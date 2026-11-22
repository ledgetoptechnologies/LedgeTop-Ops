// Cloudflare D1 REST provider for the ordered 0227..0244 once-operator.
// Mirrors the 0226 precedent provider: one HTTP request per operation, no
// retries, manual redirects refused, bounded responses, and each migration is a
// single `/query` batch of its pinned wire statements plus the d1_migrations row.
// The target account/database come from explicit arguments and are verified
// against the D1 metadata endpoint before any read.
import { createHash } from 'node:crypto';
import {
  LEDGER_INSERT_SQL, OPS_0227_0244_FILES, OPS_0227_0244_SCHEMA_ROWS_SQL, isOps0227To0244ReadQuery, loadVerifiedOps0227To0244Plan,
  parseOps0227To0244SnapshotResult,
} from './production-ops-0227-0244-ordered-once.mjs';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`ops_0227_0244_provider:${code}`); };

async function readBounded(response, maxBytes) {
  const length = response.headers?.get?.('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > maxBytes)) fail('response_too_large');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) fail('response_too_large');
    return text;
  }
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { await reader.cancel().catch(() => {}); fail('response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { try { reader.releaseLock(); } catch {} }
  return Buffer.concat(chunks, size).toString('utf8');
}

export function createOps0227To0244CloudflareProvider({ getBearerToken, accountId, databaseId, databaseName,
  allowWrites = false, fetchImpl = globalThis.fetch, timeoutMs = 30_000, now = Date.now, root } = {}) {
  if (typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function' || typeof now !== 'function'
    || !/^[a-f0-9]{32}$/u.test(accountId ?? '') || typeof databaseId !== 'string' || !/^[0-9a-f-]{36}$/u.test(databaseId)
    || typeof databaseName !== 'string' || databaseName.length === 0 || typeof allowWrites !== 'boolean'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) fail('configuration_invalid');
  // Re-verify local bytes and the wire fixture independently of the caller.
  const pinned = new Map(loadVerifiedOps0227To0244Plan(root ? { root } : {}).files.map(file => [file.name, file]));
  const applied = new Set();
  let verifiedTarget = false;

  async function request(method, route, body, maxBytes) {
    let bearer;
    try { bearer = await getBearerToken(); } catch { fail('auth_unavailable'); }
    if (typeof bearer !== 'string' || bearer.length < 20 || bearer.length > 16_384 || !/^[\x21-\x7e]+$/u.test(bearer)) fail('auth_unavailable');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
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
        if (error instanceof Error && error.message.startsWith('ops_0227_0244_provider:')) throw error;
        fail('response_invalid');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) fail('response_invalid');
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('ops_0227_0244_provider:')) throw error;
      // A transport failure after sending a mutation has an unknown outcome: reconcile, never retry.
      fail('request_uncertain_no_retry');
    } finally { clearTimeout(timer); }
  }

  async function assertTarget() {
    const payload = await request('GET', `d1/database/${encodeURIComponent(databaseId)}`, undefined, 1024 * 1024);
    if (payload.result?.uuid !== databaseId || payload.result?.name !== databaseName) fail('target_mismatch');
    verifiedTarget = true;
    return { databaseId, databaseName };
  }

  async function readSnapshot({ query } = {}) {
    if (!verifiedTarget) fail('target_not_verified');
    if (!isOps0227To0244ReadQuery(query)) fail('read_query_invalid');
    const payload = await request('POST', `d1/database/${encodeURIComponent(databaseId)}/query`,
      { batch: [{ sql: query, params: [] }, { sql: OPS_0227_0244_SCHEMA_ROWS_SQL, params: [] }] }, 32 * 1024 * 1024);
    return parseOps0227To0244SnapshotResult(payload.result, { observedAt: new Date(now()).toISOString() });
  }

  async function applyMigration({ name, sha256, statements, statementsSha256 } = {}) {
    if (!allowWrites) fail('writes_disabled');
    if (!verifiedTarget) fail('target_not_verified');
    const file = pinned.get(name);
    if (!file || !OPS_0227_0244_FILES.some(row => row.name === name && row.sha256 === sha256) || file.sha256 !== sha256
      || !Array.isArray(statements) || statementsSha256 !== file.statementsSha256
      || hash(JSON.stringify(statements)) !== file.statementsSha256) fail('migration_pin_mismatch');
    if (applied.has(name)) fail('migration_already_sent_no_retry');
    applied.add(name);
    const batch = [...file.statements.map(sql => ({ sql, params: [] })), { sql: LEDGER_INSERT_SQL, params: [name] }];
    const payload = await request('POST', `d1/database/${encodeURIComponent(databaseId)}/query`, { batch }, 8 * 1024 * 1024);
    if (!Array.isArray(payload.result) || payload.result.length !== batch.length
      || payload.result.some(item => item?.success !== true || !Array.isArray(item.results))) fail('batch_outcome_uncertain_no_retry');
    const ledger = payload.result.at(-1);
    if (!Number.isSafeInteger(ledger.meta?.changes) || ledger.meta.changes !== 1) fail('ledger_append_uncertain_no_retry');
    return { applied: true, statements: batch.length };
  }

  return Object.freeze({ assertTarget, readSnapshot, applyMigration });
}
