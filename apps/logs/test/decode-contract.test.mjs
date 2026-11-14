// Decoder queue contract against a real D1 (Miniflare). Synthetic rows only; no DJI calls or keys.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import * as decode from '../src/worker/decode-contract.mjs';
import { applySchema } from './schema.mjs';

let runtime, env;
const T = Date.parse('2026-11-13T12:00:00Z');
const hash = n => n.toString(16).padStart(64, '0');
const FP = n => n.toString(16).padStart(64, 'f');
let tokenSeq = 0;
const token = () => `attempt-${++tokenSeq}`;
const rid = n => `request-${String(n).padStart(12, '0')}`;
const minutes = m => T + m * 60_000;

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'decode-test' } });
});
after(async () => { await runtime?.dispose(); });

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB');
  await applySchema(db);
  for (const [id, pilot] of [['dev-beau', 'staff-beau'], ['dev-kollin', 'staff-kollin']])
    await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES (?, ?, 'DJI RC PLUS 2', ?, ?, ?)`)
      .bind(id, pilot, `hash-${id}`, pilot, new Date(T).toISOString()).run();
  return { LOGS_DB: db };
}
async function addRaw(n, { pilot = 'staff-beau', device = 'dev-beau', minute = n } = {}) {
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, 100, ?, ?, 'controller', ?, ?, ?)`).bind(hash(n), `log-${n}.txt`, `raw/${hash(n)}`, device, pilot, new Date(minutes(minute)).toISOString()).run();
}
async function addFlight(id, n, pilot, telemetryKey = null) {
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, telemetry_key, created_at, updated_at)
    VALUES (?, ?, 'opendronelog', ?, 'backup_owner', ?, ?, ?)`).bind(id, hash(n), pilot, telemetryKey, new Date(T).toISOString(), new Date(T).toISOString()).run();
}
const row = n => env.LOGS_DB.prepare('SELECT * FROM raw_logs WHERE sha256 = ?').bind(hash(n)).first();
const count = async (table, where = '') => (await env.LOGS_DB.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).first()).n;
const claim = (n, now = T) => decode.claimRawLog(env, { requestId: rid(n), now, token });
const result = (n, extra = {}) => ({ contentSha256: hash(n), flightId: `flight-${n}`, summary: { telemetry_points: 3 }, telemetryKey: `telemetry/v1/raw-${hash(n)}/a-b.json.gz`,
  fingerprint: FP(n), decoderVersion: 'ltds-dji-decode/1+dji-log-parser/0.5.7', ...extra });

test('a claim needs a request id, takes the oldest decodable log, and repeating it returns the same lease', async () => {
  env = await freshEnv();
  for (const n of [3, 1, 2]) await addRaw(n);
  await assert.rejects(decode.claimRawLog(env, { now: T }), error => error.code === 'request_id_invalid');
  await assert.rejects(decode.claimRawLog(env, { requestId: 'short', now: T }), error => error.code === 'request_id_invalid');
  const first = await claim(1);
  assert.equal(first.sha256, hash(1), 'oldest upload first');
  assert.deepEqual([first.attempt, first.reclaims], [1, 0]);
  const again = await claim(1, minutes(1));
  assert.deepEqual(again, first, 'a lost claim reply is safe to repeat: same row, same token');
  assert.equal((await row(1)).parse_attempts, 0, 'claiming uses no parse attempt');
});

test('only one lease is live at a time, enforced in SQL, even for concurrent claims with the same id', async () => {
  env = await freshEnv();
  for (const n of [1, 2, 3]) await addRaw(n);
  const [a, b] = await Promise.all([claim(7), claim(7)]);
  assert.deepEqual(a, b, 'the same request id never leases two rows');
  assert.equal(await claim(8, minutes(1)), null, 'another claim waits while a lease is live');
  assert.equal(await count('raw_logs', "WHERE parse_status = 'leased'"), 1);
  await decode.completeDecode(env, a, result(Number.parseInt(a.sha256, 16)), { now: minutes(1) });
  const next = await claim(8, minutes(2));
  assert.equal(next.sha256, hash(2), 'the next log once the first is done');
});

test('crashes and outages never use the parse budget; a lease that keeps expiring is parked for review, not failed as corrupt', async () => {
  env = await freshEnv();
  await addRaw(1);
  let lease = await claim(1);
  for (let i = 1; i <= decode.MAX_RECLAIMS; i++) {
    const at = minutes(i * 10);   // the previous lease expired (5 min) without a heartbeat
    lease = await claim(100 + i, at);
    assert.equal(lease.reclaims, i);
  }
  assert.equal((await row(1)).parse_attempts, 0, 'not one parse attempt used');
  assert.equal(await claim(999, minutes(1000)), null);
  const parked = await row(1);
  assert.deepEqual([parked.parse_status, parked.error_code, parked.attempt_token], ['failed', decode.PARKED, null]);
  assert.notEqual(decode.PARKED, 'attempts_exhausted');
});

test('heartbeat extends only the exact live attempt', async () => {
  env = await freshEnv();
  await addRaw(1);
  const lease = await claim(1);
  const beat = await decode.heartbeatLease(env, lease, { now: minutes(4) });
  assert.equal(beat.leaseExpiresAt, new Date(minutes(9)).toISOString());
  assert.equal(await claim(2, minutes(8)), null, 'a heartbeat keeps the log held');
  await assert.rejects(decode.heartbeatLease(env, { ...lease, attemptToken: 'other' }, { now: minutes(5) }), error => error.status === 409);
  await assert.rejects(decode.heartbeatLease(env, lease, { now: minutes(20) }), error => error.status === 409, 'an expired attempt cannot revive itself');
});

test('defer waits without using an attempt; retry uses one and backs off; the cap closes the row; raw rows are never removed', async () => {
  env = await freshEnv();
  await addRaw(1);
  let lease = await claim(1);
  const deferred = await decode.deferDecode(env, lease, 'dji_unavailable', { retryAfterSeconds: 120, now: T });
  assert.deepEqual([deferred.status, deferred.nextAttemptAt], ['needs_parse', new Date(minutes(2)).toISOString()]);
  assert.equal((await row(1)).parse_attempts, 0);
  assert.equal(await claim(2, minutes(1)), null, 'not before the deferral ends');
  lease = await claim(3, minutes(2));
  assert.ok(lease);
  await assert.rejects(decode.deferDecode(env, lease, 'corrupt_log', { now: minutes(2) }), error => error.code === 'error_code_invalid');
  await assert.rejects(decode.retryDecode(env, lease, 'keychain_unavailable', { now: minutes(2) }), error => error.code === 'error_code_invalid', 'outages are deferrals, not retries');
  let now = minutes(2);
  for (let i = 1; i < decode.MAX_ATTEMPTS; i++) {
    const retried = await decode.retryDecode(env, lease, 'decoder_error', { now });
    assert.equal(retried.status, 'needs_parse');
    const r = await row(1);
    assert.equal(r.parse_attempts, i);
    now = Date.parse(r.next_attempt_at);
    lease = await claim(10 + i, now);
  }
  assert.deepEqual(await decode.retryDecode(env, lease, 'decoder_error', { now }), { status: 'failed', errorCode: 'attempts_exhausted' });
  assert.equal(await count('raw_logs'), 1, 'the raw log is kept');
  await assert.rejects(decode.failDecode(env, lease, 'corrupt_log', { now }), error => error.status === 409, 'a closed row takes no more outcomes');
});

test('completion commits atomically with a durable receipt: identical replays get it back, conflicting results are refused', async () => {
  env = await freshEnv();
  await addRaw(1);
  const lease = await claim(1);
  const done = await decode.completeDecode(env, lease, result(1), { now: minutes(1) });
  assert.deepEqual([done.status, done.flightId, done.replayed, done.telemetryKey], ['decoded', 'flight-1', false, result(1).telemetryKey]);
  const r = await row(1);
  assert.deepEqual([r.parse_status, r.committed_attempt_token, r.result_fingerprint, r.decoder_version, r.attempt_token, r.claim_request_id],
    ['decoded', lease.attemptToken, FP(1), result(1).decoderVersion, null, null]);
  const flight = await env.LOGS_DB.prepare("SELECT * FROM flights WHERE id = 'flight-1'").first();
  assert.deepEqual([flight.pilot_id, flight.pilot_attribution, flight.file_hash, flight.source_file_name, flight.telemetry_key], ['staff-beau', 'controller_sign_in', hash(1), 'log-1.txt', result(1).telemetryKey]);

  const replay = await decode.completeDecode(env, lease, { ...result(1), flightId: 'flight-other' }, { now: minutes(30) });
  assert.deepEqual([replay.status, replay.flightId, replay.replayed], ['decoded', 'flight-1', true], 'a lost acknowledgement is safe to replay');
  await assert.rejects(decode.completeDecode(env, lease, result(1, { fingerprint: FP(2) }), { now: minutes(30) }), error => error.code === 'result_conflict');
  await assert.rejects(decode.completeDecode(env, { ...lease, attemptToken: 'another' }, result(1), { now: minutes(30) }), error => error.code === 'lease_stale');
  assert.equal(await count('flights'), 1, 'never a second flight');
  assert.equal((await env.LOGS_DB.prepare("SELECT result_fingerprint FROM raw_logs").first()).result_fingerprint, FP(1), 'the winner is never replaced');
});

test('a stale attempt can never commit after its lease was taken over', async () => {
  env = await freshEnv();
  await addRaw(1);
  const old = await claim(1);
  const fresh = await claim(2, minutes(6));
  assert.equal(fresh.reclaims, 1);
  await assert.rejects(decode.completeDecode(env, old, result(1), { now: minutes(6) }), error => error.code === 'lease_stale');
  const done = await decode.completeDecode(env, fresh, result(1), { now: minutes(7) });
  assert.equal(done.status, 'decoded');
  await assert.rejects(decode.completeDecode(env, old, result(1), { now: minutes(8) }), error => error.code === 'lease_stale', 'not even with an identical result');
});

test('same-pilot flights are linked and keep their track; another pilot’s are never linked', async () => {
  env = await freshEnv();
  await addRaw(1); await addRaw(2);
  await addFlight('odl-1', 1, 'staff-beau', 'telemetry/v1/odl-1.json.gz');
  await addFlight('odl-2', 2, 'staff-kollin');
  let lease = await claim(1);
  const linked = await decode.completeDecode(env, lease, result(1), { now: minutes(1) });
  assert.deepEqual([linked.flightId, linked.linkedExisting, linked.telemetryKey], ['odl-1', true, 'telemetry/v1/odl-1.json.gz']);
  lease = await claim(2, minutes(2));
  assert.deepEqual(await decode.completeDecode(env, lease, result(2), { now: minutes(2) }), { status: 'failed', errorCode: 'attribution_conflict' });
  assert.deepEqual(await env.LOGS_DB.prepare("SELECT raw_log_status, telemetry_key FROM flights WHERE id = 'odl-2'").first(), { raw_log_status: 'missing', telemetry_key: null });
});

test('reconcile tells a runner whether its attempt committed, still holds the log, or lost it', async () => {
  env = await freshEnv();
  await addRaw(1); await addRaw(2);
  const lease = await claim(1);
  assert.deepEqual(await decode.reconcileDecode(env, lease, { now: minutes(1) }), { status: 'held', leaseExpiresAt: lease.leaseExpiresAt });
  await decode.completeDecode(env, lease, result(1), { now: minutes(1) });
  assert.deepEqual(await decode.reconcileDecode(env, lease, { now: minutes(2) }),
    { status: 'decoded', flightId: 'flight-1', telemetryKey: result(1).telemetryKey, fingerprint: FP(1) });
  assert.deepEqual(await decode.reconcileDecode(env, { ...lease, attemptToken: 'someone-else' }, { now: minutes(2) }), { status: 'lost' });
  const other = await claim(2, minutes(3));
  assert.deepEqual(await decode.reconcileDecode(env, other, { now: minutes(30) }), { status: 'lost' }, 'an expired attempt is lost');
});

test('outcome vocabularies are closed and never overlap', () => {
  const all = [...decode.DEFER_CODES, ...decode.RETRY_CODES, ...decode.PERMANENT_ERRORS, decode.PARKED];
  assert.equal(new Set(all).size, all.length);
  assert.ok(decode.PERMANENT_ERRORS.includes('log_too_large'));
});
