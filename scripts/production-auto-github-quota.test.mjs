import test from 'node:test';
import assert from 'node:assert/strict';
import { assertProductionAutoGitHubQuota, modeledProductionAutoGitHubCoreCalls,
  validateProductionAutoGitHubCoreRateLimit } from './production-auto-github-quota.mjs';

const TOKEN = 'g'.repeat(32);
function response({ body = { resources: { core: { limit: 1_000, used: 0, remaining: 1_000,
  reset: Math.floor(Date.now() / 1_000) + 3_600 } } }, remaining = body.resources?.core?.remaining,
  headerRemaining = remaining, headers = true, status = 200 } = {}) {
  const reset = body.resources?.core?.reset ?? Math.floor(Date.now() / 1_000) + 3_600;
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json',
    ...(headers ? { 'X-RateLimit-Resource': 'core', 'X-RateLimit-Limit': '1000',
      'X-RateLimit-Remaining': String(headerRemaining), 'X-RateLimit-Reset': String(reset) } : {}) } });
}

test('modeled primary quota covers B1 and B28 for both ordinary frontend lanes', () => {
  assert.equal(modeledProductionAutoGitHubCoreCalls({ workerName: 'ledgetop-ops', bucketCount: 1 }), 241);
  assert.equal(modeledProductionAutoGitHubCoreCalls({ workerName: 'ledgetop-ops', bucketCount: 28 }), 592);
  assert.equal(modeledProductionAutoGitHubCoreCalls({ workerName: 'ledgetop-clients', bucketCount: 1 }), 281);
  assert.equal(modeledProductionAutoGitHubCoreCalls({ workerName: 'ledgetop-clients', bucketCount: 28 }), 740);
  assert.equal(modeledProductionAutoGitHubCoreCalls({ workerName: 'ledgetop-ops-sync', bucketCount: 0 }), 88,
    'Sync reserves five 8-call source/CI/predecessor checks, journal claim and writes, artifact attachment, and held receipt');
});

test('quota admission uses the lower authenticated core allowance and only reserves future calls', async () => {
  const result = await assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 28,
    callsMade: 100, token: TOKEN, fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.github.com/rate_limit');
      assert.equal(init.method, 'GET'); assert.equal(init.redirect, 'error');
      assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
      return response({ remaining: 500 });
    } });
  assert.equal(result.modeledCalls, 592);
  assert.equal(result.requiredRemaining, 492);
  assert.equal(result.remaining, 500);
  const lowerHeader = await assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 1,
    callsMade: 0, token: TOKEN, fetchImpl: async () => response({ remaining: 500, headerRemaining: 300 }) });
  assert.equal(lowerHeader.remaining, 300, 'the lower response-header allowance is authoritative');
});

test('quota admission fails closed when actual B1/B28 remaining is insufficient', async () => {
  for (const [workerName, bucketCount, modeled] of [
    ['ledgetop-ops', 1, 241], ['ledgetop-ops', 28, 592],
    ['ledgetop-clients', 1, 281], ['ledgetop-clients', 28, 740],
  ]) {
    await assert.rejects(assertProductionAutoGitHubQuota({ workerName, bucketCount, callsMade: 0,
      token: TOKEN, fetchImpl: async () => response({ remaining: modeled - 1 }) }),
    /production_auto_github_quota_insufficient/u);
  }
  await assert.rejects(assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops-sync', bucketCount: 0,
    callsMade: 0, token: TOKEN, fetchImpl: async () => response({ remaining: 87 }) }),
  /production_auto_github_quota_insufficient/u);
});

test('rate-limit admission refuses malformed body, weaker/malformed headers, and expired reset', async () => {
  await assert.rejects(assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 1,
    callsMade: 0, token: TOKEN, fetchImpl: async () => response({ body: { resources: {} } }) }),
  /production_auto_github_quota_unavailable/u);
  await assert.rejects(assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 1,
    callsMade: 0, token: TOKEN, fetchImpl: async () => response({ remaining: 1_000, headers: false }) }),
  /production_auto_github_quota_unavailable/u);
  const expired = Math.floor(Date.now() / 1_000) - 1;
  assert.throws(() => validateProductionAutoGitHubCoreRateLimit({ resources: { core: {
    limit: 1_000, used: 0, remaining: 1_000, reset: expired } } }), /production_auto_github_quota_response_invalid/u);
  await assert.rejects(assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 1,
    callsMade: 242, token: TOKEN, fetchImpl: async () => response() }),
  /production_auto_github_request_model_drift/u);
});

test('rate-limit read has a strict deadline and does not expose transport errors', async () => {
  let aborted = false;
  await assert.rejects(assertProductionAutoGitHubQuota({ workerName: 'ledgetop-ops', bucketCount: 1,
    callsMade: 0, token: TOKEN, timeoutMs: 10, fetchImpl: async (_url, init) => {
      init.signal.addEventListener('abort', () => { aborted = true; }, { once: true });
      return await new Promise(() => {});
    } }), error => error.message === 'production_auto_github_quota_unavailable');
  assert.equal(aborted, true);
});
