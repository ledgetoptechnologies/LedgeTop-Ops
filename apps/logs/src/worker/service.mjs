// Flight-log service logic. Called only by the Ops Worker through a service binding, after Ops has
// authenticated the staff member; every call still checks the actor's permissions here.
import { IMPORT_SCHEMA } from '../odl/contract.mjs';
import { encryptKeychain } from './keychain-crypto.mjs';
import { LogsError } from './errors.mjs';
export { LogsError };

export const PERMISSIONS = { view: 'flight_logs.view', import: 'flight_logs.import' };
export const LIMITS = { flightsPerBatch: 100, messagesPerFlight: 5000, tagsPerFlight: 50, telemetryBytes: 32 * 1024 * 1024, listPage: 100 };
const D1_PARAMS = 100; // D1 binds at most 100 parameters per statement

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const text = (value, max = 500) => (value == null ? null : String(value).slice(0, max));
const real = value => (Number.isFinite(value) ? value : null);
const int = value => (Number.isFinite(value) ? Math.round(value) : null);

function requireActor(actor, permission) {
  if (!actor || typeof actor.staffId !== 'string' || !actor.staffId) throw new LogsError('unauthenticated', 401, 'Sign in again to use flight logs.');
  if (!Array.isArray(actor.permissions) || !actor.permissions.includes(permission))
    throw new LogsError('forbidden', 403, permission === PERMISSIONS.import ? 'You don’t have permission to import flight logs.' : 'You don’t have permission to view flight logs.');
}

function chunk(list, size) { const out = []; for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size)); return out; }

async function audit(db, actor, action, subject, detail) {
  await db.prepare('INSERT INTO audit_events (id, actor_id, action, subject, detail, at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(uuid(), actor.staffId, action, subject, detail ? JSON.stringify(detail) : null, now()).run();
}

/** What the service already holds, so a browser dry run can count new vs existing. */
export async function inventory(env, actor) {
  requireActor(actor, PERMISSIONS.import);
  const all = async sql => (await env.LOGS_DB.prepare(sql).all()).results;
  const [flights, aircraft, batteries, controllers] = await Promise.all([
    all('SELECT file_hash FROM flights'), all('SELECT serial FROM aircraft'), all('SELECT serial FROM batteries'), all('SELECT serial FROM controllers'),
  ]);
  return {
    fileHashes: flights.map(row => row.file_hash), aircraftSerials: aircraft.map(row => row.serial),
    batterySerials: batteries.map(row => row.serial), controllerSerials: controllers.map(row => row.serial),
  };
}

export async function startImport(env, actor, { sourceSystem, pilotId, expectedFlights }) {
  requireActor(actor, PERMISSIONS.import);
  if (sourceSystem !== 'opendronelog') throw new LogsError('unsupported_source', 400, 'Only OpenDroneLog backups can be imported.');
  if (typeof pilotId !== 'string' || !pilotId) throw new LogsError('pilot_required', 400, 'Choose which pilot this backup belongs to.');
  if (!Number.isInteger(expectedFlights) || expectedFlights < 0 || expectedFlights > 100_000) throw new LogsError('invalid_import', 400, 'The import size is not valid.');
  const id = uuid();
  await env.LOGS_DB.prepare('INSERT INTO imports (id, source_system, pilot_id, actor_id, expected_flights, started_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, sourceSystem, pilotId, actor.staffId, expectedFlights, now()).run();
  await audit(env.LOGS_DB, actor, 'import.started', `import:${id}`, { sourceSystem, pilotId, expectedFlights });
  return { importId: id };
}

async function openImport(env, actor, importId) {
  const row = await env.LOGS_DB.prepare('SELECT * FROM imports WHERE id = ?').bind(String(importId)).first();
  if (!row) throw new LogsError('import_not_found', 404, 'That import was not found.');
  if (row.actor_id !== actor.staffId) throw new LogsError('forbidden', 403, 'Only the person who started this import can continue it.');
  if (row.status !== 'open') throw new LogsError('import_closed', 409, 'This import has already finished.');
  return row;
}

function validFlight(flight) {
  return flight?.schema === IMPORT_SCHEMA && typeof flight.source?.fileHash === 'string' && /^[0-9a-f]{64}$/.test(flight.source.fileHash);
}

async function upsertEquipment(db, table, serial, flight, fields = {}) {
  if (!serial) return null;
  const at = now(), startedAt = flight.startedAt ?? null;
  await db.prepare(`INSERT INTO ${table} (id, serial, ${Object.keys(fields).map(k => `${k}, `).join('')}first_flight_at, last_flight_at, created_at, updated_at)
    VALUES (?, ?, ${Object.keys(fields).map(() => '?, ').join('')}?, ?, ?, ?) ON CONFLICT(serial) DO NOTHING`)
    .bind(uuid(), serial, ...Object.values(fields), startedAt, startedAt, at, at).run();
  const sets = ['first_flight_at = CASE WHEN first_flight_at IS NULL OR ?1 < first_flight_at THEN ?1 ELSE first_flight_at END',
    'last_flight_at = CASE WHEN last_flight_at IS NULL OR ?1 > last_flight_at THEN ?1 ELSE last_flight_at END', 'updated_at = ?2'];
  const values = [startedAt, at];
  for (const [column, value] of Object.entries(fields)) {
    values.push(value);
    sets.push(column === 'max_cycle_count'
      ? `${column} = MAX(COALESCE(${column}, 0), COALESCE(?${values.length}, 0))`
      : `${column} = COALESCE(${column}, ?${values.length})`); // never overwrite names an admin has set
  }
  values.push(serial);
  await db.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE serial = ?${values.length}`).bind(...values).run();
  return (await db.prepare(`SELECT id FROM ${table} WHERE serial = ?`).bind(serial).first())?.id ?? null;
}

/**
 * Imports one batch of flights (with their tags, messages and keychains). Idempotent by file hash:
 * a flight that already exists is reported as existing and left unchanged.
 */
export async function importFlights(env, actor, importId, { flights = [], messages = [], keychains = [] }) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId), db = env.LOGS_DB;
  if (!Array.isArray(flights) || flights.length > LIMITS.flightsPerBatch) throw new LogsError('batch_too_large', 400, `Send at most ${LIMITS.flightsPerBatch} flights at a time.`);
  const invalid = flights.filter(flight => !validFlight(flight));
  if (invalid.length) throw new LogsError('invalid_flight', 400, `${invalid.length} flight record(s) are not in the expected format.`);
  if (flights.some(flight => flight.pilot?.id !== run.pilot_id)) throw new LogsError('pilot_mismatch', 400, 'Every flight in an import must belong to the import’s pilot.');

  const hashes = flights.map(flight => flight.source.fileHash), existing = new Map();
  for (const part of chunk(hashes, D1_PARAMS)) {
    const rows = (await db.prepare(`SELECT id, file_hash FROM flights WHERE file_hash IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const row of rows) existing.set(row.file_hash, row.id);
  }
  const created = [], already = [], at = now();
  const messagesByFlight = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const list = messagesByFlight.get(String(message?.sourceFlightId)) ?? [];
    list.push(message); messagesByFlight.set(String(message?.sourceFlightId), list);
  }
  for (const flight of flights) {
    const hash = flight.source.fileHash;
    if (existing.has(hash)) { already.push({ fileHash: hash, flightId: existing.get(hash), sourceFlightId: flight.source.flightId }); continue; }
    const aircraftId = await upsertEquipment(db, 'aircraft', text(flight.aircraft?.serial, 100), flight, { model: text(flight.aircraft?.model, 100), name: text(flight.aircraft?.name, 200) });
    const batteryId = await upsertEquipment(db, 'batteries', text(flight.batterySerial, 100), flight, { max_cycle_count: int(flight.battery?.cycleCount) });
    const controllerId = await upsertEquipment(db, 'controllers', text(flight.controllerSerial, 100), flight);
    const id = uuid();
    const result = await db.prepare(`INSERT INTO flights (id, file_hash, source_system, source_flight_id, source_file_name, import_id, pilot_id, pilot_attribution,
      aircraft_id, battery_id, controller_id, display_name, started_at, ended_at, duration_seconds, distance_m, max_altitude_m, max_speed_mps, home_lat, home_lon,
      photo_count, video_count, battery_cycle_count, battery_life_percent, telemetry_points, notes, color, created_at, updated_at)
      VALUES (?, ?, 'opendronelog', ?, ?, ?, ?, 'backup_owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_hash) DO NOTHING`)
      .bind(id, hash, text(flight.source.flightId, 40), text(flight.source.fileName, 300), run.id, run.pilot_id, aircraftId, batteryId, controllerId,
        text(flight.displayName, 300), text(flight.startedAt, 40), text(flight.endedAt, 40), real(flight.durationSeconds), real(flight.distanceMeters),
        real(flight.maxAltitudeMeters), real(flight.maxSpeedMetersPerSecond), real(flight.home?.latitude), real(flight.home?.longitude),
        int(flight.media?.photos) ?? 0, int(flight.media?.videos) ?? 0, int(flight.battery?.cycleCount), int(flight.battery?.lifePercent),
        int(flight.telemetryPointCount) ?? 0, text(flight.notes, 4000), text(flight.color, 20), at, at).run();
    if (!result.meta?.changes) { // lost a race with another writer: treat as existing
      const row = await db.prepare('SELECT id FROM flights WHERE file_hash = ?').bind(hash).first();
      already.push({ fileHash: hash, flightId: row?.id ?? null, sourceFlightId: flight.source.flightId }); continue;
    }
    const tags = (Array.isArray(flight.tags) ? flight.tags : []).slice(0, LIMITS.tagsPerFlight)
      .filter(tag => typeof tag?.tag === 'string' && tag.tag.trim()).map(tag => [id, text(tag.tag.trim(), 100), tag.kind === 'manual' ? 'manual' : 'auto']);
    for (const part of chunk(tags, Math.floor(D1_PARAMS / 3)))
      await db.prepare(`INSERT OR IGNORE INTO flight_tags (flight_id, tag, kind) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`).bind(...part.flat()).run();
    const flightMessages = (messagesByFlight.get(String(flight.source.flightId)) ?? []).slice(0, LIMITS.messagesPerFlight)
      .filter(message => typeof message?.text === 'string' && message.text)
      .map((message, seq) => [id, seq, int(message.offsetMs), ['tip', 'caution', 'warn'].includes(message.level) ? message.level : 'tip', text(message.text, 1000)]);
    for (const part of chunk(flightMessages, Math.floor(D1_PARAMS / 5)))
      await db.prepare(`INSERT INTO flight_messages (flight_id, seq, offset_ms, level, text) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`).bind(...part.flat()).run();
    created.push({ fileHash: hash, flightId: id, sourceFlightId: flight.source.flightId });
  }

  const wanted = new Set(hashes);
  const keys = (Array.isArray(keychains) ? keychains : []).filter(item => wanted.has(item?.fileHash) && typeof item.key === 'string' && item.key);
  if (keys.length) {
    for (const item of keys) {
      const sealed = await encryptKeychain(env, item.key);
      await db.prepare('INSERT OR IGNORE INTO keychains (file_hash, ciphertext, iv, key_version, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(item.fileHash, sealed.ciphertext, sealed.iv, sealed.keyVersion, text(item.fetchedAt, 40), now()).run();
    }
  }
  await db.prepare('UPDATE imports SET flights_created = flights_created + ?, flights_existing = flights_existing + ? WHERE id = ?').bind(created.length, already.length, run.id).run();
  return { created, existing: already, keychainsStored: keys.length };
}

/** Stores one flight's telemetry (gzip JSON columns) in R2 and links it to the flight. */
export async function putTelemetry(env, actor, importId, flightId, body) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body ?? []);
  if (!bytes.length || bytes.length > LIMITS.telemetryBytes) throw new LogsError('telemetry_too_large', 413, 'This flight’s track is too large to store.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new LogsError('telemetry_not_gzip', 400, 'Flight tracks must be sent compressed.');
  const flight = await env.LOGS_DB.prepare('SELECT id, import_id, telemetry_key FROM flights WHERE id = ?').bind(String(flightId)).first();
  if (!flight || flight.import_id !== run.id) throw new LogsError('flight_not_in_import', 404, 'That flight is not part of this import.');
  const key = `telemetry/v1/${flight.id}.json.gz`;
  await env.LOGS_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { flightId: flight.id, importId: run.id } });
  await env.LOGS_DB.prepare('UPDATE flights SET telemetry_key = ?, updated_at = ? WHERE id = ?').bind(key, now(), flight.id).run();
  if (!flight.telemetry_key) await env.LOGS_DB.prepare('UPDATE imports SET tracks_stored = tracks_stored + 1 WHERE id = ?').bind(run.id).run();
  return { flightId: flight.id, stored: true };
}

export async function completeImport(env, actor, importId) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId);
  await env.LOGS_DB.prepare("UPDATE imports SET status = 'completed', completed_at = ? WHERE id = ?").bind(now(), run.id).run();
  const done = await env.LOGS_DB.prepare('SELECT * FROM imports WHERE id = ?').bind(run.id).first();
  const summary = { importId: run.id, pilotId: done.pilot_id, expectedFlights: done.expected_flights, flightsCreated: done.flights_created, flightsExisting: done.flights_existing, tracksStored: done.tracks_stored };
  await audit(env.LOGS_DB, actor, 'import.completed', `import:${run.id}`, summary);
  return summary;
}

const FLIGHT_LIST_SQL = `SELECT f.id, f.display_name, f.started_at, f.duration_seconds, f.distance_m, f.max_altitude_m, f.pilot_id, f.photo_count, f.video_count,
  f.raw_log_status, f.telemetry_key IS NOT NULL AS has_track, a.serial AS aircraft_serial, a.model AS aircraft_model, a.name AS aircraft_name
  FROM flights f LEFT JOIN aircraft a ON a.id = f.aircraft_id`;

function flightSummary(row) {
  return {
    id: row.id, displayName: row.display_name, startedAt: row.started_at, durationSeconds: row.duration_seconds, distanceMeters: row.distance_m,
    maxAltitudeMeters: row.max_altitude_m, pilotId: row.pilot_id, media: { photos: row.photo_count, videos: row.video_count },
    aircraft: row.aircraft_serial ? { serial: row.aircraft_serial, model: row.aircraft_model, name: row.aircraft_name } : null,
    hasTrack: Boolean(row.has_track), rawLog: row.raw_log_status,
  };
}

/** Newest first, keyset paged by (started_at, id). */
export async function listFlights(env, actor, { limit = 50, before } = {}) {
  requireActor(actor, PERMISSIONS.view);
  const size = Math.min(Math.max(1, Number(limit) || 50), LIMITS.listPage);
  const [beforeStart, beforeId] = typeof before === 'string' && before.includes('|') ? before.split('|') : [null, null];
  const rows = (beforeStart
    ? await env.LOGS_DB.prepare(`${FLIGHT_LIST_SQL} WHERE (f.started_at < ?1 OR (f.started_at = ?1 AND f.id < ?2)) ORDER BY f.started_at DESC, f.id DESC LIMIT ?3`).bind(beforeStart, beforeId, size + 1).all()
    : await env.LOGS_DB.prepare(`${FLIGHT_LIST_SQL} ORDER BY f.started_at DESC, f.id DESC LIMIT ?1`).bind(size + 1).all()).results;
  const page = rows.slice(0, size), last = page.at(-1);
  return { items: page.map(flightSummary), next: rows.length > size && last ? `${last.started_at}|${last.id}` : null };
}

export async function getFlight(env, actor, flightId) {
  requireActor(actor, PERMISSIONS.view);
  const row = await env.LOGS_DB.prepare(`${FLIGHT_LIST_SQL} WHERE f.id = ?`).bind(String(flightId)).first();
  if (!row) throw new LogsError('flight_not_found', 404, 'That flight was not found.');
  const [tags, messages] = await Promise.all([
    env.LOGS_DB.prepare('SELECT tag, kind FROM flight_tags WHERE flight_id = ? ORDER BY tag').bind(row.id).all(),
    env.LOGS_DB.prepare('SELECT offset_ms, level, text FROM flight_messages WHERE flight_id = ? ORDER BY seq').bind(row.id).all(),
  ]);
  return { ...flightSummary(row), tags: tags.results, messages: messages.results.map(m => ({ offsetMs: m.offset_ms, level: m.level, text: m.text })) };
}

/** Returns the stored track (gzip JSON) for Ops to pass through to the browser. */
export async function getTelemetry(env, actor, flightId) {
  requireActor(actor, PERMISSIONS.view);
  const row = await env.LOGS_DB.prepare('SELECT telemetry_key FROM flights WHERE id = ?').bind(String(flightId)).first();
  if (!row?.telemetry_key) throw new LogsError('track_not_found', 404, 'This flight has no stored track.');
  const object = await env.LOGS_BUCKET.get(row.telemetry_key);
  if (!object) throw new LogsError('track_not_found', 404, 'This flight has no stored track.');
  return new Uint8Array(await object.arrayBuffer());
}
