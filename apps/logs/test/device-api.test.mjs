import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare } from 'miniflare';
import { handleDeviceRequest } from '../src/worker/device-routes.mjs';
import * as device from '../src/worker/device.mjs';

let runtime, env;
const beau = { staffId: 'staff-beau', permissions: ['flight_logs.view'] };
const kollin = { staffId: 'staff-kollin', permissions: ['flight_logs.view'] };
const manager = { staffId: 'staff-admin', permissions: ['flight_logs.view', 'flight_logs.import'] };

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql']) {
    const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  return { LOGS_DB: db, LOGS_BUCKET: bucket };
}
const call = async (method, path, { body, token, poll, raw } = {}) => {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (poll) headers['X-Poll-Token'] = poll;
  const init = { method, headers };
  if (raw) init.body = raw; else if (body !== undefined) { init.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  const response = await handleDeviceRequest(new Request(`https://logs.example.test${path}`, init), env);
  return { status: response.status, body: await response.json() };
};
async function signIn(username, approver) {
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username, model: 'DJI RC PLUS 2', hardwareId: 'android-1' } });
  assert.equal(started.status, 201);
  const pending = await device.pendingSignIns(env, approver, { username });
  await device.decideSignIn(env, approver, { signInId: pending.items[0].id, username, approve: true });
  const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  return { started, collected };
}

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'device-test' }, r2Buckets: { LOGS_BUCKET: 'device-test' } });
});
after(async () => { await runtime?.dispose(); });

test('a pilot signs in by username; only that person can approve, and the token is collected exactly once', async () => {
  env = await freshEnv();
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username: '  BKoltz ', model: 'DJI RC PLUS 2' } });
  assert.equal(started.status, 201);
  assert.equal(started.body.username, 'bkoltz');
  assert.match(started.body.code, /^[A-Z]{3}-\d{3}$/);
  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })).body.status, 'pending');

  // Someone else signed in to Ops can't see or approve a request addressed to bkoltz.
  assert.deepEqual((await device.pendingSignIns(env, kollin, { username: 'kstern' })).items, []);
  await assert.rejects(device.decideSignIn(env, kollin, { signInId: started.body.signInId, username: 'kstern', approve: true }), e => e.code === 'sign_in_not_found');
  const mine = await device.pendingSignIns(env, beau, { username: 'bkoltz' });
  assert.equal(mine.items.length, 1);
  assert.equal(mine.items[0].code, started.body.code);
  await device.decideSignIn(env, beau, { signInId: started.body.signInId, username: 'bkoltz', approve: true });

  // A wrong poll token learns nothing; the right one collects the token once.
  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: 'wrong' })).status, 404);
  const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  assert.equal(collected.body.status, 'approved');
  assert.equal(collected.body.pilot.id, 'staff-beau');
  assert.ok(collected.body.deviceToken.length >= 40);
  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })).body.status, 'expired', 'not twice');
  const stored = await env.LOGS_DB.prepare('SELECT token_hash FROM devices').first();
  assert.notEqual(stored.token_hash, collected.body.deviceToken, 'only a hash is kept');
  assert.equal((await call('GET', '/api/v1/device/me', { token: collected.body.deviceToken })).body.pilot.id, 'staff-beau');
});

test('a denied, expired or malformed sign-in never yields a token', async () => {
  env = await freshEnv();
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'not a user!' } })).status, 400);
  const denied = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  await device.decideSignIn(env, beau, { signInId: denied.body.signInId, username: 'bkoltz', approve: false });
  assert.equal((await call('GET', `/api/v1/device/sign-in/${denied.body.signInId}`, { poll: denied.body.pollToken })).body.status, 'denied');
  await assert.rejects(device.decideSignIn(env, beau, { signInId: denied.body.signInId, username: 'bkoltz', approve: true }), e => e.code === 'sign_in_closed');
  const late = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  await env.LOGS_DB.prepare("UPDATE device_sign_ins SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(late.body.signInId).run();
  assert.equal((await call('GET', `/api/v1/device/sign-in/${late.body.signInId}`, { poll: late.body.pollToken })).body.status, 'expired');
  await assert.rejects(device.decideSignIn(env, beau, { signInId: late.body.signInId, username: 'bkoltz', approve: true }), e => e.code === 'sign_in_closed');
  assert.equal((await call('GET', '/api/v1/device/me')).status, 401);
  assert.equal((await call('GET', '/api/v1/device/me', { token: 'x'.repeat(43) })).status, 401);
});

test('raw logs upload write-once by content hash, keep their first attribution and link an imported flight', async () => {
  env = await freshEnv();
  const { collected } = await signIn('bkoltz', beau);
  const token = collected.body.deviceToken;
  const bytes = new TextEncoder().encode('DJI raw log bytes '.repeat(500));
  const sha = await device.sha256Hex(bytes);
  // An ODL-imported flight for the same file is waiting for its original log.
  await env.LOGS_DB.prepare(`INSERT INTO imports (id, source_system, pilot_id, actor_id, expected_flights, started_at) VALUES ('i1', 'opendronelog', 'staff-beau', 'staff-beau', 1, 'now')`).run();
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, import_id, pilot_id, pilot_attribution, created_at, updated_at) VALUES ('f1', ?, 'opendronelog', 'i1', 'staff-beau', 'backup_owner', 'now', 'now')`).bind(sha).run();

  assert.deepEqual((await call('POST', '/api/v1/device/have', { token, body: { files: [{ sha256: sha, size: bytes.length }, { sha256: 'nope' }] } })).body, { missing: [sha] });
  const tampered = await call('PUT', `/api/v1/device/logs/${sha}?name=DJIFlightRecord_x.txt`, { token, raw: new TextEncoder().encode('different bytes') });
  assert.equal(tampered.status, 422, 'content must match the promised hash');
  const put = await call('PUT', `/api/v1/device/logs/${sha}?name=DJIFlightRecord_x.txt`, { token, raw: bytes });
  assert.equal(put.status, 201);
  assert.deepEqual((await call('POST', '/api/v1/device/have', { token, body: { files: [{ sha256: sha }] } })).body, { missing: [] });
  const row = await env.LOGS_DB.prepare('SELECT * FROM raw_logs WHERE sha256 = ?').bind(sha).first();
  assert.equal(row.pilot_id, 'staff-beau');
  assert.equal(row.parse_status, 'needs_parse', 'uploading never marks it parsed');
  assert.equal(row.source, 'controller');
  assert.equal(new Uint8Array(await (await env.LOGS_BUCKET.get(`raw/${sha}.txt`)).arrayBuffer()).length, bytes.length);
  const flight = await env.LOGS_DB.prepare('SELECT raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('f1').first();
  assert.deepEqual(flight, { raw_log_status: 'stored', raw_log_key: `raw/${sha}.txt` });

  // Kollin re-sends the same file later: accepted as a duplicate, attribution unchanged.
  const other = await signIn('kstern', kollin);
  const again = await call('PUT', `/api/v1/device/logs/${sha}`, { token: other.collected.body.deviceToken, raw: bytes });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal((await env.LOGS_DB.prepare('SELECT pilot_id FROM raw_logs WHERE sha256 = ?').bind(sha).first()).pilot_id, 'staff-beau');
});

test('pilots see and revoke their own controllers; a revoked or signed-out controller is refused at once', async () => {
  env = await freshEnv();
  const a = await signIn('bkoltz', beau), b = await signIn('kstern', kollin);
  const mine = await device.listDevices(env, beau);
  assert.equal(mine.items.length, 1);
  assert.equal((await device.listDevices(env, manager, { all: true })).items.length, 2);
  await assert.rejects(device.revokeDevice(env, beau, (await device.listDevices(env, kollin)).items[0].id), e => e.code === 'device_not_found');
  await device.revokeDevice(env, beau, mine.items[0].id);
  assert.equal((await call('GET', '/api/v1/device/me', { token: a.collected.body.deviceToken })).status, 401);
  assert.equal((await call('POST', '/api/v1/device/sign-out', { token: b.collected.body.deviceToken })).status, 200);
  assert.equal((await call('POST', '/api/v1/device/have', { token: b.collected.body.deviceToken, body: { files: [] } })).status, 401);
});
