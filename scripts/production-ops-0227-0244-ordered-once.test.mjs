// Offline tests for the ordered 0227..0244 once-operator. The synthetic D1 is a
// local node:sqlite file built from this repository's own migrations 0001..0226;
// no Cloudflare resource is contacted.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  LEDGER_INSERT_SQL, OPS_0227_0244_AUTHORITY_NOTE, OPS_0227_0244_FILES, OPS_0227_0244_FINAL_LEDGER,
  OPS_0227_0244_FIXTURE_SHA256, OPS_0227_0244_PRE_READ_QUERY, OPS_0227_0244_PRIOR_LEDGER, OPS_PRODUCTION_DATABASE,
  isOps0227To0244ReadQuery, loadVerifiedOps0227To0244Plan, mainOps0227To0244, openOps0227To0244Receipt,
  parseOps0227To0244Args, parseOps0227To0244SnapshotResult, runOps0227To0244Ordered,
} from './production-ops-0227-0244-ordered-once.mjs';
import { createOps0227To0244CloudflareProvider } from './production-ops-0227-0244-cloudflare-provider.mjs';
import {
  OPS_0227_0244_FIXTURE_PATH, OPS_0227_0244_ORDERED_NAMES, buildOps0227To0244WireFixture, buildOpsChainDatabase, serializeFixture,
} from './production-ops-0227-0244-wire-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-0227-0244-once-'));
const chains = {};
let counter = 0;
const REHEARSAL = { accountId: 'a'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000001', databaseName: 'ops-rehearsal-copy' };
const rehearsalArgs = ['--account-id', REHEARSAL.accountId, '--database-id', REHEARSAL.databaseId, '--database-name', REHEARSAL.databaseName];
const TOKEN_ENV = { CLOUDFLARE_API_TOKEN: 'synthetic-token-for-offline-tests-only' };

before(() => {
  for (const count of [225, 226]) {
    const file = path.join(tmp, `chain-${count}.sqlite`);
    const db = buildOpsChainDatabase({ count, filename: file });
    db.close();
    chains[count] = file;
  }
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

function freshDb(count = 226) {
  const file = path.join(tmp, `db-${++counter}.sqlite`);
  fs.copyFileSync(chains[count], file);
  return file;
}
const receiptPath = () => path.join(tmp, `receipt-${++counter}.json`);
const readReceipt = file => JSON.parse(fs.readFileSync(file, 'utf8'));

/** Synthetic D1: reads go through a separate read-only connection, writes are one transaction per migration. */
function sqliteProvider(file, { failApplyAt = null, skipLedgerAt = null, tamper = null, ambiguousAt = null, landed = false,
  refuseAt = null } = {}) {
  const writer = new DatabaseSync(file);
  writer.exec('PRAGMA foreign_keys=ON');
  const calls = { reads: 0, writes: 0, targets: 0, sent: [] };
  return {
    calls,
    close() { writer.close(); },
    async assertTarget() { calls.targets++; return { ...REHEARSAL }; },
    async readSnapshot({ query }) {
      calls.reads++;
      assert.ok(isOps0227To0244ReadQuery(query), 'read query must be the pinned read-only snapshot');
      const reader = new DatabaseSync(file, { readOnly: true });
      let row;
      try { row = { ...reader.prepare(query).get() }; } finally { reader.close(); }
      const snapshot = parseOps0227To0244SnapshotResult([{ success: true, results: [row],
        meta: { rows_written: 0, changed_db: false, served_by_primary: true } }], { observedAt: new Date().toISOString() });
      return tamper ? tamper(snapshot, calls) : snapshot;
    },
    async applyMigration({ name, statements }) {
      calls.writes++;
      if (name === refuseAt) throw new Error('ops_0227_0244_provider:migration_pin_mismatch');
      calls.sent.push(name);
      if (name === failApplyAt || (name === ambiguousAt && !landed)) throw new Error('synthetic transport failure');
      writer.exec('BEGIN');
      try {
        for (const statement of statements) writer.exec(statement);
        if (name !== skipLedgerAt) writer.prepare(LEDGER_INSERT_SQL).run(name);
        writer.exec('COMMIT');
      } catch (error) { writer.exec('ROLLBACK'); throw error; }
      // The batch landed but the response was lost.
      if (name === ambiguousAt) throw new Error('ops_0227_0244_provider:request_uncertain_no_retry');
      return { applied: true };
    },
  };
}

function ledgerOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT id,name FROM d1_migrations ORDER BY id').all().map(row => ({ ...row })); } finally { db.close(); }
}

async function execute(file, options = {}) {
  const provider = sqliteProvider(file, options);
  const receiptFile = receiptPath();
  const receipt = openOps0227To0244Receipt(receiptFile);
  try {
    const result = await runOps0227To0244Ordered({ plan: loadVerifiedOps0227To0244Plan(), provider, mode: 'execute',
      target: { environment: 'non-production', ...REHEARSAL }, receipt });
    return { result, provider, receipt: readReceipt(receiptFile), receiptText: fs.readFileSync(receiptFile, 'utf8') };
  } finally { receipt.close(); provider.close(); }
}

test('committed wire fixture is exactly the Wrangler split + local full-chain compile of the pinned files', () => {
  const derived = serializeFixture(buildOps0227To0244WireFixture());
  const committed = fs.readFileSync(OPS_0227_0244_FIXTURE_PATH, 'utf8');
  assert.equal(derived, committed);
  assert.equal(hash(Buffer.from(committed)), OPS_0227_0244_FIXTURE_SHA256);
  assert.deepEqual(OPS_0227_0244_FILES.map(file => file.name), [...OPS_0227_0244_ORDERED_NAMES]);
});

test('plan pins exact ordered names, per-file hashes, and the 226 -> 236 ledger', () => {
  const plan = loadVerifiedOps0227To0244Plan();
  assert.deepEqual(plan.files.map(file => [file.name, file.ledgerId]), OPS_0227_0244_ORDERED_NAMES.map((name, i) => [name, 227 + i]));
  for (const file of plan.files) {
    assert.equal(hash(fs.readFileSync(path.join(ROOT, 'apps/operations/migrations', file.name))), file.sha256);
  }
  const names = fs.readdirSync(path.join(ROOT, 'apps/operations/migrations')).filter(name => name.endsWith('.sql')).sort();
  assert.equal(hash(names.slice(0, 226).join('\n')), OPS_0227_0244_PRIOR_LEDGER.namesSha256);
  assert.equal(hash(names.join('\n')), OPS_0227_0244_FINAL_LEDGER.namesSha256);
  assert.match(plan.planSha256, /^[a-f0-9]{64}$/u);
  const actual = JSON.parse(fs.readFileSync(path.join(ROOT,
    'scripts/production-auto-migration-profile/installed-schema-preservation-v1/actual-metadata-evidence.fixture.json'), 'utf8'));
  assert.equal(hash(actual.databases.operations.ledger.map(row => row.name).join('\n')), OPS_0227_0244_PRIOR_LEDGER.namesSha256,
    'the expected prior ledger is the actual observed production ledger');
  assert.match(OPS_0227_0244_PRE_READ_QUERY, /^SELECT json_object\(/u);
  assert.doesNotMatch(OPS_0227_0244_PRE_READ_QUERY.replace(/'[^']*'/gu, "''"), /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/iu);
});

test('happy path advances 226 -> 236 in order with a counts-only receipt', async () => {
  const file = freshDb();
  const { result, provider, receipt, receiptText } = await execute(file);
  assert.equal(result.status, 'complete');
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.writesPerformed, 10);
  assert.equal(provider.calls.writes, 10);
  assert.deepEqual(receipt.finalLedger, { ...OPS_0227_0244_FINAL_LEDGER });
  assert.deepEqual(ledgerOf(file).slice(226), OPS_0227_0244_ORDERED_NAMES.map((name, i) => ({ id: 227 + i, name })));
  assert.equal(receipt.steps.length, 10);
  for (const step of receipt.steps) {
    assert.ok(step.preflight.checks.every(item => item.ok), step.name);
    assert.ok(step.post.checks.every(item => item.ok), step.name);
  }
  assert.equal(receipt.steps[7].preflight.recorded.onboardingApprovers, 0);
  assert.equal(receipt.steps[9].preflight.recorded.nativeHires, 0);
  assert.deepEqual(receipt.steps[9].post.tableRows, { staff_operations_access_catalog: 15, staff_operations_access_commands: 0,
    staff_operations_access_state: 0 });
  assert.ok(receipt.notes.some(note => note.includes(OPS_0227_0244_AUTHORITY_NOTE)));
  assert.equal(receipt.planSha256, loadVerifiedOps0227To0244Plan().planSha256);
  assert.equal(receipt.files.length, 10);
  // No staff identities and no tokens in the receipt.
  const db = new DatabaseSync(file, { readOnly: true });
  const identities = db.prepare('SELECT id,email,display_name FROM staff_users').all().flatMap(row => [row.id, row.email, row.display_name]);
  db.close();
  assert.ok(identities.length > 0);
  for (const value of identities) assert.ok(!receiptText.includes(value), 'receipt must not contain staff identities');
  assert.ok(!receiptText.includes(TOKEN_ENV.CLOUDFLARE_API_TOKEN));
  assert.doesNotMatch(receiptText, /CREATE (?:TABLE|TRIGGER|VIEW|INDEX)/u, 'receipt carries hashes, not schema SQL');
});

test('a wrong local file hash refuses before any remote call', async () => {
  const root = path.join(tmp, `root-${++counter}`);
  fs.mkdirSync(path.join(root, 'apps/operations/migrations'), { recursive: true });
  fs.mkdirSync(path.join(root, 'scripts/fixtures'), { recursive: true });
  for (const { name } of OPS_0227_0244_FILES) fs.copyFileSync(path.join(ROOT, 'apps/operations/migrations', name), path.join(root, 'apps/operations/migrations', name));
  fs.copyFileSync(OPS_0227_0244_FIXTURE_PATH, path.join(root, 'scripts/fixtures/production-ops-0227-0244-wrangler-wire-statements.json'));
  assert.ok(loadVerifiedOps0227To0244Plan({ root }));
  fs.appendFileSync(path.join(root, 'apps/operations/migrations/0242_native_staff_onboarding_approval_actor_authority.sql'), '\n');
  assert.throws(() => loadVerifiedOps0227To0244Plan({ root }), /local_migration_hash_mismatch:0242_/u);
  let factoryCalls = 0;
  const receiptFile = receiptPath();
  const result = await mainOps0227To0244(['--execute', '--rehearsal', '--receipt', receiptFile, ...rehearsalArgs], {
    root, env: TOKEN_ENV, out: () => {}, confirm: async () => true,
    providerFactory: () => { factoryCalls++; throw new Error('must not be constructed'); },
  });
  assert.equal(result.status, 'refused');
  assert.match(result.stop.code, /local_migration_hash_mismatch:0242_/u);
  assert.equal(factoryCalls, 0);
  assert.equal(readReceipt(receiptFile).status, 'refused');
  // A tampered wire fixture is refused the same way.
  fs.copyFileSync(path.join(ROOT, 'apps/operations/migrations/0242_native_staff_onboarding_approval_actor_authority.sql'),
    path.join(root, 'apps/operations/migrations/0242_native_staff_onboarding_approval_actor_authority.sql'));
  fs.appendFileSync(path.join(root, 'scripts/fixtures/production-ops-0227-0244-wrangler-wire-statements.json'), ' ');
  assert.throws(() => loadVerifiedOps0227To0244Plan({ root }), /wire_fixture_hash_mismatch/u);
});

test('a ledger not at exactly 226 rows ending at 0226 refuses before any write', async () => {
  const short = await execute(freshDb(225));
  assert.equal(short.result.status, 'stopped');
  assert.deepEqual(short.result.stop, { step: null, phase: 'initial-ledger', code: 'prior_ledger_mismatch:ledger_count' });
  assert.equal(short.provider.calls.writes, 0);

  const ahead = freshDb();
  const db = new DatabaseSync(ahead);
  db.prepare(LEDGER_INSERT_SQL).run('0227_owner_intel_reads.sql');
  db.close();
  const partial = await execute(ahead);
  assert.equal(partial.result.status, 'reconciliation-required');
  assert.equal(partial.result.stop.phase, 'initial-ledger');
  assert.equal(partial.provider.calls.writes, 0);
  assert.equal(partial.receipt.initial.checks.find(item => item.name === 'planned_files_already_in_ledger').observed, 1);

  const renamed = freshDb();
  const db2 = new DatabaseSync(renamed);
  db2.exec("UPDATE d1_migrations SET name='0100_renamed.sql' WHERE id=100");
  db2.close();
  const drift = await execute(renamed);
  assert.deepEqual(drift.result.stop, { step: null, phase: 'initial-ledger', code: 'prior_ledger_mismatch:ledger_names_sha256' });
  assert.equal(drift.provider.calls.writes, 0);
});

function assertStoppedAt(run, name, code, writes) {
  assert.equal(run.result.status, 'stopped');
  assert.equal(run.receipt.status, 'stopped');
  assert.deepEqual(run.receipt.stop, { step: name, phase: 'preflight', code });
  assert.equal(run.provider.calls.writes, writes);
  assert.equal(run.receipt.writesPerformed, writes);
  assert.equal(run.receipt.steps.length, writes + 1);
  assert.equal(run.receipt.steps.at(-1).apply, null);
  assert.equal(run.receipt.finalLedger.count, 226 + writes);
  assert.equal(run.receipt.finalLedger.lastMigration, writes === 0 ? '0226_staff_login_bindings.sql' : OPS_0227_0244_ORDERED_NAMES[writes - 1]);
}

test('0244 preflight stops when the 15 catalog permission keys are not all present', async () => {
  const file = freshDb();
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM role_permissions WHERE permission_key='viewer.manage'; DELETE FROM permissions WHERE key='viewer.manage';");
  db.close();
  const run = await execute(file);
  assertStoppedAt(run, '0244_staff_operations_access_writer.sql', 'preflight_failed:catalog_permission_keys', 9);
  assert.equal(run.receipt.steps.at(-1).preflight.checks.find(item => item.name === 'catalog_permission_keys').observed, 14);
  assert.equal(ledgerOf(file).length, 235);
});

test('0244 preflight stops when a native hire already has an override row', async () => {
  const run = await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes === 9
    ? { ...snapshot, probes: { ...snapshot.probes, nativeHireOverrides: 1 } } : snapshot });
  assertStoppedAt(run, '0244_staff_operations_access_writer.sql', 'preflight_failed:native_hire_overrides', 9);
});

test('0244 preflight stops when native staff reconciliation is enabled', async () => {
  const run = await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes === 9
    ? { ...snapshot, probes: { ...snapshot.probes, nativeStaffReconciliationEnabled: 1 } } : snapshot });
  assertStoppedAt(run, '0244_staff_operations_access_writer.sql', 'preflight_failed:native_staff_reconciliation_enabled', 9);
});

test('0242 preflight stops on a claimed onboarding; 0240 on missing roles; 0243 on missing login tables', async () => {
  assertStoppedAt(await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes === 7
    ? { ...snapshot, probes: { ...snapshot.probes, claimedOnboarding: 1 } } : snapshot }),
  '0242_native_staff_onboarding_approval_actor_authority.sql', 'preflight_failed:claimed_onboarding', 7);
  assertStoppedAt(await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes === 5
    ? { ...snapshot, probes: { ...snapshot.probes, ownerAdminRoles: 1 } } : snapshot }),
  '0240_flight_logs_permissions.sql', 'preflight_failed:owner_admin_roles', 5);
  assertStoppedAt(await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes === 8
    ? { ...snapshot, probes: { ...snapshot.probes, staffLoginPrerequisiteTables: 2 } } : snapshot }),
  '0243_staff_logs_device_eligibility.sql', 'preflight_failed:staff_login_prerequisite_tables', 8);
});

test('a pre-existing object of a later file stops at that file', async () => {
  const file = freshDb();
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE staff_usernames(placeholder TEXT)');
  db.close();
  assertStoppedAt(await execute(file), '0241_staff_usernames.sql', 'preflight_failed:file_objects_absent', 6);
});

test('a transport error mid-way is ambiguous: stop without retry, partial receipt, reconciliation required', async () => {
  const file = freshDb();
  const run = await execute(file, { failApplyAt: '0229_owner_intel_source_feed.sql' });
  assert.equal(run.result.status, 'reconciliation-required');
  assert.deepEqual(run.receipt.stop, { step: '0229_owner_intel_source_feed.sql', phase: 'apply',
    code: 'reconciliation_required:apply_ambiguous_no_retry', detail: 'unexpected_error' });
  assert.equal(run.receipt.steps[2].apply.outcome, 'ambiguous');
  assert.equal(run.receipt.steps[1].apply.outcome, 'acknowledged');
  assert.deepEqual(run.receipt.steps[1].readback, { ledgerCount: 228, ledgerTail: { id: 228, name: '0228_competitor_intel_ingest.sql' },
    expectedObjects: 14, objectsPresent: 14 });
  assert.equal(run.provider.calls.writes, 3);
  assert.equal(run.receipt.writesPerformed, 2);
  assert.equal(run.receipt.steps.length, 3);
  assert.ok(run.receipt.steps[2].apply.startedAt && run.receipt.steps[2].apply.finishedAt);
  assert.equal(run.receipt.steps[2].post, null);
  assert.deepEqual(run.receipt.finalLedger.lastMigration, '0228_competitor_intel_ingest.sql');
  assert.equal(ledgerOf(file).length, 228);
  assert.ok(run.receipt.notes.some(note => /Do not retry/u.test(note)));
});

test('a post-check mismatch (missing ledger row) stops at that file', async () => {
  const file = freshDb();
  const run = await execute(file, { skipLedgerAt: '0230_app_release_pilot.sql' });
  assert.equal(run.result.status, 'stopped');
  assert.deepEqual(run.receipt.stop, { step: '0230_app_release_pilot.sql', phase: 'post-check', code: 'post_check_failed:readback_ledger_tail' });
  assert.equal(run.provider.calls.writes, 4);
});

test('dry-run is the default, prints the ordered plan, and never writes', async () => {
  const file = freshDb();
  const before = fs.readFileSync(file);
  let provider, options;
  const lines = [];
  const result = await mainOps0227To0244([...rehearsalArgs], {
    env: TOKEN_ENV, out: line => lines.push(line),
    providerFactory: value => { options = value; provider = sqliteProvider(file); return provider; },
    confirm: async () => { throw new Error('dry-run must not ask for confirmation'); },
  });
  provider.close();
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.status, 'dry-run-passed');
  assert.equal(options.allowWrites, false);
  assert.equal(provider.calls.writes, 0);
  assert.equal(provider.calls.reads, 1);
  assert.equal(result.writesPerformed, 0);
  assert.ok(fs.readFileSync(file).equals(before), 'database bytes unchanged');
  assert.ok(lines[0].includes('0227_owner_intel_reads.sql') && lines[0].includes('0244_staff_operations_access_writer.sql'));
  assert.equal(result.steps.length, 10);
  assert.ok(result.steps.slice(1).every(step => step.preflight.ledgerDeferred === true));
  assert.ok(result.notes.some(note => note.includes(OPS_0227_0244_AUTHORITY_NOTE)));

  // Dry-run reports the first failing preflight instead of writing.
  const blocked = freshDb();
  const db = new DatabaseSync(blocked);
  db.exec("PRAGMA foreign_keys=OFF; DELETE FROM permissions WHERE key='sops.assign';");
  db.close();
  let blockedProvider;
  const refused = await mainOps0227To0244(['--dry-run', ...rehearsalArgs], { env: TOKEN_ENV, out: () => {},
    providerFactory: () => (blockedProvider = sqliteProvider(blocked)) });
  blockedProvider.close();
  assert.equal(refused.status, 'stopped');
  assert.equal(refused.stop.code, 'preflight_failed:catalog_permission_keys');
  assert.equal(blockedProvider.calls.writes, 0);
});

test('execute requires the typed confirmation and a fresh receipt; a cancelled run writes nothing', async () => {
  const file = freshDb();
  const receiptFile = receiptPath();
  let provider, phrase;
  const cancelled = await mainOps0227To0244(['--execute', '--rehearsal', '--receipt', receiptFile, ...rehearsalArgs], {
    env: TOKEN_ENV, out: () => {}, providerFactory: () => (provider = sqliteProvider(file)),
    confirm: async value => { phrase = value; return false; },
  });
  provider.close();
  assert.equal(phrase, `APPLY 0227-0244 TO ${REHEARSAL.databaseName}`);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(provider.calls.writes, 0);
  assert.equal(readReceipt(receiptFile).status, 'cancelled');

  let factoryCalls = 0;
  await assert.rejects(mainOps0227To0244(['--execute', '--rehearsal', '--receipt', receiptFile, ...rehearsalArgs], {
    env: TOKEN_ENV, out: () => {}, providerFactory: () => { factoryCalls++; }, confirm: async () => true,
  }), /receipt_exists_no_replay/u);
  assert.equal(factoryCalls, 0);

  const applyFile = freshDb();
  const applyReceipt = receiptPath();
  const done = await mainOps0227To0244(['--execute', '--rehearsal', '--receipt', applyReceipt, ...rehearsalArgs], {
    env: TOKEN_ENV, out: () => {}, providerFactory: () => (provider = sqliteProvider(applyFile)), confirm: async () => true,
  });
  provider.close();
  assert.equal(done.status, 'complete');
  assert.equal(readReceipt(applyReceipt).finalLedger.count, 236);
  assert.equal(ledgerOf(applyFile).length, 236);
});

test('arguments: dry-run default, explicit target, rehearsal and production guards', () => {
  assert.equal(parseOps0227To0244Args(rehearsalArgs).mode, 'dry-run');
  assert.equal(parseOps0227To0244Args(rehearsalArgs.slice(2), { CLOUDFLARE_ACCOUNT_ID: REHEARSAL.accountId }).accountId, REHEARSAL.accountId);
  assert.throws(() => parseOps0227To0244Args(rehearsalArgs.slice(2)), /account_id_required/u);
  assert.throws(() => parseOps0227To0244Args(['--account-id', REHEARSAL.accountId]), /database_id_required/u);
  assert.throws(() => parseOps0227To0244Args(['--execute', ...rehearsalArgs]), /receipt_required/u);
  assert.throws(() => parseOps0227To0244Args(['--execute', '--receipt', path.join(tmp, 'x.json'), ...rehearsalArgs]),
    /rehearsal_flag_required_for_non_production_database/u);
  assert.throws(() => parseOps0227To0244Args(['--execute', '--receipt', 'relative.json', '--rehearsal', ...rehearsalArgs]), /receipt_path_invalid/u);
  assert.throws(() => parseOps0227To0244Args(['--dry-run', '--execute', ...rehearsalArgs]), /usage/u);
  assert.throws(() => parseOps0227To0244Args(['--bogus', ...rehearsalArgs]), /usage/u);
  const production = ['--account-id', OPS_PRODUCTION_DATABASE.accountId, '--database-id', OPS_PRODUCTION_DATABASE.databaseId,
    '--database-name', OPS_PRODUCTION_DATABASE.databaseName];
  assert.equal(parseOps0227To0244Args(production).environment, 'production');
  assert.throws(() => parseOps0227To0244Args(['--execute', '--rehearsal', '--receipt', path.join(tmp, 'p.json'), ...production]),
    /rehearsal_refuses_production_database/u);
  assert.throws(() => parseOps0227To0244Args([...production.slice(0, 4), '--database-name', 'other']), /production_target_mismatch/u);
});

test('production execute runs the main-branch source check before any provider is built', async () => {
  const production = ['--account-id', OPS_PRODUCTION_DATABASE.accountId, '--database-id', OPS_PRODUCTION_DATABASE.databaseId,
    '--database-name', OPS_PRODUCTION_DATABASE.databaseName];
  let factoryCalls = 0;
  await assert.rejects(mainOps0227To0244(['--execute', '--receipt', receiptPath(), '--approval-ref', 'approval-synthetic', ...production], {
    env: TOKEN_ENV, out: () => {}, sourceCheck: async () => { throw new Error('ops_0227_0244:main_branch_required'); },
    providerFactory: () => { factoryCalls++; },
  }), /main_branch_required/u);
  assert.equal(factoryCalls, 0);
});

// --- Cloudflare provider (fake fetch only) ---------------------------------

function fakeFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : undefined });
    const { status = 200, payload } = await handler(String(url), init, calls.length);
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, calls };
}
const provider = (fetchImpl, extra = {}) => createOps0227To0244CloudflareProvider({ getBearerToken: () => TOKEN_ENV.CLOUDFLARE_API_TOKEN,
  ...REHEARSAL, fetchImpl, ...extra });
const targetPayload = { success: true, result: { uuid: REHEARSAL.databaseId, name: REHEARSAL.databaseName } };

test('provider verifies the explicit target and refuses non-snapshot reads', async () => {
  const wrong = fakeFetch(() => ({ payload: { success: true, result: { uuid: REHEARSAL.databaseId, name: 'ltds-ops' } } }));
  await assert.rejects(provider(wrong.fetchImpl).assertTarget(), /target_mismatch/u);
  const fake = fakeFetch((url, init, n) => n === 1 ? { payload: targetPayload }
    : { payload: { success: true, result: [{ success: true, results: [{ ops_0227_0244_snapshot: JSON.stringify({ ledger: [], schema: [],
      probes: Object.fromEntries(['ownerAdminRoles', 'flightLogsPermissions', 'flightLogsRolePermissions', 'claimedOnboarding', 'onboardingApprovers',
        'staffLoginPrerequisiteTables', 'catalogPermissionKeys', 'nativeHireOverrides', 'nativeHires', 'nativeStaffReconciliationRows',
        'nativeStaffReconciliationEnabled', 'staffUsersViewColumns'].map(key => [key, 0])), tableRows: {} }) }],
    meta: { rows_written: 0, changed_db: false, served_by_primary: true } }] } });
  const p = provider(fake.fetchImpl);
  await assert.rejects(p.readSnapshot({ query: OPS_0227_0244_PRE_READ_QUERY }), /target_not_verified/u);
  await p.assertTarget();
  await assert.rejects(p.readSnapshot({ query: 'DELETE FROM d1_migrations' }), /read_query_invalid/u);
  const snapshot = await p.readSnapshot({ query: OPS_0227_0244_PRE_READ_QUERY });
  assert.deepEqual(snapshot.ledger, []);
  assert.equal(fake.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${REHEARSAL.accountId}/d1/database/${REHEARSAL.databaseId}`);
  assert.equal(fake.calls[1].init.redirect, 'manual');
  assert.deepEqual(fake.calls[1].body, { sql: OPS_0227_0244_PRE_READ_QUERY, params: [] });
});

test('provider sends one pinned batch per migration, refuses writes in dry-run, tampering, and re-sends', async () => {
  const plan = loadVerifiedOps0227To0244Plan();
  const file = plan.files[0];
  const okBatch = fakeFetch((url, init) => init.method === 'GET' ? { payload: targetPayload } : { payload: { success: true,
    result: [...file.statements.map(() => ({ success: true, results: [], meta: { changes: 0 } })), { success: true, results: [], meta: { changes: 1 } }] } });
  const readOnly = provider(okBatch.fetchImpl);
  await readOnly.assertTarget();
  await assert.rejects(readOnly.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements,
    statementsSha256: file.statementsSha256 }), /writes_disabled/u);
  const p = provider(okBatch.fetchImpl, { allowWrites: true });
  await p.assertTarget();
  await assert.rejects(p.applyMigration({ name: file.name, sha256: file.sha256, statements: [...file.statements, 'DROP TABLE roles'],
    statementsSha256: file.statementsSha256 }), /migration_pin_mismatch/u);
  await assert.rejects(p.applyMigration({ name: '0226_staff_login_bindings.sql', sha256: file.sha256, statements: file.statements,
    statementsSha256: file.statementsSha256 }), /migration_pin_mismatch/u);
  await p.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements, statementsSha256: file.statementsSha256 });
  const batch = okBatch.calls.at(-1).body.batch;
  assert.equal(batch.length, file.statementCount + 1);
  assert.deepEqual(batch.at(-1), { sql: 'INSERT INTO d1_migrations(name) VALUES (?)', params: [file.name] });
  assert.deepEqual(batch.slice(0, -1).map(item => item.sql), file.statements);
  await assert.rejects(p.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements,
    statementsSha256: file.statementsSha256 }), /migration_already_sent_no_retry/u);

  const failing = fakeFetch((url, init) => init.method === 'GET' ? { payload: targetPayload } : { status: 500, payload: { success: false } });
  const q = provider(failing.fetchImpl, { allowWrites: true });
  await q.assertTarget();
  await assert.rejects(q.applyMigration({ name: file.name, sha256: file.sha256, statements: file.statements,
    statementsSha256: file.statementsSha256 }), /http_failure/u);
  assert.equal(failing.calls.length, 2, 'no retry after a failed mutation');
});

// --- Reconcile, ambiguous responses, resume, approval boundary -------------

async function cli(file, args, { providerOptions = {}, confirm = async () => true, extra = {} } = {}) {
  let provider;
  try {
    const result = await mainOps0227To0244(args, { env: TOKEN_ENV, out: () => {}, confirm,
      providerFactory: () => (provider = sqliteProvider(file, providerOptions)), ...extra });
    return { result, provider };
  } finally { provider?.close(); }
}
const execArgs = receiptFile => ['--execute', '--rehearsal', '--receipt', receiptFile, ...rehearsalArgs];

/** Applies the first `count` planned files directly, exactly as the operator would. */
function applyPrefix(file, count) {
  const plan = loadVerifiedOps0227To0244Plan();
  const db = new DatabaseSync(file);
  try {
    for (const planned of plan.files.slice(0, count)) {
      db.exec('BEGIN');
      for (const statement of planned.statements) db.exec(statement);
      db.prepare(LEDGER_INSERT_SQL).run(planned.name);
      db.exec('COMMIT');
    }
  } finally { db.close(); }
}

test('reconcile is read-only and reports the exact next step at 226, mid-chain and 236', async () => {
  for (const [count, next] of [[0, '0227_owner_intel_reads.sql'], [4, '0231_owner_google_ads_summary.sql'],
    [6, '0241_staff_usernames.sql'], [10, null]]) {
    const file = freshDb();
    applyPrefix(file, count);
    const before = fs.readFileSync(file);
    const receiptFile = receiptPath();
    const { result, provider } = await cli(file, ['--reconcile', '--receipt', receiptFile, ...rehearsalArgs]);
    assert.equal(result.status, 'reconciled', `count ${count}`);
    assert.equal(result.reconcile.appliedCount, count);
    assert.equal(result.reconcile.nextStep, next);
    assert.equal(provider.calls.writes, 0);
    assert.equal(provider.calls.reads, 1);
    assert.ok(fs.readFileSync(file).equals(before));
    assert.equal(readReceipt(receiptFile).status, 'reconciled');
  }
});

test('mid-chain refusal before send stops without an ambiguous mark', async () => {
  const run = await execute(freshDb(), { refuseAt: '0242_native_staff_onboarding_approval_actor_authority.sql' });
  assert.equal(run.result.status, 'stopped');
  assert.deepEqual(run.receipt.stop, { step: '0242_native_staff_onboarding_approval_actor_authority.sql', phase: 'apply',
    code: 'apply_refused_before_send', detail: 'ops_0227_0244_provider:migration_pin_mismatch' });
  assert.equal(run.receipt.steps.at(-1).apply.outcome, 'not-sent');
  assert.equal(run.receipt.finalLedger.count, 233);
});

for (const landed of [true, false]) {
  test(`ambiguous response mid-chain (batch ${landed ? 'landed' : 'lost'}) -> reconcile -> resume -> 236`, async () => {
    const file = freshDb();
    const ambiguousAt = '0229_owner_intel_source_feed.sql';
    const first = await cli(file, execArgs(receiptPath()), { providerOptions: { ambiguousAt, landed } });
    assert.equal(first.result.status, 'reconciliation-required');
    assert.equal(first.result.steps.at(-1).apply.outcome, 'ambiguous');
    assert.deepEqual(first.provider.calls.sent, OPS_0227_0244_ORDERED_NAMES.slice(0, 3), 'sent once, never retried');
    assert.equal(ledgerOf(file).length, landed ? 229 : 228);

    // A plain retry is refused without any write: the ledger is past 226.
    const retry = await cli(file, execArgs(receiptPath()));
    assert.equal(retry.result.status, 'reconciliation-required');
    assert.equal(retry.provider.calls.writes, 0);

    const next = landed ? '0230_app_release_pilot.sql' : ambiguousAt;
    const reconciled = await cli(file, ['--reconcile', ...rehearsalArgs]);
    assert.equal(reconciled.result.status, 'reconciled');
    assert.equal(reconciled.result.reconcile.nextStep, next);

    // Resuming from anything but the reconciled next step is refused, including re-sending a recorded file.
    const wrong = landed ? ambiguousAt : '0230_app_release_pilot.sql';
    const wrongReceipt = receiptPath();
    const refused = await cli(file, [...execArgs(wrongReceipt), '--resume-from', wrong]);
    assert.equal(refused.result.status, 'reconciliation-required');
    assert.equal(refused.provider.calls.writes, 0);
    assert.equal(readReceipt(wrongReceipt).stop.code, 'reconciliation_required:resume_from_is_not_next_step');

    const resumeReceipt = receiptPath();
    const resumed = await cli(file, [...execArgs(resumeReceipt), '--resume-from', next]);
    assert.equal(resumed.result.status, 'complete');
    const start = OPS_0227_0244_ORDERED_NAMES.indexOf(next);
    assert.deepEqual(resumed.provider.calls.sent, OPS_0227_0244_ORDERED_NAMES.slice(start));
    const receipt = readReceipt(resumeReceipt);
    assert.equal(receipt.resumeFrom, next);
    assert.deepEqual(receipt.finalLedger, { ...OPS_0227_0244_FINAL_LEDGER });
    assert.deepEqual(ledgerOf(file).map(row => row.id), Array.from({ length: 236 }, (_, i) => i + 1));
    assert.ok(receipt.steps.every(step => step.readback.ledgerTail.name === step.name));
  });
}

test('resume is refused for a non-prefix ledger, recorded files without objects, and partial objects of an unrecorded file', async () => {
  const gap = freshDb();
  applyPrefix(gap, 1);
  let db = new DatabaseSync(gap);
  db.prepare(LEDGER_INSERT_SQL).run('0229_owner_intel_source_feed.sql');
  db.close();

  const hollow = freshDb();
  db = new DatabaseSync(hollow);
  db.prepare(LEDGER_INSERT_SQL).run('0227_owner_intel_reads.sql');
  db.close();

  const partial = freshDb();
  applyPrefix(partial, 2);
  db = new DatabaseSync(partial);
  db.exec('CREATE TABLE owner_intel_source_control(placeholder TEXT)');
  db.close();

  for (const [file, resumeFrom, code] of [
    [gap, '0228_competitor_intel_ingest.sql', 'reconciliation_required:recorded_rows_exact_ordered_prefix'],
    [hollow, '0228_competitor_intel_ingest.sql', 'reconciliation_required:recorded_objects_exact:0227_owner_intel_reads.sql'],
    [partial, '0229_owner_intel_source_feed.sql', 'reconciliation_required:unrecorded_objects_absent:0229_owner_intel_source_feed.sql'],
  ]) {
    const reconcileReceipt = receiptPath();
    const reconciled = await cli(file, ['--reconcile', '--receipt', reconcileReceipt, ...rehearsalArgs]);
    assert.equal(reconciled.result.status, 'reconciliation-required');
    assert.equal(reconciled.result.stop.code, code);
    assert.equal(readReceipt(reconcileReceipt).status, 'reconciliation-required');
    const receiptFile = receiptPath();
    const refused = await cli(file, [...execArgs(receiptFile), '--resume-from', resumeFrom]);
    assert.equal(refused.result.status, 'reconciliation-required');
    assert.equal(refused.provider.calls.writes, 0);
    assert.equal(readReceipt(receiptFile).stop.code, code);
    const plain = await cli(file, execArgs(receiptPath()));
    assert.equal(plain.result.status, 'reconciliation-required');
    assert.equal(plain.provider.calls.writes, 0);
  }
});

test('production execute requires an approval reference and records it; rehearsal does not', async () => {
  const production = ['--account-id', OPS_PRODUCTION_DATABASE.accountId, '--database-id', OPS_PRODUCTION_DATABASE.databaseId,
    '--database-name', OPS_PRODUCTION_DATABASE.databaseName];
  assert.throws(() => parseOps0227To0244Args(['--execute', '--receipt', path.join(tmp, 'a.json'), ...production]),
    /approval_ref_required_for_production/u);
  assert.throws(() => parseOps0227To0244Args(['--execute', '--receipt', path.join(tmp, 'a.json'), '--approval-ref', 'x y', ...production]),
    /approval_ref_invalid/u);
  assert.throws(() => parseOps0227To0244Args(['--reconcile', '--resume-from', '0228_competitor_intel_ingest.sql', ...rehearsalArgs]),
    /resume_from_invalid/u);
  assert.throws(() => parseOps0227To0244Args(['--execute', '--receipt', path.join(tmp, 'a.json'), '--rehearsal',
    '--resume-from', '0232_unknown.sql', ...rehearsalArgs]), /resume_from_invalid/u);
  assert.equal(parseOps0227To0244Args(execArgs(path.join(tmp, 'r.json'))).approvalRef, null);
  // Offline: an injected synthetic provider stands in for D1; the source check is stubbed.
  const file = freshDb();
  const receiptFile = receiptPath();
  const { result } = await cli(file, ['--execute', '--receipt', receiptFile, '--approval-ref', 'approval-0227-0244-synthetic', ...production],
    { extra: { sourceCheck: async () => 'f'.repeat(40) } });
  assert.equal(result.status, 'complete');
  const receipt = readReceipt(receiptFile);
  assert.equal(receipt.approvalRef, 'approval-0227-0244-synthetic');
  assert.equal(receipt.target.environment, 'production');
  assert.equal(receipt.finalLedger.count, 236);
});
