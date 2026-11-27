// Cloudflare D1 REST provider for the onboarding approver grant one-shot.
// Mirrors the 0227..0244 provider: one HTTP request per operation, no retries,
// manual redirects refused, bounded responses. The target is verified against the
// D1 metadata endpoint before any read. It sends only the two pinned statements:
// the read SELECT and, with writes enabled and at most once, the guarded INSERT.
import {
  APPROVER_GRANT_INSERT_SQL, APPROVER_GRANT_READ_SQL, APPROVER_GRANT_TARGET, approverGrantDelegationId, isApproverGrantStaffId,
} from './production-ops-onboarding-approver-grant-once.mjs';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const fail = code => { throw new Error(`ops_approver_grant_provider:${code}`); };

async function readBounded(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) fail('response_too_large');
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('response_too_large');
  return text;
}

export function createApproverGrantCloudflareProvider({ getBearerToken, accountId, databaseId, databaseName,
  allowWrites = false, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function' || typeof allowWrites !== 'boolean'
    || accountId !== APPROVER_GRANT_TARGET.accountId || databaseId !== APPROVER_GRANT_TARGET.databaseId
    || databaseName !== APPROVER_GRANT_TARGET.databaseName
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) fail('configuration_invalid');
  let verifiedTarget = false, grantSent = false;

  async function request(method, route, body, maxBytes) {
    let bearer;
    try { bearer = await getBearerToken(); } catch { fail('auth_unavailable'); }
    if (typeof bearer !== 'string' || bearer.length < 20 || bearer.length > 16_384 || !/^[\x21-\x7e]+$/u.test(bearer)) fail('auth_unavailable');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    let succeeded = false;
    try {
      const response = await fetchImpl(`${API_ROOT}/accounts/${accountId}/${route}`, {
        method, redirect: 'manual', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response || response.redirected || (response.status >= 300 && response.status < 400)) fail('redirect_refused');
      if (!response.ok) fail('http_failure');
      let payload;
      try { payload = JSON.parse(await readBounded(response, maxBytes)); } catch (error) {
        if (error instanceof Error && error.message.startsWith('ops_approver_grant_provider:')) throw error;
        fail('response_invalid');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) fail('response_invalid');
      succeeded = true;
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ops_approver_grant_provider:')) throw error;
      // A transport failure after sending has an unknown outcome: reconcile, never retry.
      fail('request_uncertain_no_retry');
    } finally {
      clearTimeout(timer);
      if (!succeeded) controller.abort();
    }
  }

  async function assertTarget() {
    const payload = await request('GET', `d1/database/${encodeURIComponent(databaseId)}`, undefined, 1024 * 1024);
    if (payload.result?.uuid !== databaseId || payload.result?.name !== databaseName) fail('target_mismatch');
    verifiedTarget = true;
    return { databaseId, databaseName };
  }

  async function read({ staffId } = {}) {
    if (!verifiedTarget) fail('target_not_verified');
    if (!isApproverGrantStaffId(staffId)) fail('staff_id_invalid');
    const payload = await request('POST', `d1/database/${encodeURIComponent(databaseId)}/query`,
      { batch: [{ sql: APPROVER_GRANT_READ_SQL, params: [staffId, approverGrantDelegationId(staffId)] }] }, 1024 * 1024);
    const item = Array.isArray(payload.result) && payload.result.length === 1 ? payload.result[0] : null;
    if (item?.success !== true || !Array.isArray(item.results) || item.results.length !== 1) fail('read_result_invalid');
    return item.results[0];
  }

  async function grant({ staffId } = {}) {
    if (!allowWrites) fail('writes_disabled');
    if (!verifiedTarget) fail('target_not_verified');
    if (!isApproverGrantStaffId(staffId)) fail('staff_id_invalid');
    if (grantSent) fail('grant_already_sent_no_retry');
    grantSent = true;
    const payload = await request('POST', `d1/database/${encodeURIComponent(databaseId)}/query`,
      { batch: [{ sql: APPROVER_GRANT_INSERT_SQL, params: [staffId, approverGrantDelegationId(staffId)] }] }, 1024 * 1024);
    const item = Array.isArray(payload.result) && payload.result.length === 1 ? payload.result[0] : null;
    if (item?.success !== true || !Number.isSafeInteger(item.meta?.changes)) fail('write_outcome_uncertain_no_retry');
    return { changes: item.meta.changes };
  }

  return Object.freeze({ assertTarget, read, grant });
}
