// Canonical installed profile v5 for the automatic release lanes (plan PR 1). Offline only: synthetic states and
// pins; no production value is read. v4 behaviour is covered, unchanged, by the existing suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { PROFILE, canonical, hash, validateInstallation, readCanonicalInstalledProfileV5, validateCanonicalV5AssetAssociation,
  CANONICAL_INSTALLED_PROFILE_V4_SHA256, CANONICAL_INSTALLED_PROFILE_V5_SHA256, HELD_OPS_SYNC_INACTIVE_LATEST,
  ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
  OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT } from './production-deploy.mjs';
import { AUTO_PROFILE, isProductionAutoProfile, productionAutoInstalledPreflight, productionAutoHeldSyncAllowance,
  createProductionAutoReleaseAdapter } from './production-auto-runtime.mjs';
import { syntheticCanonicalV4Installation } from './test-fixtures/ops-staff-directory-synthetic-installation.mjs';
import { createProductionAutoSyncAdapter, syncHeldLatestAdmission, syncReconciliationLatestOwner } from './production-auto-sync-runtime.mjs';
import { ProductionCloudflareProvider } from './production-auto-provider.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
const commit = 'a'.repeat(40), runId = 678, runAttempt = 3;
const ACTIVE = '33333333-3333-4333-8333-333333333333', HELD = '55555555-5555-4555-8555-555555555555';
const CANDIDATE = '77777777-7777-4777-8777-777777777777';
const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
const env = { CLOUDFLARE_ACCOUNT_ID: accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
  GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', PRODUCTION_AUTO_PREDECESSOR_COMPLETION: 'success',
  PRODUCTION_AUTO_PREDECESSOR_SOURCE_SHA: commit, PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: sha(`ledgetop-ops\n${commit}`) };
const githubRateLimit = () => {
  const reset = Math.floor(Date.now() / 1_000) + 3_600;
  return new Response(JSON.stringify({ resources: { core: { limit: 1_000, used: 0, remaining: 1_000, reset } } }),
    { status: 200, headers: { 'Content-Type': 'application/json', 'X-RateLimit-Resource': 'core',
      'X-RateLimit-Limit': '1000', 'X-RateLimit-Remaining': '1000', 'X-RateLimit-Reset': String(reset) } });
};

/** A synthetic Sync state shaped like the AUTO_PROFILE Sync spec, with a held API upload as inactive latest. */
function heldSyncState({ held = true } = {}) {
  const spec = AUTO_PROFILE.workers['ops-sync'];
  const bindings = [...clone(spec.bindings), ...spec.plainNames.map(name => ({ name, type: 'plain_text', text: 'synthetic' }))];
  const resources = { script: { ...clone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' },
    script_runtime: clone(spec.runtime), bindings };
  const state = { deployment: { id: '99999999-9999-4999-8999-999999999999', created_on: '2026-11-13T10:00:00.000000Z',
    strategy: 'percentage', versions: [{ version_id: ACTIVE, percentage: 100 }] }, latest: held ? HELD : ACTIVE,
  version: { id: ACTIVE, resources }, modern: { id: ACTIVE, modules: [{ name: 'index.js', content_base64: Buffer.from('active').toString('base64') }] },
  settings: { ...clone(spec.settings), annotations: { 'workers/message': 'synthetic', 'workers/tag': 'auto-111111111111' }, bindings: clone(bindings) },
  schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'synthetic' })) } };
  if (held) {
    state.latestVersion = { id: HELD, resources: { ...clone(resources), script: { ...clone(resources.script), etag: 'b'.repeat(64), last_deployed_from: 'api' } } };
    state.latestModern = { id: HELD, modules: [{ name: 'index.js', content_base64: Buffer.from('held').toString('base64') }] };
  }
  return state;
}
function pinsFor(state) {
  return Object.freeze({ contract: 'synthetic-held', deploymentId: state.deployment.id, activeVersionId: state.version.id,
    latestVersionId: state.latest, sha256: Object.freeze(Object.fromEntries(['deployment', 'settings', 'schedules', 'version',
      'modern', 'latestVersion', 'latestModern'].map(key => [key, hash(canonical(state[key]))]))) });
}

test('AUTO_PROFILE is the exact frozen canonical v5 profile and selects the v5 preflight for every lane', () => {
  assert.equal(hash(canonical(AUTO_PROFILE)), CANONICAL_INSTALLED_PROFILE_V5_SHA256);
  assert.deepEqual(AUTO_PROFILE, readCanonicalInstalledProfileV5());
  assert.ok(Object.isFrozen(AUTO_PROFILE) && Object.isFrozen(AUTO_PROFILE.workers.operations.script.named_handlers));
  assert.notEqual(AUTO_PROFILE, PROFILE);
  assert.equal(hash(canonical(PROFILE)), CANONICAL_INSTALLED_PROFILE_V4_SHA256, 'the tracked v4 profile is unchanged');
  assert.equal(isProductionAutoProfile(AUTO_PROFILE), true);
  for (const other of [PROFILE, clone(AUTO_PROFILE), readCanonicalInstalledProfileV5(), null])
    assert.equal(isProductionAutoProfile(other), false, 'only the one AUTO_PROFILE object is the lane profile');
  for (const app of ['operations', 'client', 'ops-sync']) {
    assert.deepEqual(productionAutoInstalledPreflight(AUTO_PROFILE, app),
      { ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE, ordinaryFrontendApp: app });
    assert.deepEqual(productionAutoInstalledPreflight(PROFILE, app),
      { ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE, ordinaryFrontendApp: app });
  }
  const altered = clone(AUTO_PROFILE); altered.workers.operations.assetsSHA256 = 'f'.repeat(64);
  assert.deepEqual(productionAutoInstalledPreflight(altered, 'operations'), {});
});

test('v5 admits the Sync installed-control and asset-association exceptions only for the exact v5 profile', () => {
  const v5 = readCanonicalInstalledProfileV5();
  const exactSync = { profile: v5, selectedApp: 'ops-sync', ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'ops-sync' };
  // Reaching the complete-installation check proves the v5 mode/profile/app gate passed.
  assert.throws(() => validateInstallation({}, exactSync), /Existing complete production installation required/u);
  assert.throws(() => validateInstallation({}, { ...exactSync, selectedApp: 'operations' }), /limited to Operations or Client UI plans/u);
  const tampered = clone(v5); tampered.workers['ops-sync'].crons = ['* * * * *'];
  assert.throws(() => validateInstallation({}, { ...exactSync, profile: tampered }), /Unreviewed ordinary frontend accepted profile/u);
  assert.throws(() => validateInstallation({}, { ...exactSync, profile: PROFILE }), /Unreviewed ordinary frontend accepted profile/u,
    'the v5 mode never accepts the v4 profile');
  const override = { assetAssociationOverrides: { operations: { baselineAssets: { config: {} } } } };
  assert.throws(() => validateInstallation({}, { profile: v5, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations', selectedApp: 'operations', ...override }), /Existing complete production installation required/u);
  assert.throws(() => validateInstallation({}, { profile: v5, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations', assetAssociationOverrides: { client: { baselineAssets: { config: {} } } } }),
  /Unreviewed canonical v4 asset association override/u);
  assert.throws(() => validateInstallation({}, { profile: v5, ...override }), /Unreviewed canonical v4 asset association override/u,
    'no override without an explicit canonical mode');
  assert.throws(() => validateInstallation({}, { profile: v5, selectedApp: 'operations', ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V5_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations', opsStaffDirectoryEntrypointContract: OPS_STAFF_DIRECTORY_ENTRYPOINT_CONTRACT }),
  /Ops StaffDirectory entrypoint contract is limited/u, 'the StaffDirectory contract stays limited to v4');
  const baselineAssets = { config: { base_path: '/' } };
  const v5Assets = clone(v5); v5Assets.workers.client.assetsSHA256 = hash(canonical(baselineAssets));
  assert.throws(() => validateCanonicalV5AssetAssociation({ profile: v5Assets, app: 'client', baselineAssets, candidateAssets: clone(baselineAssets) }),
    /Unreviewed canonical v5 asset profile/u, 'an altered profile is not v5');
  assert.throws(() => validateCanonicalV5AssetAssociation({ profile: PROFILE, app: 'client', baselineAssets, candidateAssets: clone(baselineAssets) }),
    /Unreviewed canonical v5 asset profile/u);
  assert.throws(() => validateCanonicalV5AssetAssociation({ profile: v5, app: 'client', baselineAssets, candidateAssets: clone(baselineAssets) }),
    /Unreviewed canonical v5 asset baseline/u);
});

test('the Ops and Client lanes accept AUTO_PROFILE and run the v2 preservation session, never the stale classifier', async () => {
  for (const [workerName, app] of [['ledgetop-clients', 'client'], ['ledgetop-ops', 'operations']]) {
    let sessions = 0, observations = 0;
    const runtime = createProductionAutoReleaseAdapter({ workerName, sourceCommit: commit, env: { ...env,
      PRODUCTION_AUTO_PREDECESSOR_RELEASE_ID: sha(`ledgetop-clients\n${commit}`) },
    triggerRun: { sourceCommit: commit, runId, runAttempt }, profile: AUTO_PROFILE,
    schemaPreservationSessionFactory: async options => {
      sessions++;
      assert.equal(options.canonicalV5Profile, AUTO_PROFILE);
      assert.equal(Object.hasOwn(options, 'canonicalV4Profile'), false);
      assert.equal(options.selectedApp, app);
      assert.equal(options.allowAssetAssociationRotation, true);
      assert.equal(options.allowUnselectedRecapture, false);
      return { observe: async observed => { observations++; assert.deepEqual(observed.allowLatest, {});
        return { status: 'v2', observedAt: new Date().toISOString() }; }, close: () => {} };
    },
    schemaPreservationAdmissionCheck: value => value?.status === 'v2',
    migrationReader: async () => { throw Error('the stale append-only classifier must not run under v5'); },
    ciFactory: () => ({ verify: async sha1 => ({ sourceCommit: sha1, passed: true, runId, runAttempt }) }),
    providerFactory: () => { throw Error('provider must not be constructed in Client ciGate'); },
    journalFactory: () => { throw Error('journal must not be constructed'); } });
    try {
      if (app === 'client') assert.equal((await runtime.adapter.ciGate()).passed, true);
      else await assert.rejects(runtime.adapter.ciGate(), /provider must not be constructed/u, 'Ops builds its predecessor fence after schema and CI');
      assert.equal(sessions, 1); assert.equal(observations, 1);
    } finally { runtime.close(); }
  }
  assert.throws(() => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: commit, env,
    triggerRun: { sourceCommit: commit, runId, runAttempt }, profile: clone(AUTO_PROFILE) }), /runtime_target_or_profile_refused/u);
});

test('owned-inactive supersession stays v4-only: under AUTO_PROFILE an enabled selector is refused', () => {
  assert.throws(() => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit: commit,
    env: { ...env, PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: 'true' },
    triggerRun: { sourceCommit: commit, runId, runAttempt }, profile: AUTO_PROFILE,
    ciFactory: () => ({ verify: async () => { throw Error('unexpected'); } }) }), /runtime_owned_inactive_profile_refused/u);
  for (const value of ['false', '', undefined]) assert.doesNotThrow(() => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients',
    sourceCommit: commit, env: { ...env, ...(value === undefined ? {} : { PRODUCTION_AUTO_OWNED_INACTIVE_SUPERSESSION_ENABLED: value }) },
    triggerRun: { sourceCommit: commit, runId, runAttempt }, profile: AUTO_PROFILE,
    ciFactory: () => ({ verify: async () => { throw Error('unexpected'); } }) }).close());
});

test('the release entry points hand AUTO_PROFILE to their reviewed default factories', () => {
  const runtime = fs.readFileSync(new URL('./production-auto-runtime.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  assert.match(runtime, /const laneProfile = runtimeFactory === createProductionAutoReleaseAdapter \? \{ profile: AUTO_PROFILE \} : \{\};/u);
  const sync = fs.readFileSync(new URL('./production-auto-sync-runtime.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  assert.match(sync, /const laneProfile = runtimeFactory === createProductionAutoSyncAdapter \? \{ profile: AUTO_PROFILE \} : \{\};/u);
  assert.match(sync, /runtimeFactory\(\{ sourceCommit, triggerRun, env, fetchImpl,\n\s+\.\.\.laneProfile, recipientLoader/u);
});

test('v5 Ops and Client captures keep the strict all-Workers latest check and add only the exact pinned held Sync', () => {
  const source = fs.readFileSync(new URL('./production-auto-runtime.mjs', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');
  const body = source.slice(source.indexOf('function validatedCapture('), source.indexOf('function git('));
  assert.ok(body.length > 0 && !/selectedApp/u.test(body), 'the lane capture never selects an app, so no unselected-latest rule applies');
  assert.match(body, /const allowLatest = \{ \.\.\.productionAutoHeldSyncAllowance\(laneProfile, snapshot\),/u);
  const state = heldSyncState(), pins = pinsFor(state);
  assert.deepEqual(productionAutoHeldSyncAllowance(AUTO_PROFILE, { 'ops-sync': state }, pins), { 'ops-sync': HELD });
  for (const profile of [PROFILE, clone(AUTO_PROFILE)])
    assert.deepEqual(productionAutoHeldSyncAllowance(profile, { 'ops-sync': state }, pins), {}, 'v4 and legacy lanes get nothing');
  assert.deepEqual(productionAutoHeldSyncAllowance(AUTO_PROFILE, { 'ops-sync': state }), {}, 'production pins never match synthetic data');
  const wrangler = clone(state); wrangler.latestVersion.resources.script.last_deployed_from = 'wrangler';
  assert.deepEqual(productionAutoHeldSyncAllowance(AUTO_PROFILE, { 'ops-sync': wrangler }, pins), {},
    'a native inactive latest with unchanged resources is not admitted');
  assert.deepEqual(productionAutoHeldSyncAllowance(AUTO_PROFILE, { 'ops-sync': heldSyncState({ held: false }) }, pins), {});
  // Without selectedApp every Worker's latest must equal its active version unless explicitly allowed.
  const { profile, snapshot, reviewedPreflightProfiles } = syntheticCanonicalV4Installation();
  const sync = snapshot['ops-sync'], other = '66666666-6666-4666-8666-666666666666';
  sync.latest = other;
  sync.latestVersion = { id: other, resources: clone(sync.version.resources) };
  sync.latestModern = { id: other, modules: [{ name: 'index.js', content_base64: Buffer.from('other code').toString('base64') }] };
  const options = { profile, reviewedPreflightProfiles, ordinaryFrontendPreflightMode: ORDINARY_FRONTEND_CANONICAL_V4_PREFLIGHT_MODE,
    ordinaryFrontendApp: 'operations' };
  assert.throws(() => validateInstallation(snapshot, { ...options, allowLatest: {} }), /Latest must equal the selected sole active version/u);
  assert.throws(() => validateInstallation(snapshot, { ...options, allowLatest: { 'ops-sync': HELD } }), /Latest must equal/u);
  assert.equal(validateInstallation(snapshot, { ...options, allowLatest: { 'ops-sync': other } }), snapshot);
});

test('held Sync admission is exact: only the pinned held state, and null when latest is the active version', () => {
  const state = heldSyncState(), pins = pinsFor(state);
  assert.equal(syncHeldLatestAdmission(state, pins), HELD);
  assert.equal(syncHeldLatestAdmission(heldSyncState({ held: false }), pins), null);
  assert.throws(() => syncHeldLatestAdmission(state), /sync_held_latest_unadmitted/u, 'production pins never match synthetic data');
  for (const mutate of [s => { s.latestVersion.resources.script.last_deployed_from = 'wrangler'; },
    s => { s.settings.annotations['workers/tag'] = 'auto-222222222222'; }, s => { s.latest = CANDIDATE; },
    s => { s.deployment.versions.push({ version_id: HELD, percentage: 0 }); }, s => { s.latestModern.modules[0].content_base64 = 'eA=='; }]) {
    const changed = clone(state); mutate(changed);
    assert.throws(() => syncHeldLatestAdmission(changed, pins), /sync_held_latest_unadmitted/u);
  }
  assert.equal(HELD_OPS_SYNC_INACTIVE_LATEST.latestVersionId, 'bc65f489-e8dd-4ef8-8411-abca3b3ef464');
});

test('read-only Sync reconciliation owns only the parent, the acknowledged candidate or the re-proven held candidate', () => {
  const state = heldSyncState(), pins = pinsFor(state);
  const base = { expectedActiveVersionId: ACTIVE, candidateVersionId: undefined, acknowledgedVersionId: undefined };
  assert.equal(syncReconciliationLatestOwner({ ...base, state: heldSyncState({ held: false }) }), 'active');
  assert.equal(syncReconciliationLatestOwner({ ...base, state, heldLatestVersionId: HELD, pins }), 'held');
  assert.throws(() => syncReconciliationLatestOwner({ ...base, state }), /sync_reconciliation_latest_unowned/u,
    'without an admitted held id (v4) the held latest stays unowned');
  assert.throws(() => syncReconciliationLatestOwner({ ...base, state, heldLatestVersionId: HELD }), /sync_reconciliation_latest_unowned/u);
  const changed = clone(state); changed.settings.annotations.extra = 'x';
  assert.throws(() => syncReconciliationLatestOwner({ ...base, state: changed, heldLatestVersionId: HELD, pins }), /sync_reconciliation_latest_unowned/u);
  const uploaded = { ...clone(state), latest: CANDIDATE };
  assert.equal(syncReconciliationLatestOwner({ ...base, state: uploaded, candidateVersionId: CANDIDATE, acknowledgedVersionId: CANDIDATE,
    heldLatestVersionId: HELD, pins }), 'candidate');
  assert.throws(() => syncReconciliationLatestOwner({ ...base, state: uploaded, candidateVersionId: CANDIDATE, acknowledgedVersionId: undefined,
    heldLatestVersionId: HELD, pins }), /sync_reconciliation_latest_unowned/u);
  assert.throws(() => syncReconciliationLatestOwner({ ...base, state, candidateVersionId: CANDIDATE, acknowledgedVersionId: CANDIDATE,
    heldLatestVersionId: HELD, pins }), /sync_reconciliation_latest_unowned/u, 'the held candidate is not owned after this run uploads');
});

function syncProviderFactory(syncState, reads) {
  const others = { 'ledgetop-ops': '11111111-1111-4111-8111-111111111111', 'ledgetop-clients': '22222222-2222-4222-8222-222222222222' };
  return () => ({ async get(suffix) {
    reads.push(suffix);
    const worker = suffix.match(/\/workers\/(?:scripts|workers)\/([a-z-]+)/u)?.[1];
    const state = worker === 'ledgetop-ops-sync' ? syncState : (() => { const id = others[worker];
      return { deployment: { id, versions: [{ version_id: id, percentage: 100 }] }, latest: id, version: { id }, modern: { id },
        settings: {}, schedules: { schedules: [] } }; })();
    if (suffix.endsWith('/deployments?per_page=1')) return { deployments: [state.deployment] };
    if (suffix.endsWith('/versions?per_page=1')) return { items: [{ id: state.latest }] };
    if (suffix.endsWith('/settings')) return state.settings;
    if (suffix.endsWith('/schedules')) return state.schedules;
    const id = suffix.match(/\/versions\/([0-9a-f-]{36})/u)?.[1];
    const modern = suffix.endsWith('?include=modules');
    if (id === state.version.id) return modern ? state.modern : state.version;
    if (id === state.latest) return modern ? state.latestModern : state.latestVersion;
    throw Error(`unexpected synthetic read ${suffix}`);
  } });
}

test('the v5 Sync lane feeds its admitted held candidate into the preservation session baseline and every observation', async () => {
  for (const held of [true, false]) {
    const state = heldSyncState({ held }), pins = pinsFor(heldSyncState()), reads = [], sessionOptions = [], observed = [];
    let sourceReads = 0;
    const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit, triggerRun: { sourceCommit: commit, runId, runAttempt }, env,
      profile: AUTO_PROFILE, heldOpsSyncInactiveLatestPins: pins, cloudflarePacerFactory: null,
      fetchImpl: async input => { assert.equal(String(input), 'https://api.github.com/rate_limit'); return githubRateLimit(); },
      providerFactory: syncProviderFactory(state, reads),
      schemaPreservationSessionFactory: async options => { sessionOptions.push(options);
        return { observe: async value => { observed.push(value); return { status: 'v2', observedAt: new Date().toISOString() }; }, close: () => {} }; },
      schemaPreservationAdmissionCheck: value => value?.status === 'v2',
      migrationReader: async () => { throw Error('the stale classifier must not run under v5'); },
      sourceReader: () => { sourceReads++; throw Error('stop after schema admission'); },
      ciFactory: () => ({ verify: async () => { throw Error('CI follows the source fence'); } }),
      journalFactory: () => { throw Error('journal must not be constructed'); } });
    await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/u);
    assert.equal(sessionOptions.length, 1);
    assert.equal(sessionOptions[0].canonicalV5Profile, AUTO_PROFILE);
    assert.equal(sessionOptions[0].selectedApp, 'ops-sync');
    assert.equal(Object.hasOwn(sessionOptions[0], 'allowAssetAssociationRotation'), false);
    if (held) assert.deepEqual(sessionOptions[0].baselineAllowLatest, { 'ops-sync': HELD });
    else assert.equal(Object.hasOwn(sessionOptions[0], 'baselineAllowLatest'), false);
    assert.deepEqual(observed, [{ allowLatest: held ? { 'ops-sync': HELD } : {} }]);
    assert.ok(reads.some(row => row.endsWith(`/ledgetop-ops-sync/versions/${HELD}`)) === held);
    assert.equal(sourceReads, 1);
  }
});

test('the v5 Sync lane refuses an unpinned held latest before any schema session, source or CI read', async () => {
  const state = heldSyncState(), pins = pinsFor(state), reads = [];
  state.latestModern.modules[0].content_base64 = Buffer.from('foreign').toString('base64');
  let sessions = 0;
  const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit, triggerRun: { sourceCommit: commit, runId, runAttempt }, env,
    profile: AUTO_PROFILE, heldOpsSyncInactiveLatestPins: pins, cloudflarePacerFactory: null,
    fetchImpl: async () => { throw Error('no quota read before admission'); }, providerFactory: syncProviderFactory(state, reads),
    schemaPreservationSessionFactory: async () => { sessions++; throw Error('unexpected'); },
    sourceReader: () => { throw Error('unexpected source read'); }, ciFactory: () => ({ verify: async () => { throw Error('unexpected'); } }),
    journalFactory: () => { throw Error('unexpected'); } });
  await assert.rejects(runtime.adapter.release(), /Ops Sync backend release held/u);
  assert.equal(sessions, 0);
  assert.ok(reads.length > 0);
});

test('the Sync provider uploads over a held latest only when told to and only for the exact pinned held state', async () => {
  const state = heldSyncState(), pins = pinsFor(state);
  const map = { version: 3, file: 'index.js', sources: ['a.ts'], sourcesContent: ['x'], mappings: '', names: [] };
  const modules = { js: { bytes: Buffer.from('export default {}'), sha256: sha(Buffer.from('export default {}')) },
    sourceMap: { bytes: Buffer.from(JSON.stringify(map)), sha256: sha(Buffer.from(JSON.stringify(map))) } };
  const annotations = { 'workers/message': `Ops Sync backend release ${commit.slice(0, 12)}`, 'workers/tag': `auto-${commit.slice(0, 12)}` };
  const upload = async (input, resultId = CANDIDATE) => {
    let posts = 0;
    const provider = new ProductionCloudflareProvider({ accountId, token: 'local-test-upload-token'.padEnd(32, 'x'), profile: AUTO_PROFILE,
      fetchImpl: async () => { posts++; return Response.json({ success: true, errors: [], result: { id: resultId } }); },
      recordIntent: async () => {}, persistResponse: async () => {} });
    try { return { result: await provider.createInactiveBackendVersion({ workerName: 'ledgetop-ops-sync', modules, annotations, ...input }), posts }; }
    catch (error) { return { error, posts }; }
  };
  const refused = async input => { const out = await upload(input); assert.ok(out.error, 'refused'); assert.equal(out.posts, 0); };
  await refused({ state });
  await refused({ state, heldInactiveLatest: { versionId: HELD } });
  await refused({ state, heldInactiveLatest: { versionId: HELD, pins: { ...pins, latestVersionId: CANDIDATE } } });
  await refused({ state, heldInactiveLatest: { versionId: CANDIDATE, pins } });
  await refused({ state: heldSyncState({ held: false }), heldInactiveLatest: { versionId: HELD, pins } });
  const ok = await upload({ state, heldInactiveLatest: { versionId: HELD, pins } });
  assert.equal(ok.error, undefined); assert.equal(ok.result.id, CANDIDATE); assert.equal(ok.posts, 1);
  const reused = await upload({ state, heldInactiveLatest: { versionId: HELD, pins } }, HELD);
  assert.ok(reused.error, 'a response naming the held version is not a fresh candidate');
  const plain = await upload({ state: heldSyncState({ held: false }) });
  assert.equal(plain.error, undefined, 'the ordinary latest-equals-parent upload is unchanged');
});
