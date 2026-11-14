// Maps dji-log-parser output ({ version, details, frames }, camelCase, from `dji-log <file>` at v0.5.7) to the
// Ledge Top track (ltds.logs.telemetry.v1, the same column names ODL imports use) and the flight summary the
// Logs Worker accepts. Pure functions: nothing here reads files, keys or the network.

export const TRACK_SCHEMA = 'ltds.logs.telemetry.v1';
// The same limit Logs enforces on stored tracks (decoder-service.mjs). A longer log is refused, never cut short.
export const MAX_TRACK_ROWS = 100_000;

const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const bool = value => (typeof value === 'boolean' ? value : null);
const round = (value, places) => (value == null ? null : Math.round(value * 10 ** places) / 10 ** places);
// DJI logs use 0,0 (and out-of-range values) for "no fix yet".
const position = (lat, lon) => {
  const la = num(lat), lo = num(lon);
  return la != null && lo != null && Math.abs(la) <= 90 && Math.abs(lo) <= 180 && !(la === 0 && lo === 0) ? [la, lo] : [null, null];
};
const validTime = value => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) && ms > Date.UTC(2010, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
};

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

/** Track columns plus the flight summary for one decoded log. Throws DecodeOutputError('corrupt_log') when unusable. */
export function toFlight(output) {
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
  const times = frames.map(frame => validTime(frame?.custom?.dateTime)).filter(ms => ms != null);
  const firstFix = frames.map(frame => position(frame?.osd?.latitude, frame?.osd?.longitude)).find(([lat]) => lat != null) ?? [null, null];
  const homeRecord = frames.map(frame => position(frame?.home?.latitude, frame?.home?.longitude)).find(([lat]) => lat != null);
  const [homeLat, homeLon] = homeRecord ?? firstFix;
  let videos = 0, recording = false;
  for (const frame of frames) { const on = frame?.camera?.isVideo === true; if (on && !recording) videos++; recording = on; }
  const lastFlyTime = [...frames].reverse().map(frame => num(frame?.osd?.flyTime)).find(t => t != null);
  const nonNegative = value => (value != null && value >= 0 ? value : null);
  const count = value => (Number.isInteger(value) && value >= 0 ? value : null);

  const summary = {
    started_at: times.length ? new Date(times.reduce((a, b) => Math.min(a, b))).toISOString() : null,
    ended_at: times.length ? new Date(times.reduce((a, b) => Math.max(a, b))).toISOString() : null,
    duration_seconds: round(nonNegative(num(details.totalTime)) ?? nonNegative(lastFlyTime), 1),
    distance_m: round(nonNegative(num(details.totalDistance)), 1),
    max_altitude_m: round(num(details.maxHeight), 1),
    max_speed_mps: round(nonNegative(num(details.maxHorizontalSpeed)), 2),
    home_lat: homeLat,
    home_lon: homeLon,
    photo_count: count(details.photoNum),
    video_count: videos,
    telemetry_points: frames.length,
  };
  for (const key of Object.keys(summary)) if (summary[key] == null) delete summary[key];
  return { track, summary };
}
