import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionAutoCloudflarePacer, PRODUCTION_AUTO_CF_DISPATCH_PERMIT,
  PRODUCTION_AUTO_CF_FINALIZATION_HEADROOM_MS, PRODUCTION_AUTO_CF_REQUESTS_PER_ASSET_BUCKET,
  PRODUCTION_AUTO_CF_FIXED_REQUEST_HEADROOM, isNativeProductionCloudflareTransport } from './production-auto-cloudflare-pacer.mjs';

const account = 'a'.repeat(32);
const root = `https://api.cloudflare.com/client/v4/accounts/${account}`;

test('pacer shares ordered slots across worker and D1 reads, and requires one exact mutation permit', async () => {
  let clock = 0;
  const delays = [], calls = [];
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, intervalMs: 333,
    now: () => clock, pause: async ms => { delays.push(ms); clock += ms; },
    fetchImpl: async (url, init) => { calls.push({ url: String(url), method: init.method,
      hasPermit: Object.hasOwn(init, PRODUCTION_AUTO_CF_DISPATCH_PERMIT) }); return new Response('{}'); } });
  await pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/settings`, { method: 'GET' });
  await pacer.fetchImpl(`${root}/d1/database/${'b'.repeat(32)}/query`, { method: 'POST' });
  const permit = await pacer.reserve({ path: `/client/v4/accounts/${account}/workers/scripts/ledgetop-ops/deployments`, method: 'POST' });
  await pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, { method: 'POST', [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: permit });
  assert.equal(calls.length, 3);
  assert.deepEqual(delays, [333, 333]);
  assert.equal(calls[2].hasPermit, false);
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, { method: 'POST' }), /permit_invalid/u);
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, {
    method: 'POST', [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: permit }), /permit_invalid/u);
  assert.equal(calls.length, 3);
});

test('canceled, stale, changed-path, and over-budget permits never dispatch', async () => {
  let clock = 0, dispatched = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, intervalMs: 10, maxRunMs: 60_000,
    now: () => clock, pause: async ms => { clock += ms; },
    fetchImpl: async () => { dispatched++; return new Response('{}'); } });
  const path = `/client/v4/accounts/${account}/workers/scripts/ledgetop-ops/deployments`;
  const canceled = await pacer.reserve({ path, method: 'POST' });
  pacer.cancel(canceled);
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, {
    method: 'POST', [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: canceled }), /permit_invalid/u);
  const changed = await pacer.reserve({ path, method: 'POST' });
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/settings`, {
    method: 'POST', [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: changed }), /permit_invalid/u);
  const stale = await pacer.reserve({ path, method: 'POST' });
  clock += 30_001;
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, {
    method: 'POST', [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: stale }), /budget_expired/u);
  assert.equal(dispatched, 0);
});

test('abort after reservation cancels the permit before dispatch', async () => {
  let dispatched = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, noWait: true,
    fetchImpl: async () => { dispatched++; return new Response('{}'); } });
  const controller = new AbortController();
  const path = `/client/v4/accounts/${account}/workers/scripts/ledgetop-ops/deployments`;
  const permit = await pacer.reserve({ path, method: 'POST', signal: controller.signal });
  controller.abort();
  await assert.rejects(pacer.fetchImpl(`${root}/workers/scripts/ledgetop-ops/deployments`, {
    method: 'POST', signal: controller.signal, [PRODUCTION_AUTO_CF_DISPATCH_PERMIT]: permit }), /permit_invalid/u);
  assert.equal(dispatched, 0);
});

test('non-Cloudflare requests bypass the Cloudflare rate queue', async () => {
  let clock = 0, calls = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, intervalMs: 333,
    now: () => clock, pause: async ms => { clock += ms; },
    fetchImpl: async () => { calls++; return new Response('{}'); } });
  await pacer.fetchImpl('https://api.github.com/repos/example/repo', { method: 'GET' });
  assert.equal(calls, 1);
  assert.equal(clock, 0);
});

test('projected request admission rejects work that cannot fit the remaining fixed run window', () => {
  let clock = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, intervalMs: 10, maxRunMs: 60_000,
    now: () => clock, pause: async ms => { clock += ms; }, fetchImpl: async () => new Response('{}') });
  assert.equal(pacer.assertProjectedBudget(5).projectedMs, 50);
  assert.throws(() => pacer.assertProjectedBudget(6_001), /projected_request_budget_exceeded/u);
  clock = 59_950;
  assert.throws(() => pacer.assertProjectedBudget(6), /projected_request_budget_exceeded/u);
});

test('actual hyphenated production D1 identifiers use the read queue without a mutation permit', async () => {
  let dispatched = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account, noWait: true,
    fetchImpl: async () => { dispatched++; return new Response('{}'); } });
  await pacer.fetchImpl(`${root}/d1/database/6ebf7514-d306-4615-ae56-ad869c874dbd/query`, { method: 'POST' });
  assert.equal(dispatched, 1);
  assert.equal(pacer.stats().reads, 1);
  assert.equal(pacer.stats().mutations, 0);
  assert.equal(isNativeProductionCloudflareTransport(pacer.fetchImpl, account), false);
});

test('admission reserves actual remaining verification and cleanup time, not only API slots', () => {
  let clock = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: account,
    now: () => clock, fetchImpl: async () => new Response('{}') });
  const requests = 28 * PRODUCTION_AUTO_CF_REQUESTS_PER_ASSET_BUCKET + PRODUCTION_AUTO_CF_FIXED_REQUEST_HEADROOM;
  assert.equal(pacer.assertProjectedBudget(requests, { reservedMs: PRODUCTION_AUTO_CF_FINALIZATION_HEADROOM_MS }).reservedMs, 720_000);
  clock = 30 * 60_000;
  assert.doesNotThrow(() => pacer.assertProjectedBudget(requests));
  assert.throws(() => pacer.assertProjectedBudget(requests, { reservedMs: PRODUCTION_AUTO_CF_FINALIZATION_HEADROOM_MS }),
    /projected_request_budget_exceeded/u);
});

test('an early-firing timer never lets a request dispatch before its slot, so back-to-back instant reads keep their spacing', async () => {
  // Model libuv: the timer fires 0.4 ms before the requested delay has elapsed on the monotonic clock, and the
  // provider answers instantly. Before the fix the third read was refused (wait computed longer than intervalMs).
  // Early amounts a real timer shows (well under 1 ms); each catch-up pause is at least 1 ms.
  for (const early of [0.4, 0.6, 0.01]) {
    let t = 1_000;
    const dispatched = [];
    const pacer = createProductionAutoCloudflarePacer({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
      fetchImpl: async () => { dispatched.push(t); return new Response('{}'); },
      now: () => t, pause: async ms => { t += Math.max(0, ms - early); } });
    const url = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/workers/scripts/ledgetop-clients/settings';
    for (let i = 0; i < 6; i++) await pacer.fetchImpl(url);
    assert.equal(dispatched.length, 6, `early=${early}`);
    // Every request is sent at or after its own slot (first + i * interval), never before.
    for (let i = 1; i < dispatched.length; i++)
      assert.ok(dispatched[i] >= dispatched[0] + i * 333, `early=${early}: dispatch ${i} at ${dispatched[i] - dispatched[0]} is not before its slot ${i * 333}`);
  }
});

test('a pause that never reaches the slot still fails closed instead of dispatching early', async () => {
  let t = 1_000, sent = 0;
  const pacer = createProductionAutoCloudflarePacer({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
    fetchImpl: async () => { sent++; return new Response('{}'); }, now: () => t, pause: async () => {} });
  const url = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/workers/scripts/ledgetop-clients/settings';
  await pacer.fetchImpl(url);
  await assert.rejects(pacer.fetchImpl(url), /runtime_cloudflare_release_time_budget_exceeded/u);
  assert.equal(sent, 1, 'the second read was never sent early');
});

test('the reviewer counterexample (booked slot 666, early wake 665.5) dispatches at the booked slot, and the run budget still binds', async () => {
  // Booked slots 0, 333, 666, 999...; each wake is 0.5 ms early; the provider answers instantly.
  let t = 0;
  const dispatched = [];
  const pacer = createProductionAutoCloudflarePacer({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51',
    fetchImpl: async () => { dispatched.push(t); return new Response('{}'); }, now: () => t, pause: async ms => { t += Math.max(0, ms - 0.5); } });
  const url = 'https://api.cloudflare.com/client/v4/accounts/846c924bf17bf4f3dd15c97a4c5d1d51/workers/scripts/ledgetop-clients/settings';
  for (let i = 0; i < 4; i++) await pacer.fetchImpl(url);
  assert.deepEqual(dispatched.map(at => at >= [0, 333, 666, 999][dispatched.indexOf(at)]), [true, true, true, true]);
  // Budget exhaustion: a catch-up wait that would cross maxRunMs is refused and nothing is sent.
  let u = 0, sent = 0;
  const tight = createProductionAutoCloudflarePacer({ accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', maxRunMs: 60_000, intervalMs: 333,
    fetchImpl: async () => { sent++; return new Response('{}'); }, now: () => u,
    pause: async ms => { u += ms < 2 ? 60_000 : Math.max(0, ms - 0.5); } });
  await tight.fetchImpl(url);
  await assert.rejects(tight.fetchImpl(url), /runtime_cloudflare_release_time_budget_exceeded/u);
  assert.equal(sent, 1, 'the read past the run budget was never sent');
});
