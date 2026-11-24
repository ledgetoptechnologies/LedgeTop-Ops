'use strict';

// A session or link and the receipt that replays it are stored together, and a
// grant is spent only together with the session it opens. Real routes and
// database; storage failures are injected with triggers.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { config } = require('../server/config');
const { createApiV1 } = require('../server/apiV1');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { signServiceRequest } = require('../server/serviceAuth');
const { ViewerRepository } = require('../server/repository');

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-issue-receipts-')), database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true }), project = processing.createProject({ displayName: 'Project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', storageMode: 'external_reference', rootKey: 'imports', relativePath: 'flight' });
  processing.finalizeDataset(dataset.id, [], 'c'.repeat(64));
  function output(name, published) {
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: name }), attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const model = repository.upsertModelVersion({ provider: 'webodm', providerModelId: task.id, providerVersionId: 'v1', displayName: name, status: 'ready', makeActive: published, assets: [{ kind: 'glb', format: 'glb', rootKey: 'webodm', relativePath: 'm.glb', byteSize: 4, sha256: 'b'.repeat(64), published }] });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id, now = new Date().toISOString();
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, rootKey: 'webodm', relativePath: versionId, storageMode: 'external_reference', byteSize: 4, assetCount: 1 });
    if (published) {
      database.prepare("UPDATE processing_attempts SET status='published',completed_at=? WHERE id=?").run(now, attempt.id);
      database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=? WHERE id=?").run(attempt.id, model.id, task.id);
      database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(versionId);
    } else processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
    return { attempt, modelId: model.id, versionId };
  }
  const published = output('Published', true), review = output('In review', false);
  const token = 'issue-receipts-admin-token-000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:test', displayUnits: 'imperial', permissions: ['viewer.processing.read', 'viewer.processing.publish', 'viewer.shares.create'], expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const keys = ['serviceAuthKeyId', 'serviceAuthSecret', 'publishedSessionSourceRevocationEnabled'], previous = Object.fromEntries(keys.map((key) => [key, config[key]]));
  Object.assign(config, { serviceAuthKeyId: 'issue-receipts', serviceAuthSecret: 'r'.repeat(40), publishedSessionSourceRevocationEnabled: false });
  t.after(() => Object.assign(config, previous));
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createApiV1(repository));
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  app.use((error, _req, res, _next) => res.status(500).json({ code: 'internal' }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = (route, key) => fetch(base + route, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'idempotency-key': key } });
  const service = (route, body, key) => {
    const raw = JSON.stringify(body);
    return fetch(base + route, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'idempotency-key': key, ...signServiceRequest({ keyId: config.serviceAuthKeyId, secret: config.serviceAuthSecret, method: 'POST', path: route, body: raw }) } });
  };
  const until = new Date(Date.now() + 600_000).toISOString();
  const routes = {
    'service session': { table: 'session_grants', receipts: 'service_idempotency', call: (key) => service(`/api/v1/models/${published.modelId}/sessions`, { modelVersionId: published.versionId, subject: 'client:one', audience: 'client', permissions: { view: true }, displayUnits: 'imperial', authorizationExpiresAt: until }, key) },
    'service link': { table: 'public_shares', receipts: 'service_idempotency', call: (key) => service(`/api/v1/models/${published.modelId}/shares`, { permissions: { view: true } }, key) },
    'staff view': { table: 'session_grants', receipts: 'admin_idempotency', call: (key) => staff(`/api/v1/processing/outputs/${published.versionId}/view-sessions`, key) },
    'staff review': { table: 'session_grants', receipts: 'admin_idempotency', call: (key) => staff(`/api/v1/attempts/${review.attempt.id}/review-sessions`, key) },
  };
  const count = (table) => database.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
  return { root, database, repository, processing, token, base, routes, count, published, until, service, revoke: (key, source) => {
    const route = '/api/v1/published-sessions/source-authorization', raw = JSON.stringify({ sourceAuthorization: source });
    return fetch(base + route, { method: 'DELETE', body: raw, headers: { 'content-type': 'application/json', 'idempotency-key': key, ...signServiceRequest({ keyId: config.serviceAuthKeyId, secret: config.serviceAuthSecret, method: 'DELETE', path: route, body: raw }) } });
  } };
}

test('a session or link and its receipt are stored together or not at all', async (t) => {
  const f = await fixture(t);
  for (const [name, { table, receipts, call }] of Object.entries(f.routes)) {
    const before = [f.count(table), f.count('audit_events')], key = `receipt-key-${name.replace(' ', '-')}`;
    f.database.exec(`CREATE TRIGGER fail_receipt BEFORE UPDATE OF response_status ON ${receipts} BEGIN SELECT RAISE(ABORT,'synthetic receipt failure'); END`);
    assert.equal((await call(key)).status, 500, name);
    assert.deepEqual([f.count(table), f.count('audit_events')], before, `${name}: nothing issued without its receipt`);
    f.database.exec('DROP TRIGGER fail_receipt');
    f.database.prepare(`DELETE FROM ${receipts} WHERE response_status IS NULL`).run();
    const first = await call(key), body = await first.json();
    assert.equal(first.status, 201, name);
    assert.equal(f.count(table), before[0] + 1, name);
    const again = await call(key);
    assert.deepEqual([again.status, again.headers.get('idempotency-replayed')], [201, 'true'], name);
    assert.deepEqual(await again.json(), body, name);
    assert.equal(f.count(table), before[0] + 1, `${name}: issued once`);
  }
});

test('a receipt is there as soon as what it answers with is, even if the response is never sent', async (t) => {
  const f = await fixture(t), express4 = require('express').response, json = express4.json;
  t.after(() => { express4.json = json; });
  for (const [name, { table, call }] of Object.entries(f.routes)) {
    const before = f.count(table), key = `lost-response-${name.replace(' ', '-')}`;
    express4.json = function lost(body) { if (this.statusCode === 201) { this.socket.destroy(); return this; } return json.call(this, body); };
    await assert.rejects(call(key), name);
    express4.json = json;
    assert.equal(f.count(table), before + 1, name);
    const replay = await call(key);
    assert.deepEqual([replay.status, replay.headers.get('idempotency-replayed')], [201, 'true'], name);
    assert.equal(f.count(table), before + 1, `${name}: not issued twice`);
  }
});

test('a grant is spent only together with the session it opens', async (t) => {
  const f = await fixture(t), { grant } = await (await f.routes['service session'].call('redeem-together-key')).json();
  const redeem = () => fetch(`${f.base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }) });
  for (const trigger of ["BEFORE INSERT ON viewer_sessions BEGIN SELECT RAISE(ABORT,'synthetic'); END", "BEFORE INSERT ON audit_events WHEN NEW.action='session.redeemed' BEGIN SELECT RAISE(ABORT,'synthetic'); END"]) {
    f.database.exec(`CREATE TRIGGER fail_redeem ${trigger}`);
    const failed = await redeem();
    assert.equal(failed.status, 500);
    assert.equal(failed.headers.get('set-cookie'), null);
    assert.equal(f.count('viewer_sessions'), 0);
    assert.equal(f.database.prepare('SELECT redeemed_at FROM session_grants WHERE id=?').get(grant).redeemed_at, null);
    f.database.exec('DROP TRIGGER fail_redeem');
  }
  assert.equal((await redeem()).status, 200);
  assert.equal((await redeem()).status, 410);
  assert.equal(f.count('viewer_sessions'), 1);
  assert.throws(() => f.repository.redeemSessionGrantInTransaction(crypto.randomUUID()), /active transaction/);
});

test('refused redemptions and kept refusals are unchanged', async (t) => {
  const f = await fixture(t);
  const redeem = (grant) => fetch(`${f.base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }) });
  assert.equal((await redeem(crypto.randomUUID())).status, 410);
  const gone = f.repository.createSessionGrant({ modelId: f.published.modelId, modelVersionId: f.published.versionId, subject: 'client:one', audience: 'client', permissions: { view: true, __authorizedUntil: '2020-01-01T00:00:00.000Z' }, expiresAt: f.until });
  assert.equal((await redeem(gone.id)).status, 410);
  const bad = () => f.service(`/api/v1/models/${f.published.modelId}/sessions`, { modelVersionId: f.published.versionId, subject: '', audience: 'client', permissions: { view: true }, authorizationExpiresAt: f.until }, 'kept-refusal-key');
  assert.equal((await bad()).status, 400);
  assert.equal((await bad()).headers.get('idempotency-replayed'), 'true');
});

// ---- A reservation that is lost while its request runs ----

// Runs lose(row) once, right before the transaction that issues begins, when the request's reservation is there.
function loseReservation(f, table, key, lose) {
  const original = f.repository.transaction;
  let lost = null;
  f.repository.transaction = function transaction(...args) {
    const row = lost ? null : f.database.prepare(`SELECT rowid AS row_id,* FROM ${table} WHERE idempotency_key=? AND response_status IS NULL`).get(key);
    if (row) { lost = row; lose(row); }
    return original.apply(this, args);
  };
  return { row: () => lost, done: () => { f.repository.transaction = original; } };
}
const held = (f, table, key) => f.database.prepare(`SELECT * FROM ${table} WHERE idempotency_key=?`).get(key);
// As maintenance (service) or another request (staff) removes it.
function prune(f, table, row) {
  if (table === 'service_idempotency') {
    f.database.prepare("UPDATE service_idempotency SET expires_at='2020-01-01T00:00:00.000Z' WHERE rowid=?").run(row.row_id);
    assert.equal(f.repository.pruneAuthState().idempotency, 1);
  } else f.database.prepare('DELETE FROM admin_idempotency WHERE rowid=?').run(row.row_id);
}
// The same request again, once the first reservation is gone: a new reservation of the same key.
function supersede(f, table, row) {
  if (table === 'service_idempotency') {
    prune(f, table, row);
    assert.equal(f.repository.reserveIdempotency({ keyId: row.key_id, idempotencyKey: row.idempotency_key, method: row.method, path: row.path, requestHash: row.request_hash, expiresAt: f.until }).created, true);
  } else {
    f.database.prepare('UPDATE admin_idempotency SET created_at=? WHERE rowid=?').run(new Date(Date.now() - 16 * 60_000).toISOString(), row.row_id);
    assert.equal(f.processing.reserveAdminIdempotency({ sessionId: row.session_id, key: row.idempotency_key, method: row.method, path: row.path, requestHash: row.request_hash }).created, true);
  }
  // The new reservation is made later than the first one; here within the same millisecond, perhaps.
  f.database.prepare(`UPDATE ${table} SET created_at=? WHERE idempotency_key=?`).run(new Date(Date.now() + 1000).toISOString(), row.idempotency_key);
}

test('nothing is issued once the reservation is gone, or is held by another request', async (t) => {
  const f = await fixture(t);
  for (const [name, { table, receipts, call }] of Object.entries(f.routes)) {
    for (const lost of ['pruned', 'superseded', 'reserved for another request', 'already completed']) {
      const note = `${name} ${lost}`, key = note.replaceAll(' ', '-'), before = [f.count(table), f.count('audit_events')];
      const hook = loseReservation(f, receipts, key, (row) => {
        if (lost === 'pruned') prune(f, receipts, row);
        else if (lost === 'superseded') supersede(f, receipts, row);
        else if (lost === 'already completed') f.database.prepare(`UPDATE ${receipts} SET response_status=409 WHERE rowid=?`).run(row.row_id);
        else f.database.prepare(`UPDATE ${receipts} SET request_hash=? WHERE rowid=?`).run('d'.repeat(64), row.row_id);
      });
      const response = await call(key);
      hook.done();
      assert.ok(hook.row(), `${note}: the case under test`);
      assert.equal(response.status, 500, note);
      assert.deepEqual([f.count(table), f.count('audit_events')], before, `${note}: nothing issued`);
      await new Promise((resolve) => { setTimeout(resolve, 10); });
      const after = held(f, receipts, key);
      if (lost === 'pruned') assert.equal(after, undefined, note);
      else {
        // The other request's reservation is as it was: no receipt attached, not released.
        assert.ok(after, note);
        assert.equal(after.response_status, lost === 'already completed' ? 409 : null, note);
        assert.equal(after.response_ciphertext ?? after.response_json ?? null, null, note);
      }
    }
  }
});

test('completing or releasing names one pending reservation exactly, and an answer that issues nothing is still given', async (t) => {
  const f = await fixture(t), session = f.database.prepare('SELECT id FROM admin_sessions').get().id;
  const stores = {
    service: { reserve: () => f.repository.reserveIdempotency({ keyId: 'k', idempotencyKey: 'one-pending-row', method: 'POST', path: '/p', requestHash: 'h', expiresAt: f.until }).reservation,
      complete: (value) => f.repository.completeIdempotency(value, 200, 'c'), release: (value) => f.repository.releaseIdempotency(value), issue: (value) => f.repository.storeIssuedReceipt(value, 200, 'c'), transaction: (fn) => f.repository.transaction(fn), table: 'service_idempotency' },
    staff: { reserve: () => f.processing.reserveAdminIdempotency({ sessionId: session, key: 'one-pending-row', method: 'POST', path: '/p', requestHash: 'h' }).reservation,
      complete: (value) => f.processing.completeAdminIdempotency(value, 200, {}), release: (value) => f.processing.releaseAdminIdempotency(value), issue: (value) => f.processing.storeIssuedAdminReceipt(value, 200, {}), transaction: (fn) => f.processing.transaction(fn), table: 'admin_idempotency' },
  };
  for (const [name, store] of Object.entries(stores)) {
    const value = store.reserve();
    for (const field of Object.keys(value)) {
      const other = { ...value, [field]: typeof value[field] === 'string' ? `${value[field]}x` : Number(value[field]) + 1 };
      assert.equal(store.complete(other), false, `${name} ${field}`);
      assert.equal(store.release(other), false, `${name} ${field}`);
      assert.throws(() => store.transaction(() => store.issue(other)), { code: 'idempotency_reservation_lost' }, `${name} ${field}`);
    }
    assert.throws(() => store.issue(value), /in the transaction/, name);
    assert.equal(store.complete(value), true, name);
    assert.equal(store.complete(value), false, `${name}: once`);
    assert.equal(store.release(value), false, `${name}: a receipt is not released`);
    assert.equal(held(f, store.table, 'one-pending-row').response_status, 200, name);
  }
  // A refusal whose reservation was replaced meanwhile: answered, and the other reservation stays pending.
  const getModel = f.repository.getModel, key = 'refused-without-one';
  let done = false;
  f.repository.getModel = function lose(...args) {
    const row = done ? null : f.database.prepare('SELECT rowid AS row_id,* FROM service_idempotency WHERE idempotency_key=?').get(key);
    if (row) { done = true; supersede(f, 'service_idempotency', row); }
    return getModel.apply(this, args);
  };
  const refused = await f.service(`/api/v1/models/${f.published.modelId}/sessions`, { modelVersionId: f.published.versionId, subject: '', audience: 'client', permissions: { view: true }, authorizationExpiresAt: f.until }, key);
  f.repository.getModel = getModel;
  assert.deepEqual([done, refused.status], [true, 400]);
  assert.equal(held(f, 'service_idempotency', key).response_status, null);
});

test('a source revocation is not recorded without its receipt', async (t) => {
  const f = await fixture(t), source = { type: 'direct_client_grant', id: 'grant-one', version: 1 };
  for (const lost of ['pruned', 'superseded']) {
    const key = `source-revocation-${lost}`, before = f.count('revoked_published_session_authorizations');
    const hook = loseReservation(f, 'service_idempotency', key, (row) => (lost === 'pruned' ? prune : supersede)(f, 'service_idempotency', row));
    const response = await f.revoke(key, source);
    hook.done();
    assert.ok(hook.row(), lost);
    assert.equal(response.status, 500, lost);
    assert.equal(f.count('revoked_published_session_authorizations'), before, lost);
  }
  assert.equal((await f.revoke('source-revocation-kept', source)).status, 200);
  assert.equal((await f.revoke('source-revocation-kept', source)).headers.get('idempotency-replayed'), 'true');
});

test('a staff session is not issued where its receipt would be on another connection', async (t) => {
  const f = await fixture(t), database = openDatabase(path.join(f.root, 'viewer.sqlite')), app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProcessingApi({ repository: f.repository, processing: new ProcessingRepository(database), storage: {} }));
  app.use((error, _req, res, _next) => res.status(500).json({ code: 'internal' }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/processing/outputs/${f.published.versionId}/view-sessions`, { method: 'POST', body: '{}', headers: { authorization: `Bearer ${f.token}`, 'content-type': 'application/json', 'idempotency-key': 'other-connection' } });
  await new Promise((resolve) => server.close(resolve));
  database.close();
  assert.equal(response.status, 500);
  assert.equal(f.count('session_grants'), 0);
});

test('a grant whose renewal fails is not spent; one that can no longer open its target is', async (t) => {
  const f = await fixture(t), issue = async (key) => (await (await f.routes['service session'].call(key)).json()).grant;
  const redeem = (grant, accessToken) => fetch(`${f.base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) }, body: JSON.stringify({ grant }) });
  const spent = (grant) => Boolean(f.database.prepare('SELECT redeemed_at FROM session_grants WHERE id=?').get(grant).redeemed_at);
  const first = await (await redeem(await issue('renewal-first-key'))).json();
  // The presented session ends between reading it and renewing it.
  const renewal = await issue('renewal-second-key'), renew = f.repository.renewViewerSession;
  let ended = 0;
  f.repository.renewViewerSession = function gone(id, ...rest) { ended += 1; f.repository.revokeViewerSession(id); return renew.call(this, id, ...rest); };
  const failed = await redeem(renewal, first.accessToken);
  f.repository.renewViewerSession = renew;
  assert.deepEqual([failed.status, ended, spent(renewal)], [410, 1, false]);
  assert.equal(failed.headers.get('set-cookie'), null);
  assert.equal((await redeem(renewal)).status, 200, 'it opens a session of its own');
  assert.equal((await redeem(renewal)).status, 410, 'once');
  // Terminal: that version is no longer the published one, or the authorization has ended.
  const stale = await issue('terminal-target-key');
  f.database.prepare('UPDATE models SET active_version_id=NULL WHERE id=?').run(f.published.modelId);
  assert.deepEqual([(await redeem(stale)).status, spent(stale)], [404, true]);
  f.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(f.published.versionId, f.published.modelId);
  assert.equal((await redeem(stale)).status, 410, 'a denied grant does not open it later');
  const over = f.repository.createSessionGrant({ modelId: f.published.modelId, modelVersionId: f.published.versionId, subject: 'client:one', audience: 'client', permissions: { view: true, __authorizedUntil: '2020-01-01T00:00:00.000Z' }, expiresAt: f.until });
  assert.deepEqual([(await redeem(over.id)).status, spent(over.id)], [410, true]);
});

test('clearing a stale staff reservation never removes the fresh one another process has put in its place', async (t) => {
  const f = await fixture(t), other = openDatabase(path.join(f.root, 'viewer.sqlite')), elsewhere = new ProcessingRepository(other), session = f.database.prepare('SELECT id FROM admin_sessions').get().id;
  const stale = {
    'left pending': (id) => f.database.prepare('UPDATE admin_idempotency SET created_at=? WHERE rowid=?').run(new Date(Date.now() - 16 * 60_000).toISOString(), id),
    expired: (id) => f.database.prepare("UPDATE admin_idempotency SET created_at='2020-01-01T00:00:00.000Z',expires_at='2020-01-02T00:00:00.000Z' WHERE rowid=?").run(id),
  };
  for (const [why, makeStale] of Object.entries(stale)) {
    for (const replaced of [true, false]) {
      const key = `stale-${why.replace(' ', '-')}-${replaced}`, request = { sessionId: session, key, method: 'POST', path: '/p', requestHash: 'h' };
      const first = f.processing.reserveAdminIdempotency(request).reservation;
      makeStale(first.rowId);
      // Between this process reading the stale row and clearing it, the other one clears it and reserves the key.
      const prepare = f.database.prepare;
      let fresh = null;
      f.database.prepare = function staged(sql, ...rest) {
        if (replaced && !fresh && /^DELETE FROM admin_idempotency/.test(sql)) fresh = elsewhere.reserveAdminIdempotency(request).reservation;
        return prepare.call(this, sql, ...rest);
      };
      const second = f.processing.reserveAdminIdempotency(request);
      f.database.prepare = prepare;
      if (!replaced) { assert.equal(second.created, true, `${key}: a stale reservation is still taken over`); continue; }
      assert.ok(fresh, `${key}: the case under test`);
      assert.equal(second.created, false, key);
      assert.equal(second.record.created_at, fresh.createdAt, key);
      assert.equal(f.database.prepare('SELECT COUNT(*) n FROM admin_idempotency WHERE idempotency_key=?').get(key).n, 1, key);
      // Its owner still holds it and can store its receipt.
      assert.equal(elsewhere.completeAdminIdempotency(fresh, 200, {}), true, key);
    }
  }
  other.close();
});
