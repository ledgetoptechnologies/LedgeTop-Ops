import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { compileStagingV4MigrationPlan, executePreparedStagingV4Step,
  readCapturedStagingV4Capsule, STAGING_V4_CAPSULE_SHA256, STAGING_V4_MAX_PARAM_BYTES,
  STAGING_V4_MAX_SQL_BYTES, splitMigrationSql, stagingV4MigrationOperatorProfiles,
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

function openCapturedDb(baseline) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys=ON');
  for (const type of ['table', 'index', 'view', 'trigger']) {
    for (const row of baseline.schema.filter(item => item.type === type)) db.exec(row.sql);
  }
  assert.deepEqual(db.prepare(`SELECT type,name,tbl_name,sql FROM sqlite_schema
    WHERE name NOT LIKE 'sqlite_%' AND name NOT IN ('_cf_KV','_cf_METADATA')
      AND type IN ('table','view','index','trigger') ORDER BY type,name`).all()
    .map(row => ({ type: row.type, name: row.name, tbl_name: row.tbl_name, sql: row.sql })), baseline.schema);
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
  const plans = {};
  for (const application of ['operations', 'client']) {
    const plan = compileStagingV4MigrationPlan({ capsule, application,
      runId: application === 'operations' ? '77b33374-8164-4e89-88b9-4a2a0ef12001' : '77b33374-8164-4e89-88b9-4a2a0ef12002' });
    plans[application] = plan;
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
  const staleLedger = readCapturedStagingV4Capsule(capsulePath);
  staleLedger.byApplication.operations.ledger[224].name = '0225_wrong.sql';
  assert.throws(() => compileStagingV4MigrationPlan({ capsule: staleLedger, application: 'operations' }),
    { code: 'baseline_ledger_mismatch' });
  const staleSchema = readCapturedStagingV4Capsule(capsulePath);
  staleSchema.byApplication.operations.schema[0].sql += ' ';
  assert.throws(() => compileStagingV4MigrationPlan({ capsule: staleSchema, application: 'operations' }),
    { code: 'baseline_schema_mismatch' });
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
    staleSchema.exec('CREATE TABLE stale_schema_drift(id INTEGER PRIMARY KEY)');
    assert.throws(() => applyLocalBatch(staleSchema, firstStep.requestBody), /CHECK constraint failed/u);
    assert(columnAbsent(staleSchema), 'schema drift blocks DDL and rolls back the guard batch');
    assert.equal(staleSchema.prepare("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name='stale_schema_drift'").get().n, 1,
      'pre-existing drift remains untouched');
  } finally { staleSchema.close(); }

  const staleLedger = openCapturedDb(baseline);
  try {
    staleLedger.prepare('UPDATE d1_migrations SET name=? WHERE id=?').run('sentinel_stale_ledger.sql', 225);
    assert.throws(() => applyLocalBatch(staleLedger, firstStep.requestBody), /CHECK constraint failed/u);
    assert(columnAbsent(staleLedger), 'ledger drift blocks DDL and rolls back the guard batch');
    assert.equal(staleLedger.prepare('SELECT name FROM d1_migrations WHERE id=225').get().name, 'sentinel_stale_ledger.sql');
  } finally { staleLedger.close(); }
});

test('preflight mismatch sends nothing; uncertain submitted outcome persists intent and blocks replay', fixtureTest, async () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const step = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12003' }).steps[0];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-v4-intent-'));
  const attemptPath = path.join(directory, `${step.intentId}.attempt.json`);
  const completionPath = path.join(directory, `${step.intentId}.postcheck.json`);
  let submissions = 0, reads = 0;
  try {
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot: async () => ({ schema: [], ledger: [] }), executeBatch: async () => { submissions++; return { success: true }; } }),
    { code: 'preflight_snapshot_mismatch' });
    assert.equal(fs.existsSync(attemptPath), false, 'preflight mismatch occurs before a durable submission intent');
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot: async () => { reads++; return step.pre; },
      executeBatch: async () => { submissions++; throw new Error('ambiguous transport'); } }),
    { code: 'submission_outcome_uncertain_reconcile_only' });
    assert.equal(submissions, 1);
    assert.equal(fs.existsSync(attemptPath), true, 'attempt is durable before the uncertain submission');
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot: async () => { reads++; return step.pre; },
      executeBatch: async () => { submissions++; return { success: true }; } }), { code: 'attempt_exists_reconcile_only' });
    assert.equal(reads, 1, 'replay is blocked before a second read or submission');
    assert.equal(submissions, 1, 'uncertain transport is never retried');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an uncertain response after submit leaves a non-replayable intent marker', fixtureTest, async () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const step = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12004' }).steps[0];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-v4-partial-'));
  const attemptPath = path.join(directory, `${step.intentId}.attempt.json`);
  const completionPath = path.join(directory, `${step.intentId}.postcheck.json`);
  let reads = 0, submissions = 0;
  const readSnapshot = async () => { reads++; return reads === 1 ? step.pre : step.pre; };
  const executeBatch = async () => { submissions++; return { success: true, results: [{ success: true }] }; };
  try {
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath, readSnapshot, executeBatch }),
      { code: 'postcheck_mismatch_reconcile_only' });
    assert.equal(submissions, 1);
    assert.equal(fs.existsSync(attemptPath), true);
    assert.equal(fs.existsSync(completionPath), false);
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot, executeBatch }), { code: 'attempt_exists_reconcile_only' });
    assert.equal(submissions, 1, 'uncertain submission is never replayed');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('successful single submission requires exact post-state and retains separate receipts', fixtureTest, async () => {
  const capsule = readCapturedStagingV4Capsule(capsulePath);
  const sourcePlan = compileStagingV4MigrationPlan({ capsule, application: 'client',
    runId: '77b33374-8164-4e89-88b9-4a2a0ef12005' });
  const prepared = validatePreparedStagingV4Plan(JSON.parse(JSON.stringify(sourcePlan)), capsule);
  const step = prepared.steps[0];
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'staging-v4-success-'));
  const attemptPath = path.join(directory, `${step.intentId}.attempt.json`);
  const completionPath = path.join(directory, `${step.intentId}.postcheck.json`);
  let reads = 0, submissions = 0;
  try {
    await assert.rejects(executePreparedStagingV4Step(JSON.parse(JSON.stringify(step)), { attemptPath, completionPath,
      readSnapshot: async () => step.pre, executeBatch: async () => { submissions++; return { success: true }; } }),
    { code: 'reviewed_execution_adapter_required' });
    const result = await executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot: async () => (++reads === 1 ? step.pre : step.post),
      executeBatch: async (target, body) => { submissions++; assert.equal(target.databaseId, step.target.databaseId);
        assert.equal(body.batch.length, step.requestBody.batch.length); return { success: true }; },
      now: () => '2026-10-31T00:00:00.000Z' });
    assert.equal(result.status, 'postchecked');
    assert.equal(submissions, 1);
    assert.equal(JSON.parse(fs.readFileSync(attemptPath, 'utf8')).retryAllowed, false);
    assert.equal(JSON.parse(fs.readFileSync(completionPath, 'utf8')).requestBodySha256, step.requestBodySha256);
    await assert.rejects(executePreparedStagingV4Step(step, { attemptPath, completionPath,
      readSnapshot: async () => step.post, executeBatch: async () => { submissions++; return { success: true }; } }),
    { code: 'attempt_exists_reconcile_only' });
    assert.equal(submissions, 1, 'postchecked command is never submitted twice');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
