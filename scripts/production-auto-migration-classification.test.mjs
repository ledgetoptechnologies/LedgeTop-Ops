import test from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_MIGRATION_TARGET,
  readProductionMigrationReadiness,
  loadPinnedAppendOnlyMigrationProfile,
  restoreReviewedAppendOnlyProfileBytes,
  validateProductionMigrationReadiness,
  validateAppendOnlyMigrationReadiness,
} from './production-auto-migration-classification.mjs';
import { validateProductionMigrationAdmission } from './production-auto-migration-readiness.mjs';
import { APPROVED_SOURCE_COMMIT } from './production-auto-migration-profile/append-only-inventory-gate.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const ACCOUNT = PRODUCTION_MIGRATION_TARGET.accountId;
const profile = loadPinnedAppendOnlyMigrationProfile();
const manifestBytes = profile.reconciliationManifestBytes;
const appendPlanBytes = profile.appendPlanBytes;
const manifest = JSON.parse(manifestBytes.toString('utf8'));
const plan = JSON.parse(appendPlanBytes.toString('utf8'));
const baseRows = Object.fromEntries(Object.entries(manifest.databases).map(([app, db]) => [app, db.orderedRows]));
const fullRows = Object.fromEntries(Object.entries(baseRows).map(([app, rows]) => [
  app,
  [...rows, ...plan.apps[app].appendInExactSourceOrder.map(({ ledgerId, name }) => ({ id: ledgerId, name }))],
]));
assert.equal(execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), COMMIT);
assert.equal(manifest.source.commit, APPROVED_SOURCE_COMMIT);
assert.equal(manifest.actualReceipt.sourceCommit, 'c88011f7600e5f04dc96d5ab7ed1eacfa157c7c8');
assert.equal(plan.actualReceipt.sourceCommit, 'c88011f7600e5f04dc96d5ab7ed1eacfa157c7c8');
assert.equal(plan.sourceCommit, APPROVED_SOURCE_COMMIT);

const strictSourceRows = Object.fromEntries(Object.entries(manifest.databases).map(([app, db]) => [
  app, db.sourceMigrations.map(({ name }, index) => ({ name, id: index + 1 })),
]));

function fakeProvider(rowsByApp, options = {}) {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    const app = String(url).includes(PRODUCTION_MIGRATION_TARGET.databases[0].databaseId) ? 'operations' : 'client';
    const payload = {
      success: true, errors: [], result: [{ success: true, errors: [], results: rowsByApp[app],
        meta: options.meta ?? { changes: 0, rows_written: 0, changed_db: false } }],
    };
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchImpl, get calls() { return calls; } };
}
const args = (fetchImpl, extra = {}) => ({
  sourceCommit: COMMIT,
  root,
  token: 'synthetic-token-for-local-test-only',
  env: {},
  fetchImpl,
  now: () => new Date('2026-10-27T12:00:00.000Z'),
  monotonicNow: (() => { let n = 100; return () => n++; })(),
  ...extra,
});

test('base inventories are explicitly migration-required and never v1 ready', async () => {
  const provider = fakeProvider(baseRows);
  const result = await readProductionMigrationReadiness(args(provider.fetchImpl, { appendOnlyProfile: profile }));
  assert.equal(provider.calls, 2);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.status, 'migration-required');
  assert.equal(result.migrationRequired, true);
  assert.equal(result.applicationSchemaReady, false);
  assert.equal(result.executesDdl, false);
  assert.equal(result.authorizesFeatureActivation, false);
  for (const row of result.databases) {
    assert.equal(row.status, 'preserved-base-awaiting-entire-approved-append');
    assert.ok(row.appendEnvelope.length > 0);
  }
  assert.throws(() => validateProductionMigrationReadiness(result, { sourceCommit: COMMIT }),
    { code: 'migration_readiness_invalid' });
});

test('fully appended inventories are classified but schema readiness remains separate', async () => {
  const provider = fakeProvider(fullRows);
  const result = await readProductionMigrationReadiness(args(provider.fetchImpl, { appendOnlyProfile: profile }));
  assert.equal(provider.calls, 2);
  assert.equal(result.status, 'inventory-current-schema-check-required');
  assert.equal(result.migrationRequired, false);
  assert.equal(result.applicationSchemaReady, false);
  assert.deepEqual(result.databases.map((row) => row.installedRowCount), [231, 162]);
  assert.ok(result.databases.every((row) => row.status === 'fully-appended-source-inventory' && row.appendEnvelope.length === 0));
  assert.deepEqual(validateAppendOnlyMigrationReadiness(result, {
    sourceCommit: COMMIT, now: Date.parse(result.observedAt), appendOnlyProfile: profile,
  }), result);
  const tamperedCases = [
    (copy) => { copy.databases[0].sourceInventorySha256 = '0'.repeat(64); },
    (copy) => { copy.databases[1].installedRowsSha256 = 'f'.repeat(64); },
    (copy) => { copy.databases[1].historicalRowsPreserved = []; },
  ];
  for (const tamper of tamperedCases) {
    const copy = structuredClone(result);
    tamper(copy);
    assert.throws(() => validateAppendOnlyMigrationReadiness(copy, {
      sourceCommit: COMMIT, now: Date.parse(result.observedAt), appendOnlyProfile: profile,
    }), { code: 'append_readiness_database_profile_mismatch' });
  }
  const baseResult = await readProductionMigrationReadiness(args(fakeProvider(baseRows).fetchImpl, { appendOnlyProfile: profile }));
  for (const alter of [
    (copy) => { copy.databases[0].appendEnvelope[0].name = '0222_unreviewed.sql'; },
    (copy) => { copy.databases[0].appendEnvelope[0].sha256 = 'a'.repeat(64); },
  ]) {
    const copy = structuredClone(baseResult);
    alter(copy);
    assert.throws(() => validateAppendOnlyMigrationReadiness(copy, {
      sourceCommit: COMMIT, now: Date.parse(baseResult.observedAt), appendOnlyProfile: profile,
    }), { code: 'append_readiness_database_profile_mismatch' });
  }
});

test('runtime admission keeps both inventory classifications held with distinct reasons', async () => {
  const base = await readProductionMigrationReadiness(args(fakeProvider(baseRows).fetchImpl, { appendOnlyProfile: profile }));
  assert.throws(() => validateProductionMigrationAdmission(base, { sourceCommit: COMMIT }),
    { code: 'migration_required_pending' });
  const full = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  assert.throws(() => validateProductionMigrationAdmission(full, { sourceCommit: COMMIT }),
    { code: 'migration_application_schema_confirmation_required' });
  const malformed = structuredClone(full);
  malformed.status = 'ready';
  assert.throws(() => validateProductionMigrationAdmission(malformed, { sourceCommit: COMMIT }),
    { code: 'migration_readiness_diagnostic_invalid' });
});

test('Operations release callsite holds a full inventory before CI or provider work', async () => {
  const diagnostic = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  const { createProductionAutoReleaseAdapter } = await import('./production-auto-runtime.mjs');
  let ciCalls = 0;
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1' };
  const runtime = createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: COMMIT, env,
    triggerRun: { sourceCommit: COMMIT, runId: 101, runAttempt: 1 },
    migrationReader: async ({ appendOnlyProfile }) => {
      assert.equal(appendOnlyProfile.appendPlanBytes.toString('utf8'), appendPlanBytes.toString('utf8'));
      return diagnostic;
    },
    ciFactory: () => ({ verify: async () => { ciCalls++; return { passed: true, runId: 101, runAttempt: 1 }; }, mainCommit: async () => COMMIT }),
    providerFactory: () => { assert.fail('provider work must not start while schema confirmation is required'); },
  });
  await assert.rejects(runtime.adapter.ciGate(), { code: 'migration_application_schema_confirmation_required' });
  assert.equal(ciCalls, 0);
});

test('Ops Sync release callsite preserves the full-inventory hold before readiness or provider work', async () => {
  const diagnostic = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  const { createProductionAutoSyncAdapter } = await import('./production-auto-sync-runtime.mjs');
  let otherCalls = 0;
  const unexpected = () => { otherCalls++; throw Error('unexpected downstream work'); };
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '102', GITHUB_RUN_ATTEMPT: '1', NATIVE_STAFF_CUTOVER_REVIEW_JSON: '{"synthetic":true}' };
  const runtime = createProductionAutoSyncAdapter({ sourceCommit: COMMIT,
    triggerRun: { sourceCommit: COMMIT, runId: 102, runAttempt: 1 }, env,
    migrationReader: async () => diagnostic,
    ciFactory: () => ({ verify: unexpected }), sourceReader: unexpected, readinessReader: unexpected,
    providerFactory: unexpected, journalFactory: unexpected, recipientLoader: unexpected,
    fetchImpl: unexpected, buildRunner: unexpected,
  });
  await assert.rejects(runtime.adapter.release(), (error) => error.code === 'migration_application_schema_confirmation_required');
  assert.equal(otherCalls, 0);
});

test('default legacy path remains strict and preserves its v1 response on full current inventory', async () => {
  const provider = fakeProvider(strictSourceRows);
  const result = await readProductionMigrationReadiness(args(provider.fetchImpl));
  assert.equal(provider.calls, 2);
  assert.equal(result.schemaVersion, 1);
  assert.deepEqual(Object.keys(result), ['schemaVersion', 'sourceCommit', 'accountId', 'observedAt', 'databases']);
  await assert.rejects(readProductionMigrationReadiness(args(fakeProvider(baseRows).fetchImpl)),
    { code: 'migration_ledger_count_mismatch' });
});

test('mixed database state reports only the base database append envelope', async () => {
  const provider = fakeProvider({ operations: fullRows.operations, client: baseRows.client });
  const result = await readProductionMigrationReadiness(args(provider.fetchImpl, { appendOnlyProfile: profile }));
  assert.equal(result.status, 'migration-required');
  assert.deepEqual(result.databases.map((row) => row.appendEnvelope.length), [0, 4]);
});

test('unknown, tampered, or stale append profile refuses before provider requests', async () => {
  const provider = fakeProvider(baseRows);
  await assert.rejects(readProductionMigrationReadiness(args(provider.fetchImpl, {
    appendOnlyProfile: { ...profile, unexpected: true },
  })), { code: 'append_profile_unapproved' });
  await assert.rejects(readProductionMigrationReadiness(args(provider.fetchImpl, {
    appendOnlyProfile: { ...profile, appendPlanBytes: Buffer.from(appendPlanBytes).fill(0) },
  })), { code: 'append_profile_unapproved' });
  await assert.rejects(readProductionMigrationReadiness(args(provider.fetchImpl, {
    sourceCommit: '0000000000000000000000000000000000000000', appendOnlyProfile: profile,
  })), { code: 'source_commit_mismatch' });
  assert.equal(provider.calls, 0);
  const fresh = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  assert.throws(() => validateAppendOnlyMigrationReadiness(fresh, {
    sourceCommit: COMMIT, now: Date.parse(fresh.observedAt) + 60_001, appendOnlyProfile: profile,
  }), { code: 'append_readiness_stale' });
});

test('pinned profile JSON hashes survive a fresh autocrlf Windows checkout', (t) => {
  const checkout = mkdtempSync(path.join(os.tmpdir(), 'migration-profile-lf-'));
  t.after(() => {
    const resolved = path.resolve(checkout);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith('migration-profile-lf-'));
    rmSync(resolved, { recursive: true, force: true });
  });
  const profileDirectory = path.join(checkout, 'scripts', 'production-auto-migration-profile');
  mkdirSync(profileDirectory, { recursive: true });
  writeFileSync(path.join(checkout, '.gitattributes'), readFileSync(path.join(root, '.gitattributes')));
  for (const name of ['reconciliation-manifest.json', 'append-plan.json']) {
    const source = path.join(root, 'scripts', 'production-auto-migration-profile', name);
    writeFileSync(path.join(profileDirectory, name), readFileSync(source));
  }
  execFileSync('git', ['-C', checkout, 'init', '-q']);
  execFileSync('git', ['-C', checkout, 'config', 'core.autocrlf', 'true']);
  execFileSync('git', ['-C', checkout, 'config', 'user.email', 'offline-test@example.invalid']);
  execFileSync('git', ['-C', checkout, 'config', 'user.name', 'Offline Test']);
  execFileSync('git', ['-C', checkout, 'add', '.']);
  execFileSync('git', ['-C', checkout, 'commit', '-qm', 'profile LF checkout fixture']);
  rmSync(path.join(profileDirectory, 'reconciliation-manifest.json'));
  rmSync(path.join(profileDirectory, 'append-plan.json'));
  execFileSync('git', ['-C', checkout, 'checkout-index', '--force', '--all']);
  const expected = {
    'reconciliation-manifest.json': '33f661636025c8432aa862b158703df9053f79ca7532813cea0e23cc3c181faa',
    'append-plan.json': '142ccefd193341dafb0796fa046ecd7f559d9ab6af6f70217f9a52043a16685d',
  };
  for (const [name, sha256] of Object.entries(expected)) {
    const checked = readFileSync(path.join(profileDirectory, name));
    assert.equal(checked.includes(0x0d), false);
    const canonicalReviewedBytes = restoreReviewedAppendOnlyProfileBytes(checked);
    assert.equal(createHash('sha256').update(canonicalReviewedBytes).digest('hex'), sha256);
    assert.match(execFileSync('git', ['-C', checkout, 'check-attr', 'eol', '--', `scripts/production-auto-migration-profile/${name}`],
      { encoding: 'utf8' }), /eol: lf\s*$/);
  }
});

test('partial, reordered, altered, and wrong-target ledgers are refused', async (t) => {
  for (const [label, rows] of [
    ['partial append', { operations: [...baseRows.operations, ...fullRows.operations.slice(baseRows.operations.length, -1)], client: fullRows.client }],
    ['reordered', { operations: [...baseRows.operations].reverse(), client: fullRows.client }],
    ['altered name', { operations: baseRows.operations.map((row, index) => index === 10 ? { ...row, name: '0000_tampered.sql' } : row), client: fullRows.client }],
    ['noncontiguous append ID', { operations: fullRows.operations.map((row, index) => index === 221 ? { ...row, id: row.id + 1 } : row), client: fullRows.client }],
    ['unexpected suffix', { operations: [...fullRows.operations, { id: 232, name: '0232_unapproved.sql' }], client: fullRows.client }],
  ]) {
    await t.test(label, async () => assert.rejects(
      readProductionMigrationReadiness(args(fakeProvider(rows).fetchImpl, { appendOnlyProfile: profile })),
      { code: /migration_ledger_row_invalid|partial_or_unapproved_migration_ledger|preserved_base_rows_mismatch|fully_appended_rows_mismatch/ },
    ));
  }
  const wrongIdentityProvider = fakeProvider(fullRows, { meta: { changes: 0, database_id: '00000000-0000-0000-0000-000000000000' } });
  await assert.rejects(readProductionMigrationReadiness(args(wrongIdentityProvider.fetchImpl, { appendOnlyProfile: profile })),
    { code: 'provider_database_identity_mismatch' });
});

