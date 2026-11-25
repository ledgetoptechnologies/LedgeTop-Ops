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

/**
 * Stand-in for Ops' StaffDirectory with explicit, revisioned device eligibility (as on the Ops side): every
 * grant or deny is a new revision; only an active, explicitly eligible pilot resolves or has authority.
 */
function staffDirectory() {
  const staff = new Map([['staff-beau', { username: 'bkoltz', active: true, eligible: true, revision: 1 }],
    ['staff-kollin', { username: 'kstirn', active: true, eligible: true, revision: 1 }]]);
  const allowed = s => s && s.active && s.eligible;
  return {
    staff, calls: 0, broken: false,
    /** An Ops eligibility command: always a new revision, even when re-granting. */
    setEligible(staffId, eligible) { const s = staff.get(staffId); s.eligible = eligible; s.revision += 1; },
    async resolvePilotUsername(username) {
      this.calls++; if (this.broken) throw new Error('binding down');
      const hits = [...staff].filter(([, s]) => s.username === username && allowed(s));
      return hits.length === 1 ? { staffId: hits[0][0], eligibilityRevision: hits[0][1].revision } : null;
    },
    async getPilotDeviceAuthority(staffId) {
      this.calls++; if (this.broken) throw new Error('binding down');
      const s = staff.get(staffId);
      return allowed(s) ? { eligible: true, revision: s.revision } : { eligible: false, revision: null };
    },
    async isActiveStaff(staffId) { this.calls++; if (this.broken) throw new Error('binding down'); return allowed(staff.get(staffId)); },
  };
}

async function freshEnv() {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['raw_logs', 'device_sign_ins', 'device_pairing_failures', 'device_pairings', 'devices', 'audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  for (const file of ['0001_flight_logs.sql', '0002_devices_raw_logs.sql', '0003_device_eligibility_revision.sql', '0004_device_pairings.sql']) {
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

function streamedRequest(method, path, chunks, headers = {}) {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream({
    pull(controller) {
      const chunk = chunks[state.pulls++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return { state, request: new Request(`https://logs.example.test${path}`, { method, headers, body, duplex: 'half' }) };
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
  // ...but once it lapses the controller is refused and its token revoked.
  device.DEVICE_LIMITS.activeCacheMs = 0;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401);
  // Reactivating doesn't revive the old token.
  env.OPS_DIRECTORY.staff.get('staff-kollin').active = true;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401, 'no revival');
  // Directory errors fail closed (503) and revoke nothing.
  const fresh = (await signIn('kstirn', kollin)).collected.body.deviceToken;
  env.OPS_DIRECTORY.broken = true;
  assert.equal((await call('GET', '/api/v1/device/me', { token: fresh })).status, 503, 'fail closed');
  env.OPS_DIRECTORY.broken = false;
  assert.equal((await call('GET', '/api/v1/device/me', { token: fresh })).status, 200, 'an outage revokes nothing');
});

test('controller access is bound to the eligibility revision it was issued under; a re-grant never revives it', async () => {
  env = await freshEnv();
  device.DEVICE_LIMITS.activeCacheMs = 0;
  const dir = env.OPS_DIRECTORY;
  const { collected } = await signIn('bkoltz', beau);
  const token = collected.body.deviceToken;
  assert.equal((await env.LOGS_DB.prepare('SELECT eligibility_revision AS r FROM devices').first()).r, 1, 'token issued under revision 1');
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200);
  // Deny, then grant again: revision 3. The revision-1 token stays dead.
  dir.setEligible('staff-beau', false);
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401);
  dir.setEligible('staff-beau', true);
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401, 're-grant does not revive the old token');
  assert.equal((await env.LOGS_DB.prepare("SELECT revoked_by FROM devices WHERE eligibility_revision = 1").first()).revoked_by, 'eligibility');
  // A deliberate re-authorization (new revision while eligible) also ends the old token at once.
  const second = (await signIn('bkoltz', beau)).collected.body.deviceToken;
  dir.setEligible('staff-beau', true);
  assert.equal((await call('GET', '/api/v1/device/me', { token: second })).status, 401);
  // A new sign-in under the current revision works.
  const third = (await signIn('bkoltz', beau)).collected.body.deviceToken;
  assert.equal((await call('GET', '/api/v1/device/me', { token: third })).status, 200);
});

test('a revision change between issue, approval and collection stops the sign-in; ineligible usernames do not resolve', async () => {
  env = await freshEnv();
  const dir = env.OPS_DIRECTORY;
  // Changed before approval: approval is refused and the request closed.
  const a = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  dir.setEligible('staff-beau', true);
  await assert.rejects(device.decideSignIn(env, beau, { signInId: a.body.signInId, approve: true }), e => e.code === 'not_eligible');
  assert.equal((await call('GET', `/api/v1/device/sign-in/${a.body.signInId}`, { poll: a.body.pollToken })).body.status, 'denied');
  // Changed after approval, before collection: no token, no device.
  const b = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  await device.decideSignIn(env, beau, { signInId: b.body.signInId, approve: true });
  dir.setEligible('staff-beau', true);
  assert.equal((await call('GET', `/api/v1/device/sign-in/${b.body.signInId}`, { poll: b.body.pollToken })).body.status, 'denied');
  assert.equal(await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM devices').first().then(r => r.n), 0);
  // A pilot without explicit eligibility can't start a sign-in, even with a username set.
  dir.setEligible('staff-kollin', false);
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn' } })).status, 404);
  // Denying a request never needs eligibility.
  dir.setEligible('staff-beau', false);
  const c = await env.LOGS_DB.prepare("INSERT INTO device_sign_ins (id, code, username, pilot_id, poll_token_hash, created_at, expires_at, eligibility_revision) VALUES ('s-c', 'AAA-001', 'bkoltz', 'staff-beau', 'x', ?, ?, 2)")
    .bind(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString()).run();
  assert.ok(c.meta.changes);
  assert.deepEqual(await device.decideSignIn(env, beau, { signInId: 's-c', approve: false }), { status: 'denied' });
});

test('with the default cache, a warm cached answer for an older revision never revokes a newer token', async () => {
  env = await freshEnv();
  device.clearActiveCache();
  assert.equal(device.DEVICE_LIMITS.activeCacheMs, 60_000, 'default cache window');
  const dir = env.OPS_DIRECTORY;
  // This isolate warms a positive revision-1 answer by serving a revision-1 token.
  const old = (await signIn('bkoltz', beau)).collected.body.deviceToken;
  assert.equal((await call('GET', '/api/v1/device/me', { token: old })).status, 200);
  // Elsewhere: deny and re-grant (revision 3), and another isolate issues a revision-3 token. That token is
  // inserted directly so this isolate's cache still holds the revision-1 answer.
  dir.setEligible('staff-beau', false); dir.setEligible('staff-beau', true);
  const token = 'r3-token-issued-by-another-isolate-0000000000';
  await env.LOGS_DB.prepare(`INSERT INTO devices (id, pilot_id, model, token_hash, approved_by, created_at, eligibility_revision)
    VALUES ('dev-r3', 'staff-beau', 'DJI RC PLUS 2', ?, 'staff-beau', ?, 3)`).bind(await device.sha256Hex(token), new Date().toISOString()).run();
  // The revision-1 cache entry can't decide a revision-3 token: Ops is asked fresh, and the token survives.
  const before = dir.calls;
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200);
  assert.equal(dir.calls, before + 1, 'fresh recheck happened');
  assert.equal((await env.LOGS_DB.prepare("SELECT status FROM devices WHERE id = 'dev-r3'").first()).status, 'active');
  // Now cached at revision 3: the next use is a cache hit, with no directory call.
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200);
  assert.equal(dir.calls, before + 1, 'cache hit for the same revision');
  // The genuine revision-1 token is refused (fresh) and revoked.
  assert.equal((await call('GET', '/api/v1/device/me', { token: old })).status, 401);
  // A real denial: allowed at most until the cached allow lapses, then refused.
  dir.setEligible('staff-beau', false);
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 200, 'within the bounded window');
  device.clearActiveCache();
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401);
});

test('new sign-in requests never cancel a waiting code; past the limits they are refused, and the pilot can clear them', async () => {
  env = await freshEnv();
  const first = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  // Someone else floods the same username.
  for (let i = 1; i < device.DEVICE_LIMITS.pendingPerUsername; i++) assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 201);
  const refused = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
  assert.deepEqual([refused.status, refused.body.code], [429, 'too_many_pending']);
  // The first controller's code is still valid and still collects a token once approved.
  assert.equal((await call('GET', `/api/v1/device/sign-in/${first.body.signInId}`, { poll: first.body.pollToken })).body.status, 'pending');
  await device.decideSignIn(env, beau, { signInId: first.body.signInId, approve: true });
  assert.equal((await call('GET', `/api/v1/device/sign-in/${first.body.signInId}`, { poll: first.body.pollToken })).body.status, 'approved');
  // Another pilot's requests are unaffected.
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn' } })).status, 201);
  // Clearing only touches the signed-in pilot's own waiting codes, and frees the slots.
  assert.deepEqual(await device.clearPendingSignIns(env, beau), { cleared: device.DEVICE_LIMITS.pendingPerUsername - 1 });
  assert.equal((await device.pendingSignIns(env, kollin)).items.length, 1, 'Kollin’s request untouched');
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 201);
  await assert.rejects(device.clearPendingSignIns(env, null), e => e.code === 'unauthenticated');
});

test('the hourly limit counts only admitted requests and is enforced in the insert', async () => {
  env = await freshEnv();
  const saved = { ...device.DEVICE_LIMITS };
  try {
    device.DEVICE_LIMITS.signInsPerHour = 3;
    for (let i = 0; i < 3; i++) assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 201);
    await device.clearPendingSignIns(env, beau);
    const over = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
    assert.deepEqual([over.status, over.body.code], [429, 'too_many_sign_ins']);
    assert.equal(await env.LOGS_DB.prepare("SELECT COUNT(*) AS n FROM device_sign_ins WHERE username = 'bkoltz'").first().then(r => r.n), 3, 'refused requests are not stored');
  } finally { Object.assign(device.DEVICE_LIMITS, saved); }
});

test('a pairing code made in Ops signs in past a flooded username, once, for the right pilot only', async () => {
  env = await freshEnv();
  const saved = { ...device.DEVICE_LIMITS };
  try {
    device.DEVICE_LIMITS.signInsPerHour = device.DEVICE_LIMITS.pendingPerUsername;
    // Someone exhausts bkoltz's anonymous budget.
    for (let i = 0; i < device.DEVICE_LIMITS.pendingPerUsername; i++) await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } });
    assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 429);
    await device.clearPendingSignIns(env, beau);
    assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 429, 'clearing does not reset the hourly budget');
    // Beau makes a pairing code in Ops; only a hash is stored.
    const pairing = await device.createPairing(env, beau);
    assert.match(pairing.code, /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    const stored = await env.LOGS_DB.prepare('SELECT secret_hash, eligibility_revision FROM device_pairings').first();
    assert.notEqual(stored.secret_hash, pairing.code.replace('-', ''));
    assert.equal(stored.eligibility_revision, 1);
    // Kollin's username with Beau's code is refused and doesn't use it up.
    assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn', pairingCode: pairing.code } })).status, 404);
    // Typed loosely (lower case, no dash, O for 0) it still works, past the exhausted budget, and needs approval.
    const typed = pairing.code.toLowerCase().replace('-', ' ').replace(/0/g, 'o');
    const paired = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: typed } });
    assert.equal(paired.status, 201);
    assert.equal(paired.body.paired, true);
    assert.equal((await device.pendingSignIns(env, beau)).items.length, 1);
    await assert.rejects(device.decideSignIn(env, kollin, { signInId: paired.body.signInId, approve: true }), e => e.code === 'sign_in_not_found');
    await device.decideSignIn(env, beau, { signInId: paired.body.signInId, approve: true });
    const collected = await call('GET', `/api/v1/device/sign-in/${paired.body.signInId}`, { poll: paired.body.pollToken });
    assert.deepEqual([collected.body.status, collected.body.pilot.id], ['approved', 'staff-beau']);
    // Single use.
    assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: pairing.code } })).status, 404);
  } finally { Object.assign(device.DEVICE_LIMITS, saved); }
});

test('pairing codes need current eligibility, expire, can be cancelled, are capped per pilot, and wrong guesses are bounded', async () => {
  env = await freshEnv();
  const dir = env.OPS_DIRECTORY;
  // Not eligible: no code.
  dir.setEligible('staff-kollin', false);
  await assert.rejects(device.createPairing(env, kollin), e => e.code === 'not_eligible');
  await assert.rejects(device.createPairing(env, null), e => e.code === 'unauthenticated');
  // A code made before a revision change no longer works.
  const stale = await device.createPairing(env, beau);
  dir.setEligible('staff-beau', true);
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: stale.code } })).status, 404);
  // Expired.
  const old = await device.createPairing(env, beau);
  await env.LOGS_DB.prepare("UPDATE device_pairings SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?").bind(old.pairingId).run();
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: old.code } })).status, 404);
  // Cancelled, and only by its own pilot.
  const mine = await device.createPairing(env, beau);
  dir.setEligible('staff-kollin', true);
  assert.deepEqual(await device.cancelPairing(env, kollin, mine.pairingId), { closed: false });
  assert.deepEqual(await device.cancelPairing(env, beau, mine.pairingId), { closed: true });
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: mine.code } })).status, 404);
  // At most three open per pilot; Kollin's are untouched by Beau's.
  const kollins = await device.createPairing(env, kollin);
  for (let i = 0; i < 4; i++) await device.createPairing(env, beau);
  const open = await env.LOGS_DB.prepare("SELECT pilot_id, COUNT(*) AS n FROM device_pairings WHERE status = 'open' GROUP BY pilot_id ORDER BY pilot_id").all();
  assert.deepEqual(open.results.map(r => [r.pilot_id, r.n]), [['staff-beau', 3], ['staff-kollin', 1]]);
  // Wrong guesses are recorded (time only) and, past the global limit, pairing pauses for everyone.
  const saved = { ...device.DEVICE_LIMITS };
  try {
    device.DEVICE_LIMITS.pairingFailuresPerHour = 3;
    const before = (await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM device_pairing_failures').first()).n;
    for (const guess of ['AAAAA-AAAAA', 'not a code', 'BBBBB-BBBBB'].slice(0, Math.max(0, 3 - before)))
      assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn', pairingCode: guess } })).status, 404);
    const paused = await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn', pairingCode: kollins.code } });
    assert.deepEqual([paused.status, paused.body.code], [429, 'pairing_unavailable']);
    // The ordinary username path is unaffected.
    assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'kstirn' } })).status, 201);
  } finally { Object.assign(device.DEVICE_LIMITS, saved); }
});

test('two controllers racing one pairing code: exactly one sign-in', async () => {
  env = await freshEnv();
  const pairing = await device.createPairing(env, beau);
  const results = await Promise.all([0, 1, 2].map(() => call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', pairingCode: pairing.code } })));
  assert.equal(results.filter(r => r.status === 201).length, 1);
  assert.equal(await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM device_sign_ins WHERE pairing_id IS NOT NULL').first().then(r => r.n), 1);
});

test('requests and tokens from before revisions existed, or a directory without eligibility, fail closed', async () => {
  env = await freshEnv();
  device.DEVICE_LIMITS.activeCacheMs = 0;
  const token = (await signIn('bkoltz', beau)).collected.body.deviceToken;
  // A device row with no revision (issued before this change) is refused.
  await env.LOGS_DB.prepare('UPDATE devices SET eligibility_revision = NULL').run();
  assert.equal((await call('GET', '/api/v1/device/me', { token })).status, 401);
  // A directory that only offers the old boolean check is treated as unavailable, not as eligible.
  const legacy = { resolvePilotUsername: env.OPS_DIRECTORY.resolvePilotUsername.bind(env.OPS_DIRECTORY), isActiveStaff: async () => true };
  const saved = env; env = { ...env, OPS_DIRECTORY: legacy };
  assert.equal((await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz' } })).status, 503);
  env = saved;
  // Malformed authority answers count as not eligible.
  for (const answer of [{ eligible: true, revision: null }, { eligible: true, revision: 0 }, { eligible: 'yes', revision: 4 }, null]) {
    const fresh = (await signIn('bkoltz', beau)).collected.body.deviceToken;
    const real = env.OPS_DIRECTORY.getPilotDeviceAuthority;
    env.OPS_DIRECTORY.getPilotDeviceAuthority = async () => answer;
    assert.equal((await call('GET', '/api/v1/device/me', { token: fresh })).status, 401, JSON.stringify(answer));
    env.OPS_DIRECTORY.getPilotDeviceAuthority = real;
  }
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

test('JSON is bounded by streamed bytes for absent, understated and chunked lengths; overflow cancels before further reads', async () => {
  env = await freshEnv();
  for (const headers of [{}, { 'Content-Length': '1' }, { 'Transfer-Encoding': 'chunked' }]) {
    const { request, state } = streamedRequest('POST', '/api/v1/device/sign-in',
      [new Uint8Array(2048), new Uint8Array(2049), new Uint8Array(1)], headers);
    const response = await handleDeviceRequest(request, env);
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: 'Request too large.', code: 'too_large' });
    assert.equal(state.pulls, 2);
    assert.equal(state.cancelled, true);
  }
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM device_sign_ins').first()).n, 0);
  const early = streamedRequest('POST', '/api/v1/device/sign-in', [new Uint8Array(1)], { 'Content-Length': '4097' });
  assert.equal((await handleDeviceRequest(early.request, env)).status, 413);
  assert.equal(early.state.pulls, 0);
  assert.equal(early.state.cancelled, true);
  const json = new TextEncoder().encode(JSON.stringify({ username: 'bkoltz' }));
  const good = streamedRequest('POST', '/api/v1/device/sign-in', [json.subarray(0, 3), json.subarray(3)]);
  assert.equal((await handleDeviceRequest(good.request, env)).status, 201);
  assert.equal(good.state.cancelled, false);
  const invalid = streamedRequest('POST', '/api/v1/device/sign-in', [new TextEncoder().encode('{')]);
  const response = await handleDeviceRequest(invalid.request, env);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_json');
});

test('raw uploads cap actual streamed bytes, preserve authentication and accept a legitimate exact-limit body', async () => {
  env = await freshEnv();
  const { collected } = await signIn('bkoltz', beau);
  const headers = { Authorization: `Bearer ${collected.body.deviceToken}` };
  assert.equal(device.DEVICE_LIMITS.rawLogBytes, 100 * 1024 * 1024, 'production limit is unchanged');
  const original = device.DEVICE_LIMITS.rawLogBytes;
  // Exercise the same limit comparison with tiny synthetic chunks, without a 100 MiB fixture.
  device.DEVICE_LIMITS.rawLogBytes = 16;
  try {
    for (const extra of [{}, { 'Content-Length': '1' }, { 'Transfer-Encoding': 'chunked' }]) {
      const { request, state } = streamedRequest('PUT', `/api/v1/device/logs/${'0'.repeat(64)}`,
        [new Uint8Array(8), new Uint8Array(9), new Uint8Array(1)], { ...headers, ...extra });
      const response = await handleDeviceRequest(request, env);
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: 'This flight log is too large.', code: 'raw_log_too_large' });
      assert.equal(state.pulls, 2);
      assert.equal(state.cancelled, true);
    }
    assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM raw_logs').first()).n, 0);
    const unauthenticated = streamedRequest('PUT', `/api/v1/device/logs/${'0'.repeat(64)}`, [new Uint8Array(17)]);
    assert.equal((await handleDeviceRequest(unauthenticated.request, env)).status, 401);
    assert.equal(unauthenticated.state.pulls, 0, 'authentication precedes upload consumption');
    await unauthenticated.request.body.cancel();
    const early = streamedRequest('PUT', `/api/v1/device/logs/${'0'.repeat(64)}`, [new Uint8Array(1)], { ...headers, 'Content-Length': '17' });
    assert.equal((await handleDeviceRequest(early.request, env)).status, 413);
    assert.equal(early.state.pulls, 0);
    assert.equal(early.state.cancelled, true);
    const bytes = new TextEncoder().encode('0123456789abcdef'), sha = await device.sha256Hex(bytes);
    const good = streamedRequest('PUT', `/api/v1/device/logs/${sha}?name=test.txt`, [bytes.subarray(0, 7), bytes.subarray(7)], headers);
    assert.equal((await handleDeviceRequest(good.request, env)).status, 201);
    assert.equal(good.state.cancelled, false);
    assert.deepEqual(new Uint8Array(await (await env.LOGS_BUCKET.get(`raw/${sha}.txt`)).arrayBuffer()), bytes);
  } finally { device.DEVICE_LIMITS.rawLogBytes = original; }
});

test('a raw upload never links another pilot’s flight: it stays untouched, the raw log is kept, and the conflict is recorded once', async () => {
  env = await freshEnv();
  const { collected } = await signIn('bkoltz', beau);
  const token = collected.body.deviceToken;
  const bytes = new TextEncoder().encode('DJI raw log for a flight imported for someone else '.repeat(200));
  const sha = await device.sha256Hex(bytes);
  // Kollin's imported flight happens to have the same file fingerprint.
  await env.LOGS_DB.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, created_at, updated_at)
    VALUES ('kollin-flight', ?, 'opendronelog', 'staff-kollin', 'backup_owner', 'now', 'now')`).bind(sha).run();

  const first = await call('PUT', `/api/v1/device/logs/${sha}?name=DJIFlightRecord_y.txt`, { token, raw: bytes });
  assert.deepEqual([first.status, first.body], [201, { stored: true, duplicate: false }], 'the controller learns nothing about other pilots');
  assert.equal((await env.LOGS_DB.prepare('SELECT pilot_id FROM raw_logs WHERE sha256 = ?').bind(sha).first()).pilot_id, 'staff-beau', 'the raw log keeps its uploader');
  const untouched = await env.LOGS_DB.prepare("SELECT pilot_id, raw_log_status, raw_log_key FROM flights WHERE id = 'kollin-flight'").first();
  assert.deepEqual(untouched, { pilot_id: 'staff-kollin', raw_log_status: 'missing', raw_log_key: null }, 'the other pilot’s flight is not linked');

  const again = await call('PUT', `/api/v1/device/logs/${sha}`, { token, raw: bytes });
  assert.deepEqual([again.status, again.body.duplicate], [200, true]);
  assert.equal((await env.LOGS_DB.prepare("SELECT raw_log_status FROM flights WHERE id = 'kollin-flight'").first()).raw_log_status, 'missing', 'a retry does not link it either');
  const conflicts = (await env.LOGS_DB.prepare("SELECT actor_id, subject, detail FROM audit_events WHERE action = 'raw_log.attribution_conflict'").all()).results;
  assert.deepEqual(conflicts, [{ actor_id: 'system', subject: `raw_log:${sha}`, detail: null }], 'recorded once for review, with no pilot names in it');
});
