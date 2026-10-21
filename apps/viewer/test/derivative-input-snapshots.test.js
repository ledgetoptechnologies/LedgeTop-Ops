'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { MAX_DERIVATIVE_INPUT_BYTES, canonicalDerivativeInput, verifyDerivativeInputSnapshot, registeredPointDerivativeInput } = require('../server/derivativeInputSnapshot');

test('EPT conversion selects its exact registered input, never the first point-cloud row', () => {
  const file={role:'point_cloud_source',rootKey:'datasets',relativePath:'source/cloud.laz',byteSize:10,sha256:'a'.repeat(64)};
  const snapshot=canonicalDerivativeInput('ept',[file]);
  const asset={id:'exact',kind:'pointCloud',root_key:file.rootKey,relative_path:file.relativePath,byte_size:file.byteSize,sha256:file.sha256};
  const other={...asset,id:'other',relative_path:'source/other.laz'};
  assert.equal(registeredPointDerivativeInput(snapshot,[other,asset]),asset);
  for(const changed of [{root_key:'models'},{relative_path:'source/other.laz'},{byte_size:11},{sha256:'b'.repeat(64)}])
    assert.throws(()=>registeredPointDerivativeInput(snapshot,[{...asset,...changed}]),{code:'derivative_input_changed'});
  assert.throws(()=>registeredPointDerivativeInput(snapshot,[asset,{...asset,id:'duplicate'}]),{code:'derivative_input_changed'});
  assert.throws(()=>registeredPointDerivativeInput({...snapshot,manifestSha256:'0'.repeat(64)},[asset]),{code:'derivative_input_changed'});
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-derivative-input-'));
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db);
  const repository = new ViewerRepository(db);
  t.after(() => { db.close();fs.rmSync(root, { recursive: true, force: true }); });
  return { db, processing, repository };
}

function derivativeJob(context, type = 'mesh_tiles') {
  const project = context.processing.createProject({ displayName: 'Snapshot project' });
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'Snapshot dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: 'snapshot-source' });
  context.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: 'a'.repeat(64) }], 'b'.repeat(64));
  const task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Snapshot task' });
  const provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = context.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  const model = context.repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'importing', assets: [], makeActive: false });
  const versionId = context.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  context.processing.setAttemptResult(attempt.id, model.id, versionId);
  context.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: `${task.id}/${attempt.id}`, status: 'staged', byteSize: 33_400_000_000, assetCount: 0 });
  return { project, dataset, task, attempt, versionId, jobId: context.processing.enqueueDerivative(attempt.id, type, { optional: false }) };
}

function providerIngest(context) {
  const project = context.processing.createProject({ displayName: 'Provider ingest project' });
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'Provider ingest dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: 'provider-source' });
  context.processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: 'a'.repeat(64) }], 'b'.repeat(64));
  const task = context.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Provider ingest task' });
  const provider = context.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = context.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  const owner = 'provider-ingest-owner', job = context.processing.claimJob(owner);
  context.processing.transitionAttemptForJob(job.id, owner, 'ingesting');
  const model = context.repository.upsertModelVersion({ provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: task.displayName, status: 'importing', assets: [], makeActive: false });
  const versionId = context.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  context.processing.setAttemptResultForJob(job.id, owner, model.id, versionId);
  context.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: `${task.id}/${attempt.id}`, status: 'staged', byteSize: 33_400_000_000, assetCount: 0 });
  return { project, dataset, task, attempt, versionId, owner, job };
}

const meshFiles = [
  { role: 'mesh_obj', rootKey: 'datasets', relativePath: 'source/model.obj', byteSize: 100, sha256: '1'.repeat(64) },
  { role: 'mesh_mtl', rootKey: 'datasets', relativePath: 'source/model.mtl', byteSize: 20, sha256: '2'.repeat(64) },
  { role: 'mesh_texture', rootKey: 'datasets', relativePath: 'source/texture.jpg', byteSize: 200, sha256: '3'.repeat(64) },
  { role: 'mesh_glb', rootKey: 'datasets', relativePath: 'source/model.glb', byteSize: 150, sha256: '4'.repeat(64) },
];

test('v31 binds an immutable derivative closure and reserves from closure bytes, not retained output bytes', (t) => {
  const context = fixture(t), item = derivativeJob(context);
  const snapshot = context.processing.persistDerivativeInputSnapshot(item.jobId, 'mesh_tiles', [...meshFiles].reverse());
  assert.equal(snapshot.totalByteSize, 470);
  assert.equal(snapshot.fileCount, 4);
  assert.match(snapshot.manifestSha256, /^[a-f0-9]{64}$/);
  assert.equal(context.processing.derivativeStorageReservation(item.jobId).reservedByteSize, 8 * 1024 ** 3);
  assert.equal(context.processing.getModelOutput(item.versionId).byteSize, 33_400_000_000, 'physical output accounting is unchanged');
  assert.deepEqual(context.processing.persistDerivativeInputSnapshot(item.jobId, 'mesh_tiles', meshFiles), snapshot, 'canonical replay is idempotent');
  assert.throws(() => context.processing.persistDerivativeInputSnapshot(item.jobId, 'mesh_tiles', meshFiles.map((file, index) => index ? file : { ...file, sha256: 'f'.repeat(64) })), { code: 'derivative_input_changed' });
  assert.throws(() => context.db.prepare('UPDATE derivative_input_snapshots SET total_byte_size=1 WHERE job_id=?').run(item.jobId), /immutable/);
});

test('provider ingest atomically exposes pending jobs with exact mesh and EPT closures and reservations', (t) => {
  const context = fixture(t), item = providerIngest(context), gib = 1024 ** 3;
  const providerMeshFiles = [
    { role: 'mesh_obj', rootKey: 'models', relativePath: 'provider/model.obj', byteSize: gib, sha256: '1'.repeat(64) },
    { role: 'mesh_mtl', rootKey: 'models', relativePath: 'provider/model.mtl', byteSize: 1, sha256: '2'.repeat(64) },
    { role: 'mesh_texture', rootKey: 'models', relativePath: 'provider/texture.jpg', byteSize: 2 * gib - 2, sha256: '3'.repeat(64) },
    { role: 'mesh_glb', rootKey: 'models', relativePath: 'provider/model.glb', byteSize: 1, sha256: '4'.repeat(64) },
  ];
  const providerEptFiles = [{ role: 'point_cloud_source', rootKey: 'models', relativePath: 'provider/cloud.laz', byteSize: 2 * gib, sha256: '5'.repeat(64) }];
  const activated = context.processing.completeIngestAndEnqueueDerivatives(item.job.id, item.owner, item.attempt.id, [
    { type: 'mesh_tiles', request: { optional: false } },
    { type: 'ept', request: { optional: false } },
  ], { trustedInputFilesByType: { mesh_tiles: providerMeshFiles, ept: providerEptFiles }, requireTrustedInputs: true });
  assert.equal(activated.status, 'derivatives');
  assert.equal(context.db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(item.job.id).status, 'complete');
  const jobs = context.db.prepare('SELECT id,derivative_type,status FROM derivative_jobs WHERE attempt_id=? ORDER BY derivative_type').all(item.attempt.id);
  assert.deepEqual(jobs.map((job) => ({ type: job.derivative_type, status: job.status })), [
    { type: 'ept', status: 'pending' },
    { type: 'mesh_tiles', status: 'pending' },
  ]);
  const byType = new Map(jobs.map((job) => [job.derivative_type, job]));
  const meshSnapshot = context.processing.derivativeInputSnapshot(byType.get('mesh_tiles').id), eptSnapshot = context.processing.derivativeInputSnapshot(byType.get('ept').id);
  assert.equal(meshSnapshot.totalByteSize, 3 * gib);
  assert.deepEqual(meshSnapshot.files.map((file) => file.role), ['mesh_glb', 'mesh_mtl', 'mesh_obj', 'mesh_texture']);
  assert.equal(eptSnapshot.totalByteSize, 2 * gib);
  assert.deepEqual(eptSnapshot.files.map((file) => file.role), ['point_cloud_source']);
  assert.deepEqual(context.processing.derivativeStorageReservation(byType.get('mesh_tiles').id), {
    reservedByteSize: 12 * gib, accountedByteSize: 12 * gib, state: 'reserved', inputByteSize: 3 * gib,
    inputManifestSha256: meshSnapshot.manifestSha256, inputFileCount: 4,
  });
  assert.deepEqual(context.processing.derivativeStorageReservation(byType.get('ept').id), {
    reservedByteSize: 16 * gib, accountedByteSize: 16 * gib, state: 'reserved', inputByteSize: 2 * gib,
    inputManifestSha256: eptSnapshot.manifestSha256, inputFileCount: 1,
  });
});

test('provider ingest rolls back jobs, snapshots, files, and journals when a required trusted closure is absent', (t) => {
  const context = fixture(t), item = providerIngest(context);
  assert.throws(() => context.processing.completeIngestAndEnqueueDerivatives(item.job.id, item.owner, item.attempt.id, [
    { type: 'mesh_tiles', request: { optional: false } },
    { type: 'ept', request: { optional: false } },
  ], { trustedInputFilesByType: { mesh_tiles: meshFiles }, requireTrustedInputs: true }), { code: 'invalid_derivative_input' });
  assert.equal(context.processing.getAttempt(item.attempt.id).status, 'ingesting');
  assert.equal(context.db.prepare('SELECT status FROM processing_jobs WHERE id=?').get(item.job.id).status, 'leased');
  for (const table of ['derivative_jobs', 'derivative_input_snapshots', 'derivative_input_files', 'derivative_storage_journal']) {
    assert.equal(context.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} must remain invisible after rollback`);
  }
});

test('derivative closure admission fails precisely above 16 GiB', () => {
  const tooLarge = [
    { role: 'mesh_obj', rootKey: 'models', relativePath: 'source/model.obj', byteSize: MAX_DERIVATIVE_INPUT_BYTES, sha256: '1'.repeat(64) },
    { role: 'mesh_glb', rootKey: 'models', relativePath: 'source/model.glb', byteSize: 1, sha256: '2'.repeat(64) },
  ];
  assert.throws(() => canonicalDerivativeInput('mesh_tiles', tooLarge), (error) => error.code === 'derivative_source_too_large' && error.details.inputBytes === MAX_DERIVATIVE_INPUT_BYTES + 1);
});

test('worker revalidation rejects a changed snapshotted input before conversion', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-derivative-revalidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const obj = Buffer.from('mesh source'), glb = Buffer.from('audit source');
  fs.writeFileSync(path.join(root, 'model.obj'), obj);fs.writeFileSync(path.join(root, 'model.glb'), glb);
  const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
  const snapshot = canonicalDerivativeInput('mesh_tiles', [
    { role: 'mesh_obj', rootKey: 'models', relativePath: 'model.obj', byteSize: obj.length, sha256: digest(obj) },
    { role: 'mesh_glb', rootKey: 'models', relativePath: 'model.glb', byteSize: glb.length, sha256: digest(glb) },
  ]);
  const storage = { resolve(_rootKey, relativePath) { return path.join(root, relativePath); } };
  assert.equal((await verifyDerivativeInputSnapshot(storage, snapshot)).length, 2);
  fs.writeFileSync(path.join(root, 'model.glb'), Buffer.from('audit changed'));
  await assert.rejects(verifyDerivativeInputSnapshot(storage, snapshot), { code: 'derivative_input_changed' });
});

test('v31 rejects providerless submit jobs and duplicate active processing job types', (t) => {
  const context = fixture(t), item = derivativeJob(context), imported = context.processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: item.task.id, datasetId: item.dataset.id, providerTaskId: 'import:test', createdBy: 'ops:test', staged: true, expectedActiveAttemptId: item.attempt.id });
  const timestamp = new Date().toISOString();
  assert.throws(() => context.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES (?,?,'submit','pending',?,?,?)").run(crypto.randomUUID(), imported.id, timestamp, timestamp, timestamp), /provider-backed/);
  assert.throws(() => context.db.prepare("INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES (?,?,'submit','pending',?,?,?)").run(crypto.randomUUID(), item.attempt.id, timestamp, timestamp, timestamp), /UNIQUE constraint failed/);
});
