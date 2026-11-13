// Flight-log service logic. Called only by the Ops Worker through a service binding, after Ops has
// authenticated the staff member; every call still checks the actor's permissions here.
import { IMPORT_SCHEMA, SAME_FLIGHT_START_WINDOW_SECONDS } from '../odl/contract.mjs';
import { encryptKeychain } from './keychain-crypto.mjs';
import { LogsError } from './errors.mjs';
import { flightItem, viewScope } from './analytics.mjs';
export { LogsError };

export const PERMISSIONS = { view: 'flight_logs.view', import: 'flight_logs.import' };
// Real ODL data has flights with ~15,000 messages, so the per-flight cap is generous, and anything over it
// is reported back (messagesDropped) rather than dropped silently.
export const LIMITS = { flightsPerBatch: 100, messagesPerFlight: 50_000, tagsPerFlight: 50, telemetryBytes: 32 * 1024 * 1024, listPage: 100 };
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
    all('SELECT f.file_hash, f.started_at, a.serial FROM flights f LEFT JOIN aircraft a ON a.id = f.aircraft_id'), all('SELECT serial FROM aircraft'), all('SELECT serial FROM batteries'), all('SELECT serial FROM controllers'),
  ]);
  return {
    fileHashes: flights.map(row => row.file_hash), aircraftSerials: aircraft.map(row => row.serial),
    flightStarts: flights.filter(row => row.serial && row.started_at).map(row => [row.serial, row.started_at]),
    batterySerials: batteries.map(row => row.serial), controllerSerials: controllers.map(row => row.serial),
  };
}

export async function startImport(env, actor, { sourceSystem, pilotId, expectedFlights }) {
  requireActor(actor, PERMISSIONS.import);
  if (sourceSystem !== 'opendronelog') throw new LogsError('unsupported_source', 400, 'Only OpenDroneLog backups can be imported.');
  if (typeof pilotId !== 'string' || !pilotId) throw new LogsError('pilot_required', 400, 'Choose which pilot this backup belongs to.');
  if (!Number.isInteger(expectedFlights) || expectedFlights < 0 || expectedFlights > 100_000) throw new LogsError('invalid_import', 400, 'The import size is not valid.');
  const id = uuid(), at = now();
  // A new run for the same person and pilot supersedes any run they left unfinished; that run's
  // track-less flights can be resumed by this one (see importFlights).
  await env.LOGS_DB.batch([
    env.LOGS_DB.prepare("UPDATE imports SET status = 'abandoned', completed_at = ? WHERE actor_id = ? AND pilot_id = ? AND status = 'open'").bind(at, actor.staffId, pilotId),
    env.LOGS_DB.prepare('INSERT INTO imports (id, source_system, pilot_id, actor_id, expected_flights, started_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id, sourceSystem, pilotId, actor.staffId, expectedFlights, at),
  ]);
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

const STORED_FLIGHT_SQL = `SELECT f.id, f.file_hash, f.telemetry_key, f.import_id, f.pilot_id, i.status AS import_status, i.actor_id AS import_actor
  FROM flights f LEFT JOIN imports i ON i.id = f.import_id`;
const keychainInsert = (db, item) => db.prepare('INSERT OR IGNORE INTO keychains (file_hash, ciphertext, iv, key_version, fetched_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
  .bind(item.fileHash, item.sealed.ciphertext, item.sealed.iv, item.sealed.keyVersion, text(item.fetchedAt, 40), now());
const itemInsert = (db, runId, hash, flightId, outcome) => db.prepare('INSERT OR IGNORE INTO import_items (import_id, file_hash, flight_id, outcome) VALUES (?, ?, ?, ?)')
  .bind(runId, hash, flightId, outcome);

/**
 * Imports one batch of flights (with their tags, messages and keychains). Each new flight is written in
 * one transaction with its tags, messages and keychain, so a failure never leaves half a flight.
 * Already-stored flights are reported as existing, except one this person left without a track in an
 * unfinished run (or in this run, on a replayed batch): that one is "resumed" so its track can be sent.
 */
export async function importFlights(env, actor, importId, { flights = [], messages = [], keychains = [] }) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId), db = env.LOGS_DB;
  if (!Array.isArray(flights) || flights.length > LIMITS.flightsPerBatch) throw new LogsError('batch_too_large', 400, `Send at most ${LIMITS.flightsPerBatch} flights at a time.`);
  const invalid = flights.filter(flight => !validFlight(flight));
  if (invalid.length) throw new LogsError('invalid_flight', 400, `${invalid.length} flight record(s) are not in the expected format.`);
  if (flights.some(flight => flight.pilot?.id !== run.pilot_id)) throw new LogsError('pilot_mismatch', 400, 'Every flight in an import must belong to the import’s pilot.');

  // Seal every key before writing anything, so a missing sealing secret fails the batch up front.
  const hashes = flights.map(flight => flight.source.fileHash), wanted = new Set(hashes), sealedKeys = new Map();
  for (const item of Array.isArray(keychains) ? keychains : []) {
    if (!wanted.has(item?.fileHash) || typeof item.key !== 'string' || !item.key || sealedKeys.has(item.fileHash)) continue;
    sealedKeys.set(item.fileHash, { fileHash: item.fileHash, fetchedAt: item.fetchedAt, sealed: await encryptKeychain(env, item.key) });
  }

  const existing = new Map();
  for (const part of chunk(hashes, D1_PARAMS)) {
    const rows = (await db.prepare(`${STORED_FLIGHT_SQL} WHERE f.file_hash IN (${part.map(() => '?').join(',')})`).bind(...part).all()).results;
    for (const row of rows) existing.set(row.file_hash, row);
  }
  const resumable = row => !row.telemetry_key && row.pilot_id === run.pilot_id
    && (row.import_id === run.id || (row.import_actor === actor.staffId && (row.import_status === 'open' || row.import_status === 'abandoned')));
  const created = [], resumed = [], already = [], at = now();
  let messagesDropped = 0;
  const messagesByFlight = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    const list = messagesByFlight.get(String(message?.sourceFlightId)) ?? [];
    list.push(message); messagesByFlight.set(String(message?.sourceFlightId), list);
  }
  const keep = async (flight, row, reason) => {
    const hash = flight.source.fileHash, item = { fileHash: hash, flightId: row.id, sourceFlightId: flight.source.flightId };
    const statements = sealedKeys.has(hash) ? [keychainInsert(db, sealedKeys.get(hash))] : [];
    if (reason === 'same_file' && resumable(row)) {
      await db.batch([...statements, db.prepare('UPDATE flights SET import_id = ?, updated_at = ? WHERE id = ?').bind(run.id, at, row.id),
        itemInsert(db, run.id, hash, row.id, 'resumed')]);
      resumed.push(item); return;
    }
    await db.batch([...statements, itemInsert(db, run.id, hash, row.id, 'duplicate')]);
    already.push({ ...item, reason });
  };
  for (const flight of flights) {
    const hash = flight.source.fileHash;
    if (existing.has(hash)) { await keep(flight, existing.get(hash), 'same_file'); continue; }
    // The same flight from a different file (same aircraft, start within the window) is rejected too.
    const serial = text(flight.aircraft?.serial, 100), startedAt = text(flight.startedAt, 40);
    if (serial && startedAt) {
      const twin = await db.prepare(`SELECT f.id FROM flights f JOIN aircraft a ON a.id = f.aircraft_id
        WHERE a.serial = ? AND f.started_at IS NOT NULL AND abs(julianday(f.started_at) - julianday(?)) * 86400 <= ? LIMIT 1`)
        .bind(serial, startedAt, SAME_FLIGHT_START_WINDOW_SECONDS).first();
      if (twin) { await keep(flight, twin, 'same_aircraft_and_start'); continue; }
    }
    const aircraftId = await upsertEquipment(db, 'aircraft', serial, flight, { model: text(flight.aircraft?.model, 100), name: text(flight.aircraft?.name, 200) });
    const batteryId = await upsertEquipment(db, 'batteries', text(flight.batterySerial, 100), flight, { max_cycle_count: int(flight.battery?.cycleCount) });
    const controllerId = await upsertEquipment(db, 'controllers', text(flight.controllerSerial, 100), flight);
    const id = uuid();
    const statements = [db.prepare(`INSERT INTO flights (id, file_hash, source_system, source_flight_id, source_file_name, import_id, pilot_id, pilot_attribution,
      aircraft_id, battery_id, controller_id, display_name, started_at, ended_at, duration_seconds, distance_m, max_altitude_m, max_speed_mps, home_lat, home_lon,
      photo_count, video_count, battery_cycle_count, battery_life_percent, telemetry_points, notes, color, created_at, updated_at)
      VALUES (?, ?, 'opendronelog', ?, ?, ?, ?, 'backup_owner', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(id, hash, text(flight.source.flightId, 40), text(flight.source.fileName, 300), run.id, run.pilot_id, aircraftId, batteryId, controllerId,
        text(flight.displayName, 300), text(flight.startedAt, 40), text(flight.endedAt, 40), real(flight.durationSeconds), real(flight.distanceMeters),
        real(flight.maxAltitudeMeters), real(flight.maxSpeedMetersPerSecond), real(flight.home?.latitude), real(flight.home?.longitude),
        int(flight.media?.photos) ?? 0, int(flight.media?.videos) ?? 0, int(flight.battery?.cycleCount), int(flight.battery?.lifePercent),
        int(flight.telemetryPointCount) ?? 0, text(flight.notes, 4000), text(flight.color, 20), at, at)];
    const tags = (Array.isArray(flight.tags) ? flight.tags : []).slice(0, LIMITS.tagsPerFlight)
      .filter(tag => typeof tag?.tag === 'string' && tag.tag.trim()).map(tag => [id, text(tag.tag.trim(), 100), tag.kind === 'manual' ? 'manual' : 'auto']);
    for (const part of chunk(tags, Math.floor(D1_PARAMS / 3)))
      statements.push(db.prepare(`INSERT OR IGNORE INTO flight_tags (flight_id, tag, kind) VALUES ${part.map(() => '(?, ?, ?)').join(', ')}`).bind(...part.flat()));
    const allMessages = messagesByFlight.get(String(flight.source.flightId)) ?? [];
    const dropped = Math.max(0, allMessages.length - LIMITS.messagesPerFlight);
    const flightMessages = allMessages.slice(0, LIMITS.messagesPerFlight)
      .filter(message => typeof message?.text === 'string' && message.text)
      .map((message, seq) => [id, seq, int(message.offsetMs), ['tip', 'caution', 'warn'].includes(message.level) ? message.level : 'tip', text(message.text, 1000)]);
    for (const part of chunk(flightMessages, Math.floor(D1_PARAMS / 5)))
      statements.push(db.prepare(`INSERT INTO flight_messages (flight_id, seq, offset_ms, level, text) VALUES ${part.map(() => '(?, ?, ?, ?, ?)').join(', ')}`).bind(...part.flat()));
    if (sealedKeys.has(hash)) statements.push(keychainInsert(db, sealedKeys.get(hash)));
    statements.push(itemInsert(db, run.id, hash, id, 'created'));
    try {
      await db.batch(statements); // one transaction: the flight with everything that belongs to it, or nothing
    } catch (error) {
      // Lost a race with another writer for the same file: report what is stored now.
      const row = await db.prepare(`${STORED_FLIGHT_SQL} WHERE f.file_hash = ?`).bind(hash).first();
      if (!row) throw error;
      await keep(flight, row, 'same_file'); continue;
    }
    messagesDropped += dropped;
    created.push({ fileHash: hash, flightId: id, sourceFlightId: flight.source.flightId });
  }
  return { created, resumed, existing: already, keychainsStored: sealedKeys.size, messagesDropped };
}

/** Stores one flight's telemetry (gzip JSON columns) in R2 and links it to the flight. */
export async function putTelemetry(env, actor, importId, flightId, body) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId);
  const bytes = body instanceof Uint8Array ? body : new Uint8Array(body ?? []);
  if (!bytes.length || bytes.length > LIMITS.telemetryBytes) throw new LogsError('telemetry_too_large', 413, 'This flight’s track is too large to store.');
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new LogsError('telemetry_not_gzip', 400, 'Flight tracks must be sent compressed.');
  // Only flights this run created or resumed take a track; a duplicate it merely reported does not.
  const flight = await env.LOGS_DB.prepare(`SELECT f.id FROM flights f JOIN import_items item ON item.flight_id = f.id
    WHERE f.id = ? AND item.import_id = ? AND item.outcome IN ('created', 'resumed')`).bind(String(flightId), run.id).first();
  if (!flight) throw new LogsError('flight_not_in_import', 404, 'That flight is not part of this import.');
  const key = `telemetry/v1/${flight.id}.json.gz`;
  await env.LOGS_BUCKET.put(key, bytes, { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' }, customMetadata: { flightId: flight.id, importId: run.id } });
  await env.LOGS_DB.prepare('UPDATE flights SET telemetry_key = ?, updated_at = ? WHERE id = ?').bind(key, now(), flight.id).run();
  return { flightId: flight.id, stored: true };
}

/**
 * Finishes an import only when every expected flight was handled and every track the browser sent is
 * stored. Otherwise the import stays open (409 import_incomplete) and running it again resumes it.
 */
export async function completeImport(env, actor, importId, { tracksExpected } = {}) {
  requireActor(actor, PERMISSIONS.import);
  const run = await openImport(env, actor, importId), db = env.LOGS_DB;
  if (!Number.isInteger(tracksExpected) || tracksExpected < 0) throw new LogsError('invalid_import', 400, 'Say how many flight tracks this import sent.');
  const counts = await db.prepare(`SELECT COUNT(*) AS handled,
      COALESCE(SUM(item.outcome = 'created'), 0) AS created,
      COALESCE(SUM(item.outcome = 'resumed'), 0) AS resumed,
      COALESCE(SUM(item.outcome = 'duplicate'), 0) AS duplicate,
      COALESCE(SUM(item.outcome IN ('created', 'resumed') AND f.telemetry_key IS NOT NULL), 0) AS tracks
    FROM import_items item LEFT JOIN flights f ON f.id = item.flight_id WHERE item.import_id = ?`).bind(run.id).first();
  if (counts.handled !== run.expected_flights || counts.tracks < tracksExpected)
    throw new LogsError('import_incomplete', 409, `This import isn’t finished: ${counts.handled} of ${run.expected_flights} flights and ${counts.tracks} of ${tracksExpected} tracks are stored. Run the import again to finish it.`);
  const stored = counts.created + counts.resumed;
  await db.prepare("UPDATE imports SET status = 'completed', completed_at = ?, flights_created = ?, flights_existing = ?, tracks_stored = ? WHERE id = ? AND status = 'open'")
    .bind(now(), stored, counts.duplicate, counts.tracks, run.id).run();
  const summary = { importId: run.id, pilotId: run.pilot_id, expectedFlights: run.expected_flights, flightsCreated: stored,
    flightsResumed: counts.resumed, flightsExisting: counts.duplicate, tracksStored: counts.tracks };
  await audit(db, actor, 'import.completed', `import:${run.id}`, summary);
  return summary;
}

export { listFlights, facets, overview } from './analytics.mjs';

/** One flight with everything the detail view shows except the track (fetched separately). */
export async function getFlight(env, actor, flightId) {
  const scope = viewScope(actor);
  const row = await env.LOGS_DB.prepare(`${FLIGHT_DETAIL_SQL} WHERE f.id = ?`).bind(String(flightId)).first();
  // Someone else's flight looks exactly like a missing one to a pilot who may only see their own.
  if (!row || (!scope.all && row.pilot_id !== scope.pilotId)) throw new LogsError('flight_not_found', 404, 'That flight was not found.');
  const [tags, messages] = await Promise.all([
    env.LOGS_DB.prepare('SELECT tag, kind FROM flight_tags WHERE flight_id = ? ORDER BY tag').bind(row.id).all(),
    env.LOGS_DB.prepare('SELECT offset_ms, level, text FROM flight_messages WHERE flight_id = ? ORDER BY seq').bind(row.id).all(),
  ]);
  const item = flightItem(row);
  return { ...item, endedAt: row.ended_at, notes: row.notes, telemetryPoints: row.telemetry_points, batteryCycleCount: row.battery_cycle_count,
    controller: row.controller_serial ? { serial: row.controller_serial } : null,
    tags: tags.results, messages: messages.results.map(m => ({ offsetMs: m.offset_ms, level: m.level, text: m.text })) };
}

const FLIGHT_DETAIL_SQL = `SELECT f.*, f.telemetry_key IS NOT NULL AS has_track, a.id AS aircraft_id, a.serial AS aircraft_serial, a.model AS aircraft_model,
  a.name AS aircraft_name, b.id AS battery_id, b.serial AS battery_serial, c.serial AS controller_serial, NULL AS tags
  FROM flights f LEFT JOIN aircraft a ON a.id = f.aircraft_id LEFT JOIN batteries b ON b.id = f.battery_id LEFT JOIN controllers c ON c.id = f.controller_id`;

/** Returns the stored track (gzip JSON) for Ops to pass through to the browser. */
export async function getTelemetry(env, actor, flightId) {
  const scope = viewScope(actor);
  const row = await env.LOGS_DB.prepare('SELECT telemetry_key, pilot_id FROM flights WHERE id = ?').bind(String(flightId)).first();
  if (!row?.telemetry_key || (!scope.all && row.pilot_id !== scope.pilotId)) throw new LogsError('track_not_found', 404, 'This flight has no stored track.');
  const object = await env.LOGS_BUCKET.get(row.telemetry_key);
  if (!object) throw new LogsError('track_not_found', 404, 'This flight has no stored track.');
  return new Uint8Array(await object.arrayBuffer());
}
