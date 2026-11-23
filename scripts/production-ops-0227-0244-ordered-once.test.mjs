// Offline tests for the ordered 0227..0244 once-operator. The synthetic D1 is a
// local node:sqlite file built from this repository's own migrations 0001..0226;
// no Cloudflare resource is contacted.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  LEDGER_INSERT_SQL, OPS_0227_0244_AUTHORITY_NOTE, OPS_0227_0244_FILES, OPS_0227_0244_FINAL_LEDGER,
  OPS_0227_0244_FIXTURE_SHA256, OPS_0227_0244_PRE_READ_QUERY, OPS_0227_0244_PRIOR_LEDGER, OPS_PRODUCTION_DATABASE, OPS_PRODUCTION_EXISTING_SCHEMA,
  OPS_0227_0244_SCHEMA_ROWS_SQL, loadOps0227To0244BaselineReceipt, ops0227To0244ExistingSchema, isOps0227To0244ReadQuery, loadVerifiedOps0227To0244Plan, mainOps0227To0244, openOps0227To0244Receipt,
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
  refuseAt = null, partialAt = null, sideEffectAt = null } = {}) {
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
      let row, schemaRows;
      try {
        row = { ...reader.prepare(query).get() };
        schemaRows = reader.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all().map(item => ({ ...item }));
      } finally { reader.close(); }
      const meta = { rows_written: 0, changed_db: false, served_by_primary: true };
      const snapshot = parseOps0227To0244SnapshotResult([{ success: true, results: [row], meta },
        { success: true, results: schemaRows, meta }], { observedAt: new Date().toISOString() });
      return tamper ? tamper(snapshot, calls) : snapshot;
    },
    async applyMigration({ name, statements }) {
      calls.writes++;
      if (name === refuseAt) throw new Error('ops_0227_0244_provider:migration_pin_mismatch');
      calls.sent.push(name);
      if (name === failApplyAt || (name === ambiguousAt && !landed)) throw new Error('synthetic transport failure');
      // No BEGIN/COMMIT: a D1 batch is not assumed to be atomic. Statements land one by one.
      for (const [index, statement] of statements.entries()) {
        if (partialAt?.name === name && index === partialAt.count) throw new Error('synthetic failure mid-batch');
        writer.exec(statement);
      }
      if (sideEffectAt?.name === name) writer.exec(sideEffectAt.sql);
      if (name !== skipLedgerAt) writer.prepare(LEDGER_INSERT_SQL).run(name);
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
  assert.deepEqual(short.result.stop, { step: null, phase: 'initial-ledger', code: 'prior_ledger_mismatch:ledger_count',
    detail: 'ledger has 225 rows ending 0225_native_staff_lifecycle_bridge.sql; expected next file 0227_owner_intel_reads.sql' });
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
  assert.equal(drift.result.stop.code, 'prior_ledger_mismatch:ledger_names_sha256');
  assert.equal(drift.result.stop.phase, 'initial-ledger');
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
  assert.equal(run.result.status, 'reconciliation-required');
  assert.equal(run.receipt.stop.step, '0230_app_release_pilot.sql');
  assert.equal(run.receipt.stop.phase, 'post-check');
  assert.equal(run.receipt.stop.code, 'reconciliation_required:postcheck_failed');
  assert.match(run.receipt.stop.detail, /^readback_ledger_tail,/u);
  assert.equal(run.receipt.status, 'reconciliation-required');
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
  const receiptFile = receiptPath();
  // The real 0226 source check throws production_ops_0226_runner_* codes; they map to a refused receipt.
  const result = await mainOps0227To0244(['--execute', '--receipt', receiptFile, '--approval-ref', 'approval-synthetic', ...production], {
    env: TOKEN_ENV, out: () => {}, sourceCheck: async () => { throw new Error('production_ops_0226_runner_main_branch_required'); },
    providerFactory: () => { factoryCalls++; },
  });
  assert.equal(factoryCalls, 0);
  assert.equal(result.status, 'refused');
  const receipt = readReceipt(receiptFile);
  assert.deepEqual(receipt.stop, { step: null, phase: 'source-check',
    code: 'ops_0227_0244:source_check_failed:production_ops_0226_runner_main_branch_required' });
  assert.equal(receipt.approvalRef, 'approval-synthetic');
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
  const meta = { rows_written: 0, changed_db: false, served_by_primary: true };
  const probes = Object.fromEntries(['ownerAdminRoles', 'flightLogsPermissions', 'flightLogsRolePermissions', 'claimedOnboarding',
    'onboardingApprovers', 'staffLoginPrerequisiteTables', 'catalogPermissionKeys', 'nativeHireOverrides', 'nativeHires',
    'nativeStaffReconciliationRows', 'nativeStaffReconciliationEnabled', 'staffUsersViewColumns', 'ledgerSequence', 'rolesRows',
    'permissionsRows', 'rolePermissionsRows', 'staffUsersRows', 'staffPermissionOverridesRows'].map(key => [key, 0]));
  const fake = fakeFetch((url, init, n) => n === 1 ? { payload: targetPayload }
    : { payload: { success: true, result: [
      { success: true, results: [{ ops_0227_0244_snapshot: JSON.stringify({ ledger: [], probes, tableRows: {} }) }], meta },
      { success: true, results: [{ type: 'table', name: 'roles', tbl_name: 'roles', sql: 'CREATE TABLE roles(id TEXT)' }], meta }] } });
  const p = provider(fake.fetchImpl);
  await assert.rejects(p.readSnapshot({ query: OPS_0227_0244_PRE_READ_QUERY }), /target_not_verified/u);
  await p.assertTarget();
  await assert.rejects(p.readSnapshot({ query: 'DELETE FROM d1_migrations' }), /read_query_invalid/u);
  const snapshot = await p.readSnapshot({ query: OPS_0227_0244_PRE_READ_QUERY });
  assert.deepEqual(snapshot.ledger, []);
  assert.equal(snapshot.schema.length, 1);
  assert.equal(snapshot.snapshotBytes, Buffer.byteLength(JSON.stringify({ ledger: [], probes, tableRows: {} })));
  assert.equal(fake.calls[0].url, `https://api.cloudflare.com/client/v4/accounts/${REHEARSAL.accountId}/d1/database/${REHEARSAL.databaseId}`);
  assert.equal(fake.calls[1].init.redirect, 'manual');
  assert.deepEqual(fake.calls[1].body, { batch: [{ sql: OPS_0227_0244_PRE_READ_QUERY, params: [] },
    { sql: OPS_0227_0244_SCHEMA_ROWS_SQL, params: [] }] });
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

/** A counts-only baseline receipt holding the 226-row start counts of the synthetic chain. */
function baselineFor(recorded = 0) {
  const db = new DatabaseSync(chains[226], { readOnly: true });
  let row, schema;
  try {
    schema = db.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all().map(item => ({ ...item }));
    row = { ...db.prepare(`SELECT (SELECT count(*) FROM roles) rolesRows, (SELECT count(*) FROM permissions) permissionsRows,
      (SELECT count(*) FROM role_permissions) rolePermissionsRows, (SELECT count(*) FROM staff_users) staffUsersRows,
      (SELECT count(*) FROM staff_permission_overrides) staffPermissionOverridesRows`).get() };
  } finally { db.close(); }
  const file = receiptPath();
  fs.writeFileSync(file, JSON.stringify({ contract: 'production-ops-0227-0244-ordered-once-v1',
    planSha256: loadVerifiedOps0227To0244Plan().planSha256, target: { environment: 'non-production', ...REHEARSAL },
    rowCounts: { start: row }, stop: null, existingSchema: ops0227To0244ExistingSchema({ schema }, loadVerifiedOps0227To0244Plan()),
    finalLedger: { count: 226 + recorded, lastMigration: recorded === 0 ? '0226_staff_login_bindings.sql' : OPS_0227_0244_ORDERED_NAMES[recorded - 1] } }));
  return file;
}

/** Applies the first `count` planned files directly, exactly as the operator would. */
function applyPrefix(file, count) {
  const plan = loadVerifiedOps0227To0244Plan();
  const db = new DatabaseSync(file);
  try {
    for (const planned of plan.files.slice(0, count)) {
      for (const statement of planned.statements) db.exec(statement);
      db.prepare(LEDGER_INSERT_SQL).run(planned.name);
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
    const { result, provider } = await cli(file, ['--reconcile', '--receipt', receiptFile, '--baseline-receipt', baselineFor(count), ...rehearsalArgs]);
    assert.equal(result.status, 'reconciled', `count ${count}`);
    assert.equal(result.reconcile.appliedCount, count);
    assert.equal(result.reconcile.nextStep, next);
    assert.equal(provider.calls.writes, 0);
    assert.equal(provider.calls.reads, count >= 1 ? 2 : 1, 'one read, plus one counting the recorded seed tables');
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
    const firstReceipt = receiptPath();
    const first = await cli(file, execArgs(firstReceipt), { providerOptions: { ambiguousAt, landed } });
    assert.equal(first.result.status, 'reconciliation-required');
    assert.equal(first.result.steps.at(-1).apply.outcome, 'ambiguous');
    assert.deepEqual(first.provider.calls.sent, OPS_0227_0244_ORDERED_NAMES.slice(0, 3), 'sent once, never retried');
    assert.equal(ledgerOf(file).length, landed ? 229 : 228);

    // A plain retry is refused without any write: the ledger is past 226.
    const retry = await cli(file, execArgs(receiptPath()));
    assert.equal(retry.result.status, 'reconciliation-required');
    assert.equal(retry.provider.calls.writes, 0);

    const next = landed ? '0230_app_release_pilot.sql' : ambiguousAt;
    const withoutBaseline = await cli(file, ['--reconcile', ...rehearsalArgs]);
    assert.equal(withoutBaseline.result.stop.code, 'reconciliation_required:baseline_receipt_required');
    // Reconcile twice; both runs must agree before resuming.
    const reconciled = await cli(file, ['--reconcile', '--baseline-receipt', firstReceipt, ...rehearsalArgs]);
    const again = await cli(file, ['--reconcile', '--baseline-receipt', firstReceipt, ...rehearsalArgs]);
    assert.equal(reconciled.result.status, 'reconciled');
    assert.equal(reconciled.result.reconcile.nextStep, next);
    assert.deepEqual(again.result.reconcile, reconciled.result.reconcile);
    assert.ok(reconciled.result.reconcile.checks.some(item => item.name === 'row_count:staffUsersRows' && item.ok));

    // Resuming from anything but the reconciled next step is refused, including re-sending a recorded file.
    const wrong = landed ? ambiguousAt : '0230_app_release_pilot.sql';
    const wrongReceipt = receiptPath();
    const refused = await cli(file, [...execArgs(wrongReceipt), '--resume-from', wrong, '--baseline-receipt', firstReceipt]);
    assert.equal(refused.result.status, 'reconciliation-required');
    assert.equal(refused.provider.calls.writes, 0);
    assert.equal(readReceipt(wrongReceipt).stop.code, 'reconciliation_required:resume_from_is_not_next_step');

    const resumeReceipt = receiptPath();
    const resumed = await cli(file, [...execArgs(resumeReceipt), '--resume-from', next, '--baseline-receipt', firstReceipt]);
    assert.equal(resumed.result.status, 'complete');
    const start = OPS_0227_0244_ORDERED_NAMES.indexOf(next);
    assert.deepEqual(resumed.provider.calls.sent, OPS_0227_0244_ORDERED_NAMES.slice(start));
    const receipt = readReceipt(resumeReceipt);
    assert.equal(receipt.resumeFrom, next);
    assert.deepEqual(receipt.finalLedger, { ...OPS_0227_0244_FINAL_LEDGER });
    assert.deepEqual(ledgerOf(file).map(row => row.id), Array.from({ length: 236 }, (_, i) => i + 1));
    assert.ok(receipt.steps.every(step => step.readback.ledgerTail.name === step.name));
    assert.deepEqual(receipt.rowCounts.start, readReceipt(firstReceipt).rowCounts.start, 'start counts carried forward');
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
  // The synthetic chain is the source-built schema, not production's approved one, so the run is refused unwritten.
  assert.equal(result.status, 'refused');
  const receipt = readReceipt(receiptFile);
  assert.equal(receipt.approvalRef, 'approval-0227-0244-synthetic');
  assert.equal(receipt.target.environment, 'production');
  assert.equal(receipt.stop.code, 'approved_existing_schema_mismatch');
  assert.equal(receipt.finalLedger.count, 226);
});

// --- Review follow-ups: non-atomic batches, row counts, sequence, targets ----

test('a partially applied batch (some statements, no ledger row) is detected and refused by reconcile', async () => {
  const file = freshDb();
  const name = '0231_owner_google_ads_summary.sql';
  const first = await cli(file, execArgs(receiptPath()), { providerOptions: { partialAt: { name, count: 6 } } });
  assert.equal(first.result.status, 'reconciliation-required');
  assert.equal(first.result.steps.at(-1).apply.outcome, 'ambiguous');
  assert.equal(ledgerOf(file).length, 230, 'no ledger row for the partial file');
  const db = new DatabaseSync(file, { readOnly: true });
  const partialTables = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name GLOB 'owner_intel_google_ads_*'").get().n;
  db.close();
  assert.ok(partialTables > 0, 'some objects of the unrecorded file exist');

  const receiptFile = receiptPath();
  const reconciled = await cli(file, ['--reconcile', '--receipt', receiptFile, ...rehearsalArgs]);
  assert.equal(reconciled.result.status, 'reconciliation-required');
  assert.equal(reconciled.result.stop.code, `reconciliation_required:unrecorded_objects_absent:${name}`);
  assert.equal(reconciled.result.stop.detail,
    `ledger has 230 rows ending 0230_app_release_pilot.sql; expected next file ${name}`);
  assert.equal(readReceipt(receiptFile).reconcile.ledgerCount, 230);
  for (const args of [[...execArgs(receiptPath()), '--resume-from', name], execArgs(receiptPath())]) {
    const refused = await cli(file, args);
    assert.equal(refused.result.status, 'reconciliation-required');
    assert.equal(refused.provider.calls.writes, 0);
  }
});

test('the resume mismatch message states the ledger count and the expected next file', async () => {
  const file = freshDb();
  applyPrefix(file, 3);
  const receiptFile = receiptPath();
  const refused = await cli(file, [...execArgs(receiptFile), '--resume-from', '0228_competitor_intel_ingest.sql',
    '--baseline-receipt', baselineFor(3)]);
  assert.equal(refused.result.status, 'reconciliation-required');
  assert.equal(readReceipt(receiptFile).stop.detail, 'ledger has 229 rows ending 0229_owner_intel_source_feed.sql; '
    + 'expected next file 0230_app_release_pilot.sql; --resume-from was 0228_competitor_intel_ingest.sql');
  const plain = await cli(file, execArgs(receiptPath()));
  assert.match(plain.result.stop.detail, /^ledger has 229 rows .*expected next file 0230_app_release_pilot\.sql/u);
});

test('row counts: 0240 adds exactly 2 permissions and 4 role grants; staff and override counts never change', async () => {
  const run = await execute(freshDb());
  assert.equal(run.result.status, 'complete');
  const deltas = Object.fromEntries(run.receipt.steps.map(step => [step.name.slice(0, 4), step.post.rowDeltas]));
  assert.deepEqual(deltas['0240'], { rolesRows: 0, permissionsRows: 2, rolePermissionsRows: 4, staffUsersRows: 0, staffPermissionOverridesRows: 0 });
  for (const [prefix, delta] of Object.entries(deltas)) {
    if (prefix !== '0240') assert.deepEqual(delta, { rolesRows: 0, permissionsRows: 0, rolePermissionsRows: 0, staffUsersRows: 0,
      staffPermissionOverridesRows: 0 }, prefix);
  }
  const { start: initial, final } = run.receipt.rowCounts;
  assert.equal(final.permissionsRows - initial.permissionsRows, 2);
  assert.equal(final.rolePermissionsRows - initial.rolePermissionsRows, 4);
  assert.equal(final.staffUsersRows, initial.staffUsersRows);
  assert.equal(final.staffPermissionOverridesRows, initial.staffPermissionOverridesRows);
  assert.ok(run.receipt.steps[9].post.checks.some(item => item.name === 'catalog_rows' && item.ok && item.observed === 15));
  assert.ok(run.receipt.notes.some(note => note.startsWith('After 0244:')));
  assert.ok(run.receipt.initial.snapshotBytes > 0);
  assert.ok(run.receipt.steps.every(step => step.preflight.snapshotBytes > 0 && step.post.snapshotBytes > 0));
  console.log(`# largest single snapshot value (bytes): start ${run.receipt.initial.snapshotBytes}, after 0244 ${run.receipt.steps[9].post.snapshotBytes}`);

  const changed = await execute(freshDb(), { tamper: (snapshot, calls) => calls.writes >= 3
    ? { ...snapshot, probes: { ...snapshot.probes, staffUsersRows: snapshot.probes.staffUsersRows + 1 } } : snapshot });
  assert.equal(changed.result.status, 'reconciliation-required');
  assert.deepEqual(changed.result.stop, { step: '0229_owner_intel_source_feed.sql', phase: 'post-check',
    code: 'reconciliation_required:postcheck_failed', detail: 'staff_users_rows_unchanged_since_start' });
});

test('an AUTOINCREMENT sequence ahead of the ledger stops before the first write', async () => {
  const file = freshDb();
  const db = new DatabaseSync(file);
  db.exec("UPDATE sqlite_sequence SET seq=300 WHERE name='d1_migrations'");
  db.close();
  const run = await execute(file);
  assert.equal(run.result.stop.code, 'preflight_failed:ledger_sequence');
  assert.equal(run.provider.calls.writes, 0);
});

test('the Client production database is refused in every mode', () => {
  const client = ['--account-id', OPS_PRODUCTION_DATABASE.accountId, '--database-id', '7f40a7b7-c3ec-470e-a626-e798867f71f8',
    '--database-name', 'client-data'];
  for (const extra of [[], ['--reconcile'], ['--execute', '--rehearsal', '--receipt', path.join(tmp, 'c.json')]]) {
    assert.throws(() => parseOps0227To0244Args([...extra, ...client]), /client_production_database_refused/u);
  }
});

// --- N1: post-check failures and row-count invariants block reconcile -------

test('after a post-check failure, reconcile refuses and resume is impossible', async () => {
  const file = freshDb();
  const firstReceipt = receiptPath();
  const first = await cli(file, execArgs(firstReceipt), { providerOptions: { tamper: (snapshot, calls) => calls.writes >= 3
    ? { ...snapshot, probes: { ...snapshot.probes, staffUsersRows: snapshot.probes.staffUsersRows + 1 } } : snapshot } });
  assert.equal(first.result.status, 'reconciliation-required');
  assert.deepEqual(first.result.stop, { step: '0229_owner_intel_source_feed.sql', phase: 'post-check',
    code: 'reconciliation_required:postcheck_failed', detail: 'staff_users_rows_unchanged_since_start' });
  assert.equal(ledgerOf(file).length, 229);
  // The database itself is consistent, but the earlier run's post-check failed: never reconciled automatically.
  const reconcileReceipt = receiptPath();
  const reconciled = await cli(file, ['--reconcile', '--receipt', reconcileReceipt, '--baseline-receipt', firstReceipt, ...rehearsalArgs]);
  assert.equal(reconciled.result.status, 'reconciliation-required');
  assert.equal(reconciled.result.stop.code, 'reconciliation_required:baseline_receipt_postcheck_failed');
  assert.equal(readReceipt(reconcileReceipt).status, 'reconciliation-required');
  const resumed = await cli(file, [...execArgs(receiptPath()), '--resume-from', '0230_app_release_pilot.sql', '--baseline-receipt', firstReceipt]);
  assert.equal(resumed.result.status, 'reconciliation-required');
  assert.equal(resumed.provider.calls.writes, 0);
});

test('reconcile rechecks the row-count invariants against the start counts and names the differing counts', async () => {
  const file = freshDb();
  applyPrefix(file, 6);
  const baseline = baselineFor(6);
  const ok = await cli(file, ['--reconcile', '--baseline-receipt', baseline, ...rehearsalArgs]);
  assert.equal(ok.result.status, 'reconciled');
  assert.equal(ok.result.reconcile.nextStep, '0241_staff_usernames.sql');
  const counts = Object.fromEntries(ok.result.reconcile.checks.filter(item => item.name.startsWith('row_count:'))
    .map(item => [item.name.slice(10), item.observed - JSON.parse(fs.readFileSync(baseline, 'utf8')).rowCounts.start[item.name.slice(10)]]));
  assert.deepEqual(counts, { rolesRows: 0, permissionsRows: 2, rolePermissionsRows: 4, staffUsersRows: 0, staffPermissionOverridesRows: 0 });

  const db = new DatabaseSync(file);
  db.exec("INSERT INTO permissions(key,description) VALUES('synthetic.extra','synthetic')");
  db.close();
  const receiptFile = receiptPath();
  const refused = await cli(file, ['--reconcile', '--receipt', receiptFile, '--baseline-receipt', baseline, ...rehearsalArgs]);
  assert.equal(refused.result.status, 'reconciliation-required');
  assert.equal(refused.result.stop.code, 'reconciliation_required:row_counts_differ');
  const receipt = readReceipt(receiptFile);
  assert.match(receipt.stop.detail, /counts differ: permissionsRows \(expected \d+, observed \d+\)$/u);
  assert.deepEqual(receipt.reconcile.checks.filter(item => item.name.startsWith('row_count:') && !item.ok).map(item => item.name),
    ['row_count:permissionsRows']);
  const resumed = await cli(file, [...execArgs(receiptPath()), '--resume-from', '0241_staff_usernames.sql', '--baseline-receipt', baseline]);
  assert.equal(resumed.result.status, 'reconciliation-required');
  assert.equal(resumed.provider.calls.writes, 0);
});

test('a baseline receipt for another plan or target is refused', async () => {
  const file = freshDb();
  applyPrefix(file, 2);
  const other = receiptPath();
  fs.writeFileSync(other, JSON.stringify({ ...JSON.parse(fs.readFileSync(baselineFor(2), 'utf8')), planSha256: 'f'.repeat(64) }));
  const { result } = await cli(file, ['--reconcile', '--baseline-receipt', other, ...rehearsalArgs]);
  assert.equal(result.status, 'reconciliation-required');
  assert.deepEqual(result.stop, { step: null, phase: 'baseline-receipt', code: 'ops_0227_0244:baseline_receipt_invalid' });
  assert.throws(() => parseOps0227To0244Args(['--dry-run', '--baseline-receipt', other, ...rehearsalArgs]), /baseline_receipt_invalid/u);
});

// --- N5: the baseline must be the latest receipt; seeded rows are rechecked ---

test('an older receipt cannot bypass a later post-check failure', async () => {
  const file = freshDb();
  const firstReceipt = receiptPath();
  const first = await cli(file, execArgs(firstReceipt), { providerOptions: { ambiguousAt: '0229_owner_intel_source_feed.sql', landed: false } });
  assert.equal(first.result.status, 'reconciliation-required');
  const secondReceipt = receiptPath();
  const second = await cli(file, [...execArgs(secondReceipt), '--resume-from', '0229_owner_intel_source_feed.sql', '--baseline-receipt', firstReceipt],
    { providerOptions: { tamper: (snapshot, calls) => calls.writes >= 3
      ? { ...snapshot, probes: { ...snapshot.probes, staffUsersRows: snapshot.probes.staffUsersRows + 1 } } : snapshot } });
  assert.equal(second.result.stop.code, 'reconciliation_required:postcheck_failed');
  assert.equal(second.result.stop.step, '0231_owner_google_ads_summary.sql');
  assert.deepEqual(readReceipt(secondReceipt).finalLedger.count, 231, 'the receipt records the observed post-write ledger');
  // Reusing the older receipt is refused: it does not describe the current ledger.
  const stale = await cli(file, ['--reconcile', '--baseline-receipt', firstReceipt, ...rehearsalArgs]);
  assert.equal(stale.result.stop.code, 'reconciliation_required:baseline_receipt_not_latest');
  assert.match(stale.result.stop.detail, /the baseline receipt recorded 228 rows ending 0228_competitor_intel_ingest\.sql/u);
  const resumed = await cli(file, [...execArgs(receiptPath()), '--resume-from', '0240_flight_logs_permissions.sql', '--baseline-receipt', firstReceipt]);
  assert.equal(resumed.result.status, 'reconciliation-required');
  assert.equal(resumed.provider.calls.writes, 0);
  // The latest receipt is refused too, because its run failed a post-check.
  const latest = await cli(file, ['--reconcile', '--baseline-receipt', secondReceipt, ...rehearsalArgs]);
  assert.equal(latest.result.stop.code, 'reconciliation_required:baseline_receipt_postcheck_failed');
});

test('reconcile rechecks the seeded rows of recorded files (controls and the 0244 catalog)', async () => {
  const file = freshDb();
  applyPrefix(file, 10);
  const ok = await cli(file, ['--reconcile', '--baseline-receipt', baselineFor(10), ...rehearsalArgs]);
  assert.equal(ok.result.status, 'reconciled');
  assert.deepEqual(ok.result.reconcile.checks.filter(item => item.name.startsWith('recorded_seed_rows:'))
    .map(item => [item.name.slice(19), item.observed]), [
    ['owner_intel_control', 1], ['owner_intel_source_control', 1], ['app_release_control', 1],
    ['owner_intel_google_ads_control', 1], ['staff_operations_access_catalog', 15],
  ]);
  for (const [table, value] of [['staff_operations_access_catalog', 14], ['owner_intel_source_control', 0]]) {
    const refused = await cli(file, ['--reconcile', '--baseline-receipt', baselineFor(10), ...rehearsalArgs], { providerOptions: {
      tamper: snapshot => (table in snapshot.tableRows ? { ...snapshot, tableRows: { ...snapshot.tableRows, [table]: value } } : snapshot) } });
    assert.equal(refused.result.status, 'reconciliation-required');
    assert.equal(refused.result.stop.code, `reconciliation_required:recorded_seed_rows:${table}`);
  }
});

// --- N7: objects outside the plan are pinned at the start -------------------

test('ambiguous at file k (not landed), resumed post-check fails on file k, reconcile with the older receipt is refused', async () => {
  const file = freshDb();
  const name = '0229_owner_intel_source_feed.sql';
  const firstReceipt = receiptPath();
  const first = await cli(file, execArgs(firstReceipt), { providerOptions: { ambiguousAt: name, landed: false } });
  assert.equal(first.result.stop.code, 'reconciliation_required:apply_ambiguous_no_retry');
  assert.equal(ledgerOf(file).length, 228);
  const firstExisting = readReceipt(firstReceipt).existingSchema;
  assert.ok(firstExisting.objectCount > 2000 && /^[a-f0-9]{64}$/u.test(firstExisting.sha256));

  // The resumed run applies file k, but the batch also changes an object outside the plan.
  const secondReceipt = receiptPath();
  const second = await cli(file, [...execArgs(secondReceipt), '--resume-from', name, '--baseline-receipt', firstReceipt],
    { providerOptions: { sideEffectAt: { name, sql: 'CREATE INDEX synthetic_outside_plan ON roles(name)' } } });
  assert.equal(second.result.stop.code, 'reconciliation_required:postcheck_failed');
  assert.equal(second.result.stop.step, name);
  assert.deepEqual(readReceipt(secondReceipt).existingSchema, firstExisting, 'start digest carried forward');
  assert.equal(ledgerOf(file).length, 229);

  // The older receipt's ambiguity allowance matches 229 ending at file k, but the outside-plan digest does not.
  const receiptFile = receiptPath();
  const stale = await cli(file, ['--reconcile', '--receipt', receiptFile, '--baseline-receipt', firstReceipt, ...rehearsalArgs]);
  assert.equal(stale.result.status, 'reconciliation-required');
  assert.equal(stale.result.stop.code, 'reconciliation_required:existing_schema_changed');
  assert.match(readReceipt(receiptFile).stop.detail, /objects outside the plan changed: expected \d+ \([a-f0-9]{64}\), observed \d+/u);
  const resumed = await cli(file, [...execArgs(receiptPath()), '--resume-from', '0230_app_release_pilot.sql', '--baseline-receipt', firstReceipt]);
  assert.equal(resumed.result.status, 'reconciliation-required');
  assert.equal(resumed.provider.calls.writes, 0);
  const latest = await cli(file, ['--reconcile', '--baseline-receipt', secondReceipt, ...rehearsalArgs]);
  assert.equal(latest.result.stop.code, 'reconciliation_required:baseline_receipt_postcheck_failed');
});

test('a change to an existing object between runs is refused as existing_schema_changed', async () => {
  const file = freshDb();
  applyPrefix(file, 4);
  const baseline = baselineFor(4);
  assert.equal((await cli(file, ['--reconcile', '--baseline-receipt', baseline, ...rehearsalArgs])).result.status, 'reconciled');
  const db = new DatabaseSync(file);
  db.exec('CREATE INDEX synthetic_outside_plan ON roles(name)');
  db.close();
  const refused = await cli(file, [...execArgs(receiptPath()), '--resume-from', '0231_owner_google_ads_summary.sql', '--baseline-receipt', baseline]);
  assert.equal(refused.result.status, 'reconciliation-required');
  assert.equal(refused.result.stop.code, 'reconciliation_required:existing_schema_changed');
  assert.equal(refused.provider.calls.writes, 0);
});

// --- Approved production schema precondition --------------------------------

const PRODUCTION_ARGS = ['--account-id', OPS_PRODUCTION_DATABASE.accountId, '--database-id', OPS_PRODUCTION_DATABASE.databaseId,
  '--database-name', OPS_PRODUCTION_DATABASE.databaseName];
const productionExec = (receiptFile, ...extra) => ['--execute', '--receipt', receiptFile, '--approval-ref', 'approval-synthetic', ...extra, ...PRODUCTION_ARGS];
const SOURCE_OK = { sourceCheck: async () => 'f'.repeat(40) };

function existingSchemaOf(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try { return ops0227To0244ExistingSchema({ schema: db.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all() }, loadVerifiedOps0227To0244Plan()); }
  finally { db.close(); }
}
function sqlOn(file, sql) { const db = new DatabaseSync(file); try { db.exec(sql); } finally { db.close(); } }

test('the approved production schema is the pinned installed-schema observation, not the source-built schema', () => {
  assert.deepEqual({ ...OPS_PRODUCTION_EXISTING_SCHEMA },
    { objectCount: 2472, sha256: 'b05eb4958761549c7112518856970c010fe408dfb355d40d262595e012ab4e9b' });
  assert.ok(Object.isFrozen(OPS_PRODUCTION_EXISTING_SCHEMA));
  const profile = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts/production-auto-migration-profile/installed-schema-preservation-v1/profile.json'), 'utf8'));
  assert.equal(profile.databases.operations.databaseId, OPS_PRODUCTION_DATABASE.databaseId);
  assert.equal(profile.databases.operations.schema.objectCount, OPS_PRODUCTION_EXISTING_SCHEMA.objectCount);
  assert.notDeepEqual(existingSchemaOf(chains[226]), { ...OPS_PRODUCTION_EXISTING_SCHEMA });
});

test('production refuses an unapproved schema in every mode with zero writes and no confirmation prompt', async () => {
  const observed = existingSchemaOf(chains[226]);
  const noConfirm = async () => { throw new Error('a refused run must not ask for confirmation'); };
  for (const [args, status, code] of [
    [receipt => ['--receipt', receipt, ...PRODUCTION_ARGS], 'stopped', 'approved_existing_schema_mismatch'],
    [receipt => productionExec(receipt), 'refused', 'approved_existing_schema_mismatch'],
    [receipt => ['--reconcile', '--receipt', receipt, ...PRODUCTION_ARGS], 'reconciliation-required',
      'reconciliation_required:approved_existing_schema_mismatch'],
  ]) {
    const file = freshDb(), before = fs.readFileSync(file), receiptFile = receiptPath();
    const { result, provider } = await cli(file, args(receiptFile), { confirm: noConfirm, extra: SOURCE_OK });
    assert.equal(result.status, status);
    assert.equal(provider.calls.writes, 0);
    assert.ok(fs.readFileSync(file).equals(before), 'database bytes unchanged');
    const receipt = readReceipt(receiptFile);
    assert.equal(receipt.stop.code, code);
    assert.equal(receipt.writesPerformed, 0);
    assert.deepEqual(receipt.approvedExistingSchema, { expected: { ...OPS_PRODUCTION_EXISTING_SCHEMA }, observed, ok: false });
    assert.ok(receipt.stop.detail.includes(observed.sha256) && receipt.stop.detail.includes(OPS_PRODUCTION_EXISTING_SCHEMA.sha256));
  }
});

test('production is identified by its database id, and the approved schema cannot be overridden there', async () => {
  const plan = loadVerifiedOps0227To0244Plan(), file = freshDb();
  for (const environment of ['production', 'non-production', undefined]) {
    const provider = sqliteProvider(file), receipt = openOps0227To0244Receipt(receiptPath());
    try {
      const target = { ...OPS_PRODUCTION_DATABASE, environment };
      const result = await runOps0227To0244Ordered({ plan, provider, mode: 'execute', target, receipt });
      assert.equal(result.stop.code, 'approved_existing_schema_mismatch');
      await assert.rejects(runOps0227To0244Ordered({ plan, provider, mode: 'execute', target, receipt, approvedExistingSchema: existingSchemaOf(file) }),
        /approved_existing_schema_override_refused/u);
      await assert.rejects(runOps0227To0244Ordered({ plan, provider, mode: 'execute', receipt }), /target_required/u);
      assert.equal(provider.calls.writes, 0);
    } finally { receipt.close(); provider.close(); }
  }
  await assert.rejects(cli(file, productionExec(receiptPath()), { extra: { ...SOURCE_OK, approvedExistingSchema: existingSchemaOf(file) } }),
    /approved_existing_schema_override_refused/u);
  for (const bad of [{}, { objectCount: 1, sha256: 'x' }, { ...existingSchemaOf(file), extra: 1 }]) {
    await assert.rejects(cli(file, execArgs(receiptPath()), { extra: { approvedExistingSchema: bad } }), /approved_existing_schema_override_refused/u);
  }
  assert.equal(ledgerOf(file).length, 226);
});

test('an approved schema applies 226 -> 236 and the receipt records the match', async () => {
  const file = freshDb(), approvedExistingSchema = existingSchemaOf(file), receiptFile = receiptPath();
  const { result, provider } = await cli(file, execArgs(receiptFile), { extra: { approvedExistingSchema } });
  assert.equal(result.status, 'complete');
  assert.equal(provider.calls.writes, 10);
  const receipt = readReceipt(receiptFile);
  assert.deepEqual(receipt.approvedExistingSchema, { expected: approvedExistingSchema, observed: approvedExistingSchema, ok: true });
  assert.ok(receipt.steps.every(step => step.preflight.checks.some(item => item.name === 'approved_existing_schema' && item.ok)));
  assert.deepEqual(existingSchemaOf(file), approvedExistingSchema);
});

test('every kind of drift in the existing schema is refused before the first write', async () => {
  for (const sql of ['CREATE TABLE unapproved_extra(x INTEGER)', 'DROP VIEW native_directory_existing_import_live_reviews',
    'DROP TRIGGER native_staff_lifecycle_fence_insert']) {
    const file = freshDb(), approvedExistingSchema = existingSchemaOf(file);
    sqlOn(file, sql);
    const { result, provider } = await cli(file, execArgs(receiptPath()), { extra: { approvedExistingSchema } });
    assert.equal(result.status, 'refused', sql);
    assert.equal(result.stop.code, 'approved_existing_schema_mismatch');
    assert.equal(provider.calls.writes, 0);
  }
  // A one-character change in one definition, same object count.
  const file = freshDb(), approvedExistingSchema = existingSchemaOf(file);
  const { result, provider } = await cli(file, execArgs(receiptPath()), { extra: { approvedExistingSchema }, providerOptions: {
    tamper: snapshot => ({ ...snapshot, schema: snapshot.schema.map((row, index) => index === 0 ? { ...row, sql: `${row.sql} ` } : row) }) } });
  assert.equal(result.stop.code, 'approved_existing_schema_mismatch');
  assert.equal(result.approvedExistingSchema.observed.objectCount, approvedExistingSchema.objectCount);
  assert.equal(provider.calls.writes, 0);
});

test('drift after the confirmation stops before the first write; drift between files stops before the next one', async () => {
  const file = freshDb(), approvedExistingSchema = existingSchemaOf(file);
  const late = await cli(file, execArgs(receiptPath()), { extra: { approvedExistingSchema },
    confirm: async () => { sqlOn(file, 'CREATE TABLE unapproved_late(x INTEGER)'); return true; } });
  assert.equal(late.result.stop.code, 'approved_existing_schema_mismatch');
  assert.equal(late.provider.calls.writes, 0);

  const between = freshDb();
  // Reads: dry run, execute start, after file 1, before file 2.
  const { result, provider } = await cli(between, execArgs(receiptPath()), { extra: { approvedExistingSchema: existingSchemaOf(between) },
    providerOptions: { tamper: (snapshot, calls) => calls.reads === 4
      ? { ...snapshot, schema: [...snapshot.schema, { type: 'view', name: 'zz_unapproved', tbl_name: 'zz_unapproved', sql: 'CREATE VIEW zz_unapproved AS SELECT 1' }] }
      : snapshot } });
  assert.equal(result.stop.phase, 'preflight');
  assert.equal(result.stop.code, 'preflight_failed:approved_existing_schema');
  assert.equal(provider.calls.writes, 1);
});

test('reconcile and resume re-prove the approved schema, and a receipt cannot introduce another baseline', async () => {
  const file = freshDb(), approvedExistingSchema = existingSchemaOf(file), extra = { approvedExistingSchema }, firstReceipt = receiptPath();
  const next = '0230_app_release_pilot.sql';
  const first = await cli(file, execArgs(firstReceipt), { extra, providerOptions: { ambiguousAt: '0229_owner_intel_source_feed.sql', landed: true } });
  assert.equal(first.result.status, 'reconciliation-required');

  // Drift plus a receipt rewritten to agree with it: the receipt's own baseline check would pass, the approved one does not.
  const drifted = freshDb();
  fs.copyFileSync(file, drifted);
  sqlOn(drifted, 'CREATE TABLE unapproved_extra(x INTEGER)');
  const forged = receiptPath();
  fs.writeFileSync(forged, JSON.stringify({ ...readReceipt(firstReceipt), existingSchema: existingSchemaOf(drifted) }));
  const unpinned = await cli(drifted, ['--reconcile', '--baseline-receipt', forged, ...rehearsalArgs]);
  assert.equal(unpinned.result.status, 'reconciled', 'without the approved schema the forged receipt is accepted');
  for (const args of [['--reconcile', '--baseline-receipt', forged, ...rehearsalArgs],
    [...execArgs(receiptPath()), '--resume-from', next, '--baseline-receipt', forged]]) {
    const { result, provider } = await cli(drifted, args, { extra });
    assert.equal(result.status, 'reconciliation-required');
    assert.equal(result.stop.code, 'reconciliation_required:approved_existing_schema_mismatch');
    assert.equal(provider.calls.writes, 0);
  }
  // On production the receipt itself is refused unless it holds exactly the approved schema.
  const plan = loadVerifiedOps0227To0244Plan(), productionReceipt = receiptPath();
  const write = existingSchema => fs.writeFileSync(productionReceipt, JSON.stringify({ ...readReceipt(firstReceipt), target: { ...OPS_PRODUCTION_DATABASE }, existingSchema }));
  write(approvedExistingSchema);
  assert.throws(() => loadOps0227To0244BaselineReceipt(productionReceipt, { plan, target: OPS_PRODUCTION_DATABASE }), /baseline_receipt_existing_schema_not_approved/u);
  let provider;
  for (const args of [['--reconcile', '--baseline-receipt', productionReceipt, ...PRODUCTION_ARGS],
    productionExec(receiptPath(), '--resume-from', next, '--baseline-receipt', productionReceipt)]) {
    const refused = await cli(file, args, { extra: SOURCE_OK });
    ({ provider } = refused);
    assert.equal(refused.result.stop.code, 'ops_0227_0244:baseline_receipt_existing_schema_not_approved');
    assert.equal(provider.calls.writes, 0);
  }
  write({ ...OPS_PRODUCTION_EXISTING_SCHEMA });
  const loaded = loadOps0227To0244BaselineReceipt(productionReceipt, { plan, target: OPS_PRODUCTION_DATABASE });
  assert.deepEqual({ ...loaded.existingSchema }, { ...OPS_PRODUCTION_EXISTING_SCHEMA });
  // The right receipt does not excuse an unapproved live schema.
  const live = await cli(file, productionExec(receiptPath(), '--resume-from', next, '--baseline-receipt', productionReceipt), { extra: SOURCE_OK });
  assert.equal(live.result.stop.code, 'reconciliation_required:approved_existing_schema_mismatch');
  assert.equal(live.provider.calls.writes, 0);

  const resumeReceipt = receiptPath();
  const resumed = await cli(file, [...execArgs(resumeReceipt), '--resume-from', next, '--baseline-receipt', firstReceipt], { extra });
  assert.equal(resumed.result.status, 'complete');
  assert.equal(readReceipt(resumeReceipt).approvedExistingSchema.ok, true);
});

// The exact production-shaped store holds raw production definitions, so it is never committed.
// --- The real command and the real provider, answered from a local SQLite file -------

/** Starts the real command as a child process. Cloudflare requests are answered from `file`; writes are refused there. */
function realCommand(file, args, databaseName, extraEnv = {}, fileBlocks = 0) {
  const log = path.join(tmp, `network-${++counter}.log`);
  fs.writeFileSync(log, '');
  const env = { ...TOKEN_ENV, OPS_TEST_NETWORK_LOG: log, OPS_TEST_D1_SQLITE: file, OPS_TEST_D1_NAME: databaseName, ...extraEnv };
  for (const key of ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE']) if (process.env[key]) env[key] = process.env[key];
  const command = [process.execPath, '--import', pathToFileURL(path.join(ROOT, 'scripts/production-ops-0227-0244-cli-test-preload.mjs')).href,
    path.join(ROOT, 'scripts/production-ops-0227-0244-ordered-once.mjs'), ...args];
  const limited = fileBlocks ? ['/bin/sh', '-c', `trap '' XFSZ; ulimit -f ${fileBlocks}; exec "$@"`, 'sh', ...command] : command;
  const child = spawnSync(limited[0], limited.slice(1), {
    cwd: ROOT, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
  assert.equal(child.error, undefined);
  const network = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  assert.ok(network.every(entry => ['fetch', 'read'].includes(entry.kind) || entry.kind.startsWith('receipt-')), 'only answered reads: no socket and no write batch');
  return { status: child.status, stdout: child.stdout, stderr: child.stderr, reads: network.filter(entry => entry.kind === 'read').length,
    last: child.stdout.trim().split('\n').at(-1) };
}

test('real command: dry run and reconcile complete through the real provider; execute refuses without a terminal', () => {
  const file = freshDb(), before = fs.readFileSync(file);
  const dryReceipt = receiptPath();
  const dry = realCommand(file, [...rehearsalArgs, '--receipt', dryReceipt], REHEARSAL.databaseName);
  assert.deepEqual([dry.status, dry.stderr, dry.reads], [0, '', 1]);
  assert.equal(dry.stdout.split('\n').filter(line => line.startsWith('dry-run ok: ')).length, 10);
  assert.deepEqual(JSON.parse(dry.last), { status: 'dry-run-passed', mode: 'dry-run', stop: null, nextStep: OPS_0227_0244_ORDERED_NAMES[0],
    finalLedger: { ...OPS_0227_0244_PRIOR_LEDGER }, writesPerformed: 0 });
  assert.equal(readReceipt(dryReceipt).status, 'dry-run-passed');

  const reconciled = realCommand(file, ['--reconcile', ...rehearsalArgs], REHEARSAL.databaseName);
  assert.deepEqual([reconciled.status, reconciled.stderr, JSON.parse(reconciled.last).status], [0, '', 'reconciled']);

  const execReceipt = receiptPath();
  const executed = realCommand(file, execArgs(execReceipt), REHEARSAL.databaseName);
  assert.deepEqual([executed.status, executed.stderr], [1, 'ops_0227_0244:interactive_confirmation_required\n']);
  assert.deepEqual([readReceipt(execReceipt).status, readReceipt(execReceipt).stop.code, readReceipt(execReceipt).writesPerformed],
    ['refused', 'ops_0227_0244:interactive_confirmation_required', 0]);
  assert.ok(fs.readFileSync(file).equals(before), 'database bytes unchanged');
});

test('real command on the production ids: a source-built schema is refused with a written receipt and exit 1', () => {
  const file = freshDb();
  for (const mode of [[], ['--reconcile']]) {
    const receiptFile = receiptPath();
    const run = realCommand(file, [...mode, ...PRODUCTION_ARGS, '--receipt', receiptFile], OPS_PRODUCTION_DATABASE.databaseName);
    assert.deepEqual([run.status, run.stderr, run.reads], [1, '', 1]);
    const receipt = readReceipt(receiptFile);
    assert.match(receipt.stop.code, /approved_existing_schema_mismatch$/u);
    assert.equal(receipt.approvedExistingSchema.ok, false);
    assert.equal(receipt.writesPerformed, 0);
  }
  const wrongName = realCommand(file, PRODUCTION_ARGS, 'another-name');
  assert.deepEqual([wrongName.status, wrongName.stderr, wrongName.reads], [1, 'ops_0227_0244_provider:target_mismatch\n', 0]);
});

test('a run that cannot save its receipt stops at once and is never reported as a success', async () => {
  // Every receipt write of a full execute run fails once, in turn.
  const total = { writes: 0 };
  const attempt = async failAt => {
    const provider = sqliteProvider(freshDb());
    const calls = { write: 0, close: 0 };
    let applied = 0;
    const result = await mainOps0227To0244(execArgs(path.join(tmp, 'not-used.json')), { env: TOKEN_ENV, out: () => {},
      openReceipt: () => ({ write() { if (++calls.write === failAt) { applied = provider.calls.writes; throw new Error('synthetic disk failure'); } }, close() { calls.close++; } }),
      providerFactory: () => provider, confirm: async () => true });
    const sent = provider.calls.writes, reads = provider.calls.reads;
    provider.close();
    return { result, calls, sent, reads, applied };
  };
  const clean = await attempt(0);
  assert.equal(clean.result.status, 'complete');
  assert.equal(clean.result.receiptFailure, undefined);
  total.writes = clean.calls.write;
  assert.equal(total.writes, 23);
  const seen = new Set();
  for (let failAt = 1; failAt <= total.writes; failAt++) {
    const { result, calls, sent, applied } = await attempt(failAt);
    assert.deepEqual(calls, { write: failAt, close: 1 }, 'no second receipt write');
    assert.equal(sent, applied, 'nothing is sent after the failure');
    assert.equal(result.receiptFailure, 'ops_0227_0244:receipt_write_failed');
    assert.equal(result.writesPerformed, sent);
    assert.equal(result.stop.phase, 'receipt');
    assert.deepEqual([result.status, result.stop.code], sent > 0
      ? ['reconciliation-required', 'reconciliation_required:receipt_write_failed'] : ['stopped', 'receipt_write_failed']);
    seen.add(sent);
  }
  assert.deepEqual([...seen], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 'before the first file, after each file, and after the last');

  // A stop that came first keeps its own code.
  const provider = sqliteProvider(freshDb(), { ambiguousAt: OPS_0227_0244_ORDERED_NAMES[0], landed: true });
  let writes = 0;
  const ambiguous = await mainOps0227To0244(execArgs(path.join(tmp, 'not-used.json')), { env: TOKEN_ENV, out: () => {},
    openReceipt: () => ({ write(value) { writes++; if (value.stop) throw new Error('synthetic disk failure'); }, close() {} }),
    providerFactory: () => provider, confirm: async () => true });
  provider.close();
  assert.deepEqual([ambiguous.status, ambiguous.stop.code, ambiguous.receiptFailure, writes],
    ['reconciliation-required', 'reconciliation_required:apply_ambiguous_no_retry', 'ops_0227_0244:receipt_write_failed', 4]);

  // Dry run and reconcile: no write, and not a success.
  for (const mode of [[], ['--reconcile']]) for (const failAt of [1, 2]) {
    const readOnly = sqliteProvider(freshDb());
    let count = 0;
    const result = await mainOps0227To0244([...mode, '--receipt', path.join(tmp, 'not-used.json'), ...rehearsalArgs], { env: TOKEN_ENV, out: () => {},
      openReceipt: () => ({ write() { if (++count === failAt) throw new Error('synthetic disk failure'); }, close() {} }), providerFactory: () => readOnly });
    assert.deepEqual([result.status, result.stop.code, result.receiptFailure, readOnly.calls.writes],
      ['stopped', 'receipt_write_failed', 'ops_0227_0244:receipt_write_failed', 0]);
    readOnly.close();
  }
});

test('the receipt writer proves every byte, and never writes again after a failure', () => {
  const real = { writeSync: fs.writeSync, fsyncSync: fs.fsyncSync, readFileSync: fs.readFileSync, ftruncateSync: fs.ftruncateSync };
  const value = { text: 'x'.repeat(5000) }, bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  const disk = code => Object.assign(new Error('synthetic'), { code });
  const limited = (limit, end) => (fd, buffer, offset, length, position) => {
    const room = limit - position;
    return room > 0 ? real.writeSync(fd, buffer, offset, Math.min(length, room), position) : end();
  };
  const attempt = (patch, next = {}) => {
    const name = receiptPath(), receipt = openOps0227To0244Receipt(name);
    try {
      Object.assign(fs, patch(name));
      let error = null;
      try { receipt.write(value); } catch (caught) { error = caught; }
      Object.assign(fs, real);
      const after = fs.readFileSync(name);
      let again = null;
      try { receipt.write({ ...value, again: true }); } catch (caught) { again = caught; }
      if (error) assert.ok(fs.readFileSync(name).equals(after), 'a failed receipt is never written again');
      return { error, again, after };
    } finally { Object.assign(fs, real); receipt.close(); }
  };
  // Short writes that make progress end with the whole receipt.
  for (const patch of [() => ({}), () => ({ writeSync: (fd, b, o, n, p) => real.writeSync(fd, b, o, Math.min(n, 7), p) })]) {
    const { error, again, after } = attempt(patch);
    assert.deepEqual([error, again], [null, null]);
    assert.ok(after.equals(bytes));
  }
  const failures = {
    ENOSPC: () => ({ writeSync: limited(4096, () => { throw disk('ENOSPC'); }) }),
    EDQUOT: () => ({ writeSync: limited(4096, () => { throw disk('EDQUOT'); }) }),
    EFBIG: () => ({ writeSync: limited(0, () => { throw disk('EFBIG'); }) }),
    zero: () => ({ writeSync: limited(4096, () => 0) }),
    negative: () => ({ writeSync: () => -1 }),
    tooMany: () => ({ writeSync: (fd, b, o, n) => n + 1 }),
    notANumber: () => ({ writeSync: () => undefined }),
    lying: () => ({ writeSync: (fd, b, o, n) => n }),
    EIO: () => ({ fsyncSync: () => { throw disk('EIO'); } }),
    truncate: () => ({ ftruncateSync: () => { throw disk('EROFS'); } }),
    cutOff: name => ({ readFileSync: (file, ...rest) => (file === name ? real.readFileSync(file).subarray(0, 100) : real.readFileSync(file, ...rest)) }),
    changed: name => ({ readFileSync: (file, ...rest) => { const b = real.readFileSync(file, ...rest); if (file === name) b[20] ^= 1; return b; } }),
    unreadable: name => ({ readFileSync: (file, ...rest) => { if (file === name) throw disk('EACCES'); return real.readFileSync(file, ...rest); } }),
  };
  for (const [name, patch] of Object.entries(failures)) {
    const { error, again } = attempt(patch);
    assert.equal(error?.message, 'ops_0227_0244:receipt_write_failed', name);
    assert.ok(error.cause instanceof Error, name);
    if (/^E[A-Z]+$/u.test(name)) assert.equal(error.cause.code, name);
    assert.equal(again?.message, 'ops_0227_0244:receipt_write_failed', name);
  }
});

test('a settled refusal or cancelled run keeps its own code when its receipt cannot be written, and a result survives a failed close', async () => {
  const run = async (args, dependencies, { failWrite = true, failClose = false } = {}) => {
    const calls = { write: 0, close: 0 };
    const result = await mainOps0227To0244(args, { env: TOKEN_ENV, out: () => {}, ...dependencies, openReceipt: () => ({
      write() { calls.write++; if (failWrite) throw new Error('synthetic disk failure'); },
      close() { calls.close++; if (failClose) throw new Error('synthetic close failure'); } }) });
    return { result, calls };
  };
  const name = path.join(tmp, 'not-used.json'), empty = path.join(tmp, 'empty-root');
  fs.mkdirSync(empty, { recursive: true });
  const using = async (file, body) => { const provider = sqliteProvider(file); try { return await body(provider); } finally { provider.close(); } };
  const expectRefusal = ({ result, calls }, status, code) => {
    assert.equal(result.status, status);
    if (code) assert.equal(result.stop.code, code);
    assert.equal(result.receiptFailure, 'ops_0227_0244:refusal_receipt_write_failed');
    assert.equal(result.writesPerformed, 0);
    assert.deepEqual(calls, { write: 1, close: 1 });
  };
  const local = await run(['--receipt', name, ...rehearsalArgs], { root: empty });
  expectRefusal(local, 'refused');
  assert.equal(local.result.stop.phase, 'local-verification');
  expectRefusal(await run(productionExec(name), { sourceCheck: async () => { throw new Error('production_ops_0226_runner_main_branch_stale'); } }),
    'refused', 'ops_0227_0244:source_check_failed:production_ops_0226_runner_main_branch_stale');
  await using(freshDb(), async provider => expectRefusal(await run(['--reconcile', '--baseline-receipt', path.join(tmp, 'missing.json'), '--receipt', name, ...rehearsalArgs],
    { providerFactory: () => provider }), 'reconciliation-required', 'ops_0227_0244:baseline_receipt_unreadable'));
  await using(freshDb(225), async provider => expectRefusal(await run(execArgs(name), { providerFactory: () => provider }), 'refused', 'prior_ledger_mismatch:ledger_count'));
  await using(freshDb(), async provider => expectRefusal(await run([...execArgs(name), '--resume-from', OPS_0227_0244_ORDERED_NAMES[2], '--baseline-receipt', baselineFor()],
    { providerFactory: () => provider }), 'reconciliation-required', 'reconciliation_required:resume_from_is_not_next_step'));
  await using(freshDb(), async provider => {
    expectRefusal(await run(execArgs(name), { providerFactory: () => provider, confirm: async () => false }), 'cancelled');
    assert.equal(provider.calls.writes, 0);
  });

  const closing = { failWrite: false, failClose: true };
  await using(freshDb(), async provider => {
    const { result, calls } = await run(['--receipt', name, ...rehearsalArgs], { providerFactory: () => provider }, closing);
    assert.deepEqual([result.status, result.receiptFailure, calls.close], ['dry-run-passed', 'ops_0227_0244:receipt_close_failed', 1]);
  });
  await using(freshDb(), async provider => {
    const { result, calls } = await run(execArgs(name), { providerFactory: () => provider, confirm: async () => true }, closing);
    assert.deepEqual([result.status, result.writesPerformed, result.receiptFailure, calls.close], ['complete', 10, 'ops_0227_0244:receipt_close_failed', 1]);
  });
});

test('real command: a receipt that cannot be saved or closed is exit 1 with its own line, even when the run passed', () => {
  const file = freshDb(), before = fs.readFileSync(file);
  const dry = fails => {
    const receiptFile = receiptPath();
    return { receiptFile, ...realCommand(file, [...rehearsalArgs, '--receipt', receiptFile], REHEARSAL.databaseName, { OPS_TEST_RECEIPT_FAILS: fails }) };
  };
  for (const fails of ['enospc:4096', 'edquot:4096', 'zero:4096', 'fsync', 'readback', 'write']) {
    const run = dry(fails);
    assert.deepEqual([run.status, run.stderr], [1, 'ops_0227_0244:receipt_write_failed\n'], fails);
    const summary = JSON.parse(run.last);
    assert.deepEqual([summary.status, summary.stop.phase, summary.stop.code, summary.writesPerformed], ['stopped', 'receipt', 'receipt_write_failed', 0], fails);
    if (/:/u.test(fails)) assert.ok(fs.statSync(run.receiptFile).size <= 4096, fails);
  }
  const short = dry('short');
  assert.deepEqual([short.status, short.stderr, JSON.parse(short.last).status, readReceipt(short.receiptFile).status], [0, '', 'dry-run-passed', 'dry-run-passed']);
  const closing = dry('close');
  assert.deepEqual([closing.status, closing.stderr, JSON.parse(closing.last).status, readReceipt(closing.receiptFile).status],
    [1, 'ops_0227_0244:receipt_close_failed\n', 'dry-run-passed', 'dry-run-passed']);
  assert.ok(fs.readFileSync(file).equals(before), 'database bytes unchanged');
});

test('real command: an operating system file-size limit is a failed receipt, not a success', {
  skip: process.platform === 'win32' && 'a per-process file-size limit needs a POSIX shell' }, () => {
  const receiptFile = receiptPath();
  // dash counts 512-byte blocks: 4096 bytes. The receipt of a dry run is larger.
  const run = realCommand(freshDb(), [...rehearsalArgs, '--receipt', receiptFile], REHEARSAL.databaseName, {}, 8);
  assert.deepEqual([run.status, run.stderr, JSON.parse(run.last).stop.code], [1, 'ops_0227_0244:receipt_write_failed\n', 'receipt_write_failed']);
  assert.ok(fs.statSync(receiptFile).size <= 4096);
});

test('an unexpected error after the run has written its receipt leaves that receipt as it is', async () => {
  const provider = sqliteProvider(freshDb());
  const receiptFile = receiptPath();
  await assert.rejects(mainOps0227To0244(execArgs(receiptFile), { env: TOKEN_ENV, providerFactory: () => provider, confirm: async () => true,
    out: line => { if (line.startsWith('applied and verified: ')) throw new Error('synthetic output failure'); } }), /synthetic output failure/u);
  provider.close();
  const receipt = readReceipt(receiptFile);
  assert.deepEqual([receipt.status, receipt.stop, receipt.writesPerformed, receipt.steps.at(-1).apply.outcome], ['running', null, 1, 'acknowledged']);
});

test('a failing receipt never replaces the error that stopped the run', async () => {
  const attempt = async ({ throwing, failWrite = false, failClose = false }) => {
    const calls = { write: 0, close: 0 };
    const opened = {
      write() { calls.write++; if (failWrite) throw new Error('synthetic disk failure'); },
      close() { calls.close++; if (failClose) throw new Error('synthetic close failure'); },
    };
    let caught;
    await mainOps0227To0244(['--receipt', path.join(tmp, 'not-used.json'), ...rehearsalArgs], { env: TOKEN_ENV, out: () => {},
      openReceipt: () => opened, providerFactory: () => ({ async assertTarget() { throw throwing; } }) }).catch(error => { caught = error; });
    return { caught, calls };
  };
  const once = { write: 1, close: 1 };
  const refusal = () => new Error('ops_0227_0244_provider:target_mismatch');
  for (const [failure, expected] of [[{ failWrite: true }, 'ops_0227_0244:refusal_receipt_write_failed'],
    [{ failClose: true }, 'ops_0227_0244:receipt_close_failed'],
    [{ failWrite: true, failClose: true }, 'ops_0227_0244:refusal_receipt_write_failed'], [{}, undefined]]) {
    const throwing = refusal();
    const { caught, calls } = await attempt({ throwing, ...failure });
    assert.equal(caught, throwing, 'the original error object is rethrown');
    assert.equal(caught.message, 'ops_0227_0244_provider:target_mismatch');
    assert.equal(caught.receiptFailure, expected);
    assert.deepEqual(calls, once);
  }
  // An error that cannot carry the extra fact is wrapped with the same stable code and kept as the cause.
  const frozen = Object.freeze(refusal());
  const wrapped = (await attempt({ throwing: frozen, failWrite: true })).caught;
  assert.deepEqual([wrapped.message, wrapped.receiptFailure, wrapped.cause === frozen],
    ['ops_0227_0244_provider:target_mismatch', 'ops_0227_0244:refusal_receipt_write_failed', true]);

  // After the ordered run has written the receipt: no refusal write, and a failing close does not hide the first failure.
  const provider = sqliteProvider(freshDb());
  const late = { write: 0, close: 0 };
  const result = await mainOps0227To0244(execArgs(path.join(tmp, 'not-used-2.json')), { env: TOKEN_ENV, out: () => {},
    openReceipt: () => ({ write() { if (++late.write === 3) throw new Error('synthetic disk failure'); }, close() { late.close++; throw new Error('synthetic close failure'); } }),
    providerFactory: () => provider, confirm: async () => true });
  provider.close();
  assert.deepEqual([result.status, result.stop.code, result.receiptFailure], ['stopped', 'receipt_write_failed', 'ops_0227_0244:receipt_write_failed']);
  assert.deepEqual(late, { write: 3, close: 1 });
});

const PRODUCTION_SHAPED = process.env.OPS_0227_0244_PRODUCTION_SHAPED_SQLITE;
test('the exact production-shaped store passes as production: clean, interrupted and resumed; one missing object is refused', {
  skip: !PRODUCTION_SHAPED && 'set OPS_0227_0244_PRODUCTION_SHAPED_SQLITE to the private production-shaped 226 store' }, async () => {
  const copy = () => { const file = path.join(tmp, `db-${++counter}.sqlite`); fs.copyFileSync(PRODUCTION_SHAPED, file); return file; };
  const finalSchema = file => {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare(OPS_0227_0244_SCHEMA_ROWS_SQL).all();
      return { objectCount: rows.length, sha256: hash(JSON.stringify(rows.map(row => [row.type, row.name, row.tbl_name, row.sql]))) };
    } finally { db.close(); }
  };
  const expectedFinal = { objectCount: 2600, sha256: 'a966601e35a43d6835fcd23c9acdb7cdcbe05fa5ea5486f1f5289243fc2e89bc' };
  assert.deepEqual(existingSchemaOf(PRODUCTION_SHAPED), { ...OPS_PRODUCTION_EXISTING_SCHEMA });

  const dry = await cli(copy(), PRODUCTION_ARGS);
  assert.equal(dry.result.status, 'dry-run-passed');
  assert.equal(dry.provider.calls.writes, 0);
  assert.equal(dry.result.approvedExistingSchema.ok, true);

  const real = realCommand(copy(), PRODUCTION_ARGS, OPS_PRODUCTION_DATABASE.databaseName);
  assert.deepEqual([real.status, real.stderr, JSON.parse(real.last).status, real.reads], [0, '', 'dry-run-passed', 1]);

  const clean = copy();
  const applied = await cli(clean, productionExec(receiptPath()), { extra: SOURCE_OK });
  assert.equal(applied.result.status, 'complete');
  assert.deepEqual(existingSchemaOf(clean), { ...OPS_PRODUCTION_EXISTING_SCHEMA });
  assert.deepEqual(finalSchema(clean), expectedFinal);

  const interrupted = copy(), firstReceipt = receiptPath();
  const first = await cli(interrupted, productionExec(firstReceipt), { extra: SOURCE_OK, providerOptions: { ambiguousAt: '0230_app_release_pilot.sql', landed: true } });
  assert.equal(first.result.stop.code, 'reconciliation_required:apply_ambiguous_no_retry');
  const reconciled = await cli(interrupted, ['--reconcile', '--baseline-receipt', firstReceipt, ...PRODUCTION_ARGS]);
  assert.equal(reconciled.result.status, 'reconciled');
  const resumed = await cli(interrupted, productionExec(receiptPath(), '--resume-from', reconciled.result.reconcile.nextStep, '--baseline-receipt', firstReceipt), { extra: SOURCE_OK });
  assert.equal(resumed.result.status, 'complete');
  assert.deepEqual(finalSchema(interrupted), expectedFinal);

  const missing = copy();
  const db = new DatabaseSync(missing);
  try {
    const { name } = db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name GLOB 'production_native_*' ORDER BY name").get();
    db.exec('DROP TRIGGER ' + name);
  } finally { db.close(); }
  const refused = await cli(missing, productionExec(receiptPath()), { extra: SOURCE_OK });
  assert.equal(refused.result.stop.code, 'approved_existing_schema_mismatch');
  assert.equal(refused.result.approvedExistingSchema.observed.objectCount, 2471);
  assert.equal(refused.provider.calls.writes, 0);
});
