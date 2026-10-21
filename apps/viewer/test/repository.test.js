'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-viewer-test-'));
  const database = openDatabase(path.join(directory, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  t.after(() => {
    database.close();
    const resolved = path.resolve(directory);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return repository;
}

function modelInput(overrides = {}) {
  return {
    provider: 'webodm',
    providerModelId: 'project-17',
    providerVersionId: 'task-41',
    displayName: 'Courthouse survey',
    sourceLocator: { projectId: 17, taskId: 41 },
    georef: { rtc: { e: 1, n: 2, z: 3 } },
    pointCount: 1234,
    assets: [
      { kind: 'glb', rootKey: 'webodm', relativePath: 'textured_model.glb', format: 'glb' },
      { kind: 'ortho', rootKey: 'webodm', relativePath: 'orthophoto.tif', format: 'tiff' },
    ],
    aliasId: 'webodm-17-41',
    ...overrides,
  };
}

test('migrations are idempotent and create a versioned canonical model', (t) => {
  const repository = fixture(t);
  const created = repository.upsertModelVersion(modelInput());
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.equal(created.activeVersion.providerVersionId, 'task-41');
  assert.deepEqual(created.activeVersion.assets.map((asset) => asset.kind), ['glb', 'ortho']);
  assert.equal(repository.getModel('webodm-17-41').id, created.id);

  const updated = repository.upsertModelVersion(modelInput({
    displayName: 'Courthouse survey – final',
    assets: [{ kind: 'glb', rootKey: 'webodm', relativePath: 'final.glb' }],
  }));
  assert.equal(updated.id, created.id);
  assert.equal(updated.displayName, 'Courthouse survey – final');
  assert.equal(updated.activeVersion.assets.length, 1);
});

test('new provider versions do not change canonical model identity', (t) => {
  const repository = fixture(t);
  const first = repository.upsertModelVersion(modelInput());
  const second = repository.upsertModelVersion(modelInput({
    providerVersionId: 'task-42',
    sourceLocator: { projectId: 17, taskId: 42 },
    aliasId: 'webodm-17-42',
  }));
  assert.equal(second.id, first.id);
  assert.notEqual(second.activeVersion.id, first.activeVersion.id);
  assert.equal(repository.getModel('webodm-17-41').id, first.id);
  assert.equal(repository.getModel('webodm-17-42').id, first.id);
});

test('public shares are revocable and never require storing the raw identifier', (t) => {
  const repository = fixture(t);
  const model = repository.upsertModelVersion(modelInput());
  const share = repository.createPublicShare({
    modelId: model.id,
    publicIdHash: 'hash-only',
    permissions: { measure: true, cameras: false },
    createdBy: 'staff-1',
  });
  assert.equal(repository.getPublicShareByHash('hash-only').id, share.id);
  assert.equal(repository.publicShareLive(share), true);
  const revoked = repository.revokePublicShare(share.id, { actorId: 'staff-1', reason: 'client request' });
  assert.equal(repository.publicShareLive(revoked), false);
  assert.equal(revoked.revokeReason, 'client request');
});

test('session grants can be redeemed exactly once', (t) => {
  const repository = fixture(t);
  const model = repository.upsertModelVersion(modelInput());
  const grant = repository.createSessionGrant({
    modelId: model.id,
    subject: 'staff-1',
    audience: 'ops',
    permissions: { view: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(repository.redeemSessionGrant(grant.id).subject, 'staff-1');
  assert.equal(repository.redeemSessionGrant(grant.id), null);
});

test('browser viewer sessions store only token hashes and renew in place', (t) => {
  const repository = fixture(t);
  const model = repository.upsertModelVersion(modelInput());
  const session = repository.createViewerSession({
    tokenHash: 'sha256-only',
    modelId: model.id,
    modelVersionId: model.activeVersionId,
    subject: 'client-7',
    audience: 'client',
    permissions: { view: true },
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
  });
  assert.equal(session.tokenHash, 'sha256-only');
  assert.equal(repository.viewerSessionLive(session), true);
  const renewed = repository.renewViewerSession(session.id, {
    permissions: { view: true, measure: false },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(renewed.id, session.id);
  assert.equal(renewed.permissions.measure, false);
  repository.revokeViewerSession(session.id);
  assert.equal(repository.viewerSessionLive(repository.getViewerSessionByHash('sha256-only')), false);
});

test('expired grants and browser sessions are pruned', (t) => {
  const repository = fixture(t);
  const model = repository.upsertModelVersion(modelInput());
  const grant = repository.createSessionGrant({
    modelId: model.id, subject: 'old-user', audience: 'ops', permissions: { view: true },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  repository.createViewerSession({
    tokenHash: 'expired-session-hash', modelId: model.id, modelVersionId: model.activeVersionId,
    subject: 'old-user', audience: 'ops', permissions: { view: true },
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });
  const result = repository.pruneAuthState();
  assert.equal(result.grants, 1);
  assert.equal(result.sessions, 1);
  assert.equal(repository.redeemSessionGrant(grant.id), null);
  assert.equal(repository.getViewerSessionByHash('expired-session-hash'), null);
});

test('service nonces reject replay and accept distinct keys', (t) => {
  const repository = fixture(t);
  const cutoff = new Date(Date.now() - 10_000).toISOString();
  assert.equal(repository.consumeServiceNonce('ops-v1', 'nonce-1', cutoff), true);
  assert.equal(repository.consumeServiceNonce('ops-v1', 'nonce-1', cutoff), false);
  assert.equal(repository.consumeServiceNonce('client-v1', 'nonce-1', cutoff), true);
});

test('import jobs retain bounded failure diagnostics', (t) => {
  const repository = fixture(t);
  const job = repository.createImportJob({ provider: 'terra', identifier: 'export-7', request: { path: 'export-7' } });
  assert.equal(repository.claimPendingImport().id, job.id);
  const failed = repository.failImport(job.id, 'invalid_manifest', 'x'.repeat(2000));
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorMessage.length, 1000);
});

test('interrupted import jobs are requeued after restart', (t) => {
  const repository = fixture(t);
  const job = repository.createImportJob({ provider: 'webodm', identifier: 'webodm-1-2', request: {} });
  assert.equal(repository.claimPendingImport().status, 'importing');
  assert.equal(repository.requeueInterruptedImports(), 1);
  const resumed = repository.getImportJob(job.id);
  assert.equal(resumed.status, 'pending');
  assert.equal(resumed.errorCode, 'worker_restarted');
});
