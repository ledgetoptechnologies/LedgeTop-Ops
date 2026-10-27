import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createApprovedExecutorD1Provider, runNativeStaffBootstrapApprovedExecutor } from './native-staff-bootstrap-approved-executor.mjs';
import { loadPinnedNativeStaffBootstrapExecutorConfig } from './native-staff-bootstrap-approved-executor-config.mjs';

const config = Object.freeze({ target: Object.freeze({
  accountId: '846c924bf17bf4f3dd15c97a4c5d1d51', databaseId: '9aeec655-69dd-466c-b1a4-b134d081a746',
}) });
const ok = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });

test('production config boundary fails closed while the source pin is unprovisioned', () => {
  assert.throws(() => loadPinnedNativeStaffBootstrapExecutorConfig(), /trust_config_pin_unprovisioned/);
});

test('executor core refuses to start before issuer distribution pinning without fetching credentials', async () => {
  let fetched = false;
  await assert.rejects(runNativeStaffBootstrapApprovedExecutor({ artifact: {}, receipt: {}, getAccessToken: async () => 'unused',
    getBearerToken: async () => 'unused', fetchImpl: async () => { fetched = true; throw new Error('must-not-fetch'); } }),
  /issuer_distribution_pin_not_provisioned/);
  assert.equal(fetched, false);
});

test('the production CLI remains fail-closed with an unprovisioned distribution pin', () => {
  const script = fileURLToPath(new URL('./native-staff-bootstrap-approved-executor.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', windowsHide: true,
    timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, 'native_staff_bootstrap_executor_unavailable\n');
});

test('approved executor provider pins metadata and preserves typed D1 bindings', async () => {
  const calls = [];
  const provider = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'token-that-never-appears-in-output',
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      if (init.method === 'GET') return ok({ success: true, result: { uuid: config.target.databaseId, name: 'operations-db' } });
      const request = JSON.parse(init.body);
      return ok({ success: true, result: request.batch.map(() => ({ success: true, results: [{ value: 1 }] })) });
    } });
  assert.deepEqual(await provider.assertTarget(), { databaseId: config.target.databaseId, name: 'operations-db' });
  const row = await provider.prepare('SELECT ?, ?, ?, ?').bind('UTF-8 “value”', 7, null, 1.25).first();
  assert.deepEqual(row, { value: 1 });
  const post = calls[1];
  assert.equal(post.url, `https://api.cloudflare.com/client/v4/accounts/${config.target.accountId}/d1/database/${config.target.databaseId}/query`);
  assert.equal(post.init.redirect, 'manual');
  assert.deepEqual(JSON.parse(post.init.body), { batch: [{ sql: 'SELECT ?, ?, ?, ?', params: ['UTF-8 “value”', 7, null, 1.25] }] });
  assert.equal(post.init.headers.Authorization, 'Bearer token-that-never-appears-in-output');
});

test('approved executor refuses SQL before exact target metadata succeeds', async () => {
  const provider = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'test-bearer-token-1234567890',
    fetchImpl: async () => ok({ success: true, result: { uuid: '11111111-1111-4111-8111-111111111111', name: 'other' } }) });
  await assert.rejects(provider.assertTarget(), /provider_target_mismatch/);
  await assert.rejects(provider.prepare('SELECT 1').all(), /provider_batch_invalid/);
});

test('approved executor refuses redirects and never retries uncertain requests', async () => {
  let requests = 0;
  const provider = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'test-bearer-token-1234567890',
    fetchImpl: async () => {
      requests++;
      return new Response('', { status: 302, headers: { location: 'https://attacker.invalid/' } });
    } });
  await assert.rejects(provider.assertTarget(), /provider_redirect_refused/);
  assert.equal(requests, 1);
});

test('approved executor refuses incomplete, failed and extra D1 result shapes', async t => {
  for (const result of [
    [],
    [{ success: false, results: [] }],
    [{ results: [] }],
    [{ success: true }],
    [{ success: true, results: [] }, { success: true, results: [] }],
  ]) {
    await t.test(JSON.stringify(result), async () => {
      const provider = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'test-bearer-token-1234567890',
        fetchImpl: async (_url, init) => init.method === 'GET'
          ? ok({ success: true, result: { uuid: config.target.databaseId, name: 'operations-db' } })
          : ok({ success: true, result }) });
      await provider.assertTarget();
      await assert.rejects(provider.prepare('SELECT 1').all(), /d1_batch_outcome_uncertain/);
    });
  }
});

test('approved executor rejects unsupported parameter coercion and oversized response declarations', async () => {
  const provider = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'test-bearer-token-1234567890',
    fetchImpl: async (_url, init) => init.method === 'GET'
      ? ok({ success: true, result: { uuid: config.target.databaseId, name: 'operations-db' } })
      : ok({ success: true, result: [{ success: true, results: [] }] }) });
  await provider.assertTarget();
  await assert.rejects(provider.prepare('SELECT ?').bind(true).all(), /provider_batch_invalid/);
  const oversized = createApprovedExecutorD1Provider({ config, getBearerToken: () => 'test-bearer-token-1234567890',
    fetchImpl: async () => new Response('{}', { status: 200, headers: { 'content-length': String(9 * 1024 * 1024) } }) });
  await assert.rejects(oversized.assertTarget(), /response_too_large/);
});
