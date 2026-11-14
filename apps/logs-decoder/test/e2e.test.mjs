// End to end, locally: the real runner talks HTTP to the real Logs decoder routes (D1 + R2 in Miniflare).
// Only the DJI parser is a stand-in, so no key, no DJI call and no real log are needed.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { createClient } from '../src/client.mjs';
import { decodeOne, run } from '../src/runner.mjs';
import { ParserError } from '../src/parser.mjs';

const logsDir = new URL('../../logs/', import.meta.url);
const { Miniflare } = createRequire(new URL('package.json', logsDir))('miniflare');
const { handleDecoderRequest } = await import(new URL('src/worker/decoder-routes.mjs', logsDir));

const TOKEN = 'runner-e2e-token-0123456789abcdefghijklmnopqrstu';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
let runtime, env, server, baseUrl, outage = 0, requests = [];
const workRoot = fs.mkdtempSync(`${os.tmpdir()}/decoder-e2e-`);

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'decoder-e2e' }, r2Buckets: { LOGS_BUCKET: 'decoder-e2e' } });
  server = http.createServer(async (req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (outage > 0) { outage--; res.writeHead(503).end(); return; }
    const request = new Request(`http://local${req.url}`, { method: req.method, headers: req.headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : Readable.toWeb(req), duplex: 'half' });
    const response = (await handleDecoderRequest(request, env)) ?? new Response('Not found', { status: 404 });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await runtime?.dispose(); fs.rmSync(workRoot, { recursive: true, force: true }); });

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql', '0003_device_eligibility_revision.sql']) {
    const sql = fs.readFileSync(new URL(`migrations/${file}`, logsDir), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  await db.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at) VALUES ('dev-1', 'staff-beau', 'DJI RC PRO 2', 'h', 'staff-beau', ?)`).bind(new Date().toISOString()).run();
  env = { LOGS_DB: db, LOGS_BUCKET: bucket, DECODER_ENABLED: 'true', DECODER_TOKEN_SHA256: sha(TOKEN) };
  requests = []; outage = 0;
}
let uploaded = 0;
async function addRaw(text) {
  const bytes = new TextEncoder().encode(text), hash = sha(bytes);
  await env.LOGS_BUCKET.put(`raw/${hash}`, bytes);
  await env.LOGS_DB.prepare(`INSERT INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, ?, ?, 'controller', 'dev-1', 'staff-beau', ?)`).bind(hash, bytes.length, `${text}.txt`, `raw/${hash}`, new Date(Date.UTC(2026, 10, 13) + ++uploaded * 1000).toISOString()).run();
  return hash;
}
// Stand-in parser: decides by the log's content, as the real one would.
const fakeParser = async ({ inputFile }) => {
  const text = fs.readFileSync(inputFile, 'utf8');
  if (text.startsWith('needs-key')) throw new ParserError('keychain_unavailable', 'stand-in');
  if (text.startsWith('garbage')) return { version: 14, details: {}, frames: [] };
  return { version: 14, details: { totalTime: 2, totalDistance: 10, maxHeight: 5, maxHorizontalSpeed: 3, photoNum: 0 },
    frames: [0, 1, 2].map(i => ({ custom: { dateTime: new Date(Date.UTC(2026, 10, 13, 5) + i * 1000).toISOString() },
      osd: { flyTime: i, latitude: 45 + i / 1000, longitude: -93, height: i, altitude: 200, xSpeed: 1, ySpeed: 0, zSpeed: 0 },
      battery: { chargeLevel: 90 - i, voltage: 16 } })) };
};
const statusOf = async hash => env.LOGS_DB.prepare('SELECT parse_status, error_code, flight_id FROM raw_logs WHERE sha256 = ?').bind(hash).first();

test('the runner decodes queued logs into flights with stored tracks, and reports closed codes for the rest', async () => {
  await freshEnv();
  const good = await addRaw('flight-a'), key = await addRaw('needs-key-b'), corrupt = await addRaw('garbage-c');
  const client = createClient({ baseUrl, token: TOKEN });
  const controller = new AbortController();
  let idle = 0;
  await run({ client, parser: fakeParser, workRoot, signal: controller.signal, idleMs: 1,
    sleep: async () => { if (++idle >= 2) controller.abort(); } });
  const done = await statusOf(good);
  assert.equal(done.parse_status, 'decoded');
  const flight = await env.LOGS_DB.prepare('SELECT * FROM flights WHERE id = ?').bind(done.flight_id).first();
  assert.deepEqual([flight.pilot_id, flight.file_hash, flight.telemetry_points, flight.duration_seconds], ['staff-beau', good, 3, 2]);
  const track = JSON.parse(gunzipSync(Buffer.from(await (await env.LOGS_BUCKET.get(flight.telemetry_key)).arrayBuffer())));
  assert.deepEqual(track.columns.offsetMs, [0, 1000, 2000]);
  assert.deepEqual(await statusOf(corrupt), { parse_status: 'failed', error_code: 'corrupt_log', flight_id: null });
  // A missing keychain is retryable: it goes back in the queue, up to the attempt cap.
  const retried = await statusOf(key);
  assert.ok(['needs_parse', 'failed'].includes(retried.parse_status));
  assert.ok(['keychain_unavailable', 'attempts_exhausted'].includes(retried.error_code));
  assert.ok(requests.every(line => line.startsWith('POST /api/v1/decoder/')), 'only the decoder routes are ever called');
});

test('while Logs is down the runner waits with growing backoff, then carries on; nothing is lost', async () => {
  await freshEnv();
  const hash = await addRaw('flight-outage');
  outage = 4;
  const client = createClient({ baseUrl, token: TOKEN });
  const controller = new AbortController(), waits = [];
  await run({ client, parser: fakeParser, workRoot, signal: controller.signal, idleMs: 1, maxBackoffMs: 40_000,
    sleep: async ms => { waits.push(ms); if (ms === 1) controller.abort(); } });
  assert.deepEqual(waits.slice(0, 4), [5_000, 10_000, 20_000, 40_000], 'backoff doubles up to the cap');
  assert.equal((await statusOf(hash)).parse_status, 'decoded', 'decoded once Logs was back');
});

test('a runner that stops mid-decode loses nothing: the log is offered again after its lease, and the stale report is refused', async () => {
  await freshEnv();
  const hash = await addRaw('flight-crash');
  const client = createClient({ baseUrl, token: TOKEN });
  const [first] = await client.lease(1);
  // The runner "crashes" after leasing: no report. The lease expires (simulated) and the log is handed out again.
  await env.LOGS_DB.prepare("UPDATE raw_logs SET lease_expires_at = '2000-01-01T00:00:00.000Z' WHERE sha256 = ?").bind(hash).run();
  const [second] = await client.lease(1);
  assert.equal(second.sha256, hash);
  assert.equal(second.attempt, 2);
  await assert.rejects(decodeOne(first, { client, parser: fakeParser, workRoot }), error => error.status === 409, 'the old attempt can no longer report');
  assert.equal(await decodeOne(second, { client, parser: fakeParser, workRoot }), 'decoded');
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 1, 'one flight, not two');
  assert.deepEqual(fs.readdirSync(workRoot), [], 'temporary copies of logs are removed');
});

test('a wrong token never decodes anything; the runner just keeps waiting', async () => {
  await freshEnv();
  const hash = await addRaw('flight-wrong-token');
  const client = createClient({ baseUrl, token: 'not-the-runner-token-0123456789abcdefghij' });
  const controller = new AbortController();
  let waits = 0;
  await run({ client, parser: fakeParser, workRoot, signal: controller.signal, sleep: async () => { if (++waits >= 2) controller.abort(); } });
  assert.deepEqual(await statusOf(hash), { parse_status: 'needs_parse', error_code: null, flight_id: null });
});
