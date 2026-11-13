import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  PROFILE, SOURCE_COMMIT as OBSERVED_SOURCE_COMMIT, LEDGER_SQL, SCHEMA_SQL,
  readSourceMigrationInventory, summarizeInstalledSchema, validateInstalledSchemaPreservation,
  createInstalledSchemaPreservationTestSession,
  installedSchemaProtectedControlsFingerprint,
  validateInstalledSchemaPreservationReleaseAdmissionOffline,
  readInstalledSchemaPreservationMetadata,
  createInstalledSchemaPreservationSession,
} from './installed-schema-preservation.mjs';
import { createProductionAutoCloudflarePacer } from '../../production-auto-cloudflare-pacer.mjs';
import { PROFILE as V4_PROFILE, CANONICAL_INSTALLED_PROFILE_V4_SHA256,
  validateCanonicalV4AssetAssociationMetadata } from '../../production-deploy.mjs';

const HERE = new URL('./', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('actual-metadata-evidence.fixture.json', HERE), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function profileSubsetFromCurrentHead(source) {
  const rows = {}, files = {};
  for (const app of ['operations', 'client']) {
    const expected = PROFILE.databases[app].sourceInventory;
    const currentRows = new Map(source.rows[app].map(row => [row.name, row]));
    const currentFiles = new Map(source.files[app].map(file => [file.name, file.bytes]));
    rows[app] = expected.map(row => {
      assert.deepEqual(currentRows.get(row.name), row, `${app}/${row.name}: current HEAD blob matches historical pin`);
      const bytes = currentFiles.get(row.name);
      assert.ok(bytes, `${app}/${row.name}: current HEAD bytes exist`);
      assert.equal(hash(bytes), row.sha256, `${app}/${row.name}: current HEAD bytes match historical SHA-256`);
      return row;
    });
    files[app] = expected.map(row => ({ name: row.name, bytes: currentFiles.get(row.name) }));
  }
  return { rows, files };
}
// Ordinary CI checkouts can be shallow. Qualify the current immutable source
// tree; the historical observation remains pinned in PROFILE and the fixture.
const SOURCE_COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: fileURLToPath(new URL('../../../', import.meta.url)), encoding: 'utf8',
  windowsHide: true, timeout: 5_000, maxBuffer: 1024,
}).trim();
assert.equal(PROFILE.source.commit, OBSERVED_SOURCE_COMMIT);

test('production session accepts its native paced transport but rejects a caller fake before I/O', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; throw new Error('native-transport-test-stop'); });
  const options = { sourceCommit: SOURCE_COMMIT, canonicalV4Profile: V4_PROFILE, selectedApp: 'client', token: 'x'.repeat(32) };
  const native = createProductionAutoCloudflarePacer({ accountId: PROFILE.accountId });
  await assert.rejects(createInstalledSchemaPreservationSession({ ...options, fetchImpl: native.fetchImpl }),
    /native-transport-test-stop/u);
  assert.equal(requests, 1, 'the real production constructor reached its own paced HTTP transport');
  const fake = createProductionAutoCloudflarePacer({ accountId: PROFILE.accountId, fetchImpl: async () => {
    requests++; throw new Error('untrusted transport was called');
  } });
  await assert.rejects(createInstalledSchemaPreservationSession({ ...options, fetchImpl: fake.fetchImpl }),
    /preservation_production_transport_untrusted/u);
  assert.equal(requests, 1);
});
const fresh = evidence => Date.parse(evidence.observedAt);

test('automatic schema baseline refuses the first head change for all three Workers before any D1 query', async () => {
  for (const changed of Object.keys(V4_PROFILE.workers)) {
    let heads = 0, queries = 0;
    const fetchImpl = async input => {
      const url = new URL(input);
      if (url.pathname.includes('/d1/')) { queries++; throw Error('must not query'); }
      const app = Object.keys(V4_PROFILE.workers).find(app => url.pathname.includes(`/${V4_PROFILE.workers[app].name}/`));
      assert(app);
      let result;
      const id = '11111111-1111-4111-8111-111111111111';
      if (url.pathname.endsWith('/deployments')) {
        const changedHead = app === changed && ++heads === 2;
        result = { deployments: [{ id: changedHead ? '22222222-2222-4222-8222-222222222222' : id,
          versions: [{ version_id: id, percentage: 100 }] }] };
      } else if (url.pathname.endsWith('/versions')) result = { items: [{ id }] };
      else if (url.pathname.endsWith('/settings')) result = {};
      else if (url.pathname.endsWith('/schedules')) result = { schedules: [] };
      else result = { id };
      return Response.json({ success: true, errors: [], result });
    };
    await assert.rejects(createInstalledSchemaPreservationTestSession({ sourceCommit: SOURCE_COMMIT,
      canonicalV4Profile: V4_PROFILE, selectedApp: 'client', token: 'x'.repeat(32), allowUnselectedRecapture: false,
      fetchImpl, clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() } }), /changed during metadata capture/u);
    assert.equal(heads, 2, `${changed}: no baseline recapture`); assert.equal(queries, 0);
  }
  for (const invalid of [null, 'false', 0]) {
    let calls = 0;
    await assert.rejects(createInstalledSchemaPreservationTestSession({ sourceCommit: SOURCE_COMMIT,
      canonicalV4Profile: V4_PROFILE, selectedApp: 'client', token: 'x'.repeat(32), allowUnselectedRecapture: invalid,
      fetchImpl: async () => { calls++; throw Error('must not send'); },
      clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() } }), /preservation_session_target_invalid/u);
    assert.equal(calls, 0);
  }
});

test('sanitized actual metadata classifies the exact installed ledgers and pending source migrations', () => {
  // This is a historical-profile fixture assembled from current HEAD only after
  // every selected blob and byte hash is proven equal to the frozen manifest.
  // It does not claim the complete current HEAD inventory is profile-approved.
  const current = readSourceMigrationInventory(SOURCE_COMMIT);
  const { rows, files } = profileSubsetFromCurrentHead(current);
  assert.equal(PROFILE.source.commit, OBSERVED_SOURCE_COMMIT);
  const result = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: PROFILE.source.commit,
    sourceRows: rows, sourceFiles: files, now: fresh(fixture) });
  assert.equal(result.status, 'installed-schema-preserved-with-pending-source-migrations');
  assert.deepEqual(result.databases.operations.pendingSourceNames, [
    '0227_owner_intel_reads.sql', '0228_competitor_intel_ingest.sql', '0229_owner_intel_source_feed.sql',
    '0230_app_release_pilot.sql', '0231_owner_google_ads_summary.sql',
  ]);
  assert.deepEqual(result.databases.client.pendingSourceNames, [
    '0235_windows_portal_successor_candidates.sql', '0236_windows_portal_successor_content_start_audit.sql',
    '0239_native_project_assignment_proof_v3.sql', '0241_app_release_pilot.sql',
  ]);
  assert.equal(result.databases.operations.ledgerCount, 226);
  assert.equal(result.databases.client.ledgerCount, 159);
  assert.equal(result.allSourceMigrationsInstalled, false);
  assert.equal(result.applicationSchemaReady, false);
  assert.equal(result.executesDdl, false);
  assert.equal(result.authorizesMigration, false);
  assert.equal(result.authorizesFeatureActivation, false);
});

test('synthetic classifier source commit accepts only identical pinned inventories and bytes', () => {
  // This exercises the pure classifier with a well-formed synthetic commit ID;
  // it is not a claim that current HEAD is eligible for the historical profile.
  const laterCommit = 'd'.repeat(40);
  assert.notEqual(laterCommit, OBSERVED_SOURCE_COMMIT);
  assert.notEqual(laterCommit, SOURCE_COMMIT);
  const source = profileSubsetFromCurrentHead(readSourceMigrationInventory(SOURCE_COMMIT));
  const result = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: laterCommit,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(fixture) });
  assert.equal(result.sourceCommit, laterCommit);
  const changedRows = clone(source.rows);
  changedRows.client[0].sha256 = '0'.repeat(64);
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: laterCommit,
    sourceRows: changedRows, sourceFiles: source.files, now: fresh(fixture) }), /client_source_inventory_mismatch/);
  const withNewMigration = clone(source.rows);
  withNewMigration.client.push({ name: '0243_unreviewed.sql', gitBlobOid: 'f'.repeat(40), sha256: 'e'.repeat(64) });
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: laterCommit,
    sourceRows: withNewMigration, sourceFiles: source.files, now: fresh(fixture) }), /client_source_inventory_mismatch/);
  const changedFiles = { ...source.files, operations: source.files.operations.map(row => ({ ...row, bytes: Buffer.from(row.bytes) })) };
  changedFiles.operations[0].bytes[0] ^= 1;
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: laterCommit,
    sourceRows: source.rows, sourceFiles: changedFiles, now: fresh(fixture) }), /operations_source_bytes_mismatch/);
});

test('the unchanged historical profile rejects the complete current 233-file Operations inventory', () => {
  const current = readSourceMigrationInventory(SOURCE_COMMIT);
  assert.equal(current.rows.operations.length, 233);
  assert.deepEqual(current.rows.operations.slice(-2).map(row => row.name), [
    '0240_flight_logs_permissions.sql', '0241_staff_usernames.sql',
  ]);
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: SOURCE_COMMIT,
    sourceRows: current.rows, sourceFiles: current.files, now: fresh(fixture) }), /preservation_operations_source_inventory_mismatch/u);
});

test('ledger reorder, migration ledger drift, and schema drift are rejected', () => {
  const source = profileSubsetFromCurrentHead(readSourceMigrationInventory(SOURCE_COMMIT));
  const sourceCommit = PROFILE.source.commit;
  const reordered = clone(fixture); reordered.databases.operations.ledger.reverse();
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: reordered, sourceCommit,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(reordered) }), /operations_ledger_drift/);
  const targetMoved = clone(fixture); targetMoved.databases.client.ledger[158].id = 160;
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: targetMoved, sourceCommit,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(targetMoved) }), /client_ledger_drift/);
  const schemaChanged = clone(fixture); schemaChanged.databases.client.schema.objectsSha256 = '0'.repeat(64);
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: schemaChanged, sourceCommit,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(schemaChanged) }), /client_schema_drift/);
});

test('the source profile explicitly pins the targeted 0226 and out-of-order 0242 exceptions', () => {
  const ops = PROFILE.databases.operations, client = PROFILE.databases.client;
  assert.deepEqual(PROFILE.preservedExceptions.operations, {
    kind: 'targeted-prefix-migration', migration: '0226_staff_login_bindings.sql', ledgerId: 226,
    knownTargetSha256: 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5',
    sourcePending: ops.pendingSourceNames,
  });
  assert.equal(client.orderedLedger.at(-1).name, '0242_client_ops_triage_inquiries.sql');
  assert.equal(client.orderedLedger.at(-1).id, 159);
  assert.deepEqual(PROFILE.preservedExceptions.client.historicalLedgerRows, [
    { id: 31, name: '0112_thumbnail_renderer_coordination.sql' },
    { id: 32, name: '0113_thumbnail_backfill_controls.sql' },
  ]);
  assert.deepEqual(PROFILE.preservedExceptions.client.sourcePending, client.pendingSourceNames);
});

test('schema preservation ignores the internal Cloudflare object while hashing all application definitions', () => {
  const app = { type: 'table', name: 'app_table', tbl_name: 'app_table', sql: 'CREATE TABLE app_table(id TEXT)' };
  const internal = { type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV(k TEXT)' };
  assert.deepEqual(summarizeInstalledSchema([internal, app]), {
    objectCount: 1, objectsSha256: hash(Buffer.from(JSON.stringify([app]))), cloudflareInternalRows: 1,
  });
  assert.deepEqual(summarizeInstalledSchema([app]), {
    objectCount: 1, objectsSha256: hash(Buffer.from(JSON.stringify([app]))), cloudflareInternalRows: 0,
  });
});

test('fresh reader issues only the two pinned SELECT statements per exact production database', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body); calls.push({ url, method: init.method, sql: request.sql, params: request.params });
    const results = request.sql === LEDGER_SQL ? [{ name: '0001_fixture.sql', id: 1 }]
      : [{ type: 'table', name: '_cf_KV', tbl_name: '_cf_KV', sql: 'CREATE TABLE _cf_KV(k TEXT)' },
        { type: 'table', name: 'fixture', tbl_name: 'fixture', sql: 'CREATE TABLE fixture(id TEXT)' }];
    return new Response(JSON.stringify({ success: true, result: [{ success: true, results, meta: { changes: 0, changed_db: false } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await readInstalledSchemaPreservationMetadata({ token: 'x'.repeat(32), fetchImpl,
    now: () => new Date(fixture.observedAt) });
  assert.equal(calls.length, 4);
  assert.ok(calls.every(row => row.method === 'POST' && row.params.length === 0 && /^SELECT\b/u.test(row.sql)));
  assert.deepEqual(calls.map(row => row.sql), [LEDGER_SQL, SCHEMA_SQL, LEDGER_SQL, SCHEMA_SQL]);
  assert.equal(result.readOnly, true);
  assert.equal(result.executesDdl, false);
  assert.equal(result.databases.operations.schema.cloudflareInternalRows, 1);
  assert.equal(result.databases.operations.schema.objectCount, 1);
  assert.equal(Object.hasOwn(result.databases.operations.schema, 'rows'), false);
  const writeReportingFetch = async (url, init) => {
    const request = JSON.parse(init.body);
    const results = request.sql === LEDGER_SQL ? [{ name: '0001_fixture.sql', id: 1 }]
      : [{ type: 'table', name: 'fixture', tbl_name: 'fixture', sql: 'CREATE TABLE fixture(id TEXT)' }];
    return new Response(JSON.stringify({ success: true, result: [{ success: true, results,
      meta: { changes: 1, changed_db: true } }] }), { status: 200 });
  };
  await assert.rejects(readInstalledSchemaPreservationMetadata({ token: 'x'.repeat(32), fetchImpl: writeReportingFetch,
    now: () => new Date(fixture.observedAt) }), /preservation_provider_write_metadata_invalid/);
});

test('caller snapshots and hash-shaped values cannot create production admission', () => {
  const source = profileSubsetFromCurrentHead(readSourceMigrationInventory(SOURCE_COMMIT));
  const sourceCommit = PROFILE.source.commit;
  const classification = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(fixture) });
  for (const fakeControlSha of [CANONICAL_INSTALLED_PROFILE_V4_SHA256, 'a'.repeat(64)]) {
    assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
      sourceCommit, canonicalV4ProfileSha256: fakeControlSha,
      protectedControlsBeforeSha256: fakeControlSha, protectedControlsAfterSha256: fakeControlSha,
      now: fresh(fixture),
    }), /preservation_session_options_invalid/);
  }
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit, canonicalV4ProfileSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    protectedControlsBeforeSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    protectedControlsAfterSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    maxAgeMs: 600_000, now: fresh(fixture),
  }), /preservation_session_options_invalid/);
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit, canonicalV4Profile: V4_PROFILE, selectedApp: 'operations',
    baselineCapture: {}, currentCapture: {}, now: fresh(fixture) + 60_001,
  }), /preservation_current_evidence_stale_or_invalid/);
});

test('UI asset-association exception cannot be enabled for Ops Sync and rejects before IO', async () => {
  let requests = 0;
  await assert.rejects(createInstalledSchemaPreservationTestSession({ sourceCommit: SOURCE_COMMIT,
    canonicalV4Profile: V4_PROFILE, selectedApp: 'ops-sync', allowAssetAssociationRotation: true,
    token: 'fake-test-token-'.padEnd(32, 'x'), fetchImpl: async () => { requests++; throw Error('must not fetch'); },
    clock: { wallNow: () => Date.now(), monotonicNow: () => 0 } }), /preservation_session_target_invalid/);
  assert.equal(requests, 0);
});

test('owned UI asset rotation normalizes only its internally pinned association and retains other-worker controls', () => {
  const config = { base_path: '/', html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*'] };
  const originalAssets = { config, jwt: 'old.jwt.signature' }, rotatedAssets = { config: clone(config), jwt: 'new.jwt.signature' };
  assert.equal(validateCanonicalV4AssetAssociationMetadata(originalAssets, rotatedAssets), true);
  const state = assets => ({ settings: { annotations: {} }, schedules: { schedules: [] },
    version: { resources: { script: { handlers: ['fetch'], named_handlers: [] }, script_runtime: {}, bindings: [] } },
    modern: { assets } });
  const baseline = { operations: state(originalAssets), client: state({ config: clone(config) }), 'ops-sync': state(null) };
  const rotated = structuredClone(baseline); rotated.operations.modern.assets = rotatedAssets;
  const before = installedSchemaProtectedControlsFingerprint(baseline, { selectedApp: 'operations', baselineAssets: originalAssets });
  const after = installedSchemaProtectedControlsFingerprint(rotated, { selectedApp: 'operations', baselineAssets: originalAssets });
  assert.equal(after, before, 'the exact selected UI association is normalized to its baseline after shape validation');
  const otherWorkerDrift = structuredClone(rotated);
  otherWorkerDrift.client.modern.assets.config.html_handling = 'drop-trailing-slash';
  assert.notEqual(installedSchemaProtectedControlsFingerprint(otherWorkerDrift,
    { selectedApp: 'operations', baselineAssets: originalAssets }), before,
  'a second worker asset change remains visible to the controls digest');
  const selectedConfigDrift = { config: { ...config, base_path: '/unreviewed' }, jwt: 'new.jwt.signature' };
  assert.throws(() => validateCanonicalV4AssetAssociationMetadata(originalAssets, selectedConfigDrift));
  assert.throws(() => installedSchemaProtectedControlsFingerprint(rotated,
    { selectedApp: 'ops-sync', baselineAssets: originalAssets }), /preservation_fingerprint_override_invalid/);
});
