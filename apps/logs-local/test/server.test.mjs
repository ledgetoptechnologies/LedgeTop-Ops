// The local Logs HTTP server end to end on 127.0.0.1: real Access-style JWTs through machine-auth, the real
// Logs device and service code, SQLite and the local object store. Temp dirs, synthetic data, fake Ops
// directory; nothing leaves this machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { createHash, generateKeyPairSync, sign, webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate, LEDGERS } from '../src/migrations.mjs';
import { FsR2 } from '../src/fs-r2.mjs';
import { createMachineAuth, encodeActor } from '../src/machine-auth.mjs';
import { createIdempotency } from '../src/idempotency.mjs';
import { createLogsServer, createHealthServer, SERVER_LIMITS } from '../src/server.mjs';
import { parseConfig, checkConfigFile, ConfigError, describe } from '../src/config.mjs';
import * as device from '../../logs/src/worker/device.mjs';

const ISSUER = 'https://ledgetoptechnologies.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const STAFF = 'staff-proxy-client.access', DEVICE = 'device-proxy-client.access';
const sha = data => createHash('sha256').update(data).digest('hex');
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const verifyKey = await webcrypto.subtle.importKey('jwk', { ...publicKey.export({ format: 'jwk' }), alg: 'RS256' },
  { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
const b64 = v => Buffer.from(JSON.stringify(v)).toString('base64url');
function jwt(clientId) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64({ alg: 'RS256', kid: 'k1' }), body = b64({ type: 'app', sub: '', common_name: clientId, iss: ISSUER, aud: [AUD], iat: now - 5, exp: now + 300 });
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), privateKey).toString('base64url')}`;
}
const beau = { staffId: 'staff-beau', permissions: ['flight_logs.view', 'flight_logs.import'] };

async function harness(t, { uploadConcurrency = 4, statfs, authority } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-server-'));
  const db = new SqliteD1(':memory:');
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)), { ledger: LEDGERS.local });
  const bucket = new FsR2(path.join(dir, 'objects'), { durableBase: dir, statfs: statfs ?? (() => ({ bavail: 1e9, bsize: 4096 })) });
  const directory = {
    authorityCalls: 0,
    async resolvePilotUsername(u) { return u === 'bkoltz' ? { staffId: 'staff-beau', eligibilityRevision: 1 } : null; },
    async getPilotDeviceAuthority(id) { return id === 'staff-beau' ? { eligible: true, revision: 1 } : { eligible: false, revision: null }; },
    async isActiveStaff(id) { return id === 'staff-beau'; },
    async getStaffAuthority(staffId) { this.authorityCalls++; if (authority instanceof Error) throw authority;
      return (typeof authority === 'function' ? authority(staffId) : authority) ?? { active: true, canViewAll: true, canImport: true, administrator: true }; },
  };
  const env = { LOGS_DB: db, LOGS_BUCKET: bucket, OPS_DIRECTORY: directory };
  const authorize = createMachineAuth({ issuer: ISSUER, audience: AUD, identities: { [STAFF]: 'staff-proxy', [DEVICE]: 'device-proxy' } }, { getKey: async () => verifyKey });
  // The server only answers its one ingress host; reserve a port so that host is known before it starts.
  const port = await new Promise(resolve => { const probe = net.createServer().listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolve(p)); }); });
  const logs = createLogsServer({ env, authorize, directory, ingressHost: `127.0.0.1:${port}`, idempotency: createIdempotency(db), uploadConcurrency });
  await new Promise(resolve => logs.server.listen(port, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${logs.server.address().port}`;
  device.clearActiveCache();
  t.after(async () => { await logs.close(1000); bucket.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const call = async (method, route, { role, body, raw, token, poll, headers = {}, actor = beau } = {}) => {
    const h = { ...headers };
    if (role === 'staff') { h['Cf-Access-Jwt-Assertion'] = jwt(STAFF); h['X-Ledge-Top-Actor'] = encodeActor(actor); }
    if (role === 'device') h['Cf-Access-Jwt-Assertion'] = jwt(DEVICE);
    if (token) h.Authorization = `Bearer ${token}`;
    if (poll) h['X-Poll-Token'] = poll;
    const init = { method, headers: h };
    if (raw !== undefined) init.body = raw; else if (body !== undefined) { init.body = JSON.stringify(body); h['Content-Type'] = 'application/json'; }
    const response = await fetch(`${base}${route}`, init);
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, headers: response.headers, body: type.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  };
  const rpc = (method, args = [], options = {}) => call('POST', `/internal/v1/logs/rpc/${method}`, { role: 'staff', body: { args }, ...options });
  async function signIn() {
    const started = await call('POST', '/api/v1/device/sign-in', { role: 'device', body: { username: 'bkoltz', model: 'DJI RC PLUS 2' } });
    assert.equal(started.status, 201);
    const pending = await rpc('pendingSignIns');
    const decided = await rpc('decideSignIn', [{ signInId: pending.body.value.items[0].id, approve: true }], { headers: { 'Idempotency-Key': `approve-${started.body.signInId}` } });
    assert.equal(decided.body.ok, true, JSON.stringify(decided.body));
    const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { role: 'device', poll: started.body.pollToken });
    return collected.body.deviceToken;
  }
  return { dir, db, bucket, directory, logs, base, call, rpc, signIn };
}

test('without a valid machine identity every route is the same 404, including health and the device API', async t => {
  const { call } = await harness(t);
  for (const [method, route, role] of [['GET', '/health'], ['GET', '/api/v1/device/me'], ['POST', '/internal/v1/logs/rpc/inventory'],
    ['GET', '/api/v1/device/me', 'staff'], ['POST', '/internal/v1/logs/rpc/inventory', 'device'], ['GET', '/', 'device'], ['GET', '/healthz', 'device']])
    assert.equal((await call(method, route, { role })).status, 404, `${method} ${route} as ${role ?? 'nobody'}`);
});

test('controller sign-in, approval in Ops, and a streamed raw log upload work end to end', async t => {
  const { call, signIn, bucket, db } = await harness(t);
  const token = await signIn();
  const me = await call('GET', '/api/v1/device/me', { role: 'device', token });
  assert.deepEqual([me.status, me.body.pilot.id], [200, 'staff-beau']);
  const log = Buffer.from('synthetic controller flight log');
  const first = await call('PUT', `/api/v1/device/logs/${sha(log)}?name=DJIFlightRecord_1.txt`, { role: 'device', token, raw: log });
  assert.deepEqual([first.status, first.body], [201, { stored: true, duplicate: false }]);
  const again = await call('PUT', `/api/v1/device/logs/${sha(log)}?name=DJIFlightRecord_1.txt`, { role: 'device', token, raw: log });
  assert.deepEqual([again.status, again.body], [200, { stored: true, duplicate: true }]);
  assert.equal(Buffer.from(await (await bucket.get(device.rawLogKey(sha(log)))).bytes()).toString(), log.toString());
  const row = await db.prepare('SELECT size_bytes, source, pilot_id, file_name FROM raw_logs').first();
  assert.deepEqual(row, { size_bytes: log.length, source: 'controller', pilot_id: 'staff-beau', file_name: 'DJIFlightRecord_1.txt' });
  const have = await call('POST', '/api/v1/device/have', { role: 'device', token, body: { files: [{ sha256: sha(log) }, { sha256: sha('other') }] } });
  assert.equal(have.status, 200);
});

test('uploads: wrong SHA 422, empty 413, bad token 401, nothing stored', async t => {
  const { call, signIn, dir } = await harness(t);
  const token = await signIn();
  const log = Buffer.from('bytes');
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha('different')}`, { role: 'device', token, raw: log })).status, 422);
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha('')}`, { role: 'device', token, raw: Buffer.alloc(0) })).status, 413);
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha(log)}`, { role: 'device', token: 'x'.repeat(43), raw: log })).status, 401);
  const blobs = fs.readdirSync(path.join(dir, 'objects', 'blobs'), { recursive: true, withFileTypes: true }).filter(e => e.isFile());
  assert.equal(blobs.length, 0);
});

test('an upload announcing more than 100 MiB is refused before its body is read', async t => {
  const { base, signIn } = await harness(t);
  const token = await signIn();
  const { port } = new URL(base);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/v1/device/logs/${sha('x')}`,
      headers: { 'Cf-Access-Jwt-Assertion': jwt(DEVICE), Authorization: `Bearer ${token}`, 'Content-Length': String(SERVER_LIMITS.rawLogBytes + 1) } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.write(Buffer.alloc(1024));
  });
  assert.equal(status, 413);
});

test('storage near full: 503 with Retry-After, the log stays on the controller, nothing is evicted', async t => {
  let free = 1e12;
  const { call, signIn } = await harness(t, { statfs: () => ({ bavail: free, bsize: 1 }) });
  const token = await signIn();
  const kept = Buffer.from('kept');
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha(kept)}`, { role: 'device', token, raw: kept })).status, 201);
  free = 1;
  const full = await call('PUT', `/api/v1/device/logs/${sha('later')}`, { role: 'device', token, raw: Buffer.from('later') });
  assert.deepEqual([full.status, full.body.code, full.headers.get('retry-after')], [503, 'storage_full', String(SERVER_LIMITS.storageRetryAfterSeconds)]);
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha(kept)}`, { role: 'device', token, raw: kept })).body.duplicate, true);
});

test('concurrent uploads beyond the cap get 503 busy with Retry-After', async t => {
  const { base, call, signIn } = await harness(t, { uploadConcurrency: 1 });
  const token = await signIn();
  const { port } = new URL(base);
  const slow = Buffer.alloc(64 * 1024, 7);
  const first = http.request({ host: '127.0.0.1', port, method: 'PUT', path: `/api/v1/device/logs/${sha(slow)}`,
    headers: { 'Cf-Access-Jwt-Assertion': jwt(DEVICE), Authorization: `Bearer ${token}`, 'Content-Length': String(slow.length) } });
  const firstDone = new Promise(resolve => first.on('response', res => { res.resume(); resolve(res.statusCode); }));
  first.write(slow.subarray(0, 1024));
  await new Promise(resolve => setTimeout(resolve, 100));
  const busy = await call('PUT', `/api/v1/device/logs/${sha('second')}`, { role: 'device', token, raw: Buffer.from('second') });
  assert.deepEqual([busy.status, busy.body.code, busy.headers.get('retry-after')], [503, 'busy', String(SERVER_LIMITS.busyRetryAfterSeconds)]);
  first.end(slow.subarray(1024));
  assert.equal(await firstDone, 201);
});

test('sign-in starts are rate limited per controller address', async t => {
  const { call } = await harness(t);
  const statuses = [];
  for (let i = 0; i < SERVER_LIMITS.signInStartsPerMinute + 1; i++)
    statuses.push((await call('POST', '/api/v1/device/sign-in', { role: 'device', body: { username: 'nobody', model: 'x' }, headers: { 'X-Ledge-Top-Client-IP': '198.51.100.7' } })).status);
  assert.equal(statuses.at(-1), 429);
  assert.notEqual((await call('POST', '/api/v1/device/sign-in', { role: 'device', body: { username: 'nobody', model: 'x' }, headers: { 'X-Ledge-Top-Client-IP': '198.51.100.8' } })).status, 429);
});

test('staff RPC: reads return the result envelope; keyed writes need a key, run once, and recheck authority fresh', async t => {
  const { rpc, call, directory } = await harness(t);
  const listed = await rpc('listFlights', [{}]);
  assert.deepEqual([listed.status, listed.body.ok], [200, true]);
  const started = await call('POST', '/api/v1/device/sign-in', { role: 'device', body: { username: 'bkoltz', model: 'DJI RC PLUS 2' } });
  const signInId = (await rpc('pendingSignIns')).body.value.items[0].id;
  const noKey = await rpc('decideSignIn', [{ signInId, approve: true }]);
  assert.deepEqual([noKey.body.ok, noKey.body.error.code], [false, 'idempotency_key_invalid']);
  const before = directory.authorityCalls;
  const key = { headers: { 'Idempotency-Key': 'approve-key-000000001' } };
  const once = await rpc('decideSignIn', [{ signInId, approve: true }], key);
  const twice = await rpc('decideSignIn', [{ signInId, approve: true }], key);
  assert.equal(once.body.ok, true);
  assert.deepEqual(twice.body, once.body, 'the replay returns the stored answer');
  assert.equal(directory.authorityCalls - before, 2, 'authority is checked fresh on every keyed write, never cached');
  void started;
  assert.equal((await call('POST', '/internal/v1/logs/rpc/notAMethod', { role: 'staff', body: { args: [] } })).status, 404);
  const huge = await call('POST', '/internal/v1/logs/rpc/listFlights', { role: 'staff', raw: Buffer.alloc(SERVER_LIMITS.rpcBodyBytes + 1, 32), headers: { 'Content-Type': 'application/json' } });
  assert.equal(huge.body.error.code, 'body_too_large');
});

test('sensitive writes fail closed when Ops authority is missing or unreachable', async t => {
  for (const [authority, code] of [[{ active: false, canViewAll: true, canImport: true, administrator: true }, 'forbidden'],
    [{ active: true, canViewAll: true, canImport: false, administrator: false }, 'forbidden'], [new Error('ops down'), 'directory_unavailable']]) {
    const { rpc } = await harness(t, { authority });
    const result = await rpc('startImport', [{ sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 }], { headers: { 'Idempotency-Key': 'import-key-0000000001' } });
    assert.deepEqual([result.body.ok, result.body.error.code], [false, code], JSON.stringify(authority));
  }
});

test('telemetry for an unknown flight is a 404 envelope, not bytes', async t => {
  const { call } = await harness(t);
  const missing = await call('GET', '/internal/v1/logs/flights/nope/telemetry', { role: 'staff' });
  assert.deepEqual([missing.body.ok, missing.body.error.code], [false, 'track_not_found']);
});

test('health is a separate listener: /healthz only', async t => {
  const health = createHealthServer(() => ({ decoder: 'waiting_for_key' }));
  await new Promise(resolve => health.listen(0, '127.0.0.1', resolve));
  t.after(() => health.close());
  const base = `http://127.0.0.1:${health.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/healthz`)).json(), { ok: true, decoder: 'waiting_for_key' });
  assert.equal((await fetch(`${base}/api/v1/device/me`)).status, 404);
});

const CONFIG = `# test config
LOGS_DATA_DIR=/data/flight-logs
ACCESS_ISSUER=${ISSUER}
LOGS_INGRESS_HOST=logs-backend-staging.example.test
ACCESS_AUDIENCE=${AUD}
ACCESS_STAFF_PROXY_CLIENT_ID=${STAFF}
ACCESS_DEVICE_PROXY_CLIENT_ID=${DEVICE}
OPS_DIRECTORY_BASE_URL=https://ops.example.test/
OPS_DIRECTORY_CLIENT_ID=directory-client.access
OPS_DIRECTORY_CLIENT_SECRET="${'s'.repeat(32)}"
DJI_API_KEY=
`;

test('config: known keys only, required machine credentials, blank DJI key allowed, values never in errors', () => {
  const config = parseConfig(CONFIG);
  assert.equal(config.OPS_DIRECTORY_CLIENT_SECRET, 's'.repeat(32), 'quotes are stripped');
  assert.equal(config.DJI_API_KEY, '');
  assert.deepEqual([config.LOGS_PORT, config.LOGS_HEALTH_PORT, config.UPLOAD_CONCURRENCY], [8080, 8081, 4]);
  assert.deepEqual(describe(config), { djiKey: false, keychainKey: false, uploadConcurrency: 4 });
  const cases = {
    config_unknown_key: `${CONFIG}DJI_APP_KEY=x\n`,
    config_missing: CONFIG.replace(/^OPS_DIRECTORY_CLIENT_SECRET=.*$/m, 'OPS_DIRECTORY_CLIENT_SECRET='),
    config_duplicate_key: `${CONFIG}DJI_API_KEY=abc\n`,
    config_syntax: `${CONFIG}just words\n`,
  };
  for (const [code, text] of Object.entries(cases)) assert.throws(() => parseConfig(text), err => err instanceof ConfigError && err.code === code, code);
  assert.throws(() => parseConfig(CONFIG.replace('/data/flight-logs', 'relative/dir')), err => err.code === 'config_value');
  assert.throws(() => parseConfig(CONFIG.replace('LOGS_DATA_DIR=/data/flight-logs', 'LOGS_DATA_DIR=/data')), err => err.code === 'config_value', 'only the fixed flight-logs dir');
  assert.equal(parseConfig(CONFIG.replace(/^LOGS_DATA_DIR=.*\n/m, '')).LOGS_DATA_DIR, '/data/flight-logs', 'defaults to the fixed dir');
  assert.throws(() => parseConfig(`${CONFIG.replace('DJI_API_KEY=', 'DJI_API_KEY=$(cat /etc/passwd)')}`), err => err.code === 'config_value' && !err.message.includes('passwd'));
  assert.throws(() => parseConfig(`${CONFIG}UPLOAD_CONCURRENCY=99\n`), err => err.code === 'config_value');
});

test('config file: refused unless owned by this user and private (Linux rules)', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'logs.env');
  fs.writeFileSync(file, CONFIG);
  const { uid, mode } = fs.statSync(file);
  if (mode & 0o077) assert.throws(() => checkConfigFile(file, { platform: 'linux', uid }), err => err.code === 'config_permissions', 'group/other readable');
  assert.throws(() => checkConfigFile(file, { platform: 'linux', uid: uid + 1 }), err => err.code === 'config_permissions', 'another owner');
  assert.throws(() => checkConfigFile(dir, { platform: 'linux', uid }), err => err.code === 'config_file');
});

test('only the configured ingress host is served; any other Host is a 404 before authentication', async t => {
  const { base } = await harness(t);
  const { port } = new URL(base);
  const status = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/v1/device/me', headers: { Host: 'evil.example.test', 'Cf-Access-Jwt-Assertion': jwt(DEVICE) } },
      res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(status, 404);
  assert.throws(() => createLogsServer({ env: {}, authorize: async () => ({ ok: false }), directory: {}, idempotency: () => {}, ingressHost: '' }), /ingress_host_invalid/);
});

test('an import batch above 1 MiB (up to the Ops 8 MiB batch limit) is accepted; other RPC bodies stay at 1 MiB', async t => {
  const { rpc } = await harness(t);
  const started = await rpc('startImport', [{ sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 }], { headers: { 'Idempotency-Key': 'import-key-big-000001' } });
  assert.equal(started.body.ok, true, JSON.stringify(started.body));
  const big = await rpc('importFlights', [started.body.value.importId, { flights: [], messages: [], keychains: [], padding: 'x'.repeat(3 * 1024 * 1024) }]);
  assert.notEqual(big.body.error?.code, 'body_too_large', 'a 3 MiB batch body is within the import limit');
  const tooBig = await rpc('listFlights', [{ padding: 'x'.repeat(2 * 1024 * 1024) }]);
  assert.equal(tooBig.body.error.code, 'body_too_large');
});

test('revoking another pilot\'s controller needs import authority NOW, not just in the asserted actor', async t => {
  let kollinCanImport = false;
  const { rpc, signIn } = await harness(t, { authority: id => ({ active: true, canViewAll: true, canImport: id === 'staff-kollin' ? kollinCanImport : true, administrator: false }) });
  await signIn();
  const deviceId = (await rpc('listDevices', [{ all: true }])).body.value.items[0].id;
  const kollin = { staffId: 'staff-kollin', permissions: ['flight_logs.view', 'flight_logs.import'] };
  const denied = await rpc('revokeDevice', [deviceId], { actor: kollin, headers: { 'Idempotency-Key': 'revoke-key-0000000001' } });
  assert.deepEqual([denied.body.ok, denied.body.error.code], [false, 'device_not_found'], 'a stale asserted import permission is not honoured');
  kollinCanImport = true;
  const allowed = await rpc('revokeDevice', [deviceId], { actor: kollin, headers: { 'Idempotency-Key': 'revoke-key-0000000002' } });
  assert.deepEqual(allowed.body, { ok: true, value: { revoked: true } });
});
