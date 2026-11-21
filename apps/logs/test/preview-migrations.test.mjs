import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LEDGERS, listMigrations } from '../../logs-local/src/migrations.mjs';
import { SqliteD1 } from '../../logs-local/src/sqlite-d1.mjs';
import { migratePreviewDatabase } from '../dev/preview-migrations.mjs';
import { getFlight, listFlights, overview } from '../src/worker/service.mjs';

const baseline = new URL('../migrations/0001_flight_logs.sql', import.meta.url);
const migrations = listMigrations(fileURLToPath(new URL('../migrations/', import.meta.url)));
const splitFixtureSql = sql => sql.replace(/--.*$/gm, '').split(';');
const schemaObjects = db => db.prepare(
  "SELECT name FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT GLOB 'sqlite_*' ORDER BY name",
).all().then(result => result.results);
const ledgerRows = db => db.prepare(
  `SELECT name, sha256, applied_at FROM ${LEDGERS.logs} ORDER BY name`,
).all().then(result => result.results);
const viewer = { staffId: 'synthetic-preview-pilot', permissions: ['flight_logs.view'] };
const migrate = db => migratePreviewDatabase(db, splitFixtureSql);

async function assertAppliedOnce(db) {
  const before = await ledgerRows(db);
  assert.deepEqual(before.map(({ name, sha256 }) => ({ name, sha256 })),
    migrations.map(({ name, sha256 }) => ({ name, sha256 })));
  await migrate(db);
  assert.deepEqual(await ledgerRows(db), before);
}

test('fresh preview applies the complete Logs chain before the battery-aware reads', async t => {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  await migrate(db);
  await assertAppliedOnce(db);
  assert.deepEqual((await listFlights({ LOGS_DB: db }, viewer)).items, []);
  await overview({ LOGS_DB: db }, viewer);
});

test('legacy 0001-only preview adopts its schema and preserves completed imports and flights', async t => {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  for (const sql of splitFixtureSql(readFileSync(baseline, 'utf8')).map(sql => sql.trim()).filter(Boolean)) {
    await db.prepare(sql).run();
  }
  await db.prepare(`INSERT INTO imports (id, source_system, pilot_id, actor_id, status, expected_flights, started_at)
    VALUES ('synthetic-import', 'opendronelog', ?, ?, 'completed', 1, '2026-01-01')`).bind(viewer.staffId, viewer.staffId).run();
  await db.prepare("INSERT INTO aircraft (id, serial, created_at, updated_at) VALUES ('air', 'synthetic-air', '2026-01-01', '2026-01-01')").run();
  await db.prepare("INSERT INTO batteries (id, serial, created_at, updated_at) VALUES ('bat', 'synthetic-battery', '2026-01-01', '2026-01-01')").run();
  await db.prepare(`INSERT INTO flights (id, file_hash, source_system, import_id, pilot_id, pilot_attribution,
    aircraft_id, battery_id, created_at, updated_at)
    VALUES ('synthetic-flight','synthetic-hash','opendronelog','synthetic-import',?,
      'backup_owner','air','bat','2026-01-01','2026-01-01')`).bind(viewer.staffId).run();
  const readImport = () => db.prepare('SELECT * FROM imports').all();
  const readFlights = () => db.prepare('SELECT * FROM flights').all();
  const before = [(await readImport()).results, (await readFlights()).results];
  await migrate(db);
  await assertAppliedOnce(db);
  assert.deepEqual([(await readImport()).results, (await readFlights()).results], before);
  assert.equal((await listFlights({ LOGS_DB: db }, viewer)).items[0].id, 'synthetic-flight');
  const detail = await getFlight({ LOGS_DB: db }, viewer, 'synthetic-flight');
  assert.equal(detail.battery.serial, 'synthetic-battery');
  assert.equal(detail.battery.referenceName, null);
  await overview({ LOGS_DB: db }, viewer);
});

test('a partial untracked preview is refused without creating a ledger or later tables', async t => {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  await db.prepare('CREATE TABLE flights (id TEXT PRIMARY KEY)').run();
  const before = await schemaObjects(db);
  await assert.rejects(migrate(db), /does not match the complete 0001 migration/);
  assert.deepEqual(await schemaObjects(db), before);
});
