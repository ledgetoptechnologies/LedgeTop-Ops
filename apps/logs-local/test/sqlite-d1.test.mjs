// The D1-shaped SQLite adapter: D1 semantics, atomic batches, and the real Logs device flow on top of it.
// In-memory databases and temp dirs only; synthetic rows; no network, no keys.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteD1, D1Error, D1_MAX_PARAMS, walSafeSqlite } from '../src/sqlite-d1.mjs';
import { migrate, MigrationError } from '../src/migrations.mjs';
import { handleDeviceRequest } from '../../logs/src/worker/device-routes.mjs';
import * as device from '../../logs/src/worker/device.mjs';

const MIGRATIONS = fileURLToPath(new URL('../../logs/migrations/', import.meta.url));

/** A temp dir removed after the test; databases opened through open() are closed first (Windows file locks). */
function scratchDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-local-'));
  const opened = [];
  t.after(() => {
    for (const db of opened) db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, open: file => { const db = new SqliteD1(path.join(dir, file)); opened.push(db); return db; } };
}
function memory(t) {
  const db = new SqliteD1(':memory:');
  t.after(() => db.close());
  return db;
}

test('statements follow D1: first/all/run/raw, meta.changes and last_row_id, immutable bind', async t => {
  const db = memory(t);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, flag INTEGER, blob BLOB)').run();
  const insert = db.prepare('INSERT INTO t (name, flag, blob) VALUES (?, ?, ?)');
  const a = await insert.bind('a', true, new Uint8Array([1, 2])).run();
  assert.equal(a.success, true);
  assert.equal(a.meta.changes, 1);
  assert.equal(a.meta.last_row_id, 1);
  await insert.bind('b', false, null).run();
  assert.deepEqual(await db.prepare('SELECT * FROM t WHERE id = ?').bind(1).first(), { id: 1, name: 'a', flag: 1, blob: [1, 2] });
  assert.equal(await db.prepare('SELECT name FROM t WHERE id = 2').first('name'), 'b');
  assert.equal(await db.prepare('SELECT name FROM t WHERE id = 9').first(), null);
  assert.equal(await db.prepare('SELECT name FROM t WHERE id = 9').first('name'), null);
  await assert.rejects(db.prepare('SELECT name FROM t WHERE id = 1').first('nope'), D1Error);
  const all = await db.prepare('SELECT id FROM t ORDER BY id').all();
  assert.deepEqual(all.results, [{ id: 1 }, { id: 2 }]);
  assert.equal(all.meta.changes, 0, 'a read reports no changes');
  assert.deepEqual(await db.prepare('SELECT id, name FROM t ORDER BY id').raw(), [[1, 'a'], [2, 'b']]);
  assert.deepEqual(await db.prepare('SELECT id FROM t ORDER BY id').raw({ columnNames: true }), [['id'], [1], [2]]);
  const update = await db.prepare('UPDATE t SET flag = 1').run();
  assert.equal(update.meta.changes, 2);
  const returning = await db.prepare('UPDATE t SET flag = 0 WHERE id = ? RETURNING id').bind(2).run();
  assert.deepEqual(returning.results, [{ id: 2 }]);
  assert.equal(returning.meta.changes, 1);
});

test('meta.changes counts only the statement\'s own rows, not foreign-key cascades', async t => {
  const db = memory(t);
  await db.prepare('CREATE TABLE p (id INTEGER PRIMARY KEY)').run();
  await db.prepare('CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id) ON DELETE CASCADE)').run();
  await db.prepare('INSERT INTO p (id) VALUES (1)').run();
  await db.prepare('INSERT INTO c (p) VALUES (1), (1), (1)').run();
  assert.equal((await db.prepare('DELETE FROM p WHERE id = 1').run()).meta.changes, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM c').first()).n, 0);
  assert.equal((await db.prepare('SELECT 1').run()).meta.changes, 0, 'a read after a write still reports 0');
  await assert.rejects(db.prepare('INSERT INTO c (p) VALUES (9)').run(), /FOREIGN KEY/);
});

test('bind refuses undefined and more parameters than D1 allows', async t => {
  const db = memory(t);
  assert.throws(() => db.prepare('SELECT ?').bind(undefined), D1Error);
  assert.throws(() => db.prepare('SELECT 1').bind(...Array(D1_MAX_PARAMS + 1).fill(1)), /too many SQL variables/);
  assert.throws(() => db.prepare('SELECT ?').bind({}), D1Error);
  assert.equal((await db.prepare('SELECT 1 AS x').bind(...Array(0)).first()).x, 1);
});

test('batch commits all statements or none', async t => {
  const db = memory(t);
  await db.prepare('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL UNIQUE)').run();
  const results = await db.batch([db.prepare('INSERT INTO t (v) VALUES (?)').bind('x'), db.prepare('INSERT INTO t (v) VALUES (?)').bind('y')]);
  assert.deepEqual(results.map(r => r.meta.changes), [1, 1]);
  await assert.rejects(db.batch([db.prepare('INSERT INTO t (v) VALUES (?)').bind('z'), db.prepare('INSERT INTO t (v) VALUES (?)').bind('x')]),
    /UNIQUE constraint failed/);
  assert.deepEqual((await db.prepare('SELECT v FROM t ORDER BY v').all()).results.map(r => r.v), ['x', 'y'], 'the failed batch left nothing behind');
  assert.deepEqual(await db.batch([]), []);
  await assert.rejects(db.batch(['SELECT 1']), D1Error);
  // The connection is usable after a rollback.
  await db.batch([db.prepare('INSERT INTO t (v) VALUES (?)').bind('z')]);
  assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM t').first()).n, 3);
});

test('batch refuses statements prepared on another database, before touching either', async t => {
  const a = memory(t), b = memory(t);
  for (const db of [a, b]) await db.prepare('CREATE TABLE t (v TEXT)').run();
  await assert.rejects(a.batch([a.prepare('INSERT INTO t (v) VALUES (?)').bind('a'), b.prepare('INSERT INTO t (v) VALUES (?)').bind('b')]),
    /must come from this database/);
  for (const db of [a, b]) assert.equal((await db.prepare('SELECT COUNT(*) AS n FROM t').first()).n, 0);
});

test('only SQLite builds with the WAL-reset fix are accepted for WAL databases', t => {
  for (const ok of ['3.51.3', '3.52.0', '3.53.0', '3.50.7', '3.44.6', '3.44.9']) assert.equal(walSafeSqlite(ok), true, ok);
  for (const bad of ['3.51.2', '3.50.6', '3.45.0', '3.44.5', '3.49.9', '2.99.9', 'x', '']) assert.equal(walSafeSqlite(bad), false, bad);
  const db = memory(t);
  assert.match(db.sqliteVersion, /^3\.\d+\.\d+$/);
  t.diagnostic(`node ${process.version}, embedded sqlite ${db.sqliteVersion}`);
});

test('a closed database refuses work', async t => {
  const db = memory(t);
  db.close();
  db.close();
  assert.equal(db.isOpen, false);
  await assert.rejects(db.prepare('SELECT 1').first(), /closed/);
});

test('a file database uses WAL and enforces foreign keys', async t => {
  const db = scratchDir(t).open('logs.sqlite');
  assert.equal(await db.prepare('PRAGMA journal_mode').first('journal_mode'), 'wal');
  assert.equal(await db.prepare('PRAGMA foreign_keys').first('foreign_keys'), 1);
  assert.equal(await db.prepare('PRAGMA synchronous').first('synchronous'), 2, 'FULL');
  assert.equal(await db.prepare('PRAGMA busy_timeout').first('timeout'), 5000);
  t.diagnostic(`receipt: journal_mode=wal foreign_keys=1 synchronous=2(FULL) busy_timeout=5000 sqlite=${db.sqliteVersion}`);
});

test('migrations apply once, in order, and refuse edited or missing files', async t => {
  const scratch = scratchDir(t), dir = scratch.dir;
  const db = scratch.open('logs.sqlite');
  const first = migrate(db, MIGRATIONS);
  assert.ok(first.applied.length >= 3);
  assert.deepEqual(first.applied, [...first.applied].sort());
  assert.deepEqual(migrate(db, MIGRATIONS).applied, [], 'second run is a no-op');
  for (const table of ['flights', 'devices', 'raw_logs', 'device_sign_ins'])
    assert.ok(await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first(), table);
  db.close();

  const copy = path.join(dir, 'migrations');
  fs.cpSync(MIGRATIONS, copy, { recursive: true });
  const reopened = scratch.open('logs.sqlite');
  const [name] = first.applied;
  const original = fs.readFileSync(path.join(copy, name), 'utf8');
  const flipped = original.includes('\r\n') ? original.replace(/\r\n/g, '\n') : original.replace(/\n/g, '\r\n');
  fs.writeFileSync(path.join(copy, name), flipped);
  assert.deepEqual(migrate(reopened, copy).applied, [], 'CRLF and LF checkouts hash the same');
  fs.appendFileSync(path.join(copy, name), '\n-- edited\n');
  assert.throws(() => migrate(reopened, copy), err => err instanceof MigrationError && err.code === 'migration_changed');
  fs.rmSync(path.join(copy, name));
  assert.throws(() => migrate(reopened, copy), err => err instanceof MigrationError && err.code === 'migration_missing');
  fs.writeFileSync(path.join(copy, 'bad name.sql'), 'SELECT 1;');
  assert.throws(() => migrate(reopened, copy), err => err.code === 'migration_name');
});

test('an edited applied file is refused before any pending earlier file runs', async t => {
  const { dir } = scratchDir(t);
  const db = memory(t);
  fs.writeFileSync(path.join(dir, '0003_later.sql'), 'CREATE TABLE later (id INTEGER);');
  migrate(db, dir);
  fs.writeFileSync(path.join(dir, '0001_earlier.sql'), 'CREATE TABLE earlier (id INTEGER);');
  fs.writeFileSync(path.join(dir, '0003_later.sql'), 'CREATE TABLE later (id INTEGER, edited INTEGER);');
  assert.throws(() => migrate(db, dir), err => err.code === 'migration_changed');
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'earlier'").first(), null, 'no new DDL');
  assert.deepEqual((await db.prepare('SELECT name FROM logs_local_migrations').all()).results, [{ name: '0003_later.sql' }], 'no new ledger row');
});

test('a failing migration leaves no partial schema and is not recorded', async t => {
  const { dir } = scratchDir(t);
  fs.writeFileSync(path.join(dir, '0001_ok.sql'), 'CREATE TABLE ok (id INTEGER);');
  fs.writeFileSync(path.join(dir, '0002_broken.sql'), 'CREATE TABLE half (id INTEGER);\nCREATE TABLE ok (id INTEGER);');
  const db = memory(t);
  assert.throws(() => migrate(db, dir), /already exists/);
  assert.equal(await db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").first(), null);
  assert.deepEqual((await db.prepare('SELECT name FROM logs_local_migrations').all()).results, [{ name: '0001_ok.sql' }]);
});

test('the Logs device sign-in flow runs unchanged on the adapter', async t => {
  const db = memory(t);
  migrate(db, MIGRATIONS);
  const directory = {
    async resolvePilotUsername(username) { return username === 'bkoltz' ? { staffId: 'staff-beau', eligibilityRevision: 1 } : null; },
    async getPilotDeviceAuthority(staffId) { return staffId === 'staff-beau' ? { eligible: true, revision: 1 } : { eligible: false, revision: null }; },
    async isActiveStaff(staffId) { return staffId === 'staff-beau'; },
  };
  const env = { LOGS_DB: db, OPS_DIRECTORY: directory };
  device.clearActiveCache();
  const call = async (method, route, { body, token, poll } = {}) => {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (poll) headers['X-Poll-Token'] = poll;
    const init = { method, headers };
    if (body !== undefined) { init.body = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
    const response = await handleDeviceRequest(new Request(`https://logs.example.test${route}`, init), env);
    return { status: response.status, body: await response.json() };
  };
  const beau = { staffId: 'staff-beau', permissions: ['flight_logs.view'] };
  const started = await call('POST', '/api/v1/device/sign-in', { body: { username: 'bkoltz', model: 'DJI RC PLUS 2', hardwareId: 'android-1' } });
  assert.equal(started.status, 201);
  const pending = await device.pendingSignIns(env, beau);
  assert.equal(pending.items.length, 1);
  await device.decideSignIn(env, beau, { signInId: pending.items[0].id, approve: true });
  const collected = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  assert.equal(collected.status, 200);
  assert.deepEqual([collected.body.status, collected.body.pilot.id], ['approved', 'staff-beau']);
  assert.ok(collected.body.deviceToken);
  const again = await call('GET', `/api/v1/device/sign-in/${started.body.signInId}`, { poll: started.body.pollToken });
  assert.equal(again.body.status, 'expired', 'the token is collected once');
  assert.equal(again.body.deviceToken, undefined);
  const me = await call('GET', '/api/v1/device/me', { token: collected.body.deviceToken });
  assert.deepEqual([me.status, me.body.pilot.id], [200, 'staff-beau'], 'the collected token authenticates');
  assert.equal((await call('GET', '/api/v1/device/me', { token: 'x'.repeat(43) })).status, 401);
  assert.equal((await device.listDevices(env, beau)).items.length, 1);
});
