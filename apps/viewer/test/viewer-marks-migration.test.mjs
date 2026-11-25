import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import database from '../server/database.js';
import marksRepository from '../server/viewerMarkRepository.js';
import processing from '../server/processingRepository.js';
import schema from '../server/viewerMarkSchema.js';

const { MIGRATIONS, applyMigrations, openDatabase } = database;
const NAME = 'viewer_coordinate_marks';
const OBJECTS = ['viewer_mark_accounts', 'viewer_mark_categories', 'viewer_mark_categories_name_idx',
  'viewer_marks', 'viewer_marks_owner_idx', 'viewer_marks_shared_idx'];
const marks = MIGRATIONS.find(item => item.version === 84);
// The order in which each release reached a database: 84 was reserved before 85 and 86 shipped without it.
const LEVELS = [83, 85, 86];

// Runs `work` with only the named migrations registered, as an older or newer build would have them.
function withMigrations(keep, work) {
  const all = MIGRATIONS.splice(0);
  MIGRATIONS.push(...all.filter(keep));
  try { return work(); }
  finally { MIGRATIONS.splice(0, MIGRATIONS.length, ...all); }
}
const releasedAt = level => item => item.version !== 84 && item.version <= level;

const quote = name => '"' + name.replaceAll('"', '""') + '"';
function snapshot(db) {
  const objects = db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => ({ ...row }));
  const rows = {};
  for (const { type, name } of objects) {
    if (type !== 'table') continue;
    const primaryKey = db.prepare('SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk').all(name);
    const order = primaryKey.map(column => quote(column.name)).join(', ') || 'rowid';
    rows[name] = db.prepare(`SELECT * FROM ${quote(name)} ORDER BY ${order}`).all().map(row => ({ ...row }));
  }
  return { objects, rows };
}
const ledger = db => db.prepare('SELECT version, name FROM schema_migrations WHERE version > 42 ORDER BY version').all().map(row => [row.version, row.name]);
function healthy(db) {
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}

function populate(db) {
  const repository = new processing.ProcessingRepository(db);
  const project = repository.createProject({ displayName: 'Synthetic project' });
  const data = repository.createDataset({ projectId: project.id, displayName: 'Synthetic photos', storageMode: 'managed',
    rootKey: 'datasets', relativePath: 'synthetic-photos' });
  repository.finalizeDataset(data.id, [{ relativePath: 'photo.jpg', byteSize: 1, sha256: 'a'.repeat(64) }], 'b'.repeat(64));
  const task = repository.createTask({ projectId: project.id, datasetId: data.id, displayName: 'Synthetic task' });
  const provider = repository.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = repository.createAttempt({ taskId: task.id, providerId: provider.id });
  db.prepare('INSERT INTO processing_attempt_engine_timing VALUES (?,?,?,1)').run(attempt.id, attempt.providerTaskId, 1234);
  const now = '2026-11-20T00:00:00.000Z';
  for (const id of ['synthetic-model', 'other-model']) {
    db.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES (?,'local',?,?,'ready',?,?)").run(id, id, id, now, now);
  }
  db.prepare("INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES ('synthetic-v1','synthetic-model','v1','{}','ready',?,?)").run(now, now);
  db.prepare("UPDATE models SET active_version_id='synthetic-v1' WHERE id='synthetic-model'").run();
  db.prepare(`INSERT INTO viewer_sessions(id,token_hash,model_id,model_version_id,subject,audience,permissions_json,expires_at,created_at,updated_at)
    VALUES ('session','hash','synthetic-model','synthetic-v1','client-a','client','{}',?,?,?)`).run(now, now, now);
  db.prepare(`INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_at,original_status)
    VALUES ('trash','task','absent','metadata','',0,?,?,'active')`).run(now, now);
}

const principal = { modelId: 'synthetic-model', modelVersionId: 'synthetic-v1', audience: 'client', subject: 'client-a', session: {}, personalPersistence: true };
const pin = () => ({ id: crypto.randomUUID(), geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Synthetic pin', color: '#88aa22' });

function populated(t, level) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `viewer-marks-${level}-`));
  const filename = path.join(dir, 'viewer.sqlite');
  const handles = [];
  t.after(() => {
    for (const db of handles) if (db.isOpen) db.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10 });
  });
  const open = (keep = () => true) => {
    const db = withMigrations(keep, () => openDatabase(filename));
    handles.push(db);
    return db;
  };
  const db = open(releasedAt(level));
  populate(db);
  assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, level);
  return { db, open, filename, dir };
}

test('84 sits between 83 and 85 in the registry and is one fixed schema', () => {
  assert.deepEqual(MIGRATIONS.filter(item => item.version > 42).map(item => [item.version, item.name]).slice(1, 4),
    [[83, 'provider_engine_processing_elapsed'], [84, NAME], [85, 'processing_provider_removal']]);
  assert.equal(marks.sql, schema.VIEWER_MARKS_SQL);
});

for (const level of LEVELS) {
  test(`a populated database at ${level} gains exactly the Marks objects and keeps every row`, t => {
    const { db } = populated(t, level);
    const before = snapshot(db);
    // Only 84 is new: the rest of the registry stays at this release.
    withMigrations(item => item.version === 84 || item.version <= level, () => applyMigrations(db));
    const after = snapshot(db);
    assert.deepEqual(after.objects.filter(row => !OBJECTS.includes(row.name)), before.objects);
    assert.deepEqual(after.objects.filter(row => OBJECTS.includes(row.name)).map(row => row.name), OBJECTS);
    for (const [name, rows] of Object.entries(before.rows)) {
      if (name !== 'schema_migrations') assert.deepEqual(after.rows[name], rows, name);
    }
    for (const name of ['viewer_marks', 'viewer_mark_categories', 'viewer_mark_accounts']) assert.deepEqual(after.rows[name], [], name);
    // The old ledger rows keep their names and times; one row was added, and the maximum says nothing about it.
    assert.deepEqual(after.rows.schema_migrations.filter(row => row.version !== 84), before.rows.schema_migrations);
    assert.equal(after.rows.schema_migrations.find(row => row.version === 84).name, NAME);
    assert.equal(db.prepare('SELECT MAX(version) v FROM schema_migrations').get().v, Math.max(level, 84));
    healthy(db);
    // Re-running changes nothing, then the remaining releases apply over it.
    withMigrations(item => item.version === 84 || item.version <= level, () => applyMigrations(db));
    assert.deepEqual(snapshot(db), after);
    applyMigrations(db);
    assert.deepEqual(ledger(db), MIGRATIONS.filter(item => item.version > 42).map(item => [item.version, item.name]));
    const complete = snapshot(db);
    applyMigrations(db);
    assert.deepEqual(snapshot(db), complete);
    healthy(db);
  });

  test(`foreign keys on a database upgraded from ${level}: marks follow their model`, t => {
    const { db } = populated(t, level);
    applyMigrations(db);
    const repository = new marksRepository.ViewerMarkRepository(db);
    const { mark } = repository.create(principal, pin());
    repository.createCategory(principal, { id: crypto.randomUUID(), name: 'Synthetic', color: '#3366ff', icon: 'flag' });
    assert.equal(repository.get(principal, mark.id).name, 'Synthetic pin');
    assert.throws(() => repository.create({ ...principal, modelId: 'no-such-model' }, pin()), /FOREIGN KEY/);
    assert.equal(db.prepare("DELETE FROM models WHERE id='other-model'").run().changes, 1);
    assert.equal(repository.list(principal).length, 1, 'another model going away leaves these marks');
    db.exec("UPDATE models SET active_version_id=NULL; DELETE FROM viewer_sessions; DELETE FROM model_versions; DELETE FROM models WHERE id='synthetic-model'");
    for (const name of ['viewer_marks', 'viewer_mark_categories']) assert.equal(db.prepare(`SELECT count(*) n FROM ${name}`).get().n, 0, name);
    healthy(db);
  });

  test(`a failed 84 on a database at ${level} leaves nothing behind and a retry succeeds`, t => {
    const { db } = populated(t, level);
    const before = snapshot(db);
    const only84 = work => withMigrations(item => item.version === 84 || item.version <= level, work);
    // Fails after the first tables were created.
    db.exec('CREATE TABLE viewer_mark_accounts(stray TEXT)');
    assert.throws(() => only84(() => applyMigrations(db)), /already exists/);
    db.exec('DROP TABLE viewer_mark_accounts');
    assert.deepEqual(snapshot(db), before);
    // Fails in the check that runs before the version is recorded.
    const { after } = marks;
    marks.after = () => { throw new Error('synthetic stop'); };
    try { assert.throws(() => only84(() => applyMigrations(db)), /synthetic stop/); }
    finally { marks.after = after; }
    assert.deepEqual(snapshot(db), before);
    // Another name under 84 is refused without creating the tables.
    db.prepare("INSERT INTO schema_migrations VALUES (84,'another_name','2026-11-20T00:00:00Z')").run();
    assert.throws(() => only84(() => applyMigrations(db)), { code: 'viewer_migration_history_conflict' });
    db.exec('DELETE FROM schema_migrations WHERE version=84');
    assert.deepEqual(snapshot(db), before);
    only84(() => applyMigrations(db));
    assert.equal(marks.verify(db), true);
    healthy(db);
  });

  test(`rollback rehearsal from ${level}: the previous build opens the upgraded database, and a backup restores exactly`, t => {
    const { db, open, dir } = populated(t, level);
    const before = snapshot(db);
    const backup = path.join(dir, 'before-84.sqlite');
    db.prepare('VACUUM INTO ?').run(backup);
    db.close();

    const upgraded = open();
    const { mark } = new marksRepository.ViewerMarkRepository(upgraded).create(principal, pin());
    const saved = snapshot(upgraded);
    upgraded.close();
    // Rollback to main's build (no 84 in its registry): it ignores the extra version and tables and
    // reads everything else. Foreign keys still hold because the tables carry them.
    const previous = open(item => item.version !== 84);
    assert.deepEqual(snapshot(previous), saved);
    assert.equal(new processing.ProcessingRepository(previous).listProjects().length, 1);
    healthy(previous);
    assert.equal(previous.prepare("DELETE FROM models WHERE id='other-model'").run().changes, 1);
    previous.close();
    // Forward again: 84 is recognised, not reapplied, and the mark is still there.
    const again = open();
    assert.equal(new marksRepository.ViewerMarkRepository(again).get(principal, mark.id).name, 'Synthetic pin');
    healthy(again);
    again.close();
    // Full rollback by restoring the copy taken before 84 (marks made since are lost).
    const restored = new DatabaseSync(backup);
    try { assert.deepEqual(snapshot(restored), before); healthy(restored); }
    finally { restored.close(); }
  });
}

for (const change of ['DROP TABLE viewer_mark_accounts', 'DROP INDEX viewer_marks_owner_idx', 'ALTER TABLE viewer_marks ADD COLUMN extra TEXT']) {
  test(`a recorded 84 is refused after: ${change}`, t => {
    const { open, db } = populated(t, 86);
    db.close();
    const current = open();
    current.exec(change);
    current.close();
    assert.throws(() => open(), { code: 'viewer_migration_history_conflict' });
  });
}

const child = (script, filename) => new Promise(resolve => {
  const proc = spawn(process.execPath, ['-e', script, filename],
    { cwd: path.dirname(path.dirname(fileURLToPath(import.meta.url))), stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', chunk => { stderr += chunk; });
  proc.on('close', (code, signal) => resolve({ code, signal, stderr }));
});

test('a process killed inside 84 leaves the populated database at 86; two processes then race safely', async t => {
  const { db, open, filename } = populated(t, 86);
  const before = snapshot(db);
  db.close();
  const killed = await child(`const {MIGRATIONS,openDatabase}=require('./server/database');
    MIGRATIONS.find(item=>item.version===84).after=()=>process.kill(process.pid,'SIGKILL');openDatabase(process.argv[1]);`, filename);
  assert.ok(killed.code !== 0 || killed.signal, 'the child died');
  const reopened = open(releasedAt(86));
  assert.deepEqual(snapshot(reopened), before);
  reopened.close();
  const results = await Promise.all([1, 2].map(() => child("require('./server/database').openDatabase(process.argv[1]).close();", filename)));
  assert.deepEqual(results.map(({ code, stderr }) => [code, stderr]), [[0, ''], [0, '']]);
  const current = open();
  assert.equal(current.prepare('SELECT count(*) n FROM schema_migrations WHERE version=84').get().n, 1);
  for (const [name, rows] of Object.entries(before.rows)) {
    if (name !== 'schema_migrations') assert.deepEqual(snapshot(current).rows[name], rows, name);
  }
  healthy(current);
});

test('90 adds only the sharing tables, survives the previous build, and is refused if altered', t => {
  const { db, open } = populated(t, 86);
  withMigrations(item => item.version <= 86, () => applyMigrations(db));
  const before = snapshot(db);
  db.close();
  const current = open();
  const after = snapshot(current), added = ['viewer_mark_authors', 'viewer_mark_history', 'viewer_mark_shares'];
  assert.deepEqual(after.objects.filter(row => !added.includes(row.name)), before.objects);
  assert.deepEqual(after.objects.filter(row => added.includes(row.name)).map(row => row.name), added);
  for (const [name, rows] of Object.entries(before.rows)) if (name !== 'schema_migrations') assert.deepEqual(after.rows[name], rows, name);
  const staff = { ...principal, audience: 'ops', subject: 'staff-a' };
  const { mark } = new marksRepository.ViewerMarkRepository(current).create(staff, pin());
  // What a build without 90 reads: a row marked internal, which it serves to its owner only.
  assert.equal(current.prepare('SELECT visibility FROM viewer_marks WHERE id=?').get(mark.id).visibility, 'internal');
  current.close();
  const previous = open(item => item.version <= 86);
  healthy(previous);
  previous.close();
  const again = open();
  assert.equal(new marksRepository.ViewerMarkRepository(again).get(staff, mark.id).visibility, 'shared');
  again.exec("UPDATE models SET active_version_id=NULL; DELETE FROM viewer_sessions; DELETE FROM model_versions; DELETE FROM models WHERE id='synthetic-model'");
  assert.equal(again.prepare('SELECT count(*) n FROM viewer_mark_shares').get().n, 0);
  healthy(again);
  again.exec('ALTER TABLE viewer_mark_shares ADD COLUMN extra TEXT');
  again.close();
  assert.throws(() => open(), { code: 'viewer_migration_history_conflict' });
});

test('a later reserved number (87) can land before or after 84', t => {
  for (const first of ['87', '84']) {
    const { db } = populated(t, 86);
    const later = { version: 87, name: 'synthetic_87', sql: 'CREATE TABLE synthetic_87(id TEXT PRIMARY KEY);' };
    MIGRATIONS.push(later);
    try {
      withMigrations(item => item.version !== (first === '87' ? 84 : 87), () => applyMigrations(db));
      applyMigrations(db);
      const applied = new Map(ledger(db));
      assert.equal(applied.get(84), NAME);
      assert.equal(applied.get(85), 'processing_provider_removal');
      assert.equal(applied.get(86), 'trash_container_purge_started');
      assert.equal(applied.get(87), 'synthetic_87');
      assert.equal(applied.get(90), 'viewer_mark_sharing');
      assert.equal(applied.get(91), 'task_authorization_generations');
      assert.equal(applied.get(92), 'restricted_viewer_session_lifecycle');
      assert.equal(marks.verify(db), true);
      healthy(db);
    } finally { MIGRATIONS.splice(MIGRATIONS.indexOf(later), 1); }
  }
});
