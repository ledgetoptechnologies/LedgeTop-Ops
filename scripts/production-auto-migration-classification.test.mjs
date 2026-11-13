import test, { after } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { PROFILE, canonical } from './production-deploy.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMMIT = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const approvedFixture = mkdtempSync(path.join(os.tmpdir(), 'append-profile-approved-source-'));
after(() => {
  const resolved = path.resolve(approvedFixture);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('append-profile-approved-source-'));
  rmSync(resolved, { recursive: true, force: true });
});
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

let approvedFixtureHead;
try {
  const tree = execFileSync('git', ['-C', root, 'ls-tree', '-rz', '--full-tree', COMMIT, '--',
    'apps/operations/migrations', 'apps/client/migrations']);
  const trackedBlobs = new Map();
  for (const entry of tree.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
    assert.ok(match, `invalid Git migration tree row: ${entry}`);
    trackedBlobs.set(match[3], match[2]);
  }
  const rows = Object.entries(manifest.databases).flatMap(([app, db]) =>
    db.sourceMigrations.map((row) => ({ app, row, relative: `apps/${app}/migrations/${row.name}` })));
  const oids = rows.map(({ row, relative }) => {
    const objectId = trackedBlobs.get(relative);
    assert.equal(objectId, row.gitBlobOid, `pinned Git blob mismatch for ${relative}`);
    return objectId;
  });
  const contents = execFileSync('git', ['-C', root, 'cat-file', '--batch'], {
    input: `${oids.join('\n')}\n`, maxBuffer: 32 * 1024 * 1024,
  });
  let offset = 0;
  const verifiedBytes = [];
  for (let index = 0; index < rows.length; index++) {
    const lineEnd = contents.indexOf(0x0a, offset);
    assert.ok(lineEnd >= 0, 'truncated Git blob batch header');
    const [objectId, type, sizeText] = contents.subarray(offset, lineEnd).toString('ascii').split(' ');
    assert.equal(objectId, oids[index]);
    assert.equal(type, 'blob');
    const size = Number(sizeText);
    assert.ok(Number.isSafeInteger(size) && size > 0 && size <= 8 * 1024 * 1024);
    const start = lineEnd + 1, end = start + size;
    assert.ok(end < contents.length && contents[end] === 0x0a, 'truncated Git blob batch content');
    const bytes = contents.subarray(start, end);
    const gitOid = createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${size}\0`), bytes])).digest('hex');
    assert.equal(gitOid, rows[index].row.gitBlobOid, `reconstructed Git blob mismatch for ${rows[index].relative}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), rows[index].row.sha256,
      `pinned SHA-256 mismatch for ${rows[index].relative}`);
    verifiedBytes.push(bytes);
    offset = end + 1;
  }
  assert.equal(offset, contents.length, 'unexpected trailing Git blob batch data');
  rows.forEach(({ app, row }, index) => {
    const directory = path.join(approvedFixture, 'apps', app, 'migrations');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, row.name), verifiedBytes[index]);
  });
  execFileSync('git', ['-C', approvedFixture, 'init', '-q']);
  execFileSync('git', ['-C', approvedFixture, 'config', 'core.autocrlf', 'false']);
  execFileSync('git', ['-C', approvedFixture, 'config', 'user.email', 'fixture@example.invalid']);
  execFileSync('git', ['-C', approvedFixture, 'config', 'user.name', 'Pinned blob fixture']);
  execFileSync('git', ['-C', approvedFixture, 'add', 'apps/operations/migrations', 'apps/client/migrations']);
  execFileSync('git', ['-C', approvedFixture, 'commit', '-qm', `SQL-only fixture reconstructed from pinned rows for ${APPROVED_SOURCE_COMMIT}`]);
  approvedFixtureHead = execFileSync('git', ['-C', approvedFixture, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.match(approvedFixtureHead, /^[0-9a-f]{40}$/);
} catch (error) {
  const resolved = path.resolve(approvedFixture);
  assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('append-profile-approved-source-'));
  rmSync(resolved, { recursive: true, force: true });
  throw error;
}
console.log(`# SQL-only reconstructed fixture HEAD=${approvedFixtureHead}; pinned profile source=${APPROVED_SOURCE_COMMIT}; verified blobs=${Object.values(manifest.databases).reduce((sum, db) => sum + db.sourceMigrations.length, 0)}`);

const strictSourceRows = Object.fromEntries(Object.entries(manifest.databases).map(([app, db]) => [
  app, db.sourceMigrations.map(({ name }, index) => ({ name, id: index + 1 })),
]));
strictSourceRows.operations = readdirSync(path.join(root, 'apps/operations/migrations'))
  .filter((name) => name.endsWith('.sql')).sort()
  .map((name, index) => ({ name, id: index + 1 }));
strictSourceRows.client = readdirSync(path.join(root, 'apps/client/migrations'))
  .filter((name) => name.endsWith('.sql')).sort()
  .map((name, index) => ({ name, id: index + 1 }));

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
  sourceCommit: extra.appendOnlyProfile === undefined ? COMMIT : approvedFixtureHead,
  root: extra.appendOnlyProfile === undefined ? root : approvedFixture,
  token: 'synthetic-token-for-local-test-only',
  env: {},
  fetchImpl,
  now: () => new Date('2026-10-27T12:00:00.000Z'),
  monotonicNow: (() => { let n = 100; return () => n++; })(),
  ...extra,
});

const LEGACY_PROFILE_TEST_MARKER = '__syntheticLegacyMigrationClassificationTestProfile';
async function withSyntheticLegacyProfile(callback) {
  assert.equal(Object.hasOwn(PROFILE, LEGACY_PROFILE_TEST_MARKER), false);
  const canonicalV4Bytes = Buffer.from(canonical(PROFILE));
  PROFILE[LEGACY_PROFILE_TEST_MARKER] = true;
  try {
    assert.notDeepEqual(Buffer.from(canonical(PROFILE)), canonicalV4Bytes,
      'fixture must select the historical migration-classification path');
    return await callback();
  } finally {
    delete PROFILE[LEGACY_PROFILE_TEST_MARKER];
    assert.deepEqual(Buffer.from(canonical(PROFILE)), canonicalV4Bytes,
      'restore the canonical installed profile even when a test fails');
  }
}

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
  assert.throws(() => validateProductionMigrationReadiness(result, { sourceCommit: result.sourceCommit }),
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
    sourceCommit: result.sourceCommit, now: Date.parse(result.observedAt), appendOnlyProfile: profile,
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
      sourceCommit: result.sourceCommit, now: Date.parse(result.observedAt), appendOnlyProfile: profile,
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
      sourceCommit: baseResult.sourceCommit, now: Date.parse(baseResult.observedAt), appendOnlyProfile: profile,
    }), { code: 'append_readiness_database_profile_mismatch' });
  }
});

test('runtime admission keeps both inventory classifications held with distinct reasons', async () => {
  const base = await readProductionMigrationReadiness(args(fakeProvider(baseRows).fetchImpl, { appendOnlyProfile: profile }));
  assert.throws(() => validateProductionMigrationAdmission(base, { sourceCommit: base.sourceCommit }),
    { code: 'migration_required_pending' });
  const full = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  assert.throws(() => validateProductionMigrationAdmission(full, { sourceCommit: full.sourceCommit }),
    { code: 'migration_application_schema_confirmation_required' });
  const malformed = structuredClone(full);
  malformed.status = 'ready';
  assert.throws(() => validateProductionMigrationAdmission(malformed, { sourceCommit: full.sourceCommit }),
    { code: 'migration_readiness_diagnostic_invalid' });
});

test('Operations release callsite holds a full inventory before CI or provider work', async () => {
  const diagnostic = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  const { createProductionAutoReleaseAdapter } = await import('./production-auto-runtime.mjs');
  let diagnosticCalls = 0, ciCalls = 0, providerCalls = 0;
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '101', GITHUB_RUN_ATTEMPT: '1' };
  await withSyntheticLegacyProfile(async () => {
    const runtime = createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: diagnostic.sourceCommit, env,
      triggerRun: { sourceCommit: diagnostic.sourceCommit, runId: 101, runAttempt: 1 },
      migrationReader: async ({ appendOnlyProfile }) => {
        diagnosticCalls++;
        assert.equal(appendOnlyProfile.appendPlanBytes.toString('utf8'), appendPlanBytes.toString('utf8'));
        return diagnostic;
      },
      ciFactory: () => ({ verify: async () => { ciCalls++; return { passed: true, runId: 101, runAttempt: 1 }; }, mainCommit: async () => diagnostic.sourceCommit }),
      providerFactory: () => { providerCalls++; assert.fail('provider work must not start while schema confirmation is required'); },
    });
    await assert.rejects(runtime.adapter.ciGate(), { code: 'migration_application_schema_confirmation_required' });
  });
  assert.equal(diagnosticCalls, 1);
  assert.equal(ciCalls, 0);
  assert.equal(providerCalls, 0);
});

test('Ops Sync release callsite preserves the full-inventory hold before readiness or provider work', async () => {
  const diagnostic = await readProductionMigrationReadiness(args(fakeProvider(fullRows).fetchImpl, { appendOnlyProfile: profile }));
  const { createProductionAutoSyncAdapter } = await import('./production-auto-sync-runtime.mjs');
  let diagnosticCalls = 0, ciCalls = 0, providerCalls = 0, otherCalls = 0;
  const unexpected = () => { otherCalls++; throw Error('unexpected downstream work'); };
  const triggerRun = { sourceCommit: diagnostic.sourceCommit, runId: 102, runAttempt: 1 };
  const predecessorReleaseId = createHash('sha256').update(`ledgetop-ops\n${diagnostic.sourceCommit}`).digest('hex');
  const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '102', GITHUB_RUN_ATTEMPT: '1', NATIVE_STAFF_CUTOVER_REVIEW_JSON: '{"synthetic":true}',
    PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success',
    PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: diagnostic.sourceCommit,
    PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: predecessorReleaseId };
  await withSyntheticLegacyProfile(async () => {
    const runtime = createProductionAutoSyncAdapter({ sourceCommit: diagnostic.sourceCommit,
      triggerRun, env,
      migrationReader: async () => { diagnosticCalls++; return diagnostic; },
      ciFactory: () => ({ verify: () => { ciCalls++; return unexpected(); } }),
      sourceReader: unexpected, readinessReader: unexpected,
      providerFactory: () => { providerCalls++; return unexpected(); }, journalFactory: unexpected, recipientLoader: unexpected,
      fetchImpl: unexpected, buildRunner: unexpected,
    });
    await assert.rejects(runtime.adapter.release(), (error) => error.code === 'migration_application_schema_confirmation_required');
  });
  assert.equal(diagnosticCalls, 1);
  assert.equal(ciCalls, 0);
  assert.equal(providerCalls, 0);
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
    sourceCommit: fresh.sourceCommit, now: Date.parse(fresh.observedAt) + 60_001, appendOnlyProfile: profile,
  }), { code: 'append_readiness_stale' });
});

test('current 0242 source successor is refused by the unchanged historical profile before provider requests', async () => {
  const provider = fakeProvider(baseRows);
  const currentClientNames = readdirSync(path.join(root, 'apps/client/migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  assert.equal(currentClientNames.length, 161);
  assert.equal(currentClientNames.at(-1), '0242_client_ops_triage_inquiries.sql');
  const fixtureClientNames = readdirSync(path.join(approvedFixture, 'apps/client/migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  assert.equal(fixtureClientNames.length, 160);
  await assert.rejects(readProductionMigrationReadiness(args(provider.fetchImpl, {
    appendOnlyProfile: profile, root, sourceCommit: COMMIT,
  })), { code: 'source_inventory_count_mismatch' });
  assert.equal(provider.calls, 0);
});

test('current 0240 and 0241 Operations successors are refused by the unchanged historical profile before provider requests', async () => {
  const provider = fakeProvider(strictSourceRows);
  const currentOperationsNames = readdirSync(path.join(root, 'apps/operations/migrations'))
    .filter((name) => name.endsWith('.sql')).sort();
  assert.equal(currentOperationsNames.length, 233);
  assert.deepEqual(currentOperationsNames.slice(-2), [
    '0240_flight_logs_permissions.sql', '0241_staff_usernames.sql',
  ]);
  await assert.rejects(readProductionMigrationReadiness(args(provider.fetchImpl, {
    appendOnlyProfile: profile, root, sourceCommit: COMMIT,
  })), { code: 'source_inventory_count_mismatch' });
  assert.equal(provider.calls, 0);
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

