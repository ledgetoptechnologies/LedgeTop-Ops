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
  return { database, repository, base, routes, count, published, until, service };
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
