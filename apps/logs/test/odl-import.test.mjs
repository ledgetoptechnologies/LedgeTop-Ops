import test from 'node:test';
import assert from 'node:assert/strict';
import { inspect } from 'node:util';
import { gzipSync } from 'node:zlib';
import { openOdlBackup, dryRun, buildImport, streamTelemetry, OdlBackupError, IMPORT_SCHEMA } from '../src/odl/index.mjs';
import { backup, SECRET_KEY, TELEMETRY, flightsTable, telemetryTable, tar, FLIGHTS } from './fixture.mjs';

const pilot = { id: 'pilot-beau' };

test('a gzip tar of Parquet opens and validates; plain tar works too', () => {
  for (const gzip of [true, false]) {
    const opened = openOdlBackup(backup({ gzip }));
    assert.equal(opened.ok, true, opened.validation.errors.join('; '));
    assert.deepEqual(opened.summary().find(file => file.name === 'flights.parquet'), { name: 'flights.parquet', rows: 3 });
  }
});

test('non-backups are refused with stable codes and plain wording', () => {
  const sqlite = new Uint8Array(1024); sqlite.set(new TextEncoder().encode('SQLite format 3\0'));
  assert.throws(() => openOdlBackup(sqlite), error => error instanceof OdlBackupError && error.code === 'backup_unsupported_sqlite' && /OpenDroneLog backup/.test(error.message));
  assert.throws(() => openOdlBackup(gzipSync(new TextEncoder().encode('hello'))), error => error.code === 'backup_not_odl');
  assert.throws(() => openOdlBackup(new Uint8Array([0x1f, 0x8b, 1, 2, 3])), error => error.code === 'backup_corrupt');
  const archive = tar({ 'flights.parquet': flightsTable(FLIGHTS) });
  assert.throws(() => openOdlBackup(archive.subarray(0, 700)), error => error.code === 'backup_truncated');
  assert.throws(() => openOdlBackup(tar({ '../evil.parquet': new Uint8Array(4) })), error => error.code === 'backup_unsafe_path');
});

test('missing tables or columns block the import; extra columns and unknown files only warn', async () => {
  const noTelemetry = openOdlBackup(backup({ omit: ['telemetry.parquet'] }));
  assert.equal(noTelemetry.ok, false);
  assert.match(noTelemetry.validation.errors[0], /telemetry\.parquet is missing/);
  const report = await dryRun(noTelemetry, { pilot });
  assert.equal(report.validation.ok, false);
  assert.equal(report.flights, undefined, 'no counts are reported for an unsupported backup');
  await assert.rejects(buildImport(noTelemetry, { pilot }), error => error.code === 'backup_unsupported_layout');

  const extra = openOdlBackup(backup({ extra: { 'future_table.parquet': flightsTable(FLIGHTS) }, omit: ['keychains.parquet'] }));
  assert.equal(extra.ok, true);
  assert.ok(extra.validation.warnings.some(warning => /future_table\.parquet is not a known/.test(warning)));
  assert.ok(extra.validation.warnings.some(warning => /keychains\.parquet is missing/.test(warning)));
});

test('every flight needs an explicit pilot; the dry run says so instead of guessing', async () => {
  const opened = openOdlBackup(backup());
  const report = await dryRun(opened, {});
  assert.equal(report.validation.ok, false);
  assert.match(report.validation.errors.join(' '), /Choose which pilot/);
  await assert.rejects(buildImport(opened, { pilot: {} }), /explicit pilot/);
});

test('flights map to the v1 contract: units, customizations, tags, dedupe and model fill', async () => {
  const plan = await buildImport(openOdlBackup(backup()), { pilot });
  assert.equal(plan.schema, IMPORT_SCHEMA);
  assert.deepEqual(plan.duplicateFlightIds, ['103'], 'the second log with the same fingerprint is imported once');
  const [first, second] = plan.flights;
  assert.deepEqual(first.source, { system: 'opendronelog', flightId: '101', fileHash: 'hash-a', fileName: 'DJIFlightRecord_2026-05-01_[14-00-00].txt', importedAtSource: '2026-05-01T14:00:00.000Z' });
  assert.deepEqual(first.pilot, { id: 'pilot-beau', attribution: 'backup_owner' });
  assert.equal(first.visibility, 'staff');
  assert.equal(first.startedAt, '2026-05-01T14:00:00.000Z');
  assert.equal(first.durationSeconds, 600);
  assert.equal(first.distanceMeters, 1200.5);
  assert.deepEqual(first.home, { latitude: 43.1, longitude: -88.9 });
  assert.deepEqual(first.aircraft, { serial: 'AIRCRAFT0001', model: 'Matrice30', name: 'Big Orange' }, 'the ODL equipment name wins over the log name');
  assert.deepEqual(first.battery, { cycleCount: 20, lifePercent: 95 });
  assert.deepEqual(first.tags, [{ tag: 'High Speed', kind: 'auto' }, { tag: 'Client A', kind: 'manual' }]);
  assert.deepEqual(first.rawLog, { status: 'missing', keychainAvailable: true });
  assert.equal(second.displayName, 'Renamed inspection', 'customization overrides the name');
  assert.equal(second.notes, 'Gusty');
  assert.equal(second.home, null, '0,0 is treated as no home point');
  assert.equal(second.aircraft.model, 'Matrice30', 'missing model is filled from the same aircraft');
  assert.deepEqual(second.tags, [{ tag: 'Training', kind: 'manual' }]);
  assert.equal(second.rawLog.keychainAvailable, false);
  const aircraft = plan.equipment.aircraft.find(item => item.serial === 'AIRCRAFT0001');
  assert.equal(aircraft.name, 'Big Orange', 'equipment_names gives the display name');
  assert.equal(aircraft.flights, 2);
  assert.deepEqual(plan.messages.map(message => [message.sourceFlightId, message.level, message.text]), [['101', 'warn', 'Strong wind'], ['102', 'tip', 'Unknown level']]);
});

test('telemetry streams one flight at a time as columns, skipping flights not being imported', async () => {
  const opened = openOdlBackup(backup());
  const tracks = [];
  for await (const track of streamTelemetry(opened, { flightIds: new Set(['101', '102']) })) tracks.push(track);
  assert.deepEqual(tracks.map(track => [track.sourceFlightId, track.rowCount]), [['101', 3], ['102', 2]]);
  assert.deepEqual(tracks[0].columns.offsetMs, [0, 100, 200]);
  assert.deepEqual(tracks[0].columns.isPhoto, [false, true, false]);
  assert.deepEqual(tracks[0].columns.cellVoltages, ['[4.2,4.2]', '[4.1,4.1]', null]);
  assert.equal('rcAileron' in tracks[0].columns, false, 'columns the backup lacks are omitted, not invented');
});

test('telemetry that is not grouped by flight is refused instead of half-imported', async () => {
  const shuffled = [TELEMETRY[0], TELEMETRY[3], TELEMETRY[1]];
  const opened = openOdlBackup(backup({ telemetry: shuffled }));
  await assert.rejects(async () => { for await (const _ of streamTelemetry(opened)) { /* drain */ } }, error => error.code === 'telemetry_unordered');
  const report = await dryRun(opened, { pilot });
  assert.equal(report.validation.ok, false);
  assert.equal(report.telemetry.ordered, false);
});

test('the dry run counts flights an interrupted import left without a track, for this pilot only', async () => {
  const opened = openOdlBackup(backup());
  const existing = { fileHashes: ['hash-a', 'hash-b'], resumable: [{ fileHash: 'hash-a', pilotId: pilot.id }, { fileHash: 'hash-b', pilotId: 'someone-else' }] };
  const report = await dryRun(opened, { pilot, existing });
  assert.deepEqual([report.flights.total, report.flights.new, report.flights.alreadyImported, report.flights.resumable], [2, 0, 2, 1]);
  assert.equal((await dryRun(openOdlBackup(backup()), { pilot, existing: { fileHashes: ['hash-a'] } })).flights.resumable, 0, 'none without the inventory entry');
  // An interrupted flight whose track isn't in this backup can't be finished from it: reported, not offered.
  const both = { fileHashes: ['hash-a', 'hash-b'], resumable: [{ fileHash: 'hash-a', pilotId: pilot.id }, { fileHash: 'hash-b', pilotId: pilot.id }] };
  const noTrackFor102 = await dryRun(openOdlBackup(backup({ telemetry: TELEMETRY.filter(sample => sample.flight_id !== 102) })), { pilot, existing: both });
  assert.deepEqual([noTrackFor102.flights.resumable, noTrackFor102.flights.resumableWithoutTrack], [1, 1]);
});

test('the dry run counts new versus existing, masks serials and never exposes decryption keys', async () => {
  const opened = openOdlBackup(backup());
  const report = await dryRun(opened, { pilot, existing: { fileHashes: ['hash-b'], aircraftSerials: ['AIRCRAFT0001'] } });
  assert.equal(report.validation.ok, true, report.validation.errors.join('; '));
  assert.deepEqual([report.flights.total, report.flights.new, report.flights.alreadyImported], [2, 1, 1]);
  assert.equal(report.flights.hours, 0.3);
  assert.deepEqual([report.equipment.aircraft.total, report.equipment.aircraft.matched, report.equipment.aircraft.new], [1, 1, 0]);
  assert.equal(report.equipment.aircraft.items[0].serial, '…0001');
  assert.equal(report.telemetry.rows, 6);
  assert.ok(report.validation.warnings.some(warning => /Telemetry for 1 flight\(s\) has no matching flight/.test(warning)), 'flight 103 was a duplicate, so its track is orphaned');
  assert.ok(report.validation.warnings.some(warning => /1 duplicate flight/.test(warning)));
  assert.deepEqual(report.rawLogCoverage, { rawLogsInBackup: 0, flightsWithKeychain: 1, flightsNeedingRawLog: 2 });
  const serialised = JSON.stringify(report);
  assert.ok(!serialised.includes(SECRET_KEY));
  assert.ok(!serialised.includes('AIRCRAFT0001') && !serialised.includes('BATTERY0001'), 'full serials are masked');
});

test('keychains are only reachable through reveal(); logging and JSON print [redacted]', async () => {
  const [keychain] = await openOdlBackup(backup()).keychains();
  assert.equal(keychain.fileHash, 'hash-a');
  assert.equal(keychain.key.reveal(), SECRET_KEY);
  assert.equal(JSON.stringify(keychain).includes(SECRET_KEY), false);
  assert.equal(inspect(keychain).includes(SECRET_KEY), false);
  assert.equal(`${keychain.key}`, '[redacted]');
});

test('the browser entry opens the same backup from bytes or a Blob with an injected Parquet reader', async () => {
  const { openOdlBackupInBrowser } = await import('../src/odl/browser.mjs');
  const { NODE_PARQUET } = await import('../src/odl/index.mjs');
  const bytes = backup();
  for (const input of [bytes, new Blob([bytes])]) {
    const opened = await openOdlBackupInBrowser(input, NODE_PARQUET);
    assert.equal(opened.ok, true);
    assert.equal((await buildImport(opened, { pilot })).flights.length, 2);
  }
  await assert.rejects(openOdlBackupInBrowser(new Uint8Array([0x1f, 0x8b, 0, 1, 2]), NODE_PARQUET), error => error.code === 'backup_corrupt');
});

test('the browser entry refuses a backup that expands, or is declared, beyond the limit, before allocating it', async () => {
  const { openOdlBackupInBrowser } = await import('../src/odl/browser.mjs');
  const { NODE_PARQUET } = await import('../src/odl/index.mjs');
  // 4 MiB of zeros gzips to a few KiB: a tiny file that would otherwise expand far past the test limit.
  const bomb = gzipSync(new Uint8Array(4 * 1024 * 1024));
  assert.ok(bomb.length < 64 * 1024);
  await assert.rejects(openOdlBackupInBrowser(bomb, NODE_PARQUET, { maxBytes: 1024 * 1024 }), error => error.code === 'backup_too_large');
  await assert.rejects(openOdlBackupInBrowser(new Blob([new Uint8Array(2048)]), NODE_PARQUET, { maxBytes: 1024 }), error => error.code === 'backup_too_large', 'declared Blob size is checked before reading');
  // A real backup under the limit still opens.
  const bytes = backup();
  const opened = await openOdlBackupInBrowser(bytes, NODE_PARQUET, { maxBytes: 64 * 1024 * 1024 });
  assert.equal(opened.ok, true);
});

test('the same flight saved as a different file is rejected: same aircraft, start within 10 seconds', async () => {
  const copy = { ...FLIGHTS[0], id: 104, file_hash: 'hash-copy', display_name: 'Phone copy', start: new Date(FLIGHTS[0].start.getTime() + 5_000), point_count: 1 };
  const later = { ...FLIGHTS[0], id: 105, file_hash: 'hash-later', display_name: 'Next battery', start: new Date(FLIGHTS[0].start.getTime() + 11_000), point_count: 1 };
  const plan = await buildImport(openOdlBackup(backup({ flights: [...FLIGHTS, copy, later] })), { pilot });
  assert.deepEqual(plan.flights.map(flight => flight.source.flightId), ['101', '102', '105'], 'the 5-second copy is dropped; 11 seconds later is a real new flight');
  assert.deepEqual(plan.duplicates, [
    { flightId: '103', duplicateOf: '101', reason: 'same_file' },
    { flightId: '104', duplicateOf: '101', reason: 'same_aircraft_and_start' },
  ]);
  const report = await dryRun(openOdlBackup(backup({ flights: [...FLIGHTS, copy, later] })), { pilot, existing: { flightStarts: [['AIRCRAFT0001', new Date(FLIGHTS[0].start.getTime() + 11_002).toISOString()]] } });
  assert.ok(report.validation.warnings.some(warning => /2 duplicate flight\(s\) will be skipped: 1 with the same log file, 1 with the same aircraft and start time/.test(warning)));
  assert.equal(report.flights.alreadyImported, 1, 'a stored flight on the same aircraft within 10 seconds counts as already imported');
});
