// Synthetic equipment only; in-memory SQLite, no server, device, network or external services.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { SqliteD1 } from '../src/sqlite-d1.mjs';
import { migrate } from '../src/migrations.mjs';
import * as service from '../../logs/src/worker/service.mjs';
import { normalizeBatteryReference } from '../../logs/src/battery-reference.mjs';

const editor = { staffId: 'editor', permissions: ['flight_logs.view', 'flight_logs.import'] };
const viewer = { staffId: 'viewer', permissions: ['flight_logs.view'] };
const own = { staffId: 'pilot-one', permissions: [] };

async function fixture(t) {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  migrate(db, fileURLToPath(new URL('../../logs/migrations/', import.meta.url)));
  for (const id of ['air-one', 'air-two']) await db.prepare('INSERT INTO aircraft (id, serial, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, `serial-${id}`, id === 'air-one' ? 'Mini 4 Pro' : 'Mavic 4 Pro', 'now', 'now').run();
  for (const id of ['bat-one', 'bat-two']) await db.prepare('INSERT INTO batteries (id, serial, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .bind(id, `serial-${id}`, 'now', 'now').run();
  for (const [id, aircraft, battery, pilot] of [['flight-one', 'air-one', 'bat-one', 'pilot-one'], ['flight-two', 'air-one', 'bat-two', 'pilot-two'], ['flight-three', 'air-two', 'bat-one', 'pilot-two']])
    await db.prepare(`INSERT INTO flights (id, file_hash, source_system, pilot_id, pilot_attribution, aircraft_id, battery_id, display_name, started_at, created_at, updated_at)
      VALUES (?, ?, 'opendronelog', ?, 'backup_owner', ?, ?, ?, '2026-11-19T12:00:00Z', 'now', 'now')`)
      .bind(id, id.padEnd(64, 'a'), pilot, aircraft, battery, id).run();
  return { LOGS_DB: db };
}

test('battery reference defaults, rename, clear, scoped labels and serial/name search preserve flight history', async t => {
  const env = await fixture(t), db = env.LOGS_DB;
  const before = (await db.prepare('SELECT * FROM flights ORDER BY id').all()).results;
  assert.equal((await service.getFlight(env, viewer, 'flight-one')).battery.referenceName, null);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: '  1  ' });
  const detail = await service.getFlight(env, viewer, 'flight-one');
  assert.equal(detail.battery.referenceName, '1');
  assert.equal(detail.battery.aircraftName, 'Mini 4 Pro');
  assert.equal((await service.getFlight(env, viewer, 'flight-three')).battery.referenceName, null, 'same battery has a distinct reference on another aircraft');
  const facet = (await service.facets(env, viewer)).batteries.find(b => b.aircraftId === 'air-one' && b.id === 'bat-one');
  assert.equal(facet.referenceName, '1');
  assert.equal((await service.listFlights(env, viewer, { q: 'Battery 1' })).total, 1, 'display prefix uses the same canonical reference search');
  assert.equal((await service.listFlights(env, viewer, { q: 'Battery1' })).total, 1);
  assert.equal((await service.listFlights(env, viewer, { q: 'Battery  1' })).total, 1);
  const overview = await service.overview(env, viewer);
  for (const key of ['byBattery', 'batteryHealth']) {
    assert.equal(overview[key].find(b => b.id === 'bat-one').references.find(r => r.aircraftId === 'air-one').referenceName, '1');
    assert.equal(overview[key].length, 2, 'physical battery usage is not split by aircraft');
  }
  assert.equal((await service.listFlights(env, viewer, { q: 'serial-bat-one' })).total, 2);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: 'inspection' });
  assert.equal((await service.listFlights(env, viewer, { q: 'inspection' })).total, 1);
  assert.equal((await service.overview(env, viewer, { q: 'inspection' })).totals.flights, 1);
  assert.equal((await service.listFlights(env, own, { q: 'serial-bat-one' })).total, 1, 'search cannot widen pilot scope');
  assert.equal((await service.facets(env, own)).batteries.length, 1);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: null });
  assert.equal((await service.getFlight(env, viewer, 'flight-one')).battery.referenceName, null);
  assert.deepEqual((await db.prepare('SELECT * FROM flights ORDER BY id').all()).results, before);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'battery.reference'").first()).n, 3);
});

test('same-aircraft names are normalized and unique; other aircraft may reuse names; failures do not audit', async t => {
  const env = await fixture(t);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: 'Pack 1' });
  await assert.rejects(service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-two', referenceName: ' pack 1 ' }), e => e.code === 'battery_name_taken' && e.status === 409);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-two', batteryId: 'bat-one', referenceName: 'Pack 1' });
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).n, 2);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: ' ' });
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-two', referenceName: 'Pack 1' });
});

test('display-equivalent names conflict with 409 under the shared canonical contract', async t => {
  const env = await fixture(t), first = { aircraftId: 'air-one', batteryId: 'bat-one' }, other = { aircraftId: 'air-one', batteryId: 'bat-two' };
  await env.LOGS_DB.prepare("UPDATE flights SET source_file_name = 'Battery   evidence.txt' WHERE id = 'flight-two'").run();
  assert.equal((await service.listFlights(env, viewer, { q: 'Battery   evidence.txt' })).total, 1, 'file search keeps its literal whitespace and prefix');
  assert.equal((await service.listFlights(env, viewer, { q: 'serial-bat-one' })).total, 2, 'serial search keeps its literal query');
  for (const [canonical, variants] of [['1', ['Battery1', 'Battery 1', 'Ｂａｔｔｅｒｙ　１']], ['Pack 1', ['Pack  1', ' Battery Pack  1 ']]]) {
    await service.setBatteryReference(env, editor, { ...first, referenceName: canonical });
    for (const referenceName of variants) {
      assert.equal(normalizeBatteryReference(referenceName), canonical);
      await assert.rejects(service.setBatteryReference(env, editor, { ...other, referenceName }), e => e.code === 'battery_name_taken' && e.status === 409);
    }
  }
  assert.equal(normalizeBatteryReference('Battery Battery1'), '1');
  for (const value of ['Battery', ' Battery ', 'BatteryBattery']) assert.throws(() => normalizeBatteryReference(value));
  assert.equal(normalizeBatteryReference(null), null);
  assert.equal(normalizeBatteryReference('  '), null);
});

test('name conflict maps from the original SQLite error cause without racing a follow-up read', async () => {
  let reads = 0;
  const original = new Error('wrapped D1 failure', { cause: new Error('UNIQUE constraint failed: battery_references.aircraft_id, battery_references.normalized_name') });
  const env = { LOGS_DB: {
    prepare() { return { bind() { return this; }, async first() { reads++; if (reads > 1) throw new Error('racy conflict requery'); return { exists: 1 }; } }; },
    async batch() { throw original; },
  } };
  await assert.rejects(service.setBatteryReference(env, editor, { aircraftId: 'air', batteryId: 'bat', referenceName: '1' }), e => e.code === 'battery_name_taken' && e.status === 409);
  assert.equal(reads, 1);
});

test('physical battery statistics and pilot scope stay unchanged across aircraft and renames', async t => {
  const env = await fixture(t), db = env.LOGS_DB;
  await db.prepare("UPDATE batteries SET max_cycle_count = 17 WHERE id = 'bat-one'").run();
  await db.prepare("UPDATE flights SET duration_seconds = 60, battery_life_percent = 90, started_at = '2026-11-18T12:00:00Z' WHERE id = 'flight-one'").run();
  await db.prepare("UPDATE flights SET duration_seconds = 120, battery_life_percent = 82, started_at = '2026-11-19T12:00:00Z' WHERE id = 'flight-three'").run();
  const baseline = await service.overview(env, viewer);
  const stats = overview => overview.batteryHealth.map(({ references, ...numbers }) => numbers);
  const usage = overview => overview.byBattery.map(({ references, ...numbers }) => numbers);
  await service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: 'Battery1' });
  await service.setBatteryReference(env, editor, { aircraftId: 'air-two', batteryId: 'bat-one', referenceName: 'Pack 2' });
  const renamed = await service.overview(env, viewer);
  assert.deepEqual(stats(renamed), stats(baseline));
  assert.deepEqual(usage(renamed), usage(baseline));
  const pack = renamed.batteryHealth.find(b => b.id === 'bat-one');
  assert.deepEqual([pack.flights, pack.durationSeconds, pack.cycles, pack.lifePercent], [2, 180, 17, 82]);
  assert.deepEqual(pack.references.map(r => r.referenceName), ['1', 'Pack 2']);
  const pilotPack = (await service.overview(env, own)).batteryHealth.find(b => b.id === 'bat-one');
  assert.deepEqual([pilotPack.flights, pilotPack.durationSeconds, pilotPack.lifePercent], [1, 60, 90]);
  assert.deepEqual(pilotPack.references.map(r => r.aircraftId), ['air-one']);
  assert.equal((await service.facets(env, viewer)).batteries.length, 3, 'selector retains aircraft-specific references');
});

test('unnamed aircraft serial fallback is masked consistently in battery labels', async t => {
  const env = await fixture(t);
  await env.LOGS_DB.prepare("UPDATE aircraft SET model = NULL, name = NULL, serial = 'SYNTHETIC-AIRCRAFT-1234' WHERE id = 'air-one'").run();
  assert.equal((await service.getFlight(env, viewer, 'flight-one')).battery.aircraftName, 'Aircraft …1234');
  assert.equal((await service.facets(env, viewer)).batteries.find(b => b.aircraftId === 'air-one').aircraftName, 'Aircraft …1234');
  assert.equal((await service.overview(env, viewer)).batteryHealth.find(b => b.id === 'bat-one').references.find(r => r.aircraftId === 'air-one').aircraftName, 'Aircraft …1234');
});

test('battery naming refuses viewers, unauthenticated actors, malformed values and unrelated equipment', async t => {
  const env = await fixture(t), input = { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: '1' };
  await assert.rejects(service.setBatteryReference(env, viewer, input), e => e.status === 403);
  await assert.rejects(service.setBatteryReference(env, null, input), e => e.status === 401);
  for (const referenceName of [undefined, 1, 'x'.repeat(41), 'bad\nname', 'bad\u200bname'])
    await assert.rejects(service.setBatteryReference(env, editor, { ...input, referenceName }), e => e.status === 400);
  await assert.rejects(service.setBatteryReference(env, editor, { ...input, aircraftId: 'air-two', batteryId: 'bat-two' }), e => e.status === 404);
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM audit_events').first()).n, 0);
});

test('audit failure rolls back the reference mutation', async t => {
  const env = await fixture(t);
  await env.LOGS_DB.exec("CREATE TRIGGER refuse_reference_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END");
  await assert.rejects(service.setBatteryReference(env, editor, { aircraftId: 'air-one', batteryId: 'bat-one', referenceName: '1' }));
  assert.equal((await env.LOGS_DB.prepare('SELECT COUNT(*) AS n FROM battery_references').first()).n, 0);
});
