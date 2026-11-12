import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileStagingV4MigrationPlan, executePreparedStagingV4Step,
  assertFreshStagingV4Controls, buildCurrentStagingV4ControlSnapshot, readCapturedStagingV4Capsule, STAGING_V4_CAPSULE_SHA256,
  STAGING_V4_JOURNAL_PARENT, STAGING_V4_JOURNAL_ROOT, STAGING_V4_LEGACY_JOURNAL_ROOT,
  isStagingV4LegacyJournalMarker, STAGING_V4_MAX_PARAM_BYTES, STAGING_V4_MAX_SQL_BYTES,
  splitMigrationSql, stagingV4JournalPaths, stagingV4MigrationOperatorProfiles,
  validatePreparedStagingV4Plan } from './staging-v4-migration-operator.mjs';

const capsulePath = process.env.LEDGETOP_STAGING_V4_CONTROLS_CAPSULE_PATH;
const fixtureTest = { skip: !capsulePath && 'requires the hash-pinned metadata-only staging controls capsule' };
const expectedNames = Object.freeze({
  operations: Object.freeze([
    '0233_operations_portal_native_recipient_capability_intents.sql',
    '0234_operations_portal_native_inquiry_capability.sql',
    '0235_ops_principal_inquiries.sql',
  ]),
  client: Object.freeze(['0243_operations_portal_native_inquiry_capability.sql']),
});

function capturedSchemaRows(db) {
  return db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
      AND type IN ('table','view','index','trigger') ORDER BY type,name`).all()
    .map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql }));
}

function openCapturedDb(baseline) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const type of ['table', 'index', 'view', 'trigger']) {
    for (const row of baseline.schema.filter(item => item.type === type)) db.exec(row.sql);
  }
  assert.deepEqual(capturedSchemaRows(db), baseline.schema);
  const insert = db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)');
  for (const row of baseline.ledger) insert.run(row.id, row.name);
  return db;
}

function applyLocalBatch(db, body) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of body.batch) db.prepare(item.sql).run(...item.params);
    db.exec('COMMIT');
  } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
}

test('profile boundary is staging-only and selects only the reviewed migration window', () => {
  assert.deepEqual(Object.keys(stagingV4MigrationOperatorProfiles), ['operations', 'client']);
  assert.equal(stagingV4MigrationOperatorProfiles.operations.databaseId, '78b34173-b168-4e3d-9832-bb9d245cc6b8');
  assert.equal(stagingV4MigrationOperatorProfiles.client.databaseId, 'b6f653ab-9acd-4421-9ad0-207754b59aeb');
});

test('Wrangler splitter preserves each trigger body as one statement', () => {
  const statements = splitMigrationSql(fs.readFileSync(path.resolve('apps/operations/migrations/0233_operations_portal_native_recipient_capability_intents.sql'), 'utf8'));
  const triggers = statements.filter(sql => /^CREATE TRIGGER\b/iu.test(sql));
  assert.equal(triggers.length, 4);
  assert(triggers.every(sql => /\bBEGIN\b[\s\S]*\bEND\s*$/iu.test(sql)));
});

test('captured capsule SHA is mandatory', () => {
  if (!capsulePath) return;
  const altered = path.join(os.tmpdir(), `staging-v4-capsule-${process.pid}.json`);
  try {
    fs.writeFileSync(altered, Buffer.concat([fs.readFileSync(capsulePath), Buffer.from(' ')]), { flag: 'wx' });
    assert.throws(() => readCapturedStagingV4Capsule(altered), { code: 'controls_capsule_sha256_mismatch' });
  } finally { if (fs.existsSync(altered)) fs.unlinkSync(altered); }
});

test('compiles both migrations against the exact captured schemas and ledgers in SQLite', fixtureTest, () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  assert.equal(capsule.capsuleSha256, STAGING_V4_CAPSULE_SHA256);
  assert(Object.isFrozen(capsule.byApplication.operations.schema));
  assert(Object.isFrozen(capsule.byApplication.operations.schema[0]));
  const plans = {};
  for (const application of ['operations', 'client']) {
    const plan = compileStagingV4MigrationPlan({ capsule, application,
      runId: application === 'operations' ? '77b33374-8164-4e89-88b9-4a2a0ef12001' : '77b33374-8164-4e89-88b9-4a2a0ef12002' });
    plans[application] = plan;
    assert(Object.isFrozen(plan.steps[0].requestBody.batch));
    assert(Object.isFrozen(plan.steps[0].requestBody.batch[0].params));
    assert.deepEqual(plan.steps.map(step => step.migration), expectedNames[application]);
    assert.equal(plan.executed, false);
    assert.equal(plan.providerWrites, 0);
    assert.equal(plan.steps.every(step => step.retryAllowed === false && step.ddlAfterAllGuards && step.schemaComparisonComplete), true);
    for (const step of plan.steps) {
      assert(step.statementCount <= 100);
      assert(step.requestBodySha256.match(/^[a-f0-9]{64}$/u));
      assert(step.requestBody.batch.every(item => Buffer.byteLength(item.sql, 'utf8') <= STAGING_V4_MAX_SQL_BYTES));
      assert(step.requestBody.batch.every(item => item.params.every(value =>
        Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value), 'utf8') <= STAGING_V4_MAX_PARAM_BYTES)));
      const schemaGuardIndexes = step.requestBody.batch.map((item, index) => item.sql.includes('json_each(?) expected LEFT JOIN sqlite_schema') ? index : -1)
        .filter(index => index >= 0);
      const dropGuardIndex = step.requestBody.batch.findIndex(item => /^DROP TABLE "__codex_staging_v4_/u.test(item.sql));
      assert(schemaGuardIndexes.length >= 1);
      assert(dropGuardIndex > Math.max(...schemaGuardIndexes), 'all full-schema guards precede migration DDL');
    }
  }
  assert.equal(plans.operations.steps[0].pre.schemaObjects, 2443);
  assert.equal(plans.client.steps[0].pre.schemaObjects, 1168);
  assert.deepEqual(plans.operations.steps.map(step => step.pre.ledgerRows), [225, 226, 227]);
  assert.deepEqual(plans.operations.steps.map(step => step.post.ledgerRows), [226, 227, 228]);
  assert.deepEqual(plans.client.steps.map(step => [step.pre.ledgerRows, step.post.ledgerRows]), [[156, 157]]);
});

test('stale ledger or schema in the capsule is refused before compilation', fixtureTest, () => {
  const verified = readCapturedStagingV4Capsule(capsulePath);
  assert.throws(() => { verified.byApplication.operations.ledger[224].name = '0225_wrong.sql'; }, TypeError);
  assert.throws(() => { verified.byApplication.operations.schema[0].sql += ' '; }, TypeError);
  const forged = { ...verified, byApplication: structuredClone(verified.byApplication) };
  assert.throws(() => compileStagingV4MigrationPlan({ capsule: forged, application: 'operations' }),
    { code: 'pinned_controls_capsule_required' });
});

test('same-batch SQLite guard aborts stale schema and stale ledger before DDL', fixtureTest, () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const baseline = capsule.byApplication.operations;
  const plan = compileStagingV4MigrationPlan({ capsule, application: 'operations',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12006' });
  const firstStep = plan.steps[0];
  const columnAbsent = db => !db.prepare('PRAGMA table_info(operations_portal_native_recipient_intents)')
    .all().some(row => row.name === 'permission_schema_version');

  const staleSchema = openCapturedDb(baseline);
  try {
    staleSchema.exec('CREATE TABLE sqliteX_drift(id INTEGER PRIMARY KEY)');
    assert(capturedSchemaRows(staleSchema).some(row => row.name === 'sqliteX_drift'),
      'capture-compatible GLOB filter includes legal application names beginning sqliteX');
    assert.throws(() => applyLocalBatch(staleSchema, firstStep.requestBody), /CHECK constraint failed/u);
    assert(columnAbsent(staleSchema), 'schema drift blocks DDL and rolls back the guard batch');
    assert.equal(staleSchema.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='sqliteX_drift'").get().n, 1,
      'pre-existing drift remains untouched');
  } finally { staleSchema.close(); }

  const providerShadow = openCapturedDb(baseline);
  try {
    providerShadow.exec('CREATE TABLE _cf_provider_shadow(id INTEGER PRIMARY KEY)');
    assert.equal(capturedSchemaRows(providerShadow).some(row => row.name === '_cf_provider_shadow'), false,
      'capture-compatible filter ignores Cloudflare shadow objects');
    applyLocalBatch(providerShadow, firstStep.requestBody);
    assert.equal(providerShadow.prepare('PRAGMA table_info(operations_portal_native_recipient_intents)')
      .all().some(row => row.name === 'permission_schema_version'), true,
    'schema guard and snapshot reader ignore the same _cf_* shadow');
  } finally { providerShadow.close(); }

  const staleLedger = openCapturedDb(baseline);
  try {
    staleLedger.prepare('UPDATE d1_migrations SET name=? WHERE id=?').run('sentinel_stale_ledger.sql', 225);
    assert.throws(() => applyLocalBatch(staleLedger, firstStep.requestBody), /CHECK constraint failed/u);
    assert(columnAbsent(staleLedger), 'ledger drift blocks DDL and rolls back the guard batch');
    assert.equal(staleLedger.prepare('SELECT name FROM d1_migrations WHERE id=225').get().name, 'sentinel_stale_ledger.sql');
  } finally { staleLedger.close(); }
});

test('fresh control read enforces account, database, active/latest/runtime/binding/gate hashes and freshness', fixtureTest, () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const step = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12003' }).steps[0];
  const target = step.target, now = Date.parse('2026-10-31T02:30:00.000Z');
  const snapshot = (overrides = {}) => ({ schemaVersion: 1, observedAt: '2026-10-31T02:29:00.000Z',
    accountId: target.accountId, environment: 'staging', databaseId: target.databaseId,
    workerName: target.worker, binding: target.binding, controls: step.controls, ...overrides });
  assert.equal(assertFreshStagingV4Controls(snapshot(), target, step.controls, now), true);
  assert.throws(() => assertFreshStagingV4Controls(snapshot({ accountId: '0'.repeat(32) }), target, step.controls, now),
    { code: 'current_controls_drift' });
  assert.throws(() => assertFreshStagingV4Controls(snapshot({ databaseId: '0'.repeat(36) }), target, step.controls, now),
    { code: 'current_controls_drift' });
  assert.throws(() => assertFreshStagingV4Controls(snapshot({ controls: { ...step.controls, latestVersionId: 'drift' } }), target, step.controls, now),
    { code: 'current_controls_drift' });
  assert.throws(() => assertFreshStagingV4Controls(snapshot({ observedAt: '2026-10-31T02:20:00.000Z' }), target, step.controls, now),
    { code: 'current_controls_snapshot_stale' });
  assert.throws(() => assertFreshStagingV4Controls(snapshot({ observedAt: '2026-10-31T02:31:00.000Z' }), target, step.controls, now),
    { code: 'current_controls_snapshot_stale' });
});

test('current controls adapter DTO maps sanitized runtime/control metadata without raw values', fixtureTest, () => {
  const raw = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const expected = capsule.controls.operations;
  const current = buildCurrentStagingV4ControlSnapshot(raw, 'operations');
  assert.deepEqual(current.controls, expected);
  assert.equal(current.databaseId, '78b34173-b168-4e3d-9832-bb9d245cc6b8');
  assert.equal(current.binding, 'OPS_DB');
  assertFreshStagingV4Controls(current, { accountId: current.accountId, databaseId: current.databaseId,
    worker: current.workerName, binding: current.binding }, expected, Date.parse(current.observedAt));
});

test('each Worker requires its own exact default-off gates and accepts the pinned baseline', fixtureTest, () => {
  const raw = JSON.parse(fs.readFileSync(capsulePath, 'utf8'));
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const now = Date.parse(raw.observedAt);
  for (const application of ['operations', 'client']) {
    const baseline = buildCurrentStagingV4ControlSnapshot(raw, application);
    assert.deepEqual(baseline.controls, capsule.controls[application]);
    const target = { accountId: raw.accountId, databaseId: baseline.databaseId,
      worker: baseline.workerName, binding: baseline.binding };
    assert.equal(assertFreshStagingV4Controls(baseline, target, capsule.controls[application], now), true);
  }

  const operationsGate = structuredClone(raw);
  operationsGate.workers.operations.selectedFlags.CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED = 'true';
  const operationsChanged = buildCurrentStagingV4ControlSnapshot(operationsGate, 'operations');
  assert.throws(() => assertFreshStagingV4Controls(operationsChanged,
    { accountId: raw.accountId, databaseId: operationsChanged.databaseId, worker: operationsChanged.workerName,
      binding: operationsChanged.binding }, capsule.controls.operations, now), { code: 'current_controls_drift' });

  const clientGate = structuredClone(raw);
  clientGate.workers.client.selectedFlags.CLIENT_PORTAL_OPS_INQUIRIES_ENABLED = 'true';
  const clientChanged = buildCurrentStagingV4ControlSnapshot(clientGate, 'client');
  assert.throws(() => assertFreshStagingV4Controls(clientChanged,
    { accountId: raw.accountId, databaseId: clientChanged.databaseId, worker: clientChanged.workerName,
      binding: clientChanged.binding }, capsule.controls.client, now), { code: 'current_controls_drift' });

  const missingWriterGate = structuredClone(raw);
  delete missingWriterGate.workers.client.selectedFlags.CLIENT_PORTAL_NATIVE_INQUIRY_CAPABILITY_WRITER_ENABLED;
  assert.throws(() => buildCurrentStagingV4ControlSnapshot(missingWriterGate, 'client'),
    { code: 'worker_controls_capsule_invalid' });
  const missingOpsGate = structuredClone(raw);
  delete missingOpsGate.workers.operations.selectedFlags.CLIENT_PORTAL_NATIVE_PRINCIPAL_INQUIRIES_ENABLED;
  assert.throws(() => buildCurrentStagingV4ControlSnapshot(missingOpsGate, 'operations'),
    { code: 'worker_controls_capsule_invalid' });
});

test('intent identity and journal path remain stable across recompile; callers cannot select a directory', fixtureTest, async () => {
  assert.equal(STAGING_V4_JOURNAL_ROOT, path.join(STAGING_V4_JOURNAL_PARENT, 'staging-v4-migrations'));
  assert.equal(path.dirname(STAGING_V4_JOURNAL_ROOT), STAGING_V4_JOURNAL_PARENT);
  assert.notEqual(STAGING_V4_JOURNAL_ROOT, STAGING_V4_LEGACY_JOURNAL_ROOT);
  assert.equal(isStagingV4LegacyJournalMarker(`${'a'.repeat(32)}.attempt.json`), true);
  assert.equal(isStagingV4LegacyJournalMarker(`${'b'.repeat(32)}.postcheck.json`), true);
  assert.equal(isStagingV4LegacyJournalMarker('notes.json'), false);
  assert.equal(isStagingV4LegacyJournalMarker(`${'a'.repeat(32)}.other.json`), false);
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const originalPlan = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12004' });
  const validatedPlan = validatePreparedStagingV4Plan(JSON.parse(JSON.stringify(originalPlan)), capsule);
  const first = validatedPlan.steps[0];
  assert(Object.isFrozen(validatedPlan.steps[0].requestBody.batch[0].params));
  assert.throws(() => { validatedPlan.steps[0].requestBody.batch[0].params[2] = 'tampered'; }, TypeError);
  const second = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12007' }).steps[0];
  assert.equal(first.intentId, second.intentId);
  assert.equal(stagingV4JournalPaths(first.intentId).root, STAGING_V4_JOURNAL_ROOT);
  assert.deepEqual(stagingV4JournalPaths(first.intentId), stagingV4JournalPaths(second.intentId));
  let reads = 0, submits = 0;
  await assert.rejects(executePreparedStagingV4Step(first, { attemptPath: path.join(os.tmpdir(), 'alternate.attempt.json'),
    completionPath: path.join(os.tmpdir(), 'alternate.postcheck.json'), readSnapshot: async () => { reads++; return {}; },
    readControls: async () => { reads++; return {}; }, executeBatch: async () => { submits++; return { success: true }; } }),
  { code: 'executor_options_invalid' });
  assert.equal(reads, 0);
  assert.equal(submits, 0);
});

test('executor requires fresh controls and refuses before submission on account, binding, or snapshot drift', fixtureTest, async () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const step = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12005' }).steps[0];
  const now = '2026-10-31T02:30:00.000Z';
  let snapshotReads = 0, submissions = 0;
  await assert.rejects(executePreparedStagingV4Step(step, { now: () => now,
    readControls: async () => ({ schemaVersion: 1, observedAt: now, accountId: step.target.accountId,
      environment: 'staging', databaseId: step.target.databaseId, workerName: step.target.worker,
      binding: step.target.binding, controls: { ...step.controls, rawControlSha256: '0'.repeat(64) } }),
    readSnapshot: async () => { snapshotReads++; return { accountId: step.target.accountId, environment: 'staging',
      databaseId: step.target.databaseId, workerName: step.target.worker, binding: step.target.binding,
      readOnly: true, servedByPrimary: true, observedAt: now, ...step.pre }; },
    executeBatch: async () => { submissions++; return { success: true }; } }),
  { code: 'current_preflight_read_unavailable' });
  assert.equal(snapshotReads, 1);
  assert.equal(submissions, 0);

  await assert.rejects(executePreparedStagingV4Step(step, { now: () => now,
    readControls: async () => ({ schemaVersion: 1, observedAt: now, accountId: step.target.accountId,
      environment: 'staging', databaseId: step.target.databaseId, workerName: step.target.worker,
      binding: step.target.binding, controls: step.controls }),
    readSnapshot: async () => ({ accountId: step.target.accountId, environment: 'staging',
      databaseId: '0'.repeat(36), workerName: step.target.worker, binding: step.target.binding,
      readOnly: true, servedByPrimary: true, observedAt: now, ...step.pre }),
    executeBatch: async () => { submissions++; return { success: true }; } }), { code: 'preflight_snapshot_mismatch' });
  assert.equal(submissions, 0);
});
