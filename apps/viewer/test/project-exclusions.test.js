'use strict';

const { DatabaseSync } = require('node:sqlite');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { ProcessingRepository } = require('../server/processingRepository');
const { canonicalProjectExclusions } = require('../server/projectExclusions');
const { TASK_AUTHORIZATION_GENERATIONS_V51_SQL } = require('../server/database');

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
  db.exec(TASK_AUTHORIZATION_GENERATIONS_V51_SQL);
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

test('restricted grant expiry, redemption and active sessions recheck current exact scope', t => {
  const { ViewerRepository } = require('../server/repository');
  const { db } = fixture(t);
  db.exec(`
    CREATE TABLE session_grants(id TEXT PRIMARY KEY, model_id TEXT, model_version_id TEXT, review_attempt_id TEXT,
      session_mode TEXT, source_authorization_type TEXT, source_authorization_id TEXT, source_authorization_version INTEGER,
      subject TEXT, audience TEXT, permissions_json TEXT, display_units TEXT, expires_at TEXT, created_at TEXT, redeemed_at TEXT);
    CREATE TABLE viewer_sessions(id TEXT PRIMARY KEY, token_hash TEXT, model_id TEXT, model_version_id TEXT,
      review_attempt_id TEXT, session_mode TEXT, source_authorization_type TEXT, source_authorization_id TEXT,
      source_authorization_version INTEGER, subject TEXT, audience TEXT, permissions_json TEXT, display_units TEXT,
      expires_at TEXT, created_at TEXT, updated_at TEXT, revoked_at TEXT);
    CREATE TABLE revoked_published_session_authorizations(source_authorization_type TEXT,
      source_authorization_id TEXT, source_authorization_version INTEGER);
    CREATE TABLE service_nonces(created_at TEXT);
    CREATE TABLE service_idempotency(expires_at TEXT);
  `);
  const project = id(500);
  for (const table of ['project_folders', 'processing_tasks', 'model_outputs'])
    db.prepare(`UPDATE ${table} SET project_id=? WHERE project_id='project'`).run(project);
  db.prepare('UPDATE projects SET id=?').run(project);
  const repo = new ViewerRepository(db);
  const grant = {
    modelId: id(112), modelVersionId: id(212), subject: 'client:synthetic', audience: 'client',
    sourceAuthorization: { type: 'direct_client_grant', id: id(600), version: 1 },
    permissions: { view: true }, expiresAt: new Date(Date.now() + 60000).toISOString(),
  };
  const generation = () => db.prepare('SELECT generation FROM task_authorization_generations WHERE task_id=?').get(id(12)).generation;
  const scopeNow = () => ({ version: 1, projectId: project, taskId: id(12), generation: generation(), exclusions: mask });
  const restrictedScope = scopeNow();
  const restricted = { ...grant, restrictedScope };
  const move = db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?');
  const first = repo.createSessionGrant(restricted);
  const encoded = db.prepare('SELECT permissions_json FROM session_grants WHERE id=?').get(first.id).permissions_json;
  assert.equal(JSON.parse(encoded).view, false);
  move.run(id(2), id(12));
  assert.equal(repo.redeemSessionGrant(first.id), null);
  assert.throws(() => repo.createSessionGrant(restricted), /restricted session scope/);

  // Back to an eligible folder: the old capture stays dead, a fresh capture mints.
  move.run(id(3), id(12));
  assert.throws(() => repo.createSessionGrant(restricted), /restricted session scope/);
  const freshScope = scopeNow();
  const issued = repo.createSessionGrant({ ...grant, restrictedScope: freshScope });
  const redeemed = repo.redeemSessionGrant(issued.id);
  assert.deepEqual(redeemed.restrictedScope, freshScope);
  const live = repo.createViewerSession({ ...redeemed, tokenHash: 'restricted' });
  const ordinary = repo.createViewerSession({
    ...grant, tokenHash: 'ordinary', sourceAuthorization: { ...grant.sourceAuthorization, id: id(601) },
  });
  assert.equal(repo.viewerSessionLive(live), true);
  assert.equal(repo.viewerSessionLive(ordinary), true);
  move.run(id(2), id(12));
  assert.equal(repo.viewerSessionLive(repo.getViewerSessionByHash('restricted')), false);
  assert.equal(repo.viewerSessionLive(ordinary), true);
  move.run(id(3), id(12));
  // A->B->A: the session minted before the moves never revives.
  assert.equal(repo.viewerSessionLive(repo.getViewerSessionByHash('restricted')), false);
  const again = repo.createViewerSession({ ...grant, restrictedScope: scopeNow(), tokenHash: 'restricted-again' });
  assert.equal(repo.viewerSessionLive(again), true);
  db.prepare('INSERT INTO revoked_published_session_authorizations VALUES (?, ?, ?)').run(
    grant.sourceAuthorization.type, grant.sourceAuthorization.id, grant.sourceAuthorization.version,
  );
  assert.equal(repo.viewerSessionLive(live), false);
  assert.equal(repo.viewerSessionLive(again), false);
  assert.equal(repo.viewerSessionLive(ordinary), true);

  db.prepare('UPDATE viewer_sessions SET permissions_json=? WHERE token_hash=?').run(
    '{"view":false,"restrictedSession":{"scope":{"version":2},"permissions":{"view":true}}}', 'ordinary',
  );
  assert.equal(repo.viewerSessionLive(repo.getViewerSessionByHash('ordinary')), false);
});

test('Client D1 receipt strategy denies restricted rows to the exact old reader', t => {
  const { readFileSync } = require('node:fs');
  const { join } = require('node:path');
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE portal_v2_workspaces(id TEXT PRIMARY KEY, project_alpha_source_id TEXT,
    status TEXT, legacy_account_id TEXT);
    INSERT INTO portal_v2_workspaces VALUES ('workspace','project-alpha:primary','active',NULL)`);
  for (const migration of ['0237_viewer_direct_client_grants.sql', '0240_viewer_direct_grant_receipt_immutability.sql'])
    db.exec(readFileSync(join(__dirname, '../../client/migrations', migration), 'utf8'));
  const create = db.prepare(`INSERT INTO viewer_direct_client_grants
    (id,source_id,workspace_id,viewer_project_id,task_id,scope_type,include_future_published,can_measure,
    can_view_cameras,can_download,authorization_expires_at,created_by_staff_id,created_at,updated_at)
    VALUES (?,'project-alpha:primary','workspace','project',?,?,?,1,0,0,?,'staff','now','now')`);
  create.run('ordinary', 'task', 'task', 0, null);
  const marker = '1970-01-01T00:00:00.000Z';
  db.exec('BEGIN');
  create.run('restricted', null, 'project', 1, marker);
  db.prepare(`INSERT INTO viewer_direct_client_grant_mutation_receipts VALUES
    ('staff','synthetic-key','grant.create','fingerprint','restricted',?,'now')`)
    .run(JSON.stringify({ version: 2, exclusions: mask, grant: { expiresAt: null } }));
  db.exec('COMMIT');
  const legacyPredicate = `authorization_expires_at IS NULL OR datetime(authorization_expires_at)>datetime('now')`;
  const grants = db.prepare(`SELECT id FROM viewer_direct_client_grants WHERE source_id=? AND workspace_id=?
    AND status='active' AND revoked_at IS NULL AND (${legacyPredicate}) ORDER BY id LIMIT 101`).all('project-alpha:primary', 'workspace');
  assert.deepEqual(grants.map(row => row.id), ['ordinary']);
  assert.throws(() => db.exec("UPDATE viewer_direct_client_grants SET authorization_expires_at=NULL WHERE id='restricted'"),
    /direct-viewer-grant-immutable/);
  assert.throws(() => db.exec("DELETE FROM viewer_direct_client_grant_mutation_receipts WHERE grant_id='restricted'"),
    /direct-viewer-grant-receipt-immutable/);
  db.exec("UPDATE viewer_direct_client_grants SET status='revoked',revoked_at='now' WHERE id='restricted'");
  assert.equal(db.prepare("SELECT status FROM viewer_direct_client_grants WHERE id='restricted'").get().status, 'revoked');
});

function sessionTables(db) {
  db.exec(`
    CREATE TABLE session_grants(id TEXT PRIMARY KEY, model_id TEXT, model_version_id TEXT, review_attempt_id TEXT,
      session_mode TEXT, source_authorization_type TEXT, source_authorization_id TEXT, source_authorization_version INTEGER,
      subject TEXT, audience TEXT, permissions_json TEXT, display_units TEXT, expires_at TEXT, created_at TEXT, redeemed_at TEXT);
    CREATE TABLE viewer_sessions(id TEXT PRIMARY KEY, token_hash TEXT, model_id TEXT, model_version_id TEXT,
      review_attempt_id TEXT, session_mode TEXT, source_authorization_type TEXT, source_authorization_id TEXT,
      source_authorization_version INTEGER, subject TEXT, audience TEXT, permissions_json TEXT, display_units TEXT,
      expires_at TEXT, created_at TEXT, updated_at TEXT, revoked_at TEXT);
    CREATE TABLE revoked_published_session_authorizations(source_authorization_type TEXT,
      source_authorization_id TEXT, source_authorization_version INTEGER);
    CREATE TABLE service_nonces(created_at TEXT);
    CREATE TABLE service_idempotency(expires_at TEXT);
  `);
}

test('mint compares the captured generation, eligibility and tombstone inside one write transaction', t => {
  const { ViewerRepository } = require('../server/repository');
  const { db } = fixture(t);
  sessionTables(db);
  const project = id(500);
  for (const table of ['project_folders', 'processing_tasks', 'model_outputs'])
    db.prepare(`UPDATE ${table} SET project_id=? WHERE project_id='project'`).run(project);
  db.prepare('UPDATE projects SET id=?').run(project);
  const repo = new ViewerRepository(db);
  const generation = () => db.prepare('SELECT generation FROM task_authorization_generations WHERE task_id=?').get(id(12)).generation;
  const grant = (version = 1, captured = generation()) => ({
    modelId: id(112), modelVersionId: id(212), subject: 'client:synthetic', audience: 'client',
    sourceAuthorization: { type: 'direct_client_grant', id: id(700), version },
    permissions: { view: true }, expiresAt: new Date(Date.now() + 60000).toISOString(),
    restrictedScope: { version: 1, projectId: project, taskId: id(12), generation: captured, exclusions: mask },
  });

  // The eligibility read and the INSERT run while SQLite holds the write transaction.
  const firstGrant = grant();
  const prepare = db.prepare.bind(db);
  const seen = [];
  db.prepare = sql => { if (/task_authorization_generations|INSERT INTO session_grants/.test(sql)) seen.push(db.isTransaction ? true : sql.slice(0, 60)); return prepare(sql); };
  repo.createSessionGrant(firstGrant);
  db.prepare = prepare;
  assert.ok(seen.length >= 2 && seen.every(item => item === true), `restricted mint runs inside BEGIN IMMEDIATE ${JSON.stringify(seen)}`);

  // Move during mint: the issuer captured the generation before the move landed.
  const captured = generation();
  db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(id(2), id(12));
  db.prepare('UPDATE processing_tasks SET folder_id=? WHERE id=?').run(id(3), id(12));
  assert.throws(() => repo.createSessionGrant(grant(1, captured)), /restricted session scope/);
  assert.throws(() => repo.createViewerSession({ ...grant(1, captured), tokenHash: 'stale' }), /restricted session scope/);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM session_grants').get().count, 1);

  // A delayed issuer cannot mint under an acknowledged old grant version, even at the current generation.
  db.prepare('INSERT INTO revoked_published_session_authorizations VALUES (?, ?, ?)').run('direct_client_grant', id(700), 1);
  assert.throws(() => repo.createSessionGrant(grant(1)), /source authorization is revoked/);
  assert.ok(repo.createSessionGrant(grant(2)).id);
});
