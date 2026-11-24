'use strict';
// Viewer-owned task authorization generation (schema 88): persisted, backfilled,
// only ever increasing, bumped by every scope-affecting write, and compared at
// mint, redemption and every live restricted-session check.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { MIGRATIONS, applyMigrations, TASK_AUTHORIZATION_GENERATIONS_V88_SQL } = require('../server/database');
const { restrictedSessionAllows, currentTaskAuthorizationGeneration } = require('../server/restrictedSessionScope');

const id = sequence => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
const T0 = '2026-01-01T00:00:00.000Z';

function fileDb(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `viewer-generation-${label}-`));
  const db = new DatabaseSync(path.join(root, 'db.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}
function useMigrations(t, list) {
  const all = [...MIGRATIONS];
  MIGRATIONS.splice(0, MIGRATIONS.length, ...list);
  t.after(() => MIGRATIONS.splice(0, MIGRATIONS.length, ...all));
}
function seedTasks(db, ids) {
  db.prepare("INSERT INTO projects(id,display_name,status,created_at,updated_at) VALUES ('project-a','Synthetic project','active',?,?)").run(T0, T0);
  db.prepare(`INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,manifest_sha256,created_at,updated_at,finalized_at)
    VALUES ('dataset-a','project-a','Synthetic source','managed','datasets','synthetic-a','finalized',?,?,?,?)`).run('a'.repeat(64), T0, T0, T0);
  for (const task of ids) db.prepare(`INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,metadata_json,created_at,updated_at)
    VALUES (?,'project-a','dataset-a',?,'draft','{}',?,?)`).run(task, `Synthetic ${task}`, T0, T0);
}
const generationOf = (db, task) => db.prepare('SELECT generation FROM task_authorization_generations WHERE task_id=?').get(task)?.generation;

test('upgrade from 48 backfills every existing task, stamps 88 and new tasks start at 1', t => {
  const db = fileDb(t, 'upgrade');
  const all = [...MIGRATIONS];
  useMigrations(t, all.filter(item => item.version <= 48));
  applyMigrations(db);
  seedTasks(db, ['task-1', 'task-2']);
  MIGRATIONS.splice(0, MIGRATIONS.length, ...all);
  applyMigrations(db);
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=88').get().name, 'task_authorization_generations');
  assert.equal(generationOf(db, 'task-1'), 1);
  assert.equal(generationOf(db, 'task-2'), 1);
  db.prepare(`INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,metadata_json,created_at,updated_at)
    VALUES ('task-3','project-a','dataset-a','Synthetic task-3','draft','{}',?,?)`).run(T0, T0);
  assert.equal(generationOf(db, 'task-3'), 1);
  applyMigrations(db); // idempotent re-run accepts the verified stamp
});

// Main ends at 86 today; 84 and 87 belong to other open work and may arrive before or after this one.
const later = (version, name) => ({ version, name, sql: `CREATE TABLE synthetic_${version}(id INTEGER PRIMARY KEY);` });
for (const [label, steps] of [
  ['86, then 88', [[86], [88]]],
  ['86, then 87, then 88', [[86], [86, 87], [87, 88]]],
  ['86, then 88, then a late 87', [[86], [88], [87, 88]]],
  ['86, then 88, then a late 84', [[86], [88], [84, 88]]],
  ['83, then 88', [[83], [88]]],
  ['a fresh install with 84, 87 and 88', [[84, 87, 88]]],
]) test(`upgrade order: ${label}`, t => {
  const db = fileDb(t, 'order'), all = [...MIGRATIONS], seen = new Set();
  useMigrations(t, all);
  for (const [index, step] of steps.entries()) {
    const top = Math.max(...step);
    step.filter(version => [84, 87].includes(version)).forEach(version => seen.add(version));
    const list = [...all.filter(item => item.version <= top), ...[...seen].map(version => later(version, `synthetic_${version}`))].sort((left, right) => left.version - right.version);
    MIGRATIONS.splice(0, MIGRATIONS.length, ...list);
    applyMigrations(db);
    if (index === 0 && steps.length > 1) seedTasks(db, ['task-1']);
  }
  if (steps.length === 1) seedTasks(db, ['task-1']);
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=88').get().name, 'task_authorization_generations');
  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=52').get(), undefined, '52 was never shipped');
  assert.equal(db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get().v, 88);
  assert.equal(generationOf(db, 'task-1'), 1);
  applyMigrations(db);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('88 refuses an install order without the 48 folder schema', t => {
  const without48 = fileDb(t, 'no48');
  useMigrations(t, [...MIGRATIONS].filter(item => item.version <= 42 || item.version === 88));
  assert.throws(() => applyMigrations(without48), /require the version 48 folder schema/);
  assert.equal(without48.prepare("SELECT 1 FROM sqlite_master WHERE name='task_authorization_generations'").get(), undefined);
});

test('88 refuses half-built or unstamped objects', t => {
  const db = fileDb(t, 'unstamped'), all = [...MIGRATIONS];
  useMigrations(t, all.filter(item => item.version < 88));
  applyMigrations(db);
  MIGRATIONS.splice(0, MIGRATIONS.length, ...all);
  db.exec('CREATE TABLE task_authorization_generations(task_id TEXT PRIMARY KEY, generation INTEGER, updated_at TEXT)');
  assert.throws(() => applyMigrations(db), { code: 'viewer_migration_history_conflict' });
  assert.equal(db.prepare('SELECT 1 FROM schema_migrations WHERE version=88').get(), undefined);
});

test('an 88 stamp whose objects are missing is refused, never accepted', t => {
  const db = fileDb(t, 'stamp');
  applyMigrations(db);
  db.exec('DROP TRIGGER task_authorization_generation_task_update');
  assert.throws(() => applyMigrations(db), /explicit compatibility review/);
});

function lightFixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, display_name TEXT, default_units TEXT, status TEXT);
    CREATE TABLE project_folders(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, display_name TEXT);
    CREATE TABLE processing_tasks(id TEXT PRIMARY KEY, project_id TEXT, display_name TEXT, created_at TEXT,
      status TEXT, purged_at TEXT, published_model_id TEXT, folder_id TEXT);
    CREATE TABLE models(id TEXT PRIMARY KEY, display_name TEXT, active_version_id TEXT, status TEXT);
    CREATE TABLE model_outputs(id TEXT PRIMARY KEY, model_id TEXT, task_id TEXT, project_id TEXT,
      attempt_id TEXT, updated_at TEXT, status TEXT);
    CREATE TABLE model_versions(id TEXT PRIMARY KEY, model_id TEXT, status TEXT);
    INSERT INTO projects VALUES ('p','Project','metric','active');
    INSERT INTO project_folders VALUES ('fa','p',NULL,'A'), ('fb','p',NULL,'B'), ('fc','p','fa','C');
    INSERT INTO models VALUES ('m','Model','v','ready');
    INSERT INTO model_versions VALUES ('v','m','ready');
    INSERT INTO processing_tasks VALUES ('t','p','Task','now','ready',NULL,'m','fa'), ('u','p','Other','now','ready',NULL,NULL,NULL);
    INSERT INTO model_outputs VALUES ('v','m','t','p','attempt','now','published');
  `);
  db.exec(TASK_AUTHORIZATION_GENERATIONS_V88_SQL);
  return db;
}

test('generations only increase and are never deleted', t => {
  const db = lightFixture(t);
  assert.throws(() => db.exec("UPDATE task_authorization_generations SET generation=1 WHERE task_id='t'"), /only increases/);
  assert.throws(() => db.exec("UPDATE task_authorization_generations SET generation=0 WHERE task_id='t'"), /only increases|CHECK/);
  assert.throws(() => db.exec("DELETE FROM task_authorization_generations WHERE task_id='t'"), /permanent/);
  // A deleted and re-created task id continues from its previous generation.
  db.exec("DELETE FROM model_outputs WHERE task_id='t'");
  const before = generationOf(db, 't');
  db.exec("DELETE FROM processing_tasks WHERE id='t'");
  db.exec("INSERT INTO processing_tasks VALUES ('t','p','Task','now','ready',NULL,'m',NULL)");
  assert.equal(generationOf(db, 't'), before + 2);
});

test('every scope-affecting write bumps the task generation in the same statement', t => {
  const db = lightFixture(t);
  const cases = [
    ['move to another folder', "UPDATE processing_tasks SET folder_id='fb' WHERE id='t'"],
    ['move back (A->B->A)', "UPDATE processing_tasks SET folder_id='fa' WHERE id='t'"],
    ['move to root', "UPDATE processing_tasks SET folder_id=NULL WHERE id='t'"],
    ['archive', "UPDATE processing_tasks SET status='archived' WHERE id='t'"],
    ['unarchive', "UPDATE processing_tasks SET status='ready' WHERE id='t'"],
    ['purge', "UPDATE processing_tasks SET purged_at='now' WHERE id='t'"],
    ['published model change', "UPDATE processing_tasks SET published_model_id=NULL WHERE id='t'"],
    ['project status', "UPDATE projects SET status='archived' WHERE id='p'"],
    ['model status', "UPDATE models SET status='failed' WHERE id='m'"],
    ['model active version', "UPDATE models SET active_version_id='v2' WHERE id='m'"],
    ['model version status', "UPDATE model_versions SET status='failed' WHERE id='v'"],
    ['output status', "UPDATE model_outputs SET status='withdrawn' WHERE id='v'"],
    ['output insert', "INSERT INTO model_outputs VALUES ('v3','m','t','p','attempt','now','published')"],
    ['output delete', "DELETE FROM model_outputs WHERE id='v3'"],
    ['folder re-parent', "UPDATE project_folders SET parent_id='fb' WHERE id='fc'"],
    ['folder delete', "DELETE FROM project_folders WHERE id='fc'"],
  ];
  db.exec("UPDATE processing_tasks SET published_model_id='m' WHERE id='t'");
  for (const [label, sql] of cases) {
    if (label === 'published model change') db.exec("UPDATE processing_tasks SET purged_at=NULL WHERE id='t'");
    if (label === 'model status') db.exec("UPDATE processing_tasks SET published_model_id='m' WHERE id='t'");
    const before = generationOf(db, 't');
    db.exec(sql);
    assert.ok(generationOf(db, 't') > before, label);
  }
  const unrelated = generationOf(db, 't');
  db.exec("UPDATE processing_tasks SET display_name='Renamed', status='processing' WHERE id='t'");
  db.exec("UPDATE project_folders SET display_name='Renamed' WHERE id='fa'");
  db.exec("UPDATE models SET display_name='Renamed' WHERE id='m'");
  assert.equal(generationOf(db, 't'), unrelated, 'names and non-archive status changes keep credentials');
});

test('a missing generation row denies every restricted check', t => {
  const db = lightFixture(t);
  db.exec('DROP TRIGGER task_authorization_generation_permanent');
  db.exec("DELETE FROM task_authorization_generations WHERE task_id='t'");
  assert.equal(currentTaskAuthorizationGeneration(db, 't'), null);
  const session = { audience: 'client', sessionMode: 'published', modelId: 'm', modelVersionId: 'v',
    sourceAuthorization: { type: 'direct_client_grant', id: 'g', version: 1 },
    restrictedScope: { version: 1, projectId: id(1), taskId: id(2), generation: 1, exclusions: { version: 1, folderIds: [], taskIds: [id(3)] } } };
  assert.equal(restrictedSessionAllows(db, session), false);
  const noTable = new DatabaseSync(':memory:');
  t.after(() => noTable.close());
  assert.equal(currentTaskAuthorizationGeneration(noTable, 't'), null);
});

test('live restricted liveness reads tombstone, generation and eligibility in one snapshot (two connections)', t => {
  const { ViewerRepository } = require('../server/repository');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-generation-snapshot-'));
  const file = path.join(root, 'db.sqlite');
  const reader = new DatabaseSync(file), writer = new DatabaseSync(file);
  t.after(() => { reader.close(); writer.close(); fs.rmSync(root, { recursive: true, force: true }); });
  reader.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000');
  writer.exec('PRAGMA busy_timeout=5000');
  const P = id(1), T = id(2), M = id(3), V = id(4), FA = id(5), FB = id(6);
  reader.exec(`
    CREATE TABLE projects(id TEXT PRIMARY KEY, display_name TEXT, default_units TEXT, status TEXT);
    CREATE TABLE project_folders(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, display_name TEXT);
    CREATE TABLE processing_tasks(id TEXT PRIMARY KEY, project_id TEXT, display_name TEXT, created_at TEXT,
      status TEXT, purged_at TEXT, published_model_id TEXT, folder_id TEXT);
    CREATE TABLE models(id TEXT PRIMARY KEY, display_name TEXT, active_version_id TEXT, status TEXT);
    CREATE TABLE model_outputs(id TEXT PRIMARY KEY, model_id TEXT, task_id TEXT, project_id TEXT, attempt_id TEXT, updated_at TEXT, status TEXT);
    CREATE TABLE model_versions(id TEXT PRIMARY KEY, model_id TEXT, status TEXT);
    CREATE TABLE viewer_sessions(id TEXT PRIMARY KEY, token_hash TEXT, model_id TEXT, model_version_id TEXT,
      review_attempt_id TEXT, session_mode TEXT, source_authorization_type TEXT, source_authorization_id TEXT,
      source_authorization_version INTEGER, subject TEXT, audience TEXT, permissions_json TEXT, display_units TEXT,
      expires_at TEXT, created_at TEXT, updated_at TEXT, revoked_at TEXT);
    CREATE TABLE revoked_published_session_authorizations(source_authorization_type TEXT,
      source_authorization_id TEXT, source_authorization_version INTEGER);
  `);
  reader.prepare("INSERT INTO projects VALUES (?,'Project','metric','active')").run(P);
  reader.prepare("INSERT INTO project_folders VALUES (?,?,NULL,'Visible'),(?,?,NULL,'Hidden')").run(FA, P, FB, P);
  reader.prepare("INSERT INTO models VALUES (?,'Model',?,'ready')").run(M, V);
  reader.prepare("INSERT INTO model_versions VALUES (?,?,'ready')").run(V, M);
  reader.prepare("INSERT INTO processing_tasks VALUES (?,?,'Task','now','ready',NULL,?,?)").run(T, P, M, FA);
  reader.prepare("INSERT INTO model_outputs VALUES (?,?,?,?,'attempt','now','published')").run(V, M, T, P);
  reader.exec(TASK_AUTHORIZATION_GENERATIONS_V88_SQL);
  const repo = new ViewerRepository(reader);
  const generation = reader.prepare('SELECT generation FROM task_authorization_generations WHERE task_id=?').get(T).generation;
  const session = repo.createViewerSession({ tokenHash: 'restricted', modelId: M, modelVersionId: V, audience: 'client', subject: 'client:synthetic',
    sourceAuthorization: { type: 'direct_client_grant', id: 'grant', version: 1 }, permissions: { view: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    restrictedScope: { version: 1, projectId: P, taskId: T, generation, exclusions: { version: 1, folderIds: [FB], taskIds: [] } } });
  assert.equal(repo.viewerSessionLive(session), true);

  // Another connection commits a move into the excluded folder between the
  // generation read and the eligibility read of the same liveness decision.
  const prepare = reader.prepare.bind(reader);
  let fired = false;
  reader.prepare = sql => {
    if (!fired && /FROM projects p/.test(sql)) { fired = true; writer.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(FB, T); }
    return prepare(sql);
  };
  t.after(() => { reader.prepare = prepare; });
  assert.equal(repo.viewerSessionLive(session), true, 'all reads saw the pre-move snapshot (allowed at that instant)');
  assert.equal(fired, true);
  assert.equal(reader.isTransaction, false, 'the read snapshot is released');
  assert.equal(repo.viewerSessionLive(session), false, 'the next decision sees the move');
  assert.equal(repo.liveViewerSessionByHash('restricted'), null);
});
