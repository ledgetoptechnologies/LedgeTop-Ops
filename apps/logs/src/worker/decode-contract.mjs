// Raw DJI log decoding: the lease, completion and error contract. CONTRACT ONLY. Nothing here decodes a log
// or calls DJI. A runtime (see DECODER.md) leases a row, decodes the raw bytes, and reports the outcome
// through these functions, which keep every transition fenced and attribution-safe:
// - raw_logs rows and their R2 objects are never deleted or rewritten, whatever happens;
// - a decoded flight always carries the raw log's own pilot and content hash; it is never re-attributed;
// - only the holder of the current, unexpired lease token can complete, retry or fail a row;
// - the DJI key binding is chosen by an explicit environment, never by falling back to another key.
import { LogsError } from './errors.mjs';

export const LEASE_SECONDS = 300;
export const MAX_ATTEMPTS = 5;
export const MAX_LEASE_BATCH = 10;

// Safe categories stored in raw_logs.error_code. Never raw decoder output, keys, or file contents.
export const RETRYABLE_ERRORS = Object.freeze(['keychain_unavailable', 'decoder_error', 'raw_missing']);
export const PERMANENT_ERRORS = Object.freeze(['unsupported_version', 'corrupt_log', 'attribution_conflict', 'attempts_exhausted']);

// The only DJI Open API key binding each environment may use. Values are Worker secrets; this module
// only names the binding. There is deliberately no default and no cross-environment fallback.
const DJI_KEY_BINDINGS = Object.freeze({ staging: 'DJI_API_KEY_Staging', production: 'DJI_API_KEY' });

/** Name of the DJI key binding for this Worker. Throws unless the environment is explicit and its own key is set. */
export function djiKeyBinding(env) {
  const environment = env?.LOGS_ENVIRONMENT;
  const binding = Object.hasOwn(DJI_KEY_BINDINGS, environment) ? DJI_KEY_BINDINGS[environment] : null;
  if (!binding) throw new LogsError('decoder_not_configured', 503, 'The flight-log decoder environment isn’t configured.');
  if (typeof env[binding] !== 'string' || env[binding].trim() === '') throw new LogsError('decoder_key_missing', 503, 'The flight-log decoder key isn’t configured for this environment.');
  return binding;
}

const iso = ms => new Date(ms).toISOString();
const claimable = `(parse_status = 'needs_parse' OR (parse_status = 'leased' AND lease_expires_at <= ?1))`;

/**
 * Lease up to `limit` raw logs for decoding. Each claim is a compare-and-set on the row's current state, so
 * two runners never hold the same row. Expired leases are reclaimed; rows that have used every attempt
 * are closed as attempts_exhausted instead of being leased again.
 */
export async function leaseRawLogs(env, { now = Date.now(), limit = MAX_LEASE_BATCH, token = () => crypto.randomUUID() } = {}) {
  const at = iso(now), bounded = Math.max(1, Math.min(MAX_LEASE_BATCH, Math.trunc(limit) || 1));
  await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'failed', error_code = 'attempts_exhausted', attempt_token = NULL, lease_expires_at = NULL
    WHERE parse_status = 'leased' AND lease_expires_at <= ?1 AND parse_attempts >= ?2`).bind(at, MAX_ATTEMPTS).run();
  const candidates = await env.LOGS_DB.prepare(`SELECT sha256 FROM raw_logs WHERE ${claimable} AND parse_attempts < ?2
    ORDER BY uploaded_at, sha256 LIMIT ?3`).bind(at, MAX_ATTEMPTS, bounded).all();
  const leases = [];
  for (const { sha256 } of candidates.results) {
    const attemptToken = token(), expiresAt = iso(now + LEASE_SECONDS * 1000);
    const claimed = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'leased', attempt_token = ?2, lease_expires_at = ?3,
        parse_attempts = parse_attempts + 1, error_code = NULL
      WHERE sha256 = ?4 AND ${claimable} AND parse_attempts < ?5
      RETURNING sha256, r2_key, pilot_id, device_id, parse_attempts`).bind(at, attemptToken, expiresAt, sha256, MAX_ATTEMPTS).first();
    if (claimed) leases.push({ sha256: claimed.sha256, r2Key: claimed.r2_key, pilotId: claimed.pilot_id, deviceId: claimed.device_id,
      attempt: claimed.parse_attempts, attemptToken, leaseExpiresAt: expiresAt });
  }
  return leases;
}

// The lease fence every outcome must pass: same row, same token, still leased, lease not expired.
const fence = `sha256 = ?1 AND attempt_token = ?2 AND parse_status = 'leased' AND lease_expires_at > ?3`;
function staleLease() { return new LogsError('lease_stale', 409, 'This decode attempt no longer holds the log.'); }
function requireLease(lease) {
  if (!lease || !/^[0-9a-f]{64}$/.test(lease.sha256 ?? '') || typeof lease.attemptToken !== 'string' || !lease.attemptToken) throw staleLease();
}

const SUMMARY_FIELDS = ['display_name', 'started_at', 'ended_at', 'duration_seconds', 'distance_m', 'max_altitude_m', 'max_speed_mps',
  'home_lat', 'home_lon', 'photo_count', 'video_count', 'telemetry_points'];
// NOT NULL counters in flights; an absent count is stored as 0, as the schema default does.
const COUNT_FIELDS = new Set(['photo_count', 'video_count', 'telemetry_points']);

/**
 * Record a decoded log, atomically. `contentSha256` is the hash of the bytes the runtime actually decoded and
 * must equal the raw row's hash. If a flight with that hash already exists (for example from an ODL backup),
 * it is linked only when it belongs to the same pilot; a different pilot is an attribution conflict that needs
 * a reviewed reconciliation, so the row is failed and nothing is linked. Otherwise a new flight is created
 * with the raw row's own pilot and hash. Either way the flight write and the raw_logs update commit together.
 */
export async function completeDecode(env, lease, { contentSha256, flightId, summary = {} }, { now = Date.now() } = {}) {
  requireLease(lease);
  if (contentSha256 !== lease.sha256) throw new LogsError('hash_mismatch', 409, 'The decoded bytes don’t match this raw log.');
  if (typeof flightId !== 'string' || !flightId) throw new LogsError('flight_id_required', 400, 'A flight id is required.');
  const at = iso(now), db = env.LOGS_DB;
  const raw = await db.prepare(`SELECT sha256, pilot_id, r2_key FROM raw_logs WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, at).first();
  if (!raw) throw staleLease();
  const existing = await db.prepare('SELECT id, pilot_id FROM flights WHERE file_hash = ?1').bind(raw.sha256).first();
  if (existing && existing.pilot_id !== raw.pilot_id) {
    await failDecode(env, lease, 'attribution_conflict', { now });
    return { status: 'failed', errorCode: 'attribution_conflict' };
  }
  const linkedId = existing ? existing.id : flightId;
  const values = SUMMARY_FIELDS.map(field => summary[field] ?? null);
  const statements = existing ? [] : [db.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, ${SUMMARY_FIELDS.join(', ')},
      raw_log_status, raw_log_key, created_at, updated_at)
    SELECT ?4, r.sha256, 'controller', r.pilot_id, 'controller_sign_in', ${SUMMARY_FIELDS.map((field, i) => COUNT_FIELDS.has(field) ? `COALESCE(?${i + 5}, 0)` : `?${i + 5}`).join(', ')}, 'stored', r.r2_key, ?3, ?3
    FROM raw_logs r WHERE r.${fence.replaceAll(' AND ', ' AND r.')}`)
    .bind(lease.sha256, lease.attemptToken, at, linkedId, ...values.map(value => value ?? null))];
  // Linking an existing flight changes nothing unless the lease still holds and the pilots match.
  if (existing) statements.push(db.prepare(`UPDATE flights SET raw_log_status = 'stored', raw_log_key = (SELECT r2_key FROM raw_logs WHERE sha256 = ?1), updated_at = ?3
    WHERE id = ?4 AND file_hash = ?1
      AND EXISTS (SELECT 1 FROM raw_logs r WHERE r.${fence.replaceAll(' AND ', ' AND r.')} AND r.pilot_id = flights.pilot_id)`)
    .bind(lease.sha256, lease.attemptToken, at, linkedId));
  // The raw row only moves to decoded when its flight carries this exact hash and pilot.
  statements.push(db.prepare(`UPDATE raw_logs SET parse_status = 'decoded', flight_id = ?4, decoded_at = ?3, attempt_token = NULL, lease_expires_at = NULL, error_code = NULL
    WHERE ${fence} AND EXISTS (SELECT 1 FROM flights f WHERE f.id = ?4 AND f.file_hash = raw_logs.sha256 AND f.pilot_id = raw_logs.pilot_id)`)
    .bind(lease.sha256, lease.attemptToken, at, linkedId));
  const results = await db.batch(statements);
  if (results.at(-1).meta.changes !== 1) throw staleLease();
  return { status: 'decoded', flightId: linkedId, linkedExisting: Boolean(existing) };
}

/** Give the row back for another attempt after a retryable problem. */
export async function retryDecode(env, lease, errorCode, { now = Date.now() } = {}) {
  requireLease(lease);
  if (!RETRYABLE_ERRORS.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown retryable decode error.');
  const result = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'needs_parse', attempt_token = NULL, lease_expires_at = NULL, error_code = ?4
    WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now), errorCode).run();
  if (result.meta.changes !== 1) throw staleLease();
  return { status: 'needs_parse', errorCode };
}

/** Close the row as failed. The raw log itself is kept. */
export async function failDecode(env, lease, errorCode, { now = Date.now() } = {}) {
  requireLease(lease);
  if (!PERMANENT_ERRORS.includes(errorCode)) throw new LogsError('error_code_invalid', 400, 'Unknown decode failure.');
  const result = await env.LOGS_DB.prepare(`UPDATE raw_logs SET parse_status = 'failed', attempt_token = NULL, lease_expires_at = NULL, error_code = ?4
    WHERE ${fence}`).bind(lease.sha256, lease.attemptToken, iso(now), errorCode).run();
  if (result.meta.changes !== 1) throw staleLease();
  return { status: 'failed', errorCode };
}
