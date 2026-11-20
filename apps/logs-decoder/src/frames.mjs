// Maps dji-log-parser output ({ version, details, frames }, camelCase, from `dji-log <file>` at v0.5.7) to the
// Ledge Top track (ltds.logs.telemetry.v1, the same column names ODL imports use) and the flight summary the
// Logs Worker accepts. Pure functions: nothing here reads files, keys or the network.

export const TRACK_SCHEMA = 'ltds.logs.telemetry.v1';
import { LIMITS } from './limits.mjs';
// The same limit Logs enforces on stored tracks (decoder-service.mjs). A longer log is suspended for review, never cut short.
export const MAX_TRACK_ROWS = LIMITS.trackRows;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = value => (typeof value === 'boolean' ? value : null);
const round = (value, places) => (value == null ? null : Math.round(value * 10 ** places) / 10 ** places);
// DJI logs use 0,0 (and out-of-range values) for "no fix yet".
const position = (lat, lon) => {
  const la = num(lat), lo = num(lon);
  return la != null && lo != null && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0) ? [la, lo] : [null, null];
};
// A date is plausible when it is on or after 2013-01-01 (before any DJI flight log we can read) and no more than one
// day after the decode runs (clock skew margin). Anything else is never emitted.
const EARLIEST_LOG = Date.UTC(2013, 0, 1);
const DAY_MS = 86_400_000;
const plausibleTime = (value, now) => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms >= EARLIEST_LOG && ms <= now + DAY_MS ? ms : null;
};

// Some firmware (seen on a Matrice 4E, DJI Pilot 2 19.1, parser 0.5.7) garbles the per-frame clock in most frames:
// random years from 1970 to 2099, each held for a run of frames. A real clock stamp minus the frame's flight time
// gives the log's start. The real clock is also "sticky" (it updates every few seconds and holds in between), so a
// stamp is never ahead of true time and the freshest estimate is the latest one. Garbled runs are single held
// values, so a start is trusted only when at least two DIFFERENT stamps agree on it within CLOCK_AGREEMENT_MS.
const CLOCK_AGREEMENT_MS = 30_000;
function startFromFrameClock(frames, now) {
  const candidates = [];
  for (const frame of frames) {
    const ms = plausibleTime(frame?.custom?.dateTime, now), flyTime = num(frame?.osd?.flyTime);
    if (ms != null && flyTime != null && flyTime >= 0) candidates.push({ stamp: ms, start: ms - flyTime * 1000 });
  }
  candidates.sort((a, b) => a.start - b.start);
  // Sliding window over the sorted starts, counting distinct stamps in it (linear time).
  let best = null;
  const inWindow = new Map();
  for (let lo = 0, hi = 0; hi < candidates.length; hi++) {
    inWindow.set(candidates[hi].stamp, (inWindow.get(candidates[hi].stamp) ?? 0) + 1);
    while (candidates[hi].start - candidates[lo].start > CLOCK_AGREEMENT_MS) {
      const left = inWindow.get(candidates[lo].stamp) - 1;
      if (left) inWindow.set(candidates[lo].stamp, left); else inWindow.delete(candidates[lo].stamp);
      lo++;
    }
    if (inWindow.size >= 2 && (!best || inWindow.size > best.distinct)) best = { distinct: inWindow.size, from: candidates[lo].start };
  }
  if (!best) return null;
  // The freshest (latest) start that agrees with the winning window.
  let start = best.from;
  for (const { start: s } of candidates) if (s > start && s - best.from <= CLOCK_AGREEMENT_MS) start = s;
  return start >= EARLIEST_LOG ? start : null;
}

const R_EARTH_M = 6_371_008.8, RAD = Math.PI / 180;
const haversine = ([lat1, lon1], [lat2, lon2]) => {
  const h = Math.sin((lat2 - lat1) * RAD / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin((lon2 - lon1) * RAD / 2) ** 2;
  return 2 * R_EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
};
// A step faster than this between consecutive fixes is a position glitch, not flight (no DJI aircraft we fly
// reaches it). Steps with no usable flight time between them are judged against MAX_UNTIMED_STEP_M instead.
const MAX_STEP_SPEED_MPS = 60, MAX_UNTIMED_STEP_M = 10;
/** Path length over the valid position fixes, in metres; null without at least two fixes. */
function pathLength(frames) {
  let total = 0, previous = null, previousTime = null, steps = 0;
  for (const frame of frames) {
    const fix = position(frame?.osd?.latitude, frame?.osd?.longitude);
    if (fix[0] == null) continue;
    const time = num(frame?.osd?.flyTime);
    if (previous) {
      const step = haversine(previous, fix), dt = time != null && previousTime != null ? time - previousTime : null;
      const glitch = dt != null && dt > 0 ? step / dt > MAX_STEP_SPEED_MPS : step > MAX_UNTIMED_STEP_M;
      if (!glitch) { total += step; steps++; }
    }
    previous = fix; previousTime = time;
  }
  return steps ? total : null;
}

// The header photo count (capture_num, written by the app) is exact when present; DJI Fly leaves it at 0. The
// per-frame single-photo flag misses mission captures entirely, so it is only a fallback, and a flag that
// re-asserts within FLAG_MERGE_S is the same shot. Neither is trusted beyond MAX_PHOTOS_PER_S of flight.
const FLAG_MERGE_S = 1.5, MAX_PHOTOS_PER_S = 20;
function photoCount(details, frames, durationSeconds) {
  const ceiling = durationSeconds != null ? Math.max(1, durationSeconds) * MAX_PHOTOS_PER_S : 1e6;
  const header = details.photoNum;
  if (Number.isInteger(header) && header > 0 && header < 1e6 && header <= ceiling) return { count: header, source: 'log_header' };
  let shots = 0, on = false, lastShot = null;
  for (let i = 0; i < frames.length; i++) {
    const flag = frames[i]?.camera?.isPhoto === true, time = num(frames[i]?.osd?.flyTime) ?? i / 10;
    if (flag && !on && (lastShot == null || time - lastShot > FLAG_MERGE_S)) shots++;
    if (flag) lastShot = time;
    on = flag;
  }
  if (shots > 0 && shots <= ceiling) return { count: shots, source: 'camera_flag' };
  return { count: null, source: 'unknown' };
}

const label = (value, max) => {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
  return text || null;
};
/** The aircraft model: the parser's product type when it knows it, else the aircraft name the app wrote. */
function aircraftModel(output) {
  const product = label(output.header?.productType, 60);
  if (product && !/^unknown/i.test(product)) return product;
  return label(output.details?.aircraftName, 60);
}

/** Column name -> how to read it from one frame. Only columns dji-log-parser actually provides. */
const COLUMNS = [
  ['offsetMs', f => { const t = num(f.osd?.flyTime); return t == null ? null : Math.round(t * 1000); }],
  ['latitude', f => position(f.osd?.latitude, f.osd?.longitude)[0]],
  ['longitude', f => position(f.osd?.latitude, f.osd?.longitude)[1]],
  ['heightMeters', f => round(num(f.osd?.height), 2)],
  ['vpsHeightMeters', f => round(num(f.osd?.vpsHeight), 2)],
  ['altitudeAbsMeters', f => round(num(f.osd?.altitude), 2)],
  ['speedMetersPerSecond', f => { const x = num(f.osd?.xSpeed), y = num(f.osd?.ySpeed); return x == null || y == null ? null : round(Math.hypot(x, y), 2); }],
  ['velocityX', f => round(num(f.osd?.xSpeed), 2)],
  ['velocityY', f => round(num(f.osd?.ySpeed), 2)],
  ['velocityZ', f => round(num(f.osd?.zSpeed), 2)],
  ['pitch', f => round(num(f.osd?.pitch), 1)],
  ['roll', f => round(num(f.osd?.roll), 1)],
  ['yaw', f => round(num(f.osd?.yaw), 1)],
  ['gimbalPitch', f => round(num(f.gimbal?.pitch), 1)],
  ['gimbalRoll', f => round(num(f.gimbal?.roll), 1)],
  ['gimbalYaw', f => round(num(f.gimbal?.yaw), 1)],
  ['batteryPercent', f => num(f.battery?.chargeLevel)],
  ['batteryVoltage', f => round(num(f.battery?.voltage), 3)],
  ['batteryCurrent', f => round(num(f.battery?.current), 3)],
  ['batteryTemperatureC', f => round(num(f.battery?.temperature), 1)],
  ['batteryFullCapacity', f => num(f.battery?.fullCapacity)],
  ['batteryRemainingCapacity', f => num(f.battery?.currentCapacity)],
  ['satellites', f => num(f.osd?.gpsNum)],
  ['gpsSignal', f => num(f.osd?.gpsLevel)],
  ['flightMode', f => (typeof f.osd?.flycState === 'string' ? f.osd.flycState.slice(0, 40) : null)],
  ['isPhoto', f => bool(f.camera?.isPhoto)],
  ['isVideo', f => bool(f.camera?.isVideo)],
];

export class DecodeOutputError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/**
 * Track columns plus the flight summary for one decoded log. Throws DecodeOutputError('corrupt_log') when unusable.
 * `now` (ms) bounds plausible dates; it defaults to the current time.
 */
export function toFlight(output, { now = Date.now() } = {}) {
  const frames = Array.isArray(output?.frames) ? output.frames : null;
  if (!frames) throw new DecodeOutputError('corrupt_log', 'The parser output has no frames.');
  if (!frames.length) throw new DecodeOutputError('corrupt_log', 'The log has no flight frames.');
  if (frames.length > MAX_TRACK_ROWS) throw new DecodeOutputError('log_too_large', 'The log has more frames than a stored track can hold.');

  const columns = Object.fromEntries(COLUMNS.map(([name]) => [name, new Array(frames.length)]));
  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i] ?? {};
    for (const [name, read] of COLUMNS) columns[name][i] = read(frame);
  }
  // Drop columns this log never filled, so the track stays small and the charts only show real data.
  for (const [name] of COLUMNS) if (name !== 'offsetMs' && columns[name].every(value => value == null)) delete columns[name];
  const track = { schema: TRACK_SCHEMA, rowCount: frames.length, columns };

  const details = output.details ?? {};
  const firstFix = frames.map(frame => position(frame?.osd?.latitude, frame?.osd?.longitude)).find(([lat]) => lat != null) ?? [null, null];
  const homeRecord = frames.map(frame => position(frame?.home?.latitude, frame?.home?.longitude)).find(([lat]) => lat != null);
  const [homeLat, homeLon] = homeRecord ?? firstFix;
  let videos = 0, recording = false;
  for (const frame of frames) { const on = frame?.camera?.isVideo === true; if (on && !recording) videos++; recording = on; }
  const lastFlyTime = [...frames].reverse().map(frame => num(frame?.osd?.flyTime)).find(t => t != null);
  const nonNegative = value => (value != null && value >= 0 ? value : null);
  // Duration: the header's total time, else the last frame's flight time.
  const duration = nonNegative(num(details.totalTime)) ?? nonNegative(lastFlyTime);
  // Start: the header's start time (written by the wrapper from the log header), else the frame clock when two
  // different stamps agree. End = start + duration. A date outside the plausible window is never emitted.
  const headerStart = plausibleTime(output.header?.startTime, now);
  const [start, startSource] = headerStart != null ? [headerStart, 'log_header']
    : (frameStart => (frameStart != null ? [frameStart, 'frame_clock'] : [null, null]))(startFromFrameClock(frames, now));
  const end = start != null && duration != null ? start + duration * 1000 : null;
  const timesOk = start != null && (end == null || end <= now + DAY_MS);
  // Distance: the path over the position fixes. The header's totalDistance is not used: its unit differs by log
  // version (kilometres on v14 Matrice 4E logs, so a 11.7 km flight read as 11.7 m).
  const distance = pathLength(frames);
  const photos = photoCount(details, frames, duration);
  const appParts = [label(details.appPlatform, 20), label(details.appVersion, 20)].filter(Boolean);

  const summary = {
    started_at: timesOk ? new Date(start).toISOString() : null,
    ended_at: timesOk && end != null ? new Date(end).toISOString() : null,
    started_at_source: timesOk ? startSource : null,
    duration_seconds: round(duration, 1),
    distance_m: round(distance, 1),
    max_altitude_m: round(num(details.maxHeight), 1),
    max_speed_mps: round(nonNegative(num(details.maxHorizontalSpeed)), 2),
    home_lat: homeLat,
    home_lon: homeLon,
    photo_count: photos.count,
    photo_count_source: photos.source,
    video_count: videos,
    telemetry_points: frames.length,
    aircraft_model: aircraftModel(output),
    app: appParts.length ? appParts.join(' ') : null,
  };
  for (const key of Object.keys(summary)) if (summary[key] == null) delete summary[key];
  return { track, summary };
}
