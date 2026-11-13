/**
 * Fail-closed GitHub core-rate admission for ordinary frontend and Sync lanes.
 * Frontend projections are source-derived from the joined B=28 Ops runtime
 * fixture; Sync uses its fixed default-build call graph. Both include durable
 * journal writes, the completion artifact job, and one held receipt.
 * `rate_limit` does not consume primary core allowance;
 * this does not inspect or guarantee GitHub secondary content-rate limits.
 * It is a point-in-time admission against shared core state and cannot reserve
 * allowance against other jobs or credentials that consume the same bucket.
 */
import { PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS } from './production-auto-limits.mjs';
import { isGitHubHeaderCredential } from './production-auto-token.mjs';

const API = 'https://api.github.com/rate_limit';
// Post-journal revalidation: four CI core reads for each of B+10
// noncleanup intents. This adds 4B+40; Sync is unchanged.
const RETAINED_BASE_PER_BUCKET = 17;
const RETAINED_OPS_FIXED = 268;
const RETAINED_CLIENT_PER_BUCKET = 21;
const RETAINED_CLIENT_FIXED = 304;
// Sync default-build path: five source/CI/predecessor checks × 8 calls = 40;
// eight journal commit events × 4 plus a max existing-branch claim of 4 = 36;
// separate artifact completion = 8; one held receipt = 4; total = 88.
const SYNC_FIXED_CALLS = 88;
const DEFAULT_TIMEOUT_MS = 5_000;
const need = (ok, code) => { if (!ok) throw new Error(code); };

export function modeledProductionAutoGitHubCoreCalls({ workerName, bucketCount, ownedInactiveSupersession = false } = {}) {
  need(['ledgetop-ops', 'ledgetop-clients', 'ledgetop-ops-sync'].includes(workerName)
    && Number.isSafeInteger(bucketCount) && bucketCount >= 0
    && (workerName === 'ledgetop-ops-sync' ? bucketCount === 0 : bucketCount <= PRODUCTION_AUTO_MAX_ASSET_BUCKET_INTENTS)
    && typeof ownedInactiveSupersession === 'boolean'
    && (!ownedInactiveSupersession || workerName === 'ledgetop-clients'),
  'production_auto_github_budget_input_invalid');
  if (workerName === 'ledgetop-ops-sync') return SYNC_FIXED_CALLS;
  if (workerName === 'ledgetop-ops') return RETAINED_BASE_PER_BUCKET * bucketCount + RETAINED_OPS_FIXED;
  // One-off recovery: 4 early CI + 4 pinned journal + 3 custody metadata
  // + 1 first-claim head + (B+13) dispatch heads + 1 completion head.
  // The selector changes this conservative budget, never grants admission.
  return RETAINED_CLIENT_PER_BUCKET * bucketCount + RETAINED_CLIENT_FIXED
    + (ownedInactiveSupersession ? bucketCount + 26 : 0);
}

export function validateProductionAutoGitHubCoreRateLimit(body, nowSeconds = Math.floor(Date.now() / 1_000)) {
  const core = body?.resources?.core;
  need(Number.isSafeInteger(nowSeconds) && nowSeconds >= 0
    && core && Number.isSafeInteger(core.limit) && core.limit > 0
    && Number.isSafeInteger(core.remaining) && core.remaining >= 0 && core.remaining <= core.limit
    && Number.isSafeInteger(core.used) && core.used >= 0 && core.used <= core.limit
    && Number.isSafeInteger(core.reset) && core.reset > nowSeconds,
  'production_auto_github_quota_response_invalid');
  return Object.freeze({ limit: core.limit, remaining: core.remaining, reset: core.reset });
}

function parseCoreHeaders(headers, nowSeconds) {
  const resource = headers.get('X-RateLimit-Resource');
  const limitText = headers.get('X-RateLimit-Limit'), remainingText = headers.get('X-RateLimit-Remaining');
  const resetText = headers.get('X-RateLimit-Reset');
  need(resource === 'core' && /^(?:0|[1-9][0-9]*)$/u.test(limitText ?? '')
    && /^(?:0|[1-9][0-9]*)$/u.test(remainingText ?? '')
    && /^(?:0|[1-9][0-9]*)$/u.test(resetText ?? ''),
  'production_auto_github_quota_response_invalid');
  const value = { limit: Number(limitText), remaining: Number(remainingText), reset: Number(resetText) };
  need(Number.isSafeInteger(value.limit) && value.limit > 0
    && Number.isSafeInteger(value.remaining) && value.remaining >= 0 && value.remaining <= value.limit
    && Number.isSafeInteger(value.reset) && value.reset > nowSeconds,
  'production_auto_github_quota_response_invalid');
  return value;
}

async function readRateLimit({ token, fetchImpl, timeoutMs }) {
  need(isGitHubHeaderCredential(token)
    && typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= DEFAULT_TIMEOUT_MS,
  'production_auto_github_quota_configuration_invalid');
  const controller = new AbortController();
  let timer, reader;
  const cancel = () => { try { void reader?.cancel().catch(() => {}); } catch {} };
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); cancel(); reject(new Error('deadline')); }, timeoutMs);
  });
  const operation = (async () => {
    const response = await fetchImpl(API, { method: 'GET', redirect: 'error', signal: controller.signal,
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}` } });
    need(response instanceof Response && response.status === 200 && !response.redirected
      && !response.headers.has('Location') && response.headers.get('Content-Type')?.split(';')[0] === 'application/json',
    'production_auto_github_quota_response_invalid');
    controller.signal.throwIfAborted();
    reader = response.body?.getReader(); need(reader, 'production_auto_github_quota_response_invalid');
    const chunks = []; let length = 0;
    for (;;) {
      controller.signal.throwIfAborted();
      const part = await reader.read(); if (part.done) break;
      length += part.value.byteLength; need(length <= 64 * 1024, 'production_auto_github_quota_response_invalid');
      chunks.push(Buffer.from(part.value));
    }
    controller.signal.throwIfAborted();
    let body; try { body = JSON.parse(Buffer.concat(chunks, length).toString('utf8')); }
    catch { need(false, 'production_auto_github_quota_response_invalid'); }
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const payload = validateProductionAutoGitHubCoreRateLimit(body, nowSeconds);
    const headers = parseCoreHeaders(response.headers, nowSeconds);
    // GitHub documents the response headers as authoritative. Using the lower
    // allowance also stays conservative if a proxy/cache returns mismatched
    // body and headers.
    return Object.freeze({ limit: Math.min(payload.limit, headers.limit),
      remaining: Math.min(payload.remaining, headers.remaining), reset: Math.max(payload.reset, headers.reset) });
  })();
  try { return await Promise.race([operation, deadline]); }
  catch { throw new Error('production_auto_github_quota_unavailable'); }
  finally { clearTimeout(timer); cancel(); try { reader?.releaseLock(); } catch {} }
}

/** Check future modeled calls against the live core allowance for this token. */
export async function assertProductionAutoGitHubQuota({ workerName, bucketCount = 0, callsMade,
  token, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, ownedInactiveSupersession = false } = {}) {
  need(Number.isSafeInteger(callsMade) && callsMade >= 0,
    'production_auto_github_budget_input_invalid');
  const modeledCalls = modeledProductionAutoGitHubCoreCalls({ workerName, bucketCount, ownedInactiveSupersession });
  need(callsMade <= modeledCalls, 'production_auto_github_request_model_drift');
  const quota = await readRateLimit({ token, fetchImpl, timeoutMs });
  const requiredRemaining = modeledCalls - callsMade;
  need(quota.remaining >= requiredRemaining, 'production_auto_github_quota_insufficient');
  return Object.freeze({ modeledCalls, requiredRemaining, remaining: quota.remaining, reset: quota.reset });
}
