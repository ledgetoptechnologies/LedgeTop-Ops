'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');
const { autoImportGcpSources } = require('../server/gcpAutoImport');
const { processOneDatasetOperation } = require('../server/datasetOperationWorker');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gcp-auto-import-'));
  const mounts = Object.fromEntries(['datasets', 'models', 'cache', 'trash'].map(name => [name, path.join(root, name)]));
  for (const mount of Object.values(mounts)) fs.mkdirSync(mount, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const storage = new StorageManager({ datasetsMount: mounts.datasets, modelsMount: mounts.models,
    cacheMount: mounts.cache, trashMount: mounts.trash, storageReserveBytes: 0, storageReservePercent: 0 });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, mounts, database, processing, storage };
}

function createDataset(context, files) {
  const project = context.processing.createProject({ displayName: 'Automatic GCP import' });
  const relativePath = crypto.randomUUID();
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'Raw survey data',
    storageMode: 'managed', rootKey: 'datasets', relativePath });
  const directory = path.join(context.mounts.datasets, relativePath);
  fs.mkdirSync(directory, { recursive: true });
  const manifest = files.map(({ name, content }) => {
    const bytes = Buffer.from(content, 'utf8');
    fs.writeFileSync(path.join(directory, name), bytes);
    return { id: crypto.randomUUID(), relativePath: name, byteSize: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentType: 'text/csv' };
  });
  const canonical = manifest.map(({ relativePath: itemPath, byteSize, sha256 }) => ({ relativePath: itemPath, byteSize, sha256 }));
  context.processing.finalizeDataset(dataset.id, manifest, crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex'));
  return { dataset: context.processing.getDataset(dataset.id, true), manifest };
}

test('automatically imports a valid, explicit Emlid CSV and retains the untouched raw source', async t => {
  const context = fixture(t);
  const csv = 'Name,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nCP-1,903241.652,549596.746,833.164,Hub,-88.62836667,42.98018648,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n';
  const { dataset, manifest } = createDataset(context, [{ name: 'emlid-control.csv', content: csv }]);
  const result = await autoImportGcpSources({ processing: context.processing, storage: context.storage }, dataset.id, 'ops:test');
  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0].displayName, 'emlid-control');
  assert.equal(result.imported[0].sourceFileId, manifest[0].id);
  assert.equal(result.imported[0].points[0].externalId, 'CP-1');
  assert.equal(context.processing.hasRetainedGcpSource(dataset.id), true);
  assert.equal(fs.readFileSync(path.join(context.mounts.datasets, dataset.relativePath, 'emlid-control.csv'), 'utf8'), csv);

  const replay = await autoImportGcpSources({ processing: context.processing, storage: context.storage }, dataset.id, 'ops:test');
  assert.equal(replay.imported.length, 1);
  assert.equal(replay.imported[0].id, result.imported[0].id);
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM gcp_sets WHERE dataset_id=?').get(dataset.id).n, 1);
});

test('ignores invalid and unrelated CSV contents while permanently retaining their raw files', async t => {
  const context = fixture(t);
  const invalid = 'date,temperature\n2026-01-01,12\n';
  const ambiguous = 'Name,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nCP-1,903241,549596,833,Hub,-88,42,720,NAD83(2011) / WISCRS Dodge and Jefferson + NAVD88 height\n';
  const { dataset } = createDataset(context, [{ name: 'unrelated.csv', content: invalid }, { name: 'ambiguous.csv', content: ambiguous }]);
  const result = await autoImportGcpSources({ processing: context.processing, storage: context.storage }, dataset.id, 'ops:test');
  assert.equal(result.imported.length, 0);
  assert.equal(result.ignored, 2);
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM gcp_sets WHERE dataset_id=?').get(dataset.id).n, 0);
  assert.equal(context.processing.hasRetainedGcpSource(dataset.id), true, 'raw CSV source holds exist even when content is not a valid GCP interchange');
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM retained_dataset_files WHERE dataset_id=? AND retention_reason=\'gcp_source\'').get(dataset.id).n, 2);
  assert.equal(context.database.prepare('SELECT COUNT(*) AS n FROM retained_gcp_sources WHERE dataset_id=?').get(dataset.id).n, 0,
    'invalid CSVs do not create imported GCP point sets or parsed source records');
  assert.equal(context.processing.beginTrashMutation(dataset.id, 'ops:test'), null, 'dataset retention prevents raw source deletion');
  for (const filename of ['unrelated.csv', 'ambiguous.csv'])
    assert.equal(fs.existsSync(path.join(context.mounts.datasets, dataset.relativePath, filename)), true);
});

test('browser upload finalization discovers and imports an attached valid Emlid CSV', async t => {
  const context = fixture(t);
  const project = context.processing.createProject({ displayName: 'Uploaded GCP source' });
  const dataset = context.processing.createDataset({ projectId: project.id, displayName: 'Flight source',
    storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const content = Buffer.from('Name,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nCP-1,903241.652,549596.746,833.164,Hub,-88.62836667,42.98018648,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n');
  const file = { id: 'gcp-csv', relativePath: 'survey-control.csv', byteSize: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), processingRole: 'auto' };
  const created = context.processing.createUpload({ datasetId: dataset.id, files: [file], subject: 'ops:upload-test',
    chunkSize: content.length, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const chunk = context.storage.writeChunk(created.upload.id, file.id, 0, content, file.sha256);
  const chunkPath = context.storage.chunkPath(created.upload.id, file.id, 0);
  context.processing.recordChunk({ uploadId: created.upload.id, fileId: file.id, chunkIndex: 0,
    byteSize: chunk.byteSize, sha256: chunk.sha256, relativePath: path.relative(context.mounts.cache, chunkPath).replace(/\\/g, '/') });
  context.processing.createUploadFinalizeOperation(created.upload.id, 'ops:upload-test');

  assert.equal(await processOneDatasetOperation({ processing: context.processing, storage: context.storage }, 'gcp-upload-worker'), true);
  const imported = context.database.prepare('SELECT id,source_file_id FROM gcp_sets WHERE dataset_id=?').get(dataset.id);
  const finalizedFile = context.database.prepare('SELECT id FROM dataset_files WHERE dataset_id=? AND relative_path=?').get(dataset.id, file.relativePath);
  assert.ok(imported);
  assert.equal(imported.source_file_id, finalizedFile.id);
  assert.equal(context.processing.getUpload(created.upload.id).status, 'complete');
  assert.equal(context.processing.hasRetainedGcpSource(dataset.id), true);
  assert.equal(fs.readFileSync(path.join(context.mounts.datasets, dataset.relativePath, file.relativePath)).equals(content), true);
});
