import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { exactSyncReady, verifySyncBackendCandidate } from './production-auto-sync-runtime.mjs';
import { createProductionAutoSyncAdapter } from './production-auto-sync-runtime.mjs';
import { PROFILE, canonical } from './production-deploy.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const parent = '11111111-1111-4111-8111-111111111111';
const candidate = '22222222-2222-4222-8222-222222222222';
const commit = 'a'.repeat(40);
const nativeTarget = { accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', databaseId: '6ebf7514-d306-4615-ae56-ad869c874dbd' };

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
    { name: 'index.js.map', content_base64: mapBytes.toString('base64') },
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
  Object.assign(PROFILE, profile);
  return { snapshots, restore: () => Object.assign(PROFILE, original) };
}

function awaitlessRead(relative) {
  return JSON.parse(readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8'));
}

test('Sync runtime drives readiness, capture, two durable intents, candidate proof and activation in order', async () => {
  const fixture = fullSnapshotFixture();
  const candidateId = '44444444-4444-4444-8444-444444444444';
  const deploymentId = '55555555-5555-4555-8555-555555555555';
  const moduleBytes = Buffer.from('export default {fetch(){return new Response("sync")}};');
  const sourceMap = { version: 3, file: 'index.js', sources: ['synthetic.ts'], sourcesContent: ['export default {};'], mappings: '', names: [] };
  const sourceMapBytes = Buffer.from(JSON.stringify(sourceMap));
  const triggerRun = { sourceCommit: commit, runId: 678, runAttempt: 3 };
  const env = { CLOUDFLARE_ACCOUNT_ID: nativeTarget.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
    GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', NATIVE_STAFF_CUTOVER_REVIEW_JSON: '{"synthetic":true}' };
  const events = [], candidateResources = { ...structuredClone(fixture.snapshots['ops-sync'].version.resources),
    script: { ...structuredClone(fixture.snapshots['ops-sync'].version.resources.script), last_deployed_from: 'api' } };
  const latestCandidate = { id: candidateId, resources: candidateResources };
  const modernCandidate = { id: candidateId, assets: null, modules: [
    { name: 'index.js', content_base64: moduleBytes.toString('base64') },
    { name: 'index.js.map', content_base64: sourceMapBytes.toString('base64') },
  ] };
  const journal = {
    releaseId: '6'.repeat(64), receipt: async value => { events.push(`receipt:${value.status}`); },
    recordIntent: async value => { events.push(`intent:${value.phase}`); },
    persistResponse: async () => { events.push('response'); },
  };
  let readinessCalls = 0, candidateExists = false, activated = false;
  const providerFactory = options => ({
    async get(suffix) {
      const worker = suffix.match(/\/workers\/(?:scripts|workers)\/(ledgetop-ops-sync|ledgetop-clients|ledgetop-ops)/u)?.[1];
      const app = worker;
      const source = Object.entries(fixture.snapshots).find(([name]) => PROFILE.workers[name].name === app)?.[1];
      if (suffix.includes(`/versions/${candidateId}?include=modules`)) return modernCandidate;
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
      await options.recordIntent({ requestId: '77777777-7777-4777-8777-777777777777', method: 'POST',
        path: '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict', phase: 'sync-version-upload',
        workerName: 'ledgetop-ops-sync', parentVersionId: parent,
        modules: { 'index.js': hash(moduleBytes), 'index.js.map': hash(sourceMapBytes) }, hashes: [], automaticRetry: false });
      candidateExists = true; fixture.snapshots['ops-sync'].latest = candidateId;
      events.push('upload');
      await options.persistResponse({ requestId: '77777777-7777-4777-8777-777777777777', method: 'POST',
        path: '/workers/scripts/ledgetop-ops-sync/versions?bindings_inherit=strict', status: 201,
        rawResponse: Buffer.from(JSON.stringify({ success: true, result: { id: candidateId }, errors: [] })) });
      return { id: candidateId };
    },
    async activateBackendCandidate(input) {
      assert.deepEqual(input, { workerName: 'ledgetop-ops-sync', parentVersionId: parent,
        candidateVersionId: candidateId, message: `Ops Sync backend release ${commit.slice(0, 12)}` });
      await options.recordIntent({ requestId: '88888888-8888-4888-8888-888888888888', method: 'POST',
        path: '/workers/scripts/ledgetop-ops-sync/deployments', phase: 'sync-activate-candidate', workerName: 'ledgetop-ops-sync',
        parentVersionId: parent, candidateVersionId: candidateId, versions: [{ version_id: candidateId, percentage: 100 }],
        hashes: [], automaticRetry: false });
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
    const runtime = createProductionAutoSyncAdapter({ sourceCommit: commit, triggerRun, env, fetchImpl: async () => { throw Error('no external calls'); },
      sourceReader: () => commit, ciFactory: () => ({ verify: async sha => ({ sourceCommit: sha, passed: true,
        runId: triggerRun.runId, runAttempt: triggerRun.runAttempt }) }), providerFactory,
      journalFactory: () => journal, recipientLoader: () => ({ synthetic: 'recipient' }),
      readinessReader: async ({ review, sourceCommit }) => { readinessCalls++; assert.deepEqual(review, { synthetic: true });
        return { schemaVersion: 2, sourceCommit, accountId: nativeTarget.accountId, databaseId: nativeTarget.databaseId,
          reviewSha256: '1'.repeat(64), cohortSha256: '2'.repeat(64), controlPlaneSha256: '3'.repeat(64),
          observedAt: new Date().toISOString(), staffCount: 3, generation: 8 }; },
      buildRunner: () => {}, buildArtifactsReader: () => ({ moduleBytes, sourceMapBytes }) });
    const result = await runtime.adapter.release();
    assert.equal(result.verifiedActive, true); assert.equal(result.candidateVersionId, candidateId);
    assert.equal(result.deploymentId, deploymentId); assert.equal(candidateExists, true); assert.equal(activated, true);
    assert.ok(readinessCalls >= 5, 'native readiness is rechecked at each source/candidate/activation boundary');
    assert.deepEqual(events.filter(value => value.startsWith('intent:')),
      ['intent:sync-version-upload','intent:sync-activate-candidate']);
    assert.equal(events.at(-1), 'receipt:verified');
    assert.deepEqual(events.filter(value => ['upload','activate'].includes(value)), ['upload','activate']);
  } finally { fixture.restore(); }
});
