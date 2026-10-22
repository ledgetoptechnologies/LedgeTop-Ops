'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const { MIGRATIONS, openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

const databaseModule = path.resolve(__dirname, '..', 'server', 'database.js');
const childSource = "const {openDatabase}=require(process.argv[1]);const db=openDatabase(process.argv[2]);db.close();";

function openInChild(databasePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childSource, databaseModule, databasePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0
      ? resolve()
      : reject(new Error(`database child exited ${code}: ${Buffer.concat(stderr).toString('utf8')}`)));
  });
}

function temporaryDatabase(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `viewer-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'viewer.sqlite');
}

function assertFullyMigrated(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((row) => row.version);
    assert.deepEqual(versions, MIGRATIONS.map((migration) => migration.version));
    assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { database.close(); }
}

test('two processes serialize migrations on a new shared volume', async (t) => {
  const databasePath = temporaryDatabase(t, 'migration-empty');
  await Promise.all([openInChild(databasePath), openInChild(databasePath)]);
  assertFullyMigrated(databasePath);
});

test('two processes serialize the same pending upgrade migration', async (t) => {
  const databasePath = temporaryDatabase(t, 'migration-upgrade');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.slice(0, -1)) {
    database.exec('BEGIN IMMEDIATE');
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
    database.exec('COMMIT');
  }
  database.close();

  await Promise.all([openInChild(databasePath), openInChild(databasePath)]);
  assertFullyMigrated(databasePath);
});

test('v28 preserves operation receipts and creates the complete retained-import schema', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v28-retained-imports');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 28)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = new Date().toISOString(), future = new Date(Date.now() + 60_000).toISOString();
  const legacyProcessing=new ProcessingRepository(database),legacyRepository=new ViewerRepository(database),legacyProject=legacyProcessing.createProject({displayName:'Legacy accounting'}),legacyDataset=legacyProcessing.createDataset({projectId:legacyProject.id,displayName:'Legacy source',storageMode:'managed',rootKey:'datasets',relativePath:'legacy-source'});legacyProcessing.finalizeDataset(legacyDataset.id,[{relativePath:'model.glb',byteSize:123,sha256:'b'.repeat(64)}],'c'.repeat(64));const legacyTask=legacyProcessing.createTask({projectId:legacyProject.id,datasetId:legacyDataset.id,displayName:'Legacy task'}),legacyAttempt=legacyProcessing.createImportedAttempt({id:crypto.randomUUID(),taskId:legacyTask.id,datasetId:legacyDataset.id,providerTaskId:'legacy:v28',createdBy:'ops:test',staged:false}),legacyModel=legacyRepository.upsertModelVersion({provider:'webodm',providerModelId:'legacy:v28',providerVersionId:legacyAttempt.id,displayName:'Legacy task',status:'ready',assets:[],makeActive:false}),legacyVersionId=database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(legacyModel.id).id;legacyProcessing.setAttemptResult(legacyAttempt.id,legacyModel.id,legacyVersionId);database.prepare("INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at) VALUES (?,?,?,?,?,'models',?,'managed','ready',123,0,?,?)").run(legacyVersionId,legacyModel.id,legacyTask.id,legacyAttempt.id,legacyProject.id,`${legacyTask.id}/${legacyAttempt.id}`,created,created);
  for (const status of ['queued','leased','succeeded','failed']) {
    const id=`operation-${status}`;
    database.prepare(`INSERT INTO dataset_operations(id,operation_type,subject,payload_json,status,lease_owner,lease_expires_at,available_at,created_at,updated_at,completed_at)
      VALUES (?,'catalog_map','ops:test','{}',?,?,?,?,?,?,?)`).run(id,status,status==='leased'?'legacy-worker':null,status==='leased'?future:null,created,created,created,['succeeded','failed'].includes(status)?created:null);
    database.prepare("INSERT INTO subject_operation_receipts(subject,client_key,method,path,request_sha256,operation_id,created_at,updated_at) VALUES ('ops:test',?,'POST','/imports',?,?,?,?)").run(`receipt-${status}`,crypto.createHash('sha256').update(status).digest('hex'),id,created,created);
  }
  database.close();

  const upgraded = openDatabase(databasePath);
  const columns = upgraded.prepare('PRAGMA table_info(dataset_operations)').all().map((row) => row.name);
  assert.ok(columns.includes('processing_attempt_id'));
  assert.equal(columns.includes('awaiting_derivatives'),false);
  assert.deepEqual(upgraded.prepare('SELECT id,status FROM dataset_operations ORDER BY id').all().map((row)=>[row.id,row.status]),[['operation-failed','failed'],['operation-leased','leased'],['operation-queued','queued'],['operation-succeeded','succeeded']]);
  assert.deepEqual(upgraded.prepare('SELECT client_key,operation_id FROM subject_operation_receipts ORDER BY client_key').all().map((row)=>[row.client_key,row.operation_id]),[['receipt-failed','operation-failed'],['receipt-leased','operation-leased'],['receipt-queued','operation-queued'],['receipt-succeeded','operation-succeeded']]);
  const tables=['retained_imports','retained_import_files','import_cleanup_jobs','model_output_storage_components','derivative_storage_journal'];
  for(const name of tables)assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name),name);
  const baseComponent=upgraded.prepare("SELECT component_key,root_key,relative_path,byte_size FROM model_output_storage_components WHERE output_id=?").get(legacyVersionId);assert.equal(baseComponent.component_key,'base');assert.equal(baseComponent.root_key,'models');assert.equal(baseComponent.relative_path,`${legacyTask.id}/${legacyAttempt.id}`);assert.equal(baseComponent.byte_size,123);
  const identityTypes=Object.fromEntries(upgraded.prepare('PRAGMA table_info(retained_imports)').all().filter((row)=>['source_dev','source_ino','source_ctime_ns','source_mtime_ns'].includes(row.name)).map((row)=>[row.name,row.type]));
  assert.deepEqual(identityTypes,{source_dev:'TEXT',source_ino:'TEXT',source_ctime_ns:'TEXT',source_mtime_ns:'TEXT'});
  assert.match(upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='dataset_operations'").get().sql,/awaiting_derivatives/);
  assert.throws(()=>upgraded.prepare("UPDATE dataset_operations SET status='awaiting_derivatives' WHERE id='operation-failed'").run(),/CHECK constraint failed/);
  const insertRetained=upgraded.prepare(`INSERT INTO retained_imports(id,source_kind,staging_root_key,staging_relative_path,active_slot,slot_lease_owner,slot_lease_token,slot_lease_expires_at,state,created_at,updated_at)
    VALUES (?,'nodeodm_result','cache',?,1,'worker','token',?,'source_snapshotted',?,?)`);
  insertRetained.run('retained-one','one',future,created,created);
  assert.throws(()=>insertRetained.run('retained-two','two',future,created,created),/UNIQUE constraint failed/);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]);
  upgraded.close();
});

test('v29 upgrades already-applied v28 cleanup journals without rewriting migration history', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v29-cleanup-executor');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version <= 28)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = '2026-09-01T00:00:00.000Z';
  const future = '2099-01-01T00:00:00.000Z';
  const insertRetained = database.prepare(`INSERT INTO retained_imports(
    id,source_kind,staging_root_key,staging_relative_path,active_slot,state,cleanup_jobs_inserted,created_at,updated_at
  ) VALUES (?,'nodeodm_result','cache',?,1,'ready',1,?,?)`);
  const insertCleanup = database.prepare(`INSERT INTO import_cleanup_jobs(
    id,retained_import_id,cleanup_type,root_key,relative_path,quarantine_relative_path,status,
    lease_owner,lease_token,lease_expires_at,available_at,created_at,updated_at
  ) VALUES (?,?,'staging_tree','cache',?,?,?,?,?,?,?,?,?)`);
  for (const id of ['pending','leased','broken-quarantined','terminal-with-lease']) {
    insertRetained.run(`retained-${id}`, `webodm-task-imports/retained-${id}`, created, created);
  }
  insertCleanup.run('cleanup-pending','retained-pending','webodm-task-imports/retained-pending',null,'pending',null,null,null,created,created,created);
  insertCleanup.run('cleanup-leased','retained-leased','webodm-task-imports/retained-leased',null,'leased','worker','a'.repeat(32),future,created,created,created);
  insertCleanup.run('cleanup-broken-quarantined','retained-broken-quarantined','webodm-task-imports/retained-broken-quarantined','webodm-task-imports/retained-broken-quarantined.cleanup-a.quarantine','quarantined',null,null,null,created,created,created);
  insertCleanup.run('cleanup-terminal','retained-terminal-with-lease','webodm-task-imports/retained-terminal-with-lease',null,'source_changed','stale-worker','b'.repeat(32),future,created,created,created);
  database.close();

  const upgraded = openDatabase(databasePath);
  assert.equal(upgraded.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 38);
  const tableSql = upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='import_cleanup_jobs'").get().sql;
  assert.match(tableSql, /cleanup_quarantine_conflict/);
  assert.match(tableSql, /status IN \('leased','quarantined'\)/);
  assert.equal(upgraded.prepare("SELECT status,lease_owner FROM import_cleanup_jobs WHERE id='cleanup-leased'").get().status, 'leased');
  assert.deepEqual({ ...upgraded.prepare("SELECT status,lease_owner,lease_token,lease_expires_at FROM import_cleanup_jobs WHERE id='cleanup-broken-quarantined'").get() }, {
    status: 'pending', lease_owner: null, lease_token: null, lease_expires_at: null,
  });
  assert.deepEqual({ ...upgraded.prepare("SELECT status,lease_owner,lease_token,lease_expires_at FROM import_cleanup_jobs WHERE id='cleanup-terminal'").get() }, {
    status: 'source_changed', lease_owner: null, lease_token: null, lease_expires_at: null,
  });
  assert.throws(() => upgraded.prepare("UPDATE import_cleanup_jobs SET status='quarantined' WHERE id='cleanup-pending'").run(), /CHECK constraint failed/);
  assert.throws(() => upgraded.prepare("UPDATE import_cleanup_jobs SET lease_owner='stale',lease_token='stale',lease_expires_at=? WHERE id='cleanup-terminal'").run(future), /CHECK constraint failed/);
  assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(), []);
  upgraded.close();
});

test('v28 refuses a partially initialized retained-import schema without modifying v27', (t) => {
  const databasePath=temporaryDatabase(t,'migration-v28-corrupt-partial'),database=new DatabaseSync(databasePath);database.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const migration of MIGRATIONS.filter((item)=>item.version<28)){database.exec(migration.sql);database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());}database.exec('CREATE TABLE retained_imports(unexpected TEXT)');database.close();
  assert.throws(()=>openDatabase(databasePath),/migration_v28_guard|UNIQUE constraint failed/);const unchanged=new DatabaseSync(databasePath,{readOnly:true});assert.equal(unchanged.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,27);assert.ok(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retained_imports'").get());assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='retained_import_files'").get(),undefined);unchanged.close();
});

test('v28 reconciles all heavy leases and expands the singleton to EPT', (t) => {
  const databasePath=temporaryDatabase(t,'migration-v28-heavy-singleton'),database=new DatabaseSync(databasePath);database.exec('PRAGMA foreign_keys=OFF');database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const migration of MIGRATIONS.filter((item)=>item.version<28)){database.exec(migration.sql);database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());}
  const past='2000-01-01T00:00:00.000Z',created='2026-01-01T00:00:00.000Z',futureOne=new Date(Date.now()+60_000).toISOString(),futureTwo=new Date(Date.now()+120_000).toISOString(),futureThree=new Date(Date.now()+180_000).toISOString(),insert=database.prepare(`INSERT INTO derivative_jobs(id,attempt_id,derivative_type,status,request_json,result_json,lease_owner,lease_token,lease_expires_at,heartbeat_at,attempt_count,first_started_at,deadline_at,created_at,updated_at)
    VALUES (?,?,?,'leased','{}','{}',?,?,?,?,1,?,?,?,?)`);
  insert.run('expired-ept','attempt-expired','ept','expired-owner','expired-token',past,created,created,past,created,created);
  insert.run('future-mesh','attempt-mesh','mesh_tiles','mesh-owner','mesh-token',futureOne,created,created,futureTwo,created,created);database.prepare("UPDATE derivative_jobs SET attempt_count=3 WHERE id='future-mesh'").run();
  insert.run('future-ept','attempt-ept','ept','ept-owner','ept-token',futureTwo,created,created,futureTwo,created,'2026-01-01T00:00:01.000Z');
  insert.run('legacy-tokenless','attempt-tokenless','ept','legacy-owner',null,futureThree,created,created,futureThree,created,'2026-01-01T00:00:02.000Z');database.close();
  const upgraded=openDatabase(databasePath),rows=Object.fromEntries(upgraded.prepare("SELECT id,status,lease_owner,lease_token FROM derivative_jobs WHERE id IN ('expired-ept','future-mesh','future-ept','legacy-tokenless')").all().map((row)=>[row.id,row]));
  assert.equal(rows['expired-ept'].status,'failed');assert.equal(rows['expired-ept'].lease_token,null);assert.equal(rows['future-mesh'].status,'failed');assert.equal(rows['future-mesh'].lease_owner,null);assert.equal(rows['future-mesh'].lease_token,null);assert.equal(rows['future-ept'].status,'leased');assert.equal(rows['future-ept'].lease_token,'ept-token');assert.equal(rows['legacy-tokenless'].status,'pending');assert.equal(rows['legacy-tokenless'].lease_owner,null);assert.equal(rows['legacy-tokenless'].lease_token,null);
  const lock=upgraded.prepare('SELECT job_id,lease_owner,lease_token FROM lod_conversion_lock WHERE id=1').get();assert.equal(lock.job_id,'future-ept');assert.equal(lock.lease_owner,'ept-owner');assert.equal(lock.lease_token,'ept-token');assert.ok(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_single_heavy_lease'").get());assert.equal(upgraded.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_single_lod_lease'").get(),undefined);assert.match(upgraded.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='derivative_jobs_deadline_idx'").get().sql,/'ept'/);
  assert.throws(()=>upgraded.prepare("UPDATE derivative_jobs SET status='leased',lease_owner='other',lease_token='other-token',lease_expires_at=? WHERE id='future-mesh'").run(futureTwo),/UNIQUE constraint failed/);upgraded.close();
});

test('v28 propagates an expired required heavy lease to its owning processing state', (t) => {
  const databasePath=temporaryDatabase(t,'migration-v28-required-terminal'),database=new DatabaseSync(databasePath);database.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');for(const migration of MIGRATIONS.filter((item)=>item.version<28)){database.exec(migration.sql);database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());}const processing=new ProcessingRepository(database),repository=new ViewerRepository(database),project=processing.createProject({displayName:'Expired migration'}),data=processing.createDataset({projectId:project.id,displayName:'Expired source',storageMode:'managed',rootKey:'datasets',relativePath:'expired-source'});processing.finalizeDataset(data.id,[{relativePath:'cloud.laz',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));const task=processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Expired task'}),attempt=processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:data.id,providerTaskId:'migration:expired',createdBy:'ops:test'}),model=repository.upsertModelVersion({provider:'webodm',providerModelId:'migration:expired',providerVersionId:attempt.id,displayName:task.displayName,status:'importing',assets:[],makeActive:false}),versionId=database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id,created=new Date().toISOString();processing.setAttemptResult(attempt.id,model.id,versionId);database.prepare("INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,storage_mode,status,byte_size,asset_count,created_at,updated_at) VALUES (?,?,?,?,?,'models',?,'managed','staged',1,0,?,?)").run(versionId,model.id,task.id,attempt.id,project.id,`${task.id}/${attempt.id}`,created,created);database.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(attempt.id);database.prepare("UPDATE processing_tasks SET status='processing' WHERE id=?").run(task.id);const jobId=processing.enqueueDerivative(attempt.id,'ept',{optional:false}),past='2000-01-01T00:00:00.000Z';database.prepare("UPDATE derivative_jobs SET status='leased',lease_owner='legacy-worker',lease_token='11111111111111111111111111111111',lease_expires_at=?,heartbeat_at=?,attempt_count=3,first_started_at=?,deadline_at=? WHERE id=?").run(past,past,past,past,jobId);database.prepare("UPDATE lod_conversion_lock SET job_id=?,lease_owner='legacy-worker',lease_token='11111111111111111111111111111111',lease_expires_at=?,heartbeat_at=? WHERE id=1").run(jobId,past,past);database.close();const upgraded=openDatabase(databasePath);t.after(()=>upgraded.close());assert.equal(upgraded.prepare('SELECT status FROM derivative_jobs WHERE id=?').get(jobId).status,'failed');assert.equal(upgraded.prepare('SELECT status FROM processing_attempts WHERE id=?').get(attempt.id).status,'failed');assert.equal(upgraded.prepare('SELECT status FROM processing_tasks WHERE id=?').get(task.id).status,'failed');assert.equal(upgraded.prepare('SELECT status FROM model_outputs WHERE id=?').get(versionId).status,'failed');assert.equal(upgraded.prepare('SELECT status FROM model_versions WHERE id=?').get(versionId).status,'failed');assert.equal(upgraded.prepare('SELECT status FROM models WHERE id=?').get(model.id).status,'failed');assert.equal(upgraded.prepare("SELECT COUNT(*) n FROM event_outbox WHERE id=? AND event_type='processing.failed'").get(`processing-failed-${attempt.id}`).n,1);assert.deepEqual(upgraded.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('v27 reconciles legacy parallel LOD leases before enforcing database singleton uniqueness', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v27-lod-singleton');
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=OFF');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 27)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = new Date().toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  const insert = database.prepare(`INSERT INTO derivative_jobs(
    id,attempt_id,derivative_type,status,request_json,result_json,lease_owner,lease_expires_at,heartbeat_at,created_at,updated_at
  ) VALUES (?,?,?,'leased','{}','{}',?,?,?,?,?)`);
  insert.run('legacy-lod-one', 'legacy-attempt-one', 'mesh_tiles', 'legacy-one', future, created, created, created);
  insert.run('legacy-lod-two', 'legacy-attempt-two', 'lod_audit', 'legacy-two', future, created, created, created);

  const migration = MIGRATIONS.find((item) => item.version === 27);
  database.exec('BEGIN IMMEDIATE');
  database.exec(migration.sql);
  database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
    .run(migration.version, migration.name, new Date().toISOString());
  database.exec('COMMIT');

  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='leased'").get().n, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS n FROM derivative_jobs WHERE derivative_type IN ('mesh_tiles','lod_audit') AND status='pending'").get().n, 1);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_single_lod_lease'").get());
  const pending = database.prepare("SELECT id FROM derivative_jobs WHERE status='pending'").get();
  assert.throws(
    () => database.prepare("UPDATE derivative_jobs SET status='leased',lease_owner='old-worker',lease_expires_at=? WHERE id=?").run(future, pending.id),
    /UNIQUE constraint failed/,
  );
  database.close();
});

test('v17 fails closed for legacy live unbound published authorization state', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v17-auth');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 17)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  database.exec('PRAGMA foreign_keys=OFF');
  const future = new Date(Date.now() + 60_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const created = new Date().toISOString();
  const insertGrant = database.prepare(`INSERT INTO session_grants(
    id,model_id,subject,audience,permissions_json,expires_at,redeemed_at,created_at,session_mode
  ) VALUES (?,?,?,?,?,?,?,?,?)`);
  insertGrant.run('published-pending', 'model-one', 'ops:one', 'ops', '{}', future, null, created, 'published');
  insertGrant.run('published-redeemed', 'model-one', 'ops:one', 'ops', '{}', future, created, created, 'published');
  insertGrant.run('review-pending', 'model-one', 'ops:one', 'ops', '{}', future, null, created, 'review');
  const insertSession = database.prepare(`INSERT INTO viewer_sessions(
    id,token_hash,model_id,model_version_id,subject,audience,permissions_json,expires_at,revoked_at,created_at,updated_at,session_mode
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  insertSession.run('published-live', 'hash-live', 'model-one', 'version-one', 'ops:one', 'ops', '{}', future, null, created, created, 'published');
  insertSession.run('published-expired', 'hash-expired', 'model-one', 'version-one', 'ops:one', 'ops', '{}', past, null, created, created, 'published');
  insertSession.run('review-live', 'hash-review', 'model-one', 'version-one', 'ops:one', 'ops', '{}', future, null, created, created, 'review');
  database.close();

  const upgraded = openDatabase(databasePath);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='published-pending'").get().count, 0);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='published-redeemed'").get().count, 1);
  assert.equal(upgraded.prepare("SELECT COUNT(*) count FROM session_grants WHERE id='review-pending'").get().count, 1);
  assert.ok(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='published-live'").get().revoked_at);
  assert.equal(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='published-expired'").get().revoked_at, null);
  assert.equal(upgraded.prepare("SELECT revoked_at FROM viewer_sessions WHERE id='review-live'").get().revoked_at, null);
  assert.equal(upgraded.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, MIGRATIONS.at(-1).version);
  upgraded.close();
});

test('v23 persists revision-zero recovery state for terminal pre-upgrade LOD jobs', (t) => {
  const databasePath = temporaryDatabase(t, 'migration-v23-lod-recovery');
  const database = new DatabaseSync(databasePath);
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version < 23)) {
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
  }
  const created = new Date().toISOString();
  database.exec('PRAGMA foreign_keys=OFF');
  database.prepare("INSERT INTO derivative_jobs(id,attempt_id,derivative_type,status,request_json,result_json,created_at,updated_at,completed_at) VALUES (?,?,?,'failed',?,?,?, ?,?)")
    .run('legacy-lod-job', 'legacy-attempt', 'mesh_tiles', JSON.stringify({ optional: true, manualRetryCount: 1 }), JSON.stringify({ error: 'old validator rejected output' }), created, created, created);

  const migration=MIGRATIONS.find((item)=>item.version===23);
  database.exec('BEGIN IMMEDIATE');
  database.exec(migration.sql);
  database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)')
    .run(migration.version,migration.name,new Date().toISOString());
  database.exec('COMMIT');

  const row = database.prepare('SELECT recovery_revision,recovery_requeued_at FROM derivative_jobs WHERE id=?').get('legacy-lod-job');
  assert.equal(row.recovery_revision, 0);
  assert.equal(row.recovery_requeued_at, null);
  assert.ok(database.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='derivative_jobs_lod_recovery_idx'").get());
  assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 23);
  database.close();
});

test('v25 preserves import history while replacing fingerprint uniqueness with a lookup index', (t) => {
  const databasePath=temporaryDatabase(t,'migration-v25-duplicate-imports'),database=new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys=ON');
  database.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for(const migration of MIGRATIONS.filter((item)=>item.version<25)){
    database.exec(migration.sql);
    database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());
  }
  const processing=new ProcessingRepository(database),repository=new ViewerRepository(database),fingerprint='f'.repeat(64);
  const project=processing.createProject({id:'project-one',displayName:'Migration project'});
  const dataset=processing.createDataset({id:'dataset-one',projectId:project.id,displayName:'Migration dataset',sourceType:'webodm',storageMode:'adopted',rootKey:'datasets',relativePath:'dataset-one'});
  processing.finalizeDataset(dataset.id,[],crypto.createHash('sha256').digest('hex'));
  const task=processing.createTask({id:'task-one',projectId:project.id,datasetId:dataset.id,displayName:'Migration task'});
  const attempt=processing.createImportedAttempt({id:'attempt-one',taskId:task.id,datasetId:dataset.id,providerTaskId:'webodm:migration',createdBy:'ops:test',staged:false});
  const model=repository.upsertModelVersion({modelId:'model-one',versionId:'version-one',provider:'webodm',providerModelId:'task-import:import-one',providerVersionId:fingerprint,displayName:'Migration task',status:'ready',assets:[],makeActive:false});
  processing.setAttemptResult(attempt.id,model.id,'version-one');
  processing.recordWebodmTaskImport({id:'import-one',sourceFingerprint:fingerprint,sourceRelativePath:'backup.zip',projectId:project.id,taskId:task.id,datasetId:dataset.id,attemptId:attempt.id,modelId:model.id,modelVersionId:'version-one',assetKinds:[],createdBy:'ops:test'});
  const migration=MIGRATIONS.find((item)=>item.version===25);
  database.exec('BEGIN IMMEDIATE');database.exec(migration.sql);database.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(migration.version,migration.name,new Date().toISOString());database.exec('COMMIT');
  const preserved=database.prepare('SELECT * FROM webodm_task_imports WHERE id=?').get('import-one');
  assert.equal(preserved.source_fingerprint,fingerprint);
  assert.equal(preserved.project_id,project.id);
  assert.equal(preserved.task_id,task.id);
  assert.equal(preserved.dataset_id,dataset.id);
  assert.equal(preserved.attempt_id,attempt.id);
  assert.equal(preserved.model_id,model.id);
  assert.equal(preserved.model_version_id,'version-one');
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(),[]);
  const indexes=database.prepare("PRAGMA index_list('webodm_task_imports')").all(),lookup=indexes.find((item)=>item.name==='webodm_task_imports_fingerprint_idx');
  assert.ok(lookup);
  assert.equal(lookup.unique,0);
  assert.deepEqual(database.prepare("PRAGMA index_info('webodm_task_imports_fingerprint_idx')").all().map((item)=>item.name),['source_fingerprint','created_at','id']);
  assert.doesNotMatch(database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='webodm_task_imports'").get().sql,/source_fingerprint\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version,25);
  database.close();
});
