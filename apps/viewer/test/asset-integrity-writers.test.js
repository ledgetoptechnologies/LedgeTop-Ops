'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { hashFileChunks, hashTree } = require('../server/storageManager');
const { assertAssetIntegrity, chunksCover } = require('../server/assetIntegrityRecords');

const MIB = 1024 * 1024, CHUNK = 4 * MIB;
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function database(t) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  applyMigrations(db);
  t.after(() => db.close());
  return db;
}

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// An attempt whose required derivative of the given type is leased.
function leased(db, type) {
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db);
  const project = processing.createProject({ displayName: `Project ${crypto.randomUUID()}` });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Task' });
  const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: 'fixture', createdBy: 'ops:test', staged: false });
  const model = repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: 'Task', status: 'ready', makeActive: false,
    assets: [{ kind: 'glb', rootKey: 'models', relativePath: 'base/model.glb', byteSize: 1, sha256: 'b'.repeat(64), published: false },
      { kind: 'pointCloud', rootKey: 'models', relativePath: 'base/cloud.laz', byteSize: 1, sha256: 'c'.repeat(64), published: false }] });
  const versionId = db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: 'base', status: 'staged', byteSize: 1, assetCount: 2 });
  const jobId = processing.enqueueDerivative(attempt.id, type, { optional: false });
  db.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);
  const job = processing.claimDerivative('worker');
  assert.equal(job.id, jobId);
  return { processing, repository, attempt, versionId, job };
}

async function tree(t, entry, size) {
  const root = directory(t);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, entry), '{}');
  fs.writeFileSync(path.join(root, 'data', 'large.bin'), crypto.randomBytes(size));
  const integrity = await hashTree(root), head = integrity.files.find(file => file.relativePath === entry);
  return { sha256: head.sha256, byteSize: head.byteSize, manifestSha256: integrity.manifestSha256, manifestFiles: integrity.files };
}

const without = (files, strip) => files.map(file => strip ? { ...file, chunks: [] } : file);
const provenance = manifestSha256 => ({ schemaVersion: 2, sourceAsset: 'model.glb', sourceSha256: 'b'.repeat(64), tilesManifestSha256: manifestSha256,
  geometry: 'bounded-triangle-equivalence', textures: 'byte-identical-material-equivalence', leafGeometricError: 0,
  audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 } });

async function singleFile(t, size, strip) {
  const file = path.join(directory(t), 'raster.tif');
  fs.writeFileSync(file, crypto.randomBytes(size));
  const integrity = await hashFileChunks(file);
  return { byteSize: size, sha256: integrity.sha256, chunks: strip ? [] : integrity.chunks };
}

function upsert(db, asset) {
  new ViewerRepository(db).upsertModelVersion({ provider: 'ltds-processing', providerModelId: 'model', providerVersionId: 'version', displayName: 'Model', status: 'ready', makeActive: true, assets: [asset] });
}

// Every server function that registers a delivered file.
const WRITERS = {
  'upsertModelVersion (one file)': { kind: 'ortho', relativePath: '', async register(t, db, size, strip) {
    upsert(db, { kind: 'ortho', rootKey: 'models', relativePath: 'ortho.tif', ...await singleFile(t, size, strip) });
  } },
  'upsertModelVersion (EPT tree)': { kind: 'ept', relativePath: 'data/large.bin', async register(t, db, size, strip) {
    const value = await tree(t, 'ept.json', size);
    upsert(db, { kind: 'ept', rootKey: 'models', relativePath: 'cloud/ept.json', ...value, manifestFiles: without(value.manifestFiles, strip) });
  } },
  addModelAsset: { kind: 'dsm', relativePath: '', async register(t, db, size, strip) {
    const c = leased(db, 'ept');
    c.processing.addModelAsset({ versionId: c.versionId, kind: 'dsm', rootKey: 'models', relativePath: 'base/dsm.tif', format: 'tif', attemptId: c.attempt.id, ...await singleFile(t, size, strip) });
  } },
  registerVerifiedEptAsset: { kind: 'ept', relativePath: 'data/large.bin', async register(t, db, size, strip, promote) {
    const c = leased(db, 'ept'), value = await tree(t, 'ept.json', size);
    const asset = { versionId: c.versionId, attemptId: c.attempt.id, rootKey: 'models', relativePath: `base/ept-${c.job.id}/ept.json`, ...value, manifestFiles: without(value.manifestFiles, strip) };
    assert.equal(c.processing.registerVerifiedEptAsset(c.job.id, 'worker', asset, { leaseToken: c.job.lease_token, promote }), true);
  } },
  registerVerifiedLodAsset: { kind: 'tiles', relativePath: 'data/large.bin', async register(t, db, size, strip, promote) {
    const c = leased(db, 'lod_audit'), value = await tree(t, 'tileset.json', size);
    const asset = { versionId: c.versionId, attemptId: c.attempt.id, rootKey: 'models', relativePath: 'base/tiles/tileset.json', ...value, manifestFiles: without(value.manifestFiles, strip) };
    assert.ok(c.processing.registerVerifiedLodAsset(c.job.id, 'worker', asset, provenance(value.manifestSha256), { leaseToken: c.job.lease_token, promote }));
  } },
};

for (const [name, writer] of Object.entries(WRITERS)) {
  for (const [label, size, expected] of [['5 MiB', 5 * MIB, 2], ['exactly 4 MiB', CHUNK, 1], ['one byte below 4 MiB', CHUNK - 1, 0]]) {
    test(`${name} records chunk hashes: ${label} gives ${expected}`, async t => {
      const db = database(t);
      await writer.register(t, db, size, false);
      const asset = db.prepare('SELECT id FROM model_assets WHERE kind=?').get(writer.kind);
      const chunks = new ViewerRepository(db).getModelAssetChunks(asset.id, writer.relativePath);
      assert.equal(chunks.length, expected);
      if (expected) assert.equal(chunksCover(chunks, size), true);
    });
  }
  test(`${name} refuses a new 4 MiB file without chunk hashes and leaves nothing behind`, async t => {
    const db = database(t);
    let promoted = false;
    await assert.rejects(writer.register(t, db, CHUNK, true, () => { promoted = true; }), { code: 'asset_chunks_missing' });
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_assets WHERE kind=?').get(writer.kind).n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_asset_files').get().n, 0);
    assert.equal(promoted, false, 'the guard runs before files are moved into place');
  });
}

test('registerVerifiedEptAsset leaves an already registered chunkless EPT exactly as it was', async t => {
  const db = database(t), c = leased(db, 'ept'), value = await tree(t, 'ept.json', 5 * MIB);
  const asset = { versionId: c.versionId, attemptId: c.attempt.id, rootKey: 'models', relativePath: `base/ept-${c.job.id}/ept.json`, ...value };
  assert.equal(c.processing.registerVerifiedEptAsset(c.job.id, 'worker', asset, { leaseToken: c.job.lease_token }), true);
  db.prepare('DELETE FROM model_asset_chunks').run();
  assert.equal(c.processing.registerVerifiedEptAsset(c.job.id, 'worker', asset, { leaseToken: c.job.lease_token }), true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM model_asset_chunks').get().n, 0);
});

test('the guard rejects gaps, overlaps, short totals, reordering and bad digests', () => {
  const size = 5 * MIB;
  const good = () => [{ chunkIndex: 0, byteOffset: 0, byteSize: CHUNK, sha256: sha('0') }, { chunkIndex: 1, byteOffset: CHUNK, byteSize: MIB, sha256: sha('1') }];
  const asset = chunks => ({ kind: 'ortho', byteSize: size, sha256: sha('file'), chunks });
  assertAssetIntegrity(asset(good()));
  for (const [label, change] of [
    ['gap', chunks => { chunks[1].byteOffset += 1; }],
    ['overlap', chunks => { chunks[1].byteOffset -= 1; chunks[1].byteSize += 1; }],
    ['short total', chunks => { chunks[1].byteSize -= 1; }],
    ['long total', chunks => { chunks[1].byteSize += 1; }],
    ['missing first', chunks => { chunks.shift(); }],
    ['wrong order', chunks => { chunks.reverse(); }],
    ['oversized region', chunks => { chunks.splice(0, 2, { chunkIndex: 0, byteOffset: 0, byteSize: size, sha256: sha('0') }); }],
    ['bad digest', chunks => { chunks[0].sha256 = 'A'.repeat(64); }],
    ['none', chunks => { chunks.length = 0; }],
  ]) {
    const chunks = good();
    change(chunks);
    assert.throws(() => assertAssetIntegrity(asset(chunks)), { code: 'asset_chunks_missing' }, label);
    assert.throws(() => assertAssetIntegrity({ kind: 'ept', manifestFiles: [{ ...asset(chunks), relativePath: 'child' }] }), { code: 'asset_chunks_missing' }, `child ${label}`);
    if (chunks.length) assert.throws(() => assertAssetIntegrity(asset(chunks), { recoveryCopy: true }), { code: 'asset_chunks_missing' }, `recovery copy ${label}`);
  }
});

test('files without a recorded hash and recovery copies of legacy sources stay registrable', () => {
  assertAssetIntegrity({ kind: 'ortho', byteSize: 5 * MIB, sha256: null, chunks: [] });
  assertAssetIntegrity({ kind: 'ortho', byteSize: 5 * MIB, sha256: sha('legacy'), chunks: [] }, { recoveryCopy: true });
  assertAssetIntegrity({ kind: 'ept', manifestFiles: [{ relativePath: 'ept-data/0.laz', byteSize: 5 * MIB, sha256: sha('legacy'), chunks: [] }] }, { recoveryCopy: true });
});
