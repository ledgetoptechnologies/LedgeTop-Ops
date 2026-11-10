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
const { latestScan, recordScan } = require('../server/gcpScanLedger');

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

test('scan ledger retains a failure, allows a successful retry and binds outcomes to source bytes', (t) => {
  const c = fixture(t), project = c.processing.createProject({displayName:'Scan ledger'});
  const dataset = c.processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const file = {id:crypto.randomUUID(),relativePath:'field.csv',byteSize:5,sha256:'a'.repeat(64),contentType:'text/csv'};
  c.processing.finalizeDataset(dataset.id,[file],'b'.repeat(64));
  const base = {datasetId:dataset.id,fileId:file.id,sha256:file.sha256};
  assert.equal(latestScan(c.database,dataset.id,file.id,file.sha256),null);
  const first = c.processing.transaction(()=>recordScan(c.database,{...base,outcome:'failed',reasonCode:'io_error'}));
  const second = c.processing.transaction(()=>recordScan(c.database,{...base,outcome:'ignored',reasonCode:'invalid_rows'}));
  const repeat = c.processing.transaction(()=>recordScan(c.database,{...base,outcome:'ignored',reasonCode:'invalid_rows'}));
  assert.equal(first.attempt_seq,1); assert.equal(second.attempt_seq,2); assert.equal(repeat.id,second.id);
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM gcp_source_scan_attempts').get().n,2);
  const laterFailure=c.processing.transaction(()=>recordScan(c.database,{...base,outcome:'failed',reasonCode:'snapshot_mismatch'}));
  assert.equal(laterFailure.attempt_seq,3);
  assert.equal(latestScan(c.database,dataset.id,file.id,file.sha256).outcome,'failed');
  assert.throws(()=>c.processing.transaction(()=>recordScan(c.database,{...base,sha256:'c'.repeat(64),outcome:'ignored'})),{code:'gcp_source_snapshot_mismatch'});
  assert.throws(()=>c.database.prepare('UPDATE gcp_source_scan_attempts SET outcome=? WHERE id=?').run('ignored',first.id),/immutable/);
});

test('valid automatic import commits its scan record with the GCP set', async (t) => {
  const c=fixture(t),project=c.processing.createProject({displayName:'Atomic scan'}),relativePath=crypto.randomUUID();
  const dataset=c.processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath});
  const content=Buffer.from('point_id,label,latitude,longitude,elevation_m,description\nA,Target,44.5,-88.1,250,test\n');
  const file={id:crypto.randomUUID(),relativePath:'control.csv',byteSize:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex'),contentType:'text/csv'};
  const directory=path.join(c.mounts.datasets,relativePath);fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,file.relativePath),content);
  c.processing.finalizeDataset(dataset.id,[file],'a'.repeat(64));
  c.database.exec("CREATE TRIGGER fail_scan_test BEFORE INSERT ON gcp_source_scan_attempts BEGIN SELECT RAISE(ABORT,'injected ledger failure'); END");
  const failed=await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id);
  assert.equal(failed.failed,1);
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM gcp_sets WHERE dataset_id=?').get(dataset.id).n,0);
  c.database.exec('DROP TRIGGER fail_scan_test');
  await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id);
  const scan=latestScan(c.database,dataset.id,file.id,file.sha256);
  assert.equal(scan.outcome,'imported');assert.equal(scan.point_count,1);
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM gcp_sets WHERE id=?').get(scan.gcp_set_id).n,1);
  assert.equal(new (require('../server/gcpRepository').GcpRepository)(c.database).deleteSet(scan.gcp_set_id),true);
  assert.throws(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)),{code:'gcp_scan_pending'});
  await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id,null,{pendingOnly:true});
  const rescanned=latestScan(c.database,dataset.id,file.id,file.sha256);
  assert.equal(rescanned.outcome,'imported');assert.notEqual(rescanned.gcp_set_id,scan.gcp_set_id);
  assert.throws(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)),{code:'gcp_review_required'});
});

test('empty CSVs are verified and oversized CSVs are classified by size within the retry budget', async (t) => {
  const c=fixture(t),project=c.processing.createProject({displayName:'CSV size limits'}),relativePath=crypto.randomUUID();
  const dataset=c.processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath});
  const directory=path.join(c.mounts.datasets,relativePath);fs.mkdirSync(directory,{recursive:true});
  const files=[['empty.csv',Buffer.alloc(0)],['large.csv',Buffer.alloc(2*1024*1024+1,120)]].map(([name,content])=>{
    fs.writeFileSync(path.join(directory,name),content);
    return {id:crypto.randomUUID(),relativePath:name,byteSize:content.length,sha256:crypto.createHash('sha256').update(content).digest('hex'),contentType:'text/csv'};
  });
  c.processing.finalizeDataset(dataset.id,files,'a'.repeat(64));
  const result=await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id,null,{pendingOnly:true,maxFiles:20,maxBytes:1});
  assert.equal(result.ignored,2);assert.equal(result.failed,0);
  assert.deepEqual(files.map(file=>latestScan(c.database,dataset.id,file.id,file.sha256).reason_code),['empty','too_large']);
  assert.doesNotThrow(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)));
});

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
  assert.throws(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)),{code:'gcp_scan_pending'});

  const held = c.database.prepare('SELECT dataset_file_id,sha256,byte_size,retention_reason FROM retained_dataset_files WHERE dataset_id=?').all(dataset.id);
  assert.deepEqual(held.map((row) => ({ ...row })), [{ dataset_file_id: file.id, sha256: file.sha256,
    byte_size: file.byteSize, retention_reason: 'gcp_source' }]);
  const result = await autoImportGcpSources({ processing: c.processing, storage: c.storage }, dataset.id, 'ops:test');
  assert.equal(result.imported.length, 0);
  assert.equal(result.ignored, 1);
  const scan = latestScan(c.database,dataset.id,file.id,file.sha256);
  assert.equal(scan.outcome,'ignored');
  assert.equal(scan.reason_code,'unrecognized_format');
  assert.doesNotThrow(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)));
  await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id,'ops:test');
  assert.equal(c.database.prepare('SELECT COUNT(*) n FROM gcp_source_scan_attempts WHERE source_file_id=?').get(file.id).n,1);
  fs.writeFileSync(path.join(directory,'unrelated.csv'),Buffer.alloc(content.length,120));
  const failed = await autoImportGcpSources({processing:c.processing,storage:c.storage},dataset.id,'ops:test');
  assert.equal(failed.failed,1);
  assert.throws(()=>c.processing.assertGcpAttemptChoice(c.processing.getDataset(dataset.id,true)),{code:'gcp_scan_failed'});
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
    processing_role) VALUES (?,?,?,?,?,?,?,?,?)`).run(id, dataset.id, 'unrecognized.csv', 12, digest, 'text/csv', '{}', createdAt, 'auto');
  database.prepare(`UPDATE datasets SET status='finalized',manifest_sha256=?,file_count=1,byte_size=12,finalized_at=?,updated_at=? WHERE id=?`)
    .run('c'.repeat(64), createdAt, createdAt, dataset.id);

  applyMigrations(database);
  const hold = database.prepare('SELECT dataset_file_id,sha256,byte_size,retention_reason FROM retained_dataset_files WHERE dataset_file_id=?').get(id);
  assert.deepEqual({ ...hold }, { dataset_file_id: id, sha256: digest, byte_size: 12, retention_reason: 'gcp_source' });
  assert.equal(processing.hasRetainedGcpSource(dataset.id), true);
  database.close();
});
