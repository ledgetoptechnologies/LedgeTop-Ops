import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PRODUCTION_OPS_0226_TARGET, PRODUCTION_OPS_0226_PRE_READ_QUERY, PRODUCTION_OPS_0226_POST_READ_QUERY,
  parseProductionOps0226SnapshotResult,
} from './production-ops-staff-login-0226-once.mjs';

const API_ROOT = 'https://api.cloudflare.com/client/v4';
const MIGRATION_NAME = '0226_staff_login_bindings.sql';
const MIGRATION_SHA256 = 'c25b03f4499c6de80d586a583c0e59b8c39b264248645c59733304ebe751d0c5';
const WIRE_FIXTURE_SHA256 = 'fd02f7220e2afaeb1105a19da0dc14b3c9329c084ac6500b8d0b5e32b440edb3';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_PATH = path.join(ROOT, 'scripts', 'fixtures', 'production-ops-0226-wrangler-wire-statements.json');
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new Error(`production_ops_0226_provider_${code}`); };
function isExactTarget(target) {
  return target !== null && typeof target === 'object' && !Array.isArray(target)
    && Object.keys(target).sort().join('\0') === Object.keys(PRODUCTION_OPS_0226_TARGET).sort().join('\0')
    && Object.entries(PRODUCTION_OPS_0226_TARGET).every(([key, value]) => target[key] === value);
}

async function readBounded(response, maxBytes = 32 * 1024 * 1024) {
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

/** Fixed production D1 provider. It issues one HTTP request per operation and never retries. */
export function createProductionOps0226CloudflareProvider({ getBearerToken, fetchImpl = globalThis.fetch,
  timeoutMs = 15_000, now = Date.now } = {}) {
  if (typeof getBearerToken !== 'function' || typeof fetchImpl !== 'function'
    || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 || typeof now !== 'function')
    fail('configuration_invalid');
  let verifiedTarget = false;

  async function request(method, route, body, { maxBytes } = {}) {
    let bearer;
    try { bearer = await getBearerToken(); } catch { fail('auth_unavailable'); }
    if (typeof bearer !== 'string' || bearer.length < 20 || bearer.length > 16_384 || !/^[\x21-\x7e]+$/u.test(bearer))
      fail('auth_unavailable');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${API_ROOT}/accounts/${PRODUCTION_OPS_0226_TARGET.accountId}/${route}`, {
        method, redirect: 'manual', cache: 'no-store', signal: controller.signal,
        headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response || response.redirected || (response.status >= 300 && response.status < 400)) fail('redirect_refused');
      if (!response.ok) fail('http_failure');
      let payload;
      try { payload = JSON.parse(await readBounded(response, maxBytes)); } catch (error) {
        if (error instanceof Error && error.message.startsWith('production_ops_0226_provider_')) throw error;
        fail('response_invalid');
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.success !== true) fail('response_invalid');
      return payload;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('production_ops_0226_provider_')) throw error;
      // A transport failure after sending a mutation has an ambiguous outcome. Caller must reconcile, never retry.
      fail('request_uncertain_no_retry');
    } finally { clearTimeout(timer); }
  }

  async function assertTarget(target = PRODUCTION_OPS_0226_TARGET) {
    if (!isExactTarget(target)) fail('target_mismatch');
    const payload = await request('GET', `d1/database/${encodeURIComponent(PRODUCTION_OPS_0226_TARGET.databaseId)}`);
    if (payload.result?.uuid !== PRODUCTION_OPS_0226_TARGET.databaseId
      || payload.result?.name !== PRODUCTION_OPS_0226_TARGET.databaseName) fail('target_mismatch');
    verifiedTarget = true;
    return { databaseId: payload.result.uuid, name: payload.result.name };
  }

  async function readSnapshot({ target = PRODUCTION_OPS_0226_TARGET, phase, query } = {}) {
    if (!verifiedTarget) fail('target_not_verified');
    if (!isExactTarget(target)) fail('target_mismatch');
    const expectedQuery = phase === 'postwrite' ? PRODUCTION_OPS_0226_POST_READ_QUERY : PRODUCTION_OPS_0226_PRE_READ_QUERY;
    if (!['immediate-prewrite', 'postwrite'].includes(phase) || query !== expectedQuery) fail('read_query_invalid');
    const payload = await request('POST', `d1/database/${encodeURIComponent(PRODUCTION_OPS_0226_TARGET.databaseId)}/query`,
      { sql: query, params: [] }, { maxBytes: 32 * 1024 * 1024 });
    const observedAt = new Date(now()).toISOString();
    return parseProductionOps0226SnapshotResult(payload.result, { observedAt });
  }

  async function applyExactMigration({ target = PRODUCTION_OPS_0226_TARGET, name, sha256, sql, appendLedger } = {}) {
    if (!verifiedTarget) fail('target_not_verified');
    if (!isExactTarget(target)) fail('target_mismatch');
    if (name !== MIGRATION_NAME || sha256 !== MIGRATION_SHA256 || appendLedger !== true
      || typeof sql !== 'string' || hash(Buffer.from(sql, 'utf8')) !== MIGRATION_SHA256) fail('migration_pin_mismatch');
    let bytes, fixture;
    try {
      bytes = fs.readFileSync(FIXTURE_PATH);
      if (hash(bytes) !== WIRE_FIXTURE_SHA256) fail('wire_fixture_pin_mismatch');
      fixture = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('production_ops_0226_provider_')) throw error;
      fail('wire_fixture_invalid');
    }
    if (!Array.isArray(fixture.statements) || fixture.statements.length !== 24
      || fixture.sourceMigrationSha256 !== MIGRATION_SHA256) fail('wire_fixture_invalid');
    const batch = [...fixture.statements.map(statement => ({ sql: statement, params: [] })),
      { sql: 'INSERT INTO d1_migrations(name) VALUES (?)', params: [MIGRATION_NAME] }];
    const payload = await request('POST', `d1/database/${encodeURIComponent(PRODUCTION_OPS_0226_TARGET.databaseId)}/query`,
      { batch }, { maxBytes: 8 * 1024 * 1024 });
    if (!Array.isArray(payload.result) || payload.result.length !== batch.length
      || payload.result.some(item => item?.success !== true || !Array.isArray(item.results))) fail('batch_outcome_uncertain_no_retry');
    const ledger = payload.result.at(-1);
    if (!Number.isSafeInteger(ledger.meta?.changes) || ledger.meta.changes !== 1) fail('ledger_append_uncertain_no_retry');
    return { applied: true, statements: batch.length };
  }

  return Object.freeze({ assertTarget, readSnapshot, applyExactMigration });
}
