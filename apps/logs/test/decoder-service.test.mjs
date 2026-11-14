// The parser-only DecoderService: strict result checks, attempt-scoped immutable track storage, and the private
// RPC entrypoint (never the public host). Real D1/R2 and the real Worker in Miniflare; synthetic data only.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';
import * as decode from '../src/worker/decode-contract.mjs';
import { checkSummary, checkTrack, completeWithTrack, readRaw, DECODER_LIMITS, TRACK_SCHEMA } from '../src/worker/decoder-service.mjs';
import { applySchema } from './schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const track = (rows = 3, extra = {}) => gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: rows,
  columns: { offsetMs: Array.from({ length: rows }, (_, i) => i * 100), latitude: Array.from({ length: rows }, () => 45), isPhoto: Array.from({ length: rows }, () => false) }, ...extra }));
let runtime, env;

before(async () => {
  runtime = new Miniflare({ workers: [
    { name: 'logs', modules: true, scriptPath: path.resolve(here, '../src/worker/index.mjs'), modulesRoot: path.resolve(here, '..'),
      modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'] }], compatibilityDate: '2026-07-22',
      d1Databases: { LOGS_DB: 'decoder-service' }, r2Buckets: { LOGS_BUCKET: 'decoder-service' }, bindings: { DECODER_ENABLED: 'true' } },
    { name: 'logs-closed', modules: true, scriptPath: path.resolve(here, '../src/worker/index.mjs'), modulesRoot: path.resolve(here, '..'),
      modulesRules: [{ type: 'ESModule', include: ['**/*.mjs'] }], compatibilityDate: '2026-07-22',
      d1Databases: { LOGS_DB: 'decoder-service' }, r2Buckets: { LOGS_BUCKET: 'decoder-service' } },
    // Stand-in for the Ops machine bridge: reaches DecoderService only through a service binding.
    { name: 'bridge', modules: true, compatibilityDate: '2026-07-22',
      serviceBindings: { DECODER: { name: 'logs', entrypoint: 'DecoderService' }, CLOSED: { name: 'logs-closed', entrypoint: 'DecoderService' } },
      script: `export default { async fetch(request, env) {
        const { op, target } = await request.json();
        const binding = target === 'closed' ? env.CLOSED : env.DECODER;
        if (op === 'claim') return Response.json(await binding.claim({ runnerId: 'staging-90-decoder-1', requestId: 'bridge-request-0000001' }));
        return new Response('?', { status: 400 });
      } };` },
  ] });
});
after(async () => { await runtime?.dispose(); });

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB', 'logs'), bucket = await runtime.getR2Bucket('LOGS_BUCKET', 'logs');
  await applySchema(db);
  await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES ('dev-1', 'staff-beau', 'DJI RC PRO 2', 'h', 'staff-beau', 'now')`).run();
  return { LOGS_DB: db, LOGS_BUCKET: bucket, DECODER_ENABLED: 'true' };
}
let uploads = 0;
async function addRaw(text) {
  const bytes = new TextEncoder().encode(text), hash = sha(bytes);
  await env.LOGS_BUCKET.put(`raw/${hash}.txt`, bytes);
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, ?, ?, 'controller', 'dev-1', 'staff-beau', ?)`).bind(hash, bytes.length, `${text}.txt`, `raw/${hash}.txt`, new Date(Date.UTC(2026, 10, 13) + ++uploads * 1000).toISOString()).run();
  return { hash, bytes };
}
let requests = 0;
const claim = () => decode.claimRawLog(env, { runnerId: 'runner-a', requestId: `service-request-${String(++requests).padStart(8, '0')}` });
const VERSION = 'ltds-dji-decode/1+dji-log-parser/0.5.7';

test('the result summary and track are checked strictly before anything is stored', async () => {
  for (const bad of [{ pilot_id: 'x' }, { home_lat: 91 }, { telemetry_points: DECODER_LIMITS.trackRows + 1 }, { started_at: '2026-11-13T05:00:00Z', ended_at: '2026-11-13T04:00:00Z' },
    Object.create({ inherited: 1 }), [], 'x'])
    assert.throws(() => checkSummary(bad), error => error.code === 'summary_invalid', JSON.stringify(bad));
  assert.deepEqual(checkSummary({ telemetry_points: 3, display_name: null }), { telemetry_points: 3 });
  assert.equal(await checkTrack(new Uint8Array(track())), 3);
  assert.equal(await checkTrack(new Uint8Array(gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 2,
    columns: { offsetMs: [0, null], flightMode: ['GPS', null], cellVoltages: ['3.9,3.9', null], isVideo: [true, null] } })))), 2, 'text, flag and null values in their own columns');
  const bad = [
    [gzipSync(JSON.stringify({ schema: 'other', rowCount: 1, columns: { offsetMs: [0] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 2, columns: { offsetMs: [0] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [0], pilotId: ['x'] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [{}] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [true] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [0], isPhoto: [123] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [0], latitude: ['45'] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: 1, columns: { offsetMs: [0], flightMode: [7] } })), 'track_invalid'],
    [gzipSync(JSON.stringify({ schema: TRACK_SCHEMA, rowCount: DECODER_LIMITS.trackRows + 1, columns: { offsetMs: [] } })), 'track_invalid'],
    [gzipSync(Buffer.alloc(DECODER_LIMITS.trackJsonBytes + 1, 32)), 'track_too_large'],
    [new TextEncoder().encode('{"not":"gzip"}'), 'telemetry_not_gzip'],
  ];
  for (const [bytes, code] of bad) await assert.rejects(checkTrack(new Uint8Array(bytes)), error => error.code === code, code);
  await assert.rejects(checkTrack(new Uint8Array(DECODER_LIMITS.trackGzipBytes + 1)), error => error.code === 'track_too_large');
});

test('a result is stored under a key unique to its attempt and bytes, and referenced only by the fenced commit', async () => {
  env = await freshEnv();
  const { hash, bytes } = await addRaw('flight-one');
  const lease = await claim();
  const raw = await readRaw(env, lease);
  assert.deepEqual(new Uint8Array(await new Response(raw.body).arrayBuffer()), bytes);
  await assert.rejects(readRaw(env, { ...lease, attemptToken: 'not-mine' }), error => error.status === 409, 'only the holder reads the bytes');
  const done = await completeWithTrack(env, lease, { contentSha256: hash, summary: { telemetry_points: 3 }, track: new Uint8Array(track()), decoderVersion: VERSION });
  assert.equal(done.status, 'decoded');
  assert.match(done.telemetryKey, new RegExp(`^telemetry/v1/raw-${hash}/[0-9a-f]{16}-[0-9a-f]{16}\\.json\\.gz$`));
  const stored = await env.LOGS_BUCKET.get(done.telemetryKey);
  assert.deepEqual(new Uint8Array(await stored.arrayBuffer()), new Uint8Array(track()));
  const replay = await completeWithTrack(env, lease, { contentSha256: hash, summary: { telemetry_points: 3 }, track: new Uint8Array(track()), decoderVersion: VERSION });
  assert.deepEqual([replay.replayed, replay.telemetryKey], [true, done.telemetryKey]);
  await assert.rejects(completeWithTrack(env, lease, { contentSha256: hash, summary: { telemetry_points: 4 }, track: new Uint8Array(track(4)), decoderVersion: VERSION }),
    error => error.code === 'result_conflict', 'a different result for the same attempt is refused');
  await assert.rejects(completeWithTrack(env, lease, { contentSha256: hash, summary: { telemetry_points: 9 }, track: new Uint8Array(track()), decoderVersion: VERSION }),
    error => error.code === 'summary_invalid', 'the summary must agree with the track');
});

test('a stale attempt paused mid-upload while another commits leaves the winner’s track and reference untouched', async () => {
  env = await freshEnv();
  const { hash } = await addRaw('flight-race');
  const stale = await claim();
  let release, reached;
  const gate = new Promise(resolve => { release = resolve; }), paused = new Promise(resolve => { reached = resolve; });
  let first = true;
  const pausing = { ...env, LOGS_BUCKET: { head: async key => { if (first) { first = false; reached(); await gate; } return env.LOGS_BUCKET.head(key); },
    put: (...args) => env.LOGS_BUCKET.put(...args), get: (...args) => env.LOGS_BUCKET.get(...args) } };
  const staleUpload = completeWithTrack(pausing, stale, { contentSha256: hash, summary: { telemetry_points: 5 }, track: new Uint8Array(track(5)), decoderVersion: VERSION });
  await paused;   // the stale attempt passed its fence check and is about to write its track
  await env.LOGS_DB.prepare('UPDATE raw_logs SET lease_expires_at = ? WHERE sha256 = ?').bind('2000-01-01T00:00:00.000Z', hash).run();
  const winner = await claim();
  const won = await completeWithTrack(env, winner, { contentSha256: hash, summary: { telemetry_points: 3 }, track: new Uint8Array(track()), decoderVersion: VERSION });
  release();
  await assert.rejects(staleUpload, error => error.code === 'lease_stale');
  const flight = await env.LOGS_DB.prepare('SELECT telemetry_key FROM flights WHERE id = ?').bind(won.flightId).first();
  assert.equal(flight.telemetry_key, won.telemetryKey, 'the flight references the winner’s track');
  assert.deepEqual(new Uint8Array(await (await env.LOGS_BUCKET.get(won.telemetryKey)).arrayBuffer()), new Uint8Array(track()), 'the winner’s bytes are intact');
  const objects = (await env.LOGS_BUCKET.list({ prefix: `telemetry/v1/raw-${hash}/` })).objects.map(object => object.key);
  assert.equal(objects.length, 2, 'the stale attempt wrote only under its own key');
  assert.equal((await env.LOGS_DB.prepare('SELECT committed_attempt_token FROM raw_logs WHERE sha256 = ?').bind(hash).first()).committed_attempt_token, winner.attemptToken);
});

test('the public Logs host stays device API + /health only; decoding is reachable only through the private, closed-by-default RPC', async () => {
  env = await freshEnv();
  await addRaw('flight-rpc');
  for (const [method, url] of [['POST', 'https://logs.example/api/v1/decoder/lease'], ['POST', 'https://logs.example/api/v1/decoder/claim'], ['GET', 'https://logs.example/api/v1/decoder/raw']])
    assert.equal((await runtime.dispatchFetch(url, { method })).status, 404, `${method} ${url}`);
  assert.equal((await runtime.dispatchFetch('https://logs.example/health')).status, 200);
  const bridge = await runtime.getWorker('bridge');
  const closed = await (await bridge.fetch('https://bridge.example/', { method: 'POST', body: JSON.stringify({ op: 'claim', target: 'closed' }) })).json();
  assert.deepEqual(closed, { ok: false, error: { code: 'decoder_disabled', status: 503 } }, 'fixed codes only, no message text');
  const open = await (await bridge.fetch('https://bridge.example/', { method: 'POST', body: JSON.stringify({ op: 'claim', target: 'open' }) })).json();
  assert.equal(open.ok, true);
  assert.deepEqual(Object.keys(open.value).sort(), ['attempt', 'attemptToken', 'leaseExpiresAt', 'reclaims', 'sha256'], 'no pilot, device or storage key');
});
