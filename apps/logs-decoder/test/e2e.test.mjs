// End to end, locally: the real runner talks HTTP, in the Ops bridge's wire format, to the real Logs decoder functions
// (decode contract + DecoderService checks) on D1 + R2 in Miniflare. The bridge's own forwarding and auth are tested
// in apps/operations (logs-decoder-bridge.test.ts); here a small stand-in speaks the same protocol. Only the DJI
// parser is a stand-in too, so no key, no DJI call and no real log are needed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { createClient } from '../src/client.mjs';
import { decodeOne, run, ScratchError } from '../src/runner.mjs';
import { ParserError } from '../src/parser.mjs';

const logsDir = new URL('../../logs/', import.meta.url);
const { Miniflare } = createRequire(new URL('package.json', logsDir))('miniflare');
const decode = await import(new URL('src/worker/decode-contract.mjs', logsDir));
const service = await import(new URL('src/worker/decoder-service.mjs', logsDir));
const { applySchema } = await import(new URL('test/schema.mjs', logsDir));
const { LogsError } = await import(new URL('src/worker/errors.mjs', logsDir));

const TOKEN = 'runner-e2e-token-0123456789abcdefghijklmnopqrstu', AUDIENCE = 'ledgetop-logs-decoder-staging';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let runtime, env, server, baseUrl, outage = 0, dropReply = null, requests = [];
const workRoot = fs.mkdtempSync(`${os.tmpdir()}/decoder-e2e-`);
const noWait = async () => {};

async function body(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks); }
// Stand-in for the Ops bridge: same paths, headers and status mapping; forwards to the Logs decoder functions.
async function bridge(req) {
  const route = req.url.replace('/api/machine/logs-decoder/', '');
  if (req.headers.authorization !== `Bearer ${TOKEN}` || req.headers['x-machine-audience'] !== AUDIENCE) return [401, { error: 'unauthorized' }];
  const raw = await body(req);
  try {
    if (route === 'complete') {
      const lease = { sha256: req.headers['x-lease-sha256'], attemptToken: req.headers['x-attempt-token'] };
      const summary = JSON.parse(Buffer.from(req.headers['x-decode-summary'], 'base64url').toString());
      return [200, await service.completeWithTrack(env, lease, { contentSha256: req.headers['x-content-sha256'], summary, track: new Uint8Array(raw), decoderVersion: req.headers['x-decoder-version'] })];
    }
    const input = JSON.parse(raw.toString() || '{}'), lease = { sha256: input.sha256, attemptToken: input.attemptToken };
    if (route === 'claim') return [200, await decode.claimRawLog(env, { runnerId: 'staging-90-decoder-1', requestId: input.requestId })];
    if (route === 'heartbeat') return [200, await decode.heartbeatLease(env, lease)];
    if (route === 'reconcile') return [200, await decode.reconcileDecode(env, lease)];
    if (route === 'defer') return [200, await decode.deferDecode(env, lease, input.errorCode, { retryAfterSeconds: input.retryAfterSeconds })];
    if (route === 'retry') return [200, await decode.retryDecode(env, lease, input.errorCode)];
    if (route === 'suspend') return [200, await decode.suspendDecode(env, lease, input.errorCode)];
    if (route === 'fail') return [200, await decode.failDecode(env, lease, input.errorCode)];
    if (route === 'raw') { const held = await service.readRaw(env, lease); return [200, Buffer.from(await new Response(held.body).arrayBuffer()), held.sha256]; }
    return [404, { error: 'not_found' }];
  } catch (error) {
    if (error instanceof LogsError) return [error.status, { error: error.code }];
    throw error;
  }
}

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'decoder-e2e' }, r2Buckets: { LOGS_BUCKET: 'decoder-e2e' } });
  server = http.createServer(async (req, res) => {
    const route = req.url.split('/').pop();
    requests.push(`${req.method} ${req.url}`);
    if (outage > 0) { outage--; res.writeHead(503, { 'Content-Type': 'application/json' }).end('{"error":"unavailable"}'); return; }
    const [status, payload, contentSha] = await bridge(req);
    // Simulate a reply lost after the server already acted on the request.
    if (dropReply === route) { dropReply = null; req.socket.destroy(); return; }
    if (Buffer.isBuffer(payload)) { res.writeHead(status, { 'Content-Type': 'application/octet-stream', 'X-Content-Sha256': contentSha }).end(payload); return; }
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await runtime?.dispose(); fs.rmSync(workRoot, { recursive: true, force: true }); });

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  await applySchema(db);
  await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES ('dev-1', 'staff-beau', 'DJI RC PRO 2', 'h', 'staff-beau', ?)`).bind(new Date().toISOString()).run();
  env = { LOGS_DB: db, LOGS_BUCKET: bucket, DECODER_ENABLED: 'true' };
  requests = []; outage = 0; dropReply = null;
}
let uploaded = 0;
async function addRaw(text) {
  const bytes = new TextEncoder().encode(text), hash = sha(bytes);
  await env.LOGS_BUCKET.put(`raw/${hash}.txt`, bytes);
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, ?, ?, 'controller', 'dev-1', 'staff-beau', ?)`).bind(hash, bytes.length, `${text}.txt`, `raw/${hash}.txt`, new Date(Date.UTC(2026, 10, 13) + ++uploaded * 1000).toISOString()).run();
  return hash;
}
// Stand-in parser: decides by the log's content, as the real one would.
const fakeParser = async ({ inputFile }) => {
  const text = fs.readFileSync(inputFile, 'utf8');
  if (text.startsWith('needs-key')) throw new ParserError('defer', 'keychain_unavailable');
  if (text.startsWith('garbage')) return { version: 14, details: {}, frames: [] };
  if (text.startsWith('huge')) return { version: 14, details: {}, frames: Array.from({ length: 100_001 }, (_, i) => ({ osd: { flyTime: i / 10 } })) };
  return { version: 14, details: { totalTime: 2, totalDistance: 10, maxHeight: 5, maxHorizontalSpeed: 3, photoNum: 0 },
    frames: [0, 1, 2].map(i => ({ custom: { dateTime: new Date(Date.UTC(2026, 10, 13, 5) + i * 1000).toISOString() },
      osd: { flyTime: i, latitude: 45 + i / 1000, longitude: -93, height: i, altitude: 200, xSpeed: 1, ySpeed: 0, zSpeed: 0 },
      battery: { chargeLevel: 90 - i, voltage: 16 } })) };
};
const statusOf = async hash => env.LOGS_DB.prepare('SELECT parse_status, error_code, parse_attempts, flight_id FROM raw_logs WHERE sha256 = ?').bind(hash).first();
const client = (token = TOKEN) => createClient({ baseUrl, token, audience: AUDIENCE });
let seq = 0;
const ids = () => `e2e-request-${String(++seq).padStart(10, '0')}`;
async function runUntilIdle(c, idleRounds = 2) {
  const controller = new AbortController();
  let idle = 0;
  await run({ client: c, parser: fakeParser, workRoot, signal: controller.signal, idleMs: 1, newRequestId: ids,
    // Stop after a few waits of any kind: idle polls, or backoff while refused.
    sleep: async () => { if (++idle >= idleRounds) controller.abort(); } });
}

test('the runner decodes queued logs into flights with stored tracks, and reports closed outcomes for the rest', async () => {
  await freshEnv();
  const good = await addRaw('flight-a'), key = await addRaw('needs-key-b'), corrupt = await addRaw('garbage-c');
  await runUntilIdle(client());
  const done = await statusOf(good);
  assert.equal(done.parse_status, 'decoded');
  const flight = await env.LOGS_DB.prepare('SELECT * FROM flights WHERE id = ?').bind(done.flight_id).first();
  assert.deepEqual([flight.pilot_id, flight.file_hash, flight.telemetry_points, flight.duration_seconds], ['staff-beau', good, 3, 2]);
  const track = JSON.parse(gunzipSync(Buffer.from(await (await env.LOGS_BUCKET.get(flight.telemetry_key)).arrayBuffer())));
  assert.deepEqual(track.columns.offsetMs, [0, 1000, 2000]);
  assert.match((await env.LOGS_DB.prepare('SELECT decoder_version FROM raw_logs WHERE sha256 = ?').bind(good).first()).decoder_version, /^ltds-dji-decode\//);
  assert.deepEqual(await statusOf(corrupt), { parse_status: 'failed', error_code: 'corrupt_log', parse_attempts: 0, flight_id: null });
  assert.deepEqual(await statusOf(key), { parse_status: 'needs_parse', error_code: 'keychain_unavailable', parse_attempts: 0, flight_id: null }, 'deferred, no attempt used');
  assert.ok(requests.every(line => line.startsWith('POST /api/machine/logs-decoder/')), 'only the bridge paths are ever called');
});

test('while the bridge is down the runner waits with growing backoff and the same claim id, then carries on', async () => {
  await freshEnv();
  const hash = await addRaw('flight-outage');
  outage = 4;
  const controller = new AbortController(), waits = [];
  await run({ client: client(), parser: fakeParser, workRoot, signal: controller.signal, idleMs: 1, maxBackoffMs: 40_000, newRequestId: ids,
    sleep: async ms => { waits.push(ms); if (ms === 1) controller.abort(); } });
  assert.deepEqual(waits.slice(0, 4), [5_000, 10_000, 20_000, 40_000], 'backoff doubles up to the cap');
  assert.equal((await statusOf(hash)).parse_status, 'decoded');
  assert.equal((await statusOf(hash)).parse_attempts, 0, 'the outage used no attempt');
});

test('a lost claim reply is repeated with the same id and never takes a second log', async () => {
  await freshEnv();
  await addRaw('flight-x'); await addRaw('flight-y');
  dropReply = 'claim';
  const c = client();
  await assert.rejects(c.claim('lost-claim-request-01'));
  const again = await c.claim('lost-claim-request-01');
  assert.ok(again);
  assert.equal((await env.LOGS_DB.prepare("SELECT COUNT(*) AS n FROM raw_logs WHERE parse_status = 'leased'").first()).n, 1, 'one lease, not two');
});

test('a completion whose reply is lost is reconciled, not blindly re-sent; one flight', async () => {
  await freshEnv();
  const hash = await addRaw('flight-lost-ack');
  const c = client();
  const lease = await c.claim('lost-ack-request-0001');
  dropReply = 'complete';
  assert.equal(await decodeOne(lease, { client: c, parser: fakeParser, workRoot, sleep: noWait }), 'decoded');
  assert.equal((await statusOf(hash)).parse_status, 'decoded');
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 1);
  assert.ok(requests.some(line => line.endsWith('/reconcile')), 'asked Logs what happened');
});

test('a runner that stops mid-decode loses nothing: the log is offered again and the stale attempt can’t report', async () => {
  await freshEnv();
  const hash = await addRaw('flight-crash');
  const c = client();
  const first = await c.claim('crash-request-000001');
  await env.LOGS_DB.prepare("UPDATE raw_logs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE sha256 = ?").bind(hash).run();
  const second = await c.claim('crash-request-000002');
  assert.deepEqual([second.sha256, second.reclaims], [hash, 1]);
  await assert.rejects(decodeOne(first, { client: c, parser: fakeParser, workRoot, sleep: noWait }), error => error.status === 409);
  assert.equal(await decodeOne(second, { client: c, parser: fakeParser, workRoot, sleep: noWait }), 'decoded');
  assert.equal((await statusOf(hash)).parse_attempts, 0, 'the crash used no attempt');
  assert.deepEqual(fs.readdirSync(workRoot), [], 'temporary copies of logs are removed');
});

test('a wrong token never decodes anything; the runner just keeps waiting', async () => {
  await freshEnv();
  const hash = await addRaw('flight-wrong-token');
  await runUntilIdle(client('not-the-runner-token-0123456789abcdefghij'));
  assert.deepEqual(await statusOf(hash), { parse_status: 'needs_parse', error_code: null, parse_attempts: 0, flight_id: null });
});

test('a log over the track limits is suspended visibly for review, using no attempt; nothing is partly recorded', async () => {
  await freshEnv();
  const hash = await addRaw('huge-log');
  const c = client();
  const lease = await c.claim('huge-request-0000001');
  assert.equal(await decodeOne(lease, { client: c, parser: fakeParser, workRoot, sleep: noWait }), 'suspend:log_too_large');
  assert.deepEqual(await statusOf(hash), { parse_status: 'failed', error_code: 'log_too_large', parse_attempts: 0, flight_id: null });
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 0);
});

test('shutting down while Logs is unreachable returns promptly: no endless reconcile, no held result', async () => {
  await freshEnv();
  const hash = await addRaw('flight-shutdown');
  const c = client();
  const lease = await c.claim('shutdown-request-0001');
  const controller = new AbortController();
  // Logs goes down once the log has been read and decoded: every call fails from then on.
  const parserThenOutage = async input => { const output = await fakeParser(input); outage = 1_000; return output; };
  let sleeps = 0;
  const label = await decodeOne(lease, { client: c, parser: parserThenOutage, workRoot, signal: controller.signal,
    sleep: async () => { if (++sleeps === 2) controller.abort(); } });
  outage = 0;
  assert.ok(['stopped', 'unreported'].includes(label), label);
  assert.ok(sleeps <= 3, 'it stopped waiting as soon as it was told to');
  assert.equal((await statusOf(hash)).parse_status, 'leased', 'nothing was reported; the lease will expire and the log will be offered again');
  assert.deepEqual(fs.readdirSync(workRoot), [], 'scratch is cleaned');
});

test('if scratch can’t be verified clean, the runner stops instead of taking another log', async () => {
  await freshEnv();
  await addRaw('flight-scratch');
  const c = client();
  const lease = await c.claim('scratch-request-00001');
  const stuck = fs.mkdtempSync(`${os.tmpdir()}/decoder-stuck-`);
  // A parser that leaves a read-only directory behind stands in for scratch that can't be removed.
  const sticky = async ({ workDir }) => { fs.mkdirSync(`${workDir}/locked`); fs.writeFileSync(`${workDir}/locked/f`, 'x'); fs.chmodSync(`${workDir}/locked`, 0o500); throw new ParserError('defer', 'dji_unavailable'); };
  const rmBefore = fs.promises.rm;
  fs.promises.rm = async () => {};   // simulate a removal that silently fails
  try {
    await assert.rejects(decodeOne(lease, { client: c, parser: sticky, workRoot: stuck, sleep: noWait }), error => error instanceof ScratchError);
  } finally {
    fs.promises.rm = rmBefore;
    for (const dir of fs.readdirSync(stuck)) { fs.chmodSync(`${stuck}/${dir}/locked`, 0o700); }
    fs.rmSync(stuck, { recursive: true, force: true });
  }
});
