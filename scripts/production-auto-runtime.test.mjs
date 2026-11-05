import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createProductionAutoReleaseAdapter, productionAutoBuildEnvironment, readProductionAutoTriggerRun,
  runProductionAutoRelease, validateDeploymentTransitionIntent } from './production-auto-runtime.mjs';
import { NATIVE_STAFF_PRODUCTION_TARGET } from './native-staff-cutover-readiness.mjs';
import { completeProductionAutoArtifact } from './production-auto-journal-artifact.mjs';
import { PROFILE, canonical } from './production-deploy.mjs';
import { ledgerBytes } from './production-auto-assets.mjs';
import { ProductionCloudflareProvider } from './production-auto-provider.mjs';

const sourceCommit = 'a'.repeat(40), runId = 456, attempt = 2;
const hash = value => createHash('sha256').update(value).digest('hex');
function migrationFixture(commit = sourceCommit) {
  return { schemaVersion: 1, sourceCommit: commit, accountId: NATIVE_STAFF_PRODUCTION_TARGET.accountId,
    observedAt: new Date().toISOString(), databases: [
      { databaseId: NATIVE_STAFF_PRODUCTION_TARGET.databaseId, sourceInventorySha256: '1'.repeat(64), ledgerNamesSha256: '2'.repeat(64), migrationCount: 231 },
      { databaseId: '7f40a7b7-c3ec-470e-a626-e798867f71f8', sourceInventorySha256: '3'.repeat(64), ledgerNamesSha256: '4'.repeat(64), migrationCount: 160 },
    ] };
}
function withEvent(change = value => value, verify = () => {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-trigger-'));
  try {
    const file = path.join(directory, 'event.json');
    const run = { name: 'CI', path: '.github/workflows/ci.yml', event: 'push', status: 'completed', conclusion: 'success',
      head_branch: 'main', head_sha: sourceCommit, run_attempt: attempt, id: runId,
      repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' }, head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' } };
    fs.writeFileSync(file, JSON.stringify({ workflow_run: change(run) }), { flag: 'wx' });
    verify({ GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: file });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

test('only exact successful same-repository main CI completion is admitted as release source', () => {
  withEvent(run => run, env => assert.deepEqual(readProductionAutoTriggerRun(env), { sourceCommit, runId, runAttempt: attempt }));
  for (const workflowPath of ['.github/workflows/ci.yml@main', '.github/workflows/ci.yml@refs/heads/main'])
    withEvent(run => ({ ...run, path: workflowPath }), env => assert.deepEqual(readProductionAutoTriggerRun(env), { sourceCommit, runId, runAttempt: attempt }));
  for (const change of [
    run => ({ ...run, event: 'pull_request' }), run => ({ ...run, head_branch: 'feature' }),
    run => ({ ...run, conclusion: 'failure' }), run => ({ ...run, repository: { full_name: 'fork/repo' } }),
    run => ({ ...run, head_repository: { full_name: 'fork/repo' } }), run => ({ ...run, path: '.github/workflows/other.yml' }),
    run => ({ ...run, path: '.github/workflows/ci.yml@feature' }),
  ]) withEvent(change, env => assert.throws(() => readProductionAutoTriggerRun(env)));
});

test('frontend build child receives no provider, readiness, workflow-output, or Actions credentials', () => {
  const env = productionAutoBuildEnvironment({ PATH: 'safe-path', GITHUB_TOKEN: 'token', CLOUDFLARE_API_TOKEN: 'cf',
    CLOUDFLARE_ACCOUNT_ID: 'account', NATIVE_STAFF_CUTOVER_REVIEW_JSON: 'review', GITHUB_OUTPUT: 'output',
    GITHUB_EVENT_PATH: 'event', ACTIONS_RUNTIME_TOKEN: 'runtime', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'url', NODE_ENV: 'production' });
  assert.deepEqual(env, { PATH: 'safe-path', NODE_ENV: 'production' });
});

function fakeReleaseAdapter(workerName, commit, evidence) {
  const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const parent = '11111111-1111-4111-8111-111111111111', candidate = '22222222-2222-4222-8222-222222222222';
  const firstDeployment = '33333333-3333-4333-8333-333333333333', stagedDeployment = '44444444-4444-4444-8444-444444444444';
  const activeDeployment = '55555555-5555-4555-8555-555555555555', controls = 'c'.repeat(64), module = 'd'.repeat(64);
  const oldBytes = Buffer.from('old'), newBytes = Buffer.from('new');
  const entry = (bytes, assetPath = '/index.html') => ({ path: assetPath, size: bytes.length, sha256: hash(bytes),
    mime: 'text/html', providerHash: hash(bytes).slice(0, 32) });
  const old = { schemaVersion: 1, workerName, accountId, sourceCommit: '9'.repeat(40), parentVersionId: parent,
    observedAt: '2026-10-23T00:00:00.000Z', minimumRetentionHours: 48, automaticPruning: false, assets: [entry(oldBytes)] };
  let current = { activeVersionId: parent, latestVersionId: parent, controlsSHA256: controls, deploymentId: firstDeployment,
    deployedAt: '2026-10-27T05:00:00.000000Z', versions: [{ versionId: parent, percentage: 100 }] };
  let candidateLedger;
  const copy = value => structuredClone(value);
  const adapter = {
    capture: async () => copy(current),
    sourceFence: async () => ({ sourceCommit: commit, mainCommit: commit, clean: true }),
    ciGate: async () => ({ sourceCommit: commit, passed: true }),
    build: async () => ({ sourceCommit: commit, moduleSHA256: module, assets: { entries: [entry(newBytes)], payloads: new Map([['/index.html', newBytes]]) } }),
    readLedger: async () => copy(old),
    readOldAssets: async () => new Map([['/index.html', Buffer.from(oldBytes)]]),
    upload: async input => {
      candidateLedger = input.ledger;
      for (const phase of ['asset-session', 'asset-bucket', 'worker-version-upload'])
        await input.recordIntent({ phase, hashes: [] });
      current.latestVersionId = candidate;
      return { candidateVersionId: candidate, moduleSHA256: module };
    },
    candidateReadback: async input => ({ verified: true, candidateVersionId: candidate, moduleSHA256: module,
      ledgerSHA256: input.ledgerSHA256, controlsSHA256: controls }),
    stageZero: async input => { current = { ...current, deploymentId: stagedDeployment, versions: copy(input.versions), deployedAt: '2026-10-27T06:00:00.123456Z' }; },
    verifyAssets: async input => ({ verified: true, versionRoutingVerified: true, routingDeploymentId: input.routingDeploymentId,
      versionId: input.versionId, ledgerSHA256: input.ledgerSHA256, files: input.ledger.assets.length,
      bytes: input.ledger.assets.reduce((sum, row) => sum + row.size, 0) }),
    activate: async input => { current = { ...current, deploymentId: activeDeployment, activeVersionId: candidate,
      versions: copy(input.versions), deployedAt: '2026-10-27T07:20:51.938465Z' }; },
    readDeployment: async () => copy(current),
    recordIntent: async value => { evidence.intents.push(value.phase); },
    receipt: async value => { evidence.receipts.push(value.status); },
  };
  return adapter;
}

test('runtime entrypoint drives the real coordinator through a complete fake-provider release', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-runtime-success-'));
  try {
    const eventPath = path.join(directory, 'event.json');
    const releaseRunId = 789, releaseAttempt = 1, workerName = 'ledgetop-clients';
    const event = { workflow_run: { name: 'CI', path: '.github/workflows/ci.yml@main', event: 'push', status: 'completed',
      conclusion: 'success', head_branch: 'main', head_sha: sourceCommit, run_attempt: attempt, id: runId,
      repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' },
      head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' } } };
    fs.writeFileSync(eventPath, JSON.stringify(event), { flag: 'wx' });
    const env = { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', PRODUCTION_AUTO_WORKER: workerName,
      CLOUDFLARE_ACCOUNT_ID: NATIVE_STAFF_PRODUCTION_TARGET.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32),
      GITHUB_TOKEN: 'g'.repeat(32), GITHUB_RUN_ID: String(releaseRunId), GITHUB_RUN_ATTEMPT: String(releaseAttempt),
      GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath };
    const evidence = { intents: [], receipts: [] }, recipient = { fixture: 'pinned recipient' };
    let adapterConfig;
    const result = await runProductionAutoRelease({ workerName, env, fetchImpl: async () => { throw Error('unexpected network'); },
      recipientLoader: () => recipient, sourceReader: () => sourceCommit,
      runtimeFactory: options => { adapterConfig = options; return { adapter: fakeReleaseAdapter(workerName, sourceCommit, evidence) }; } });
    assert.equal(result.verifiedActive, true);
    assert.equal(result.minimumRetentionHours, 48);
    assert.equal(result.earliestPermittedPruningAt, '2026-10-29T07:20:51.939Z');
    assert.equal(result.automaticPruning, false);
    assert.equal(adapterConfig.workerName, workerName);
    assert.equal(adapterConfig.sourceCommit, sourceCommit);
    assert.equal(adapterConfig.triggerRun.runId, runId);
    assert.equal(adapterConfig.triggerRun.runAttempt, attempt);
    assert.equal(adapterConfig.recipientLoader(), recipient);
    assert.ok(evidence.intents.includes('activate'));
    assert.equal(evidence.receipts.at(-1), 'verified');
    assert.ok(evidence.receipts.includes('prepared'));
    assert.ok(evidence.receipts.includes('zero-percent-verified'));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

function configuredSnapshotFixture() {
  const accountId = NATIVE_STAFF_PRODUCTION_TARGET.accountId;
  const parentIds = { operations: '11111111-1111-4111-8111-111111111111', client: '22222222-2222-4222-8222-222222222222',
    'ops-sync': '33333333-3333-4333-8333-333333333333' };
  const values = structuredClone(PROFILE), snapshots = {};
  for (const [app, spec] of Object.entries(values.workers)) {
    const defaults = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'apps', app, 'wrangler.jsonc'), 'utf8')).vars;
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
    const parentId = parentIds[app], ledger = app === 'client' ? {
      schemaVersion: 1, workerName: 'ledgetop-clients', accountId, sourceCommit: '9'.repeat(40), parentVersionId: parentId,
      observedAt: '2026-10-23T00:00:00.000Z', minimumRetentionHours: 48, automaticPruning: false,
      assets: [{ path: '/index.html', size: 3, sha256: hash(Buffer.from('old')), mime: 'text/html', providerHash: hash(Buffer.from('old')).slice(0, 32) }],
    } : null;
    const assets = app === 'ops-sync' ? null : { config: { ...structuredClone(spec.metadata.assets.config), base_path: '/' }, opaque: `${app}-synthetic-existing-association` };
    spec.assetsSHA256 = hash(Buffer.from(canonical(assets)));
    const resources = { script: { ...structuredClone(spec.script), etag: 'a'.repeat(64), last_deployed_from: 'wrangler' },
      script_runtime: structuredClone(spec.runtime), bindings };
    const modules = app === 'client' ? [
      { name: 'index.js', content_base64: Buffer.from('old module').toString('base64') },
      { name: '__ops_release_ledger.json', content_base64: ledgerBytes(ledger).toString('base64') },
    ] : [{ name: 'index.js', content_base64: Buffer.from('old module').toString('base64') }];
    snapshots[app] = { parentId, latest: parentId,
      deployment: { id: parentId, created_on: '2026-10-27T05:00:00.000000Z', versions: [{ version_id: parentId, percentage: 100 }], strategy: 'percentage' },
      version: { id: parentId, resources },
      modern: { id: parentId, assets, modules },
      settings: { ...structuredClone(spec.settings), annotations: { 'workers/message': 'fixture', 'workers/triggered_by': 'fixture' }, bindings: structuredClone(bindings) },
      schedules: { schedules: spec.crons.map(cron => ({ cron, created_on: 'synthetic' })) }, ledger };
  }
  const original = structuredClone(PROFILE);
  Object.assign(PROFILE, values);
  return { snapshots, restore: () => Object.assign(PROFILE, original) };
}

test('deployment transition intent binds verified candidate, original parent, coordinator fence and exact weights', () => {
  const parentVersionId = '11111111-1111-4111-8111-111111111111';
  const candidateVersionId = '22222222-2222-4222-8222-222222222222';
  const intent = { phase: 'stage-zero-percent', parentVersionId, candidateVersionId,
    versions: [{ version_id: parentVersionId, percentage: 100 }, { version_id: candidateVersionId, percentage: 0 }] };
  const coordinatorFence = { parentVersionId, candidateVersionId };
  const args = { intent, candidateVersionId, parentVersionId, baselineVersionId: parentVersionId,
    coordinatorFence, candidateReadbackVerified: true };
  assert.deepEqual(validateDeploymentTransitionIntent(args), { activeVersionId: parentVersionId, latestVersionId: candidateVersionId,
    versions: [{ versionId: parentVersionId, percentage: 100 }, { versionId: candidateVersionId, percentage: 0 }] });
  for (const mutate of [
    value => { value.parentVersionId = '33333333-3333-4333-8333-333333333333'; },
    value => { value.candidateVersionId = '33333333-3333-4333-8333-333333333333'; },
    value => { value.intent.versions[1].version_id = '33333333-3333-4333-8333-333333333333'; },
    value => { value.intent.versions[1].percentage = 1; value.intent.versions[0].percentage = 99; },
    value => { value.intent.versions[1].version_id = parentVersionId; },
    value => { value.coordinatorFence.candidateVersionId = '33333333-3333-4333-8333-333333333333'; },
    value => { value.candidateReadbackVerified = false; },
  ]) { const changed = structuredClone(args); mutate(changed); assert.throws(() => validateDeploymentTransitionIntent(changed)); }
  const activate = { ...structuredClone(args), intent: { phase: 'activate-candidate', parentVersionId, candidateVersionId,
    versions: [{ version_id: candidateVersionId, percentage: 100 }] } };
  assert.equal(validateDeploymentTransitionIntent(activate).activeVersionId, candidateVersionId);
  activate.intent.versions.push({ version_id: parentVersionId, percentage: 0 });
  assert.throws(() => validateDeploymentTransitionIntent(activate));
});

for (const scenario of ['success', 'subsequent-release', 'ledger-tampered', 'ledger-version-mismatch', 'old-index-mismatch',
  'known-manual-version-no-bootstrap', 'first-write-drift', 'activation-drift']) test(
  scenario === 'activation-drift'
    ? 'frontend migration drift at activation intent blocks dispatch after earlier writes without retry'
    : scenario === 'subsequent-release'
      ? 'a subsequent P-to-C release reads predecessor ledger lineage from exact active-version modules and verifies old bytes'
      : scenario === 'ledger-tampered'
        ? 'tampered active-version ledger bytes fail before journal claim or provider writes'
        : scenario === 'ledger-version-mismatch'
          ? 'ledger module metadata from a different version fails closed before journal claim or provider writes'
          : scenario === 'old-index-mismatch'
            ? 'an old index body mismatch cleans the verifier and prevents application mutation intents'
            : scenario === 'known-manual-version-no-bootstrap'
              ? 'a known manual-static version with a missing bootstrap pin holds before helper, journal or upload'
    : scenario === 'first-write-drift'
      ? 'frontend migration drift before first mutation prevents journal claim and provider writes'
      : 'real runtime adapter drives provider protocol over fake HTTP with microsecond deployment timestamps', async () => {
  const fixture = configuredSnapshotFixture();
  const clientState = fixture.snapshots.client;
  if (scenario === 'subsequent-release') {
    const predecessor = clientState.parentId;
    const currentActive = '33333333-3333-4333-8333-333333333333';
    clientState.parentId = currentActive;
    clientState.latest = currentActive;
    clientState.deployment = { id: '99999999-9999-4999-8999-999999999999',
      created_on: '2026-10-27T05:00:00.000000Z', versions: [{ version_id: currentActive, percentage: 100 }], strategy: 'percentage' };
    clientState.version.id = currentActive;
    clientState.modern.id = currentActive;
    const priorModule = clientState.modern.modules.find(row => row.name === '__ops_release_ledger.json');
    assert.notEqual(JSON.parse(Buffer.from(priorModule.content_base64, 'base64').toString()).parentVersionId, currentActive,
      'the live ledger records the predecessor version, not its own active version');
    assert.equal(JSON.parse(Buffer.from(priorModule.content_base64, 'base64').toString()).parentVersionId, predecessor);
  } else if (scenario === 'ledger-tampered') {
    const priorModule = clientState.modern.modules.find(row => row.name === '__ops_release_ledger.json');
    priorModule.content_base64 = Buffer.from('tampered').toString('base64');
  } else if (scenario === 'ledger-version-mismatch') {
    clientState.modern.id = '33333333-3333-4333-8333-333333333333';
  } else if (scenario === 'known-manual-version-no-bootstrap') {
    const currentActive = '1c606164-9a98-495a-87c9-3be251658d00';
    clientState.parentId = currentActive;
    clientState.latest = currentActive;
    clientState.deployment = { id: '99999999-9999-4999-8999-999999999999',
      created_on: '2026-10-27T05:00:00.000000Z', versions: [{ version_id: currentActive, percentage: 100 }], strategy: 'percentage' };
    clientState.version.id = currentActive;
    clientState.modern.id = currentActive;
  }
  const calls = [], intents = [], publicReceipts = [], privateResponses = [], verifierVersions = new Map();
  const sourceCommit = 'a'.repeat(40), candidateId = '44444444-4444-4444-8444-444444444444';
  let uploadedLedger;
  const moduleBytes = Buffer.from('export default {fetch(){return new Response("synthetic")}};');
  const sourceMap = { version: 3, file: 'index.js', sources: ['synthetic.ts'], sourcesContent: ['export default {};'], names: [], mappings: 'AAAA' };
  const sourceMapBytes = Buffer.from(JSON.stringify(sourceMap)), newAsset = Buffer.from('new');
  const artifact = { moduleBytes, sourceMapBytes, sourceMap, assets: {
    entries: [{ path: '/index.html', size: newAsset.length, sha256: hash(newAsset), mime: 'text/html', providerHash: hash(newAsset).slice(0, 32) }],
    payloads: new Map([['/index.html', newAsset]]),
  } };
  const ciRun = { id: 678, run_number: 99, run_attempt: 3, name: 'CI', path: '.github/workflows/ci.yml@main', head_sha: sourceCommit,
    head_branch: 'main', event: 'push', status: 'completed', conclusion: 'success', repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' },
    head_repository: { full_name: 'ledgetoptechnologies/LedgeTop-Ops' } };
  const jobs = (await import('./production-auto-ci.mjs')).REQUIRED_MAIN_JOBS.map(name => ({ name, status: 'completed', conclusion: 'success', run_id: ciRun.id, head_sha: sourceCommit }));
  const ok = result => Response.json({ success: true, errors: [], result });

  const apiBase = `https://api.cloudflare.com/client/v4/accounts/${NATIVE_STAFF_PRODUCTION_TARGET.accountId}`;
  const appByWorker = Object.fromEntries(Object.entries(PROFILE.workers).map(([app, spec]) => [spec.name, app]));
  const now = () => fixture.snapshots.client;
  let candidateLegacyReadAttempts = 0, candidateVisibility404s = 1, migrationDrift = false, activationMethodCalls = 0, activationDispatches = 0;
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url); calls.push({ url, method: init.method ?? 'GET', headers: init.headers });
    if (parsed.origin === 'https://api.github.com') {
      if (parsed.pathname.endsWith('/commits/main')) return Response.json({ sha: sourceCommit });
      if (parsed.pathname.endsWith('/actions/workflows/ci.yml/runs')) return Response.json({ total_count: 1, workflow_runs: [ciRun] });
      if (parsed.pathname.endsWith(`/actions/runs/${ciRun.id}/jobs`)) return Response.json({ total_count: jobs.length, jobs });
      throw Error('unexpected synthetic GitHub request');
    }
    if (url.startsWith(apiBase)) {
      const suffix = parsed.pathname.slice(new URL(apiBase).pathname.length) + parsed.search;
      if (suffix === '/workers/subdomain') return ok({ subdomain: 'synthetic-account' });
      const temp = suffix.match(/^\/workers\/scripts\/(ops-ui-verify-[a-f0-9]{24})(?:\/(.*))?$/u);
      if (temp) {
        const [, name, tail] = temp;
        if (init.method === 'GET' && !tail) return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
        if (init.method === 'PUT') {
          const source = await init.body.get('index.js').text();
          verifierVersions.set(name, source.includes(candidateId) ? candidateId : fixture.snapshots.client.parentId);
          return ok({ id: candidateId });
        }
        if (tail === 'settings') return ok({ bindings: [{ name: 'SOURCE_ASSETS', type: 'service', service: 'ledgetop-clients', environment: 'production' }] });
        if (tail === 'subdomain' && init.method === 'POST') return ok({ enabled: true, previews_enabled: false });
        if (tail === 'subdomain') return ok({ enabled: true, previews_enabled: false });
        if (init.method === 'DELETE') return ok({});
      }
      if (suffix === '/workers/scripts/ledgetop-clients/assets-upload-session' && init.method === 'POST') {
        assert.match(init.headers.Authorization, /^Bearer [A-Za-z0-9_-]{32,}$/u);
        return ok({ jwt: 'synthetic.uploadsession.jwt', buckets: [] });
      }
      if (suffix === '/workers/scripts/ledgetop-clients/versions?bindings_inherit=strict' && init.method === 'POST') {
        const metadata = JSON.parse(init.body.get('metadata'));
        assert.equal(metadata.assets.jwt, 'synthetic.uploadsession.jwt');
        const newLedger = JSON.parse(await init.body.get('__ops_release_ledger.json').text());
        uploadedLedger = newLedger;
        assert.equal(newLedger.minimumRetentionHours, 48);
        const state = now(); state.latest = candidateId;
        state.candidateVersion = { id: candidateId, resources: structuredClone(state.version.resources) };
        state.candidateModern = { id: candidateId, assets: structuredClone(state.modern.assets), modules: [
          { name: 'index.js', content_base64: moduleBytes.toString('base64') },
          { name: 'index.js.map', content_base64: sourceMapBytes.toString('base64') },
          { name: '__ops_release_ledger.json', content_base64: Buffer.from(await init.body.get('__ops_release_ledger.json').arrayBuffer()).toString('base64') },
        ] };
        return ok({ id: candidateId });
      }
      const deploymentMatch = suffix.match(/^\/workers\/scripts\/(ledgetop-[a-z-]+)\/deployments$/u);
      if (deploymentMatch && init.method === 'POST') {
        const app = appByWorker[deploymentMatch[1]], state = fixture.snapshots[app], requested = JSON.parse(init.body).versions;
        const candidateRow = requested.find(row => row.version_id === candidateId);
        if (candidateRow?.percentage === 0) state.deployment = { id: '66666666-6666-4666-8666-666666666666', created_on: '2026-10-27T06:00:00.123456Z', versions: requested };
        else { activationDispatches++; state.deployment = { id: '77777777-7777-4777-8777-777777777777', created_on: '2026-10-27T07:20:51.938465Z', versions: requested }; }
        return ok({ id: state.deployment.id });
      }
      const match = suffix.match(/^\/workers\/(scripts|workers)\/([^/]+)(?:\/(.*))?$/u);
      if (!match) throw Error(`unexpected synthetic Cloudflare endpoint: ${suffix}`);
      const [, family, name, tail = ''] = match, app = appByWorker[name], state = fixture.snapshots[app];
      if (!state) throw Error(`unexpected synthetic Worker: ${name}`);
      if (family === 'workers' && tail === `versions/${candidateId}?include=modules`) return ok(state.candidateModern);
      if (family === 'scripts' && tail === 'deployments?per_page=1') return ok({ deployments: [state.deployment] });
      if (family === 'scripts' && tail === 'versions?per_page=1') return ok({ items: [{ id: state.latest }] });
      if (family === 'scripts' && tail === 'settings') return ok(state.settings);
      if (family === 'scripts' && tail === 'schedules') return ok(state.schedules);
      const versionMatch = tail.match(/^versions\/([a-f0-9-]+)$/u);
      if (family === 'scripts' && versionMatch) {
        if (versionMatch[1] === candidateId) {
          candidateLegacyReadAttempts++;
          if (candidateVisibility404s > 0) {
            candidateVisibility404s--;
            return Response.json({ success: false, result: null, errors: [{ code: 100146, message: 'synthetic propagation' }] }, { status: 404 });
          }
          return ok(state.candidateVersion);
        }
        return ok(state.version);
      }
      if (family === 'workers' && /^versions\/[a-f0-9-]+\?include=modules$/u.test(tail)) return ok(state.modern);
      throw Error(`unexpected synthetic Cloudflare route: ${suffix}`);
    }
    const workerMatch = parsed.hostname.match(/^(ops-ui-verify-[a-f0-9]{24})\.synthetic-account\.workers\.dev$/u);
    if (workerMatch) {
      assert.match(init.headers.Authorization, /^Bearer [A-Za-z0-9_-]{43}$/u);
      assert.match(parsed.pathname, /^\/(?:index\.html|_ui\/client\/[a-f0-9]{40}\/index\.html)$/u);
      const archivedAsset = parsed.pathname.startsWith('/_ui/client/');
      const bytes = archivedAsset ? Buffer.from('old')
        : verifierVersions.get(workerMatch[1]) === candidateId ? newAsset
          : scenario === 'old-index-mismatch' ? Buffer.from('bad') : Buffer.from('old');
      return new Response(init.method === 'HEAD' ? null : bytes, { status: 200,
        headers: { 'Content-Type': 'text/html', 'Content-Length': String(bytes.length) } });
    }
    throw Error('unexpected synthetic network destination');
  };
  try {
    const eventPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-actual-runtime-'));
    try {
      const eventPath = path.join(eventPathDir, 'event.json');
      fs.writeFileSync(eventPath, JSON.stringify({ workflow_run: { ...ciRun, run_attempt: ciRun.run_attempt } }), { flag: 'wx' });
      const env = { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', PRODUCTION_AUTO_WORKER: 'ledgetop-clients',
        CLOUDFLARE_ACCOUNT_ID: NATIVE_STAFF_PRODUCTION_TARGET.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32), GITHUB_TOKEN: 'g'.repeat(32),
        GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1', GITHUB_EVENT_NAME: 'workflow_run', GITHUB_EVENT_PATH: eventPath };
      const journalFactory = options => ({
        receipt: async row => { publicReceipts.push(structuredClone(row)); },
        recordIntent: async row => { intents.push(structuredClone(row)); },
        persistResponse: async row => { privateResponses.push({ path: row.path, method: row.method, status: row.status, rawResponseBytes: row.rawResponse?.length ?? 0 }); },
      });
      let migrationCalls = 0;
      const adapterFactory = options => createProductionAutoReleaseAdapter({ ...options, fetchImpl, journalFactory,
        migrationReader: async input => { assert.equal(input.token, env.CLOUDFLARE_API_TOKEN); assert.equal(input.sourceCommit, sourceCommit);
          migrationCalls++; const value = migrationFixture(sourceCommit);
          if (migrationDrift) value.databases[1].ledgerNamesSha256 = '5'.repeat(64);
          return value; },
        providerFactory: providerOptions => {
          const provider = new ProductionCloudflareProvider(providerOptions);
          if (scenario === 'activation-drift') {
            const activate = provider.activateCandidate.bind(provider);
            provider.activateCandidate = input => { activationMethodCalls++; migrationDrift = true; return activate(input); };
          }
          return provider;
        },
        recipientLoader: () => ({ synthetic: true }), sourceReader: () => sourceCommit,
        buildRunner: () => {},
        ...(scenario === 'known-manual-version-no-bootstrap'
          ? { assetBootstrapReader: () => { throw Error('asset_bootstrap_successful_receipt_required'); } } : {}),
        buildArtifactsReader: () => { if (scenario === 'first-write-drift') migrationDrift = true; return artifact; } });
      const release = runProductionAutoRelease({ workerName: 'ledgetop-clients', env, fetchImpl,
        recipientLoader: () => ({ synthetic: true }), triggerReader: () => ({ sourceCommit, runId: ciRun.id, runAttempt: ciRun.run_attempt }),
        sourceReader: () => sourceCommit, runtimeFactory: adapterFactory });
      if (scenario === 'ledger-tampered' || scenario === 'ledger-version-mismatch') {
        await assert.rejects(release, /Automatic release held/);
        assert.equal(publicReceipts.length, 0, 'invalid active ledger is refused before preparation receipt/claim');
        assert.equal(intents.length, 0, 'no provider mutation intent is emitted');
        assert.equal(calls.some(call => call.url.startsWith(apiBase) && call.method !== 'GET'), false,
          'the malformed or mismatched versioned ledger stops before provider writes');
        assert.equal(activationDispatches, 0);
      } else if (scenario === 'old-index-mismatch') {
        await assert.rejects(release, /Automatic release held/);
        assert.equal(intents.some(row => ['asset-session', 'asset-bucket', 'worker-version-upload', 'stage-zero-percent', 'activate-candidate'].includes(row.phase)), false,
          'old-index proof fails before asset upload, version creation, staging, or activation');
        assert.ok(intents.some(row => row.phase === 'temporary-verifier-create'));
        assert.ok(intents.some(row => row.phase === 'temporary-verifier-delete'));
        assert.ok(calls.some(call => call.method === 'DELETE' && call.url.includes('/ops-ui-verify-')));
        assert.equal(calls.some(call => call.url.includes('assets-upload-session') || call.url.endsWith('/deployments')
          || call.url.endsWith('/versions?bindings_inherit=strict')), false);
        assert.equal(activationDispatches, 0);
        assert.equal(publicReceipts.at(-1).status, 'held');
      } else if (scenario === 'first-write-drift') {
        await assert.rejects(release, /Automatic release held/);
        assert.equal(intents.length, 0, 'no mutation intent is persisted');
        assert.equal(publicReceipts.length, 0, 'journal is not claimed before the migration fence passes');
        assert.equal(privateResponses.length, 0);
        assert.equal(calls.some(call => call.url.startsWith(apiBase) && call.method !== 'GET'), false,
          'the preflight migration drift stops before any Cloudflare write');
        assert.equal(activationMethodCalls, 0);
        assert.equal(activationDispatches, 0);
        assert.ok(migrationCalls >= 2, 'the ledger is rechecked after build and before first mutation preparation');
      } else if (scenario === 'known-manual-version-no-bootstrap') {
        await assert.rejects(release, /Automatic release held/);
        assert.equal(intents.length, 0, 'bootstrap refusal occurs before helper or upload mutation intents');
        assert.equal(publicReceipts.length, 0, 'bootstrap refusal occurs before journal claim');
        assert.equal(privateResponses.length, 0);
        assert.equal(calls.some(call => call.url.startsWith(apiBase) && call.method !== 'GET'), false,
          'known manual-static version cannot silently release against its passive incomplete ledger');
        assert.equal(calls.some(call => call.url.includes('/ops-ui-verify-')), false,
          'the verifier helper is not created until an exact successful active receipt is pinned');
        assert.equal(calls.some(call => call.url.includes('assets-upload-session') || call.url.endsWith('/deployments')
          || call.url.endsWith('/versions?bindings_inherit=strict')), false);
      } else if (scenario === 'activation-drift') {
        await assert.rejects(release, /Automatic release held/);
        assert.equal(activationMethodCalls, 1, 'the provider path reaches the activation intent boundary');
        assert.equal(activationDispatches, 0, 'migration drift is checked before activation HTTP dispatch');
        assert.equal(intents.some(row => row.phase === 'activate-candidate'), false, 'the activation intent is not journaled after drift');
        assert.ok(intents.some(row => row.phase === 'worker-version-upload'));
        assert.ok(intents.some(row => row.phase === 'stage-zero-percent'));
        assert.equal(publicReceipts.at(-1).status, 'held');
        assert.equal(publicReceipts.at(-1).writesAttempted, true);
        assert.equal(migrationCalls > 2, true, 'migration state is reread after earlier writes');
        assert.equal(activationDispatches, 0, 'there is no automatic activation retry');
      } else {
        const result = await release;
        assert.equal(result.verifiedActive, true);
        assert.ok(migrationCalls >= intents.length + 2, 'both migration ledgers are checked before provider mutations and during preparation');
        assert.equal(result.cutoverObservedAt, '2026-10-27T07:20:51.938465Z');
        assert.equal(result.earliestPermittedPruningAt, '2026-10-29T07:20:51.939Z');
        assert.equal(result.minimumRetentionHours, 48);
        assert.equal(result.automaticPruning, false);
        if (scenario === 'subsequent-release') {
          assert.equal(uploadedLedger.parentVersionId, '33333333-3333-4333-8333-333333333333',
            'the newly written ledger records the active P version as its predecessor');
        }
        assert(candidateLegacyReadAttempts >= 3, 'one transient candidate GET is retried and later captures remain complete');
        assert.equal(candidateVisibility404s, 0);
        assert.ok(intents.some(row => row.phase === 'temporary-verifier-create'));
        assert.ok(intents.some(row => row.phase === 'asset-session'));
        assert.ok(intents.some(row => row.phase === 'worker-version-upload'));
        assert.ok(intents.some(row => row.phase === 'stage-zero-percent'));
        assert.ok(intents.some(row => row.phase === 'activate-candidate'));
        assert.equal(activationDispatches, 1);
        assert.equal(publicReceipts.at(-1).status, 'verified');
      }
      if (['success', 'subsequent-release', 'activation-drift'].includes(scenario)) {
        assert.ok(privateResponses.length > 0);
        assert.ok(privateResponses.some(row => row.path.endsWith('/assets-upload-session') && row.rawResponseBytes > 0));
        assert.equal(JSON.stringify([...intents, ...publicReceipts]).includes('synthetic.uploadsession.jwt'), false);
        assert.equal(JSON.stringify([...intents, ...publicReceipts]).includes(env.CLOUDFLARE_API_TOKEN), false);
        assert.ok(calls.some(call => call.url.includes('assets-upload-session') && call.headers.Authorization === `Bearer ${env.CLOUDFLARE_API_TOKEN}`));
        assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/assets-upload-session')));
        assert.ok(calls.some(call => call.method === 'POST' && call.url.endsWith('/deployments')));
        assert.ok(calls.some(call => call.method === 'PUT' && call.url.includes('/ops-ui-verify-')));
        assert.ok(calls.some(call => call.url.startsWith('https://ops-ui-verify-')));
      }
    } finally { fs.rmSync(eventPathDir, { recursive: true, force: true }); }
  } finally { fixture.restore(); }
});

test('frontend migration refusal and later ledger drift stop before provider construction', async () => {
  const env = { CLOUDFLARE_ACCOUNT_ID: NATIVE_STAFF_PRODUCTION_TARGET.accountId, CLOUDFLARE_API_TOKEN: 'c'.repeat(32),
    GITHUB_TOKEN: 'g'.repeat(32), GITHUB_RUN_ID: '789', GITHUB_RUN_ATTEMPT: '1' };
  let providers = 0, journals = 0;
  const make = migrationReader => createProductionAutoReleaseAdapter({ workerName: 'ledgetop-clients', sourceCommit, env,
    triggerRun: { sourceCommit, runId, runAttempt: attempt }, migrationReader,
    providerFactory: () => { providers++; throw Error('provider must not be created'); },
    journalFactory: () => { journals++; throw Error('journal must not be created'); },
    ciFactory: () => ({ verify: async () => ({ sourceCommit, passed: true, runId, runAttempt: attempt }) }) }).adapter;
  await assert.rejects(make(async () => { throw Error('ledger missing'); }).ciGate(), /ledger missing/);
  await assert.rejects(make(async () => ({ ...migrationFixture(), sourceCommit: 'b'.repeat(40) })).ciGate());
  let checks = 0;
  const drift = make(async () => { const result = migrationFixture(); if (++checks > 1) result.databases[1].ledgerNamesSha256 = '5'.repeat(64); return result; });
  await drift.ciGate();
  await assert.rejects(drift.ciGate(), /runtime_migration_readiness_drift/);
  assert.equal(providers, 0); assert.equal(journals, 0);
});

test('unprovisioned recipient stops release and artifact completion before provider or GitHub requests', async () => {
  let requests = 0;
  const fetchImpl = async () => { requests++; throw Error('must not fetch'); };
  await assert.rejects(runProductionAutoRelease({ env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', CLOUDFLARE_API_TOKEN: 'private-token' }, fetchImpl }),
    error => !error.message.includes('private-token'));
  await assert.rejects(completeProductionAutoArtifact({ env: { PRODUCTION_AUTO_RELEASE_ENABLED: 'true', GITHUB_TOKEN: 'private-github-token' }, fetchImpl }),
    error => !error.message.includes('private-github-token'));
  assert.equal(requests, 0);
});
