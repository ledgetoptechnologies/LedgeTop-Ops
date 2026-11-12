import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Miniflare } from 'miniflare';
import { handleDeviceRequest } from '../src/worker/device-routes.mjs';
import * as device from '../src/worker/device.mjs';

let runtime, env;
const beau = { staffId: 'staff-beau', permissions: ['flight_logs.view'] };
const kollin = { staffId: 'staff-kollin', permissions: ['flight_logs.view'] };
const manager = { staffId: 'staff-admin', permissions: ['flight_logs.view', 'flight_logs.import'] };

/** Stand-in for Ops' StaffDirectory: explicit usernames to stable staff ids, with active flags. */
function staffDirectory() {
  const staff = new Map([['staff-beau', { username: 'bkoltz', active: true }], ['staff-kollin', { username: 'kstirn', active: true }]]);
  return {
    staff, calls: 0, broken: false,
    async resolvePilotUsername(username) {
      this.calls++; if (this.broken) throw new Error('binding down');
      const hits = [...staff].filter(([, s]) => s.username === username && s.active);
      return hits.length === 1 ? { staffId: hits[0][0] } : null;
    },
    async isActiveStaff(staffId) { this.calls++; if (this.broken) throw new Error('binding down'); return staff.get(staffId)?.active === true; },
  };
}

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['raw_logs', 'device_sign_ins', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql']) {
    const sql = fs.readFileSync(new URL(`../migrations/${file}`, import.meta.url), 'utf8').replace(/--.*$/gm, '');
    for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  }
  return { LOGS_DB: db, LOGS_BUCKET: bucket, OPS_DIRECTORY: staffDirectory() };
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
  const pending = await device.pendingSignIns(env, approver);
  await device.decideSignIn(env, approver, { signInId: pending.items[0].id, approve: true });
  const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  return { started, collected };
}

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'device-test' }, r2Buckets: { LOGS_BUCKET: 'device-test' } });
});
after(async () => { await runtime?.dispose(); });
beforeEach(() => { device.clearActiveCache(); device.DEVICE_LIMITS.activeCacheMs = 60_000; });

test('a typed username resolves once to a stable staff id; only that person can approve, and the token is collected once', async () => {
  env = await freshEnv();
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username: '  BKoltz ', model: 'DJI RC PLUS 2' } });
  assert.equal(started.status, 201);
  assert.equal(started.body.username, 'bkoltz');
  assert.match(started.body.code, /^[A-Z]{3}-\d{3}$/);
  assert.equal((await env.LOGS_DB.prepare('SELECT pilot_id FROM device_sign_ins').first()).pilot_id, 'staff-beau', 'bound to the staff id at issuance');
  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })).body.status, 'pending');

  // Someone else signed in to Ops neither sees nor can approve it.
  assert.deepEqual((await device.pendingSignIns(env, kollin)).items, []);
  await assert.rejects(device.decideSignIn(env, kollin, { signInId: started.body.signInId, approve: true }), e => e.code === 'sign_in_not_found');
  const mine = await device.pendingSignIns(env, beau);
  assert.deepEqual(mine.items.map(i => i.code), [started.body.code]);
  // Renaming the username in Ops afterwards doesn't move the request: it stays with the original staff id.
  env.OPS_DIRECTORY.staff.get('staff-beau').username = 'beau';
  await device.decideSignIn(env, beau, { signInId: started.body.signInId, approve: true });

  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: 'wrong' })).status, 404);
  const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  assert.deepEqual([collected.body.status, collected.body.pilot.id], ['approved', 'staff-beau']);
  assert.ok(collected.body.deviceToken.length >= 40);
  assert.equal((await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })).body.status, 'expired', 'not twice');
  assert.notEqual((await env.LOGS_DB.prepare('SELECT token_hash FROM devices').first()).token_hash, collected.body.deviceToken, 'only a hash is kept');
  assert.equal((await call('GET', '/api/v1/device/me', { token: collected.body.deviceToken })).body.pilot.id, 'staff-beau');
});

test('unknown, inactive or unresolvable usernames are refused, and directory errors fail closed', async () => {
  env = await freshEnv();
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'not a user!' } })).status, 400);
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'nobody' } })).status, 404);
  env.OPS_DIRECTORY.staff.get('staff-kollin').active = false;
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn' } })).status, 404, 'inactive staff');
  env.OPS_DIRECTORY.broken = true;
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 503, 'directory error');
  const noBinding = env; env = { ...env, OPS_DIRECTORY: undefined };
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 503, 'no binding');
  env = noBinding;
  assert.equal(await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM device_sign_ins').first().then(r => r.n), 0, 'nothing was issued');
});

test('denied, expired, or deactivated-before-collection sign-ins never yield a token', async () => {
  env = await freshEnv();
  const denied = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  await device.decideSignIn(env, beau, { signInId: denied.body.signInId, approve: false });
  assert.equal((await call('GET', `/api/v1/device/sign-in/${denied.body.signInId}`, { poll: denied.body.pollToken })).body.status, 'denied');
  await assert.rejects(device.decideSignIn(env, beau, { signInId: denied.body.signInId, approve: true }), e => e.code === 'sign_in_closed');

  const late = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  await env.LOGS_DB.prepare("UPDATE device_sign_ins SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(late.body.signInId).run();
  assert.equal((await call('GET', `/api/v1/device/sign-in/${late.body.signInId}`, { poll: late.body.pollToken })).body.status, 'expired');
  await assert.rejects(device.decideSignIn(env, beau, { signInId: late.body.signInId, approve: true }), e => e.code === 'sign_in_closed');

  // Approved, but the pilot is deactivated in Ops before the controller collects: refused at collection.
  const approved = await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn' } });
  await device.decideSignIn(env, kollin, { signInId: approved.body.signInId, approve: true });
  env.OPS_DIRECTORY.staff.get('staff-kollin').active = false;
  assert.equal((await call('GET', `/api/v1/device/sign-in/${approved.body.signInId}`, { poll: approved.body.pollToken })).body.status, 'denied');
  assert.equal(await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM devices').first().then(r => r.n), 0);
  assert.equal((await call('GET', '/api/v1/device/me')).status, 401);
});

test('a pilot deactivated in Ops loses their controller within the bounded cache window', async () => {
  env = await freshEnv();
  const { collected } = await signIn('kstirn', kollin);
  const token = collected.body.deviceToken;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200);
  env.OPS_DIRECTORY.staff.get('staff-kollin').active = false;
  // Inside the window the cached answer may still be used...
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200, 'within activeCacheMs');
  // ...but once it lapses the controller is refused, and directory errors also refuse.
  device.DEVICE_LIMITS.activeCacheMs = 0;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401);
  env.OPS_DIRECTORY.staff.get('staff-kollin').active = true;
  env.OPS_DIRECTORY.broken = true;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 503, 'fail closed');
});

test('raw logs upload write-once by content hash, keep their first attribution and link an imported flight', async () => {
  env = await freshEnv();
  const { collected } = await signIn('bkoltz', beau);
  const token = collected.body.deviceToken;
  const bytes = new TextEncoder().encode('DJI raw log bytes '.repeat(500));
  const sha = await device.sha256Hex(bytes);
  await env.LOGS_DB.prepare(`INSERT INTO imports (id, source_system, pilot_id, actor_id, expected_flights, started_at) VALUES ('i1', 'opendronelog', 'staff-beau', 'staff-beau', 1, 'now')`).run();
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, import_id, pilot_id, pilot_attribution, created_at, updated_at) VALUES ('f1', ?, 'opendronelog', 'i1', 'staff-beau', 'backup_owner', 'now', 'now')`).bind(sha).run();

  assert.deepEqual((await call('POST', '/api/v1/device/have', { token, body: { files: [{ sha256: sha, size: bytes.length }, { sha256: 'nope' }] } })).body, { missing: [sha] });
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha}?name=DJIFlightRecord_x.txt`, { token, raw: new TextEncoder().encode('different bytes') })).status, 422);
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha}?name=DJIFlightRecord_x.txt`, { token, raw: bytes })).status, 201);
  assert.deepEqual((await call('POST', '/api/v1/device/have', { token, body: { files: [{ sha256: sha }] } })).body, { missing: [] });
  const row = await env.LOGS_DB.prepare('SELECT * FROM raw_logs WHERE sha256 = ?').bind(sha).first();
  assert.deepEqual([row.pilot_id, row.parse_status, row.source], ['staff-beau', 'needs_parse', 'controller']);
  assert.equal(new Uint8Array(await (await env.LOGS_BUCKET.get(`raw/${sha}.txt`)).arrayBuffer()).length, bytes.length);
  assert.deepEqual(await env.LOGS_DB.prepare('SELECT raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('f1').first(), { raw_log_status: 'stored', raw_log_key: `raw/${sha}.txt` });

  const other = await signIn('kstirn', kollin);
  const again = await call('PUT', `/api/v1/device/logs/${sha}`, { token: other.collected.body.deviceToken, raw: bytes });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal((await env.LOGS_DB.prepare('SELECT pilot_id FROM raw_logs WHERE sha256 = ?').bind(sha).first()).pilot_id, 'staff-beau');
});

test('pilots see and revoke their own controllers; a revoked or signed-out controller is refused at once', async () => {
  env = await freshEnv();
  const a = await signIn('bkoltz', beau), b = await signIn('kstirn', kollin);
  const mine = await device.listDevices(env, beau);
  assert.equal(mine.items.length, 1);
  assert.equal((await device.listDevices(env, manager, { all: true })).items.length, 2);
  await assert.rejects(device.revokeDevice(env, beau, (await device.listDevices(env, kollin)).items[0].id), e => e.code === 'device_not_found');
  await device.revokeDevice(env, beau, mine.items[0].id);
  assert.equal((await call('GET', '/api/v1/device/me', { token: a.collected.body.deviceToken })).status, 401);
  assert.equal((await call('POST', '/api/v1/device/sign-out', { token: b.collected.body.deviceToken })).status, 200);
  assert.equal((await call('POST', '/api/v1/device/have', { token: b.collected.body.deviceToken, body: { files: [] } })).status, 401);
});

test('concurrent polls of one approved sign-in issue exactly one token and one device', async () => {
  env = await freshEnv();
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', model: 'DJI RC PLUS 2' } });
  const pending = await device.pendingSignIns(env, beau);
  await device.decideSignIn(env, beau, { signInId: pending.items[0].id, approve: true });
  const polls = await Promise.all(Array.from({ length: 4 }, () => call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken })));
  const winners = polls.filter(p => p.status === 200 && p.body.status === 'approved');
  assert.equal(winners.length, 1, 'only one poll collects the token');
  for (const p of polls.filter(p => p !== winners[0])) assert.ok(p.status === 409 || p.body.status === 'expired', `loser: ${p.status} ${JSON.stringify(p.body)}`);
  const devices = await env.LOGS_DB.prepare("SELECT COUNT(*) AS n FROM devices WHERE pilot_id = 'staff-beau'").first();
  assert.equal(devices.n, 1, 'no orphan device from a losing poll');
  const row = await env.LOGS_DB.prepare('SELECT status, device_id FROM device_sign_ins WHERE id = ?').bind(started.body.signInId).first();
  assert.equal(row.status, 'collected');
  assert.equal((await env.LOGS_DB.prepare('SELECT id FROM devices WHERE id = ?').bind(row.device_id).first())?.id, row.device_id);
  assert.equal((await call('GET', '/api/v1/device/me', { token: winners[0].body.deviceToken })).status, 200);
});

test('a failed ledger write stores nothing, a retry stores ledger and flight link together, and a duplicate repairs a missed link', async () => {
  env = await freshEnv();
  const { collected } = await signIn('bkoltz', beau);
  const token = collected.body.deviceToken;
  const bytes = new TextEncoder().encode('DJI raw log for link repair '.repeat(300));
  const sha = await device.sha256Hex(bytes);
  await env.LOGS_DB.prepare(`INSERT INTO imports (id, source_system, pilot_id, actor_id, expected_flights, started_at) VALUES ('i1', 'opendronelog', 'staff-beau', 'staff-beau', 1, 'now')`).run();
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, import_id, pilot_id, pilot_attribution, created_at, updated_at) VALUES ('f1', ?, 'opendronelog', 'i1', 'staff-beau', 'backup_owner', 'now', 'now')`).bind(sha).run();

  // Injected failure of the ledger+link transaction: neither half is written.
  const real = env.LOGS_DB;
  let failNext = true;
  env.LOGS_DB = new Proxy(real, { get(target, prop) {
    if (prop === 'batch') return async statements => { if (failNext) { failNext = false; throw new Error('injected D1 failure'); } return target.batch(statements); };
    const value = target[prop]; return typeof value === 'function' ? value.bind(target) : value;
  } });
  await assert.rejects(device.putRawLog(env, { id: 'dev', pilot_id: 'staff-beau' }, sha, 'x.txt', bytes), /injected/);
  env.LOGS_DB = real;
  assert.equal((await real.prepare('SELECT COUNT(*) AS n FROM raw_logs WHERE sha256 = ?').bind(sha).first()).n, 0);
  assert.equal((await real.prepare('SELECT raw_log_status FROM flights WHERE id = ?').bind('f1').first()).raw_log_status, 'missing');

  // The controller retries: ledger row and link land together. R2 holds content only (no uploader attribution).
  assert.equal((await call('PUT', `/api/v1/device/logs/${sha}?name=x.txt`, { token, raw: bytes })).status, 201);
  assert.equal((await real.prepare('SELECT raw_log_status FROM flights WHERE id = ?').bind('f1').first()).raw_log_status, 'stored');
  const object = await env.LOGS_BUCKET.head(`raw/${sha}.txt`);
  assert.deepEqual(object.customMetadata, { sha256: sha, source: 'controller' });

  // A link missed by some earlier path (flight reset to missing) is repaired by the next duplicate upload.
  await real.prepare("UPDATE flights SET raw_log_status = 'missing', raw_log_key = NULL WHERE id = 'f1'").run();
  const again = await call('PUT', `/api/v1/device/logs/${sha}`, { token, raw: bytes });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.deepEqual(await real.prepare('SELECT raw_log_status, raw_log_key FROM flights WHERE id = ?').bind('f1').first(), { raw_log_status: 'stored', raw_log_key: `raw/${sha}.txt` });
});
