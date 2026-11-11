// Builds the import plan from an opened backup and produces a dry-run report. Pure: no network, no writes.
import { OdlBackupError } from './archive.mjs';
import { IMPORT_SCHEMA, mapFlight, mapMessage, mapTag, manualTags, pilotFor, TELEMETRY_COLUMNS, telemetryValue } from './map.mjs';

export const DRY_RUN_SCHEMA = 'ltds.logs.odl-import-dry-run.v1';
const mask = serial => (serial ? `…${serial.slice(-4)}` : null);
const hours = seconds => Math.round((seconds / 3600) * 10) / 10;

/**
 * Builds flight, equipment, tag and message records. Telemetry and keychains are read separately
 * (streamTelemetry, backup.keychains) because they are large or secret.
 */
export async function buildImport(backup, { pilot }) {
  if (!backup.ok) throw new OdlBackupError('backup_unsupported_layout', backup.validation.errors.join(' '));
  pilotFor(pilot);
  const [flightRows, tagRows, messageRows, customizationRows, equipmentRows, keychainRows] = await Promise.all([
    backup.rows('flights.parquet'),
    backup.rows('flight_tags.parquet'),
    backup.rows('flight_messages.parquet'),
    backup.rows('flight_customizations.parquet'),
    backup.rows('equipment_names.parquet'),
    backup.rows('keychains.parquet', ['file_hash']), // hashes only: key values never leave backup.keychains()
  ]);
  const keychainHashes = new Set(keychainRows.map(row => String(row.file_hash)));
  const customizations = new Map(customizationRows.map(row => [String(row.file_hash), row]));
  const tagsByFlight = new Map();
  for (const row of tagRows) {
    const tag = mapTag(row);
    if (!tag) continue;
    const key = String(row.flight_id), list = tagsByFlight.get(key) ?? [];
    if (!list.some(existing => existing.tag === tag.tag)) list.push(tag);
    tagsByFlight.set(key, list);
  }

  const flights = [], seenHashes = new Map(), duplicates = [];
  for (const row of flightRows) {
    const customization = customizations.get(String(row.file_hash)) ?? null, tags = [...(tagsByFlight.get(String(row.id)) ?? [])];
    for (const tag of manualTags(customization?.manual_tags)) if (!tags.some(existing => existing.tag === tag)) tags.push({ tag, kind: 'manual' });
    const flight = mapFlight(row, { pilot, keychainHashes, customization, tags });
    if (flight.source.fileHash && seenHashes.has(flight.source.fileHash)) { duplicates.push(flight.source.flightId); continue; }
    if (flight.source.fileHash) seenHashes.set(flight.source.fileHash, flight.source.flightId);
    flights.push(flight);
  }

  const names = new Map(equipmentRows.map(row => [String(row.serial), { type: row.equipment_type ? String(row.equipment_type) : null, name: row.display_name ? String(row.display_name) : null }]));
  const equipment = { aircraft: new Map(), batteries: new Map(), controllers: new Map() };
  const note = (map, serial, flight, extra) => {
    if (!serial) return;
    const record = map.get(serial) ?? { serial, flights: 0, seconds: 0, firstFlightAt: null, lastFlightAt: null, ...extra(null) };
    record.flights++; record.seconds += flight.durationSeconds ?? 0;
    if (flight.startedAt && (!record.firstFlightAt || flight.startedAt < record.firstFlightAt)) record.firstFlightAt = flight.startedAt;
    if (flight.startedAt && (!record.lastFlightAt || flight.startedAt > record.lastFlightAt)) record.lastFlightAt = flight.startedAt;
    Object.assign(record, extra(record));
    map.set(serial, record);
  };
  for (const flight of flights) {
    note(equipment.aircraft, flight.aircraft.serial, flight, record => ({
      model: record?.model ?? flight.aircraft.model,
      name: names.get(flight.aircraft.serial)?.name ?? record?.name ?? flight.aircraft.name,
    }));
    note(equipment.batteries, flight.batterySerial, flight, record => ({ maxCycleCount: Math.max(record?.maxCycleCount ?? 0, flight.battery.cycleCount ?? 0) }));
    note(equipment.controllers, flight.controllerSerial, flight, () => ({}));
  }
  // Fill missing models from the aircraft record (many ODL flights lack drone_model), and apply names the
  // pilot gave the aircraft in ODL's equipment list.
  for (const flight of flights) {
    if (!flight.aircraft.serial) continue;
    if (!flight.aircraft.model) flight.aircraft.model = equipment.aircraft.get(flight.aircraft.serial)?.model ?? null;
    const renamed = names.get(flight.aircraft.serial)?.name;
    if (renamed) flight.aircraft.name = renamed;
  }

  const flightIds = new Set(flights.map(flight => flight.source.flightId));
  const messages = messageRows.map(mapMessage).filter(message => message && flightIds.has(message.sourceFlightId));
  return {
    schema: IMPORT_SCHEMA,
    pilot: pilotFor(pilot),
    flights,
    equipment: { aircraft: [...equipment.aircraft.values()], batteries: [...equipment.batteries.values()], controllers: [...equipment.controllers.values()] },
    messages,
    keychainCount: keychainHashes.size,
    duplicateFlightIds: duplicates,
  };
}

/**
 * Streams telemetry one flight at a time as columns ({ offsetMs: [...], latitude: [...], ... }).
 * ODL writes telemetry ordered by flight; an out-of-order file is rejected rather than half-imported.
 */
export async function* streamTelemetry(backup, { flightIds } = {}) {
  const odlColumns = ['flight_id', ...TELEMETRY_COLUMNS.map(([, column]) => column)];
  const present = TELEMETRY_COLUMNS.filter(([, column]) => backup.tables.get('telemetry.parquet')?.columns.includes(column));
  let current = null, columns = null, rowCount = 0;
  const finished = new Set();
  const flush = () => (current == null || (flightIds && !flightIds.has(current)) ? null : { sourceFlightId: current, rowCount, columns });
  for (const range of backup.telemetryRowGroups()) {
    for (const row of await backup.telemetryRows(odlColumns, range)) {
      const flightId = String(row.flight_id);
      if (flightId !== current) {
        const done = flush();
        if (current != null) finished.add(current);
        if (finished.has(flightId)) throw new OdlBackupError('telemetry_unordered', 'Telemetry in this backup is not grouped by flight, so it cannot be imported safely.');
        if (done) yield done;
        current = flightId; rowCount = 0; columns = Object.fromEntries(present.map(([name]) => [name, []]));
      }
      for (const [name, column] of present) columns[name].push(telemetryValue(name, row[column]));
      rowCount++;
    }
  }
  const last = flush();
  if (last) yield last;
}

/** Counts telemetry per flight using only the flight_id column (fast; used by the dry run). */
export async function telemetryCounts(backup) {
  const counts = new Map(), finished = new Set();
  let current = null, ordered = true;
  for (const range of backup.telemetryRowGroups()) {
    for (const row of await backup.telemetryRows(['flight_id'], range)) {
      const flightId = String(row.flight_id);
      if (flightId !== current) { if (current != null) finished.add(current); if (finished.has(flightId)) ordered = false; current = flightId; }
      counts.set(flightId, (counts.get(flightId) ?? 0) + 1);
    }
  }
  return { counts, ordered };
}

/**
 * Dry-run report: what an import would create, with nothing written. Serials are masked to the last
 * four characters and keychain values are never read. `existing` lists what the logs service already holds.
 */
export async function dryRun(backup, { pilot, existing = {} } = {}) {
  const report = {
    schema: DRY_RUN_SCHEMA,
    importSchema: IMPORT_SCHEMA,
    pilot: pilot?.id ? pilotFor(pilot) : null,
    files: backup.summary(),
    validation: { ok: backup.ok, errors: [...backup.validation.errors], warnings: [...backup.validation.warnings] },
  };
  if (!backup.ok) return report;
  if (!report.pilot) { report.validation.ok = false; report.validation.errors.push('Choose which pilot this backup belongs to before importing.'); return report; }

  const plan = await buildImport(backup, { pilot });
  const { counts, ordered } = await telemetryCounts(backup);
  const known = { hashes: new Set(existing.fileHashes ?? []), aircraft: new Set(existing.aircraftSerials ?? []), batteries: new Set(existing.batterySerials ?? []), controllers: new Set(existing.controllerSerials ?? []) };
  const isNew = flight => !flight.source.fileHash || !known.hashes.has(flight.source.fileHash);
  const fresh = plan.flights.filter(isNew), starts = plan.flights.map(flight => flight.startedAt).filter(Boolean).sort();
  const totalSeconds = plan.flights.reduce((sum, flight) => sum + (flight.durationSeconds ?? 0), 0);
  const flightIds = new Set(plan.flights.map(flight => flight.source.flightId));
  const orphanTelemetry = [...counts.keys()].filter(flightId => !flightIds.has(flightId));
  const withoutTelemetry = plan.flights.filter(flight => !counts.has(flight.source.flightId));
  const mismatched = plan.flights.filter(flight => counts.has(flight.source.flightId) && flight.telemetryPointCount && counts.get(flight.source.flightId) !== flight.telemetryPointCount);
  const equipmentSummary = (list, set, extra = () => ({})) => ({
    total: list.length, matched: list.filter(item => set.has(item.serial)).length, new: list.filter(item => !set.has(item.serial)).length,
    items: list.map(item => ({ serial: mask(item.serial), flights: item.flights, hours: hours(item.seconds), firstFlightAt: item.firstFlightAt, lastFlightAt: item.lastFlightAt, existing: set.has(item.serial), ...extra(item) }))
      .sort((a, b) => b.flights - a.flights),
  });
  const messageLevels = {};
  for (const message of plan.messages) messageLevels[message.level] = (messageLevels[message.level] ?? 0) + 1;
  const tagCounts = {};
  for (const flight of plan.flights) for (const tag of flight.tags) tagCounts[tag.tag] = (tagCounts[tag.tag] ?? 0) + 1;

  if (!ordered) report.validation.errors.push('Telemetry in this backup is not grouped by flight, so it cannot be imported safely.');
  if (plan.duplicateFlightIds.length) report.validation.warnings.push(`${plan.duplicateFlightIds.length} duplicate flight(s) with the same log fingerprint will be imported once.`);
  if (orphanTelemetry.length) report.validation.warnings.push(`Telemetry for ${orphanTelemetry.length} flight(s) has no matching flight and will be skipped.`);
  if (withoutTelemetry.length) report.validation.warnings.push(`${withoutTelemetry.length} flight(s) have no telemetry track.`);
  if (mismatched.length) report.validation.warnings.push(`${mismatched.length} flight(s) have a different number of telemetry points than OpenDroneLog recorded.`);
  report.validation.ok = report.validation.errors.length === 0;

  Object.assign(report, {
    flights: {
      total: plan.flights.length, new: fresh.length, alreadyImported: plan.flights.length - fresh.length,
      firstFlightAt: starts[0] ?? null, lastFlightAt: starts.at(-1) ?? null, hours: hours(totalSeconds),
      withoutAircraftSerial: plan.flights.filter(flight => !flight.aircraft.serial).length,
    },
    equipment: {
      aircraft: equipmentSummary(plan.equipment.aircraft, known.aircraft, item => ({ model: item.model, name: item.name })),
      batteries: equipmentSummary(plan.equipment.batteries, known.batteries, item => ({ maxCycleCount: item.maxCycleCount || null })),
      controllers: equipmentSummary(plan.equipment.controllers, known.controllers),
    },
    telemetry: { rows: [...counts.values()].reduce((a, b) => a + b, 0), flightsWithTrack: plan.flights.length - withoutTelemetry.length, flightsWithoutTrack: withoutTelemetry.length, ordered },
    messages: { total: plan.messages.length, byLevel: messageLevels },
    tags: Object.entries(tagCounts).map(([tag, flights]) => ({ tag, flights })).sort((a, b) => b.flights - a.flights),
    rawLogCoverage: {
      rawLogsInBackup: 0, // ODL backups hold parsed data only, never the original DJI .txt logs
      flightsWithKeychain: plan.flights.filter(flight => flight.rawLog.keychainAvailable).length,
      flightsNeedingRawLog: plan.flights.length,
    },
    keychains: { count: plan.keychainCount, note: 'Imported encrypted for the log parser only; values are never shown.' },
  });
  return report;
}
