'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { createProcessingApi } = require('../server/processingApi');
const { processLodRecovery } = require('../server/lodRecovery');
const { processOneDerivative } = require('../server/derivativeWorker');
const { collectRecoveryCompanions, companionCopyManifests, ownedRecoveryCompanions,
  verifyRecoveryCompanionPlan, verifyRecoveryCompanionDestination } = require('../server/lodRecoveryCompanions');
const { verifyLodProvenance } = require('../server/lodProvenance');
const { hashTree } = require('../server/storageManager');
const { stable, OFFICIAL_CONVERTER_BINARY_SHA256 } = require('../lod-converter-policy.cjs');
const { config } = require('../server/config');
const { retainedChunkVerifier } = require('../server/retainedChunkVerifier');
const { buildMeshRecoveryManifest } = require('../server/retainedManifest');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const jsonHash = value => sha(JSON.stringify(value));
const linux = { skip: process.platform === 'win32' };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-recovery-companions-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database), repository = new ViewerRepository(database);
  const roots = { models: path.join(root, 'models'), datasets: path.join(root, 'datasets') };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory);
  const reservations = [];
  const storage = { roots, requireSpace(key, bytes) { reservations.push({ key, bytes }); },
    resolve(key, relative, { mustExist = false } = {}) {
      const result = path.resolve(roots[key], ...relative.split('/'));
      assert.ok(result.startsWith(`${roots[key]}${path.sep}`));
      if (mustExist) assert.ok(fs.existsSync(result), `missing ${relative}`);
      return result;
    } };
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, processing, repository, storage, reservations };
}

function write(context, rootKey, relativePath, bytes) {
  const file = context.storage.resolve(rootKey, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return { rootKey, relativePath, byteSize: Buffer.byteLength(bytes), sha256: sha(bytes) };
}

function richSource(context, { glb = Buffer.from('fixture-glb'), obj = Buffer.from('o fixture\n') } = {}) {
  const { processing, repository, database } = context;
  const project = processing.createProject({ displayName: 'Rome companion source' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'retained source', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  processing.finalizeDataset(dataset.id, [], sha('dataset'));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Rome Dam' });
  const attempt = processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id,
    providerTaskId: 'source', createdBy: 'staff', staged: false });
  const base = `${task.id}/${attempt.id}`;
  const assets = ['obj', 'glb'].map(kind => ({ kind, ...write(context, 'models', `${base}/model.${kind}`, kind === 'obj' ? obj : glb), published: false }));
  for (const [kind, suffix] of [['ortho', 'ortho.tif'], ['dsm', 'dsm.tif'], ['dtm', 'dtm.tif'], ['shots', 'shots.geojson'], ['report', 'report.pdf'], ['pointCloud', 'source.laz']]) {
    const bytes = Buffer.from(`${kind}-data`);
    assets.push({ kind, ...write(context, 'datasets', `${dataset.id}/${suffix}`, bytes), published: false,
      chunks: [{ chunkIndex: 0, byteOffset: 0, byteSize: bytes.length, sha256: sha(bytes) }] });
  }
  const eptFiles = [['ept.json', Buffer.from('{"version":"1.0.0"}')], ['ept-hierarchy/0-0-0-0.json', Buffer.from('{"0-0-0-0":1}')], ['ept-data/0-0-0-0.laz', Buffer.from('cloud-data')]]
    .map(([relativePath, bytes]) => ({ relativePath, ...write(context, 'models', `${base}/ept/${relativePath}`, bytes),
      chunks: [{ chunkIndex: 0, byteOffset: 0, byteSize: bytes.length, sha256: sha(bytes) }] }))
    .map(file => ({ ...file, relativePath: file.relativePath.slice(`${base}/ept/`.length) }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const ept = eptFiles.find(file => file.relativePath === 'ept.json');
  assets.push({ kind: 'ept', rootKey: 'models', relativePath: `${base}/ept/ept.json`, byteSize: ept.byteSize, sha256: ept.sha256,
    manifestSha256: jsonHash(eptFiles.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 }))), manifestFiles: eptFiles, published: false });
  const photo = { filename: 'DJI_0001.JPG', contentType: 'image/jpeg', ...write(context, 'datasets', `${dataset.id}/images/DJI_0001.JPG`, Buffer.from('jpeg-photo')) };
  const model = repository.upsertModelVersion({ provider: 'webodm', providerModelId: task.id, providerVersionId: attempt.id,
    displayName: task.displayName, status: 'ready', makeActive: false, assets, cameraPhotos: [photo] });
  const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id,
    relativePath: base, byteSize: obj.length + glb.length + 100, assetCount: assets.length });
  const files = [{ relativePath: 'model.glb', sourceRelativePath: 'model.glb', role: 'mesh_glb', byteSize: glb.length, sha256: sha(glb) },
    { relativePath: 'model.obj', sourceRelativePath: 'model.obj', role: 'mesh_obj', byteSize: obj.length, sha256: sha(obj) }];
  return { project, dataset, task, attempt, model, versionId, base, obj, glb, assets, photo, manifest: { files, manifestSha256: jsonHash(files) } };
}

function queue(context, source, { companionRepair = false } = {}) {
  return context.processing.createLodRecoveryOperation({ outputId: source.versionId, subject: 'staff', sessionId: 'staff-session', manifest: source.manifest, companionRepair });
}

test('companion snapshot contains only registered products, exact EPT chunks, and linked photos', t => {
  const context = fixture(t), source = richSource(context);
  write(context, 'models', `${source.base}/ept/unregistered-secret.txt`, 'not registered');
  write(context, 'datasets', `${source.dataset.id}/images/unused.JPG`, 'not linked');
  const plan = collectRecoveryCompanions(context.database, source.versionId);
  assert.deepEqual(plan.assets.map(asset => asset.kind), ['dsm', 'dtm', 'ept', 'ortho', 'pointCloud', 'report', 'shots']);
  assert.equal(plan.cameraPhotos.length, 1);
  assert.equal(plan.files.length, 10);
  assert.equal(plan.files.some(file => /secret|unused/.test(file.sourceRelativePath)), false);
  const owned = ownedRecoveryCompanions(plan, 'new-task/new-attempt', 'new-attempt');
  assert.ok(owned.assets.every(asset => asset.rootKey === 'models' && asset.relativePath.startsWith('new-task/new-attempt/recovery-companions/')));
  assert.equal(owned.assets.find(asset => asset.kind === 'ept').manifestFiles[0].chunks.length, 1);
  assert.equal(owned.cameraPhotos[0].rootKey, 'models');
  assert.equal(verifyRecoveryCompanionPlan(context.database, source.versionId, plan).manifestSha256, plan.manifestSha256);
});

test('companion snapshot rejects changed registry, missing EPT proof, unsafe paths and bad chunk coverage', t => {
  const context = fixture(t), source = richSource(context), plan = collectRecoveryCompanions(context.database, source.versionId);
  const dsm = context.database.prepare("SELECT id FROM model_assets WHERE version_id=? AND kind='dsm'").get(source.versionId);
  context.database.prepare("UPDATE model_assets SET sha256=? WHERE id=?").run('f'.repeat(64), dsm.id);
  assert.throws(() => verifyRecoveryCompanionPlan(context.database, source.versionId, plan), { code: 'lod_recovery_companion_changed' });
  context.database.prepare("UPDATE model_assets SET relative_path='../escape' WHERE id=?").run(dsm.id);
  assert.throws(() => collectRecoveryCompanions(context.database, source.versionId), { code: 'lod_recovery_companion_changed' });
  context.database.prepare('UPDATE model_assets SET relative_path=? WHERE id=?').run(`${source.dataset.id}/dsm.tif`, dsm.id);
  context.database.prepare('UPDATE model_asset_chunks SET byte_offset=1 WHERE asset_id=?').run(dsm.id);
  assert.throws(() => collectRecoveryCompanions(context.database, source.versionId), { code: 'lod_recovery_companion_changed' });
  context.database.prepare('DELETE FROM model_asset_chunks WHERE asset_id=?').run(dsm.id);
  context.database.prepare("DELETE FROM model_asset_files WHERE asset_id IN (SELECT id FROM model_assets WHERE version_id=? AND kind='ept') AND relative_path='ept.json'").run(source.versionId);
  assert.throws(() => collectRecoveryCompanions(context.database, source.versionId), { code: 'lod_recovery_companion_changed' });
});

test('queued companion copies reserve physical storage, independently of the mesh admission snapshot', t => {
  const context = fixture(t), source = richSource(context), plan = collectRecoveryCompanions(context.database, source.versionId);
  const operation = queue(context, source), total = source.obj.length + source.glb.length + plan.byteSize;
  assert.equal(context.processing.activeRecoveryMaterializationBytes(), total);
  assert.equal(context.processing.activeDerivativeReservationBytes(), total);
  assert.equal(context.processing.activeDerivativeReservationBytes(null, operation.id), 0);
  assert.equal(queue(context, source).id, operation.id);
  const payload = JSON.parse(context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(operation.id).payload_json);
  assert.equal(payload.companions.manifestSha256, plan.manifestSha256);
  assert.deepEqual(payload.sourceFiles.map(file => file.role), ['mesh_glb', 'mesh_obj']);
});

test('recovery copies all companion bytes into independent ownership and keeps derivative closure mesh-only', linux, async t => {
  const context = fixture(t), source = richSource(context), plan = collectRecoveryCompanions(context.database, source.versionId);
  const operation = queue(context, source), leased = context.processing.claimDatasetOperation('copy-worker');
  assert.equal(leased.id, operation.id);
  const result = await processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } });
  const versionId = result.model.activeVersion.id, assets = result.model.activeVersion.assets;
  assert.deepEqual(assets.map(asset => asset.kind), ['dsm', 'dtm', 'ept', 'glb', 'obj', 'ortho', 'pointCloud', 'report', 'shots']);
  assert.equal(context.reservations[0].bytes, source.obj.length + source.glb.length + plan.byteSize);
  assert.equal(context.processing.getModelOutput(versionId).byteSize, context.reservations[0].bytes);
  assert.equal(context.processing.activeRecoveryMaterializationBytes(), 0, 'registered base storage replaces the copy reservation');
  const photo = context.repository.listCameraPhotos(versionId)[0];
  assert.equal(fs.readFileSync(context.storage.resolve(photo.rootKey, photo.relativePath), 'utf8'), 'jpeg-photo');
  for (const kind of ['dsm', 'dtm', 'ortho']) {
    const asset = assets.find(item => item.kind === kind), original = source.assets.find(item => item.kind === kind);
    assert.notEqual(context.storage.resolve(asset.rootKey, asset.relativePath), context.storage.resolve(original.rootKey, original.relativePath));
    assert.equal(context.repository.getModelAssetChunks(asset.id).length, 1);
  }
  const ept = assets.find(asset => asset.kind === 'ept');
  assert.equal(context.repository.getModelAssetChunks(ept.id, 'ept-data/0-0-0-0.laz').length, 1);
  context.processing.activateImportedDerivativesForOperation(operation.id, 'copy-worker', result.attempt.id, result.requiredDerivatives, result);
  const job = context.database.prepare('SELECT id FROM derivative_jobs WHERE attempt_id=?').get(result.attempt.id);
  assert.equal(context.processing.derivativeInputSnapshot(job.id).totalByteSize, source.obj.length + source.glb.length);
  const targetRoot = context.storage.resolve('models', `${source.task.id}/${result.attempt.id}`);
  await verifyRecoveryCompanionDestination(plan, targetRoot);
  fs.rmSync(context.storage.resolve('models', source.base), { recursive: true });
  fs.rmSync(context.storage.resolve('datasets', source.dataset.id), { recursive: true });
  await verifyRecoveryCompanionDestination(plan, targetRoot);
});

test('failed companion copies and inadequate storage never register a replacement', linux, async t => {
  const context = fixture(t), source = richSource(context), operation = queue(context, source);
  const leased = context.processing.claimDatasetOperation('copy-failure');
  context.storage.requireSpace = () => { throw Object.assign(new Error('test space limit'), { code: 'insufficient_storage' }); };
  await assert.rejects(processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } }), { code: 'insufficient_storage' });
  context.storage.requireSpace = () => {};
  fs.writeFileSync(context.storage.resolve('datasets', `${source.dataset.id}/ortho.tif`), 'corrupt');
  await assert.rejects(processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } }), error => ['source_changed', 'lod_recovery_companion_changed'].includes(error.code));
  const payload = JSON.parse(leased.payload_json);
  assert.equal(context.processing.getModelOutput(payload.ids.versionId), null);
  assert.equal(context.processing.getTask(source.task.id).activeAttemptId, source.attempt.id);
  assert.equal(fs.existsSync(context.storage.resolve('models', payload.targetRelativePath)), false);
  assert.equal(operation.id, leased.id);
});

test('registered companion directory symlinks are rejected instead of followed', linux, t => {
  const context = fixture(t), source = richSource(context), plan = collectRecoveryCompanions(context.database, source.versionId);
  const images = context.storage.resolve('datasets', `${source.dataset.id}/images`), moved = `${images}-saved`;
  fs.renameSync(images, moved); fs.symlinkSync(moved, images);
  assert.throws(() => companionCopyManifests(plan, context.storage), { code: 'lod_recovery_companion_changed' });
});

async function legacyRecovery(context) {
  const { writeAuditableFixture } = await import('./helpers/lod-fixture.mjs');
  const { writeLodProvenance } = await import('../scripts/lib/lod-equivalence.mjs');
  const fixtureDir = path.join(context.root, 'controlled-fixture'), sourcePath = writeAuditableFixture(fixtureDir, { leafABasisu: true, leafBBasisu: true });
  const obj = Buffer.from('o controlled companion repair\n'), glb = fs.readFileSync(sourcePath);
  const original = richSource(context, { obj, glb });
  const oldOperation = queue(context, original), payload = JSON.parse(context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(oldOperation.id).payload_json);
  const attempt = context.processing.createImportedAttempt({ id: payload.ids.attemptId, taskId: original.task.id, datasetId: original.dataset.id, providerTaskId: `lod-recovery:${oldOperation.id}`, createdBy: 'staff', staged: false });
  const base = payload.targetRelativePath, sourceGlb = context.storage.resolve('models', `${base}/model.glb`), sourceObj = context.storage.resolve('models', `${base}/model.obj`);
  write(context, 'models', `${base}/model.glb`, glb); write(context, 'models', `${base}/model.obj`, obj);
  const tilesDirectory = context.storage.resolve('models', `${base}/tiles-ktx2-old`);
  fs.renameSync(fixtureDir, tilesDirectory);
  fs.unlinkSync(path.join(tilesDirectory, 'model.glb'));
  const binary = path.join(context.root, 'test-converter'); fs.writeFileSync(binary, 'test converter');
  const { provenance, outputPath } = await writeLodProvenance({ derivativeDir: tilesDirectory, sourceGlb, allowExternalSource: true,
    controlledObj2Tiles: true, converterInput: sourceObj, converterBinary: binary, trustedConverterBinarySha256: [sha('test converter')] });
  // Synthetic test data uses the same approved-hash rebinding convention as
  // lod-provenance.test.js; production never performs this transformation.
  provenance.converter.binarySha256 = OFFICIAL_CONVERTER_BINARY_SHA256[0];
  const { algorithm: _algorithm, policy, equivalenceSha256: _digest, artifacts, ...surfaceEvidence } = provenance.audit;
  provenance.audit.equivalenceSha256 = sha(stable({ sourceSha256: provenance.sourceSha256, converter: provenance.converter, policy, surfaceEvidence, artifacts }));
  fs.writeFileSync(outputPath, JSON.stringify(provenance));
  const checked = await verifyLodProvenance(outputPath, sourceGlb);
  assert.equal(checked.verified, true, checked.errors.join('; '));
  const tree = await hashTree(tilesDirectory), tiles = tree.files.find(file => file.relativePath === 'tileset.json');
  const assets = ['glb', 'obj'].map(kind => ({ kind, rootKey: 'models', relativePath: `${base}/model.${kind}`, byteSize: kind === 'glb' ? glb.length : obj.length, sha256: sha(kind === 'glb' ? glb : obj), published: false }));
  assets.push({ kind: 'tiles', rootKey: 'models', relativePath: `${base}/tiles-ktx2-old/tileset.json`, byteSize: tiles.byteSize, sha256: tiles.sha256,
    manifestSha256: tree.manifestSha256, manifestFiles: tree.files, published: false });
  context.repository.upsertModelVersion({ modelId: original.model.id, versionId: payload.ids.versionId, provider: 'webodm', providerModelId: original.task.id,
    providerVersionId: `lod-recovery:${oldOperation.id}`, displayName: 'legacy mesh-only recovery', status: 'ready', makeActive: false, assets,
    versionMetadata: { lodRecovery: { schemaVersion: 1, operationId: oldOperation.id, sourceVersionId: original.versionId },
      lodProvenance: { ...checked.provenance, tilesManifestSha256: tree.manifestSha256 } } });
  context.processing.setAttemptResult(attempt.id, original.model.id, payload.ids.versionId);
  context.processing.registerModelOutput({ versionId: payload.ids.versionId, modelId: original.model.id, taskId: original.task.id, attemptId: attempt.id,
    projectId: original.project.id, relativePath: base, byteSize: obj.length + glb.length + tree.files.reduce((sum, file) => sum + file.byteSize, 0), assetCount: 3 });
  context.database.prepare("UPDATE dataset_operations SET status='succeeded',processing_attempt_id=? WHERE id=?").run(attempt.id, oldOperation.id);
  return { ...original, original, attempt, versionId: payload.ids.versionId, base, tree };
}

test('explicit companion repair is same-source, idempotent, reserves all copies and protects both old outputs', async t => {
  const context = fixture(t), recovered = await legacyRecovery(context);
  const action = context.processing.companionRepairAction(recovered.versionId);
  assert.equal(action.eligible, true);
  assert.ok(action.missingAssetKinds.includes('ortho'));
  assert.match(action.endpoint, /companion-repair-attempts$/);
  assert.equal(context.processing.companionRepairAction(recovered.versionId, { meshDerivativesEnabled: false }).eligible, false);
  const operation = queue(context, recovered, { companionRepair: true });
  assert.equal(operation.type, 'lod_recovery');
  assert.equal(operation.companionRepair, true);
  assert.equal(queue(context, recovered, { companionRepair: true }).id, operation.id);
  const payload = JSON.parse(context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(operation.id).payload_json);
  assert.equal(payload.companionSourceOutputId, recovered.original.versionId);
  assert.equal(payload.reusedTiles.assets[0].manifestSha256, recovered.tree.manifestSha256);
  assert.notEqual(payload.ids.versionId, recovered.versionId);
  const copiedBytes = recovered.glb.length + recovered.obj.length + payload.companions.byteSize + payload.reusedTiles.byteSize;
  assert.equal(context.processing.activeRecoveryMaterializationBytes(), copiedBytes);
  assert.equal(context.processing.archiveModelOutput(recovered.original.versionId), null);
  assert.equal(context.processing.archiveModelOutput(recovered.versionId), null);
  assert.equal(context.repository.getModel(recovered.model.id).activeVersionId, null, 'repair never publishes automatically');
  assert.throws(() => context.processing.createLodRecoveryOperation({ outputId: recovered.versionId, subject: 'different-staff', manifest: recovered.manifest, companionRepair: true }), { code: 'lod_recovery_in_progress' });
  assert.throws(() => queue(context, recovered), { code: 'lod_recovery_kind_conflict' }, 'normal reconversion cannot alias an explicit companion-repair request');
});

test('companion repair rejects wrong lineage, changed source mesh and a newer active task attempt', async t => {
  const context = fixture(t), recovered = await legacyRecovery(context);
  const row = context.database.prepare('SELECT metadata_json FROM model_versions WHERE id=?').get(recovered.versionId), metadata = JSON.parse(row.metadata_json);
  metadata.lodRecovery.sourceVersionId = 'unrelated';
  context.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify(metadata), recovered.versionId);
  assert.equal(context.processing.companionRepairCandidate(recovered.versionId), null);
  context.database.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(row.metadata_json, recovered.versionId);
  const obj = context.database.prepare("SELECT id,sha256 FROM model_assets WHERE version_id=? AND kind='obj'").get(recovered.original.versionId);
  context.database.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run('f'.repeat(64), obj.id);
  assert.equal(context.processing.companionRepairCandidate(recovered.versionId), null);
  context.database.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run(obj.sha256, obj.id);
  context.database.prepare("UPDATE model_outputs SET status='trashed' WHERE id=?").run(recovered.original.versionId);
  assert.equal(context.processing.companionRepairCandidate(recovered.versionId), null, 'deleted companion source cannot be borrowed');
  context.database.prepare("UPDATE model_outputs SET status='ready' WHERE id=?").run(recovered.original.versionId);
  context.processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: recovered.task.id, datasetId: recovered.dataset.id, providerTaskId: 'new-work', staged: false });
  assert.equal(context.processing.companionRepairCandidate(recovered.versionId), null);
  assert.equal(queue(context, recovered, { companionRepair: true }), null);
});

test('companion repair copies KTX2 v4 tree and verifies a new receipt without conversion or v2 regeneration', linux, async t => {
  const context = fixture(t), recovered = await legacyRecovery(context), operation = queue(context, recovered, { companionRepair: true });
  const leased = context.processing.claimDatasetOperation('repair-worker');
  const result = await processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } });
  assert.equal(result.requiredDerivatives[0].type, 'lod_audit');
  assert.equal(result.requiredDerivatives[0].request.reuseVerifiedProvenance, true);
  context.processing.activateImportedDerivativesForOperation(operation.id, 'repair-worker', result.attempt.id, result.requiredDerivatives, result);
  await processOneDerivative({ ...context, config: {}, generateMeshTilesImpl() { assert.fail('repair must not reconvert the model'); } }, 'repair-auditor');
  const repaired = context.repository.getModelVersion(recovered.model.id, result.model.activeVersion.id).activeVersion;
  assert.equal(context.processing.getAttempt(result.attempt.id).status, 'ready_for_review');
  assert.equal(repaired.metadata.lodProvenance.schemaVersion, 4);
  assert.equal(repaired.metadata.lodProvenance.tilesManifestSha256, recovered.tree.manifestSha256);
  assert.ok(repaired.lodVerifierReceipt, 'a new version-bound receipt is created');
  assert.deepEqual(repaired.assets.map(asset => asset.kind), ['dsm', 'dtm', 'ept', 'glb', 'obj', 'ortho', 'pointCloud', 'report', 'shots', 'tiles']);
  assert.equal(context.processing.getModelOutput(repaired.id).assetCount, 10);
  assert.equal(context.processing.getDatasetOperation(operation.id).status, 'succeeded');
  assert.equal(context.repository.getModel(recovered.model.id).activeVersionId, null);
  assert.equal(context.processing.getModelOutput(recovered.versionId).status, 'ready');
  assert.equal(context.processing.archiveModelOutput(recovered.original.versionId).status, 'archived', 'successful independent ownership releases the original');
});

test('companion repair rejects corrupt copied tile artifacts and never promotes the candidate', linux, async t => {
  const context = fixture(t), recovered = await legacyRecovery(context), operation = queue(context, recovered, { companionRepair: true });
  const leased = context.processing.claimDatasetOperation('repair-worker');
  const result = await processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } });
  context.processing.activateImportedDerivativesForOperation(operation.id, 'repair-worker', result.attempt.id, result.requiredDerivatives, result);
  const directory = context.storage.resolve('models', result.requiredDerivatives[0].request.tilesRelativePath);
  fs.chmodSync(path.join(directory, 'leaf-a.b3dm'), 0o600);
  fs.appendFileSync(path.join(directory, 'leaf-a.b3dm'), 'corrupt');
  await processOneDerivative({ ...context, config: {} }, 'repair-auditor');
  assert.equal(context.processing.getAttempt(result.attempt.id).status, 'failed');
  assert.equal(context.processing.getDatasetOperation(operation.id).status, 'failed');
  assert.equal(context.repository.getModelVersion(recovered.model.id, result.model.activeVersion.id).activeVersion.assets.some(asset => asset.kind === 'tiles'), false);
  assert.equal(context.repository.getModel(recovered.model.id).activeVersionId, null);
});

test('companion repair API requires processing write permission before source access', async t => {
  const context = fixture(t), token = 'companion-repair-read-only-token-000000';
  context.processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'reader', permissions: ['viewer.processing.read'], expiresAt: new Date(Date.now() + 60000).toISOString() });
  const app = express(); app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.use(createProcessingApi({ ...context, storage: { resolve() { assert.fail('unauthorized storage access'); } } }));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/processing/outputs/unknown/companion-repair-attempts`;
  assert.equal((await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': 'read-only-repair' }, body: '{}' })).status, 403);
});

test('registered chunk proofs validate incrementally across arbitrary streaming boundaries', () => {
  const chunks = [{ chunkIndex: 0, byteOffset: 0, byteSize: 3, sha256: sha('abc') },
    { chunkIndex: 1, byteOffset: 3, byteSize: 4, sha256: sha('defg') }];
  const proof = retainedChunkVerifier(chunks, 7);
  proof.update(Buffer.from('a')); proof.update(Buffer.from('bcde')); proof.update(Buffer.from('fg')); proof.finish();
  assert.throws(() => retainedChunkVerifier(chunks, 8), { code: 'source_changed' });
  const corrupt = retainedChunkVerifier(chunks, 7);
  assert.throws(() => corrupt.update(Buffer.from('abd')), { code: 'source_changed' });
  assert.throws(() => retainedChunkVerifier(chunks, 7).finish(), { code: 'source_changed' });
});

test('mesh recovery replay ignores copied companion tile payloads named model.glb', linux, async t => {
  const context = fixture(t), source = richSource(context);
  write(context, 'models', source.base + '/recovery-companions/tiles/root/model.glb', 'registered-tile-not-source');
  const manifest = await buildMeshRecoveryManifest(context.storage.resolve('models', source.base));
  assert.deepEqual(manifest.files.map(file => file.relativePath), ['model.glb', 'model.obj']);
});

test('companion copy rejects a parent replaced by a symlink during canonical resolution', linux, async t => {
  const context = fixture(t), source = richSource(context), plan = collectRecoveryCompanions(context.database, source.versionId);
  const sourceDirectory = path.join(context.storage.roots.datasets, source.dataset.id);
  const held = sourceDirectory + '.held', realpath = fs.realpathSync.native;
  let swapped = false;
  fs.realpathSync.native = function(value, ...args) {
    if (value === sourceDirectory && !swapped) {
      swapped = true;
      fs.renameSync(sourceDirectory, held);
      fs.symlinkSync(held, sourceDirectory, 'dir');
    }
    return realpath.call(this, value, ...args);
  };
  try { assert.throws(() => companionCopyManifests(plan, context.storage), { code: 'lod_recovery_companion_changed' }); }
  finally { fs.realpathSync.native = realpath; }
  assert.equal(swapped, true, 'race happens after the no-symlink lstat check');
});

test('legacy queued recovery binds its companion reservation durably before copying', linux, async t => {
  const context = fixture(t), source = richSource(context), operation = queue(context, source);
  const row = context.database.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(operation.id), payload = JSON.parse(row.payload_json);
  delete payload.companions;
  context.database.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload), operation.id);
  const expected = source.glb.length + source.obj.length + collectRecoveryCompanions(context.database, source.versionId).byteSize;
  const leased = context.processing.claimDatasetOperation('legacy-copy-worker');
  let checked = false;
  context.storage.requireSpace = (_key, required) => {
    checked = true;
    assert.equal(required, expected);
    assert.equal(context.processing.activeRecoveryMaterializationBytes(), expected, 'other workers see this full durable reservation');
  };
  await processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } });
  assert.equal(checked, true);
  assert.equal(context.processing.activeRecoveryMaterializationBytes(), 0, 'owned output accounting replaces the materialization reservation');
});

test('companion copy rejects bad registered chunk hash even when the whole file is unchanged', linux, async t => {
  const context = fixture(t), source = richSource(context);
  context.database.prepare("UPDATE model_asset_chunks SET sha256=? WHERE asset_id=(SELECT id FROM model_assets WHERE version_id=? AND kind='ortho')").run('f'.repeat(64), source.versionId);
  queue(context, source);
  const leased = context.processing.claimDatasetOperation('bad-chunk-worker');
  await assert.rejects(processLodRecovery(leased, { ...context, config: { meshDerivativesEnabled: true } }), { code: 'source_changed' });
  assert.equal(context.processing.getTask(source.task.id).activeAttemptId, source.attempt.id);
  assert.equal(context.database.prepare('SELECT COUNT(*) n FROM model_outputs').get().n, 1);
});

test('explicit companion repair API has authenticated idempotency, disabled-policy and immutable-version gates', linux, async t => {
  const context = fixture(t), recovered = await legacyRecovery(context), previous = config.meshDerivativesEnabled;
  config.meshDerivativesEnabled = false;
  t.after(() => { config.meshDerivativesEnabled = previous; });
  const token = 'companion-repair-writer-token-0000000000';
  context.processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'staff',
    permissions: ['viewer.processing.read', 'viewer.processing.write'], expiresAt: new Date(Date.now() + 60000).toISOString() });
  const app = express(); app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.use(createProcessingApi(context));
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/processing/outputs/${recovered.versionId}/companion-repair-attempts`;
  const post = (key, body = '{}') => fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`,
    'content-type': 'application/json', 'idempotency-key': key }, body });
  const disabled = await post('companion-disabled');
  assert.equal(disabled.status, 409); assert.equal((await disabled.json()).code, 'mesh_derivatives_disabled');
  config.meshDerivativesEnabled = true;
  const invalid = await post('companion-client-path', JSON.stringify({ companionSourceOutputId: 'different-output' }));
  assert.equal(invalid.status, 400);
  const first = await post('companion-explicit-repair');
  const firstBody = await first.json();
  assert.equal(first.status, 202, JSON.stringify(firstBody));
  assert.ok(firstBody.operation.id);
  assert.equal(first.headers.get('location'), `/api/v1/operations/${firstBody.operation.id}`);
  const repeated = await post('companion-explicit-repair');
  assert.equal(repeated.status, 202);
  assert.equal((await repeated.json()).operation.id, firstBody.operation.id);
  const newKey = await post('companion-explicit-replay');
  assert.equal(newKey.status, 202);
  assert.equal((await newKey.json()).operation.id, firstBody.operation.id);
  assert.equal(context.processing.getTask(recovered.task.id).activeAttemptId, recovered.attempt.id, 'queueing does not replace the active attempt');
  assert.equal(context.processing.getModelOutput(recovered.versionId).status, 'ready');
  assert.equal(context.repository.getModel(recovered.model.id).activeVersionId, null);
});
