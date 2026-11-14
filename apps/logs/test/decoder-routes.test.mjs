// Decoder runner routes against a real D1 and R2 (Miniflare). Synthetic rows and bytes only; no DJI calls or keys.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import { handleDecoderRequest, checkSummary } from '../src/worker/decoder-routes.mjs';
import { MAX_ATTEMPTS } from '../src/worker/decode-contract.mjs';

const TOKEN = 'decoder-test-token-0123456789abcdefghijklmnop';
const TOKEN_SHA256 = createHash('sha256').update(TOKEN).digest('hex');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let runtime, env;

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'decoder-routes' }, r2Buckets: { LOGS_BUCKET: 'decoder-routes' } });
});
after(async () => { await runtime?.dispose(); });

async function freshEnv(extra = { DECODER_ENABLED: 'true', DECODER_TOKEN_SHA256: TOKEN_SHA256 }) {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql', '0003_device_eligibility_revision.sql']) {
    const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES ('dev-beau', 'staff-beau', 'DJI RC PRO 2', 'h', 'staff-beau', ?)`)
    .bind(new Date().toISOString()).run();
  return { LOGS_DB: db, LOGS_BUCKET: bucket, ...extra };
}

async function addRaw(bytes, { pilot = 'staff-beau', name = 'DJIFlightRecord_test.txt' } = {}) {
  const hash = sha(bytes);
  await env.LOGS_BUCKET.put(`raw/${hash}`, bytes);
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, ?, ?, 'controller', 'dev-beau', ?, ?)`).bind(hash, bytes.length, name, `raw/${hash}`, pilot, new Date().toISOString()).run();
  return hash;
}

const b64url = value => Buffer.from(JSON.stringify(value)).toString('base64url');
async function call(path, { body, headers = {}, token = TOKEN, method = 'POST', raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (token) init.headers.Authorization = `Bearer ${token}`;
  if (raw !== undefined) init.body = raw; else if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  return handleDecoderRequest(new Request(`https://logs.example.test${path}`, init), env);
}
const jsonOf = async response => ({ status: response.status, body: await response.json() });
const TRACK = gzipSync(JSON.stringify({ schema: 'ltds.logs.telemetry.v1', rowCount: 2, columns: { offsetMs: [0, 100], latitude: [45, 45.0001] } }));
const SUMMARY = { started_at: '2026-11-13T05:36:14.000Z', ended_at: '2026-11-13T05:56:53.000Z', duration_seconds: 1239, distance_m: 2100.5,
  max_altitude_m: 61.2, max_speed_mps: 12.5, home_lat: 45.1, home_lon: -93.2, photo_count: 4, video_count: 1, telemetry_points: 2 };
const complete = (lease, { summary = SUMMARY, track = TRACK, contentSha256 = lease.sha256 } = {}) => call('/api/v1/decoder/complete', {
  raw: track, headers: { 'X-Lease-Sha256': lease.sha256, 'X-Attempt-Token': lease.attemptToken, 'X-Content-Sha256': contentSha256, 'X-Decode-Summary': b64url(summary) } });

test('closed by default: without DECODER_ENABLED and a token hash every decoder path is indistinguishable from an unknown path', async () => {
  for (const extra of [{}, { DECODER_ENABLED: 'true' }, { DECODER_TOKEN_SHA256: TOKEN_SHA256 }, { DECODER_ENABLED: 'yes', DECODER_TOKEN_SHA256: TOKEN_SHA256 },
    { DECODER_ENABLED: 'true', DECODER_TOKEN_SHA256: 'not-a-hash' }]) {
    env = await freshEnv(extra);
    for (const path of ['/api/v1/decoder/lease', '/api/v1/decoder/raw', '/api/v1/decoder/complete'])
      assert.equal(await call(path, { body: {} }), null, `${path} stays closed for ${JSON.stringify(Object.keys(extra))}`);
  }
  env = await freshEnv();
  assert.equal(await call('/api/v1/decoder/lease', { method: 'GET' }), null, 'only the listed methods and paths exist');
  assert.equal(await call('/api/v1/decoder/flights', { body: {} }), null);
  assert.equal(await call('/api/v1/device/sign-in', { body: {} }), null, 'device paths are not decoder paths');
});

test('only the runner token is accepted; a wrong, missing or malformed token gets 401 and touches nothing', async () => {
  env = await freshEnv();
  await addRaw(new Uint8Array([1, 2, 3, 4]));
  for (const token of [null, 'wrong-token-but-long-enough-0123456789abcdef', `${TOKEN}x`, 'short'])
    assert.equal((await call('/api/v1/decoder/lease', { body: { limit: 5 }, token })).status, 401);
  const row = await env.LOGS_DB.prepare('SELECT parse_status, parse_attempts FROM raw_logs').first();
  assert.deepEqual(row, { parse_status: 'needs_parse', parse_attempts: 0 }, 'a refused call leases nothing');
});

test('lease, read the held bytes, complete: a controller flight with its track, pilot and hash; leases carry no pilot or storage key', async () => {
  env = await freshEnv();
  const bytes = new Uint8Array(Array.from({ length: 300 }, (_, i) => i % 251));
  const hash = await addRaw(bytes);
  const leased = await jsonOf(await call('/api/v1/decoder/lease', { body: { limit: 50 } }));
  assert.equal(leased.status, 200);
  assert.equal(leased.body.leases.length, 1);
  const lease = leased.body.leases[0];
  assert.deepEqual(Object.keys(lease).sort(), ['attempt', 'attemptToken', 'leaseExpiresAt', 'sha256']);
  assert.equal(lease.sha256, hash);

  const raw = await call('/api/v1/decoder/raw', { body: { sha256: hash, attemptToken: lease.attemptToken } });
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get('X-Content-Sha256'), hash);
  assert.deepEqual(new Uint8Array(await raw.arrayBuffer()), bytes, 'the exact stored bytes');
  assert.equal((await call('/api/v1/decoder/raw', { body: { sha256: hash, attemptToken: 'someone-else' } })).status, 409, 'only the lease holder reads them');

  const done = await jsonOf(await complete(lease));
  assert.equal(done.status, 200);
  assert.equal(done.body.status, 'decoded');
  const flight = await env.LOGS_DB.prepare('SELECT * FROM flights WHERE id = ?').bind(done.body.flightId).first();
  assert.equal(flight.file_hash, hash);
  assert.equal(flight.pilot_id, 'staff-beau', 'the raw log’s own pilot, never from the decoder');
  assert.equal(flight.pilot_attribution, 'controller_sign_in');
  assert.equal(flight.source_system, 'controller');
  assert.equal(flight.source_file_name, 'DJIFlightRecord_test.txt');
  assert.equal(flight.raw_log_status, 'stored');
  assert.equal(flight.telemetry_key, `telemetry/v1/raw-${hash}.json.gz`);
  assert.deepEqual([flight.duration_seconds, flight.photo_count, flight.video_count, flight.telemetry_points, flight.home_lat], [1239, 4, 1, 2, 45.1]);
  const stored = await env.LOGS_BUCKET.get(flight.telemetry_key);
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), new Uint8Array(TRACK), 'the track is stored exactly as sent');
  const after = await env.LOGS_DB.prepare('SELECT parse_status, flight_id, attempt_token FROM raw_logs').first();
  assert.deepEqual(after, { parse_status: 'decoded', flight_id: done.body.flightId, attempt_token: null });
  assert.equal((await complete(lease)).status, 409, 'a repeated report after completion is stale, not a second flight');
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 1);
});

test('an existing flight of the same pilot is linked and keeps its own track; another pilot’s is never linked', async () => {
  env = await freshEnv();
  const mine = await addRaw(new Uint8Array([9, 9, 9, 1]));
  const theirs = await addRaw(new Uint8Array([9, 9, 9, 2]));
  const at = new Date().toISOString();
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, telemetry_key, created_at, updated_at)
    VALUES ('odl-1', ?, 'opendronelog', 'staff-beau', 'backup_owner', 'telemetry/v1/odl-1.json.gz', ?, ?)`).bind(mine, at, at).run();
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, created_at, updated_at)
    VALUES ('odl-2', ?, 'opendronelog', 'staff-kollin', 'backup_owner', ?, ?)`).bind(theirs, at, at).run();
  const { body } = await jsonOf(await call('/api/v1/decoder/lease', { body: { limit: 10 } }));
  const leases = new Map(body.leases.map(lease => [lease.sha256, lease]));
  const linked = await jsonOf(await complete(leases.get(mine)));
  assert.deepEqual([linked.body.status, linked.body.flightId, linked.body.linkedExisting], ['decoded', 'odl-1', true]);
  const odl = await env.LOGS_DB.prepare("SELECT telemetry_key, raw_log_status FROM flights WHERE id = 'odl-1'").first();
  assert.deepEqual(odl, { telemetry_key: 'telemetry/v1/odl-1.json.gz', raw_log_status: 'stored' }, 'the backup’s track is kept');
  const conflict = await jsonOf(await complete(leases.get(theirs)));
  assert.deepEqual(conflict.body, { status: 'failed', errorCode: 'attribution_conflict' });
  const other = await env.LOGS_DB.prepare("SELECT raw_log_status, telemetry_key FROM flights WHERE id = 'odl-2'").first();
  assert.deepEqual(other, { raw_log_status: 'missing', telemetry_key: null }, 'nothing is linked across pilots');
});

test('bad reports change nothing: wrong content hash, bad summary, uncompressed or oversized track', async () => {
  env = await freshEnv();
  const hash = await addRaw(new Uint8Array([5, 6, 7, 8]));
  const { body } = await jsonOf(await call('/api/v1/decoder/lease', { body: {} }));
  const lease = body.leases[0];
  assert.equal((await complete(lease, { contentSha256: '0'.repeat(64) })).status, 409, 'decoded bytes must be this log');
  for (const summary of [{ pilot_id: 'staff-kollin' }, { home_lat: 123 }, { duration_seconds: -1 }, { started_at: 'yesterday' }, { photo_count: 1.5 }, { display_name: 'x'.repeat(301) }])
    assert.equal((await complete(lease, { summary })).status, 400, JSON.stringify(summary));
  assert.equal((await complete(lease, { track: new TextEncoder().encode('{"not":"gzip"}') })).status, 400);
  const tooBig = await call('/api/v1/decoder/complete', { raw: new Uint8Array(8), headers: { 'X-Lease-Sha256': hash, 'X-Attempt-Token': lease.attemptToken,
    'X-Content-Sha256': hash, 'X-Decode-Summary': b64url(SUMMARY), 'Content-Length': String(33 * 1024 * 1024) } });
  assert.equal(tooBig.status, 413);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 0);
  assert.equal(await env.LOGS_BUCKET.head(`telemetry/v1/raw-${hash}.json.gz`), null, 'no track is stored for a rejected report');
  assert.equal((await env.LOGS_DB.prepare('SELECT parse_status FROM raw_logs').first()).parse_status, 'leased', 'still held; the runner can report properly');
  assert.throws(() => checkSummary({ toString: 'x' }), error => error.code === 'summary_invalid');
});

test('retry and fail go through the fence with closed error codes; raw bytes are never removed', async () => {
  env = await freshEnv();
  const hash = await addRaw(new Uint8Array([1, 1, 2, 3, 5, 8]));
  let { body } = await jsonOf(await call('/api/v1/decoder/lease', { body: {} }));
  let lease = body.leases[0];
  assert.equal((await call('/api/v1/decoder/retry', { body: { sha256: hash, attemptToken: lease.attemptToken, errorCode: 'something_new' } })).status, 400);
  assert.deepEqual((await jsonOf(await call('/api/v1/decoder/retry', { body: { sha256: hash, attemptToken: lease.attemptToken, errorCode: 'keychain_unavailable' } }))).body,
    { status: 'needs_parse', errorCode: 'keychain_unavailable' });
  ({ body } = await jsonOf(await call('/api/v1/decoder/lease', { body: {} })));
  lease = body.leases[0];
  assert.equal(lease.attempt, 2);
  assert.deepEqual((await jsonOf(await call('/api/v1/decoder/fail', { body: { sha256: hash, attemptToken: lease.attemptToken, errorCode: 'corrupt_log' } }))).body,
    { status: 'failed', errorCode: 'corrupt_log' });
  assert.equal((await call('/api/v1/decoder/fail', { body: { sha256: hash, attemptToken: lease.attemptToken, errorCode: 'corrupt_log' } })).status, 409);
  assert.ok(await env.LOGS_BUCKET.head(`raw/${hash}`), 'the raw log is kept');
  assert.ok(MAX_ATTEMPTS >= 2);
});
