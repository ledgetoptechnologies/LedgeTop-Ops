import test from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_BLOCKED_STEPS, PROBE_STOP, probeAdapter, requestShape } from './production-auto-readonly-probe.mjs';

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
