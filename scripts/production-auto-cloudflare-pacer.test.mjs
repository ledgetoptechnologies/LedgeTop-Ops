import test from 'node:test';
import assert from 'node:assert/strict';
import { createProductionAutoCloudflarePacer, PRODUCTION_AUTO_CF_DISPATCH_PERMIT } from './production-auto-cloudflare-pacer.mjs';

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
