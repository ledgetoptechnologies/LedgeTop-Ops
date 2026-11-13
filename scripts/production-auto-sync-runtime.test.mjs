import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { exactSyncReady, verifySyncBackendCandidate } from './production-auto-sync-runtime.mjs';
import { createProductionAutoSyncAdapter } from './production-auto-sync-runtime.mjs';
import { PROFILE, canonical } from './production-deploy.mjs';
import { ledgerBytes } from './production-auto-assets.mjs';
import { productionAutoBuildProfileSHA256, productionAutoControlsSHA256 } from './production-auto-runtime.mjs';
import { loadPinnedProductionAutoPost0226PreservationPolicy } from './production-auto-post0226-policy.mjs';
import { POST0226_STAFF_PRESERVATION_CONTRACT } from './ordinary-frontend-authority-post0226.mjs';
import { createProductionAutoCloudflarePacer, PRODUCTION_AUTO_CF_DISPATCH_PERMIT } from './production-auto-cloudflare-pacer.mjs';
import { ProductionCloudflareProvider } from './production-auto-provider.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const parent = '11111111-1111-4111-8111-111111111111';
const candidate = '22222222-2222-4222-8222-222222222222';
const commit = 'a'.repeat(40);
const nativeTarget = { accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd' };
const predecessorEnv = { PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success', PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: commit,
  PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: hash(`ledgetop-ops\n${commit}`) };
const preservationPolicy = loadPinnedProductionAutoPost0226PreservationPolicy();
function preservationObservation(sourceCommit, changes = {}) {
  const baseline = structuredClone(preservationPolicy.baseline);
  return { schemaVersion: 1, contract: POST0226_STAFF_PRESERVATION_CONTRACT, sourceCommit,
    accountId: preservationPolicy.accountId, databaseId: preservationPolicy.databaseId,
    observedAt: new Date().toISOString(), ...baseline, schemaSha256: baseline.loginSchemaSha256, ...changes };
}
function githubRateLimit(remaining = 1_000) {
  const reset = Math.floor(Date.now() / 1_000) + 3_600;
  return new Response(JSON.stringify({ resources: { core: { limit: 1_000, used: 1_000 - remaining, remaining, reset } } }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Resource': 'core',
      'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': String(remaining), 'X-RateLimit-Reset': String(reset) } });
}

test('default Sync schema factory accepts its native paced transport before any quota or CI request', async () => {
  const actualCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: new URL('..', import.meta.url), encoding: 'utf8',
  }).trim();
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    throw Error('intentional native-transport contract stop');
  };
  let runtime;
  try {
    runtime = createProductionAutoSyncAdapter({ sourceCommit: actualCommit,
      triggerRun: { sourceCommit: actualCommit, runId: 123, runAttempt: 1 },
      sourceReader: () => actualCommit,
      env: { CLOUDFLARE_ACCOUNT_ID: nativeTarget.accountId,
        CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: `ghs_${'A'.repeat(260)}.${'B'.repeat(180)}.${'C'.repeat(80)}`,
        GITHUB_RUN_ID: '456', GITHUB_RUN_ATTEMPT: '1',
        PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success',
        PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: actualCommit,
        PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: hash(`ledgetop-ops\n${actualCommit}`) } });
    await assert.rejects(runtime.adapter.release(), /held/);
    assert.equal(requests.length, 1, 'real default factory must reach its first read, rather than reject an unbranded wrapper');
    assert.ok(requests[0].startsWith(`https://api.cloudflare.com/client/v4/accounts/${nativeTarget.accountId}/`));
  } finally {
    runtime?.close();
    globalThis.fetch = originalFetch;
  }
});

test('Sync readiness is exact-source, bounded, and rejects stale or future observations', () => {
  const ready = { schemaVersion: 2, sourceCommit: commit, accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
    databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd', reviewSha256: '1'.repeat(64), cohortSha256: '2'.repeat(64),
    controlPlaneSha256: '3'.repeat(64), observedAt: '2026-10-27T12:00:00.000Z', staffCount: 3, generation: 8 };
  const now = Date.parse(ready.observedAt) + 30_000;
  assert.deepEqual(exactSyncReady(ready, commit, now), ready);
  for (const invalid of [
    { ...ready, sourceCommit: 'b'.repeat(40) }, { ...ready, staffCount: 0 },
    { ...ready, unexpected: true },
    { ...ready, observedAt: new Date(now + 1).toISOString() },
    { ...ready, observedAt: new Date(now - 60_001).toISOString() },
    { ...ready, databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8' },
  ]) assert.throws(() => exactSyncReady(invalid, commit, now));
});

test('Sync v4 preservation refusal stops before CI, staff reads, provider construction and journal writes', async () => {
  let otherCalls = 0;
  const unexpected = () => { otherCalls++; throw Error('unexpected side effect'); };
  const env = { CLOUDFLARE_ACCOUNT_ID: nativeTarget.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', ...predecessorEnv };
  const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit, triggerRun: { sourceCommit: commit, runId: 678, runAttempt: 3 }, env,
    schemaPreservationSessionFactory: async () => { throw Error('schema preservation unavailable'); },
    migrationReader: async () => { throw Error('missing migration'); }, sourceReader: unexpected,
    ciFactory: () => ({ verify: unexpected }), preservationReader: unexpected, providerFactory: unexpected,
    journalFactory: unexpected, fetchImpl: unexpected });
  await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held; inspect the durable journal/);
  assert.equal(otherCalls, 0);
});

test('exact v4 Sync runtime uses its selected ops-sync preservation session before source and CI fences', async () => {
  let sessionCalls = 0, observations = 0, migrationCalls = 0, sourceCalls = 0, ciCalls = 0, providerCalls = 0, closed = 0;
  let schemaTransport, quotaCalls = 0;
  const env = { CLOUDFLARE_ACCOUNT_ID: nativeTarget.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', ...predecessorEnv };
  const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit,
    triggerRun: { sourceCommit: commit, runId: 678, runAttempt: 3 }, env,
    cloudflarePacerFactory: () => {
      schemaTransport = async input => {
        assert.equal(String(input), 'https://api.github.com/rate_limit');
        quotaCalls++;
        return githubRateLimit();
      };
      return { fetchImpl: schemaTransport };
    },
    schemaPreservationSessionFactory: async options => {
      sessionCalls++;
      assert.equal(options.fetchImpl, schemaTransport, 'schema preservation keeps the directly branded paced transport');
      assert.equal(options.selectedApp, 'ops-sync');
      assert.equal(options.allowUnselectedRecapture, false);
      assert.equal(options.allowAssetAssociationRotation, undefined,
        'Sync does not receive the UI asset-association exception');
      return { observe: async () => { observations++; return { status: 'preserved-installed-schema-with-pending-source-migrations',
        observedAt: new Date().toISOString(), baselineAgeMs: 3, applicationSchemaReady: false }; },
        close: () => { closed++; } };
    },
    schemaPreservationAdmissionCheck: value => value?.status === 'preserved-installed-schema-with-pending-source-migrations'
      && value.applicationSchemaReady === false && Date.now() >= Date.parse(value.observedAt)
      && Date.now() - Date.parse(value.observedAt) <= 60_000,
    migrationReader: async () => { migrationCalls++; throw Error('stale classifier must not run for exact v4'); },
    sourceReader: () => { sourceCalls++; throw Error('stop after proving schema session passed'); },
    ciFactory: options => {
      assert.notEqual(options.fetchImpl, globalThis.fetch, 'native fetch selects the default production pacer');
      assert.notEqual(options.fetchImpl, schemaTransport, 'GitHub accounting wraps only the GitHub consumers');
      return { verify: async () => { ciCalls++; throw Error('CI must be after source fence'); } }; },
    providerFactory: () => { providerCalls++; throw Error('provider must not be constructed before source fence'); },
    journalFactory: () => { throw Error('journal must not be constructed'); } });
  await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/);
  await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/);
  assert.equal(sessionCalls, 1);
  assert.equal(observations, 1, 'fresh same-session schema evidence is reused across repeated fences');
  assert.equal(migrationCalls, 0);
  assert.equal(sourceCalls, 2);
  assert.equal(quotaCalls, 2, 'each attempt checks quota after schema admission and before source');
  assert.equal(ciCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(closed, 2);
});

test('Sync candidate proof binds exact API-created code, source map, resources and opaque assets', () => {
  const moduleBytes = Buffer.from('export default {fetch(){return new Response("ok")}};');
  const mapObject = { version: 3, file: 'index.js', sources: ['src/index.ts'], sourcesContent: ['export default {};'], mappings: '', names: [] };
  const mapBytes = Buffer.from(JSON.stringify(mapObject));
  const resources = { script: { handlers: ['fetch'], named_handlers: [] }, script_runtime: { compatibility_date: '2026-07-22' },
    bindings: [{ name: 'OPS_DB', type: 'd1' }] };
  const before = { 'ops-sync': { version: { id: parent, resources }, modern: { assets: null } } };
  const candidateRow = { id: candidate, resources: { ...structuredClone(resources), script: { ...resources.script, last_deployed_from: 'api' } } };
  const modern = { id: candidate, assets: null, modules: [
    { name: 'index.js', content_base64: moduleBytes.toString('base64') },
    { name: 'index.js.map', content_type: 'application/source-map', content_base64: mapBytes.toString('base64') },
  ] };
  assert.deepEqual(verifySyncBackendCandidate({ before, candidate: candidateRow, modern, moduleBytes,
    sourceMap: mapObject, candidateVersionId: candidate }),
  { candidateVersionId: candidate, moduleSHA256: hash(moduleBytes), sourceMapSHA256: hash(mapBytes) });
  assert.throws(() => verifySyncBackendCandidate({ before, candidate: { ...candidateRow,
    resources: { ...candidateRow.resources, bindings: [] } }, modern, moduleBytes, sourceMap: mapObject, candidateVersionId: candidate }));
  assert.throws(() => verifySyncBackendCandidate({ before, candidate: { ...candidateRow,
    resources: { ...candidateRow.resources, script: { ...resources.script, last_deployed_from: 'wrangler' } } },
    modern, moduleBytes, sourceMap: mapObject, candidateVersionId: candidate }));
  assert.throws(() => verifySyncBackendCandidate({ before, candidate: candidateRow,
    modern: { ...modern, modules: [...modern.modules, modern.modules[0]] }, moduleBytes, sourceMap: mapObject, candidateVersionId: candidate }));
});

function fullSnapshotFixture() {
  const original = structuredClone(PROFILE), profile = structuredClone(PROFILE), snapshots = {};
  // This synthetic legacy fixture exercises the strict legacy lane, not the
  // separately pinned canonical-v4 installed-profile acceptance.
  profile.onboardingAdminOrigin = undefined;
  const parentIds = { operations: '11111111-1111-4111-8111-111111111111', client: '22222222-2222-4222-8222-222222222222',
    'ops-sync': parent };
  for (const [app, spec] of Object.entries(profile.workers)) {
    const defaults = awaitlessRead(`apps/${app}/wrangler.jsonc`).vars;
    const vars = Object.fromEntries(spec.plainNames.map(key => [key, defaults[key] ?? 'synthetic-fixture']));
    if (app === 'operations') Object.assign(vars, { DELIVERY_BASE_URL: 'https://portal.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_ADMIN_ENABLED: 'true', CLIENT_ONBOARDING_ADMIN_ORIGIN: 'https://ops.ledgetopdroneservices.com',
      CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED: 'true', CLIENT_ONBOARDING_NOTIFICATIONS_ENABLED: 'true',
      CLIENT_ONBOARDING_NOTIFICATION_STAFF_IDS: '["synthetic-owner"]',
      CLIENT_ONBOARDING_NOTIFICATIONS_NOT_BEFORE: '2026-10-20T00:00:00.000Z',
      PROJECT_ALPHA_DIRECTORY_CREATE_GENERATION_RECOVERY_ENABLED: 'true' });
    if (app === 'client') vars.CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED = 'true';
    for (const key of Object.keys(spec.plainValueSHA256)) spec.plainValueSHA256[key] = hash(vars[key]);
    const bindings = [...structuredClone(spec.bindings), ...Object.entries(vars).map(([name, text]) => ({ name, type: 'plain_text', text }))];
    const assets = app === 'ops-sync' ? null : { config: { ...structuredClone(spec.metadata.assets.config), base_path: '/' }, opaque: `${app}-test-assets` };
    spec.assetsSHA256 = hash(Buffer.from(canonical(assets)));
    const resources = { script: { ...structuredClone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' },
      script_runtime: structuredClone(spec.runtime), bindings };
    const id = parentIds[app];
    snapshots[app] = { deployment: { id, created_on: '2026-10-27T05:00:00.000000Z',
      versions: [{ version_id: id, percentage: 100 }], strategy: 'percentage' }, latest: id,
      version: { id, resources }, modern: { id, assets, modules: [{ name: 'index.js', content_base64: Buffer.from('active').toString('base64') }] },
      settings: { ...structuredClone(spec.settings), annotations: { 'workers/message': 'test', 'workers/triggered_by': 'fixture' }, bindings },
      schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'synthetic' })) } };
  }
  const ops = snapshots.operations, ledger = { schemaVersion: 1, workerName: 'ledgetop-ops',
    accountId: nativeTarget.accountId, sourceCommit: commit, parentVersionId: ops.version.id,
    observedAt: '2026-10-27T05:00:00.000Z', minimumRetentionHours: 48, automaticPruning: false,
    assets: [{ path: '/index.html', size: 5, sha256: hash(Buffer.from('index')),
      mime: 'text/html', providerHash: hash(Buffer.from('index')).slice(0, 32) }] };
  ops.modern.modules.push({ name: '__ops_release_ledger.json', content_base64: ledgerBytes(ledger).toString('base64') });
  Object.assign(PROFILE, profile);
  return { snapshots, restore: () => Object.assign(PROFILE, original) };
}

function awaitlessRead(relative) {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
}

for (const scenario of ['success', 'quota-low-at-start', 'quota-low-before-activation', 'quota-foreign-latest', 'quota-parent-latest', 'quota-controls-drift', 'untrusted-upload-ack', 'dispatch-stale', 'dispatch-aborted', 'dispatch-source-stale', 'dispatch-preflight-delay', 'dispatch-journal-delay',
  'dispatch-queue-delay', 'dispatch-mismatch-request', 'dispatch-mismatch-phase', 'dispatch-mismatch-path',
  'first-write-drift', 'activation-drift', 'post0226-preservation-drift', 'predecessor-missing-artifact',
  'predecessor-ci-mismatch', 'predecessor-live-drift']) test(
  scenario === 'activation-drift'
    ? 'Sync migration drift at activation intent holds without activation dispatch or retry'
    : scenario === 'quota-low-at-start'
      ? 'Sync quota admission holds before source and CI reads when allowance is low'
      : scenario === 'quota-low-before-activation'
        ? 'Sync quota re-admission holds before the second mutation when allowance falls'
    : scenario === 'first-write-drift'
      ? 'Sync migration drift before first mutation prevents upload intent and provider write'
      : 'Sync runtime drives readiness, capture, two durable intents, candidate proof and activation in order', async () => {
  const fixture = fullSnapshotFixture();
  const candidateId = '44444444-4444-4444-8444-444444444444';
  const foreignId = '66666666-6666-4666-8666-666666666666';
  const originalSyncAnnotations = structuredClone(fixture.snapshots['ops-sync'].settings.annotations);
  const deploymentId = '55555555-5555-4555-8555-555555555555';
  const moduleBytes = Buffer.from('export default {fetch(){return new Response("sync")}};');
  const sourceMap = { version: 3, file: 'index.js', sources: ['synthetic.ts'], sourcesContent: ['export default {};'], mappings: '', names: [] };
  const sourceMapBytes = Buffer.from(JSON.stringify(sourceMap));
  const triggerRun = { sourceCommit: commit, runId: 678, runAttempt: 3 };
  const env = { CLOUDFLARE_ACCOUNT_ID: nativeTarget.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1',
    ...predecessorEnv };
  const operations = fixture.snapshots.operations;
  const opsLedger = JSON.parse(Buffer.from(operations.modern.modules.find(row => row.name === '__ops_release_ledger.json').content_base64, 'base64'));
  const predecessorProof = { workerName: 'ledgetop-ops', releaseKind: 'retained-assets', sourceCommit: commit,
    releaseId: env.PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID, ci: { runId: triggerRun.runId, runAttempt: triggerRun.runAttempt },
    workflow: { runId: 789, runAttempt: 1 }, runtime: { profileSha256: productionAutoBuildProfileSHA256(),
      moduleSha256: hash(Buffer.from('active')), ledgerSha256: hash(ledgerBytes(opsLedger)) },
    artifact: { artifactId: 901, digestSha256: 'd'.repeat(64), name: `production-auto-${env.PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID}`,
      runId: 789, runAttempt: 1, uploadStepConclusion: 'success', releaseStepConclusion: 'success' },
    startedReceipt: { status: 'started', phase: 'prepare', writesAttempted: false, parentVersionId: opsLedger.parentVersionId,
      controlsSHA256: productionAutoControlsSHA256(fixture.snapshots, 'operations') },
    finalReceipt: { status: 'verified', sourceCommit: commit, workerName: 'ledgetop-ops', verifiedActive: true,
      candidateVersionId: operations.version.id, deploymentId: operations.deployment.id,
      parentVersionId: opsLedger.parentVersionId,
      minimumRetentionHours: 48, automaticPruning: false, allHistoricalAssetsCarried: true,
      moduleSHA256: hash(Buffer.from('active')), ledgerSHA256: hash(ledgerBytes(opsLedger)) } };
  const suppliedProof = structuredClone(predecessorProof);
  if (scenario === 'predecessor-missing-artifact') suppliedProof.artifact = null;
  if (scenario === 'predecessor-ci-mismatch') suppliedProof.ci.runAttempt += 1;
  if (scenario === 'predecessor-live-drift') operations.deployment.id = '99999999-9999-4999-8999-999999999999';
  const events = [], journalReceipts = [], candidateResources = { ...structuredClone(fixture.snapshots['ops-sync'].version.resources),
    script: { ...structuredClone(fixture.snapshots['ops-sync'].version.resources.script), last_deployed_from: 'api' } };
  const latestCandidate = { id: candidateId, resources: candidateResources };
  const modernCandidate = { id: candidateId, assets: null, modules: [
    { name: 'index.js', content_base64: moduleBytes.toString('base64') },
    { name: 'index.js.map', content_type: 'application/source-map', content_base64: Buffer.from(JSON.stringify({ ...sourceMap,
      sources: sourceMap.sources.map(value => `../../${value}`) }, null, 2)).toString('base64') },
  ] };
  let journalFetch;
  const githubUrl = 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/commits/main';
  const journal = {
    releaseId: '6'.repeat(64), receipt: async value => { if (exercisePacer) await journalFetch(githubUrl);
      journalReceipts.push(structuredClone(value)); events.push(`receipt:${value.status}`); },
    recordIntent: async value => { if (exercisePacer) await journalFetch(githubUrl);
      events.push(`intent:${value.phase}`);
      if (scenario === 'dispatch-source-stale') sourceDrift = true;
      if (scenario === 'dispatch-journal-delay') pacerClock += 30_001;
    },
    persistResponse: async () => { if (exercisePacer) await journalFetch(githubUrl); events.push('response'); },
  };
  let sourceDrift = false;
  const exercisePacer = ['success', 'quota-low-before-activation', 'quota-foreign-latest', 'quota-parent-latest', 'quota-controls-drift', 'dispatch-stale', 'dispatch-aborted', 'dispatch-source-stale',
    'dispatch-preflight-delay', 'dispatch-journal-delay', 'dispatch-queue-delay', 'dispatch-mismatch-request', 'dispatch-mismatch-phase',
    'dispatch-mismatch-path'].includes(scenario);
  const transportCalls = [], cloudflareCalls = [], transport = async (input, init = {}) => {
    const call = { url: String(input), method: String(init.method ?? 'GET').toUpperCase(),
      carriesPermit: Object.hasOwn(init, PRODUCTION_AUTO_CF_DISPATCH_PERMIT) };
    transportCalls.push(call);
    if (call.url === 'https://api.github.com/rate_limit') {
      if (candidateExists && scenario === 'quota-foreign-latest') fixture.snapshots['ops-sync'].latest = foreignId;
      if (candidateExists && scenario === 'quota-parent-latest') {
        fixture.snapshots['ops-sync'].latest = parent;
        fixture.snapshots['ops-sync'].settings.annotations = structuredClone(originalSyncAnnotations);
      }
      if (candidateExists && scenario === 'quota-controls-drift') fixture.snapshots['ops-sync'].settings.annotations.synthetic = 'changed';
      const remaining = scenario.startsWith('quota-') && scenario !== 'quota-low-at-start' && candidateExists ? 0
        : scenario === 'quota-low-at-start' ? 87 : 1_000;
      return githubRateLimit(remaining);
    }
    if (call.url.startsWith('https://api.cloudflare.com/client/v4/accounts/')) {
      cloudflareCalls.push(call);
      pacerClock += 333;
    }
    return new Response('{}');
  };
  let pacer, pacerClock = 0;
  const cloudflareRoot = `https://api.cloudflare.com/client/v4/accounts/${nativeTarget.accountId}`;
  const invokeCloudflare = async (fetch, suffix, init = {}) => {
    if (exercisePacer) await fetch(`${cloudflareRoot}${suffix}`, init);
  };
  let readinessCalls = 0, migrationCalls = 0, candidateExists = false, activated = false, migrationDrift = false, activationMethodCalls = 0, candidateVisibilityAttempts = 0;
  const providerFactory = options => ({
    async getCandidateVersion(workerName, versionId) {
      assert.equal(workerName, 'ledgetop-ops-sync'); assert.equal(versionId, candidateId);
      await invokeCloudflare(options.fetchImpl, `/workers/scripts/${workerName}/versions/${versionId}`);
      candidateVisibilityAttempts++;
      if (candidateVisibilityAttempts === 1)
        throw Object.assign(new Error('synthetic exact transient'), { code: 'candidate_version_not_visible' });
      return latestCandidate;
    },
    async get(suffix) {
      await invokeCloudflare(options.fetchImpl, suffix);
      const worker = suffix.match(/\/workers\/(?:scripts|workers)\/(ledgetop-ops-sync|ledgetop-clients|ledgetop-ops)/u)?.[1];
      const app = worker;
      const source = Object.entries(fixture.snapshots).find(([name]) => PROFILE.workers[name].name === app)?.[1];
      if (suffix.endsWith(`/versions/${candidateId}?include=modules,sourcemaps`)) return modernCandidate;
      if (suffix.endsWith(`/versions/${foreignId}?include=modules`)) return { ...modernCandidate, id: foreignId,
        modules: modernCandidate.modules.filter(row => row.name !== 'index.js.map') };
      if (suffix.endsWith(`/versions/${foreignId}`)) return { ...latestCandidate, id: foreignId };
      if (suffix.endsWith(`/versions/${candidateId}?include=modules`)) return { ...modernCandidate,
        modules: modernCandidate.modules.filter(row => row.name !== 'index.js.map') };
      if (suffix.endsWith(`/versions/${candidateId}`)) return latestCandidate;
      if (app === 'ledgetop-ops-sync' && source) {
        if (suffix.endsWith('/deployments?per_page=1')) return { deployments: [source.deployment] };
        if (suffix.endsWith('/versions?per_page=1')) return { items: [{ id: source.latest }] };
        if (suffix.endsWith('/settings')) return source.settings;
        if (suffix.endsWith('/schedules')) return source.schedules;
        if (suffix.includes('/versions/') && suffix.endsWith('?include=modules')) return source.modern;
        if (suffix.includes(`/versions/${source.deployment.versions[0].version_id}`)) return source.version;
      }
      if (source) {
        if (suffix.endsWith('/deployments?per_page=1')) return { deployments: [source.deployment] };
        if (suffix.endsWith('/versions?per_page=1')) return { items: [{ id: source.latest }] };
        if (suffix.endsWith('/settings')) return source.settings;
        if (suffix.endsWith('/schedules')) return source.schedules;
        if (suffix.includes('/versions/') && suffix.endsWith('?include=modules')) return source.modern;
        if (suffix.includes('/versions/')) return source.version;
      }
      throw Error(`unexpected synthetic provider read: ${suffix}`);
    },
    async createInactiveBackendVersion(input) {
      assert.equal(input.workerName, 'ledgetop-ops-sync');
      const uploadPath = '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict';
      const uploadIntent = { requestId: '77777777-7777-4777-8777-777777777777', method: 'POST',
        path: uploadPath, phase: 'sync-version-upload',
        workerName: 'ledgetop-ops-sync', parentVersionId: parent,
        modules: { 'index.js': hash(moduleBytes), 'index.js.map': hash(sourceMapBytes) }, hashes: [], automaticRetry: false };
      await options.recordIntent(uploadIntent);
      if (exercisePacer) {
        const controller = new AbortController();
        if (scenario === 'dispatch-aborted') controller.abort();
        const { automaticRetry: _automaticRetry, ...dispatchIntent } = uploadIntent;
        const dispatchInfo = { ...dispatchIntent, signal: controller.signal };
        if (scenario === 'dispatch-mismatch-request') dispatchInfo.requestId = '99999999-9999-4999-8999-999999999999';
        if (scenario === 'dispatch-mismatch-phase') dispatchInfo.phase = 'sync-activate-candidate';
        if (scenario === 'dispatch-mismatch-path') dispatchInfo.path = '/workers/scripts/ledgetop-ops-sync/settings';
        const permit = await options.beforeDispatch(dispatchInfo);
        if (scenario === 'dispatch-stale') pacerClock += 30_001;
        await options.fetchImpl(`${cloudflareRoot}${uploadPath}`, { method: 'POST',
          [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: permit });
      }
      candidateExists = true; fixture.snapshots['ops-sync'].latest = candidateId;
      events.push('upload');
      await options.persistResponse({ requestId: '77777777-7777-4777-8777-777777777777', method: 'POST',
        path: '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict', status: 201,
        rawResponse: Buffer.from(JSON.stringify({ success: true, result: { id: candidateId }, errors: [] })) });
      // This deliberately fake dispatch fixture still obtains its ACK object
      // from the real provider consumer. It cannot manufacture a private tag
      // proof with a plain {id} return. No external transport is used here.
      const ack = await new ProductionCloudflareProvider({ accountId: nativeTarget.accountId,
        token: 'local-test-upload-token'.padEnd(32, 'x'), profile: PROFILE,
        fetchImpl: async () => Response.json({ success: true, errors: [], result: { id: candidateId } }),
        recordIntent: async () => {}, persistResponse: async () => {} }).createInactiveBackendVersion(input);
      latestCandidate.annotations = { ...input.annotations, 'workers/triggered_by': 'version_upload' };
      Object.assign(fixture.snapshots['ops-sync'].settings.annotations, latestCandidate.annotations);
      return scenario === 'untrusted-upload-ack' ? { id: candidateId } : ack;
    },
    async activateBackendCandidate(input) {
      assert.deepEqual(input, { workerName: 'ledgetop-ops-sync', parentVersionId: parent,
        candidateVersionId: candidateId, message: `Ops Sync backend release ${commit.slice(0, 12)}` });
      activationMethodCalls++;
      if (scenario === 'activation-drift') migrationDrift = true;
      const activationPath = '/workers/scripts/ledgetop-ops-sync/deployments';
      const activationIntent = { requestId: '88888888-8888-4888-8888-888888888888', method: 'POST',
        path: activationPath, phase: 'sync-activate-candidate', workerName: 'ledgetop-ops-sync',
        parentVersionId: parent, candidateVersionId: candidateId, versions: [{ version_id: candidateId, percentage: 100 }],
        hashes: [], automaticRetry: false };
      await options.recordIntent(activationIntent);
      if (exercisePacer) {
        const { automaticRetry: _automaticRetry, ...dispatchIntent } = activationIntent;
        const permit = await options.beforeDispatch(dispatchIntent);
        await options.fetchImpl(`${cloudflareRoot}${activationPath}`, { method: 'POST',
          [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: permit });
      }
      activated = true;
      const state = fixture.snapshots['ops-sync'];
      state.deployment = { id: deploymentId, created_on: '2026-10-27T06:00:00.123456Z',
        versions: [{ version_id: candidateId, percentage: 100 }], strategy: 'percentage' };
      state.latest = candidateId; state.version = latestCandidate; state.modern = modernCandidate;
      events.push('activate');
      await options.persistResponse({ requestId: '88888888-8888-4888-8888-888888888888', method: 'POST',
        path: '/workers/scripts/ledgetop-ops-sync/deployments', status: 200,
        rawResponse: Buffer.from(JSON.stringify({ success: true, result: { id: deploymentId }, errors: [] })) });
    },
  });
  try {
    const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit, triggerRun, env,
      fetchImpl: exercisePacer ? transport : async input => {
        if (String(input) === 'https://api.github.com/rate_limit') return githubRateLimit(
          scenario === 'quota-low-at-start' ? 87 : 1_000);
        throw Error('no external calls');
      },
      cloudflarePacerFactory: exercisePacer ? options => {
        const inner = createProductionAutoCloudflarePacer({ ...options, noWait: true, now: () => pacerClock });
        pacer = { ...inner, reserve: async reservation => {
          if (scenario === 'dispatch-queue-delay' && reservation.method === 'POST') pacerClock += 30_001;
          return inner.reserve(reservation);
        } };
        return pacer;
      } : null,
      monotonicNow: () => pacerClock,
      sourceReader: () => sourceDrift ? 'b'.repeat(40) : commit,
      ciFactory: ({ fetchImpl }) => { let verifications = 0; return { verify: async sha => {
        verifications++;
        if (scenario === 'dispatch-preflight-delay' && verifications === 2) pacerClock += 30_001;
        if (exercisePacer) await fetchImpl(githubUrl);
        if (exercisePacer) pacerClock += 500;
        return { sourceCommit: sha, passed: true, runId: triggerRun.runId, runAttempt: triggerRun.runAttempt }; } }; },
      providerFactory,
      predecessorReader: async input => { if (exercisePacer) await input.fetchImpl(githubUrl);
        assert.equal(input.workerName, 'ledgetop-ops'); assert.equal(input.releaseKind, 'retained-assets');
        assert.equal(input.ciRunId, triggerRun.runId); assert.equal(input.workflowRunId, 789); return suppliedProof; },
      journalFactory: ({ fetchImpl }) => { journalFetch = fetchImpl; return journal; }, recipientLoader: () => ({ synthetic: 'recipient' }),
      migrationReader: async input => { assert.equal(input.token, env.CLOUDFLARE_API_TOKEN); assert.equal(input.sourceCommit, commit);
        migrationCalls++; return { schemaVersion: 1, sourceCommit: commit,
        accountId: nativeTarget.accountId, observedAt: new Date().toISOString(), databases: [
          { databaseId: nativeTarget.databaseId, sourceInventorySha256: '1'.repeat(64), ledgerNamesSha256: migrationDrift ? '5'.repeat(64) : '2'.repeat(64), migrationCount: 231 },
          { databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8', sourceInventorySha256: '3'.repeat(64), ledgerNamesSha256: '4'.repeat(64), migrationCount: 160 },
        ] }; },
      preservationReader: async ({ sourceCommit }) => {
        readinessCalls++;
        const observation = preservationObservation(sourceCommit);
        if (scenario === 'post0226-preservation-drift' && readinessCalls > 1)
          observation.baseSnapshotSha256 = 'f'.repeat(64);
        return observation;
      },
      buildRunner: () => {}, buildArtifactsReader: () => {
        if (scenario === 'first-write-drift') migrationDrift = true;
        return { moduleBytes, sourceMapBytes };
      } });
    if (scenario !== 'success') {
      await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held; inspect the durable journal/);
      if (scenario === 'quota-low-at-start') {
        assert.equal(candidateExists, false);
        assert.equal(activationMethodCalls, 0);
        assert.equal(events.some(value => value.startsWith('intent:')), false);
        assert.equal(journalReceipts.length, 0, 'insufficient allowance holds before build or journal activity');
        assert.equal(cloudflareCalls.some(call => call.method !== 'GET'), false);
      } else if (scenario === 'untrusted-upload-ack') {
        assert.equal(candidateExists, true);
        assert.equal(activationMethodCalls, 0);
        assert.equal(journalReceipts.at(-1).phase, 'sync-candidate-readback');
        assert.equal(journalReceipts.at(-1).reconciliationCode, 'read_failed',
          'an unbranded acknowledgment must never authorize tag projection');
        assert.equal(journalReceipts.at(-1).reconciliation.readSucceeded, false);
      } else if (['quota-low-before-activation', 'quota-foreign-latest', 'quota-parent-latest', 'quota-controls-drift'].includes(scenario)) {
        assert.equal(candidateExists, true, 'the first inactive upload completed under the initial allowance');
        assert.equal(activationMethodCalls, 0, 'quota is re-admitted before activation intent and fence work');
        assert.equal(events.includes('intent:sync-version-upload'), true);
        assert.equal(events.includes('intent:sync-activate-candidate'), false);
        assert.equal(activated, false);
        assert.equal(journalReceipts.at(-1).status, 'held');
        assert.equal(journalReceipts.at(-1).phase, 'sync-activate');
        const reconciliation = journalReceipts.at(-1);
        if (scenario === 'quota-foreign-latest') assert.equal(reconciliation.reconciliationCode, 'read_failed');
        else {
          assert.equal(reconciliation.reconciliationCode, 'read_succeeded');
          assert.equal(reconciliation.reconciliation.latestVersionId, scenario === 'quota-parent-latest' ? parent : candidateId);
          assert.equal(reconciliation.reconciliation.controlsUnchanged, scenario !== 'quota-controls-drift');
        }
        assert.equal(cloudflareCalls.some(call => call.method === 'POST' && call.url.endsWith('/deployments')), false);
      } else if (scenario.startsWith('predecessor-')) {
        assert.equal(candidateExists, false, 'predecessor refusal occurs before candidate upload');
        assert.equal(activationMethodCalls, 0);
        assert.equal(events.some(value => value.startsWith('intent:')), false, 'predecessor refusal persists no provider intent');
        assert.equal(journalReceipts.length, 0, 'predecessor refusal happens before claiming the Sync journal');
        assert.equal(events.some(value => ['upload','activate'].includes(value)), false);
      } else if (scenario === 'post0226-preservation-drift') {
        assert.equal(candidateExists, false, 'changed fixed preservation state refuses before any upload');
        assert.equal(activationMethodCalls, 0);
        assert.equal(events.some(value => value.startsWith('intent:')), false);
        assert.equal(journalReceipts.length, 0);
      } else if (scenario === 'dispatch-preflight-delay') {
        assert.equal(candidateExists, false, 'expired full preflight cannot reach the provider');
        assert.equal(events.some(value => value.startsWith('intent:')), false, 'no mutation intent is written after stale CI/capture proof');
        assert.equal(cloudflareCalls.some(call => call.method !== 'GET'), false);
        assert.equal(journalReceipts.at(-1).status, 'held');
        assert.equal(journalReceipts.at(-1).writesAttempted, false);
      } else if (scenario.startsWith('dispatch-')) {
        assert.equal(candidateExists, false, 'failed permit prevents candidate upload dispatch');
        assert.equal(activationMethodCalls, 0);
        assert.equal(events.includes('intent:sync-version-upload'), true, 'durable intent is retained for reconciliation');
        assert.equal(cloudflareCalls.some(call => call.method !== 'GET'), false);
        assert.equal(pacer.stats().mutations, 0, 'an aborted, stale, delayed, mismatched, or source-invalid lease never reaches transport');
      } else if (scenario === 'first-write-drift') {
        assert.equal(candidateExists, false, 'no candidate version is uploaded');
        assert.equal(activationMethodCalls, 0);
        assert.equal(events.some(value => value.startsWith('intent:')), false);
        assert.equal(events.some(value => ['upload','activate'].includes(value)), false);
        assert.equal(journalReceipts.length, 0, 'the journal is not claimed before first-write readiness passes');
        assert.ok(migrationCalls >= 2, 'ledger is rechecked after build and before first mutation');
      } else {
        assert.equal(candidateExists, true, 'the already-uploaded inactive candidate remains available for reconciliation');
        assert.equal(activationMethodCalls, 1, 'execution reaches the final activation intent boundary');
        assert.equal(activated, false, 'the provider callback does not proceed after ledger drift');
        assert.equal(events.includes('intent:sync-version-upload'), true);
        assert.equal(events.includes('intent:sync-activate-candidate'), false, 'the activation intent is not journaled after drift');
        assert.equal(events.includes('upload'), true);
        assert.equal(events.includes('activate'), false, 'no activation dispatch occurs');
        assert.equal(events.at(-1), 'receipt:held');
        assert.equal(journalReceipts.at(-1).writesAttempted, true);
        assert.equal(journalReceipts.at(-1).phase, 'sync-activate');
        assert.ok(migrationCalls >= 5, 'ledger is reread after candidate upload and before activation');
      }
    } else {
      const result = await runtime.adapter.release();
      assert.equal(result.verifiedActive, true); assert.equal(result.candidateVersionId, candidateId);
      assert.equal(result.deploymentId, deploymentId); assert.equal(candidateExists, true); assert.equal(activated, true);
      assert.equal(candidateVisibilityAttempts, 2, 'Sync candidate readback uses bounded GET-only visibility retry');
      assert.ok(readinessCalls >= 5, 'native readiness is rechecked at each source/candidate/activation boundary');
      assert.ok(migrationCalls >= 7, 'both migration ledgers are checked before preparation, provider intents and final verification');
      assert.deepEqual(events.filter(value => value.startsWith('intent:')),
        ['intent:sync-version-upload','intent:sync-activate-candidate']);
      assert.equal(events.at(-1), 'receipt:verified');
      assert.deepEqual(events.filter(value => ['upload','activate'].includes(value)), ['upload','activate']);
      assert.equal(activationMethodCalls, 1);
      assert.equal(cloudflareCalls.length, pacer.stats().cloudflareApiRequests);
      assert.ok(transportCalls.some(call => call.url.startsWith('https://api.github.com/')),
        'CI, predecessor and journal use the same apiFetch wrapper; external GitHub requests pass through unpaced');
      assert.ok(pacer.stats().reads > 0, 'Sync capture/read traffic uses the account pacer');
      assert.equal(pacer.stats().mutations, 2, 'both Sync mutations consume exact one-shot permits');
      assert.equal(cloudflareCalls.some(call => call.carriesPermit), false, 'permit metadata is stripped before transport');
    }
  } finally { fixture.restore(); }
});
