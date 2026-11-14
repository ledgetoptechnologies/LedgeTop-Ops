// Flight attribution review: administrators only, every change audited, nothing changes without an audit row.
//
// A decoded controller log is not a flight until an administrator says whose it is (the uploader is custody, never
// proof of who flew). This module gives administrators:
//   - logsStatus:      counts that separate logs ACCEPTED AND RETAINED but waiting (for the DJI key, or in the queue)
//                      from logs that failed (by safe error category) and from flights that have no original;
//   - reviewQueue:     the logs waiting for a decision (unassigned, conflict) or stuck (waiting, failed), with safe
//                      summary fields only: no coordinates, raw content, serials or keys;
//   - assignDecodedLog:   initial assignment of an unassigned decoded log, which creates its flight;
//   - reassignFlight:     moves any flight to another pilot;
//   - resolveConflict:    a decoded log whose content hash matches another pilot's flight: link it to that flight as
//                         is, or move that flight to the chosen pilot and link it.
// Every write is one batch (one transaction) whose FIRST statement is the audit row, inserted only if the expected
// state still holds (otherwise its actor is NULL, which the NOT NULL constraint rejects, and the whole batch rolls
// back). So an audit row exists if and only if the change was made, and a concurrent change is refused (409), never
// overwritten. Attribution is stored as 'admin_reassigned'; the audit detail says initial, reassign or conflict.
//
// The caller (the local Logs server) checks the administrator role fresh with Ops for every call, reads included;
// these functions check it again (actor.administrator) and check that the target pilot is active in Ops right now.
import { LogsError } from './errors.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const STAFF_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FLIGHT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const QUEUES = ['unassigned', 'conflict', 'waiting', 'failed'];
const ACTION = 'flight.attribution';

const iso = ms => new Date(ms).toISOString();
const uuid = () => crypto.randomUUID();

function requireAdministrator(actor) {
  if (!actor || typeof actor.staffId !== 'string' || actor.administrator !== true)
    throw new LogsError('forbidden', 403, 'Only an administrator can review flight attribution.');
}

function reasonOf(input) {
  const reason = typeof input?.reason === 'string' ? input.reason.trim() : '';
  if (reason.length > 500) throw new LogsError('reason_too_long', 400, 'Keep the reason under 500 characters.');
  return reason || null;
}

/** The target pilot must be an active staff member in Ops right now (fail closed). */
async function requireActivePilot(env, pilotId) {
  if (typeof pilotId !== 'string' || !STAFF_ID.test(pilotId)) throw new LogsError('pilot_invalid', 400, 'Choose a pilot.');
  const directory = env.OPS_DIRECTORY;
  if (typeof directory?.getStaffAuthority !== 'function') throw new LogsError('directory_unavailable', 503, 'Ledge Top could not check that pilot. Try again in a minute.');
  let authority;
  try { authority = await directory.getStaffAuthority(pilotId); }
  catch { throw new LogsError('directory_unavailable', 503, 'Ledge Top could not check that pilot. Try again in a minute.'); }
  if (authority?.active !== true) throw new LogsError('pilot_not_active', 400, 'That pilot is not active in Ledge Top.');
}

const changed = () => new LogsError('attribution_changed', 409, 'This log changed while you were deciding. Refresh and try again.');

/** Runs the batch; if it was refused because the state moved on (the audit guard), answers 409. */
async function commit(db, statements, stillValid) {
  try { return await db.batch(statements); }
  catch (error) {
    if (!(await stillValid())) throw changed();
    throw error;
  }
}

/** The audit row that guards the whole batch: inserted only when `condition` (SQL) holds. */
function guardedAudit(db, { condition, params, actor, subject, detail, at }) {
  const base = params.length;
  return db.prepare(`INSERT INTO audit_events (id, actor_id, action, subject, detail, at)
      SELECT ?${base + 1}, CASE WHEN ${condition} THEN ?${base + 2} END, '${ACTION}', ?${base + 3}, ?${base + 4}, ?${base + 5}`)
    .bind(...params, uuid(), actor.staffId, subject, JSON.stringify(detail), at);
}

const SUMMARY_COLUMNS = {
  display_name: 'text', started_at: 'text', ended_at: 'text', duration_seconds: 'real', distance_m: 'real', max_altitude_m: 'real',
  max_speed_mps: 'real', home_lat: 'real', home_lon: 'real', photo_count: 'count', video_count: 'count', telemetry_points: 'count',
};
const fromSummary = column => SUMMARY_COLUMNS[column] === 'count'
  ? `COALESCE(json_extract(d.summary_json, '$.${column}'), 0)` : `json_extract(d.summary_json, '$.${column}')`;

/** Admin status counts. `env.LOGS_DECODER_STATE()` (local host) says why waiting logs are waiting. */
export async function logsStatus(env, actor) {
  requireAdministrator(actor);
  const db = env.LOGS_DB;
  const [raw, failed, decoded, flights] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS retained,
        COALESCE(SUM(parse_status = 'needs_parse'), 0) AS waiting, COALESCE(SUM(parse_status = 'leased'), 0) AS decoding,
        COALESCE(SUM(parse_status = 'decoded'), 0) AS decoded, COALESCE(SUM(parse_status = 'failed'), 0) AS failed,
        MAX(uploaded_at) AS last_upload_at FROM raw_logs`),
    db.prepare(`SELECT COALESCE(error_code, 'unknown') AS code, COUNT(*) AS n FROM raw_logs WHERE parse_status = 'failed' GROUP BY 1 ORDER BY 1`),
    db.prepare(`SELECT status, COUNT(*) AS n FROM decoded_logs GROUP BY status`),
    db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(raw_log_status = 'missing'), 0) AS without_original FROM flights`),
  ]);
  const r = raw.results[0];
  const decoder = typeof env.LOGS_DECODER_STATE === 'function' ? String(env.LOGS_DECODER_STATE()) : 'unknown';
  const byStatus = Object.fromEntries(decoded.results.map(row => [row.status, row.n]));
  return {
    decoder,
    raw: {
      retained: r.retained, waiting: r.waiting,
      // Accepted, stored and safe: the reason they are not decoded yet is the decoder's state (e.g. waiting_for_key).
      waitingReason: r.waiting === 0 ? null : decoder === 'running' ? 'queued' : decoder,
      decoding: r.decoding, decoded: r.decoded, failed: r.failed,
      failedByCode: Object.fromEntries(failed.results.map(row => [row.code, row.n])),
      lastUploadAt: r.last_upload_at ?? null,
    },
    review: { unassigned: byStatus.unassigned ?? 0, conflict: byStatus.conflict ?? 0, linked: byStatus.linked ?? 0, assigned: byStatus.assigned ?? 0 },
    flights: { total: flights.results[0].total, withoutOriginal: flights.results[0].without_original },
  };
}

/** One page of a review queue, newest first. Safe fields only. */
export async function reviewQueue(env, actor, { queue = 'unassigned', limit = 50, before } = {}) {
  requireAdministrator(actor);
  if (!QUEUES.includes(queue)) throw new LogsError('queue_invalid', 400, 'Unknown review list.');
  const size = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : 50, 1), 100);
  let cursor = null;
  if (before != null) {
    const [at, sha] = String(before).split('|');
    if (!sha || !HEX64.test(sha) || Number.isNaN(Date.parse(at))) throw new LogsError('cursor_invalid', 400, 'Invalid page.');
    cursor = { at, sha };
  }
  const where = queue === 'unassigned' || queue === 'conflict' ? `d.status = '${queue}'`
    : queue === 'waiting' ? `r.parse_status IN ('needs_parse', 'leased')` : `r.parse_status = 'failed'`;
  const page = cursor ? 'AND (r.uploaded_at < ?1 OR (r.uploaded_at = ?1 AND r.sha256 < ?2))' : '';
  const rows = await env.LOGS_DB.prepare(`SELECT r.sha256, r.file_name, r.size_bytes, r.uploaded_at, r.pilot_id AS uploader_id, r.parse_status,
        r.error_code, r.parse_attempts, dev.name AS device_name, dev.model AS device_model,
        d.status, d.summary_json, d.decoded_at, d.conflict_flight_id, cf.pilot_id AS conflict_pilot_id
      FROM raw_logs r LEFT JOIN decoded_logs d ON d.raw_sha256 = r.sha256 LEFT JOIN devices dev ON dev.id = r.device_id
      LEFT JOIN flights cf ON cf.id = d.conflict_flight_id
      WHERE ${where} ${page} ORDER BY r.uploaded_at DESC, r.sha256 DESC LIMIT ${size + 1}`)
    .bind(...(cursor ? [cursor.at, cursor.sha] : [])).all();
  const items = rows.results.slice(0, size).map(row => {
    const summary = row.summary_json ? JSON.parse(row.summary_json) : null;
    return {
      rawSha256: row.sha256, fileName: row.file_name, sizeBytes: row.size_bytes, uploadedAt: row.uploaded_at,
      uploader: { pilotId: row.uploader_id, deviceName: row.device_name ?? null, deviceModel: row.device_model ?? null },
      parseStatus: row.parse_status, errorCode: row.error_code ?? null, attempts: row.parse_attempts,
      review: row.status ?? null, decodedAt: row.decoded_at ?? null,
      // No home position or track: what an administrator needs to recognise the flight.
      summary: summary && { displayName: summary.display_name, startedAt: summary.started_at, endedAt: summary.ended_at,
        durationSeconds: summary.duration_seconds, distanceM: summary.distance_m, maxAltitudeM: summary.max_altitude_m,
        photoCount: summary.photo_count, videoCount: summary.video_count },
      conflict: row.conflict_flight_id ? { flightId: row.conflict_flight_id, pilotId: row.conflict_pilot_id ?? null } : null,
    };
  });
  const last = rows.results.length > size ? rows.results[size - 1] : null;
  return { queue, items, next: last ? `${last.uploaded_at}|${last.sha256}` : null };
}

/** Initial assignment: an unassigned decoded log becomes a flight of the chosen pilot. */
export async function assignDecodedLog(env, actor, input = {}) {
  requireAdministrator(actor);
  const sha = String(input.rawSha256 ?? '');
  if (!HEX64.test(sha)) throw new LogsError('raw_log_invalid', 400, 'Invalid log.');
  const reason = reasonOf(input);
  const db = env.LOGS_DB;
  const row = await db.prepare('SELECT d.status, r.pilot_id AS uploader FROM decoded_logs d JOIN raw_logs r ON r.sha256 = d.raw_sha256 WHERE d.raw_sha256 = ?').bind(sha).first();
  if (!row) throw new LogsError('raw_log_not_found', 404, 'That log has not been decoded.');
  if (row.status !== 'unassigned') throw new LogsError('not_unassigned', 409, 'That log is not waiting for assignment.');
  await requireActivePilot(env, input.pilotId);
  const flightId = uuid();
  const at = iso(Date.now()); // after the last await
  const unassigned = `EXISTS (SELECT 1 FROM decoded_logs WHERE raw_sha256 = ?1 AND status = 'unassigned' AND flight_id IS NULL)
    AND NOT EXISTS (SELECT 1 FROM flights WHERE file_hash = ?1 OR id = ?2)`;
  const columns = Object.keys(SUMMARY_COLUMNS);
  const results = await commit(db, [
    guardedAudit(db, { condition: unassigned, params: [sha, flightId], actor, subject: `raw_log:${sha}`, at,
      // The uploader is the retained raw log's custody (the signed-in controller account), never the chosen pilot.
      detail: { kind: 'initial', rawSha256: sha, flightId, from: null, to: input.pilotId, uploader: row.uploader, reason } }),
    db.prepare(`INSERT INTO flights (id, file_hash, source_system, source_file_name, pilot_id, pilot_attribution, ${columns.join(', ')},
        telemetry_key, raw_log_status, raw_log_key, created_at, updated_at)
      SELECT ?2, r.sha256, 'controller', r.file_name, ?3, 'admin_reassigned', ${columns.map(fromSummary).join(', ')},
        d.telemetry_key, 'stored', r.r2_key, ?4, ?4
      FROM decoded_logs d JOIN raw_logs r ON r.sha256 = d.raw_sha256 WHERE d.raw_sha256 = ?1 AND d.status = 'unassigned'`)
      .bind(sha, flightId, input.pilotId, at),
    db.prepare(`UPDATE decoded_logs SET status = 'assigned', flight_id = ?2, assigned_by = ?3, assigned_at = ?4
      WHERE raw_sha256 = ?1 AND status = 'unassigned' AND EXISTS (SELECT 1 FROM flights WHERE id = ?2)`).bind(sha, flightId, actor.staffId, at),
    db.prepare('UPDATE raw_logs SET flight_id = ?2 WHERE sha256 = ?1 AND EXISTS (SELECT 1 FROM flights WHERE id = ?2)').bind(sha, flightId),
  ], async () => (await db.prepare('SELECT status FROM decoded_logs WHERE raw_sha256 = ?').bind(sha).first())?.status === 'unassigned'
    && !(await db.prepare('SELECT 1 AS x FROM flights WHERE file_hash = ?').bind(sha).first()));
  if (results[1].meta.changes !== 1 || results[2].meta.changes !== 1) throw changed();
  return { flightId, pilotId: input.pilotId, attribution: 'admin_reassigned', kind: 'initial' };
}

/** Moves any flight (imported or decoded) to another active pilot. */
export async function reassignFlight(env, actor, input = {}) {
  requireAdministrator(actor);
  const flightId = String(input.flightId ?? '');
  if (!FLIGHT_ID.test(flightId)) throw new LogsError('flight_invalid', 400, 'Invalid flight.');
  const reason = reasonOf(input);
  const db = env.LOGS_DB;
  // Custody, when this flight has a retained controller original (explicitly null for an imported flight without one).
  const flight = await db.prepare(`SELECT f.pilot_id, r.sha256 AS raw_sha256, r.pilot_id AS uploader FROM flights f
      LEFT JOIN raw_logs r ON r.sha256 = f.file_hash WHERE f.id = ?`).bind(flightId).first();
  if (!flight) throw new LogsError('flight_not_found', 404, 'That flight was not found.');
  if (flight.pilot_id === input.pilotId) throw new LogsError('no_change', 409, 'That flight already belongs to this pilot.');
  await requireActivePilot(env, input.pilotId);
  const at = iso(Date.now());
  const results = await commit(db, [
    guardedAudit(db, { condition: 'EXISTS (SELECT 1 FROM flights WHERE id = ?1 AND pilot_id = ?2)', params: [flightId, flight.pilot_id], actor,
      subject: `flight:${flightId}`, at, detail: { kind: 'reassign', flightId, from: flight.pilot_id, to: input.pilotId,
        rawSha256: flight.raw_sha256 ?? null, uploader: flight.uploader ?? null, reason } }),
    db.prepare(`UPDATE flights SET pilot_id = ?3, pilot_attribution = 'admin_reassigned', updated_at = ?4 WHERE id = ?1 AND pilot_id = ?2`)
      .bind(flightId, flight.pilot_id, input.pilotId, at),
  ], async () => (await db.prepare('SELECT pilot_id FROM flights WHERE id = ?').bind(flightId).first())?.pilot_id === flight.pilot_id);
  if (results[1].meta.changes !== 1) throw changed();
  return { flightId, from: flight.pilot_id, pilotId: input.pilotId, attribution: 'admin_reassigned', kind: 'reassign' };
}

/**
 * A decoded log whose content hash matches another pilot's flight. `keep_existing` links it to that flight and keeps
 * the flight's owner; `reassign_existing` moves that flight to `pilotId` (e.g. the controller's pilot) and links it.
 */
export async function resolveConflict(env, actor, input = {}) {
  requireAdministrator(actor);
  const sha = String(input.rawSha256 ?? '');
  if (!HEX64.test(sha)) throw new LogsError('raw_log_invalid', 400, 'Invalid log.');
  if (!['keep_existing', 'reassign_existing'].includes(input.resolution)) throw new LogsError('resolution_invalid', 400, 'Choose how to resolve this conflict.');
  const reason = reasonOf(input);
  const db = env.LOGS_DB;
  const row = await db.prepare(`SELECT d.status, d.conflict_flight_id, f.pilot_id AS owner, r.pilot_id AS uploader
      FROM decoded_logs d JOIN raw_logs r ON r.sha256 = d.raw_sha256 LEFT JOIN flights f ON f.id = d.conflict_flight_id WHERE d.raw_sha256 = ?`).bind(sha).first();
  if (!row) throw new LogsError('raw_log_not_found', 404, 'That log has not been decoded.');
  if (row.status !== 'conflict' || !row.conflict_flight_id || !row.owner) throw new LogsError('not_conflict', 409, 'That log is not waiting for a conflict decision.');
  const reassign = input.resolution === 'reassign_existing';
  if (reassign) {
    if (input.pilotId === row.owner) throw new LogsError('no_change', 409, 'That flight already belongs to this pilot. Choose keep the existing owner.');
    await requireActivePilot(env, input.pilotId);
  }
  const to = reassign ? input.pilotId : row.owner;
  const at = iso(Date.now());
  const flightId = row.conflict_flight_id;
  const condition = `EXISTS (SELECT 1 FROM decoded_logs WHERE raw_sha256 = ?1 AND status = 'conflict' AND conflict_flight_id = ?2)
    AND EXISTS (SELECT 1 FROM flights WHERE id = ?2 AND pilot_id = ?3)`;
  const results = await commit(db, [
    guardedAudit(db, { condition, params: [sha, flightId, row.owner], actor, subject: `raw_log:${sha}`, at,
      detail: { kind: reassign ? 'conflict_reassign' : 'conflict_keep_existing', rawSha256: sha, flightId, from: row.owner, to, uploader: row.uploader, reason } }),
    db.prepare(`UPDATE flights SET pilot_id = ?3, pilot_attribution = CASE WHEN ?3 = ?2 THEN pilot_attribution ELSE 'admin_reassigned' END,
        raw_log_status = 'stored', raw_log_key = COALESCE(raw_log_key, (SELECT r2_key FROM raw_logs WHERE sha256 = ?4)),
        telemetry_key = COALESCE(telemetry_key, (SELECT telemetry_key FROM decoded_logs WHERE raw_sha256 = ?4)), updated_at = ?5
      WHERE id = ?1 AND pilot_id = ?2`).bind(flightId, row.owner, to, sha, at),
    db.prepare(`UPDATE decoded_logs SET status = 'linked', flight_id = ?2, assigned_by = ?3, assigned_at = ?4
      WHERE raw_sha256 = ?1 AND status = 'conflict' AND conflict_flight_id = ?2`).bind(sha, flightId, actor.staffId, at),
    db.prepare('UPDATE raw_logs SET flight_id = ?2 WHERE sha256 = ?1').bind(sha, flightId),
  ], async () => {
    const now = await db.prepare(`SELECT d.status, f.pilot_id FROM decoded_logs d LEFT JOIN flights f ON f.id = d.conflict_flight_id WHERE d.raw_sha256 = ?`).bind(sha).first();
    return now?.status === 'conflict' && now.pilot_id === row.owner;
  });
  if (results[1].meta.changes !== 1 || results[2].meta.changes !== 1) throw changed();
  return { flightId, from: row.owner, pilotId: to, kind: reassign ? 'conflict_reassign' : 'conflict_keep_existing' };
}
