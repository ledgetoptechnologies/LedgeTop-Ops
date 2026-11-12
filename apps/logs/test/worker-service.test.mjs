import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import { Miniflare } from 'miniflare';
import * as service from '../src/worker/service.mjs';
import { decryptKeychain } from '../src/worker/keychain-crypto.mjs';
import { openOdlBackup, buildImport, streamTelemetry } from '../src/odl/index.mjs';
import { backup, FLIGHTS, SECRET_KEY } from './fixture.mjs';

const importer = { staffId: 'staff-beau', permissions: ['flight_logs.view', 'flight_logs.import'] };
const viewer = { staffId: 'staff-viewer', permissions: ['flight_logs.view'] };
const SEAL_KEY = Buffer.alloc(32, 7).toString('base64');
const hash = letter => letter.repeat(64);
let runtime, env;

async function freshEnv(extra = {}) {
  const db = await runtime.getD1Database('LOGS_DB'), bucket = await runtime.getR2Bucket('LOGS_BUCKET');
  for (const table of ['audit_events', 'keychains', 'flight_messages', 'flight_tags', 'import_items', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
    await db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
  const sql = fs.readFileSync(new URL('../migrations/0001_flight_logs.sql', import.meta.url), 'utf8').replace(/--.*$/gm, '');
  for (const statement of sql.split(';').map(part => part.trim()).filter(Boolean)) await db.prepare(statement).run();
  return { LOGS_DB: db, LOGS_BUCKET: bucket, KEYCHAIN_ENCRYPTION_KEY: SEAL_KEY, ...extra };
}

/** The synthetic backup's flights, with hex fingerprints like real ODL hashes. */
async function plannedFlights(pilotId = 'staff-beau') {
  // Same shape as the fixture (flight 103 duplicates 101's fingerprint), with hex fingerprints like real ODL hashes.
  const fixtureFlights = FLIGHTS.map((flight, index) => ({ ...flight, file_hash: hash(['a', 'b', 'a'][index]) }));
  const opened = openOdlBackup(backup({ flights: fixtureFlights, keychainHash: hash('a'), customizedHash: hash('b') }));
  return { opened, plan: await buildImport(opened, { pilot: { id: pilotId } }) };
}

before(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: '2026-07-22', script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: { LOGS_DB: 'logs-test' }, r2Buckets: { LOGS_BUCKET: 'logs-test' } });
});
after(async () => { await runtime?.dispose(); });

test('permissions are checked on every call, even behind the Ops binding', async () => {
  env = await freshEnv();
  await assert.rejects(service.inventory(env, null), error => error.code === 'unauthenticated');
  await assert.rejects(service.inventory(env, viewer), error => error.code === 'forbidden' && /import flight logs/.test(error.message));
  await assert.rejects(service.listFlights(env, { staffId: 'x', permissions: [] }), error => error.code === 'forbidden');
  assert.deepEqual(await service.listFlights(env, viewer), { items: [], next: null, total: 0 });
});

test('a full import stores flights, equipment, tags, messages, tracks and sealed keychains, then lists them', async () => {
  env = await freshEnv();
  const { opened, plan } = await planned();
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: plan.flights.length });
  const keychains = (await opened.keychains()).map(item => ({ fileHash: item.fileHash, key: item.key.reveal(), fetchedAt: item.fetchedAt }));
  const result = await service.importFlights(env, importer, importId, { flights: plan.flights, messages: plan.messages, keychains });
  assert.equal(result.created.length, 2);
  assert.equal(result.existing.length, 0);
  assert.equal(result.keychainsStored, 1);

  const ids = new Map(result.created.map(item => [item.sourceFlightId, item.flightId]));
  for await (const track of streamTelemetry(opened, { flightIds: new Set(ids.keys()) })) {
    const body = gzipSync(JSON.stringify({ schema: 'ltds.logs.telemetry.v1', ...track }));
    assert.deepEqual(await service.putTelemetry(env, importer, importId, ids.get(track.sourceFlightId), body), { flightId: ids.get(track.sourceFlightId), stored: true });
  }
  const summary = await service.completeImport(env, importer, importId, { tracksExpected: 2 });
  assert.deepEqual({ ...summary, importId: undefined }, { importId: undefined, pilotId: 'staff-beau', expectedFlights: 2, flightsCreated: 2, flightsResumed: 0, flightsExisting: 0, tracksStored: 2 });

  const list = await service.listFlights(env, viewer);
  assert.deepEqual(list.items.map(item => item.displayName), ['Renamed inspection', 'Roof survey'], 'newest first');
  assert.equal(list.items[1].aircraft.name, 'Big Orange');
  assert.equal(list.items[1].hasTrack, true);
  assert.equal(list.items[1].rawLog, 'missing');
  const detail = await service.getFlight(env, viewer, ids.get('101'));
  assert.deepEqual(detail.tags, [{ tag: 'Client A', kind: 'manual' }, { tag: 'High Speed', kind: 'auto' }]);
  assert.deepEqual(detail.messages, [{ offsetMs: 50, level: 'warn', text: 'Strong wind' }]);
  const track = JSON.parse(gunzipSync(await service.getTelemetry(env, viewer, ids.get('101'))).toString());
  assert.deepEqual(track.columns.offsetMs, [0, 100, 200]);

  const sealed = await env.LOGS_DB.prepare('SELECT * FROM keychains').first();
  assert.equal(sealed.file_hash, hash('a'));
  assert.equal(JSON.stringify(sealed).includes(SECRET_KEY), false, 'the key is stored encrypted');
  assert.equal(await decryptKeychain(env, sealed), SECRET_KEY);
  const aircraft = (await env.LOGS_DB.prepare('SELECT serial, model, name, status FROM aircraft').all()).results;
  assert.deepEqual(aircraft, [{ serial: 'AIRCRAFT0001', model: 'Matrice30', name: 'Big Orange', status: 'unconfirmed' }]);
  const audit = (await env.LOGS_DB.prepare('SELECT action FROM audit_events ORDER BY at').all()).results.map(row => row.action);
  assert.deepEqual(audit, ['import.started', 'import.completed']);
});

test('re-importing the same backup creates nothing new and the inventory reports what exists', async () => {
  const { plan } = await planned();
  const inventory = await service.inventory(env, importer);
  assert.deepEqual(inventory.fileHashes.sort(), [hash('a'), hash('b')]);
  assert.deepEqual(inventory.aircraftSerials, ['AIRCRAFT0001']);
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 2 });
  const again = await service.importFlights(env, importer, importId, { flights: plan.flights, messages: plan.messages });
  assert.equal(again.created.length, 0);
  assert.equal(again.resumed.length, 0, 'flights from a finished import are not resumed');
  assert.equal(again.existing.length, 2);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flight_messages').first()).n, 2, 'messages are not duplicated');
  await assert.rejects(service.putTelemetry(env, importer, importId, again.existing[0].flightId, gzipSync('{}')), error => error.code === 'flight_not_in_import', 'a duplicate takes no track');
  const summary = await service.completeImport(env, importer, importId, { tracksExpected: 0 });
  assert.equal(summary.flightsExisting, 2);
});

test('imports are guarded: pilot, owner, batch size, record format, closed imports and tracks', async () => {
  env = await freshEnv();
  const { plan } = await planned();
  await assert.rejects(service.startImport(env, importer, { sourceSystem: 'airdata', pilotId: 'staff-beau', expectedFlights: 1 }), error => error.code === 'unsupported_source');
  await assert.rejects(service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: '', expectedFlights: 1 }), error => error.code === 'pilot_required');
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-kollin', expectedFlights: 2 });
  await assert.rejects(service.importFlights(env, importer, importId, { flights: plan.flights }), error => error.code === 'pilot_mismatch', 'flights must carry the import pilot');
  const other = { staffId: 'staff-other', permissions: importer.permissions };
  await assert.rejects(service.importFlights(env, other, importId, { flights: [] }), error => error.code === 'forbidden');
  await assert.rejects(service.importFlights(env, importer, importId, { flights: Array(101).fill(plan.flights[0]) }), error => error.code === 'batch_too_large');
  await assert.rejects(service.importFlights(env, importer, importId, { flights: [{ ...plan.flights[0], source: { fileHash: 'not-a-sha' } }] }), error => error.code === 'invalid_flight');
  await assert.rejects(service.putTelemetry(env, importer, importId, 'missing', gzipSync('{}')), error => error.code === 'flight_not_in_import');
  await assert.rejects(service.putTelemetry(env, importer, importId, 'missing', new TextEncoder().encode('{}')), error => error.code === 'telemetry_not_gzip');
  await assert.rejects(service.completeImport(env, importer, importId, {}), error => error.code === 'invalid_import', 'the track count is required');
  await assert.rejects(service.completeImport(env, importer, importId, { tracksExpected: 0 }), error => error.code === 'import_incomplete', 'no flights were handled');
  const empty = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-kollin', expectedFlights: 0 });
  await service.completeImport(env, importer, empty.importId, { tracksExpected: 0 });
  await assert.rejects(service.importFlights(env, importer, empty.importId, { flights: [] }), error => error.code === 'import_closed');
});

test('keychains are refused, not stored in the clear, when the sealing secret is missing', async () => {
  env = await freshEnv({ KEYCHAIN_ENCRYPTION_KEY: undefined });
  const { plan } = await planned();
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 2 });
  await assert.rejects(service.importFlights(env, importer, importId, { flights: plan.flights, messages: plan.messages, keychains: [{ fileHash: hash('a'), key: SECRET_KEY }] }), error => error.code === 'keychain_key_missing');
  for (const table of ['keychains', 'flights', 'flight_messages', 'flight_tags', 'import_items'])
    assert.equal((await env.LOGS_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n, 0, `${table}: nothing is written before the keys are sealed`);
  // Once the secret is configured, retrying the same batch stores everything.
  env.KEYCHAIN_ENCRYPTION_KEY = SEAL_KEY;
  const retry = await service.importFlights(env, importer, importId, { flights: plan.flights, messages: plan.messages, keychains: [{ fileHash: hash('a'), key: SECRET_KEY }] });
  assert.equal(retry.created.length, 2);
  assert.equal(retry.keychainsStored, 1);
});

test('an interrupted import is resumed by the next run: no duplicates, and the missing tracks are stored', async () => {
  env = await freshEnv();
  const { opened, plan } = await planned();
  // First attempt: flights are stored, then the browser stops before sending any track.
  const first = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: plan.flights.length });
  const stored = await service.importFlights(env, importer, first.importId, { flights: plan.flights, messages: plan.messages });
  assert.equal(stored.created.length, 2);
  await assert.rejects(service.completeImport(env, importer, first.importId, { tracksExpected: 2 }), error => error.code === 'import_incomplete' && /0 of 2 tracks/.test(error.message));
  // A replayed batch in the same run counts once and hands the same flights back for their tracks.
  const replay = await service.importFlights(env, importer, first.importId, { flights: plan.flights, messages: plan.messages });
  assert.deepEqual(replay.resumed.map(item => item.flightId).sort(), stored.created.map(item => item.flightId).sort());

  // Another importer's run never adopts these flights.
  const other = { staffId: 'staff-other', permissions: importer.permissions };
  const foreign = await service.startImport(env, other, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: plan.flights.length });
  const seen = await service.importFlights(env, other, foreign.importId, { flights: plan.flights });
  assert.equal(seen.resumed.length, 0);
  assert.equal(seen.existing.length, 2);

  // Second run by the same person: nothing is written twice, and both flights come back to take their track.
  const second = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: plan.flights.length });
  assert.equal((await env.LOGS_DB.prepare('SELECT status FROM imports WHERE id = ?').bind(first.importId).first()).status, 'abandoned');
  await assert.rejects(service.putTelemetry(env, importer, first.importId, stored.created[0].flightId, gzipSync('{}')), error => error.code === 'import_closed');
  const again = await service.importFlights(env, importer, second.importId, { flights: plan.flights, messages: plan.messages });
  assert.equal(again.created.length, 0);
  assert.equal(again.existing.length, 0);
  const ids = new Map(again.resumed.map(item => [item.sourceFlightId, item.flightId]));
  assert.deepEqual([...ids.values()].sort(), stored.created.map(item => item.flightId).sort(), 'the same stored flights are resumed');
  for await (const track of streamTelemetry(opened, { flightIds: new Set(ids.keys()) }))
    await service.putTelemetry(env, importer, second.importId, ids.get(track.sourceFlightId), gzipSync(JSON.stringify(track)));
  const summary = await service.completeImport(env, importer, second.importId, { tracksExpected: 2 });
  assert.deepEqual([summary.flightsCreated, summary.flightsResumed, summary.flightsExisting, summary.tracksStored], [2, 2, 0, 2]);

  const count = async table => (await env.LOGS_DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first()).n;
  assert.equal(await count('flights'), 2);
  assert.equal(await count('flight_messages'), 2, 'messages were written once');
  const list = await service.listFlights(env, viewer);
  assert.deepEqual(list.items.map(item => item.hasTrack), [true, true]);
});

async function planned() { return plannedFlights(); }

test('a flight with more messages than the cap keeps the cap and reports the rest instead of dropping them silently', async () => {
  env = await freshEnv();
  const { plan } = await planned();
  // The real cap is 50,000; a small cap exercises the same path without 50,000 local D1 writes.
  const realCap = service.LIMITS.messagesPerFlight;
  service.LIMITS.messagesPerFlight = 40;
  try {
    const flight = plan.flights[0], many = Array.from({ length: 43 }, (_, i) => ({ sourceFlightId: flight.source.flightId, offsetMs: i, level: 'tip', text: `m${i}` }));
    const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 });
    const result = await service.importFlights(env, importer, importId, { flights: [flight], messages: many });
    assert.equal(result.messagesDropped, 3);
    assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flight_messages').first()).n, 40);
  } finally { service.LIMITS.messagesPerFlight = realCap; }
  assert.equal(service.LIMITS.messagesPerFlight, 50_000);
});

test('a different file for a flight already stored (same aircraft, start within 10 s) is rejected, not imported twice', async () => {
  env = await freshEnv();
  const { plan } = await planned();
  const first = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 });
  await service.importFlights(env, importer, first.importId, { flights: [plan.flights[0]] });
  const copy = { ...plan.flights[0], source: { ...plan.flights[0].source, fileHash: hash('d'), flightId: '901' }, startedAt: new Date(Date.parse(plan.flights[0].startedAt) + 3_000).toISOString() };
  const second = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 });
  const result = await service.importFlights(env, importer, second.importId, { flights: [copy] });
  assert.equal(result.created.length, 0);
  assert.deepEqual(result.existing.map(item => [item.sourceFlightId, item.reason]), [['901', 'same_aircraft_and_start']]);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flights').first()).n, 1);
  const inventory = await service.inventory(env, importer);
  assert.deepEqual(inventory.flightStarts, [['AIRCRAFT0001', plan.flights[0].startedAt]]);
});

test('flight list filters, facets and the overview agree on the same filtered flights', async () => {
  env = await freshEnv();
  const { plan } = await planned();
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: plan.flights.length });
  await service.importFlights(env, importer, importId, { flights: plan.flights, messages: plan.messages });

  const all = await service.listFlights(env, viewer, {});
  assert.equal(all.total, 2);
  assert.ok(all.items.every(item => Array.isArray(item.tags)));
  const facets = await service.facets(env, viewer);
  assert.deepEqual(facets.aircraft.map(item => [item.serial, item.flights]), [['AIRCRAFT0001', 2]]);
  assert.ok(facets.tags.some(item => item.tag === 'Client A'));
  assert.equal(facets.pilots[0].id, 'staff-beau');

  // A tag filter narrows the list and the overview the same way.
  const tagged = await service.listFlights(env, viewer, { tag: 'Client A' });
  assert.equal(tagged.total, 1);
  assert.deepEqual(tagged.items[0].tags.includes('Client A'), true);
  const overview = await service.overview(env, viewer, { tag: 'Client A' });
  assert.equal(overview.totals.flights, 1);
  assert.deepEqual(overview.longest.map(item => item.id), [tagged.items[0].id]);

  // Range filters are inclusive and in metric; malformed values are ignored, not errors.
  const longest = Math.max(...all.items.map(item => item.durationSeconds ?? 0));
  assert.equal((await service.listFlights(env, viewer, { minDuration: longest })).total, 1);
  assert.equal((await service.listFlights(env, viewer, { minDuration: 'abc', aircraft: 'not a valid id!' })).total, 2);
  // Search escapes LIKE wildcards instead of matching everything.
  assert.equal((await service.listFlights(env, viewer, { q: '%' })).total, 0);
  // Dates bound the start day inclusively.
  const day = all.items[0].startedAt.slice(0, 10);
  assert.ok((await service.listFlights(env, viewer, { from: day, to: day })).total >= 1);
  assert.equal((await service.listFlights(env, viewer, { from: '2999-01-01' })).total, 0);

  // Viewers only: the import permission alone isn't enough, and no actor is refused.
  await assert.rejects(service.overview(env, { staffId: 'x', permissions: ['flight_logs.import'] }), error => error.code === 'forbidden');
  await assert.rejects(service.facets(env, null), error => error.code === 'unauthenticated');
});
