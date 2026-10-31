import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createProductionOps0226Operator, PRODUCTION_OPS_0226_BASELINE, PRODUCTION_OPS_0226_TARGET,
  PRODUCTION_OPS_0226_POST_READ_QUERY, PRODUCTION_OPS_0226_PRE_READ_QUERY,
  PRODUCTION_OPS_0226_PROTECTED_TABLES, parseProductionOps0226SnapshotResult,
} from './production-ops-staff-login-0226-once.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const canonical = value => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number'
  ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
const wireFixtureBytes = fs.readFileSync(new URL('./fixtures/production-ops-0226-wrangler-wire-statements.json', import.meta.url));
const wireFixture = JSON.parse(wireFixtureBytes.toString('utf8'));
const productionTarget = structuredClone(PRODUCTION_OPS_0226_TARGET);

test('production profile pins the verified target, ledger, schema, and all protected-state digests', () => {
  assert.deepEqual(PRODUCTION_OPS_0226_TARGET, {
    environment:'production', accountId:'846c924bf17bf4f3dd15c97a4c5d1d51', workerName:'ledgetop-ops', binding:'OPS_DB',
    databaseName:'ltds-ops', databaseId:'6ebf7514-d306-4615-ae56-ad869c874dbd',
  });
  assert.equal(PRODUCTION_OPS_0226_BASELINE.sourceMetadataSha256, 'b05b702f4e81ec75962e5f13b084518ea1aded4eebbbb4819832fa3451078303');
  assert.equal(PRODUCTION_OPS_0226_BASELINE.ledgerCount, 225);
  assert.equal(PRODUCTION_OPS_0226_BASELINE.lastMigration, '0225_native_staff_lifecycle_bridge.sql');
  assert.equal(PRODUCTION_OPS_0226_BASELINE.schemaObjectCount, 2449);
  assert.equal(Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES).length, 14);
  assert.deepEqual(Object.keys(PRODUCTION_OPS_0226_BASELINE.protectedTableCounts).sort(),
    Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES).sort());
  assert.deepEqual(Object.keys(PRODUCTION_OPS_0226_BASELINE.protectedTableDigests).sort(),
    Object.keys(PRODUCTION_OPS_0226_PROTECTED_TABLES).sort());
  assert.equal(hash(canonical({ counts:PRODUCTION_OPS_0226_BASELINE.protectedTableCounts,
    digests:PRODUCTION_OPS_0226_BASELINE.protectedTableDigests })), PRODUCTION_OPS_0226_BASELINE.protectedStateSha256);
  assert.equal(PRODUCTION_OPS_0226_BASELINE.nativeStaffControlEnabled, 0);
  assert.equal(Object.hasOwn(PRODUCTION_OPS_0226_BASELINE, 'requiredMigrations'), false);
});

test('production migration bytes and pinned 24-statement Wrangler wire fixture compile to exactly 23 objects', () => {
  const migration = fs.readFileSync(new URL('../apps/operations/migrations/0226_staff_login_bindings.sql', import.meta.url));
  assert.equal(hash(migration), 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5');
  assert.equal(hash(wireFixtureBytes), 'fd02f7220e2afaeb1105a19da0dc14b3c9329c084ac6500b8d0b5e32b440edb3');
  assert.equal(wireFixture.sourceMigrationSha256, hash(migration));
  assert.equal(wireFixture.statementCount, 24);
  assert.equal(hash(JSON.stringify(wireFixture.statements)), wireFixture.statementsSha256);
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT NOT NULL,display_name TEXT NOT NULL,access_subject TEXT,status TEXT NOT NULL);
      CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT);
      CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT);
      CREATE TABLE native_staff_profiles(staff_id TEXT PRIMARY KEY,version INTEGER NOT NULL,updated_at TEXT);`);
    for (const statement of wireFixture.statements) db.exec(statement);
    const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND substr(name,1,12)='staff_login_' ORDER BY type,name").all();
    assert.equal(objects.length, 23);
    const fingerprint = hash(JSON.stringify(objects.map(row => [row.type,row.name,row.tbl_name,row.sql])));
    assert.equal(fingerprint, wireFixture.expectedAddedSchemaSha256);
  } finally { db.close(); }
});

test('production snapshot queries are read-only and parser pins the production target and zero-write primary result', () => {
  assert.match(PRODUCTION_OPS_0226_PRE_READ_QUERY.trim(), /^SELECT\b/u);
  assert.match(PRODUCTION_OPS_0226_POST_READ_QUERY.trim(), /^SELECT\b/u);
  assert.doesNotMatch(PRODUCTION_OPS_0226_PRE_READ_QUERY, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER)\b/iu);
  const result = [{ success:true, results:[{ production_ops_0226_snapshot:JSON.stringify({}) }],
    meta:{ rows_written:0, changed_db:false, served_by_primary:true } }];
  const parsed = parseProductionOps0226SnapshotResult(result, {
    observedAt:'2026-10-31T11:11:59.354Z', target:{ ...productionTarget, databaseId:'staging' },
  });
  assert.deepEqual(parsed.target, productionTarget);
  assert.equal(parsed.observedAt, '2026-10-31T11:11:59.354Z');
  for (const meta of [{ rows_written:1,changed_db:true,served_by_primary:true },
    { rows_written:0,changed_db:false,served_by_primary:false }, { rows_written:0,changed_db:false }]) {
    assert.throws(() => parseProductionOps0226SnapshotResult([{ ...result[0], meta }],
      { observedAt:'2026-10-31T11:11:59.354Z' }), /read_result_invalid/u);
  }
});

test('wrong production identity and non-production ledger fail closed before planning', () => {
  assert.throws(() => createProductionOps0226Operator({ baseline:{ ledgerCount:228 } }), /operator_options_invalid/u);
  assert.throws(() => createProductionOps0226Operator({ target:{ environment:'staging' } }), /operator_options_invalid/u);
  const operator = createProductionOps0226Operator();
  const snapshot = { target:productionTarget, observedAt:new Date().toISOString(), ledger:[], schema:[], schemaColumns:{}, protectedRows:{} };
  for (const target of [
    { ...productionTarget, accountId:'wrong' },
    { ...productionTarget, workerName:'ledgetop-ops-staging' },
    { ...productionTarget, databaseId:'78b34173-b168-4e3d-9832-bb9d245cc6b8' },
    { ...productionTarget, environment:'staging' },
  ]) {
    assert.throws(() => operator.compile({ ...snapshot, target }, { sourceCommit:'dc8cedfe953ce75eb2f65de846de74d076b820f8' }), /target_mismatch/u);
  }
  assert.throws(() => operator.compile(snapshot, { sourceCommit:'dc8cedfe953ce75eb2f65de846de74d076b820f8' }), /ledger_pin_mismatch/u);
  assert.throws(() => operator.compile(snapshot, { sourceCommit:'invalid' }), /source_commit_invalid/u);
});

test('migration source bytes are pinned before a production plan can be compiled', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-ops-0226-source-'));
  try {
    const migrationDirectory = path.join(directory, 'apps','operations','migrations');
    fs.mkdirSync(migrationDirectory, { recursive:true });
    fs.writeFileSync(path.join(migrationDirectory, '0226_staff_login_bindings.sql'), 'SELECT 1;\n');
    const snapshot = { target:productionTarget, observedAt:new Date().toISOString(), ledger:[], schema:[], schemaColumns:{}, protectedRows:{} };
    assert.throws(() => createProductionOps0226Operator().compile(snapshot, {
      sourceCommit:'dc8cedfe953ce75eb2f65de846de74d076b820f8', root:directory,
    }), /migration_pin_mismatch/u);
  } finally { fs.rmSync(directory, { recursive:true, force:true }); }
});

test('an existing journal blocks replay before provider reads or writes', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'production-ops-0226-journal-'));
  t.after(() => fs.rmSync(directory, { recursive:true, force:true }));
  const journalPath = path.join(directory, 'journal.jsonl'); fs.writeFileSync(journalPath, 'existing\n');
  const calls = { reads:0, mutations:0 };
  const provider = { async readSnapshot() { calls.reads++; }, async applyExactMigration() { calls.mutations++; } };
  await assert.rejects(createProductionOps0226Operator().executeOnce({ plan:{}, provider, journalPath }), /journal_exists_no_replay/u);
  assert.deepEqual(calls, { reads:0, mutations:0 });
});
