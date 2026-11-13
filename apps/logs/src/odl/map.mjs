// Maps OpenDroneLog rows to Ledge Top flight-log records (contract ltds.logs.odl-import.v1).
// Units are ODL's own: metres, metres per second, seconds, UTC timestamps.
import { toIso } from './util.mjs';

import { IMPORT_SCHEMA } from './contract.mjs';
export { IMPORT_SCHEMA };
const MESSAGE_LEVELS = new Set(['tip', 'caution', 'warn']);

const clean = value => {
  if (value == null) return null;
  const text = String(value).trim();
  return text && text !== 'None' && text !== 'null' ? text : null;
};
const number = value => {
  if (value == null) return null;
  const result = typeof value === 'bigint' ? Number(value) : Number(value);
  return Number.isFinite(result) ? result : null;
};
const count = value => { const result = number(value); return result == null ? null : Math.max(0, Math.round(result)); };
const id = value => (value == null ? null : String(value));

/** The pilot every flight in one backup is attributed to. ODL has no pilot field, so this is always explicit. */
export function pilotFor(pilot) {
  if (!pilot?.id || typeof pilot.id !== 'string') throw new TypeError('An explicit pilot id is required: each OpenDroneLog backup belongs to one pilot account.');
  return { id: pilot.id, attribution: 'backup_owner' };
}

export function mapFlight(row, { pilot, keychainHashes = new Set(), customization = null, tags = [] }) {
  const latitude = number(row.home_lat), longitude = number(row.home_lon);
  const home = latitude == null || longitude == null || (latitude === 0 && longitude === 0) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180
    ? null : { latitude, longitude };
  const fileHash = clean(row.file_hash);
  return {
    schema: IMPORT_SCHEMA,
    source: { system: 'opendronelog', flightId: id(row.id), fileHash, fileName: clean(row.file_name), importedAtSource: toIso(row.imported_at) },
    pilot: pilotFor(pilot),
    visibility: 'staff', // flight logs are never shown to clients
    displayName: clean(customization?.display_name) ?? clean(row.display_name),
    startedAt: toIso(row.start_time),
    endedAt: toIso(row.end_time),
    durationSeconds: number(row.duration_secs),
    distanceMeters: number(row.total_distance),
    maxAltitudeMeters: number(row.max_altitude),
    maxSpeedMetersPerSecond: number(row.max_speed),
    home,
    aircraft: { serial: clean(row.drone_serial), model: clean(row.drone_model), name: clean(row.aircraft_name) },
    batterySerial: clean(row.battery_serial),
    controllerSerial: clean(row.rc_serial),
    battery: { cycleCount: count(row.cycle_count), lifePercent: count(row.battery_life) },
    media: { photos: count(row.photo_count) ?? 0, videos: count(row.video_count) ?? 0 },
    telemetryPointCount: count(row.point_count) ?? 0,
    notes: clean(customization?.notes) ?? clean(row.notes),
    color: clean(customization?.color) ?? clean(row.color),
    tags,
    rawLog: { status: 'missing', keychainAvailable: fileHash ? keychainHashes.has(fileHash) : false },
  };
}

export function mapTag(row) {
  const tag = clean(row.tag);
  return tag ? { tag, kind: clean(row.tag_type) === 'manual' ? 'manual' : 'auto' } : null;
}

/** ODL stores manual tags from customizations as text; accept JSON arrays or comma-separated lists. */
export function manualTags(value) {
  const text = clean(value);
  if (!text) return [];
  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed.map(clean).filter(Boolean); } catch { /* fall through */ }
  return text.split(',').map(clean).filter(Boolean);
}

export function mapMessage(row) {
  const text = clean(row.message);
  if (!text) return null;
  const level = clean(row.message_type)?.toLowerCase();
  return { sourceFlightId: id(row.flight_id), offsetMs: number(row.timestamp_ms), level: MESSAGE_LEVELS.has(level) ? level : 'tip', text };
}

/** [ledge-top name, ODL column]. Telemetry offsets are milliseconds from the flight start. */
export const TELEMETRY_COLUMNS = [
  ['offsetMs', 'timestamp_ms'], ['latitude', 'latitude'], ['longitude', 'longitude'],
  ['altitudeMeters', 'altitude'], ['heightMeters', 'height'], ['vpsHeightMeters', 'vps_height'], ['altitudeAbsMeters', 'altitude_abs'],
  ['speedMetersPerSecond', 'speed'], ['velocityX', 'velocity_x'], ['velocityY', 'velocity_y'], ['velocityZ', 'velocity_z'],
  ['pitch', 'pitch'], ['roll', 'roll'], ['yaw', 'yaw'], ['gimbalPitch', 'gimbal_pitch'], ['gimbalRoll', 'gimbal_roll'], ['gimbalYaw', 'gimbal_yaw'],
  ['batteryPercent', 'battery_percent'], ['batteryVoltage', 'battery_voltage'], ['batteryCurrent', 'battery_current'],
  ['batteryTemperatureC', 'battery_temp'], ['cellVoltages', 'cell_voltages'], ['batteryFullCapacity', 'battery_full_capacity'],
  ['batteryRemainingCapacity', 'battery_remained_capacity'], ['flightMode', 'flight_mode'], ['gpsSignal', 'gps_signal'],
  ['satellites', 'satellites'], ['rcSignal', 'rc_signal'], ['rcUplink', 'rc_uplink'], ['rcDownlink', 'rc_downlink'],
  ['stickAileron', 'rc_aileron'], ['stickElevator', 'rc_elevator'], ['stickThrottle', 'rc_throttle'], ['stickRudder', 'rc_rudder'],
  ['isPhoto', 'is_photo'], ['isVideo', 'is_video'],
];
const TEXT_TELEMETRY = new Set(['cellVoltages', 'flightMode']), FLAG_TELEMETRY = new Set(['isPhoto', 'isVideo']);

export function telemetryValue(name, value) {
  if (value == null) return null;
  if (TEXT_TELEMETRY.has(name)) return clean(value);
  if (FLAG_TELEMETRY.has(name)) return Boolean(value);
  return number(value);
}
