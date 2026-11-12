// Controller (device) API for Ledge Top Logs.
//
// Sign-in, TV style: the pilot types their Ledge Top username on the controller, which shows a short code.
// The username is resolved once, at issuance, through Ops' StaffDirectory (OPS_DIRECTORY binding) to a stable
// active staff id; only that staff member, signed in to Ops, can approve. The controller then collects a
// device token once (after a fresh active check); only its SHA-256 is stored. Directory errors fail closed. After that the controller asks which raw logs are missing (by content hash) and
// uploads them write-once. Uploads are attributed to the pilot and device at that moment, for good.
import { LogsError } from './errors.mjs';

export const DEVICE_LIMITS = { codeTtlSeconds: 600, rawLogBytes: 100 * 1024 * 1024, haveBatch: 2000, pendingPerUsername: 5, signInsPerHour: 30,
  // A pilot deactivated in Ops loses their controllers within this window (cached per Worker isolate).
  activeCacheMs: 60_000 };

const activeCache = new Map();
/** Forgets cached active checks (tests, and after a revocation in this isolate). */
export function clearActiveCache() { activeCache.clear(); }

function directory(env) {
  const service = env.OPS_DIRECTORY;
  if (!service || typeof service.resolvePilotUsername !== 'function') throw new LogsError('directory_unavailable', 503, 'Sign-in is not available right now. Try again in a minute.');
  return service;
}
/** Whether the Ops staff member is active. Errors fail closed; answers are cached for activeCacheMs. */
async function pilotActive(env, staffId, { fresh = false } = {}) {
  const hit = activeCache.get(staffId);
  if (!fresh && hit && Date.now() - hit.at < DEVICE_LIMITS.activeCacheMs) return hit.active;
  let active = false;
  try { active = (await directory(env).isActiveStaff(staffId)) === true; }
  catch (error) { if (error instanceof LogsError) throw error; throw new LogsError('directory_unavailable', 503, 'Ledge Top could not confirm your account. Try again in a minute.'); }
  activeCache.set(staffId, { active, at: Date.now() });
  return active;
}
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

const now = () => new Date().toISOString();
const text = (value, max) => (value == null ? null : String(value).slice(0, max));
const randomToken = () => { const b = new Uint8Array(32); crypto.getRandomValues(b); return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
function signInCode() {
  const b = new Uint8Array(6); crypto.getRandomValues(b);
  return `${[...b.slice(0, 3)].map(x => CODE_LETTERS[x % CODE_LETTERS.length]).join('')}-${String((b[3] << 16 | b[4] << 8 | b[5]) % 1000).padStart(3, '0')}`;
}
export const normalizeUsername = value => String(value ?? '').trim().toLowerCase();

// ---- Controller side (public device API, no Ops session) -------------------------------------------

/** The controller asks to sign in as `username`, which must resolve to exactly one active staff member. */
export async function startSignIn(env, { username, model, name, hardwareId }) {
  const user = normalizeUsername(username);
  if (!USERNAME.test(user)) throw new LogsError('invalid_username', 400, 'Type your Ledge Top username.');
  const db = env.LOGS_DB;
  let resolved;
  try { resolved = await directory(env).resolvePilotUsername(user); }
  catch (error) { if (error instanceof LogsError) throw error; throw new LogsError('directory_unavailable', 503, 'Sign-in is not available right now. Try again in a minute.'); }
  if (!resolved || typeof resolved.staffId !== 'string' || !resolved.staffId) throw new LogsError('unknown_username', 404, 'No active Ledge Top pilot has that username. Check the spelling, or ask an admin to set your username.');
  const since = new Date(Date.now() - 3600_000).toISOString();
  const recent = await db.prepare('SELECT COUNT(*) AS n FROM device_sign_ins WHERE username = ? AND created_at > ?').bind(user, since).first();
  if ((recent?.n ?? 0) >= DEVICE_LIMITS.signInsPerHour) throw new LogsError('too_many_sign_ins', 429, 'Too many sign-in attempts for this username. Try again later.');
  // Only the newest few pending requests per username stay valid, so old codes can't pile up.
  await db.prepare(`UPDATE device_sign_ins SET status = 'expired' WHERE username = ? AND status = 'pending' AND id NOT IN
    (SELECT id FROM device_sign_ins WHERE username = ? AND status = 'pending' ORDER BY created_at DESC LIMIT ?)`).bind(user, user, DEVICE_LIMITS.pendingPerUsername - 1).run();
  const id = crypto.randomUUID(), pollToken = randomToken(), code = signInCode(), created = now();
  await db.prepare(`INSERT INTO device_sign_ins (id, code, username, pilot_id, poll_token_hash, model, name, hardware_id, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, code, user, resolved.staffId, await sha256Hex(pollToken), text(model, 80), text(name, 80), text(hardwareId, 80),
    created, new Date(Date.now() + DEVICE_LIMITS.codeTtlSeconds * 1000).toISOString()).run();
  return { signInId: id, code, pollToken, username: user, expiresInSeconds: DEVICE_LIMITS.codeTtlSeconds };
}

/** The controller polls; after approval it collects its device token exactly once. */
export async function pollSignIn(env, signInId, pollToken) {
  const db = env.LOGS_DB;
  const row = await db.prepare('SELECT * FROM device_sign_ins WHERE id = ?').bind(String(signInId)).first();
  if (!row || typeof pollToken !== 'string' || row.poll_token_hash !== await sha256Hex(pollToken)) throw new LogsError('sign_in_not_found', 404, 'That sign-in request was not found. Start again on the controller.');
  if (row.status === 'pending' && Date.parse(row.expires_at) <= Date.now()) {
    await db.prepare("UPDATE device_sign_ins SET status = 'expired' WHERE id = ? AND status = 'pending'").bind(row.id).run();
    return { status: 'expired' };
  }
  if (row.status !== 'approved') return { status: row.status === 'collected' ? 'expired' : row.status };
  // Approved earlier, but the pilot must still be active right now, and the code must still be in date.
  if (Date.parse(row.expires_at) <= Date.now()) {
    await db.prepare("UPDATE device_sign_ins SET status = 'expired' WHERE id = ? AND status = 'approved'").bind(row.id).run();
    return { status: 'expired' };
  }
  if (!(await pilotActive(env, row.pilot_id, { fresh: true }))) {
    await db.prepare("UPDATE device_sign_ins SET status = 'denied' WHERE id = ? AND status = 'approved'").bind(row.id).run();
    return { status: 'denied' };
  }
  const token = randomToken(), deviceId = crypto.randomUUID(), at = now();
  const results = await db.batch([
    db.prepare(`INSERT INTO devices (id, pilot_id, model, name, hardware_id, token_hash, approved_by, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(deviceId, row.pilot_id, row.model, row.name, row.hardware_id, await sha256Hex(token), row.decided_by, at, at),
    db.prepare("UPDATE device_sign_ins SET status = 'collected', device_id = ? WHERE id = ? AND status = 'approved'").bind(deviceId, row.id),
  ]);
  if (!results[1].meta?.changes) throw new LogsError('sign_in_collected', 409, 'This sign-in was already used. Start again on the controller.');
  return { status: 'approved', deviceToken: token, pilot: { id: row.pilot_id, username: row.username } };
}

/** Resolves a device token to an active device, or refuses. */
export async function deviceFor(env, request) {
  const bearer = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get('Authorization') ?? '')?.[1];
  if (!bearer) throw new LogsError('device_unauthenticated', 401, 'Sign in again on the controller.');
  const device = await env.LOGS_DB.prepare("SELECT * FROM devices WHERE token_hash = ? AND status = 'active'").bind(await sha256Hex(bearer)).first();
  if (!device) throw new LogsError('device_unauthenticated', 401, 'Sign in again on the controller.');
  // A pilot deactivated in Ops can't keep uploading (within DEVICE_LIMITS.activeCacheMs).
  if (!(await pilotActive(env, device.pilot_id))) throw new LogsError('device_unauthenticated', 401, 'Your Ledge Top account is not active. Ask an admin.');
  await env.LOGS_DB.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').bind(now(), device.id).run();
  return device;
}

/** Which of these raw logs the service doesn't have yet. */
export async function missingRawLogs(env, files) {
  if (!Array.isArray(files) || files.length > DEVICE_LIMITS.haveBatch) throw new LogsError('invalid_batch', 400, `Send at most ${DEVICE_LIMITS.haveBatch} files at a time.`);
  const hashes = [...new Set(files.map(f => f?.sha256).filter(h => typeof h === 'string' && SHA256.test(h)))];
  const have = new Set();
  for (let i = 0; i < hashes.length; i += 100) {
    const part = hashes.slice(i, i + 100);
    const rows = (await env.LOGS_DB.prepare(`SELECT sha256 FROM raw_logs WHERE sha256 IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const row of rows) have.add(row.sha256);
  }
  return { missing: hashes.filter(h => !have.has(h)) };
}

/**
 * Stores one raw log write-once at raw/<sha256>.txt after checking its content against the promised hash.
 * Re-sending a log that's already stored succeeds without changing anything (including its attribution).
 */
export async function putRawLog(env, device, sha256, fileName, bytes) {
  if (!SHA256.test(String(sha256))) throw new LogsError('invalid_hash', 400, 'The file fingerprint is not valid.');
  const existing = await env.LOGS_DB.prepare('SELECT sha256 FROM raw_logs WHERE sha256 = ?').bind(sha256).first();
  if (existing) return { stored: true, duplicate: true };
  if (!bytes?.byteLength || bytes.byteLength > DEVICE_LIMITS.rawLogBytes) throw new LogsError('raw_log_too_large', 413, 'This flight log is empty or too large.');
  if (await sha256Hex(bytes) !== sha256) throw new LogsError('hash_mismatch', 422, 'The file changed or was damaged on the way. It will be sent again.');
  const key = `raw/${sha256}.txt`;
  // The key is the content hash, so an existing object already holds exactly these bytes: never rewrite it.
  if (!(await env.LOGS_BUCKET.head(key))) {
    await env.LOGS_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { sha256, source: 'controller', deviceId: device.id } });
  }
  await env.LOGS_DB.prepare(`INSERT OR IGNORE INTO raw_logs (sha256, size_bytes, file_name, r2_key, source, device_id, pilot_id, uploaded_at)
    VALUES (?, ?, ?, ?, 'controller', ?, ?, ?)`).bind(sha256, bytes.byteLength, text(fileName, 200), key, device.id, device.pilot_id, now()).run();
  // An ODL-imported flight for the same file now has its original log; the decoder still parses it separately.
  await env.LOGS_DB.prepare("UPDATE flights SET raw_log_status = 'stored', raw_log_key = ?, updated_at = ? WHERE file_hash = ? AND raw_log_status = 'missing'")
    .bind(key, now(), sha256).run();
  return { stored: true, duplicate: false };
}

export async function signOutDevice(env, device) {
  await env.LOGS_DB.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_by = pilot_id WHERE id = ? AND status = 'active'").bind(now(), device.id).run();
  return { signedOut: true };
}

// ---- Ops side (through the FlightLogsService binding; Ops has authenticated the staff member) -------

function requireStaff(actor) {
  if (!actor || typeof actor.staffId !== 'string' || !actor.staffId) throw new LogsError('unauthenticated', 401, 'Sign in again to manage controllers.');
}

/** Sign-in requests addressed to this staff member (by stable staff id, resolved when each was issued). */
export async function pendingSignIns(env, actor) {
  requireStaff(actor);
  const rows = (await env.LOGS_DB.prepare(`SELECT id, code, model, name, created_at, expires_at FROM device_sign_ins
    WHERE pilot_id = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 10`).bind(actor.staffId, now()).all()).results;
  return { items: rows.map(r => ({ id: r.id, code: r.code, model: r.model, name: r.name, createdAt: r.created_at, expiresAt: r.expires_at })) };
}

/**
 * Approves or denies a request. Ops passes the authenticated staff id (rechecked active); only the staff
 * member the request was addressed to can decide it, and the device signs in as that same person.
 */
export async function decideSignIn(env, actor, { signInId, approve }) {
  requireStaff(actor);
  const at = now();
  const row = await env.LOGS_DB.prepare('SELECT pilot_id, status, expires_at FROM device_sign_ins WHERE id = ?').bind(String(signInId)).first();
  if (!row || row.pilot_id !== actor.staffId) throw new LogsError('sign_in_not_found', 404, 'That sign-in request was not found.');
  if (row.status !== 'pending' || Date.parse(row.expires_at) <= Date.now()) throw new LogsError('sign_in_closed', 409, 'That code has expired or was already used. Start again on the controller.');
  const result = await env.LOGS_DB.prepare(`UPDATE device_sign_ins SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending' AND pilot_id = ?`)
    .bind(approve ? 'approved' : 'denied', at, actor.staffId, String(signInId), actor.staffId).run();
  if (!result.meta?.changes) throw new LogsError('sign_in_closed', 409, 'That code has expired or was already used.');
  return { status: approve ? 'approved' : 'denied' };
}

/** Controllers signed in as this staff member, or every controller for someone who manages Logs. */
export async function listDevices(env, actor, { all = false } = {}) {
  requireStaff(actor);
  const manage = all && actor.permissions?.includes('flight_logs.import');
  const rows = (manage
    ? await env.LOGS_DB.prepare("SELECT * FROM devices ORDER BY status, last_seen_at DESC LIMIT 200").all()
    : await env.LOGS_DB.prepare("SELECT * FROM devices WHERE pilot_id = ? ORDER BY status, last_seen_at DESC LIMIT 50").bind(actor.staffId).all()).results;
  const counts = new Map((await env.LOGS_DB.prepare('SELECT device_id, COUNT(*) AS n FROM raw_logs GROUP BY device_id').all()).results.map(r => [r.device_id, r.n]));
  return { items: rows.map(r => ({ id: r.id, pilotId: r.pilot_id, model: r.model, name: r.name, status: r.status, signedInAt: r.created_at,
    lastSeenAt: r.last_seen_at, revokedAt: r.revoked_at, rawLogs: counts.get(r.id) ?? 0 })) };
}

/** Signs a controller out remotely. Pilots can revoke their own; Logs managers can revoke any. */
export async function revokeDevice(env, actor, deviceId) {
  requireStaff(actor);
  const device = await env.LOGS_DB.prepare('SELECT id, pilot_id, status FROM devices WHERE id = ?').bind(String(deviceId)).first();
  if (!device || (device.pilot_id !== actor.staffId && !actor.permissions?.includes('flight_logs.import'))) throw new LogsError('device_not_found', 404, 'That controller was not found.');
  if (device.status === 'revoked') return { revoked: true };
  await env.LOGS_DB.prepare("UPDATE devices SET status = 'revoked', revoked_at = ?, revoked_by = ? WHERE id = ? AND status = 'active'").bind(now(), actor.staffId, device.id).run();
  return { revoked: true };
}
