// Decoder lease/completion contract against a real D1 (Miniflare). Synthetic rows only; no DJI calls or keys.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare } from 'miniflare';
import * as decode from '../src/worker/decode-contract.mjs';

let runtime, env;
const T = Date.parse('2026-11-13T12:00:00Z');
const hash = n => n.toString(16).padStart(64, '0');
let tokenSeq = 0;
const token = () => `attempt-${++tokenSeq}`;

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'decode-test' } });
});
after(async () => { await runtime?.dispose(); });

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB');
  for (const table of ['raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql']) {
    const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  for (const [id, pilot] of [['dev-beau', 'staff-beau'], ['dev-kollin', 'staff-kollin']])
    await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES (?, ?, 'DJI RC PLUS 2', ?, ?, ?)`)
      .bind(id, pilot, `hash-${id}`, pilot, new Date(T).toISOString()).run();
  return { LOGS_DB: db };
}
async function addRaw(n, { pilot = 'staff-beau', device = 'dev-beau', minute = n } = {}) {
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, 100, ?, ?, 'controller', ?, ?, ?)`).bind(hash(n), `log-${n}.txt`, `raw/${hash(n)}`, device, pilot, new Date(T + minute * 60_000).toISOString()).run();
}
async function addFlight(id, n, pilot) {
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, created_at, updated_at)
    VALUES (?, ?, 'opendronelog', ?, 'backup_owner', ?, ?)`).bind(id, hash(n), pilot, new Date(T).toISOString(), new Date(T).toISOString()).run();
}
const row = n => env.LOGS_DB.prepare('SELECT * FROM raw_logs WHERE sha256 = ?').bind(hash(n)).first();
const count = async table => (await env.LOGS_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;

test('DJI key binding is explicit per environment with no fallback either way', () => {
  assert.equal(decode.djiKeyBinding({ LOGS_ENVIRONMENT: 'staging', DJI_API_KEY_Staging: 'x' }), 'DJI_API_KEY_Staging');
  assert.equal(decode.djiKeyBinding({ LOGS_ENVIRONMENT: 'production', DJI_API_KEY: 'x' }), 'DJI_API_KEY');
  assert.throws(() => decode.djiKeyBinding({ LOGS_ENVIRONMENT: 'staging', DJI_API_KEY: 'x' }), e => e.code === 'decoder_key_missing', 'staging never uses the production key');
  assert.throws(() => decode.djiKeyBinding({ LOGS_ENVIRONMENT: 'production', DJI_API_KEY_Staging: 'x' }), e => e.code === 'decoder_key_missing', 'production never uses the staging key');
  for (const environment of [undefined, '', 'Staging', 'prod', 'toString', '__proto__'])
    assert.throws(() => decode.djiKeyBinding({ LOGS_ENVIRONMENT: environment, DJI_API_KEY: 'x', DJI_API_KEY_Staging: 'x' }), e => e.code === 'decoder_not_configured');
  assert.throws(() => decode.djiKeyBinding({ LOGS_ENVIRONMENT: 'staging', DJI_API_KEY_Staging: '  ' }), e => e.code === 'decoder_key_missing');
});

test('leases are exclusive, bounded, ordered, and reclaimed only after expiry', async () => {
  env = await freshEnv();
  for (let n = 1; n <= 12; n++) await addRaw(n);
  const first = await decode.leaseRawLogs(env, { now: T, limit: 50, token });
  assert.equal(first.length, decode.MAX_LEASE_BATCH, 'batch is capped');
  assert.deepEqual(first.map(l => l.sha256), Array.from({ length: 10 }, (_, i) => hash(i + 1)), 'oldest first');
  assert.equal(first[0].pilotId, 'staff-beau');
  const second = await decode.leaseRawLogs(env, { now: T + 1000, limit: 10, token });
  assert.deepEqual(second.map(l => l.sha256), [hash(11), hash(12)], 'held leases are not handed out again');
  assert.deepEqual(await decode.leaseRawLogs(env, { now: T + 2000, token }), []);
  const reclaimed = await decode.leaseRawLogs(env, { now: T + decode.LEASE_SECONDS * 1000 + 1, limit: 1, token });
  assert.equal(reclaimed[0].sha256, hash(1));
  assert.equal(reclaimed[0].attempt, 2);
  assert.notEqual(reclaimed[0].attemptToken, first[0].attemptToken);
});

test('a stale, expired, or foreign token cannot complete, retry, or fail a row', async () => {
  env = await freshEnv();
  await addRaw(1);
  const [old] = await decode.leaseRawLogs(env, { now: T, token });
  const [current] = await decode.leaseRawLogs(env, { now: T + decode.LEASE_SECONDS * 1000 + 1, token });
  const later = T + decode.LEASE_SECONDS * 1000 + 2;
  await assert.rejects(decode.completeDecode(env, old, { contentSha256: hash(1), flightId: 'f-old' }, { now: later }), e => e.code === 'lease_stale');
  await assert.rejects(decode.retryDecode(env, old, 'decoder_error', { now: later }), e => e.code === 'lease_stale');
  await assert.rejects(decode.failDecode(env, old, 'corrupt_log', { now: later }), e => e.code === 'lease_stale');
  await assert.rejects(decode.completeDecode(env, { ...current, attemptToken: 'forged' }, { contentSha256: hash(1), flightId: 'f' }, { now: later }), e => e.code === 'lease_stale');
  // Holding the right token past expiry is not enough either.
  await assert.rejects(decode.completeDecode(env, current, { contentSha256: hash(1), flightId: 'f' }, { now: later + decode.LEASE_SECONDS * 1000 }), e => e.code === 'lease_stale');
  assert.equal(await count('flights'), 0, 'no flight was created by a rejected attempt');
  assert.equal((await row(1)).parse_status, 'leased');
});

test('completion creates a flight bound to the raw log’s own pilot and hash, atomically', async () => {
  env = await freshEnv();
  await addRaw(1, { pilot: 'staff-kollin', device: 'dev-kollin' });
  const [lease] = await decode.leaseRawLogs(env, { now: T, token });
  await assert.rejects(decode.completeDecode(env, lease, { contentSha256: hash(2), flightId: 'f1' }, { now: T + 1 }), e => e.code === 'hash_mismatch');
  assert.equal(await count('flights'), 0);
  const done = await decode.completeDecode(env, lease, { contentSha256: hash(1), flightId: 'f1',
    summary: { duration_seconds: 600, photo_count: 12, pilot_id: 'staff-beau', file_hash: hash(9) } }, { now: T + 2 });
  assert.deepEqual(done, { status: 'decoded', flightId: 'f1', linkedExisting: false });
  const flight = await env.LOGS_DB.prepare('SELECT * FROM flights WHERE id = ?').bind('f1').first();
  assert.deepEqual([flight.pilot_id, flight.file_hash, flight.pilot_attribution, flight.raw_log_status, flight.raw_log_key, flight.photo_count],
    ['staff-kollin', hash(1), 'controller_sign_in', 'stored', `raw/${hash(1)}`, 12], 'summary cannot override pilot or hash');
  const raw = await row(1);
  assert.deepEqual([raw.parse_status, raw.flight_id, raw.attempt_token, raw.lease_expires_at, raw.pilot_id], ['decoded', 'f1', null, null, 'staff-kollin']);
  await assert.rejects(decode.completeDecode(env, lease, { contentSha256: hash(1), flightId: 'f1' }, { now: T + 3 }), e => e.code === 'lease_stale', 'not twice');
});

test('an existing flight with the same hash is linked only for the same pilot; another pilot is a conflict', async () => {
  env = await freshEnv();
  await addRaw(1); await addFlight('odl-1', 1, 'staff-beau');
  const [same] = await decode.leaseRawLogs(env, { now: T, token });
  const linked = await decode.completeDecode(env, same, { contentSha256: hash(1), flightId: 'ignored' }, { now: T + 1 });
  assert.deepEqual(linked, { status: 'decoded', flightId: 'odl-1', linkedExisting: true });
  const flight = await env.LOGS_DB.prepare('SELECT pilot_id, pilot_attribution, raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('odl-1').first();
  assert.deepEqual(flight, { pilot_id: 'staff-beau', pilot_attribution: 'backup_owner', raw_log_status: 'stored', raw_log_key: `raw/${hash(1)}` });
  assert.equal(await count('flights'), 1, 'no duplicate flight');

  await addRaw(2, { pilot: 'staff-kollin', device: 'dev-kollin' }); await addFlight('odl-2', 2, 'staff-beau');
  const [cross] = await decode.leaseRawLogs(env, { now: T + 2, token });
  const conflict = await decode.completeDecode(env, cross, { contentSha256: hash(2), flightId: 'x' }, { now: T + 3 });
  assert.deepEqual(conflict, { status: 'failed', errorCode: 'attribution_conflict' });
  const untouched = await env.LOGS_DB.prepare('SELECT pilot_id, raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('odl-2').first();
  assert.deepEqual(untouched, { pilot_id: 'staff-beau', raw_log_status: 'missing', raw_log_key: null }, 'the other pilot’s flight is not linked or changed');
  const raw = await row(2);
  assert.deepEqual([raw.parse_status, raw.error_code, raw.flight_id, raw.pilot_id], ['failed', 'attribution_conflict', null, 'staff-kollin']);
});

test('a stale lease linking an existing flight changes nothing on that flight', async () => {
  env = await freshEnv();
  await addRaw(1); await addFlight('odl-1', 1, 'staff-beau');
  const [lease] = await decode.leaseRawLogs(env, { now: T, token });
  await decode.leaseRawLogs(env, { now: T + decode.LEASE_SECONDS * 1000 + 1, token });
  await assert.rejects(decode.completeDecode(env, lease, { contentSha256: hash(1), flightId: 'x' }, { now: T + decode.LEASE_SECONDS * 1000 + 2 }), e => e.code === 'lease_stale');
  const flight = await env.LOGS_DB.prepare('SELECT raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('odl-1').first();
  assert.deepEqual(flight, { raw_log_status: 'missing', raw_log_key: null });
});

test('retries return the row, attempts are capped, and error codes come from a closed list', async () => {
  env = await freshEnv();
  await addRaw(1);
  let now = T;
  for (let attempt = 1; attempt < decode.MAX_ATTEMPTS; attempt++) {
    const [lease] = await decode.leaseRawLogs(env, { now, token });
    assert.equal(lease.attempt, attempt);
    await assert.rejects(decode.retryDecode(env, lease, 'corrupt_log', { now: now + 1 }), e => e.code === 'error_code_invalid', 'permanent codes are not retries');
    await assert.rejects(decode.retryDecode(env, lease, 'some raw decoder text', { now: now + 1 }), e => e.code === 'error_code_invalid');
    assert.deepEqual(await decode.retryDecode(env, lease, 'keychain_unavailable', { now: now + 1 }), { status: 'needs_parse', errorCode: 'keychain_unavailable' });
    now += 10;
  }
  const [last] = await decode.leaseRawLogs(env, { now, token });
  assert.equal(last.attempt, decode.MAX_ATTEMPTS);
  // The final lease expires unfinished: the row is closed rather than leased a sixth time.
  assert.deepEqual(await decode.leaseRawLogs(env, { now: now + decode.LEASE_SECONDS * 1000 + 1, token }), []);
  const raw = await row(1);
  assert.deepEqual([raw.parse_status, raw.error_code, raw.parse_attempts], ['failed', 'attempts_exhausted', decode.MAX_ATTEMPTS]);
});

test('a retryable problem on the last attempt closes the row instead of stranding it', async () => {
  env = await freshEnv();
  await addRaw(1);
  let now = T, lease;
  for (let attempt = 1; attempt <= decode.MAX_ATTEMPTS; attempt++) {
    [lease] = await decode.leaseRawLogs(env, { now, token });
    assert.equal(lease.attempt, attempt);
    const outcome = await decode.retryDecode(env, lease, 'decoder_error', { now: now + 1 });
    assert.deepEqual(outcome, attempt < decode.MAX_ATTEMPTS
      ? { status: 'needs_parse', errorCode: 'decoder_error' }
      : { status: 'failed', errorCode: 'attempts_exhausted' });
    now += 10;
  }
  const raw = await row(1);
  assert.deepEqual([raw.parse_status, raw.error_code, raw.parse_attempts, raw.attempt_token, raw.lease_expires_at],
    ['failed', 'attempts_exhausted', decode.MAX_ATTEMPTS, null, null]);
  assert.deepEqual(await decode.leaseRawLogs(env, { now: now + decode.LEASE_SECONDS * 1000 + 1, token }), [], 'no sixth lease');
  // The final retry still needs the current lease: a stale holder can't close or reopen the row.
  await assert.rejects(decode.retryDecode(env, lease, 'decoder_error', { now: now + 2 }), e => e.code === 'lease_stale');
});

test('a row already left at the attempt cap as needs_parse is closed, never leased again', async () => {
  env = await freshEnv();
  await addRaw(1);
  await env.LOGS_DB.prepare("UPDATE raw_logs SET parse_attempts = ? WHERE sha256 = ?").bind(decode.MAX_ATTEMPTS, hash(1)).run();
  assert.deepEqual(await decode.leaseRawLogs(env, { now: T, token }), []);
  const raw = await row(1);
  assert.deepEqual([raw.parse_status, raw.error_code], ['failed', 'attempts_exhausted']);
});

test('no transition ever deletes or rewrites the raw log record', async () => {
  env = await freshEnv();
  for (let n = 1; n <= 3; n++) await addRaw(n);
  const before = await env.LOGS_DB.prepare('SELECT sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at FROM raw_logs ORDER BY sha256').all();
  const [a, b, c] = await decode.leaseRawLogs(env, { now: T, token });
  await decode.completeDecode(env, a, { contentSha256: a.sha256, flightId: 'fa' }, { now: T + 1 });
  await decode.retryDecode(env, b, 'raw_missing', { now: T + 1 });
  await decode.failDecode(env, c, 'unsupported_version', { now: T + 1 });
  const afterRows = await env.LOGS_DB.prepare('SELECT sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at FROM raw_logs ORDER BY sha256').all();
  assert.deepEqual(afterRows.results, before.results);
});
