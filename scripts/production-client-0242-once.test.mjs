import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { TARGET, READ_SQL, EMPTY_TARGET_SQL, runOneShot,
  bindingsMetadataSha256, selectProductionClientBindings,
  validateReleaseCheckout, verifyPostSnapshot } from './production-client-0242-once.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE_DIR = path.join(ROOT, 'scripts/production-auto-migration-profile/source38-inventory-v2');
const manifest = JSON.parse(readFileSync(path.join(PROFILE_DIR, 'reconciliation-manifest.json'), 'utf8'));
const baselineRows = manifest.databases.client.orderedRows;
const workspaces = new Set();

function makeDb() {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE d1_migrations(id INTEGER PRIMARY KEY,name TEXT NOT NULL UNIQUE,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE portal_v2_identities(id TEXT PRIMARY KEY); CREATE TABLE _cf_fixture_internal(id TEXT);');
  const insert = db.prepare('INSERT INTO d1_migrations(id,name) VALUES(?,?)');
  for (const row of baselineRows) insert.run(row.id, row.name);
  return db;
}

function queryMetadata(db) {
  return [
    { success: true, results: db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all().map(row => ({ ...row })), meta: { rows_written: 0, changed_db: false } },
    { success: true, results: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' ORDER BY type,name").all().map(row => ({ ...row })), meta: { rows_written: 0, changed_db: false } },
    { success: true, results: db.prepare("PRAGMA table_info('portal_v2_identities')").all().map(row => ({ ...row })), meta: { rows_written: 0, changed_db: false } },
  ];
}

function createMockRequest(db, { beforeWrite, loseWriteResponse = false, settingsFactory } = {}) {
  const calls = [];
  let settingsReads = 0;
  const request = async (url, init = {}) => {
    const u = new URL(url);
    assert.equal(u.origin, 'https://api.cloudflare.com');
    assert.equal(u.pathname.startsWith(`/client/v4/accounts/${TARGET.accountId}/`), true);
    const route = u.pathname.slice(`/client/v4/accounts/${TARGET.accountId}`.length);
    const method = init.method ?? 'GET';
    let result;
    if (route === '/workers/scripts/ledgetop-clients/settings' && method === 'GET') {
      result = settingsFactory ? settingsFactory(settingsReads++) : { bindings: [
        { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
        { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId } ] };
    } else if (route === `/d1/database/${TARGET.databaseId}` && method === 'GET') {
      result = { uuid: TARGET.databaseId, name: 'client-data' };
    } else if (route === `/d1/database/${TARGET.databaseId}/query` && method === 'POST') {
      const body = JSON.parse(init.body);
      calls.push({ body, method });
      if (JSON.stringify(body) === JSON.stringify({ batch: READ_SQL.map(sql => ({ sql })) })) {
        result = queryMetadata(db);
      } else if (JSON.stringify(body) === JSON.stringify({ sql: EMPTY_TARGET_SQL })) {
        result = [{ success: true, results: [ { inquiries: db.prepare('SELECT COUNT(*) AS n FROM client_ops_triage_inquiries').get().n,
          outbox: db.prepare('SELECT COUNT(*) AS n FROM client_ops_triage_notification_outbox').get().n } ], meta: { rows_written: 0, changed_db: false } }];
      } else if (Array.isArray(body.batch) && body.batch.length === 9) {
        await beforeWrite?.();
        db.exec('BEGIN IMMEDIATE');
        try {
          for (const statement of body.batch) {
            if (statement.params?.length) db.prepare(statement.sql).run(...statement.params);
            else db.exec(statement.sql);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
        result = body.batch.map(() => ({ success: true, results: [], meta: { rows_written: 0, changed_db: true } }));
        if (loseWriteResponse) throw new Error('simulated_transport_lost_after_commit');
      } else assert.fail('unrecognized query body');
    } else assert.fail(`unexpected route ${method} ${route}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200,
      headers: { 'content-type': 'application/json' } });
  };
  return { request, calls };
}

function tempDir() {
  const parent = mkdtempSync(path.join(os.tmpdir(), 'client-0242-once-'));
  const dir = path.join(parent, 'release');
  workspaces.add(dir);
  return dir;
}
test.afterEach(() => {
  for (const dir of workspaces) rmSync(path.dirname(dir), { recursive: true, force: true });
  workspaces.clear();
});

test('only exact production Client binding is accepted', () => {
  const valid = { bindings: [ { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
    { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId } ] };
  const validProjection = selectProductionClientBindings(valid);
  assert.equal(validProjection.environment, 'production');
  assert.equal(validProjection.worker, 'ledgetop-clients');
  assert.equal(validProjection.binding, 'DELIVERY_DB');
  assert.equal(validProjection.databaseId, TARGET.databaseId);
  assert.equal(validProjection.inquiryFlag, 'absent');
  assert.match(validProjection.bindingsMetadataSha256, /^[a-f0-9]{64}$/u);
  assert.throws(() => selectProductionClientBindings({ bindings: [
    { name: 'ENVIRONMENT', type: 'plain_text', text: 'staging' },
    { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId } ] }), /client_worker_not_production/);
  assert.throws(() => selectProductionClientBindings({ bindings: [
    { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
    { name: 'DELIVERY_DB', type: 'd1', id: 'b6f653ab-9acd-4421-9ad0-207754b59aeb' } ] }), /client_database_binding_mismatch/);
  assert.throws(() => selectProductionClientBindings({ bindings: [ ...valid.bindings,
    { name: 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED', type: 'plain_text', text: 'true' } ] }),
  /client_inquiry_flag_must_remain_disabled/);
  assert.equal(selectProductionClientBindings({ bindings: [ ...valid.bindings,
    { name: 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED', type: 'plain_text', text: 'false' } ] }).inquiryFlag, 'false');
  const extra = { name: 'PUBLIC_BUCKET', type: 'r2', bucket_name: 'client-data' };
  const original = selectProductionClientBindings({ bindings: [ ...valid.bindings, extra ] });
  const changed = selectProductionClientBindings({ bindings: [ ...valid.bindings,
    { ...extra, bucket_name: 'other-bucket' } ] });
  assert.notEqual(original.bindingsMetadataSha256, changed.bindingsMetadataSha256,
    'hash covers unrelated returned bindings too');
  assert.equal(original.bindingsMetadataSha256, bindingsMetadataSha256({ bindings: [ ...valid.bindings, extra ] }));
});

test('release checkout accepts clean main or detached exact origin/main only', () => {
  const head = 'da0b6375decf6c0d8a0b251d1b760accffc28ce3';
  assert.equal(validateReleaseCheckout({ head, originHead: head, branch: 'main', dirty: '', sourceAncestor: true }), true);
  assert.equal(validateReleaseCheckout({ head, originHead: head, branch: '', dirty: '', sourceAncestor: true }), true);
  assert.throws(() => validateReleaseCheckout({ head, originHead: head, branch: 'codex/topic', dirty: '', sourceAncestor: true }), /release_checkout_not_clean_current_main/);
  assert.throws(() => validateReleaseCheckout({ head, originHead: 'f'.repeat(40), branch: '', dirty: '', sourceAncestor: true }), /release_checkout_not_clean_current_main/);
  assert.throws(() => validateReleaseCheckout({ head, originHead: head, branch: '', dirty: ' M source.mjs', sourceAncestor: true }), /release_checkout_not_clean_current_main/);
  assert.throws(() => validateReleaseCheckout({ head, originHead: head, branch: '', dirty: '', sourceAncestor: false }), /release_checkout_not_clean_current_main/);
});

test('prepare stays held; exact packet executes once and preserves pending migrations', async () => {
  const db = makeDb(), dir = tempDir();
  try {
    const mock = createMockRequest(db);
    const prepared = await runOneShot({ mode: 'prepare', request: mock.request, artifactDir: dir });
    assert.equal(prepared.status, 'review-candidate-requires-explicit-execute');
    assert.equal(prepared.providerWrites, 0);
    const prep = JSON.parse(readFileSync(path.join(dir, 'prepared.private.json'), 'utf8'));
    assert.equal(prep.heldCompilerAuthorization, false);
    assert.equal(prep.heldCompilerFeatureAuthorization, false);
    assert.equal(prep.executionAuthorization, false);

    const result = await runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 });
    assert.equal(result.status, 'applied_and_verified');
    assert.equal(result.providerWrites, 1);
    assert.equal(result.exactSchemaLedgerDelta, true);
    assert.equal(result.newTablesEmpty, true);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 1);
    const after = db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all().map(row => ({ ...row }));
    assert.deepEqual(after.slice(0, 158), baselineRows);
    assert.deepEqual(after.at(-1), { id: 159, name: '0242_client_ops_triage_inquiries.sql' });
    assert.equal(after.some(row => ['0235_windows_portal_successor_candidates.sql',
      '0236_windows_portal_successor_content_start_audit.sql', '0239_native_project_assignment_proof_v3.sql',
      '0241_app_release_pilot.sql'].includes(row.name)), false);
    await assert.rejects(runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 }), /one_shot_already_consumed/);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 1);
  } finally { db.close(); }
});

test('lost batch response is reconciled by readback without replay', async () => {
  const db = makeDb(), dir = tempDir();
  try {
    const mock = createMockRequest(db, { loseWriteResponse: true });
    const prepared = await runOneShot({ mode: 'prepare', request: mock.request, artifactDir: dir });
    const result = await runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 });
    assert.equal(result.status, 'applied_reconciled_after_uncertain_response');
    assert.equal(result.providerWrites, 1);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 1);
  } finally { db.close(); }
});

test('uncertain response with unchanged database is terminally held and never retried', async () => {
  const db = makeDb(), dir = tempDir();
  try {
    const mock = createMockRequest(db, { beforeWrite: () => { throw new Error('simulated_transport_failure_before_commit'); } });
    const prepared = await runOneShot({ mode: 'prepare', request: mock.request, artifactDir: dir });
    const result = await runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 });
    assert.equal(result.status, 'held_uncertain_or_poststate_mismatch_no_retry');
    assert.equal(result.providerWrites, 1);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 1);
    await assert.rejects(runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 }), /one_shot_already_consumed/);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 1);
  } finally { db.close(); }
});

test('changed metadata after prepare refuses before the migration write', async () => {
  const db = makeDb(), dir = tempDir();
  try {
    const mock = createMockRequest(db);
    const prepared = await runOneShot({ mode: 'prepare', request: mock.request, artifactDir: dir });
    db.exec('CREATE TABLE external_drift(id TEXT PRIMARY KEY)');
    await assert.rejects(runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 }), /production_metadata_changed/);
    assert.equal(mock.calls.filter(call => call.body.batch?.length === 9).length, 0);
  } finally { db.close(); }
});

test('enabled inquiry flag and unrelated binding drift both refuse migration', async () => {
  const db = makeDb(), dir = tempDir(), dbGate = makeDb(), dirGate = tempDir();
  try {
    const gateMock = createMockRequest(dbGate, { settingsFactory: n => ({ bindings: [
      { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
      { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId },
      { name: 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED', type: 'plain_text', text: n === 0 ? 'false' : 'true' },
    ] }) });
    const gatePrepared = await runOneShot({ mode: 'prepare', request: gateMock.request, artifactDir: dirGate });
    await assert.rejects(runOneShot({ mode: 'execute', request: gateMock.request,
      artifactDir: dirGate, preparedSha256: gatePrepared.preparedSha256 }), /client_inquiry_flag_must_remain_disabled/);
    assert.equal(gateMock.calls.filter(call => call.body.batch?.length === 9).length, 0);
    // Start without the inquiry gate, then introduce a non-target binding after
    // preparation; the full metadata digest must catch that drift.
    const baselineMock = createMockRequest(db, { settingsFactory: n => ({ bindings: [
      { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
      { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId },
      ...(n > 0 ? [{ name: 'PUBLIC_BUCKET', type: 'r2', bucket_name: 'changed' }] : []),
    ] }) });
    const prepared = await runOneShot({ mode: 'prepare', request: baselineMock.request, artifactDir: dir });
    await assert.rejects(runOneShot({ mode: 'execute', request: baselineMock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 }), /production_binding_changed/);
    assert.equal(baselineMock.calls.filter(call => call.body.batch?.length === 9).length, 0);
  } finally { db.close(); dbGate.close(); }
});

test('postflight records changed full bindings metadata and refuses a false unchanged claim', async () => {
  const db = makeDb(), dir = tempDir();
  try {
    const mock = createMockRequest(db, { settingsFactory: n => ({ bindings: [
      { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
      { name: 'DELIVERY_DB', type: 'd1', id: TARGET.databaseId },
      { name: 'CLIENT_PORTAL_OPS_INQUIRIES_ENABLED', type: 'plain_text', text: n >= 2 ? 'true' : 'false' },
    ] }) });
    const prepared = await runOneShot({ mode: 'prepare', request: mock.request, artifactDir: dir });
    const result = await runOneShot({ mode: 'execute', request: mock.request,
      artifactDir: dir, preparedSha256: prepared.preparedSha256 });
    assert.equal(result.status, 'held_postwrite_reconciliation_incomplete_no_retry');
    assert.equal(result.providerWrites, 1);
    const terminal = JSON.parse(readFileSync(path.join(dir, 'terminal.private.json'), 'utf8'));
    assert.equal(terminal.productionBindingsUnchanged, false);
    assert.notEqual(terminal.bindingsMetadataSha256, terminal.postBindingsMetadataSha256);
    assert.equal(terminal.secretVisibility.includes('not observable or compared'), true);
  } finally { db.close(); }
});

test('postflight rejects unexpected ledger/schema changes and optional pending migration application', () => {
  {
    const packet = JSON.parse(readFileSync(path.join(PROFILE_DIR, 'append-plan.json'), 'utf8'));
    // The strict post verifier also checks that every old schema object remains
    // and the only new object SQL is the five statements from the compiled packet.
    const before = { ledger: baselineRows, schema: [ { type: 'table', name: 'old', tbl_name: 'old', sql: 'CREATE TABLE old(id)' } ], parent: [] };
    const after = { ...before, ledger: [...baselineRows,
      { id: 159, name: '0242_client_ops_triage_inquiries.sql' },
      { id: 160, name: '0235_windows_portal_successor_candidates.sql' }], schema: before.schema };
    assert.throws(() => verifyPostSnapshot(before, after, { requestBody: { batch: [
      {}, {}, {}, { sql: 'CREATE TABLE a(id)' }, { sql: 'CREATE TABLE b(id)' },
      { sql: 'CREATE INDEX c ON a(id)' }, { sql: 'CREATE INDEX d ON a(id)' },
      { sql: 'CREATE INDEX e ON b(id)' }, {} ] } }), /post_ledger_not_exact/);
    assert.equal(packet.apps?.client?.appendInExactSourceOrder?.length > 0, true);
  }
});
