import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { readDirectShareForm } from '../workspace-direct-client-share.mjs';

const require = createRequire(import.meta.url);
const express = require('express');
const { createClientGrantProxy, REMOTE_PATH } = require('../server/clientGrantProxy');
const { canonicalViewerEvent } = require('../server/viewerEvents');
const PATH = '/api/v1/workspace/direct-client-grants';
const secret = 's'.repeat(32);
const sourceId = 'project-alpha:primary';
const workspaceId = 'client-workspace-1';
const viewerProjectId = 'viewer-project-1';
const taskId = 'published-task-1';
const idempotencyKey = 'direct-browser-transport-idempotency-0001';
const clients = [{ sourceId, workspaceId, displayName: 'Synthetic recipient', businessName: 'Ledge Top' }];
const tasks = [{ id: taskId, name: 'Published model' }];

function selectedTaskForm() {
  return {
    elements: {
      client: { value: JSON.stringify([sourceId, workspaceId]) },
      confirmedScope: { checked: true },
      expiresAt: { value: '2027-01-15T12:00' },
      measure: { checked: false }, cameras: { checked: false }, download: { checked: false },
    },
    querySelector: selector => selector === 'input[name="scope"]:checked' ? { value: 'tasks' } : null,
    querySelectorAll: selector => selector === 'input[name="taskId"]' ? [{ value: taskId, checked: true }] : [],
  };
}

test('Viewer task-share form body passes the direct HTTP proxy contract without a grant wrapper', async t => {
  const [body] = readDirectShareForm(selectedTaskForm(), {
    projectId: viewerProjectId, projectName: 'Synthetic project', tasks, clients,
  }).bodies();
  assert.ok(body);
  assert.ok(Number.isFinite(Date.parse(body.expiresAt)) && Date.parse(body.expiresAt) > Date.now());
  assert.match(body.expiresAt, /^2027-01-15T/);
  assert.deepEqual(body.permissions, { measure: false, cameras: false, download: false });
  assert.equal(body.scopeType, 'task');
  assert.equal(body.includeFuturePublished, false);

  const forwarded = [];
  const app = express();
  app.use(express.json());
  createClientGrantProxy({
    config: { opsAutomationBaseUrl: 'https://operations.example.test', viewerEventSecret: secret, viewerEventKeyId: 'viewer-v1' },
    authorize: () => (req, _res, next) => { req.adminPrincipal = { subject: 'ops:synthetic-staff' }; next(); },
    diagnostic() {},
    fetchImpl: async (url, request) => {
      assert.equal(url.href, 'https://operations.example.test/api/viewer/workspace/client-grants');
      assert.equal(request.method, 'POST');
      assert.equal(request.redirect, 'error');
      const requestHash = crypto.createHash('sha256').update(request.body).digest('hex');
      const canonical = canonicalViewerEvent({ method: 'POST', path: REMOTE_PATH,
        timestamp: request.headers['X-LTDS-Viewer-Timestamp'], nonce: request.headers['X-LTDS-Viewer-Nonce'], bodySha256: requestHash });
      assert.equal(request.headers['X-LTDS-Viewer-Signature'], crypto.createHmac('sha256', secret).update(canonical).digest('base64url'));
      const envelope = JSON.parse(request.body);
      forwarded.push(envelope);
      const { confirmedScope: _consent, ...scope } = envelope.grant;
      const grant = { ...scope, grantId: 'grant-task-1', grantVersion: 1, revokedAt: null,
        clientDisplayName: 'Synthetic recipient', createdAt: '2026-10-25T12:00:00.000Z', createdBy: 'ops:synthetic-staff' };
      return new Response(JSON.stringify({ grant, replayed: false }), { status: 201 });
    },
  }).mount(app);
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(() => new Promise(resolve => server.close(resolve)));

  // This is the body/key pair emitted by the Viewer form's POST call.
  const response = await fetch(`http://127.0.0.1:${server.address().port}${PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey, Authorization: 'Bearer synthetic-browser-session' },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 201);
  const { confirmedScope: _consent, ...scope } = body;
  assert.deepEqual(await response.json(), { grant: { ...scope, grantId: 'grant-task-1', grantVersion: 1, revokedAt: null,
    clientDisplayName: 'Synthetic recipient', createdAt: '2026-10-25T12:00:00.000Z', createdBy: 'ops:synthetic-staff' }, replayed: false });
  assert.deepEqual(forwarded, [{ subject: 'ops:synthetic-staff', action: 'create', connection: 'direct',
    idempotencyKey, grant: body }]);
});
