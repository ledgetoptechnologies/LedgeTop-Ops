import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  PROFILE, SOURCE_COMMIT, LEDGER_SQL, SCHEMA_SQL,
  readSourceMigrationInventory, summarizeInstalledSchema, validateInstalledSchemaPreservation,
  createInstalledSchemaPreservationTestSession, isProductionInstalledSchemaPreservationAdmission,
  isProductionInstalledSchemaPreservationSession, isTestInstalledSchemaPreservationAdmission,
  validateInstalledSchemaPreservationReleaseAdmissionOffline,
  readInstalledSchemaPreservationMetadata,
} from './installed-schema-preservation.mjs';
import { PROFILE as DEPLOY_PROFILE, CANONICAL_INSTALLED_PROFILE_V4_SHA256 } from '../../production-deploy.mjs';

const HERE = new URL('./', import.meta.url);
const fixture = JSON.parse(fs.readFileSync(new URL('actual-metadata-evidence.fixture.json', HERE), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const fresh = evidence => Date.parse(evidence.observedAt);
const OFFLINE_ARTIFACTS = 'C:/Projects/Ledge Top Operations/_artifacts/production-release-readback-20261104';
const v4Candidate = () => JSON.parse(fs.readFileSync(path.join(OFFLINE_ARTIFACTS,
  'canonical-installed-profile-v4-2686c535-offline-20261105', 'candidate.private.json'), 'utf8'));

test('sanitized actual metadata classifies the exact installed ledgers and pending source migrations', () => {
  const source = readSourceMigrationInventory(SOURCE_COMMIT);
  const result = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: SOURCE_COMMIT,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(fixture) });
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

test('a later source commit is accepted only when both committed migration inventories and bytes stay identical', () => {
  const laterCommit = '2a86d224115c83c39ce04c3c1b53618098ac2cf2';
  const source = readSourceMigrationInventory(laterCommit);
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

test('ledger reorder, migration ledger drift, and schema drift are rejected', () => {
  const source = readSourceMigrationInventory(SOURCE_COMMIT);
  const reordered = clone(fixture); reordered.databases.operations.ledger.reverse();
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: reordered, sourceCommit: SOURCE_COMMIT,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(reordered) }), /operations_ledger_drift/);
  const targetMoved = clone(fixture); targetMoved.databases.client.ledger[158].id = 160;
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: targetMoved, sourceCommit: SOURCE_COMMIT,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(targetMoved) }), /client_ledger_drift/);
  const schemaChanged = clone(fixture); schemaChanged.databases.client.schema.objectsSha256 = '0'.repeat(64);
  assert.throws(() => validateInstalledSchemaPreservation({ evidence: schemaChanged, sourceCommit: SOURCE_COMMIT,
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
  const source = readSourceMigrationInventory(SOURCE_COMMIT);
  const classification = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: SOURCE_COMMIT,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(fixture) });
  for (const fakeControlSha of [CANONICAL_INSTALLED_PROFILE_V4_SHA256, 'a'.repeat(64)]) {
    assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
      sourceCommit: SOURCE_COMMIT, canonicalV4ProfileSha256: fakeControlSha,
      protectedControlsBeforeSha256: fakeControlSha, protectedControlsAfterSha256: fakeControlSha,
      now: fresh(fixture),
    }), /preservation_session_options_invalid/);
  }
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4ProfileSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    protectedControlsBeforeSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    protectedControlsAfterSha256: CANONICAL_INSTALLED_PROFILE_V4_SHA256,
    maxAgeMs: 600_000, now: fresh(fixture),
  }), /preservation_session_options_invalid/);
  const profile = fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'canonical-installed-profile-v4-2686c535-offline-20261105', 'candidate.private.json'))
    ? v4Candidate().profile : null;
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4Profile: profile, selectedApp: 'operations',
    baselineCapture: {}, currentCapture: {}, now: fresh(fixture) + 60_001,
  }), /preservation_current_evidence_stale_or_invalid/);
});

test('fake HTTP same-run session reads actual full capture and D1 metadata and brands only its fresh receipt', {
  skip: !fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'ops-canonical-execution-2686-20261105-02', 'authenticated-final-capture.private.json'))
    || !fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'canonical-installed-profile-v4-2686c535-offline-20261105', 'candidate.private.json'))
    || !fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'actual-installed-metadata-20261105-01.private.json')),
}, async () => {
  const savedCapture = JSON.parse(fs.readFileSync(path.join(OFFLINE_ARTIFACTS,
    'ops-canonical-execution-2686-20261105-02', 'authenticated-final-capture.private.json'), 'utf8'));
  const candidate = JSON.parse(fs.readFileSync(path.join(OFFLINE_ARTIFACTS,
    'canonical-installed-profile-v4-2686c535-offline-20261105', 'candidate.private.json'), 'utf8'));
  const actualMetadata = JSON.parse(fs.readFileSync(path.join(OFFLINE_ARTIFACTS, 'actual-installed-metadata-20261105-01.private.json'), 'utf8'));
  const appsByWorker = Object.fromEntries(Object.entries(DEPLOY_PROFILE.workers).map(([app, row]) => [row.name, app]));
  let wall = Date.parse('2026-11-05T15:50:00.000Z'), mono = 1000;
  const fakeFetch = async (url, init = {}) => {
    const parsed = new URL(url), workerMatch = /\/workers\/scripts\/([^/]+)(.*)$/u.exec(parsed.pathname);
    if (parsed.pathname.includes('/d1/database/')) {
      assert.equal(init.method, 'POST');
      const dbid = parsed.pathname.match(/\/d1\/database\/([^/]+)\/query/u)[1];
      const app = Object.keys(actualMetadata.databases).find(key => actualMetadata.databases[key].id.toLowerCase() === dbid.toLowerCase());
      assert.ok(app);
      const sql = JSON.parse(init.body).sql, db = actualMetadata.databases[app];
      const results = sql === LEDGER_SQL ? db.ledger : sql === SCHEMA_SQL ? db.schema : null;
      assert.ok(results);
      return new Response(JSON.stringify({ success: true, result: [{ success: true, results,
        database_id: dbid, meta: { changes: 0, changed_db: false, database_id: dbid } }] }), { status: 200 });
    }
    assert.equal(init.method, 'GET');
    if (!workerMatch) {
      const modern = /\/workers\/([^/]+)\/versions\/([^/]+)\?include=modules$/u.exec(parsed.pathname + parsed.search);
      assert.ok(modern, parsed.pathname + parsed.search);
      const app = appsByWorker[modern[1]], row = savedCapture.snapshot[app];
      assert.equal(modern[2], row.version.id);
      return new Response(JSON.stringify({ success: true, result: row.modern }), { status: 200 });
    }
    const app = appsByWorker[workerMatch[1]], row = savedCapture.snapshot[app], suffix = workerMatch[2] + parsed.search;
    assert.ok(row, workerMatch[1]);
    let result;
    if (suffix === '/deployments?per_page=1') result = { deployments: [row.deployment] };
    else if (suffix === '/versions?per_page=1') result = { items: [{ id: row.latest }] };
    else if (suffix === `/versions/${row.version.id}`) result = row.version;
    else if (suffix === '/settings') result = row.settings;
    else if (suffix === '/schedules') result = row.schedules;
    else if (suffix.startsWith('/versions/')) result = row.latestVersion;
    assert.ok(result, `${app} ${suffix}`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  const session = await createInstalledSchemaPreservationTestSession({ sourceCommit: SOURCE_COMMIT,
    canonicalV4Profile: candidate.profile, selectedApp: 'operations', token: 'fake-test-token-'.padEnd(32, 'x'),
    fetchImpl: fakeFetch, clock: { wallNow: () => wall += 2, monotonicNow: () => mono += 1 } });
  assert.equal(isProductionInstalledSchemaPreservationAdmission({}), false);
  assert.equal(isProductionInstalledSchemaPreservationAdmission(session), false);
  assert.equal(isProductionInstalledSchemaPreservationSession(session), false);
  const receipt = await session.observe();
  assert.equal(receipt.status, 'preserved-installed-schema-with-pending-source-migrations');
  assert.equal(receipt.offlineOnly, undefined);
  assert.equal(receipt.testOnly, true);
  assert.equal(isTestInstalledSchemaPreservationAdmission(receipt), true);
  assert.equal(isProductionInstalledSchemaPreservationAdmission(receipt), false);
  assert.equal(isTestInstalledSchemaPreservationAdmission(clone(receipt)), false);
  assert.equal(receipt.allSourceMigrationsInstalled, false);
  assert.equal(receipt.applicationSchemaReady, false);
  assert.equal(receipt.executesDdl, false);
  await assert.rejects(session.observe({ unreviewedCandidateConfiguration: true }), /preservation_session_options_invalid/);
  session.close();
  const makeTestSession = extra => createInstalledSchemaPreservationTestSession({ sourceCommit: SOURCE_COMMIT,
    canonicalV4Profile: candidate.profile, selectedApp: 'operations', token: 'fake-test-token-'.padEnd(32, 'x'),
    fetchImpl: fakeFetch, clock: { wallNow: () => wall += 2, monotonicNow: () => mono += 1 }, ...extra });
  const staleSession = await makeTestSession({ testHooks: { afterMetadata(stage, evidence) {
    return stage === 'current' ? { ...evidence, observedAt: '2020-01-01T00:00:00.000Z' } : evidence;
  } } });
  await assert.rejects(staleSession.observe(), /preservation_capture_or_metadata_stale/);
  staleSession.close();
  const expiredSession = await makeTestSession();
  mono += 45 * 60_000 + 1;
  await assert.rejects(expiredSession.observe(), /preservation_same_run_baseline_expired/);
  expiredSession.close();
});

test('saved actual snapshot and v4 candidate admit offline under their captured historical clock', {
  skip: !fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'ops-canonical-execution-2686-20261105-02', 'authenticated-final-capture.private.json'))
    || !fs.existsSync(path.join(OFFLINE_ARTIFACTS, 'canonical-installed-profile-v4-2686c535-offline-20261105', 'candidate.private.json')),
}, () => {
  const savedCapture = JSON.parse(fs.readFileSync(path.join(OFFLINE_ARTIFACTS,
    'ops-canonical-execution-2686-20261105-02', 'authenticated-final-capture.private.json'), 'utf8'));
  const candidate = v4Candidate();
  assert.equal(candidate.profileSHA256, CANONICAL_INSTALLED_PROFILE_V4_SHA256);
  const source = readSourceMigrationInventory(SOURCE_COMMIT);
  const classification = validateInstalledSchemaPreservation({ evidence: fixture, sourceCommit: SOURCE_COMMIT,
    sourceRows: source.rows, sourceFiles: source.files, now: fresh(fixture) });
  for (const app of ['operations', 'client', 'ops-sync']) {
    const admission = validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
      sourceCommit: SOURCE_COMMIT, canonicalV4Profile: candidate.profile, selectedApp: app,
      baselineCapture: savedCapture.snapshot, currentCapture: savedCapture.snapshot, now: fresh(fixture),
    });
    assert.equal(admission.status, 'preserved-installed-schema-with-pending-source-migrations');
    assert.equal(admission.accountId, PROFILE.accountId);
    assert.equal(admission.observedAt, fixture.observedAt);
    assert.equal(admission.selectedApp, app);
    assert.equal(admission.offlineOnly, true);
    assert.equal(admission.applicationSchemaReady, false);
    assert.equal(admission.authorizesFeatureActivation, false);
    assert.match(admission.currentProtectedControlsSha256, /^[a-f0-9]{64}$/u);
  }

  const alteredProfile = clone(candidate.profile);
  alteredProfile.workers.operations.plainValueSHA256.CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED = '0'.repeat(64);
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4Profile: alteredProfile, selectedApp: 'operations',
    baselineCapture: savedCapture.snapshot, currentCapture: savedCapture.snapshot, now: fresh(fixture),
  }), /preservation_v4_profile_unpinned/);
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4Profile: candidate.profile, selectedApp: 'not-a-worker',
    baselineCapture: savedCapture.snapshot, currentCapture: savedCapture.snapshot, now: fresh(fixture),
  }), /preservation_selected_app_invalid/);
  const changedCandidate = clone(savedCapture.snapshot);
  changedCandidate.operations.settings.compatibility_flags.push('unreviewed-candidate-flag');
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4Profile: candidate.profile, selectedApp: 'operations',
    baselineCapture: savedCapture.snapshot, currentCapture: changedCandidate, now: fresh(fixture),
  }), /unrecognized production settings/);
  const changedControls = clone(savedCapture.snapshot);
  changedControls.operations.version.resources.bindings.find(row => row.name === 'CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED').text = 'false';
  changedControls.operations.settings.bindings.find(row => row.name === 'CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED').text = 'false';
  assert.throws(() => validateInstalledSchemaPreservationReleaseAdmissionOffline(classification, {
    sourceCommit: SOURCE_COMMIT, canonicalV4Profile: candidate.profile, selectedApp: 'operations',
    baselineCapture: savedCapture.snapshot, currentCapture: changedControls, now: fresh(fixture),
  }), /pinned installed profile|preserved true flag|scalar configuration/u);
});
