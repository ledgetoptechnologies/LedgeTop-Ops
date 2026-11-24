'use strict';

// After a delete, complete or stopped partway, a model's earlier sign-in grants
// do not redeem and no new session or single-model link is issued for it. Real
// routes and database; tasks and projects are deleted and restored by staff.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const shareApi = require('../server/shareApi');
const { config } = require('../server/config');
const { createApiV1 } = require('../server/apiV1');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { signServiceRequest } = require('../server/serviceAuth');
const { ViewerRepository } = require('../server/repository');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-deleted-model-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });

  function makeProject(displayName) {
    const project = processing.createProject({ displayName });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', storageMode: 'external_reference', rootKey: 'imports', relativePath: crypto.randomUUID() });
    processing.finalizeDataset(dataset.id, [], 'c'.repeat(64));
    // A second task on the same photos, so deleting one task does not also try
    // to delete the photos another task needs.
    processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Sibling' });
    return { project, dataset };
  }
  function attemptOutput(site, task, state) {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const key = crypto.randomUUID();
    const model = repository.upsertModelVersion({
      provider: 'webodm', providerModelId: task.id, providerVersionId: key, displayName: task.displayName, status: 'ready', makeActive: state === 'published',
      assets: [{ kind: 'glb', format: 'glb', rootKey: 'webodm', relativePath: `${key}.glb`, byteSize: 4, sha256: digest(key), published: state === 'published' }],
    });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, key).id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: site.project.id, rootKey: 'webodm', relativePath: versionId, storageMode: 'external_reference', byteSize: 4, assetCount: 1 });
    const now = new Date().toISOString();
    if (state === 'published') {
      database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now, now, attempt.id);
      database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id, model.id, now, task.id);
      database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now, versionId);
    } else if (state === 'ready') {
      processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
    } else {
      database.prepare("UPDATE processing_attempts SET status='failed',completed_at=? WHERE id=?").run(now, attempt.id);
      database.prepare("UPDATE model_outputs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(versionId);
    }
    return { attempt, modelId: model.id, versionId };
  }
  // incomplete: an older output of the task that cannot be moved to the bin, so
  // the delete stops (409) after the task itself is in the bin.
  function makeTask(site, name, { state = 'published', incomplete = false } = {}) {
    const task = processing.createTask({ projectId: site.project.id, datasetId: site.dataset.id, displayName: name });
    const blocker = incomplete ? attemptOutput(site, task, 'failed') : null;
    const output = attemptOutput(site, task, state);
    if (blocker) database.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(blocker.attempt.id);
    return { task, ...output };
  }

  const staffToken = 'deleted-model-admin-token-00000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(staffToken), subject: 'ops:test', displayUnits: 'imperial',
    permissions: ['viewer.processing.read', 'viewer.processing.write', 'viewer.processing.publish', 'viewer.projects.write', 'viewer.storage.purge', 'viewer.shares.read', 'viewer.shares.create', 'viewer.shares.revoke'],
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const keys = ['serviceAuthKeyId', 'serviceAuthSecret', 'clientViewerSharesEnabled', 'publishedSessionSourceRevocationEnabled'];
  const previous = Object.fromEntries(keys.map((key) => [key, config[key]]));
  Object.assign(config, { serviceAuthKeyId: 'deleted-model', serviceAuthSecret: 'd'.repeat(40), clientViewerSharesEnabled: true, publishedSessionSourceRevocationEnabled: false });
  t.after(() => Object.assign(config, previous));

  shareApi.setRepository(repository);
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
    next();
  });
  app.use(shareApi);
  app.use(createApiV1(repository));
  app.use(createProcessingApi({ repository, processing, storage: { pathExistsStrict: () => true } }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, message: error.message }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  const staff = (method, route, body = {}) => fetch(base + route, { method, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json', 'idempotency-key': `deleted-model-${sequence += 1}` } });
  const service = (method, route, body, key = `deleted-model-service-${sequence += 1}`) => {
    const raw = JSON.stringify(body);
    return fetch(base + route, { method, body: raw, headers: { 'content-type': 'application/json', 'idempotency-key': key,
      ...signServiceRequest({ keyId: config.serviceAuthKeyId, secret: config.serviceAuthSecret, method, path: route, body: raw }) } });
  };
  const until = new Date(Date.now() + 600_000).toISOString();
  const sessionBody = (item, audience = 'client') => ({ modelId: undefined, modelVersionId: item.versionId, subject: `${audience}:one`, audience, permissions: { view: true }, displayUnits: 'imperial', authorizationExpiresAt: until,
    ...(audience === 'client' ? { sourceAuthorization: { type: 'direct_client_grant', id: 'grant-1', version: 1 } } : {}) });
  const issue = {
    'client session': (item, key) => service('POST', `/api/v1/models/${item.modelId}/sessions`, sessionBody(item), key),
    'staff session': (item, key) => service('POST', `/api/v1/models/${item.modelId}/sessions`, sessionBody(item, 'ops'), key),
    'workspace view': (item) => staff('POST', `/api/v1/processing/outputs/${item.versionId}/view-sessions`),
  };
  const links = {
    'service link': (item, body = {}) => service('POST', `/api/v1/models/${item.modelId}/shares`, { permissions: { view: true }, ...body }),
    'service client link': (item) => service('POST', `/api/v1/models/${item.modelId}/shares`, { permissions: { view: true }, shareClass: 'client', sourceAuthorization: { type: 'client_grant', id: 'g', version: 1, subject: 'client:one', expiresAt: null } }),
    'workspace link': (item, body = {}) => staff('POST', `/api/v1/processing/outputs/${item.versionId}/shares`, body),
  };
  const redeem = async (grant) => (await fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }) }));
  const count = (table) => database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  const liveSessions = () => database.prepare('SELECT COUNT(*) n FROM viewer_sessions WHERE revoked_at IS NULL').get().n;
  const audits = () => database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN ('session.created','session.redeemed','share.created','processing_published_session.created','processing_review_session.created')").get().n;
  const bin = (item) => processing.activeTrashForEntity('task', item.task.id);
  async function grantsFor(item) {
    const grants = {};
    for (const [name, call] of Object.entries(issue)) {
      const response = await call(item), body = await response.json();
      assert.equal(response.status, 201, `${name} ${JSON.stringify(body)}`);
      grants[name] = body.grant;
    }
    return grants;
  }
  // Nothing new is issued, and nothing is written for it.
  async function refusedToIssue(item, note) {
    const before = [count('session_grants'), liveSessions(), count('public_shares'), audits()];
    for (const [name, call] of Object.entries({ ...issue, ...links })) {
      const response = await call(item), text = await response.text();
      assert.equal(response.status, 404, `${note} ${name}: ${text}`);
      assert.deepEqual(Object.keys(JSON.parse(text)).filter((key) => !['error', 'code', 'message'].includes(key)), [], `${note} ${name}`);
    }
    assert.deepEqual([count('session_grants'), liveSessions(), count('public_shares'), audits()], before, note);
  }
  async function refusedToRedeem(grants, note) {
    const before = liveSessions();
    for (const [name, grant] of Object.entries(grants)) {
      const response = await redeem(grant);
      assert.equal(response.status, 410, `${note} ${name}`);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    assert.equal(liveSessions(), before, note);
  }
  async function works(item, note) {
    for (const [name, grant] of Object.entries(await grantsFor(item))) assert.equal((await redeem(grant)).status, 200, `${note} ${name}`);
    for (const [name, call] of Object.entries(links)) assert.equal((await call(item)).status, 201, `${note} ${name}`);
  }
  return { database, repository, processing, base, makeProject, makeTask, staff, service, sessionBody, issue, links, redeem, count, audits, bin, grantsFor, refusedToIssue, refusedToRedeem, works };
}

const deleteTask = (f, item) => f.staff('DELETE', `/api/v1/tasks/${item.task.id}`);

test('a deleted task: earlier grants do not redeem and nothing new is issued', async (t) => {
  for (const incomplete of [false, true]) {
    const note = incomplete ? 'stopped partway' : 'complete', f = await fixture(t), site = f.makeProject('Project');
    const item = f.makeTask(site, 'Deleted', { incomplete }), kept = f.makeTask(site, 'Kept');
    await f.works(item, `${note} before`);
    const grants = await f.grantsFor(item), keptGrants = await f.grantsFor(kept);
    assert.equal((await deleteTask(f, item)).status, incomplete ? 409 : 200);
    assert.ok(f.bin(item));
    assert.equal(f.repository.getModel(item.modelId).status, incomplete ? 'ready' : 'unregistered', 'the case under test');
    await f.refusedToRedeem(grants, note);
    await f.refusedToIssue(item, note);
    // Another task of the same project is untouched.
    for (const grant of Object.values(keptGrants)) assert.equal((await f.redeem(grant)).status, 200, note);
    await f.works(kept, `${note} kept`);
  }
});

test('restoring allows new sessions and links, and brings back none of the old ones', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted', { incomplete: true });
  const grants = await f.grantsFor(item), open = await f.redeem((await (await f.issue['client session'](item)).json()).grant);
  assert.equal(open.status, 200);
  const { accessToken } = await open.json(), link = await (await f.links['service link'](item)).json();
  const current = () => fetch(`${f.base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${accessToken}` } });
  assert.equal((await current()).status, 200);
  assert.equal((await deleteTask(f, item)).status, 409);
  assert.equal((await current()).status, 401);
  assert.equal((await fetch(`${f.base}/api/share/${link.token}`)).status, 410);
  await f.refusedToIssue(item, 'deleted');
  assert.equal((await f.staff('POST', `/api/v1/storage/trash/${f.bin(item).id}/restore`)).status, 200);
  await f.refusedToRedeem(grants, 'restored');
  assert.equal((await current()).status, 401);
  assert.equal((await fetch(`${f.base}/api/share/${link.token}`)).status, 410);
  await f.works(item, 'restored');
});

test('the open trash item decides, whatever the task status says', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted', { incomplete: true });
  assert.equal((await deleteTask(f, item)).status, 409);
  for (const status of ['draft', 'ready_for_review', 'published']) {
    f.database.prepare('UPDATE processing_tasks SET status=?,archived_at=NULL WHERE id=?').run(status, item.task.id);
    await f.refusedToIssue(item, status);
  }
  // Purged: no trash item is open any more.
  const trash = f.bin(item);
  f.database.prepare('UPDATE storage_trash SET permanently_deleted_at=? WHERE id=?').run(new Date().toISOString(), trash.id);
  f.database.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(), item.task.id);
  await f.refusedToIssue(item, 'purged');
});

test('a deleted project: the same for every model in it, also when the delete stops partway', async (t) => {
  for (const incomplete of [false, true]) {
    const note = incomplete ? 'stopped partway' : 'complete', f = await fixture(t), site = f.makeProject('Project'), other = f.makeProject('Other');
    const first = f.makeTask(site, 'First', { incomplete }), second = f.makeTask(site, 'Second'), kept = f.makeTask(other, 'Kept');
    const grants = [await f.grantsFor(first), await f.grantsFor(second)], keptGrants = await f.grantsFor(kept);
    const response = await f.staff('DELETE', `/api/v1/projects/${site.project.id}`);
    if (incomplete) assert.equal(response.status, 409);
    assert.ok(f.processing.activeTrashForEntity('project', site.project.id), note);
    for (const item of grants) await f.refusedToRedeem(item, note);
    for (const item of [first, second]) await f.refusedToIssue(item, note);
    for (const grant of Object.values(keptGrants)) assert.equal((await f.redeem(grant)).status, 200, note);
    await f.works(kept, note);
  }
});

test('review of an unpublished output: earlier review grants do not redeem, none are issued, and sharing cannot publish it', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'In review', { state: 'ready', incomplete: true });
  const review = () => f.staff('POST', `/api/v1/attempts/${item.attempt.id}/review-sessions`);
  assert.equal((await f.redeem((await (await review()).json()).grant)).status, 200);
  const { grant } = await (await review()).json();
  assert.equal((await deleteTask(f, item)).status, 409);
  await f.refusedToRedeem({ review: grant }, 'review');
  // The task keeps its attempt; only its status shows the delete.
  for (const status of ['archived', 'ready_for_review']) {
    f.database.prepare('UPDATE processing_tasks SET status=? WHERE id=?').run(status, item.task.id);
    const refused = await review();
    assert.equal(refused.status, 409, status);
    assert.equal((await refused.json()).code, 'review_output_unavailable');
    const shared = await f.links['workspace link'](item, { publishIfReady: true, selectedAssetKinds: ['glb'], allowExistingAccessUpdate: true });
    assert.equal(shared.status, 404, status);
    assert.equal(f.processing.getModelOutput(item.versionId).status, 'ready', status);
  }
  assert.equal(f.count('public_shares'), 0);
});

test('a delete during the request: a link whose password is still being hashed is not created', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), original = auth.hashPassword;
  t.after(() => { auth.hashPassword = original; });
  for (const [name, status] of [['service link', 404], ['workspace link', 409]]) {
    const item = f.makeTask(site, name, { incomplete: true }), before = [f.count('public_shares'), f.audits()];
    auth.hashPassword = async (value) => { assert.equal((await deleteTask(f, item)).status, 409); return original(value); };
    const response = await f.links[name](item, { password: 'password123' });
    auth.hashPassword = original;
    assert.equal(response.status, status, `${name} ${await response.text()}`);
    assert.deepEqual([f.count('public_shares'), f.audits()], before, name);
  }
});

test('a replayed request returns the old answer but nothing usable', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted', { incomplete: true });
  const session = await (await f.issue['client session'](item, 'replayed-session-key')).json();
  const route = `/api/v1/models/${item.modelId}/shares`, share = await (await f.service('POST', route, { permissions: { view: true } }, 'replayed-share-key')).json();
  assert.equal((await deleteTask(f, item)).status, 409);
  const before = [f.count('session_grants'), f.count('public_shares')];
  const sessionAgain = await (await f.issue['client session'](item, 'replayed-session-key')).json(), shareAgain = await (await f.service('POST', route, { permissions: { view: true } }, 'replayed-share-key')).json();
  assert.equal(sessionAgain.grant, session.grant);
  assert.equal(shareAgain.token, share.token);
  await f.refusedToRedeem({ replayed: session.grant }, 'replay');
  assert.equal((await fetch(`${f.base}/api/share/${share.token}`)).status, 410);
  assert.deepEqual([f.count('session_grants'), f.count('public_shares')], before);
});

test('the repository itself refuses, not only the routes', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted', { incomplete: true });
  const session = { modelId: item.modelId, modelVersionId: item.versionId, subject: 'client:one', audience: 'client', permissions: { view: true }, expiresAt: new Date(Date.now() + 60_000).toISOString() };
  const grant = f.repository.createSessionGrant(session);
  const later = f.repository.createSessionGrant(session);
  assert.equal((await deleteTask(f, item)).status, 409);
  assert.equal(f.repository.redeemSessionGrant(grant.id), null);
  // A grant row that somehow outlives the delete is refused as well, unspent.
  f.database.prepare(`INSERT INTO session_grants(id,model_id,model_version_id,session_mode,subject,audience,permissions_json,display_units,expires_at,created_at)
    VALUES (?,?,?,'published','client:one','client','{"view":true}','imperial',?,?)`).run(later.id, item.modelId, item.versionId, session.expiresAt, new Date().toISOString());
  assert.equal(f.repository.redeemSessionGrant(later.id), null);
  assert.equal(f.database.prepare('SELECT redeemed_at FROM session_grants WHERE id=?').get(later.id).redeemed_at, null);
  assert.throws(() => f.repository.createSessionGrant(session), { code: 'model_deleted' });
  assert.equal(f.repository.createViewerSession({ ...session, tokenHash: auth.hashToken('never-stored-token') }), null);
  assert.throws(() => f.repository.createPublicShare({ modelId: item.modelId, publicIdHash: auth.hashToken('never-stored-link'), permissions: { view: true } }), { code: 'model_deleted' });
});

test('models that were never processed here, and archived tasks, are unaffected', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Archived');
  assert.equal((await f.staff('POST', `/api/v1/tasks/${item.task.id}/archive`)).status, 200);
  for (const name of ['client session', 'staff session', 'workspace view']) assert.equal((await f.issue[name](item)).status, 201, name);
  assert.equal((await f.links['service link'](item)).status, 201);
  const imported = f.repository.upsertModelVersion({ provider: 'terra', providerModelId: 'imported', providerVersionId: 'v1', displayName: 'Imported', status: 'ready', makeActive: true, assets: [] });
  const legacy = { modelId: imported.id, versionId: imported.activeVersion.id };
  assert.equal((await f.issue['client session'](legacy)).status, 201);
  assert.equal((await f.links['service link'](legacy)).status, 201);
});

test('a version of its own decides; a version without one follows the rest of the model', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), live = f.makeTask(site, 'Live'), gone = f.makeTask(site, 'Deleted', { incomplete: true });
  // An older arrangement: one model with outputs from two tasks.
  f.database.prepare('UPDATE model_outputs SET model_id=? WHERE task_id=?').run(live.modelId, gone.task.id);
  assert.ok(f.processing.trashTask(gone.task.id, 'ops:test'));
  assert.equal(f.repository.modelDeleted(live.modelId), false, 'active version of the live task');
  assert.equal(f.repository.modelDeleted(live.modelId, gone.versionId), true);
  assert.equal((await f.issue['client session'](live)).status, 201);
  f.database.prepare('DELETE FROM model_outputs WHERE id=?').run(live.versionId);
  assert.equal(f.repository.modelDeleted(live.modelId), true, 'no output of its own');
  assert.equal((await f.issue['client session'](live)).status, 404);
});

test('a restored project does not bring back earlier grants', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Task'), grants = await f.grantsFor(item);
  const trash = f.processing.trashProject(site.project.id, 'ops:test');
  await f.refusedToIssue(item, 'deleted');
  assert.ok(f.processing.restoreMetadataEntity(trash.id, 'ops:test'));
  await f.refusedToRedeem(grants, 'restored');
  await f.works(item, 'restored');
});
