// Raw DJI log decoding: the claim, heartbeat, completion and error contract for the local decoder (DECODER.md).
// Logs' D1 ledger is the durable queue and R2 holds the raw originals; the decoder only ever holds a lease. Every
// transition here is fenced and attribution-safe:
// - raw_logs rows and their R2 objects are never deleted or rewritten; pilot, device, source, upload time and key
//   never change;
// - a decoded flight always carries the raw log's own pilot and content hash; it is never re-attributed;
// - only the current, unexpired attempt can heartbeat, complete, retry, defer or fail a row;
// - a committed result has a durable receipt (attempt, fingerprint): an identical replay gets the same receipt, a
//   different result for the same row is refused, never swapped in;
// - outages, crashes and DJI/network trouble never use up the parse budget; only real decoder errors do.
// Needs the decoder-queue columns from migrations/0005_local_decoder_leases.sql on raw_logs.
import { LogsError } from './errors.mjs';

export const LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 5;        // reported decoder errors before attempts_exhausted
export const MAX_RECLAIMS = 20;       // leases taken over after expiry before the row is parked for review
export const MAX_OCCUPANCY = 1;       // live leases at once, across all runners (enforced in SQL, not only by the runner)
const DEFER_MIN_SECONDS = 60, DEFER_MAX_SECONDS = 6 * 3600;

// Closed outcome vocabularies. Stored in raw_logs.error_code; never raw decoder output, keys or file contents.
export const DEFER_CODES = Object.freeze(['keychain_unavailable', 'dji_unavailable', 'network_unavailable', 'rate_limited', 'raw_missing']);
export const RETRY_CODES = Object.freeze(['decoder_error']);
export const PERMANENT_ERRORS = Object.freeze(['unsupported_version', 'corrupt_log', 'attribution_conflict', 'attempts_exhausted']);
// Suspended for review, visibly, never a verdict on the log and never partly recorded: log_too_large means the log or
// its decoded output is over the runner's or the stored track's limits. A reviewer can return the row to the queue.
// resource_capacity: decoding this log ran the runner out of memory or scratch space (no disk spill, no retry loop).
export const SUSPEND_CODES = Object.freeze(['log_too_large', 'resource_capacity']);
// Set only by the server: a row whose leases kept expiring (possible poison log or an unhealthy runner). Not a
// verdict on the log; a reviewer can return it to the queue.
export const PARKED = 'needs_review';

const REQUEST_ID = /^[A-Za-z0-9_-]{16,64}$/;
const RUNNER_ID = /^[a-z0-9-]{3,40}$/;   // set by the bridge from its own configuration, never by the runner
const HEX64 = /^[0-9a-f]{64}$/;
const iso = ms => new Date(ms).toISOString();
const stale = () => new LogsError('lease_stale', 409, 'This decode attempt no longer holds the log.');
const fence = `sha256 = ?1 AND attempt_token = ?2 AND parse_status = 'leased' AND lease_expires_at > ?3`;
const claimable = `((parse_status = 'needs_parse' AND (next_attempt_at IS NULL OR next_attempt_at <= ?1)) OR (parse_status = 'leased' AND lease_expires_at <= ?1))`;

function requireLease(lease) {
  if (!lease || !HEX64.test(lease.sha256 ?? '') || typeof lease.attemptToken !== 'string' || !lease.attemptToken || lease.attemptToken.length > 100) throw stale();
}
const leaseOf = (row, attemptToken, leaseExpiresAt) => ({ sha256: row.sha256, attemptToken, leaseExpiresAt,
  attempt: row.parse_attempts + 1, reclaims: row.lease_reclaims });

/**
 * Claim the next decodable raw log, just in time, one at a time, for one configured runner identity.
 * `runnerId` comes from the bridge's configuration (bound to the authenticated token), never from the runner;
 * `requestId` is unique per claim. Repeating the EXACT same claim (a lost claim reply) returns the same lease; any
 * other claim (including a restarted process of the same runner) never adopts a live lease: it waits until that lease
 * expires (at most LEASE_SECONDS) and then takes it over with a fresh token, so two generations can never both hold
 * it. At most MAX_OCCUPANCY leases are live at once, enforced inside the claim's own statement. Taking over an EXPIRED
 * lease counts as a reclaim, not a parse attempt; a row whose leases keep expiring is parked for review.
 */
export async function claimRawLog(env, { runnerId, requestId, now = Date.now(), token = () => crypto.randomUUID() } = {}) {
  if (typeof runnerId !== 'string' || !RUNNER_ID.test(runnerId)) throw new LogsError('runner_invalid', 400, 'The decoder runner isn’t configured.');
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) throw new LogsError('request_id_invalid', 400, 'A claim request id is required.');
  const db = env.LOGS_DB, at = iso(now), claimKey = `${runnerId}:${requestId}`, mine = `${runnerId}:%`;
  const repeatOf = async () => {
    const row = await db.prepare(`SELECT sha256, attempt_token, lease_expires_at, parse_attempts, lease_reclaims FROM raw_logs
      WHERE claim_request_id = ?1 AND parse_status = 'leased' AND lease_expires_at > ?2`).bind(claimKey, at).first();
    return row ? leaseOf(row, row.attempt_token, row.lease_expires_at) : null;
  };
  const repeat = await repeatOf();
  if (repeat) return repeat;
  // The key is unique among rows; release it from a lease of this key that has since expired, so it can be reused.
  await db.prepare(`UPDATE raw_logs SET claim_request_id = NULL WHERE claim_request_id = ?1 AND NOT (parse_status = 'leased' AND lease_expires_at > ?2)`).bind(claimKey, at).run();

  await db.prepare(`UPDATE raw_logs SET parse_status = 'failed', error_code = ?3, attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL
    WHERE parse_status = 'leased' AND lease_expires_at <= ?1 AND lease_reclaims >= ?2`).bind(at, MAX_RECLAIMS, PARKED).run();
  const candidates = await db.prepare(`SELECT sha256 FROM raw_logs WHERE ${claimable} ORDER BY uploaded_at, sha256 LIMIT 5`).bind(at).all();
  for (const { sha256 } of candidates.results) {
    const attemptToken = token(), expiresAt = iso(now + LEASE_SECONDS * 1000);
    // SET expressions read the row as it was, so the reclaim counter only moves when an expired lease is taken over.
    const claimed = await db.prepare(`UPDATE raw_logs SET parse_status = 'leased', attempt_token = ?2, lease_expires_at = ?3, claim_request_id = ?4,
        lease_reclaims = lease_reclaims + CASE WHEN parse_status = 'leased' THEN 1 ELSE 0 END, error_code = NULL
      WHERE sha256 = ?5 AND ${claimable} AND NOT (parse_status = 'leased' AND lease_reclaims >= ?6)
        AND NOT EXISTS (SELECT 1 FROM raw_logs held WHERE held.claim_request_id LIKE ?8 AND held.parse_status = 'leased' AND held.lease_expires_at > ?1)
        AND (SELECT COUNT(*) FROM raw_logs live WHERE live.parse_status = 'leased' AND live.lease_expires_at > ?1) < ?7
      RETURNING sha256, parse_attempts, lease_reclaims`).bind(at, attemptToken, expiresAt, claimKey, sha256, MAX_RECLAIMS, MAX_OCCUPANCY, mine).first();
    if (claimed) return leaseOf(claimed, attemptToken, expiresAt);
  }
  // A concurrent identical claim may have won meanwhile: hand back that lease, never a second row.
  return repeatOf();
}

/** Extend the lease of the exact active attempt. Anything else is stale. */
export async function heartbeatLease(env, lease, { now = Date.now() } = {}) {
  requireLease(lease);
  const row = await env.LOGS_DB.prepare(`UPDATE raw_logs SET lease_expires_at = ?4 WHERE ${fence} RETURNING lease_expires_at`)
    .bind(lease.sha256, lease.attemptToken, iso(now), iso(now + LEASE_SECONDS * 1000)).first();
  if (!row) throw stale();
  return { leaseExpiresAt: row.lease_expires_at };
}

/** The stored raw log for the exact active attempt, or raw_missing. Never any other row. */
export async function heldRawLog(env, lease, { now = Date.now() } = {}) {
  requireLease(lease);
  const row = await env.LOGS_DB.prepare(`SELECT sha256, r2_key, size_bytes FROM raw_logs WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now)).first();
  if (!row) throw stale();
  return row;
}

const SUMMARY_FIELDS = ['display_name', 'started_at', 'ended_at', 'duration_seconds', 'distance_m', 'max_altitude_m', 'max_speed_mps',
  'home_lat', 'home_lon', 'photo_count', 'video_count', 'telemetry_points'];
const COUNT_FIELDS = new Set(['photo_count', 'video_count', 'telemetry_points']);

async function receiptFor(db, sha256) {
  return db.prepare(`SELECT r.parse_status, r.committed_attempt_token, r.result_fingerprint, d.flight_id, d.telemetry_key, d.status AS attribution
    FROM raw_logs r LEFT JOIN decoded_logs d ON d.raw_sha256 = r.sha256 WHERE r.sha256 = ?1`).bind(sha256).first();
}

/**
 * Commit a decoded log, atomically, with a durable receipt. `fingerprint` identifies the exact result (summary and
 * track). Replaying the same attempt with the same fingerprint returns the original receipt; a different
 * fingerprint, or another attempt, is refused. A flight with the same hash is linked only for the same pilot (it
 * keeps its own track); a different pilot fails the row as attribution_conflict and links nothing.
 */
export async function completeDecode(env, lease, { contentSha256, summary = {}, telemetryKey = null, fingerprint, decoderVersion }, { now = Date.now } = {}) {
  requireLease(lease);
  if (contentSha256 !== lease.sha256) throw new LogsError('hash_mismatch', 409, 'The decoded bytes don’t match this raw log.');
  if (typeof fingerprint !== 'string' || !HEX64.test(fingerprint)) throw new LogsError('fingerprint_invalid', 400, 'Invalid result fingerprint.');
  if (typeof decoderVersion !== 'string' || !/^[A-Za-z0-9._:/+@-]{1,80}$/.test(decoderVersion)) throw new LogsError('decoder_version_invalid', 400, 'Invalid decoder version.');
  if (telemetryKey != null && (typeof telemetryKey !== 'string' || !/^telemetry\/v1\/[A-Za-z0-9._/-]{1,160}\.json\.gz$/.test(telemetryKey)))
    throw new LogsError('telemetry_key_invalid', 400, 'Invalid track location.');
  const db = env.LOGS_DB;
  const clock = typeof now === 'function' ? now : () => now;

  const prior = await receiptFor(db, lease.sha256);
  if (prior?.parse_status === 'decoded') {
    if (prior.committed_attempt_token !== lease.attemptToken) throw stale();
    if (prior.result_fingerprint !== fingerprint) throw new LogsError('result_conflict', 409, 'A different result was already committed for this attempt.');
    return { status: 'decoded', attribution: prior.attribution, flightId: prior.flight_id ?? null, telemetryKey: prior.telemetry_key ?? null, fingerprint, replayed: true };
  }
  // The lease-expiry time is read now, after the last await and right before the batch, so a stalled read can never
  // commit with a time from before the stall. (The remaining gap is the database executing this one batch.)
  const at = iso(clock());

  // Everything below is one batch (one transaction). The attribution is decided INSIDE it, from the flights table as
  // it is at commit time, and every effect depends on this attempt's own decoded row, which can only be written
  // while this attempt still holds the lease. A reclaimed or stale attempt therefore changes nothing at all.
  // The uploader is custody, not the pilot. Only a flight with this exact content hash can say who flew:
  // same owner -> linked (fill a missing track only); another owner -> conflict for review; none -> unassigned.
  const summaryJson = JSON.stringify(Object.fromEntries(SUMMARY_FIELDS.map(field => [field, summary[field] ?? null])));
  const rFence = fence.replaceAll(' AND ', ' AND r.');
  const mine = `SELECT 1 FROM decoded_logs d WHERE d.raw_sha256 = ?1 AND d.committed_attempt_token = ?2`;
  const statements = [
    db.prepare(`INSERT INTO decoded_logs (raw_sha256, status, summary_json, telemetry_key, result_fingerprint, decoder_version,
        committed_attempt_token, flight_id, conflict_flight_id, decoded_at)
      SELECT r.sha256,
        CASE WHEN f.id IS NULL THEN 'unassigned' WHEN f.pilot_id = r.pilot_id THEN 'linked' ELSE 'conflict' END,
        ?4, ?5, ?6, ?7, ?2,
        CASE WHEN f.pilot_id = r.pilot_id THEN f.id END,
        CASE WHEN f.id IS NOT NULL AND f.pilot_id <> r.pilot_id THEN f.id END,
        ?3
      FROM raw_logs r LEFT JOIN flights f ON f.file_hash = r.sha256 WHERE r.${rFence}`)
      .bind(lease.sha256, lease.attemptToken, at, summaryJson, telemetryKey, fingerprint, decoderVersion),
    // Linked: the flight keeps its owner, attribution, metadata and track; the decode only fills a missing track.
    db.prepare(`UPDATE flights SET raw_log_status = 'stored', raw_log_key = (SELECT r2_key FROM raw_logs WHERE sha256 = ?1),
        telemetry_key = COALESCE(telemetry_key, ?4), updated_at = ?3
      WHERE file_hash = ?1 AND id = (SELECT d.flight_id FROM decoded_logs d WHERE d.raw_sha256 = ?1 AND d.committed_attempt_token = ?2 AND d.status = 'linked')
        AND pilot_id = (SELECT pilot_id FROM raw_logs WHERE sha256 = ?1)
        AND EXISTS (SELECT 1 FROM raw_logs r WHERE r.${rFence})`)
      .bind(lease.sha256, lease.attemptToken, at, telemetryKey),
    // Conflict: one audit row, only for this attempt's committed conflict, never repeated.
    db.prepare(`INSERT INTO audit_events (id, actor_id, action, subject, detail, at)
      SELECT ?4, 'system', 'raw_log.attribution_conflict', 'raw_log:' || ?1, NULL, ?3
      WHERE EXISTS (${mine} AND d.status = 'conflict') AND EXISTS (SELECT 1 FROM raw_logs r WHERE r.${rFence})
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE action = 'raw_log.attribution_conflict' AND subject = 'raw_log:' || ?1)`)
      .bind(lease.sha256, lease.attemptToken, at, crypto.randomUUID()),
    // The raw row moves to decoded, with its receipt, only together with this attempt's decoded row.
    db.prepare(`UPDATE raw_logs SET parse_status = 'decoded', decoded_at = ?3, committed_attempt_token = ?2,
        flight_id = (SELECT d.flight_id FROM decoded_logs d WHERE d.raw_sha256 = ?1 AND d.committed_attempt_token = ?2),
        result_fingerprint = ?4, decoder_version = ?5, attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL, next_attempt_at = NULL, error_code = NULL
      WHERE ${fence} AND EXISTS (${mine})`)
      .bind(lease.sha256, lease.attemptToken, at, fingerprint, decoderVersion),
  ];
  const results = await db.batch(statements);
  if (results[0].meta.changes !== 1 || results.at(-1).meta.changes !== 1) throw stale();
  const committed = await receiptFor(db, lease.sha256);
  return { status: 'decoded', attribution: committed.attribution, flightId: committed.flight_id ?? null, telemetryKey, fingerprint, replayed: false };
}

/**
 * Give a row back for later because of something outside the log: DJI, the network, a rate limit, a missing raw
 * object. Uses no parse attempt; the row waits at least `retryAfterSeconds` (clamped to 1 minute – 6 hours).
 */
export async function deferDecode(env, lease, errorCode, { retryAfterSeconds = 300, now = Date.now() } = {}) {
  requireLease(lease);
  if (!DEFER_CODES.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown deferral reason.');
  const wait = Math.min(DEFER_MAX_SECONDS, Math.max(DEFER_MIN_SECONDS, Math.trunc(Number(retryAfterSeconds)) || DEFER_MIN_SECONDS));
  const row = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'needs_parse', error_code = ?4, next_attempt_at = ?5,
      attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL
    WHERE ${fence} RETURNING next_attempt_at`).bind(lease.sha256, lease.attemptToken, iso(now), errorCode, iso(now + wait * 1000)).first();
  if (!row) throw stale();
  return { status: 'needs_parse', errorCode, nextAttemptAt: row.next_attempt_at };
}

/**
 * The decoder failed on this log. Uses one parse attempt and waits (2, 4, 8 … minutes, at most an hour) before the
 * next; at MAX_ATTEMPTS the row is closed as attempts_exhausted. The raw log is kept either way.
 */
export async function retryDecode(env, lease, errorCode, { now = Date.now() } = {}) {
  requireLease(lease);
  if (!RETRY_CODES.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown retryable decode error.');
  const current = await env.LOGS_DB.prepare(`SELECT parse_attempts FROM raw_logs WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now)).first();
  if (!current) throw stale();
  const used = current.parse_attempts + 1, exhausted = used >= MAX_ATTEMPTS;
  const wait = Math.min(3600, 60 * 2 ** used);
  const row = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_attempts = ?4, parse_status = ?5, error_code = ?6, next_attempt_at = ?7,
      attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL
    WHERE ${fence} RETURNING parse_status, error_code`).bind(lease.sha256, lease.attemptToken, iso(now), used,
      exhausted ? 'failed' : 'needs_parse', exhausted ? 'attempts_exhausted' : errorCode, exhausted ? null : iso(now + wait * 1000)).first();
  if (!row) throw stale();
  return { status: row.parse_status, errorCode: row.error_code };
}

/**
 * Suspend the row for review, visibly: the log (or its decoded output) is over the limits. Not a verdict on the log
 * and nothing is partly recorded; a reviewer can return it to the queue. Uses no parse attempt.
 */
export async function suspendDecode(env, lease, errorCode, { now = Date.now() } = {}) {
  requireLease(lease);
  if (!SUSPEND_CODES.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown suspension reason.');
  const result = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'failed', attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL, error_code = ?4
    WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now), errorCode).run();
  if (result.meta.changes !== 1) throw stale();
  return { status: 'suspended', errorCode };
}

/** Close the row as failed for a reason in the log itself. The raw log is kept. */
export async function failDecode(env, lease, errorCode, { now = Date.now() } = {}) {
  requireLease(lease);
  if (!PERMANENT_ERRORS.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown decode failure.');
  const result = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'failed', error_code = ?4, attempt_token = NULL, lease_expires_at = NULL, claim_request_id = NULL
    WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now), errorCode).run();
  if (result.meta.changes !== 1) throw stale();
  return { status: 'failed', errorCode };
}

/**
 * After a lost reply: did this attempt's result commit? `decoded` with the original receipt only for the attempt
 * that committed it; `held` while the attempt still holds the lease; otherwise `lost` (the log will be offered again).
 */
export async function reconcileDecode(env, lease, { now = Date.now() } = {}) {
  requireLease(lease);
  const row = await env.LOGS_DB.prepare(`SELECT r.parse_status, r.attempt_token, r.lease_expires_at, r.committed_attempt_token, r.result_fingerprint, d.flight_id, d.telemetry_key, d.status AS attribution
    FROM raw_logs r LEFT JOIN decoded_logs d ON d.raw_sha256 = r.sha256 WHERE r.sha256 = ?1`).bind(lease.sha256).first();
  if (row?.parse_status === 'decoded' && row.committed_attempt_token === lease.attemptToken)
    return { status: 'decoded', attribution: row.attribution, flightId: row.flight_id ?? null, telemetryKey: row.telemetry_key ?? null, fingerprint: row.result_fingerprint };
  if (row?.parse_status === 'leased' && row.attempt_token === lease.attemptToken && row.lease_expires_at > iso(now)) return { status: 'held', leaseExpiresAt: row.lease_expires_at };
  return { status: 'lost' };
}
