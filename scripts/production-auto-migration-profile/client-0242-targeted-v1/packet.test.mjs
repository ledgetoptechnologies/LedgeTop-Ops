import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SOURCE_COMMIT } from '../source38-inventory-v2/gate.mjs';
import { compileClient0242Packet, ACCOUNT_ID, DATABASE_ID, MIGRATION_BLOB_OID,
  MIGRATION_NAME, MIGRATION_SHA256, PROFILE, REMAINING_PENDING, SOURCE_PENDING,
  TARGET_LEDGER_ID } from './packet.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const profileDir = path.join(root, 'scripts/production-auto-migration-profile/source38-inventory-v2');
const manifestBytes = readFileSync(path.join(profileDir, 'reconciliation-manifest.json'));
const appendPlanBytes = readFileSync(path.join(profileDir, 'append-plan.json'));
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const baseRows = manifest.databases.client.orderedRows;
const migrationDirectory = path.join(root, 'apps/client/migrations');
const sourceRows = manifest.databases.client.sourceMigrations;
const localMigrationNames = readdirSync(migrationDirectory).filter(name => /^\d{4}_.+\.sql$/u.test(name)).sort();
const sourceFiles = localMigrationNames.map(name => ({ name, bytes: readFileSync(path.join(migrationDirectory, name)) }));
const migrationSql = sourceFiles.find(file => file.name === MIGRATION_NAME).bytes;
const statementMeta = Object.freeze({ changes: 0, rows_written: 0, changed_db: false });
const sourceEvidence = () => ({ manifestBytes, appendPlanBytes, sourceCommit: SOURCE_COMMIT, databaseId: DATABASE_ID,
  sourceRows, sourceFiles, localMigrationNames, ledgerRows: baseRows, statementMeta, migrationSql });
const TEST_RUN_ID = '00000000-0000-4000-8000-000000000242';

function makeDb() {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec(`CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL);
    CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY);
    CREATE TABLE _cf_probe_internal(id TEXT);`);
  const insert = db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)');
  for (const row of baseRows) insert.run(row.id, row.name);
  return db;
}

function schemaSnapshot(db) {
  return {
    schemaVersion: 1,
    observedAt: '2026-10-30T12:00:00.000Z',
    accountId: ACCOUNT_ID,
    databaseId: DATABASE_ID,
    metadataOnly: true,
    ledger: baseRows,
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name").all()
      .map(row => ({ ...row })),
    parent: db.prepare('PRAGMA table_info(portal_v2_identities)').all().map(row => ({ ...row })),
  };
}

function compile(db, overrides = {}) {
  return compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: schemaSnapshot(db), runId: TEST_RUN_ID,
    ...overrides });
}

function runRestBatchTransaction(db, batch) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const statement of batch) {
      if (statement.params.length) db.prepare(statement.sql).run(...statement.params);
      else db.exec(statement.sql);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function ledger(db) {
  return db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all().map(row => ({ ...row }));
}

test('pins source38 profile, target migration, baseline and one selected append', () => {
  const db = makeDb();
  try {
    const evidence = sourceEvidence();
    const before = JSON.stringify(evidence);
    const packet = compile(db);
    assert.equal(packet.profile, PROFILE);
    assert.equal(packet.status, 'review-candidate-not-executable');
    assert.equal(packet.held, true);
    assert.equal(packet.target.accountId, ACCOUNT_ID);
    assert.equal(packet.target.databaseId, '7f40a7b7-c3ec-470e-a626-e798867f71f8');
    assert.equal(packet.source.commit, '38ad7ebcfc09e4334de846d5307e7dac5a0ff327');
    assert.equal(packet.source.manifestSha256, '20722fd99f78dbb5052a4914fd5ba308afb6b0213be61aa4a04c9321e012ede6');
    assert.equal(packet.source.appendPlanSha256, 'ecdd9d0673a075e94b3dd3005103a8d898bd85fd5ba5af988cbbae612ecbeaa1');
    assert.equal(packet.source.migration.gitBlobOid, MIGRATION_BLOB_OID);
    assert.equal(packet.source.migration.sha256, MIGRATION_SHA256);
    assert.equal(packet.source.migration.ledgerId, TARGET_LEDGER_ID);
    assert.equal(packet.baseline.rowCount, 158);
    assert.equal(packet.sourceMigrationCount, 161);
    assert.equal(sourceFiles.length, 161);
    assert.equal(localMigrationNames.length, 161);
    assert.deepEqual(packet.baseline.preservedHistoricalRows, [
      { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
      { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
    ]);
    assert.deepEqual(packet.sourcePending, SOURCE_PENDING);
    assert.equal(packet.selected, MIGRATION_NAME);
    assert.deepEqual(packet.remainsPending, REMAINING_PENDING);
    assert.equal(packet.batchStatementCount, 9);
    assert.equal(packet.requestBody.batch[0].sql.startsWith('CREATE TABLE "__codex_client0242_guard_'), true);
    assert.deepEqual(packet.requestBody.batch.at(-1), {
      sql: 'INSERT INTO d1_migrations(id,name) VALUES(?,?)', params: ['159', MIGRATION_NAME],
    });
    assert.equal(packet.executesDdl, false);
    assert.equal(packet.providerAccessed, false);
    assert.equal(packet.providerWrites, 0);
    assert.equal(packet.authorizesMigration, false);
    assert.equal(packet.authorizesFeatureActivation, false);
    assert.equal(packet.applicationReady, false);
    assert.equal(Object.isFrozen(packet.requestBody.batch), true);
    assert.ok(packet.requestBody.batch.every(statement => statement.params.every(value => typeof value === 'string')));
    assert.equal(JSON.stringify(evidence), before, 'compiler must not mutate evidence input');
    const capsuleOrderSnapshot = { ...schemaSnapshot(db), ledger: baseRows.map(({ id, name }) => ({ id, name })) };
    assert.equal(compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: capsuleOrderSnapshot,
      runId: '00000000-0000-4000-8000-000000000243' }).status, 'review-candidate-not-executable');
  } finally { db.close(); }
});

test('does not emit a batch when target schema evidence is missing', () => {
  const result = compileClient0242Packet(sourceEvidence());
  assert.equal(result.status, 'held-required-schema-snapshot-missing');
  assert.equal(result.requestBody, null);
  assert.equal(result.authorizesMigration, false);
  assert.equal(result.applicationReady, false);
});

test('synthetic exact-base transaction appends only 0242 and preserves historical rows', () => {
  const db = makeDb();
  try {
    const before = ledger(db);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='_cf_probe_internal'").get().n, 1);
    assert.equal(schemaSnapshot(db).schema.some(row => row.name === '_cf_probe_internal'), false);
    const packet = compile(db);
    runRestBatchTransaction(db, packet.requestBody.batch);
    assert.deepEqual(ledger(db).slice(0, 158), before);
    assert.deepEqual(ledger(db).slice(30, 32), [
      { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
      { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
    ]);
    assert.deepEqual(ledger(db).at(-1), { id: TARGET_LEDGER_ID, name: MIGRATION_NAME });
    assert.equal(ledger(db).length, 159);
    assert.deepEqual(db.prepare(`SELECT name FROM sqlite_schema WHERE name IN ('client_ops_triage_inquiries',
      'client_ops_triage_notification_outbox','idx_client_ops_triage_inquiries_queue',
      'idx_client_ops_triage_inquiries_identity','idx_client_ops_triage_outbox_ready') ORDER BY name`).all()
      .map(row => row.name), [
      'client_ops_triage_inquiries', 'client_ops_triage_notification_outbox',
      'idx_client_ops_triage_inquiries_identity', 'idx_client_ops_triage_inquiries_queue',
      'idx_client_ops_triage_outbox_ready',
    ]);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
});

test('transaction guard rejects a changed baseline or schema without partial DDL', () => {
  const db = makeDb();
  try {
    const packet = compile(db);
    db.prepare("UPDATE d1_migrations SET name='unexpected-history' WHERE id=1").run();
    assert.throws(() => runRestBatchTransaction(db, packet.requestBody.batch));
    assert.equal(ledger(db).length, 158);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='client_ops_triage_inquiries'").get().n, 0);

    db.prepare("UPDATE d1_migrations SET name=? WHERE id=1").run(baseRows[0].name);
    const fresh = compile(db);
    db.exec('CREATE TABLE schema_drift(id TEXT PRIMARY KEY)');
    assert.throws(() => runRestBatchTransaction(db, fresh.requestBody.batch));
    assert.equal(ledger(db).length, 158);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='client_ops_triage_inquiries'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='schema_drift'").get().n, 1);
  } finally { db.close(); }
});

test('transaction guard refuses when foreign-key enforcement is disabled after compilation', () => {
  const db = makeDb();
  try {
    const packet = compile(db);
    const before = ledger(db);
    db.exec('PRAGMA foreign_keys=OFF');
    assert.equal(db.prepare('SELECT foreign_keys FROM pragma_foreign_keys').get().foreign_keys, 0);
    assert.throws(() => runRestBatchTransaction(db, packet.requestBody.batch));
    assert.deepEqual(ledger(db), before);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='client_ops_triage_inquiries'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE '__codex_client0242_guard_%'").get().n, 0);
    assert.equal(db.prepare('SELECT foreign_keys FROM pragma_foreign_keys').get().foreign_keys, 0);
  } finally { db.close(); }
});

test('replay after success is refused and rolls back guard work', () => {
  const db = makeDb();
  try {
    const packet = compile(db);
    runRestBatchTransaction(db, packet.requestBody.batch);
    assert.throws(() => runRestBatchTransaction(db, packet.requestBody.batch));
    assert.equal(ledger(db).length, 159);
    assert.equal(ledger(db).at(-1).name, MIGRATION_NAME);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name LIKE '__codex_client0242_guard_%'").get().n, 0);
  } finally { db.close(); }
});

test('wrong source, database, baseline order, schema parent, and migration bytes fail closed', () => {
  const db = makeDb();
  try {
    const snapshot = schemaSnapshot(db);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot, runId: TEST_RUN_ID,
      sourceCommit: '1'.repeat(40) }), /inventory_source_commit_mismatch/);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot, runId: TEST_RUN_ID,
      databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd' }), /targeted_database_mismatch/);
    const reordered = [...baseRows]; [reordered[4], reordered[5]] = [reordered[5], reordered[4]];
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot, ledgerRows: reordered,
      runId: TEST_RUN_ID }), /inventory_base_ledger_mismatch/);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot,
      ledgerRows: baseRows.slice(0, -1), runId: TEST_RUN_ID }), /inventory_unknown_or_partial_ledger/);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot,
      statementMeta: { changes: 1, rows_written: 1, changed_db: true }, runId: TEST_RUN_ID }),
    /inventory_write_metadata_detected/);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot,
      appendPlanBytes: Buffer.from(appendPlanBytes).fill(0), runId: TEST_RUN_ID }), /inventory_append_plan_unpinned/);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot,
      localMigrationNames: localMigrationNames.slice(0, -1), runId: TEST_RUN_ID }), /inventory_current_source_mismatch/);
    const noParent = { ...snapshot, schema: snapshot.schema.filter(row => row.name !== 'portal_v2_identities') };
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: noParent,
      runId: TEST_RUN_ID }), /targeted_schema_ledger_mismatch|targeted_schema_prerequisite_missing|targeted_schema_objects_invalid/);
    const badMigration = Buffer.from(migrationSql); badMigration[0] ^= 1;
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: snapshot,
      migrationSql: badMigration, runId: TEST_RUN_ID }), /targeted_migration_source_disagreement/);
  } finally { db.close(); }
});

test('wrong schema target and pending-object collision are rejected', () => {
  const db = makeDb();
  try {
    const snapshot = schemaSnapshot(db);
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(),
      schemaSnapshot: { ...snapshot, databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd' }, runId: TEST_RUN_ID }),
    /targeted_schema_snapshot_invalid/);
    const collision = { ...snapshot, schema: [...snapshot.schema,
      { type: 'table', name: 'client_ops_triage_inquiries', tbl_name: 'client_ops_triage_inquiries', sql: 'CREATE TABLE x(id)' }] };
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: collision,
      runId: TEST_RUN_ID }), /targeted_target_object_already_exists/);
    const internalInSnapshot = { ...snapshot, schema: [...snapshot.schema,
      { type: 'table', name: '_cf_snapshot_internal', tbl_name: '_cf_snapshot_internal', sql: 'CREATE TABLE _cf_snapshot_internal(id)' }] };
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: internalInSnapshot,
      runId: TEST_RUN_ID }), /targeted_schema_object_invalid/);
    const missingSql = { ...snapshot, schema: snapshot.schema.map(row => row.name === 'portal_v2_identities'
      ? { ...row, sql: null } : row) };
    assert.throws(() => compileClient0242Packet({ ...sourceEvidence(), schemaSnapshot: missingSql,
      runId: TEST_RUN_ID }), /targeted_schema_object_invalid/);
  } finally { db.close(); }
});
