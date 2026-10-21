'use strict';

const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');

test('admin grant renewal reuses the same bearer and session and exposes only the exact Ops control origin', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-workspace-renewal-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const app = express();
  app.use(express.json());
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve));database.close();fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const issue = (suffix) => processing.createAdminGrant({
    subject: 'ops:workspace-user',
    permissions: ['viewer.projects.read'],
    displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    authorizationExpiresAt: new Date(Date.now() + 60 * 60_000 + suffix).toISOString(),
  });
  const redeem = (grant, token) => fetch(`${base}/api/v1/admin-sessions/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ grant: grant.token }),
  });

  const firstResponse = await redeem(issue(0));
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  assert.equal(new URL(first.controllerOrigin).origin, first.controllerOrigin);

  const renewedResponse = await redeem(issue(60_000), first.accessToken);
  assert.equal(renewedResponse.status, 200);
  const renewed = await renewedResponse.json();
  assert.equal(renewed.accessToken, first.accessToken);
  assert.equal(renewed.session.id, first.session.id);
  assert.equal(renewed.controllerOrigin, first.controllerOrigin);

  database.prepare('UPDATE admin_sessions SET expires_at=? WHERE id=?').run(
    new Date(Date.now() - 60_000).toISOString(), first.session.id,
  );
  assert.equal((await fetch(`${base}/api/v1/admin-sessions/current`, { headers: { authorization: `Bearer ${first.accessToken}` } })).status, 401);
  const revivedResponse = await redeem(issue(90_000), first.accessToken);
  assert.equal(revivedResponse.status, 200);
  const revived = await revivedResponse.json();
  assert.equal(revived.accessToken, first.accessToken);
  assert.equal(revived.session.id, first.session.id);

  const currentResponse = await fetch(`${base}/api/v1/admin-sessions/current`, { headers: { authorization: `Bearer ${first.accessToken}` } });
  assert.equal(currentResponse.status, 200);
  const current = await currentResponse.json();
  assert.equal(current.accessToken, undefined);
  assert.equal(current.session.id, first.session.id);
  assert.equal(current.controllerOrigin, first.controllerOrigin);
  assert.equal((await fetch(`${base}/api/v1/admin-sessions/current`)).status, 401);

  const recoverable = issue(120_000);
  const staleBearer = await redeem(recoverable, 'stale-workspace-token-000000000000000');
  assert.equal(staleBearer.status, 401);
  assert.equal((await redeem(recoverable)).status, 200, 'authoritative bearer rejection does not consume the one-time grant');
});
