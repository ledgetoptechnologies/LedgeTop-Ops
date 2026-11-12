import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_BLOCKED_STEPS, PROBE_STOP, allowedProbeRequest, probeAdapter, readOnlySql, requestShape } from './production-auto-readonly-probe.mjs';
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

test('network enforcement: reads pass, a D1 query passes only with read-only SQL, everything else is refused', () => {
  const account = 'a'.repeat(32), db = '12345678-1234-4123-8123-123456789abc';
  const d1 = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${db}/query`;
  const post = sql => ({ method: 'POST', body: JSON.stringify({ sql, params: [] }) });
  assert.equal(allowedProbeRequest('https://api.github.com/repos/o/r/actions/runs/1'), true);
  assert.equal(allowedProbeRequest(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/x`, { method: 'HEAD' }), true);
  assert.equal(allowedProbeRequest(d1, post(PRODUCTION_MIGRATION_QUERY)), true, 'the real migration-readiness read passes');
  assert.equal(allowedProbeRequest(d1, { method: 'POST', body: JSON.stringify([{ sql: 'select 1' }, { sql: 'select 2' }]) }), true);
  for (const [why, url, init] of [
    ['write SQL', d1, post('UPDATE staff_users SET status = 1')],
    ['second statement', d1, post('select 1; delete from t')],
    ['pragma', d1, post('PRAGMA writable_schema = 1')],
    ['batch with one write', d1, { method: 'POST', body: JSON.stringify([{ sql: 'select 1' }, { sql: 'insert into t values (1)' }]) }],
    ['query string', `${d1}?x=1`, post('select 1')],
    ['non-string body', d1, { method: 'POST', body: new Uint8Array([1]) }],
    ['worker version upload', `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/ledgetop-clients/versions`, { method: 'POST', body: '{}' }],
    ['deployment', `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/ledgetop-clients/deployments`, { method: 'POST', body: '{}' }],
    ['journal git write', 'https://api.github.com/repos/o/r/git/blobs', { method: 'POST', body: '{}' }],
    ['delete', `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/v`, { method: 'DELETE' }],
    ['other host', 'https://evil.test/client/v4/accounts/x/d1/database/y/query', post('select 1')],
  ]) assert.equal(allowedProbeRequest(url, init), false, why);
  assert.equal(readOnlySql("select * from t where a = 'drop table x'"), true, 'keywords inside string literals are ignored');
  assert.equal(readOnlySql('select 1 /* ; drop */'), true);
  assert.equal(readOnlySql('select * from t -- ;\n; drop table t'), false);
});
