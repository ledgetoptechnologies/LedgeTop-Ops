'use strict';

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ProcessingRepository } = require('../server/processingRepository');
const { canonicalProjectExclusions } = require('../server/projectExclusions');

const id = sequence => `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
const mask = { version: 1, folderIds: [id(1)], taskIds: [id(15)] };

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE processing_presets(id TEXT PRIMARY KEY, display_name TEXT, options_json TEXT, built_in INTEGER, enabled INTEGER, created_at TEXT, updated_at TEXT, provider_type TEXT, capability_fingerprint TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY, display_name TEXT, default_units TEXT, status TEXT);
    CREATE TABLE project_folders(id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, display_name TEXT);
    CREATE TABLE processing_tasks(id TEXT PRIMARY KEY, project_id TEXT, display_name TEXT, created_at TEXT,
      status TEXT, purged_at TEXT, published_model_id TEXT, folder_id TEXT);
    CREATE TABLE models(id TEXT PRIMARY KEY, display_name TEXT, active_version_id TEXT, status TEXT);
    CREATE TABLE model_outputs(id TEXT PRIMARY KEY, model_id TEXT, task_id TEXT, project_id TEXT,
      attempt_id TEXT, updated_at TEXT, status TEXT);
    CREATE TABLE model_versions(id TEXT PRIMARY KEY, model_id TEXT, status TEXT);
    INSERT INTO projects VALUES ('project','Project','metric','active');
  `);
  const folder = db.prepare("INSERT INTO project_folders VALUES (?, ?, ?, 'Folder')");
  for (const [sequence, parent, project = 'project'] of [
    [1, null], [2, id(1)], [3, null], [4, id(4)], [5, id(6)], [6, null, 'other'],
  ]) folder.run(id(sequence), project, parent);

  for (const [sequence, parent] of [
    [11, null], [12, id(3)], [13, id(2)], [14, id(1)], [15, id(3)],
    [16, id(4)], [17, id(5)], [18, id(999)],
  ]) {
    const task = id(sequence);
    const model = id(sequence + 100);
    const version = id(sequence + 200);
    const date = `2026-11-${sequence}T00:00:00Z`;
    db.prepare("INSERT INTO processing_tasks VALUES (?, 'project', 'Task', ?, 'ready', NULL, ?, ?)")
      .run(task, date, model, parent);
    db.prepare("INSERT INTO models VALUES (?, 'Model', ?, 'ready')").run(model, version);
    db.prepare("INSERT INTO model_versions VALUES (?, ?, 'ready')").run(version, model);
    db.prepare("INSERT INTO model_outputs VALUES (?, ?, ?, 'project', 'attempt', ?, 'published')")
      .run(version, model, task, date);
  }
  return { db, repo: new ProcessingRepository(db) };
}

test('scope is bounded, canonical, and rejects incompatible or malformed forms', () => {
  assert.deepEqual(canonicalProjectExclusions({
    version: 1, folderIds: [id(3), id(1), id(3)], taskIds: [id(15)],
  }), { version: 1, folderIds: [id(1), id(3)], taskIds: [id(15)] });
  for (const input of [null, { ...mask, version: 2 }, { ...mask, taskIds: ['name'] },
    { ...mask, unexpected: true }, { ...mask, folderIds: Array(128).fill(id(1)) },
    { ...mask, folderIds: [], taskIds: [] }]) assert.equal(canonicalProjectExclusions(input), null);
});

test('exact and paged reads agree before pagination and preserve independent legacy access', t => {
  const { repo } = fixture(t);
  const scope = { strictPublished: true, exclusions: mask, limit: 1 };
  const first = repo.listActivePublishedProjectTasksPage('project', scope);
  assert.deepEqual(first.items.map(row => row.taskId), [id(12)]);
  assert.ok(first.nextCursor);
  assert.deepEqual(repo.listActivePublishedProjectTasksPage('project', { ...scope, cursor: first.nextCursor })
    .items.map(row => row.taskId), [id(11)]);
  for (const sequence of [13, 14, 15, 16, 17, 18]) {
    assert.equal(repo.getActivePublishedProjectTask('project', id(sequence), scope), undefined);
    assert.equal(repo.getActivePublishedProjectTask('project', id(sequence), { strictPublished: true }).taskId,
      id(sequence));
  }
  assert.equal(repo.getActivePublishedProjectTask('project', id(11), { ...scope, exclusions: null }), undefined);
});

test('current ancestry follows moves while explicit task exclusions survive them', t => {
  const { db, repo } = fixture(t);
  const scope = { strictPublished: true, exclusions: mask };
  const move = db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?');
  move.run(id(2), id(12));
  move.run(id(3), id(13));
  move.run(null, id(15));
  assert.equal(repo.getActivePublishedProjectTask('project', id(12), scope), undefined);
  assert.equal(repo.getActivePublishedProjectTask('project', id(13), scope).taskId, id(13));
  assert.equal(repo.getActivePublishedProjectTask('project', id(15), scope), undefined);
  db.exec('DROP TABLE project_folders');
  assert.equal(repo.getActivePublishedProjectTask('project', id(11), scope), undefined);
  assert.equal(repo.getActivePublishedProjectTask('project', id(11)).taskId, id(11));
});


test('staff validation accepts only exclusion targets in the active exact project', t => {
  const { db, repo } = fixture(t);
  assert.deepEqual(repo.validateProjectExclusions('project', mask), mask);
  assert.equal(repo.validateProjectExclusions('other', mask), null);
  assert.equal(repo.validateProjectExclusions('project', { ...mask, folderIds: [id(6)] }), null);
  db.prepare("UPDATE processing_tasks SET purged_at='now' WHERE id=?").run(id(15));
  assert.equal(repo.validateProjectExclusions('project', mask), null);
});
