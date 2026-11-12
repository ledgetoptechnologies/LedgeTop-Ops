import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_BLOCKED_STEPS, PROBE_CLOUDFLARE_ACCOUNT, PROBE_D1_DATABASES, PROBE_REQUEST_CATEGORIES, PROBE_STOP, allowedProbeRequest, classifyProbeRequest, probeAdapter, probeFetch, refusalRecord } from './production-auto-readonly-guard.mjs';
import { PRODUCTION_MIGRATION_QUERY } from './production-auto-migration-readiness.mjs';

test('refusals are recorded only as a fixed method label and a fixed category, never host, path or body text', () => {
  const leaky = 'https://client-jane-smith.example.com/acme-roof-survey/jane.smith@example.com?token=secret';
  const record = refusalRecord(leaky, { method: 'post', body: 'Jane Smith private body', headers: { Authorization: 'Bearer secret' } });
  assert.deepEqual(record, { method: 'POST', category: 'refused_other_host' });
  assert.doesNotMatch(JSON.stringify(record), /jane|acme|example|token|secret|smith/iu);
  assert.deepEqual(refusalRecord('not a url'), { method: 'OTHER', category: 'refused_invalid_url' });
  assert.deepEqual(refusalRecord('https://api.github.com/rate_limit', { method: 'WEIRDVERB' }).method, 'OTHER');
  assert.ok(PROBE_REQUEST_CATEGORIES.includes(refusalRecord(leaky).category));
  assert.ok(Object.isFrozen(PROBE_REQUEST_CATEGORIES));
});

test('every write-capable adapter step becomes a counted stop and receipts become no-ops', async () => {
  const calls = [];
  const real = Object.fromEntries([...PROBE_BLOCKED_STEPS, 'receipt', 'capture'].map(name => [name, async () => { calls.push(name); return 'real'; }]));
  const counts = { blocked: {}, receiptsSkipped: 0 }, probe = probeAdapter(real, counts);
  for (const step of PROBE_BLOCKED_STEPS) await assert.rejects(probe[step](), error => error.message === PROBE_STOP);
  await probe.receipt({ status: 'started' });
  assert.equal(await probe.capture(), 'real');
  assert.deepEqual(calls, ['capture'], 'no real write step or receipt ran');
  assert.equal(counts.receiptsSkipped, 1);
  assert.deepEqual(Object.keys(counts.blocked).sort(), [...PROBE_BLOCKED_STEPS].sort());
  assert.ok(Object.isFrozen(probe));
});

test('the method is read the same way for string, URL, Request and init inputs', () => {
  const url = 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/runs/1/jobs?filter=latest&per_page=100';
  assert.equal(refusalRecord(url).method, 'GET');
  assert.equal(refusalRecord(new URL(url)).method, 'GET');
  assert.equal(refusalRecord(new Request(url)).method, 'GET');
  assert.equal(refusalRecord(new Request(url, { method: 'POST' })).method, 'POST');
  assert.equal(refusalRecord(url, { method: 'delete' }).method, 'DELETE');
  assert.equal(refusalRecord(new Request(url), { method: 'PUT' }).method, 'PUT', 'init overrides the Request method');
  assert.equal(allowedProbeRequest(url), true);
  assert.equal(allowedProbeRequest(new Request(url, { method: 'POST' })), false, 'a POST Request object is not read as GET');
  assert.equal(classifyProbeRequest(new Request(url, { method: 'POST' })), 'refused_github_write');
});

test('network enforcement is an exact allowlist: pinned reads and exact reviewed D1 SQL only', () => {
  const account = PROBE_CLOUDFLARE_ACCOUNT, db = PROBE_D1_DATABASES[0];
  const cf = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const d1 = `${cf}/d1/database/${db}/query`;
  const post = (sql, params = []) => ({ method: 'POST', body: JSON.stringify({ sql, params }) });
  // Allowed.
  assert.equal(allowedProbeRequest('https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/runs/1/jobs?filter=latest&per_page=100'), true);
  assert.equal(allowedProbeRequest('https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/runs/1/jobs'), false, 'jobs without its exact query');
  assert.equal(allowedProbeRequest('https://api.github.com/rate_limit'), true);
  assert.equal(allowedProbeRequest(`${cf}/workers/scripts/ledgetop-clients/versions?per_page=1`), true);
  assert.equal(allowedProbeRequest(`${cf}/workers/scripts/ledgetop-ops/deployments?per_page=1`), true);
  assert.equal(allowedProbeRequest(`${cf}/workers/workers/ledgetop-ops-sync/versions/11111111-1111-4111-8111-111111111111?include=modules`), true);
  assert.equal(allowedProbeRequest(`${cf}/workers/scripts/ledgetop-clients/settings`, { method: 'HEAD' }), true);
  assert.equal(allowedProbeRequest('https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/commits/main'), true);
  assert.equal(allowedProbeRequest(d1, post(PRODUCTION_MIGRATION_QUERY)), true);
  assert.equal(allowedProbeRequest(d1, { method: 'POST', body: JSON.stringify({ sql: PRODUCTION_MIGRATION_QUERY }) }), true);
  // Refused.
  for (const [why, url, init] of [
    ['other repo', 'https://api.github.com/repos/someone/else/actions/runs/1', undefined],
    ['github write', 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/git/blobs', { method: 'POST', body: '{}' }],
    ['other account', 'https://api.cloudflare.com/client/v4/accounts/' + 'f'.repeat(32) + '/workers/scripts/x', undefined],
    ['other database', `${cf}/d1/database/00000000-0000-4000-8000-000000000000/query`, post(PRODUCTION_MIGRATION_QUERY)],
    ['other read SQL', d1, post('SELECT * FROM staff_users')],
    ['write SQL', d1, post('UPDATE staff_users SET status = 1')],
    ['pragma', d1, post('PRAGMA writable_schema = 1')],
    ['multi-statement', d1, post(PRODUCTION_MIGRATION_QUERY + '; DELETE FROM d1_migrations')],
    ['batch body', d1, { method: 'POST', body: JSON.stringify([{ sql: PRODUCTION_MIGRATION_QUERY }]) }],
    ['params', d1, post(PRODUCTION_MIGRATION_QUERY, ['x'])],
    ['extra key', d1, { method: 'POST', body: JSON.stringify({ sql: PRODUCTION_MIGRATION_QUERY, params: [], extra: 1 }) }],
    ['query string', `${d1}?x=1`, post(PRODUCTION_MIGRATION_QUERY)],
    ['non-string body', d1, { method: 'POST', body: new Uint8Array([1]) }],
    ['version upload', `${cf}/workers/scripts/ledgetop-clients/versions`, { method: 'POST', body: '{}' }],
    ['deployment', `${cf}/workers/scripts/ledgetop-clients/deployments`, { method: 'POST', body: '{}' }],
    ['delete', `${cf}/workers/scripts/ledgetop-ops`, { method: 'DELETE' }],
    ['http', d1.replace('https:', 'http:'), post(PRODUCTION_MIGRATION_QUERY)],
    ['port', d1.replace('api.cloudflare.com', 'api.cloudflare.com:444'), post(PRODUCTION_MIGRATION_QUERY)],
    ['other host', 'https://evil.test/rate_limit', undefined],
    // Unrelated GETs inside the pinned account and repo are refused too.
    ['unrelated account GET', `${cf}/tokens`, undefined],
    ['unrelated worker', `${cf}/workers/scripts/someone-elses-worker`, undefined],
    ['worker secrets', `${cf}/workers/scripts/ledgetop-ops/secrets`, undefined],
    ['extra query field', `${cf}/workers/scripts/ledgetop-clients/versions?per_page=1&x=1`, undefined],
    ['reordered query', `${cf}/workers/scripts/ledgetop-clients/versions?x=1&per_page=1`, undefined],
    ['no query where required', `${cf}/workers/scripts/ledgetop-clients/versions`, undefined],
    ['d1 GET', `${cf}/d1/database/${db}`, undefined],
    ['repo secrets', 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/secrets', undefined],
    ['repo contents', 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/contents/README.md', undefined],
    ['rate_limit with query', 'https://api.github.com/rate_limit?x=1', undefined],
  ]) assert.equal(allowedProbeRequest(url, init), false, why);
});

test('a refused request is never forwarded; an allowed one is', async () => {
  const sent = [], refused = [];
  const guarded = probeFetch(async input => { sent.push(String(input)); return new Response('{}'); }, refused);
  await assert.rejects(guarded(`https://api.cloudflare.com/client/v4/accounts/${PROBE_CLOUDFLARE_ACCOUNT}/workers/scripts/x/deployments`, { method: 'POST', body: '{}' }),
    error => error.message === 'probe_refused_non_read_request');
  assert.deepEqual(sent, [], 'nothing reached the network');
  assert.deepEqual(refused, [{ method: 'POST', category: 'refused_cloudflare_write' }]);
  await assert.rejects(guarded('https://api.cloudflare.com/client/v4/accounts/' + PROBE_CLOUDFLARE_ACCOUNT + '/d1/database/' + PROBE_D1_DATABASES[0] + '/query',
    { method: 'POST', body: JSON.stringify({ sql: 'SELECT email FROM staff_users' }) }), /probe_refused_non_read_request/u);
  assert.deepEqual(sent, [], 'unreviewed SQL never reached the network');
  assert.deepEqual(refused.at(-1), { method: 'POST', category: 'refused_d1_unreviewed_sql' });
  assert.doesNotMatch(JSON.stringify(refused), /staff_users|email|deployments|scripts/u);
  await guarded('https://api.github.com/rate_limit');
  assert.equal(sent.length, 1);
});

test('forwarded reads never follow redirects, whatever the caller or Request asked for', async () => {
  const seen = [], refused = [];
  const guarded = probeFetch(async (input, init) => { seen.push(init?.redirect); return new Response('{}'); }, refused);
  await guarded('https://api.github.com/rate_limit');
  await guarded('https://api.github.com/rate_limit', { redirect: 'follow' });
  await guarded(new Request('https://api.github.com/rate_limit', { redirect: 'follow' }));
  await guarded('https://api.github.com/rate_limit', { redirect: 'manual' });
  assert.deepEqual(seen, ['error', 'error', 'error', 'error']);
  await assert.rejects(guarded(`https://api.cloudflare.com/client/v4/accounts/${PROBE_CLOUDFLARE_ACCOUNT}/tokens`), /probe_refused_non_read_request/u);
  assert.equal(seen.length, 4, 'an unrelated GET is never forwarded');
  assert.deepEqual(refused, [{ method: 'GET', category: 'refused_cloudflare_other_target' }]);
});

test('the probe pins equal the source constants it mirrors', async () => {
  const { PROBE_REVIEWED_SQL } = await import('./production-auto-readonly-guard.mjs');
  const { NATIVE_STAFF_PRODUCTION_TARGET } = await import('./native-staff-cutover-readiness.mjs');
  assert.equal(PROBE_CLOUDFLARE_ACCOUNT, NATIVE_STAFF_PRODUCTION_TARGET.accountId);
  assert.deepEqual(PROBE_REVIEWED_SQL, [PRODUCTION_MIGRATION_QUERY]);
});

test('a copy of the probe outside the repository loads the release modules from an exact checkout', async () => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-outside-'));
  try {
    const copy = path.join(outside, 'production-auto-readonly-probe.mjs');
    fs.copyFileSync(path.join(repo, 'scripts', 'production-auto-readonly-probe.mjs'), copy);
    const probe = await import(pathToFileURL(copy).href);
    const modules = await probe.loadReleaseModules(repo);
    assert.equal(modules.root, fs.realpathSync(repo));
    assert.equal(typeof modules.runProductionAutoRelease, 'function');
    assert.equal(typeof modules.productionAutoStartupFailure, 'function');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

test('the probe runs the real runtime in readonly_diagnostic mode; a hold inside a read step is located by its fixed name', async () => {
  const { runProductionAutoReadonlyProbe, loadReleaseModules } = await import('./production-auto-readonly-probe.mjs');
  const calls = [];
  const adapter = Object.fromEntries(['sourceFence', 'ciGate', 'capture', 'build', 'readLedger', ...PROBE_BLOCKED_STEPS, 'receipt', 'readDeployment']
    .map(name => [name, async () => { calls.push(name); throw Error('runtime_unexpected_capture_change'); }]));
  let gateEnv;
  const result = await runProductionAutoReadonlyProbe({ modules: await loadReleaseModules(),
    env: { PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'false' }, workerName: 'ledgetop-clients',
    fetchImpl: async () => { throw Error('no network'); }, recipientLoader: () => ({}),
    triggerReader: env => { gateEnv = env; return { sourceCommit: 'a'.repeat(40), runId: 1, runAttempt: 1 }; }, sourceReader: () => 'a'.repeat(40),
    runtimeFactory: () => ({ adapter }) });
  assert.equal(gateEnv.PRODUCTION_AUTO_RELEASE_ENABLED, 'false', 'the release gate value is never substituted');
  assert.equal(result.status, 'held_before_first_write');
  assert.equal(result.failedReadStep, 'sourceFence');
  assert.deepEqual(result.readStepsEntered, ['sourceFence']);
  assert.deepEqual(result.readStepsCompleted, []);
  assert.deepEqual(calls, ['sourceFence'], 'nothing after the failing read ran');
  assert.deepEqual(result.blockedSteps, {});
});

test('the probe refuses (held at the gate) when the global release is not exactly OFF', async () => {
  const { runProductionAutoReadonlyProbe, loadReleaseModules } = await import('./production-auto-readonly-probe.mjs');
  let triggered = 0;
  const result = await runProductionAutoReadonlyProbe({ modules: await loadReleaseModules(),
    env: { PRODUCTION_AUTO_DIAGNOSTIC_ENABLED: 'true', PRODUCTION_AUTO_RELEASE_ENABLED: 'true' }, workerName: 'ledgetop-clients',
    recipientLoader: () => ({}), triggerReader: () => { triggered++; }, fetchImpl: async () => { throw Error('no network'); } });
  assert.equal(result.status, 'held_before_first_write');
  assert.equal(result.stage, 'gate');
  assert.equal(triggered, 0);
});
