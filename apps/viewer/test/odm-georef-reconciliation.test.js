'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { reconcileMissingOdmGeoreference } = require('../server/odmGeorefReconciliation');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-odm-georef-reconcile-'));
  const config = Object.fromEntries(['datasets', 'models', 'cache', 'trash', 'imports'].map((name) => [name, path.join(root, name)]));
  for (const directory of Object.values(config)) fs.mkdirSync(directory, { recursive: true });
  const db = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(db), repository = new ViewerRepository(db);
  const storage = new StorageManager({ datasetsMount: config.datasets, modelsMount: config.models, cacheMount: config.cache, trashMount: config.trash, datasetImportMount: config.imports, storageReserveBytes: 0, storageReservePercent: 0 });
  storage.initialize();
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { db, processing, repository, storage, datasets: config.datasets };
}

function legacyImport(c, georef = {}, { metadataAvailable = true } = {}) {
  const project = c.processing.createProject({ displayName: `Project ${crypto.randomUUID()}` });
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Backup', sourceType: 'webodm', storageMode: 'adopted', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const datasetRoot = path.join(c.datasets, dataset.relativePath), metadata = path.join(datasetRoot, 'assets', 'odm_georeferencing');
  fs.mkdirSync(datasetRoot, { recursive: true });
  if (metadataAvailable) {
    fs.mkdirSync(metadata, { recursive: true });
    fs.writeFileSync(path.join(metadata, 'proj.txt'), '+proj=utm +zone=16 +datum=WGS84 +units=m');
    fs.writeFileSync(path.join(metadata, 'odm_georeferencing_model_geo.txt'), 'WGS84 UTM 16N\n435932 4897211\n');
    fs.writeFileSync(path.join(metadata, 'odm_georeferenced_model.summary.json'), JSON.stringify({ summary: { bounds: { minx: 435895.3, miny: 4897159.221, minz: 211.914, maxx: 435976.627, maxy: 4897266.836, maxz: 258.005 } } }));
  }
  c.processing.finalizeDataset(dataset.id, [], 'a'.repeat(64));
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Imported task' });
  const attempt = c.processing.createImportedAttempt({ id: crypto.randomUUID(), taskId: task.id, datasetId: dataset.id, providerTaskId: `legacy:${task.id}`, createdBy: 'ops:test', staged: false });
  const model = c.repository.upsertModelVersion({ provider: 'webodm', providerModelId: `task-import:${task.id}`, providerVersionId: attempt.id, displayName: task.displayName, status: 'ready', georef, assets: [], makeActive: false });
  const versionId = c.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  c.processing.setAttemptResult(attempt.id, model.id, versionId);
  c.processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, rootKey: 'datasets', relativePath: dataset.relativePath, storageMode: 'adopted', status: 'ready', byteSize: 1, assetCount: 0 });
  return { modelId: model.id, versionId, datasetRoot };
}

test('bounded reconciliation repairs an already-imported version without reimport and is idempotent', (t) => {
  const c = fixture(t), item = legacyImport(c, { crs: 'WGS 84 / UTM zone 16N' });
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 1, updated: 1, terminal: 0 });
  const repaired = c.repository.getModelVersion(item.modelId, item.versionId).activeVersion.georef;
  assert.deepEqual(repaired.rtc, { e: 435932, n: 4897211, z: 0 });
  assert.ok(Math.abs(repaired.bboxCenter.x - 3.9635) < 1e-9);
  assert.ok(Math.abs(repaired.bboxCenter.y - 2.0285) < 1e-9);
  assert.ok(Math.abs(repaired.bboxCenter.z - 234.9595) < 1e-9);
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 0, updated: 0, terminal: 0 });
});

test('reconciliation never replaces an existing valid RTC with a newly discovered origin', (t) => {
  const c = fixture(t), item = legacyImport(c, { rtc: { e: 1, n: 2, z: 3 } });
  reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 });
  const value = c.repository.getModelVersion(item.modelId, item.versionId).activeVersion.georef;
  assert.deepEqual(value.rtc, { e: 1, n: 2, z: 3 });
  assert.equal(value.bboxCenter, undefined, 'bounds relative to a different origin are not mixed into existing metadata');
});

test('a stale cursor wraps once and terminal no-metadata versions are revision-marked instead of rescanned forever', (t) => {
  const c = fixture(t), item = legacyImport(c, {}, { metadataAvailable: false });
  c.repository.setState('odm_georef_backfill_cursor', JSON.stringify('zzzzzzzz'));
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 1, updated: 0, terminal: 1 });
  const metadata = c.repository.getModelVersion(item.modelId, item.versionId).activeVersion.metadata;
  assert.deepEqual(metadata.odmGeorefReconciliation, { revision: 1, outcome: 'terminal_no_metadata' });
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 0, updated: 0, terminal: 0 });
});

test('temporarily unavailable adopted roots remain eligible for a later maintenance retry', (t) => {
  const c = fixture(t), item = legacyImport(c);
  fs.rmSync(item.datasetRoot, { recursive: true, force: true });
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 1, updated: 0, terminal: 0 });
  const metadata = c.repository.getModelVersion(item.modelId, item.versionId).activeVersion.metadata;
  assert.equal(metadata.odmGeorefReconciliation, undefined);
  assert.deepEqual(reconcileMissingOdmGeoreference(c.repository, c.storage, { limit: 1 }), { scanned: 1, updated: 0, terminal: 0 });
});
