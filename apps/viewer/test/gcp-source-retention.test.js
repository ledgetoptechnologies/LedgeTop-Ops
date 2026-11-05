'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { applyMigrations, MIGRATIONS, openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');
const { autoImportGcpSources } = require('../server/gcpAutoImport');

function migrationsThrough(database, maxVersion) {
  database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version <= maxVersion)) {
    database.exec('BEGIN IMMEDIATE');
    try {
      database.exec(migration.sql);
      migration.after?.(database);
      database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-gcp-source-retention-'));
  const mounts = Object.fromEntries(['datasets', 'models', 'cache', 'trash'].map((name) => [name, path.join(root, name)]));
  for (const mount of Object.values(mounts)) fs.mkdirSync(mount, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const storage = new StorageManager({ datasetsMount: mounts.datasets, modelsMount: mounts.models,
    cacheMount: mounts.cache, trashMount: mounts.trash, storageReserveBytes: 0, storageReservePercent: 0 });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, mounts, database, processing, storage };
}

test('unrecognized raw CSVs are ignored for GCP matching but stay permanently held with dataset files', async (t) => {
  const c = fixture(t), project = c.processing.createProject({ displayName: 'Raw GCP source retention' });
  const relativePath = crypto.randomUUID();
  const dataset = c.processing.createDataset({ projectId: project.id, displayName: 'Raw field data',
    storageMode: 'managed', rootKey: 'datasets', relativePath });
  const directory = path.join(c.mounts.datasets, relativePath); fs.mkdirSync(directory, { recursive: true });
  const content = Buffer.from('date,temperature\n2026-11-05,12\n');
  fs.writeFileSync(path.join(directory, 'unrelated.csv'), content);
  const file = { id: crypto.randomUUID(), relativePath: 'unrelated.csv', byteSize: content.length,
    sha256: crypto.createHash('sha256').update(content).digest('hex'), contentType: 'text/csv' };
  c.processing.finalizeDataset(dataset.id, [file], 'a'.repeat(64));

  const held = c.database.prepare('SELECT dataset_file_id,sha256,byte_size,retention_reason FROM retained_dataset_files WHERE dataset_id=?').all(dataset.id);
  assert.deepEqual(held.map((row) => ({ ...row })), [{ dataset_file_id: file.id, sha256: file.sha256,
    byte_size: file.byteSize, retention_reason: 'gcp_source' }]);
  const result = await autoImportGcpSources({ processing: c.processing, storage: c.storage }, dataset.id, 'ops:test');
  assert.equal(result.imported.length, 0);
  assert.equal(result.ignored, 1);
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM gcp_sets WHERE dataset_id=?').get(dataset.id).n, 0);
  assert.equal(c.database.prepare('SELECT COUNT(*) AS n FROM retained_gcp_sources WHERE dataset_id=?').get(dataset.id).n, 0);
  assert.equal(c.processing.hasRetainedGcpSource(dataset.id), true);
  assert.equal(c.processing.beginTrashMutation(dataset.id, 'ops:test'), null);
  assert.ok(fs.existsSync(path.join(directory, 'unrelated.csv')));
});

test('migration permanently holds previously uploaded CSVs that have no imported GCP set', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-gcp-source-retention-migration-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const database = new DatabaseSync(path.join(root, 'viewer.sqlite'));
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  migrationsThrough(database, 76);
  const processing = new ProcessingRepository(database);
  const project = processing.createProject({ displayName: 'Existing raw CSV' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Existing raw data',
    storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const id = crypto.randomUUID(), digest = 'b'.repeat(64), createdAt = new Date().toISOString();
  database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,
    processing_role) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, dataset.id, 'unrecognized.csv', 12, digest, 'text/csv', '{}', createdAt, 'gcp_source');
  database.prepare(`UPDATE datasets SET status='finalized',manifest_sha256=?,file_count=1,byte_size=12,finalized_at=?,updated_at=? WHERE id=?`)
    .run('c'.repeat(64), createdAt, createdAt, dataset.id);

  applyMigrations(database);
  const hold = database.prepare('SELECT dataset_file_id,sha256,byte_size,retention_reason FROM retained_dataset_files WHERE dataset_file_id=?').get(id);
  assert.deepEqual({ ...hold }, { dataset_file_id: id, sha256: digest, byte_size: 12, retention_reason: 'gcp_source' });
  assert.equal(processing.hasRetainedGcpSource(dataset.id), true);
  database.close();
});
