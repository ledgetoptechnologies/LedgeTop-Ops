// Explicit local acceptance only. This reads the actual private production
// capture/metadata artifacts, but all provider requests are simulated in memory.
// It is intentionally not named *.test.mjs so CI does not depend on local files.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createProductionAutoReleaseAdapter } from '../../production-auto-runtime.mjs';
import { createProductionAutoSyncAdapter } from '../../production-auto-sync-runtime.mjs';
import { PROFILE, CANONICAL_INSTALLED_PROFILE_V4_SHA256, canonical } from '../../production-deploy.mjs';
import { createInstalledSchemaPreservationTestSession, isTestInstalledSchemaPreservationAdmission,
  LEDGER_SQL, SCHEMA_SQL, SOURCE_COMMIT, readSourceMigrationInventory,
  validateInstalledSchemaPreservation, validateInstalledSchemaPreservationReleaseAdmissionOffline }
  from './installed-schema-preservation.mjs';

const ARTIFACTS = 'C:/Projects/Ledge Top Operations/_artifacts/production-release-readback-20261104';
const capturePath = path.join(ARTIFACTS, 'ops-canonical-execution-2686-20261105-02', 'authenticated-final-capture.private.json');
const metadataPath = path.join(ARTIFACTS, 'actual-installed-metadata-20261105-01.private.json');
const sourceCommit = SOURCE_COMMIT;
const accountId = '846c924bf17bf4f3dd15c97a4c5d1d51';
const predecessorReleaseId = createHash('sha256').update(`ledgetop-ops\n${sourceCommit}`).digest('hex');
const need = (value, message) => { if (!value) throw new Error(message); };

for (const file of [capturePath, metadataPath]) need(fs.existsSync(file), `required actual acceptance artifact is missing: ${file}`);
const captureArtifact = JSON.parse(fs.readFileSync(capturePath, 'utf8'));
const metadataArtifact = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
need(captureArtifact.observedAt && captureArtifact.sha256 === '3d8dde3b9c7ae611c4eb2922cb3e49b3283820b80e836267c5d5bbcf2ffcdf30',
  'actual final capture receipt identity changed');
need(createHash('sha256').update(canonical(captureArtifact.snapshot)).digest('hex') === captureArtifact.sha256,
  'actual final capture body does not match its pinned receipt');
need(metadataArtifact.accountId === accountId && metadataArtifact.readOnly === true
  && metadataArtifact.executesDDL === false, 'actual metadata receipt identity changed');
need(canonical(PROFILE) && (await import('node:crypto')).createHash('sha256').update(canonical(PROFILE)).digest('hex')
  === CANONICAL_INSTALLED_PROFILE_V4_SHA256, 'tracked installed profile is not exact canonical v4');
const sanitizedFixture = JSON.parse(fs.readFileSync(new URL('./actual-metadata-evidence.fixture.json', import.meta.url), 'utf8'));
const sourceInventory = readSourceMigrationInventory(SOURCE_COMMIT);
const capturedClassification = validateInstalledSchemaPreservation({ evidence: sanitizedFixture, sourceCommit: SOURCE_COMMIT,
  sourceRows: sourceInventory.rows, sourceFiles: sourceInventory.files, now: Date.parse(sanitizedFixture.observedAt) });
const offlineAdmission = validateInstalledSchemaPreservationReleaseAdmissionOffline(capturedClassification, {
  sourceCommit: SOURCE_COMMIT, canonicalV4Profile: PROFILE, selectedApp: 'operations',
  baselineCapture: captureArtifact.snapshot, currentCapture: captureArtifact.snapshot,
  now: Date.parse(sanitizedFixture.observedAt),
});
assert.equal(offlineAdmission.offlineOnly, true);
assert.equal(offlineAdmission.applicationSchemaReady, false);

function fakeHttp({ driftCurrentSchema = false } = {}) {
  const workerToApp = Object.fromEntries(Object.entries(PROFILE.workers).map(([app, spec]) => [spec.name, app]));
  let d1Calls = 0;
  const requests = { workerGets: 0, d1Selects: 0 };
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname.includes('/d1/database/')) {
      assert.equal(init.method, 'POST');
      const databaseId = parsed.pathname.match(/\/d1\/database\/([^/]+)\/query/u)?.[1];
      const key = Object.keys(metadataArtifact.databases).find(key =>
        metadataArtifact.databases[key].id.toLowerCase() === databaseId?.toLowerCase());
      assert.ok(key, 'D1 request remained within the two exact databases');
      const database = metadataArtifact.databases[key], app = database.app;
      const sql = JSON.parse(init.body).sql;
      let rows = sql === LEDGER_SQL ? database.ledger : sql === SCHEMA_SQL ? database.schema : null;
      assert.ok(rows, 'metadata reader used only its two pinned SELECTs');
      d1Calls++; requests.d1Selects++;
      if (driftCurrentSchema && d1Calls > 4 && app === 'operations' && sql === SCHEMA_SQL) {
        rows = structuredClone(rows);
        const index = rows.findIndex(row => row && typeof row.name === 'string'
          && !row.name.startsWith('_cf_') && !row.name.startsWith('sqlite_') && typeof row.sql === 'string');
        assert.ok(index >= 0, 'captured application schema object exists');
        rows[index] = { ...rows[index], sql: `${rows[index].sql} ` };
      }
      return new Response(JSON.stringify({ success: true, result: [{ success: true, results: rows,
        database_id: databaseId, meta: { changes: 0, changed_db: false, database_id: databaseId } }] }), { status: 200 });
    }
    assert.equal(init.method, 'GET', 'installation capture remained read-only');
    requests.workerGets++;
    const worker = /\/workers\/scripts\/([^/]+)(.*)$/u.exec(parsed.pathname);
    if (!worker) {
      const modern = /\/workers\/([^/]+)\/versions\/([^/]+)\?include=modules$/u.exec(parsed.pathname + parsed.search);
      assert.ok(modern, 'capture used an approved Worker version GET');
      const app = workerToApp[modern[1]], state = captureArtifact.snapshot[app];
      assert.equal(modern[2], state.version.id);
      return new Response(JSON.stringify({ success: true, result: state.modern }), { status: 200 });
    }
    const app = workerToApp[worker[1]], state = captureArtifact.snapshot[app], suffix = worker[2] + parsed.search;
    assert.ok(state, 'capture used a known Worker');
    let result;
    if (suffix === '/deployments?per_page=1') result = { deployments: [state.deployment] };
    else if (suffix === '/versions?per_page=1') result = { items: [{ id: state.latest }] };
    else if (suffix === `/versions/${state.version.id}`) result = state.version;
    else if (suffix === '/settings') result = state.settings;
    else if (suffix === '/schedules') result = state.schedules;
    else if (suffix.startsWith('/versions/')) result = state.latestVersion;
    assert.ok(result, `${app} capture route was recognized`);
    return new Response(JSON.stringify({ success: true, result }), { status: 200 });
  };
  return { fetchImpl, requests };
}

function sessionFactory(transport) {
  return options => createInstalledSchemaPreservationTestSession({ ...options,
    fetchImpl: transport.fetchImpl, clock: { wallNow: () => Date.now(), monotonicNow: () => performance.now() } });
}
const testAdmission = receipt => isTestInstalledSchemaPreservationAdmission(receipt)
  && Date.now() >= Date.parse(receipt.observedAt) && Date.now() - Date.parse(receipt.observedAt) <= 60_000
  && receipt.baselineAgeMs <= 45 * 60_000;
const envFor = () => ({ CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'fake-test-token-'.padEnd(32, 'x'),
  GITHUB_TOKEN: 'fake-github-token-'.padEnd(32, 'x'), GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1' });

// Client's actual default runtime path reaches exact main CI only after the
// v4 session has performed its baseline/current Worker GETs and D1 SELECTs.
{
  const transport = fakeHttp(); let ciCalls = 0, sessionCalls = 0;
  const env = envFor();
  const runtime = createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit, env,
    triggerRun: { sourceCommit, runId: 678, runAttempt: 3 }, fetchImpl: transport.fetchImpl,
    schemaPreservationSessionFactory: options => { sessionCalls++; return sessionFactory(transport)(options); },
    schemaPreservationAdmissionCheck: testAdmission,
    sourceReader: () => sourceCommit,
    ciFactory: () => ({ verify: async sha => { ciCalls++; return { sourceCommit: sha, passed: true, runId: 678, runAttempt: 3 }; } }),
    providerFactory: () => { throw new Error('provider must not be constructed for ciGate'); },
    journalFactory: () => { throw new Error('journal must not be constructed for ciGate'); },
    migrationReader: () => { throw new Error('stale append-only classifier must not admit v4'); } });
  try {
    const result = await runtime.adapter.ciGate();
    assert.equal(result.passed, true);
    assert.equal(sessionCalls, 1);
    assert.equal(ciCalls, 1);
    assert.ok(transport.requests.workerGets > 0 && transport.requests.d1Selects === 8);
  } finally { runtime.close(); }
}

// A real same-run Operations schema drift is rejected before CI/provider work.
{
  const transport = fakeHttp({ driftCurrentSchema: true }); let ciCalls = 0, providerCalls = 0;
  const triggerRun = { sourceCommit, runId: 678, runAttempt: 3 };
  const runtime = createProductionAutoSyncAdapter({ sourceCommit, triggerRun, env: { ...envFor(),
    PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success', PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: sourceCommit,
    PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: predecessorReleaseId }, fetchImpl: transport.fetchImpl,
    schemaPreservationSessionFactory: options => sessionFactory(transport)(options),
    schemaPreservationAdmissionCheck: testAdmission,
    migrationReader: () => { throw new Error('stale append-only classifier must not admit v4'); },
    ciFactory: () => ({ verify: async sha => { ciCalls++; return { sourceCommit: sha, passed: true, runId: 678, runAttempt: 3 }; } }),
    sourceReader: () => sourceCommit,
    providerFactory: () => { providerCalls++; throw new Error('schema drift must hold before provider creation'); },
    journalFactory: () => { throw new Error('journal must not be created on schema drift'); } });
  try {
    await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/);
    assert.equal(ciCalls, 0);
    assert.equal(providerCalls, 0);
    assert.equal(transport.requests.d1Selects, 8);
  } finally { runtime.close(); }
}

// With unchanged metadata, Ops Sync's exact app-scoped v4 session clears its
// preservation gate and still reaches the existing source/CI fences first.
{
  const transport = fakeHttp(); let ciCalls = 0, providerCalls = 0;
  const triggerRun = { sourceCommit, runId: 678, runAttempt: 3 };
  const runtime = createProductionAutoSyncAdapter({ sourceCommit, triggerRun, env: { ...envFor(),
    PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success', PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: sourceCommit,
    PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: predecessorReleaseId }, fetchImpl: transport.fetchImpl,
    schemaPreservationSessionFactory: options => sessionFactory(transport)(options),
    schemaPreservationAdmissionCheck: testAdmission,
    migrationReader: () => { throw new Error('stale append-only classifier must not admit v4'); },
    sourceReader: () => sourceCommit,
    ciFactory: () => ({ verify: async sha => { ciCalls++; return { sourceCommit: sha, passed: true, runId: 678, runAttempt: 3 }; } }),
    providerFactory: () => { providerCalls++; throw new Error('stop after successful v4, source and CI gates'); },
    journalFactory: () => { throw new Error('journal must not be created before live capture'); } });
  try {
    await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/);
    assert.equal(ciCalls, 1);
    assert.equal(providerCalls, 1);
    assert.equal(transport.requests.d1Selects, 8);
  } finally { runtime.close(); }
}

console.log('Actual-capture runtime acceptance passed: Client CI gate, Ops Sync v4 session plus source/CI gates, and same-run schema-drift refusal.');
