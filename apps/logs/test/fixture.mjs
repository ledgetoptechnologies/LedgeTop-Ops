// Builds small synthetic OpenDroneLog backups for tests. No real flight data is used.
import { gzipSync } from 'node:zlib';
import { parquetWriteBuffer } from 'hyparquet-writer';

const T0 = Date.parse('2026-05-01T14:00:00Z');
export const SECRET_KEY = 'SYNTHETIC-KEYCHAIN-VALUE-DO-NOT-PRINT';

function column(name, data, type) { return { name, data, type }; }

export function flightsTable(flights) {
  const pick = key => flights.map(flight => flight[key] ?? null);
  return parquetWriteBuffer({ columnData: [
    column('id', pick('id').map(BigInt), 'INT64'),
    column('file_name', pick('file_name'), 'STRING'), column('display_name', pick('display_name'), 'STRING'),
    column('file_hash', pick('file_hash'), 'STRING'), column('drone_model', pick('drone_model'), 'STRING'),
    column('drone_serial', pick('drone_serial'), 'STRING'), column('aircraft_name', pick('aircraft_name'), 'STRING'),
    column('battery_serial', pick('battery_serial'), 'STRING'),
    column('start_time', pick('start'), 'TIMESTAMP'), column('end_time', pick('end'), 'TIMESTAMP'),
    column('duration_secs', pick('duration'), 'DOUBLE'), column('total_distance', pick('distance'), 'DOUBLE'),
    column('max_altitude', pick('max_altitude'), 'DOUBLE'), column('max_speed', pick('max_speed'), 'DOUBLE'),
    column('home_lat', pick('home_lat'), 'DOUBLE'), column('home_lon', pick('home_lon'), 'DOUBLE'),
    column('point_count', pick('point_count'), 'INT32'), column('photo_count', pick('photos'), 'INT32'), column('video_count', pick('videos'), 'INT32'),
    column('imported_at', pick('start'), 'TIMESTAMP'), column('notes', pick('notes'), 'STRING'), column('color', pick('color'), 'STRING'),
    column('cycle_count', pick('cycle_count'), 'INT32'), column('rc_serial', pick('rc_serial'), 'STRING'), column('battery_life', pick('battery_life'), 'INT32'),
  ] });
}

export function telemetryTable(samples) {
  const pick = key => samples.map(sample => sample[key] ?? null);
  return parquetWriteBuffer({ rowGroupSize: 3, columnData: [
    column('flight_id', pick('flight_id').map(BigInt), 'INT64'), column('timestamp_ms', pick('t').map(BigInt), 'INT64'),
    column('latitude', pick('lat'), 'DOUBLE'), column('longitude', pick('lon'), 'DOUBLE'),
    column('altitude', pick('alt'), 'FLOAT'), column('height', pick('alt'), 'FLOAT'), column('speed', pick('speed'), 'FLOAT'),
    column('pitch', pick('speed'), 'FLOAT'), column('roll', pick('speed'), 'FLOAT'), column('yaw', pick('speed'), 'FLOAT'),
    column('battery_percent', pick('battery'), 'INT32'), column('battery_voltage', pick('speed'), 'FLOAT'),
    column('cell_voltages', pick('cells'), 'STRING'), column('is_photo', pick('photo'), 'BOOLEAN'),
  ] });
}

const tableOf = (columns, rows) => parquetWriteBuffer({ columnData: columns.map(([name, type]) => column(name, rows.map(row => row[name] ?? null), type)) });

export function tar(files) {
  const blocks = [];
  for (const [name, data] of Object.entries(files)) {
    const bytes = new Uint8Array(data), header = new Uint8Array(512), encode = (text, at) => header.set(new TextEncoder().encode(text), at);
    encode(name, 0); encode('0000644\0', 100); encode('0000000\0', 108); encode('0000000\0', 116);
    encode(`${bytes.length.toString(8).padStart(11, '0')}\0`, 124); encode('00000000000\0', 136); encode('0', 156); encode('ustar\0', 257); encode('00', 263);
    encode('        ', 148);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    encode(`${checksum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((sum, block) => sum + block.length, 0));
  let offset = 0;
  for (const block of blocks) { out.set(block, offset); offset += block.length; }
  return out;
}

export const FLIGHTS = [
  { id: 101, file_name: 'DJIFlightRecord_2026-05-01_[14-00-00].txt', display_name: 'Roof survey', file_hash: 'hash-a', drone_model: 'Matrice30', drone_serial: 'AIRCRAFT0001',
    aircraft_name: 'M30T', battery_serial: 'BATTERY0001', start: new Date(T0), end: new Date(T0 + 600_000), duration: 600, distance: 1200.5, max_altitude: 60, max_speed: 12,
    home_lat: 43.1, home_lon: -88.9, point_count: 3, photos: 4, videos: 0, color: '#ee5007', cycle_count: 20, rc_serial: 'RC0001', battery_life: 95 },
  { id: 102, file_name: 'DJIFlightRecord_2026-05-02_[09-00-00].txt', display_name: 'Inspection', file_hash: 'hash-b', drone_model: null, drone_serial: 'AIRCRAFT0001',
    aircraft_name: 'M30T', battery_serial: 'BATTERY0002', start: new Date(T0 + 86_400_000), end: new Date(T0 + 86_400_000 + 300_000), duration: 300, distance: 400, max_altitude: 30, max_speed: 8,
    home_lat: 0, home_lon: 0, point_count: 2, photos: 0, videos: 1, color: '#ee5007', cycle_count: null, rc_serial: null, battery_life: null },
  { id: 103, file_name: 'DJIFlightRecord_2026-05-03_[10-00-00].txt', display_name: 'Duplicate of first', file_hash: 'hash-a', drone_model: 'Mini4Pro', drone_serial: 'AIRCRAFT0002',
    aircraft_name: 'Mini', battery_serial: 'BATTERY0003', start: new Date(T0 + 2 * 86_400_000), end: new Date(T0 + 2 * 86_400_000 + 60_000), duration: 60, distance: 10, max_altitude: 5, max_speed: 2,
    home_lat: 43.2, home_lon: -88.8, point_count: 1, photos: 0, videos: 0, color: '#ee5007' },
];

export const TELEMETRY = [
  { flight_id: 101, t: 0, lat: 43.1, lon: -88.9, alt: 0, speed: 0, battery: 100, cells: '[4.2,4.2]', photo: false },
  { flight_id: 101, t: 100, lat: 43.1001, lon: -88.9001, alt: 10, speed: 5, battery: 99, cells: '[4.1,4.1]', photo: true },
  { flight_id: 101, t: 200, lat: 43.1002, lon: -88.9002, alt: 20, speed: 6, battery: 98, cells: null, photo: false },
  { flight_id: 102, t: 0, lat: 43.2, lon: -88.8, alt: 0, speed: 0, battery: 90, cells: null, photo: false },
  { flight_id: 102, t: 100, lat: 43.2001, lon: -88.8001, alt: 5, speed: 2, battery: 89, cells: null, photo: false },
  { flight_id: 103, t: 0, lat: 43.3, lon: -88.7, alt: 0, speed: 0, battery: 80, cells: null, photo: false },
];

/** A synthetic gzip tar backup shaped like OpenDroneLog's, with optional overrides per file. */
export function backup({ flights = FLIGHTS, telemetry = TELEMETRY, gzip = true, omit = [], extra = {}, keychainHash = 'hash-a', customizedHash = 'hash-b' } = {}) {
  const files = {
    'flights.parquet': flightsTable(flights),
    'telemetry.parquet': telemetryTable(telemetry),
    'keychains.parquet': tableOf([['file_hash', 'STRING'], ['encryption_key', 'STRING'], ['fetched_at', 'TIMESTAMP']], [{ file_hash: keychainHash, encryption_key: SECRET_KEY, fetched_at: new Date(T0) }]),
    'flight_tags.parquet': tableOf([['flight_id', 'INT64'], ['tag', 'STRING'], ['tag_type', 'STRING']], [
      { flight_id: 101n, tag: 'High Speed', tag_type: 'auto' }, { flight_id: 101n, tag: 'Client A', tag_type: 'manual' }, { flight_id: 101n, tag: 'High Speed', tag_type: 'auto' }]),
    'flight_messages.parquet': tableOf([['flight_id', 'INT64'], ['timestamp_ms', 'INT64'], ['message_type', 'STRING'], ['message', 'STRING']], [
      { flight_id: 101n, timestamp_ms: 50n, message_type: 'warn', message: 'Strong wind' }, { flight_id: 102n, timestamp_ms: 10n, message_type: 'odd', message: 'Unknown level' },
      { flight_id: 999n, timestamp_ms: 10n, message_type: 'tip', message: 'Orphan' }]),
    'flight_customizations.parquet': tableOf([['file_hash', 'STRING'], ['display_name', 'STRING'], ['notes', 'STRING'], ['color', 'STRING'], ['manual_tags', 'STRING'], ['updated_at', 'TIMESTAMP']], [
      { file_hash: customizedHash, display_name: 'Renamed inspection', notes: 'Gusty', color: null, manual_tags: '["Training"]', updated_at: new Date(T0) }]),
    'equipment_names.parquet': tableOf([['serial', 'STRING'], ['equipment_type', 'STRING'], ['display_name', 'STRING'], ['updated_at', 'TIMESTAMP']], [
      { serial: 'AIRCRAFT0001', equipment_type: 'aircraft', display_name: 'Big Orange', updated_at: new Date(T0) }]),
    'settings.parquet': tableOf([['key', 'STRING'], ['value', 'STRING'], ['updated_at', 'TIMESTAMP']], [{ key: 'donation_acknowledged', value: 'true', updated_at: new Date(T0) }]),
    ...extra,
  };
  for (const name of omit) delete files[name];
  const archive = tar(files);
  return gzip ? gzipSync(archive) : archive;
}
