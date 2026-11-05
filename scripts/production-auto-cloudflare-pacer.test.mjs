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
