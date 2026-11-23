'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { ProviderCredentials } = require('../server/providerCredentials');
const { createProcessingApi } = require('../server/processingApi');

const KEY = '7c'.repeat(32);

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-provider-removal-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const credentials = new ProviderCredentials({ processing, activeKeyId: 'provider-v1', keys: { 'provider-v1': KEY } });
  const session = (permissions) => {
    const token = crypto.randomBytes(32).toString('base64url');
    processing.createAdminSession({ tokenHash: auth.hashToken(token), subject: 'ops:admin', permissions, displayUnits: 'imperial', expiresAt: new Date(Date.now() + 60_000).toISOString() });
    return token;
  };
  const writer = session(['viewer.providers.read', 'viewer.providers.write', 'viewer.processing.read']);
  const reader = session(['viewer.providers.read', 'viewer.processing.read']);
  const app = express();
  app.use(express.json({ verify(req, _res, body) { req.rawBody = Buffer.from(body); } }));
  app.use(createProcessingApi({ repository, processing, storage: {}, providerCredentials: credentials }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, { method = 'GET', body, key, token = writer } = {}) => fetch(`${base}${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(key ? { 'idempotency-key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const provider = (displayName, { enabled = true } = {}) => {
    const id = crypto.randomUUID(), sealed = credentials.seal(id, `token-for-${displayName}`);
    return processing.upsertProvider({ id, type: 'nodeodm', displayName, endpoint: `https://${displayName.toLowerCase().replace(/\W+/g, '-')}.example.test`, enabled, credentialCiphertext: sealed.ciphertext, credentialKeyId: sealed.keyId, credentialUpdatedAt: new Date().toISOString(), lastHealth: 'healthy' });
  };
  const project = processing.createProject({ displayName: 'Removal project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Removal images', storageMode: 'managed', rootKey: 'datasets', relativePath: `removal-${crypto.randomUUID()}` });
  processing.finalizeDataset(dataset.id, [{ relativePath: 'img.jpg', byteSize: 1, sha256: 'a'.repeat(64) }], 'b'.repeat(64));
  const attemptOn = (providerId, status) => {
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: `Task ${crypto.randomUUID().slice(0, 8)}` });
    const attempt = processing.createAttempt({ taskId: task.id, providerId, options: {}, createdBy: 'ops:admin' });
    if (status !== 'pending') database.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(status, attempt.id);
    return { task, attempt };
  };
  return { database, processing, credentials, request, provider, attemptOn, reader };
}

const removeRoute = (id) => `/api/v1/processing/providers/${encodeURIComponent(id)}`;

test('removing a provider archives it, wipes its token, audits it and keeps old tasks named', async (t) => {
  const c = await fixture(t);
  const old = c.provider('Old Node'), current = c.provider('Current Node');
  const { task } = c.attemptOn(old.id, 'failed');

  const response = await c.request(removeRoute(old.id), { method: 'DELETE', body: {}, key: 'provider-remove-0001' });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.removed, true);
  assert.equal(body.provider.id, old.id);
  assert.equal(typeof body.provider.removedAt, 'string');
  assert.equal(body.provider.credential.configured, false);
  assert.doesNotMatch(JSON.stringify(body), /token-for|ciphertext/);

  const row = c.database.prepare('SELECT * FROM processing_providers WHERE id=?').get(old.id);
  assert.ok(row, 'the provider row is archived, not deleted');
  assert.equal(row.enabled, 0);
  assert.equal(row.credential_ciphertext, null);
  assert.equal(row.credential_cleared, 1);
  assert.equal(row.removed_by, 'ops:admin');
  assert.throws(() => c.credentials.resolve(old.id), { code: 'provider_credential_unavailable' });
  const audit = c.database.prepare("SELECT actor_id,details_json FROM audit_events WHERE action='provider.removed' AND entity_id=?").all(old.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_id, 'ops:admin');
  assert.equal(JSON.parse(audit[0].details_json).displayName, 'Old Node');

  const listed = await (await c.request('/api/v1/processing/providers')).json();
  assert.deepEqual(listed.providers.map((item) => item.id), [current.id]);
  assert.deepEqual(c.processing.listProviders().map((item) => item.id), [current.id]);

  const detail = await (await c.request(`/api/v1/tasks/${task.id}`)).json();
  assert.equal(detail.task.latestAttempt.providerId, old.id);
  assert.equal(detail.task.latestAttempt.providerDisplayName, 'Old Node');
  assert.equal(detail.task.latestAttempt.providerRemoved, true);
  const tasks = await (await c.request('/api/v1/tasks')).json();
  assert.equal(tasks.tasks.find((item) => item.id === task.id).latestAttempt.providerDisplayName, 'Old Node');

  const replay = await c.request(removeRoute(old.id), { method: 'DELETE', body: {}, key: 'provider-remove-0001' });
  assert.equal(replay.status, 200, 'the same idempotency key replays the removal');
  assert.equal((await c.request(removeRoute(old.id), { method: 'DELETE', body: {}, key: 'provider-remove-0002' })).status, 404);
  assert.equal((await c.request(removeRoute(old.id), { method: 'PATCH', body: { enabled: true }, key: 'provider-remove-0003' })).status, 404);
  assert.equal((await c.request(`${removeRoute(old.id)}/credential`, { method: 'PUT', body: { token: 'new-token' }, key: 'provider-remove-0004' })).status, 404);
  assert.equal((await c.request(`${removeRoute(old.id)}/capabilities`)).status, 404);
  assert.throws(() => c.attemptOn(old.id, 'pending'), { code: 'provider_unavailable' });
});

test('removal is refused while the provider has queued or running work', async (t) => {
  const c = await fixture(t);
  const busy = c.provider('Busy Node');
  c.provider('Spare Node');
  const { attempt } = c.attemptOn(busy.id, 'pending');

  const queued = await c.request(removeRoute(busy.id), { method: 'DELETE', body: {}, key: 'provider-busy-0001' });
  assert.equal(queued.status, 409);
  const queuedBody = await queued.json();
  assert.equal(queuedBody.code, 'provider_in_use');
  assert.match(queuedBody.error, /1 queued or running job\. Wait for it to finish or cancel it/);

  c.database.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(attempt.id);
  const running = await c.request(removeRoute(busy.id), { method: 'DELETE', body: {}, key: 'provider-busy-0002' });
  assert.equal(running.status, 409);
  assert.equal((await running.json()).code, 'provider_in_use');
  const row = c.database.prepare('SELECT removed_at,credential_ciphertext FROM processing_providers WHERE id=?').get(busy.id);
  assert.equal(row.removed_at, null);
  assert.notEqual(row.credential_ciphertext, null, 'a refused removal keeps the token');

  c.database.prepare("UPDATE processing_attempts SET status='cancelled' WHERE id=?").run(attempt.id);
  assert.equal((await c.request(removeRoute(busy.id), { method: 'DELETE', body: {}, key: 'provider-busy-0003' })).status, 200);
});

test('removal is refused for the only enabled provider until another is enabled or it is disabled', async (t) => {
  const c = await fixture(t);
  const only = c.provider('Only Node');
  c.provider('Disabled Node', { enabled: false });

  const refused = await c.request(removeRoute(only.id), { method: 'DELETE', body: {}, key: 'provider-only-0001' });
  assert.equal(refused.status, 409);
  const body = await refused.json();
  assert.equal(body.code, 'provider_last_enabled');
  assert.match(body.error, /only enabled node.*Enable another node first, or disable this one/);
  assert.equal(c.processing.getProvider(only.id).removedAt, null);

  c.database.prepare('UPDATE processing_providers SET enabled=0 WHERE id=?').run(only.id);
  assert.equal((await c.request(removeRoute(only.id), { method: 'DELETE', body: {}, key: 'provider-only-0002' })).status, 200);
});

test('removal returns not found for unknown providers and denies callers without write permission', async (t) => {
  const c = await fixture(t);
  const node = c.provider('Guarded Node');
  c.provider('Other Node');

  const missing = await c.request(removeRoute(crypto.randomUUID()), { method: 'DELETE', body: {}, key: 'provider-missing-0001' });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'provider_not_found');

  const denied = await c.request(removeRoute(node.id), { method: 'DELETE', body: {}, key: 'provider-denied-0001', token: c.reader });
  assert.equal(denied.status, 403);
  assert.equal(c.processing.getProvider(node.id).removedAt, null);

  const unkeyed = await c.request(removeRoute(node.id), { method: 'DELETE', body: {} });
  assert.equal(unkeyed.status, 428, 'removal requires the mutation idempotency guard');
});

test('health polling and acceptance delivery ignore removed providers', async (t) => {
  const c = await fixture(t);
  const old = c.provider('Polled Node');
  c.provider('Live Node');
  const { task, attempt } = c.attemptOn(old.id, 'published');
  assert.ok(c.processing.removeProvider(old.id, { actorId: 'ops:admin' }));

  // Even if a stale write re-enabled the archived row, no poller picks it up.
  c.database.prepare('UPDATE processing_providers SET enabled=1,runtime_health_at=NULL WHERE removed_at IS NOT NULL').run();
  const claimed = [];
  for (let i = 0; i < 3; i += 1) {
    const next = c.processing.claimProviderHealth(`owner-${i}`, { intervalMs: 0 });
    if (next) claimed.push(next.provider.id);
  }
  assert.ok(!claimed.includes(old.id));
  assert.equal(claimed.length, 1);

  const t0 = new Date(Date.now() - 1000).toISOString();
  c.database.prepare(`INSERT INTO viewer_acceptance_ack_outbox(event_id,attempt_id,task_id,provider_id,provider_endpoint,provider_task_id,payload_json,status,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,'{}','pending',?,?,?)`).run(`viewer-acceptance-${attempt.id}`, attempt.id, task.id, old.id, old.endpoint, attempt.providerTaskId, t0, t0, t0);
  assert.equal(c.processing.claimViewerAcceptanceAck('ack-owner'), null);
});
