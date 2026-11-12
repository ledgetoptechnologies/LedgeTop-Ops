import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_BLOCKED_STEPS, PROBE_CLOUDFLARE_ACCOUNT, PROBE_D1_DATABASES, PROBE_STOP, allowedProbeRequest, probeAdapter, probeFetch, requestShape } from './production-auto-readonly-probe.mjs';
import { PRODUCTION_MIGRATION_QUERY } from './production-auto-migration-readiness.mjs';

test('request audit keeps method, host and an id-free path shape only', () => {
  const shape = requestShape('https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/workers/scripts/ledgetop-clients/versions?token=secret#x',
    { method: 'post', body: 'secret body', headers: { Authorization: 'Bearer secret' } });
  assert.deepEqual(shape, { method: 'POST', host: 'api.cloudflare.com', path: '/client/v4/accounts/:id/workers/scripts/ledgetop-clients/versions' });
  assert.ok(!JSON.stringify(shape).includes('secret'));
  assert.deepEqual(requestShape(new URL('https://api.github.com/repos/o/r/actions/runs/43261175765/jobs')),
    { method: 'GET', host: 'api.github.com', path: '/repos/o/r/actions/runs/:id/jobs' });
  assert.deepEqual(requestShape('not a url'), { method: 'UNKNOWN', host: 'unparsed', path: '/' });
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

test('requestShape and the policy read the method the same way for string, URL, Request and init inputs', () => {
  const url = 'https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/runs/1';
  assert.equal(requestShape(url).method, 'GET');
  assert.equal(requestShape(new URL(url)).method, 'GET');
  assert.equal(requestShape(new Request(url)).method, 'GET');
  assert.equal(requestShape(new Request(url, { method: 'POST' })).method, 'POST');
  assert.equal(requestShape(url, { method: 'delete' }).method, 'DELETE');
  assert.equal(requestShape(new Request(url), { method: 'PUT' }).method, 'PUT', 'init overrides the Request method');
  assert.equal(allowedProbeRequest(new Request(url, { method: 'POST' })), false, 'a POST Request object is not read as GET');
});

test('network enforcement is an exact allowlist: pinned reads and exact reviewed D1 SQL only', () => {
  const account = PROBE_CLOUDFLARE_ACCOUNT, db = PROBE_D1_DATABASES[0];
  const cf = `https://api.cloudflare.com/client/v4/accounts/${account}`;
  const d1 = `${cf}/d1/database/${db}/query`;
  const post = (sql, params = []) => ({ method: 'POST', body: JSON.stringify({ sql, params }) });
  // Allowed.
  assert.equal(allowedProbeRequest('https://api.github.com/repos/ledgetoptechnologies/LedgeTop-Ops/actions/runs/1/jobs'), true);
  assert.equal(allowedProbeRequest('https://api.github.com/rate_limit'), true);
  assert.equal(allowedProbeRequest(`${cf}/workers/scripts/ledgetop-clients/versions`), true);
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
    ['delete', `${cf}/workers/scripts/v`, { method: 'DELETE' }],
    ['http', d1.replace('https:', 'http:'), post(PRODUCTION_MIGRATION_QUERY)],
    ['port', d1.replace('api.cloudflare.com', 'api.cloudflare.com:444'), post(PRODUCTION_MIGRATION_QUERY)],
    ['other host', 'https://evil.test/rate_limit', undefined],
  ]) assert.equal(allowedProbeRequest(url, init), false, why);
});

test('a refused request is never forwarded; an allowed one is', async () => {
  const sent = [], refused = [];
  const guarded = probeFetch(async (input, init) => { sent.push(requestShape(input, init)); return new Response('{}'); }, refused);
  await assert.rejects(guarded(`https://api.cloudflare.com/client/v4/accounts/${PROBE_CLOUDFLARE_ACCOUNT}/workers/scripts/x/deployments`, { method: 'POST', body: '{}' }),
    error => error.message === 'probe_refused_non_read_request');
  assert.deepEqual(sent, [], 'nothing reached the network');
  assert.deepEqual(refused, [{ method: 'POST', host: 'api.cloudflare.com', path: '/client/v4/accounts/:id/workers/scripts/x/deployments' }]);
  await guarded('https://api.github.com/rate_limit');
  assert.equal(sent.length, 1);
});
