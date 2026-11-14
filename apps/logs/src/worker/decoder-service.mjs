// The parser-only side of Logs (DECODER.md). Exposed ONLY as the named RPC entrypoint DecoderService (index.mjs),
// reached through a private service binding from the Ops machine bridge; never through Logs' public fetch, which
// stays device API + /health. Nothing here takes a staff actor, a pilot, a URL or a storage key from the caller.
import { LogsError } from './errors.mjs';
import * as decode from './decode-contract.mjs';
import { TELEMETRY_COLUMNS } from '../odl/map.mjs';

// Identical limits in every layer (runner, Ops bridge, here). See DECODER.md.
export const DECODER_LIMITS = Object.freeze({ trackGzipBytes: 8 * 1024 * 1024, trackJsonBytes: 32 * 1024 * 1024, trackRows: 100_000, summaryBytes: 4096 });
export const TRACK_SCHEMA = 'ltds.logs.telemetry.v1';
const TRACK_COLUMNS = new Set(TELEMETRY_COLUMNS.map(([name]) => name));
const STRING_COLUMNS = new Set(['flightMode']);

export function decoderEnabled(env) { return env?.DECODER_ENABLED === 'true'; }

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
  telemetry_points: value => Number.isInteger(value) && value >= 0 && value <= DECODER_LIMITS.trackRows,
};
const invalidSummary = () => new LogsError('summary_invalid', 400, 'Invalid flight summary.');

/** Only known fields, each type- and range-checked; nulls dropped. Never trusted as-is. */
export function checkSummary(raw) {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype) throw invalidSummary();
  if (JSON.stringify(raw).length > DECODER_LIMITS.summaryBytes) throw invalidSummary();
  const summary = {};
  for (const [field, value] of Object.entries(raw)) {
    const rule = Object.hasOwn(SUMMARY_RULES, field) ? SUMMARY_RULES[field] : null;
    if (!rule) throw invalidSummary();
    if (value == null) continue;
    if (!rule(value)) throw invalidSummary();
    summary[field] = value;
  }
  if (summary.started_at && summary.ended_at && Date.parse(summary.ended_at) < Date.parse(summary.started_at)) throw invalidSummary();
  return summary;
}

const invalidTrack = () => new LogsError('track_invalid', 400, 'The flight track is not in the expected format.');

async function gunzipBounded(bytes, limit) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel().catch(() => {}); throw new LogsError('track_too_large', 413, 'The flight track is too large to store.'); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof LogsError) throw error;
    throw invalidTrack();
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

/** Checks a gzip track fully: sizes, schema, known columns, one value per row, value types. Returns its row count. */
export async function checkTrack(bytes) {
  if (!(bytes instanceof Uint8Array)) throw invalidTrack();
  if (bytes.byteLength > DECODER_LIMITS.trackGzipBytes) throw new LogsError('track_too_large', 413, 'The flight track is too large to store.');
  if (bytes.byteLength < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new LogsError('telemetry_not_gzip', 400, 'Flight tracks must be sent compressed.');
  let track;
  try { track = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await gunzipBounded(bytes, DECODER_LIMITS.trackJsonBytes))); }
  catch (error) { if (error instanceof LogsError) throw error; throw invalidTrack(); }
  if (!track || typeof track !== 'object' || Array.isArray(track) || track.schema !== TRACK_SCHEMA) throw invalidTrack();
  const { rowCount, columns } = track;
  if (!Number.isInteger(rowCount) || rowCount < 1 || rowCount > DECODER_LIMITS.trackRows) throw invalidTrack();
  if (!columns || typeof columns !== 'object' || Array.isArray(columns) || !Array.isArray(columns.offsetMs)) throw invalidTrack();
  for (const [name, values] of Object.entries(columns)) {
    if (!TRACK_COLUMNS.has(name) || !Array.isArray(values) || values.length !== rowCount) throw invalidTrack();
    const stringy = STRING_COLUMNS.has(name);
    for (const value of values)
      if (!(value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) || (stringy && typeof value === 'string' && value.length <= 40))) throw invalidTrack();
  }
  return rowCount;
}

async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}
const canonical = value => JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])));

/**
 * Store and commit one decoded result. The track goes to an immutable key unique to this attempt and these bytes,
 * so a stale attempt can never overwrite the winner's track; only the fenced commit references a key. Replays of a
 * committed attempt return the original receipt without writing anything.
 */
export async function completeWithTrack(env, lease, { contentSha256, summary: rawSummary, track, decoderVersion }) {
  if (!lease || contentSha256 !== lease.sha256) throw new LogsError('hash_mismatch', 409, 'The decoded bytes don’t match this raw log.');
  const summary = checkSummary(rawSummary);
  const bytes = track instanceof Uint8Array ? track : track instanceof ArrayBuffer ? new Uint8Array(track) : null;
  const rows = await checkTrack(bytes);
  if (summary.telemetry_points != null && summary.telemetry_points !== rows) throw invalidSummary();
  const trackSha = await sha256Hex(bytes);
  const fingerprint = await sha256Hex(`${canonical(summary)}\n${trackSha}\n${decoderVersion}`);

  const state = await env.LOGS_DB.prepare('SELECT parse_status FROM raw_logs WHERE sha256 = ?1').bind(lease.sha256).first();
  if (state?.parse_status === 'decoded') return decode.completeDecode(env, lease, { contentSha256, flightId: crypto.randomUUID(), summary, fingerprint, decoderVersion });
  await decode.heldRawLog(env, lease);
  const telemetryKey = `telemetry/v1/raw-${lease.sha256}/${(await sha256Hex(lease.attemptToken)).slice(0, 16)}-${trackSha.slice(0, 16)}.json.gz`;
  if (!(await env.LOGS_BUCKET.head(telemetryKey)))
    await env.LOGS_BUCKET.put(telemetryKey, bytes, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' },
      customMetadata: { rawSha256: lease.sha256, decoderVersion, schema: TRACK_SCHEMA } });
  return decode.completeDecode(env, lease, { contentSha256, flightId: crypto.randomUUID(), summary, telemetryKey, fingerprint, decoderVersion });
}

/** The held raw log's bytes as a stream, for the exact active attempt only. */
export async function readRaw(env, lease) {
  const row = await decode.heldRawLog(env, lease);
  const object = await env.LOGS_BUCKET.get(row.r2_key);
  if (!object) throw new LogsError('raw_missing', 404, 'The stored log could not be read.');
  return { sha256: row.sha256, size: row.size_bytes, body: object.body };
}
