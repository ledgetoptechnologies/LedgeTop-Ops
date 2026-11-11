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
  for (const table of ['audit_events', 'keychains', 'flight_messages', 'flight_tags', 'flights', 'imports', 'controllers', 'batteries', 'aircraft'])
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
  assert.deepEqual(await service.listFlights(env, viewer), { items: [], next: null });
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
  const summary = await service.completeImport(env, importer, importId);
  assert.deepEqual({ ...summary, importId: undefined }, { importId: undefined, pilotId: 'staff-beau', expectedFlights: 2, flightsCreated: 2, flightsExisting: 0, tracksStored: 2 });

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
  assert.equal(again.existing.length, 2);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flight_messages').first()).n, 2, 'messages are not duplicated');
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
  await service.completeImport(env, importer, importId);
  await assert.rejects(service.importFlights(env, importer, importId, { flights: [] }), error => error.code === 'import_closed');
});

test('keychains are refused, not stored in the clear, when the sealing secret is missing', async () => {
  env = await freshEnv({ KEYCHAIN_ENCRYPTION_KEY: undefined });
  const { plan } = await planned();
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 2 });
  await assert.rejects(service.importFlights(env, importer, importId, { flights: plan.flights, keychains: [{ fileHash: hash('a'), key: SECRET_KEY }] }), error => error.code === 'keychain_key_missing');
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM keychains').first()).n, 0);
});

async function planned() { return plannedFlights(); }

test('a flight with more messages than the cap keeps the cap and reports the rest instead of dropping them silently', async () => {
  env = await freshEnv();
  const { plan } = await planned();
  const flight = plan.flights[0], many = Array.from({ length: service.LIMITS.messagesPerFlight + 3 }, (_, i) => ({ sourceFlightId: flight.source.flightId, offsetMs: i, level: 'tip', text: `m${i}` }));
  const { importId } = await service.startImport(env, importer, { sourceSystem: 'opendronelog', pilotId: 'staff-beau', expectedFlights: 1 });
  const result = await service.importFlights(env, importer, importId, { flights: [flight], messages: many });
  assert.equal(result.messagesDropped, 3);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM flight_messages').first()).n, service.LIMITS.messagesPerFlight);
});
