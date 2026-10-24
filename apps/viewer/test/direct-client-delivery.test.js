'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const express = require('express');
process.env.SERVICE_AUTH_KEY_ID = 'direct-test';
process.env.PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED = 'false';
process.env.SERVICE_AUTH_SECRET = 'direct-client-catalog-test-service-secret';
const { MIGRATIONS, applyMigrations } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { createClientDeliveryCatalog } = require('../server/clientDeliveryCatalog');
const { signServiceRequest } = require('../server/serviceAuth');
const { createApiV1 } = require('../server/apiV1');

function fixture(t, through = 40) {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter(m => m.version <= through)) {
    database.exec('BEGIN IMMEDIATE');
    database.exec(migration.sql); migration.after?.(database);
    database.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(migration.version, migration.name, new Date().toISOString());
    database.exec('COMMIT');
  }
  t.after(() => database.close());
  return { database, repository: new ViewerRepository(database), processing: new ProcessingRepository(database) };
}
function readyModel(repository, suffix = crypto.randomUUID()) {
  return repository.upsertModelVersion({ provider: 'terra', providerModelId: suffix, providerVersionId: 'v1',
    displayName: `Model ${suffix}`, sourceLocator: {}, status: 'ready', makeActive: true, assets: [] });
}
function sessionInput(model, sourceAuthorization) {
  return { modelId: model.id, modelVersionId: model.activeVersion.id, sourceAuthorization,
    subject: 'client:one-person', audience: 'client', permissions: { view: true }, expiresAt: new Date(Date.now() + 600_000).toISOString() };
}
function publish({ database, repository, processing }, project, label) {
  const dataset = processing.createDataset({ projectId: project.id, displayName: label, storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  database.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?").run('a'.repeat(64), new Date().toISOString(), dataset.id);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: label });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Test provider', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
  const model = readyModel(repository, task.id);
  processing.setAttemptResult(attempt.id, model.id, model.activeVersion.id);
  processing.registerModelOutput({ versionId: model.activeVersion.id, modelId: model.id, taskId: task.id,
    attemptId: attempt.id, projectId: project.id, rootKey: 'models', relativePath: task.id, byteSize: 1, assetCount: 0 });
  database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(model.activeVersion.id);
  database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=? WHERE id=?").run(attempt.id, model.id, task.id);
  return { task, model };
}
async function listener(t, app) {
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, signed: (url, options = {}) => {
    const body = options.body || '', method = options.method || 'GET';
    return fetch(base + url, { ...options, headers: { ...signServiceRequest({ secret: process.env.SERVICE_AUTH_SECRET,
      keyId: process.env.SERVICE_AUTH_KEY_ID, method, path: url, body }), ...(body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } });
  } };
}

test('migration40 preserves legacy authority/data/indexes/triggers and isolates typed durable revocation', t => {
  const { database, repository } = fixture(t, 39), model = readyModel(repository);
  const authority = { type: 'model_association', id: 'same-id', version: 1 };
  const grant = repository.createSessionGrant(sessionInput(model, authority));
  repository.createViewerSession({ ...sessionInput(model, authority), tokenHash: 'legacy-token-hash' });
  repository.revokePublishedSessionsBySourceAuthorization({ sourceAuthorization: { ...authority, id: 'old-tombstone' }, audit: { actorType: 'service', action: 'test', entityType: 'source_authorization' } });
  const names = ['session_grants', 'viewer_sessions', 'revoked_published_session_authorizations'];
  const before = names.map(name => database.prepare(`SELECT * FROM ${name}`).all());
  const objects = database.prepare("SELECT name,type FROM sqlite_master WHERE tbl_name IN ('session_grants','viewer_sessions','revoked_published_session_authorizations') AND type IN ('index','trigger') ORDER BY name").all();
  applyMigrations(database);
  assert.deepEqual(names.map(name => database.prepare(`SELECT * FROM ${name}`).all()), before);
  assert.deepEqual(database.prepare("SELECT name,type FROM sqlite_master WHERE tbl_name IN ('session_grants','viewer_sessions','revoked_published_session_authorizations') AND type IN ('index','trigger') ORDER BY name").all(), objects);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  assert.throws(() => database.prepare("UPDATE session_grants SET source_authorization_id='changed' WHERE id=?").run(grant.id), /immutable/);
  assert.throws(() => database.prepare("UPDATE viewer_sessions SET source_authorization_type='direct_client_grant' WHERE token_hash='legacy-token-hash'").run(), /immutable/);
  const direct = { type: 'direct_client_grant', id: 'same-id', version: 1 }, directInput = sessionInput(model, direct);
  const directGrant = repository.createSessionGrant(directInput), staleSession = repository.createViewerSession({ ...directInput, tokenHash: 'direct-token-hash' });
  const nextVersion = repository.createViewerSession({ ...sessionInput(model, { ...direct, version: 2 }), tokenHash: 'next-version-hash' });
  assert.deepEqual(repository.getViewerSessionByHash('direct-token-hash').sourceAuthorization, direct);
  const result = repository.revokePublishedSessionsBySourceAuthorization({ sourceAuthorization: direct, audit: { actorType: 'service', action: 'test', entityType: 'source_authorization' } });
  assert.equal(result.revokedGrants, 1); assert.equal(result.revokedSessions, 1);
  assert.equal(repository.redeemSessionGrant(directGrant.id), null);
  assert.equal(repository.viewerSessionLive(staleSession), false);
  assert.equal(repository.viewerSessionLive(nextVersion), true);
  assert.ok(repository.redeemSessionGrant(grant.id), 'same ID in legacy authority remains usable');
  assert.equal(repository.getViewerSessionByHash('legacy-token-hash').revokedAt, null);
  assert.throws(() => repository.createSessionGrant(directInput), /revoked/);
  assert.equal(repository.createViewerSession({ ...directInput, tokenHash: 'retry-token-hash' }), null);
  assert.throws(() => database.prepare("INSERT INTO revoked_published_session_authorizations VALUES('unknown','x',1,'now',NULL)").run(), /CHECK/);
});

test('signed client catalog has bounded pagination, exact-task isolation and fresh publication fences', async t => {
  const state = fixture(t), { database, processing } = state, project = processing.createProject({ displayName: 'Client delivery' });
  const first = publish(state, project, 'First flight'), second = publish(state, project, 'Second flight');
  const foreignProject = processing.createProject({ displayName: 'Another client' }), foreign = publish(state, foreignProject, 'Private flight');
  const app = express(); app.use(createClientDeliveryCatalog(state.repository));
  const { base, signed } = await listener(t, app), url = `/api/v1/client-delivery-catalog?projectId=${project.id}`;
  assert.equal((await fetch(base + url)).status, 401);
  const headers = signServiceRequest({ secret: process.env.SERVICE_AUTH_SECRET, keyId: process.env.SERVICE_AUTH_KEY_ID, method: 'GET', path: url });
  assert.equal((await fetch(base + url, { headers })).status, 200);
  assert.equal((await fetch(base + url, { headers })).status, 401, 'service nonce replay rejected');
  const pageOneResponse = await signed(url + '&limit=1'), pageOne = await pageOneResponse.json();
  assert.equal(pageOneResponse.headers.get('cache-control'), 'no-store');
  assert.equal(pageOne.schemaVersion, 1); assert.equal(pageOne.tasks.length, 1); assert.ok(pageOne.nextCursor);
  const pageTwo = await (await signed(url + '&limit=1&cursor=' + pageOne.nextCursor)).json();
  assert.equal(pageTwo.tasks.length, 1); assert.equal(pageTwo.nextCursor, null);
  assert.notEqual(pageOne.tasks[0].id, pageTwo.tasks[0].id);
  const single = await (await signed(url + `&taskId=${first.task.id}`)).json();
  assert.deepEqual(single.tasks.map(row => row.id), [first.task.id]); assert.equal(single.nextCursor, null);
  assert.equal((await signed(url + `&taskId=${foreign.task.id}`)).status, 404);
  for (const tail of ['&limit=51', '&limit=0', '&cursor=invalid_cursor', '&projectId=duplicate', `&taskId=${first.task.id}&cursor=${pageOne.nextCursor}`, '&unexpected=x'])
    assert.equal((await signed(url + tail)).status, 400, tail);
  database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(first.task.id);
  assert.equal((await signed(url + `&taskId=${first.task.id}`)).status, 404);
  database.prepare("UPDATE model_versions SET status='failed' WHERE id=?").run(second.model.activeVersion.id);
  assert.deepEqual((await (await signed(url)).json()).tasks, []);
  database.prepare("UPDATE model_versions SET status='ready' WHERE id=?").run(second.model.activeVersion.id);
  database.prepare("UPDATE processing_tasks SET purged_at=? WHERE id=?").run(new Date().toISOString(), second.task.id);
  assert.equal((await signed(url + `&taskId=${second.task.id}`)).status, 404);
  database.prepare("UPDATE projects SET status='archived' WHERE id=?").run(project.id);
  assert.equal((await signed(url)).status, 404);
});

test('migration40 rejects unexpected inbound references atomically and retains the old authority constraint', t => {
  const { database } = fixture(t, 39);
  database.exec('CREATE TABLE unexpected_extension(id TEXT PRIMARY KEY,grant_id TEXT REFERENCES session_grants(id))');
  assert.throws(() => applyMigrations(database), /reviewed leaf tables/);
  assert.equal(database.prepare('SELECT MAX(version) version FROM schema_migrations').get().version, 39);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE name LIKE '%_direct_client_migration'").get().count, 0);
  assert.match(database.prepare("SELECT sql FROM sqlite_master WHERE name='session_grants'").get().sql, /source_authorization_type='model_association'/);
  database.exec('DROP TABLE unexpected_extension'); applyMigrations(database); applyMigrations(database);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM schema_migrations WHERE version=40').get().count, 1);
});

test('direct source revoke service works with legacy rollout flag disabled and blocks new issuance', async t => {
  const { repository } = fixture(t), model = readyModel(repository), source = { type: 'direct_client_grant', id: 'grant-one', version: 1 };
  const app = express(); app.use(express.json({ verify(req, _res, body) { req.rawBody = body; } })); app.use(createApiV1(repository));
  const { signed } = await listener(t, app), url = '/api/v1/published-sessions/source-authorization';
  repository.createSessionGrant(sessionInput(model, source));
  const body = JSON.stringify({ sourceAuthorization: source });
  const result = await signed(url, { method: 'DELETE', body, headers: { 'Idempotency-Key': 'direct-revoke-fixture-0001' } });
  assert.equal(result.status, 200); assert.equal((await result.json()).revokedGrants, 1);
  const replay = await signed(url, { method: 'DELETE', body, headers: { 'Idempotency-Key': 'direct-revoke-fixture-0001' } });
  assert.equal(replay.status, 200); assert.equal((await replay.json()).revokedGrants, 1);
  assert.throws(() => repository.createSessionGrant(sessionInput(model, source)), /revoked/);
  assert.equal((await signed(url, { method: 'DELETE', body: JSON.stringify({ sourceAuthorization: { ...source, type: 'unknown' } }), headers: { 'Idempotency-Key': 'invalid-revoke-fixture-0001' } })).status, 503);
});

test('direct authority survives redemption and exact-authority renewal, then revokes browser access', async t => {
  const { repository } = fixture(t), model = readyModel(repository), source = { type: 'direct_client_grant', id: 'grant-renew', version: 1 };
  const app = express(); app.use(express.json({ verify(req, _res, body) { req.rawBody = body; } })); app.use(createApiV1(repository));
  const { base, signed } = await listener(t, app), sessionPath = `/api/v1/models/${model.id}/sessions`;
  const issue = async (authorization, key) => {
    const response = await signed(sessionPath, { method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({
      modelVersionId: model.activeVersion.id, subject: 'client:person', audience: 'client', permissions: { view: true },
      authorizationExpiresAt: new Date(Date.now() + 600_000).toISOString(), sourceAuthorization: authorization,
    }) });
    return { response, body: await response.json() };
  };
  const first = await issue(source, 'direct-first-session-0001'); assert.equal(first.response.status, 201);
  const redeem = (grant, token) => fetch(base + '/api/v1/sessions/redeem', { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ grant }) });
  const redeemed = await redeem(first.body.grant); assert.equal(redeemed.status, 200);
  const live = await redeemed.json(); assert.ok(live.accessToken);
  assert.equal(repository.getViewerSessionByHash(crypto.createHash('sha256').update(live.accessToken).digest('hex')).sourceAuthorization.type, 'direct_client_grant');
  const renewed = await issue(source, 'direct-renew-session-0001'); assert.equal(renewed.response.status, 201);
  const renewal = await redeem(renewed.body.grant, live.accessToken); assert.equal(renewal.status, 200);
  assert.equal((await renewal.json()).sessionId, live.sessionId);
  repository.revokePublishedSessionsBySourceAuthorization({ sourceAuthorization: source,
    audit: { actorType: 'service', action: 'test', entityType: 'source_authorization' } });
  assert.equal((await fetch(base + '/api/v1/sessions/current', { headers: { Authorization: `Bearer ${live.accessToken}` } })).status, 401);
  assert.equal((await issue(source, 'direct-revoked-session-0001')).response.status, 409);
  assert.equal((await issue({ ...source, type: 'unknown' }, 'direct-invalid-session-0001')).response.status, 400);
});
