// Read side of the flight-log service: filtered flight lists, filter facets, the fleet overview and
// equipment. Every function re-checks the actor's view permission. Filters are bound parameters only.
import { LogsError } from './errors.mjs';

const VIEW = 'flight_logs.view';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9-]{1,80}$/;
export const LIST_PAGE = 100;

function requireViewer(actor) {
  if (!actor || typeof actor.staffId !== 'string' || !actor.staffId) throw new LogsError('unauthenticated', 401, 'Sign in again to use flight logs.');
  if (!Array.isArray(actor.permissions) || !actor.permissions.includes(VIEW)) throw new LogsError('forbidden', 403, 'You don’t have permission to view flight logs.');
}

const num = value => (value === undefined || value === null || value === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null);

/** Turns query filters into a WHERE clause over `f` (flights) with bound values. Unknown or malformed filters are ignored. */
export function filterClause(filters = {}) {
  const where = [], values = [];
  const add = (sql, ...bound) => { where.push(sql); values.push(...bound); };
  if (DAY.test(filters.from ?? '')) add('f.started_at >= ?', `${filters.from}T00:00:00`);
  if (DAY.test(filters.to ?? '')) add('f.started_at < ?', `${filters.to}T23:59:59.999`);
  if (ID.test(filters.aircraft ?? '')) add('f.aircraft_id = ?', filters.aircraft);
  if (ID.test(filters.battery ?? '')) add('f.battery_id = ?', filters.battery);
  if (ID.test(filters.pilot ?? '')) add('f.pilot_id = ?', filters.pilot);
  if (typeof filters.tag === 'string' && filters.tag.trim() && filters.tag.length <= 100)
    add('EXISTS (SELECT 1 FROM flight_tags t WHERE t.flight_id = f.id AND t.tag = ?)', filters.tag.trim());
  if (typeof filters.q === 'string' && filters.q.trim() && filters.q.length <= 100) {
    const like = `%${filters.q.trim().replace(/[\\%_]/g, c => `\\${c}`)}%`;
    add("(f.display_name LIKE ? ESCAPE '\\' OR f.source_file_name LIKE ? ESCAPE '\\' OR f.notes LIKE ? ESCAPE '\\')", like, like, like);
  }
  for (const [key, column] of [['Duration', 'f.duration_seconds'], ['Altitude', 'f.max_altitude_m'], ['Distance', 'f.distance_m']]) {
    const min = num(filters[`min${key}`]), max = num(filters[`max${key}`]);
    if (min !== null) add(`${column} >= ?`, min);
    if (max !== null) add(`${column} <= ?`, max);
  }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', values };
}

const LIST_SQL = `SELECT f.id, f.display_name, f.source_file_name, f.started_at, f.duration_seconds, f.distance_m, f.max_altitude_m, f.max_speed_mps,
  f.pilot_id, f.photo_count, f.video_count, f.raw_log_status, f.telemetry_key IS NOT NULL AS has_track, f.home_lat, f.home_lon, f.color,
  f.battery_life_percent, a.id AS aircraft_id, a.serial AS aircraft_serial, a.model AS aircraft_model, a.name AS aircraft_name,
  b.id AS battery_id, b.serial AS battery_serial,
  (SELECT group_concat(t.tag, char(31)) FROM flight_tags t WHERE t.flight_id = f.id) AS tags
  FROM flights f LEFT JOIN aircraft a ON a.id = f.aircraft_id LEFT JOIN batteries b ON b.id = f.battery_id`;

export function flightItem(row) {
  return {
    id: row.id, displayName: row.display_name, fileName: row.source_file_name, startedAt: row.started_at, durationSeconds: row.duration_seconds,
    distanceMeters: row.distance_m, maxAltitudeMeters: row.max_altitude_m, maxSpeedMetersPerSecond: row.max_speed_mps, pilotId: row.pilot_id,
    media: { photos: row.photo_count, videos: row.video_count }, hasTrack: Boolean(row.has_track), rawLog: row.raw_log_status, color: row.color,
    home: row.home_lat != null && row.home_lon != null ? { latitude: row.home_lat, longitude: row.home_lon } : null,
    aircraft: row.aircraft_serial ? { id: row.aircraft_id, serial: row.aircraft_serial, model: row.aircraft_model, name: row.aircraft_name } : null,
    battery: row.battery_serial ? { id: row.battery_id, serial: row.battery_serial, lifePercent: row.battery_life_percent } : null,
    tags: row.tags ? String(row.tags).split('\u001f').sort() : [],
  };
}

/** Newest first, keyset paged by (started_at, id), with the same filters as the overview. */
export async function listFlights(env, actor, query = {}) {
  requireViewer(actor);
  const size = Math.min(Math.max(1, Number(query.limit) || 50), LIST_PAGE);
  const filter = filterClause(query), values = [...filter.values];
  let sql = `${LIST_SQL} ${filter.sql}`;
  const [beforeStart, beforeId] = typeof query.before === 'string' && query.before.includes('|') ? query.before.split('|') : [null, null];
  if (beforeStart && beforeId) {
    sql += `${filter.sql ? ' AND' : ' WHERE'} (f.started_at < ? OR (f.started_at = ? AND f.id < ?))`;
    values.push(beforeStart, beforeStart, beforeId);
  }
  sql += ' ORDER BY f.started_at DESC, f.id DESC LIMIT ?';
  values.push(size + 1);
  const rows = (await env.LOGS_DB.prepare(sql).bind(...values).all()).results;
  const count = await env.LOGS_DB.prepare(`SELECT COUNT(*) AS n FROM flights f ${filter.sql}`).bind(...filter.values).first();
  const page = rows.slice(0, size), last = page.at(-1);
  return { items: page.map(flightItem), next: rows.length > size && last ? `${last.started_at}|${last.id}` : null, total: count?.n ?? 0 };
}

/** What the filter controls offer: equipment, tags and the ranges of the sliders. */
export async function facets(env, actor) {
  requireViewer(actor);
  const all = async sql => (await env.LOGS_DB.prepare(sql).all()).results;
  const [aircraft, batteries, tags, pilots, ranges] = await Promise.all([
    all(`SELECT a.id, a.serial, a.model, a.name, COUNT(f.id) AS flights FROM aircraft a LEFT JOIN flights f ON f.aircraft_id = a.id GROUP BY a.id ORDER BY flights DESC`),
    all(`SELECT b.id, b.serial, COUNT(f.id) AS flights FROM batteries b LEFT JOIN flights f ON f.battery_id = b.id GROUP BY b.id ORDER BY flights DESC`),
    all(`SELECT tag, kind, COUNT(*) AS flights FROM flight_tags GROUP BY tag, kind ORDER BY flights DESC, tag LIMIT 200`),
    all(`SELECT pilot_id AS id, COUNT(*) AS flights FROM flights GROUP BY pilot_id ORDER BY flights DESC`),
    all(`SELECT MAX(duration_seconds) AS duration, MAX(max_altitude_m) AS altitude, MAX(distance_m) AS distance, MIN(started_at) AS first, MAX(started_at) AS last FROM flights`),
  ]);
  return {
    aircraft: aircraft.map(row => ({ id: row.id, serial: row.serial, model: row.model, name: row.name, flights: row.flights })),
    batteries: batteries.map(row => ({ id: row.id, serial: row.serial, flights: row.flights })),
    tags: tags.map(row => ({ tag: row.tag, kind: row.kind, flights: row.flights })),
    pilots: pilots.map(row => ({ id: row.id, flights: row.flights })),
    ranges: { durationSeconds: ranges[0]?.duration ?? 0, altitudeMeters: ranges[0]?.altitude ?? 0, distanceMeters: ranges[0]?.distance ?? 0,
      firstFlightAt: ranges[0]?.first ?? null, lastFlightAt: ranges[0]?.last ?? null },
  };
}

/** Fleet overview for the same filters as the list: totals, activity, breakdowns, locations, battery health and top flights. */
export async function overview(env, actor, query = {}) {
  requireViewer(actor);
  const filter = filterClause(query), db = env.LOGS_DB;
  const rows = async (sql, extra = []) => (await db.prepare(sql).bind(...filter.values, ...extra).all()).results;
  const and = filter.sql ? `${filter.sql} AND` : 'WHERE';
  const [totals, activity, byAircraft, byBattery, buckets, locations, longest, furthest, batteryHealth, byHour] = await Promise.all([
    rows(`SELECT COUNT(*) AS flights, COALESCE(SUM(f.duration_seconds), 0) AS seconds, COALESCE(SUM(f.distance_m), 0) AS meters,
      COALESCE(SUM(f.telemetry_points), 0) AS points, MAX(f.max_altitude_m) AS max_altitude, MAX(f.max_speed_mps) AS max_speed,
      SUM(f.photo_count) AS photos, SUM(f.video_count) AS videos FROM flights f ${filter.sql}`),
    rows(`SELECT substr(f.started_at, 1, 10) AS day, COUNT(*) AS flights, SUM(f.duration_seconds) AS seconds FROM flights f ${and} f.started_at IS NOT NULL GROUP BY day ORDER BY day`),
    rows(`SELECT a.id, a.serial, a.model, a.name, COUNT(*) AS flights, SUM(f.duration_seconds) AS seconds FROM flights f JOIN aircraft a ON a.id = f.aircraft_id ${filter.sql} GROUP BY a.id ORDER BY seconds DESC`),
    rows(`SELECT b.id, b.serial, COUNT(*) AS flights, SUM(f.duration_seconds) AS seconds FROM flights f JOIN batteries b ON b.id = f.battery_id ${filter.sql} GROUP BY b.id ORDER BY flights DESC`),
    rows(`SELECT SUM(f.duration_seconds < 600) AS short, SUM(f.duration_seconds >= 600 AND f.duration_seconds <= 1200) AS mid, SUM(f.duration_seconds > 1200) AS long FROM flights f ${filter.sql}`),
    rows(`SELECT f.id, f.display_name, f.started_at, f.home_lat, f.home_lon FROM flights f ${and} f.home_lat IS NOT NULL AND f.home_lon IS NOT NULL AND NOT (f.home_lat = 0 AND f.home_lon = 0) LIMIT 5000`),
    rows(`SELECT f.id, f.display_name, f.started_at, f.duration_seconds AS value FROM flights f ${and} f.duration_seconds IS NOT NULL ORDER BY f.duration_seconds DESC LIMIT 3`),
    rows(`SELECT f.id, f.display_name, f.started_at, f.distance_m AS value FROM flights f ${and} f.distance_m IS NOT NULL ORDER BY f.distance_m DESC LIMIT 3`),
    rows(`SELECT b.id, b.serial, b.max_cycle_count AS cycles, COUNT(*) AS flights, SUM(f.duration_seconds) AS seconds,
      (SELECT f2.battery_life_percent FROM flights f2 WHERE f2.battery_id = b.id AND f2.battery_life_percent IS NOT NULL ORDER BY f2.started_at DESC LIMIT 1) AS life
      FROM flights f JOIN batteries b ON b.id = f.battery_id ${filter.sql} GROUP BY b.id ORDER BY flights DESC`),
    rows(`SELECT CAST(substr(f.started_at, 12, 2) AS INTEGER) AS hour, COUNT(*) AS flights FROM flights f ${and} f.started_at IS NOT NULL GROUP BY hour ORDER BY hour`),
  ]);
  const t = totals[0] ?? {};
  const top = row => ({ id: row.id, displayName: row.display_name, startedAt: row.started_at, value: row.value });
  return {
    totals: {
      flights: t.flights ?? 0, durationSeconds: t.seconds ?? 0, distanceMeters: t.meters ?? 0, dataPoints: t.points ?? 0,
      maxAltitudeMeters: t.max_altitude ?? null, maxSpeedMetersPerSecond: t.max_speed ?? null, photos: t.photos ?? 0, videos: t.videos ?? 0,
      averageDistanceMeters: t.flights ? t.meters / t.flights : null, averageDurationSeconds: t.flights ? t.seconds / t.flights : null,
      averageSpeedMetersPerSecond: t.seconds ? t.meters / t.seconds : null,
    },
    activity: activity.map(row => ({ day: row.day, flights: row.flights, durationSeconds: row.seconds ?? 0 })),
    byHour: byHour.filter(row => row.hour != null).map(row => ({ hour: row.hour, flights: row.flights })),
    byAircraft: byAircraft.map(row => ({ id: row.id, serial: row.serial, model: row.model, name: row.name, flights: row.flights, durationSeconds: row.seconds ?? 0 })),
    byBattery: byBattery.map(row => ({ id: row.id, serial: row.serial, flights: row.flights, durationSeconds: row.seconds ?? 0 })),
    byDuration: { short: buckets[0]?.short ?? 0, mid: buckets[0]?.mid ?? 0, long: buckets[0]?.long ?? 0 },
    locations: locations.map(row => ({ id: row.id, displayName: row.display_name, startedAt: row.started_at, latitude: row.home_lat, longitude: row.home_lon })),
    batteryHealth: batteryHealth.map(row => ({ id: row.id, serial: row.serial, cycles: row.cycles, lifePercent: row.life, flights: row.flights, durationSeconds: row.seconds ?? 0 })),
    longest: longest.map(top), furthest: furthest.map(top),
  };
}
