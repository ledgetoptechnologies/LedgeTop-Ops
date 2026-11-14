// Routes for the local decoder runner (logs.ledgetop.app/api/v1/decoder/*). See DECODER.md.
//
// CLOSED BY DEFAULT: unless DECODER_ENABLED is "true" and DECODER_TOKEN_SHA256 holds the SHA-256 (hex) of the
// runner's token, every path here is a plain 404, exactly like an unknown path. The runner is a machine, not a
// person: it sends only its own bearer token, never a staff cookie, and it can only lease raw logs, read the
// bytes of a log it currently holds, and report that log's outcome through the fenced decode contract. It
// can't list flights, read other logs, pick a pilot, or name an R2 key or URL.
import { LogsError } from './errors.mjs';
import * as decode from './decode-contract.mjs';

const PREFIX = '/api/v1/decoder/';
const TRACK_LIMIT = 32 * 1024 * 1024;
const SMALL_BODY = 4096;
const SUMMARY_HEADER_LIMIT = 6144;
const HEX64 = /^[0-9a-f]{64}$/;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export function decoderEnabled(env) {
  return env?.DECODER_ENABLED === 'true' && typeof env.DECODER_TOKEN_SHA256 === 'string' && HEX64.test(env.DECODER_TOKEN_SHA256);
}

async function sha256Hex(text) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function sameHex(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function authorized(request, env) {
  const header = request.headers.get('Authorization') ?? '';
  const match = /^Bearer ([A-Za-z0-9_-]{32,256})$/.exec(header);
  if (!match) return false;
  return sameHex(await sha256Hex(match[1]), env.DECODER_TOKEN_SHA256);
}

async function readLimited(request, limit) {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > limit) { await request.body?.cancel('too_large').catch(() => {}); throw new LogsError('too_large', 413, 'Request too large.'); }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel('too_large').catch(() => {}); throw new LogsError('too_large', 413, 'Request too large.'); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

async function readSmallJson(request) {
  const bytes = await readLimited(request, SMALL_BODY);
  try { return bytes.byteLength ? JSON.parse(new TextDecoder().decode(bytes)) : {}; } catch { throw new LogsError('invalid_json', 400, 'The request was not valid JSON.'); }
}

function leaseFrom(sha256, attemptToken) {
  if (typeof sha256 !== 'string' || !HEX64.test(sha256) || typeof attemptToken !== 'string' || !attemptToken || attemptToken.length > 100)
    throw new LogsError('lease_stale', 409, 'This decode attempt no longer holds the log.');
  return { sha256, attemptToken };
}

const iso = value => typeof value === 'string' && value.length <= 40 && !Number.isNaN(Date.parse(value));
const SUMMARY_RULES = {
  display_name: value => typeof value === 'string' && value.length <= 300,
  started_at: iso, ended_at: iso,
  duration_seconds: value => Number.isFinite(value) && value >= 0 && value < 7 * 86400,
  distance_m: value => Number.isFinite(value) && value >= 0 && value < 1e7,
  max_altitude_m: value => Number.isFinite(value) && value > -1000 && value < 1e5,
  max_speed_mps: value => Number.isFinite(value) && value >= 0 && value < 1000,
  home_lat: value => Number.isFinite(value) && value >= -90 && value <= 90,
  home_lon: value => Number.isFinite(value) && value >= -180 && value <= 180,
  photo_count: value => Number.isInteger(value) && value >= 0 && value < 1e6,
  video_count: value => Number.isInteger(value) && value >= 0 && value < 1e6,
  telemetry_points: value => Number.isInteger(value) && value >= 0 && value < 1e8,
};

/** The flight summary the runner reports: only known fields, each checked. Never trusted as-is. */
export function checkSummary(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) throw new LogsError('summary_invalid', 400, 'Invalid flight summary.');
  const summary = {};
  for (const [field, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(SUMMARY_RULES, field) ? SUMMARY_RULES[field] : null;
    if (!rule) throw new LogsError('summary_invalid', 400, 'Invalid flight summary.');
    if (value == null) continue;
    if (!rule(value)) throw new LogsError('summary_invalid', 400, 'Invalid flight summary.');
    summary[field] = value;
  }
  return summary;
}

function summaryHeader(request) {
  const header = request.headers.get('X-Decode-Summary') ?? '';
  if (!header || header.length > SUMMARY_HEADER_LIMIT || !/^[A-Za-z0-9_-]+$/.test(header)) throw new LogsError('summary_invalid', 400, 'Invalid flight summary.');
  try {
    const binary = atob(header.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (header.length % 4)) % 4));
    return checkSummary(JSON.parse(new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)))));
  } catch (error) {
    if (error instanceof LogsError) throw error;
    throw new LogsError('summary_invalid', 400, 'Invalid flight summary.');
  }
}

async function heldRawLog(env, lease, now = Date.now()) {
  const row = await env.LOGS_DB.prepare(`SELECT sha256, r2_key FROM raw_logs
    WHERE sha256 = ?1 AND attempt_token = ?2 AND parse_status = 'leased' AND lease_expires_at > ?3`).bind(lease.sha256, lease.attemptToken, new Date(now).toISOString()).first();
  if (!row) throw new LogsError('lease_stale', 409, 'This decode attempt no longer holds the log.');
  return row;
}

/** Returns a Response for /api/v1/decoder/* when the decoder is enabled, or null (so the caller answers 404). */
export async function handleDecoderRequest(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(PREFIX) || !decoderEnabled(env)) return null;
  const route = `${request.method} ${path}`;
  const known = ['POST /api/v1/decoder/lease', 'POST /api/v1/decoder/raw', 'POST /api/v1/decoder/complete', 'POST /api/v1/decoder/retry', 'POST /api/v1/decoder/fail'];
  if (!known.includes(route)) return null;
  try {
    if (!(await authorized(request, env))) { await request.body?.cancel('unauthorized').catch(() => {}); return json({ error: 'unauthorized' }, 401); }

    if (route === 'POST /api/v1/decoder/lease') {
      const body = await readSmallJson(request);
      const leases = await decode.leaseRawLogs(env, { limit: Number(body.limit) || 1 });
      // Only what the runner needs: no pilot, device or storage key leaves the Worker.
      return json({ leases: leases.map(lease => ({ sha256: lease.sha256, attemptToken: lease.attemptToken, leaseExpiresAt: lease.leaseExpiresAt, attempt: lease.attempt })) });
    }

    if (route === 'POST /api/v1/decoder/raw') {
      const body = await readSmallJson(request);
      const row = await heldRawLog(env, leaseFrom(body.sha256, body.attemptToken));
      const object = await env.LOGS_BUCKET.get(row.r2_key);
      if (!object) return json({ error: 'raw_missing' }, 404);
      return new Response(object.body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Sha256': row.sha256 } });
    }

    if (route === 'POST /api/v1/decoder/complete') {
      const lease = leaseFrom(request.headers.get('X-Lease-Sha256'), request.headers.get('X-Attempt-Token'));
      const contentSha256 = request.headers.get('X-Content-Sha256');
      // Checked before anything is stored, so a wrong report leaves no object behind.
      if (contentSha256 !== lease.sha256) throw new LogsError('hash_mismatch', 409, 'The decoded bytes don’t match this raw log.');
      const summary = summaryHeader(request);
      await heldRawLog(env, lease);
      const track = await readLimited(request, TRACK_LIMIT);
      if (track.byteLength < 18 || track[0] !== 0x1f || track[1] !== 0x8b) throw new LogsError('telemetry_not_gzip', 400, 'Flight tracks must be sent compressed.');
      // One key per raw log, so a repeated report overwrites rather than leaving orphan objects.
      const telemetryKey = `telemetry/v1/raw-${lease.sha256}.json.gz`;
      await env.LOGS_BUCKET.put(telemetryKey, track, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { rawSha256: lease.sha256 } });
      return json(await decode.completeDecode(env, lease, { contentSha256, flightId: crypto.randomUUID(), summary, telemetryKey }));
    }

    const body = await readSmallJson(request);
    const lease = leaseFrom(body.sha256, body.attemptToken);
    if (route === 'POST /api/v1/decoder/retry') return json(await decode.retryDecode(env, lease, body.errorCode));
    return json(await decode.failDecode(env, lease, body.errorCode));
  } catch (error) {
    if (error instanceof LogsError) return json({ error: error.code }, error.status);
    console.error('decoder-route', error?.message);
    return json({ error: 'internal_error' }, 500);
  }
}
