'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const SERVICE_SECRET = 'published-session-source-revocation-service-secret';
const SESSION_SECRET = 'published-session-test-cookie-secret-at-least-32';

function encryptReplay(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(SESSION_SECRET).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64url')).join('.');
}

async function unusedPort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  server.close();
  await once(server, 'close');
  return port;
}

function signedHeaders(method, requestPath, body = '') {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(24).toString('base64url');
  const digest = crypto.createHash('sha256').update(body).digest('hex');
  const canonical = ['ltds-viewer-service-v1', method, requestPath, timestamp, nonce, digest].join('\n');
  return {
    'X-LTDS-Key-Id': 'ops-v1',
    'X-LTDS-Timestamp': String(timestamp),
    'X-LTDS-Nonce': nonce,
    'X-LTDS-Content-SHA256': digest,
    'X-LTDS-Signature': crypto.createHmac('sha256', SERVICE_SECRET).update(canonical).digest('base64url'),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  };
}

async function signedFetch(base, requestPath, { method = 'GET', body = '', idempotencyKey } = {}) {
  return fetch(`${base}${requestPath}`, {
    method,
    headers: {
      ...signedHeaders(method, requestPath, body),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    ...(body ? { body } : {}),
  });
}

async function waitFor(base, child) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`viewer exited with ${child.exitCode}`);
    try {
      if ((await fetch(`${base}/api/v1/ready`)).ok) return;
    } catch { /* listener is not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('viewer did not become ready');
}

function model(repository, suffix) {
  return repository.upsertModelVersion({
    provider: 'terra',
    providerModelId: `source-${suffix}`,
    providerVersionId: `version-${suffix}`,
    displayName: `Model ${suffix}`,
    sourceLocator: { fixture: suffix },
    status: 'ready',
    assets: [],
  });
}

test('exact source revocation is atomic, scoped, replay-safe, and token-redacted', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-source-revocation-'));
  const dataDir = path.join(root, 'data');
  const distDir = path.join(root, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'index.html'), '<!doctype html>Viewer');
  fs.writeFileSync(path.join(distDir, 'admin-login.html'), '<!doctype html>Login');
  const databasePath = path.join(dataDir, 'viewer.sqlite');
  const seedDatabase = openDatabase(databasePath);
  const seedRepository = new ViewerRepository(seedDatabase);
  const firstModel = model(seedRepository, 'one');
  const secondModel = model(seedRepository, 'two');
  const legacyExpiry = new Date(Date.now() + 10 * 60_000).toISOString();
  const legacyGrant = seedRepository.createSessionGrant({
    modelId: firstModel.id, modelVersionId: firstModel.activeVersionId,
    subject: 'ops:legacy', audience: 'ops', permissions: { view: true }, expiresAt: legacyExpiry,
  });
  const legacyAccessToken = crypto.randomBytes(32).toString('base64url');
  seedRepository.createViewerSession({
    tokenHash: crypto.createHash('sha256').update(legacyAccessToken).digest('hex'),
    modelId: firstModel.id, modelVersionId: firstModel.activeVersionId,
    subject: 'ops:legacy', audience: 'ops', permissions: { view: true }, expiresAt: legacyExpiry,
  });
  seedDatabase.close();

  const port = await unusedPort();
  const output = [];
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(port),
      DATA_DIR: dataDir,
      DIST_DIR: distDir,
      WEBODM_ENABLED: 'false',
      SYNC_ON_STARTUP: 'false',
      ADMIN_PASSWORD: 'published-session-test-admin-password',
      SESSION_SECRET,
      SERVICE_AUTH_KEY_ID: 'ops-v1',
      SERVICE_AUTH_SECRET: SERVICE_SECRET,
      PUBLISHED_SESSION_SOURCE_REVOCATION_ENABLED: 'true',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => output.push(chunk));
  child.stderr.on('data', (chunk) => output.push(chunk));
  t.after(async () => {
    if (child.exitCode === null) {
      child.kill();
      await once(child, 'exit');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  await waitFor(base, child);

  assert.equal((await fetch(`${base}/api/v1/sessions/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: legacyGrant.id }),
  })).status, 410, 'enabling revocation fails closed for compatibility-window unbound grants');
  assert.equal((await fetch(`${base}/api/v1/sessions/current`, {
    headers: { Authorization: `Bearer ${legacyAccessToken}` },
  })).status, 401, 'enabling revocation fails closed for compatibility-window unbound sessions');
  const activationDatabase = openDatabase(databasePath);
  assert.deepEqual(JSON.parse(activationDatabase.prepare(`SELECT details_json FROM audit_events
    WHERE action='published_session.unbound_revoked'`).get().details_json), {
    revokedGrants: 1, revokedSessions: 1,
  });
  activationDatabase.close();

  const revokePath = '/api/v1/published-sessions/source-authorization';
  assert.equal((await fetch(`${base}${revokePath}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'source-revoke-unsigned-0001' },
    body: JSON.stringify({ sourceAuthorization: { type: 'model_association', id: 'unsigned', version: 1 } }),
  })).status, 401, 'revocation is service-HMAC only');
  const inexactBody = JSON.stringify({
    sourceAuthorization: { type: 'model_association', id: 'association-extra', version: 1 },
    modelId: firstModel.id,
  });
  assert.equal((await signedFetch(base, revokePath, {
    method: 'DELETE', body: inexactBody, idempotencyKey: 'source-revoke-inexact-0001',
  })).status, 400, 'revocation body is an exact DTO');

  let keySequence = 0;
  async function issue(targetModel, authorization, subject = 'ops:staff-one') {
    keySequence += 1;
    const body = JSON.stringify({
      modelVersionId: targetModel.activeVersionId,
      subject,
      audience: 'ops',
      authorizationExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      permissions: { view: true, measure: true },
      sourceAuthorization: authorization,
    });
    const response = await signedFetch(base, `/api/v1/models/${targetModel.id}/sessions`, {
      method: 'POST', body, idempotencyKey: `source-session-${String(keySequence).padStart(4, '0')}`,
    });
    assert.equal(response.status, 201);
    return response.json();
  }

  async function redeem(grant, accessToken = null) {
    const response = await fetch(`${base}/api/v1/sessions/redeem`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify({ grant: grant.grant }),
    });
    assert.equal(response.status, 200);
    return response.json();
  }

  const missingDescriptor = JSON.stringify({
    modelVersionId: firstModel.activeVersionId,
    subject: 'ops:staff-one',
    audience: 'ops',
    authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    permissions: { view: true },
  });
  assert.equal((await signedFetch(base, `/api/v1/models/${firstModel.id}/sessions`, {
    method: 'POST', body: missingDescriptor, idempotencyKey: 'source-session-missing-0001',
  })).status, 400, 'enabled mode requires an exact source descriptor');

  const target = { type: 'model_association', id: 'association-target', version: 7 };
  const pendingTarget = await issue(firstModel, target);
  const activeTarget = await redeem(await issue(firstModel, target));

  const otherAssociation = await redeem(await issue(firstModel,
    { type: 'model_association', id: 'association-other', version: 7 }));
  const otherVersion = await redeem(await issue(firstModel,
    { type: 'model_association', id: target.id, version: 8 }));
  const otherModel = await redeem(await issue(secondModel,
    { type: 'model_association', id: 'association-second-model', version: 1 }));
  const otherSubject = await redeem(await issue(firstModel,
    { type: 'model_association', id: 'association-other-subject', version: 1 }, 'ops:staff-two'));

  const sameDescriptorRenewal = await redeem(await issue(firstModel, target), activeTarget.accessToken);
  assert.equal(sameDescriptorRenewal.accessToken, activeTarget.accessToken,
    'an exact descriptor renewal preserves the browser session');
  const changedDescriptorRenewal = await redeem(await issue(firstModel,
    { type: 'model_association', id: 'association-changed', version: 1 }), otherAssociation.accessToken);
  assert.notEqual(changedDescriptorRenewal.accessToken, otherAssociation.accessToken,
    'a different descriptor cannot mutate an existing session authorization');

  const inspectDatabase = openDatabase(databasePath);
  const stored = inspectDatabase.prepare(`SELECT source_authorization_type,source_authorization_id,source_authorization_version
    FROM viewer_sessions WHERE token_hash=?`).get(crypto.createHash('sha256').update(activeTarget.accessToken).digest('hex'));
  assert.deepEqual({ ...stored }, {
    source_authorization_type: target.type,
    source_authorization_id: target.id,
    source_authorization_version: target.version,
  });
  assert.throws(() => inspectDatabase.prepare(
    'UPDATE viewer_sessions SET source_authorization_version=8 WHERE token_hash=?',
  ).run(crypto.createHash('sha256').update(activeTarget.accessToken).digest('hex')), /source_authorization_immutable/);
  inspectDatabase.close();

  const revokeBody = JSON.stringify({ sourceAuthorization: target });
  const revoke = await signedFetch(base, revokePath, {
    method: 'DELETE', body: revokeBody, idempotencyKey: 'source-revoke-target-0001',
  });
  assert.equal(revoke.status, 200);
  assert.equal(revoke.headers.get('cache-control'), 'no-store');
  const revoked = await revoke.json();
  assert.deepEqual(revoked, { sourceAuthorization: target, revokedGrants: 1, revokedSessions: 1 });
  const revokedText = JSON.stringify(revoked);
  assert.ok(!revokedText.includes(pendingTarget.grant));
  assert.ok(!revokedText.includes(activeTarget.accessToken));
  assert.equal((await fetch(`${base}/api/v1/sessions/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: pendingTarget.grant }),
  })).status, 410, 'unredeemed target grant is immediately unusable');
  assert.equal((await fetch(`${base}/api/v1/sessions/current`, {
    headers: { Authorization: `Bearer ${activeTarget.accessToken}` },
  })).status, 401, 'redeemed target session is immediately unusable');
  const tombstoneDatabase = openDatabase(databasePath);
  assert.deepEqual({ ...tombstoneDatabase.prepare(`SELECT source_authorization_id,source_authorization_version
    FROM revoked_published_session_authorizations WHERE source_authorization_id=?`).get(target.id) }, {
    source_authorization_id: target.id, source_authorization_version: target.version,
  });
  tombstoneDatabase.close();
  const reissueBody = JSON.stringify({
    modelVersionId: firstModel.activeVersionId,
    subject: 'ops:staff-one', audience: 'ops',
    authorizationExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    permissions: { view: true }, sourceAuthorization: target,
  });
  assert.equal((await signedFetch(base, `/api/v1/models/${firstModel.id}/sessions`, {
    method: 'POST', body: reissueBody, idempotencyKey: 'source-session-revoked-0001',
  })).status, 409, 'a revoked exact descriptor cannot mint another grant');
  const lateDatabase = openDatabase(databasePath);
  const lateSession = new ViewerRepository(lateDatabase).createViewerSession({
    tokenHash: 'late-session-hash', modelId: firstModel.id, modelVersionId: firstModel.activeVersionId,
    sourceAuthorization: target, subject: 'ops:staff-one', audience: 'ops', permissions: { view: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(lateSession, null, 'revocation tombstone closes the redeem-to-session creation race');
  lateDatabase.close();

  for (const session of [otherAssociation, otherVersion, otherModel, otherSubject, changedDescriptorRenewal]) {
    assert.equal((await fetch(`${base}/api/v1/sessions/current`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
    })).status, 200, 'unrelated published session remains live');
  }

  const replay = await signedFetch(base, revokePath, {
    method: 'DELETE', body: revokeBody, idempotencyKey: 'source-revoke-target-0001',
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await replay.json(), revoked);
  const conflictBody = JSON.stringify({
    sourceAuthorization: { type: 'model_association', id: 'association-other', version: 7 },
  });
  assert.equal((await signedFetch(base, revokePath, {
    method: 'DELETE', body: conflictBody, idempotencyKey: 'source-revoke-target-0001',
  })).status, 409);

  const rollbackDescriptor = { type: 'model_association', id: 'association-rollback', version: 1 };
  const rollbackPending = await issue(firstModel, rollbackDescriptor);
  const rollbackActive = await redeem(await issue(firstModel, rollbackDescriptor));
  const failureDatabase = openDatabase(databasePath);
  failureDatabase.exec(`CREATE TRIGGER reject_source_revocation_audit BEFORE INSERT ON audit_events
    WHEN NEW.action='published_session.source_authorization_revoked'
    BEGIN SELECT RAISE(ABORT,'injected source revocation audit failure'); END`);
  failureDatabase.close();
  const failed = await signedFetch(base, revokePath, {
    method: 'DELETE', body: JSON.stringify({ sourceAuthorization: rollbackDescriptor }),
    idempotencyKey: 'source-revoke-rollback-0001',
  });
  assert.equal(failed.status, 500);
  const recoveryDatabase = openDatabase(databasePath);
  recoveryDatabase.exec('DROP TRIGGER reject_source_revocation_audit');
  const audit = recoveryDatabase.prepare(`SELECT entity_id,details_json FROM audit_events
    WHERE action='published_session.source_authorization_revoked' AND entity_id=?`).get(target.id);
  assert.ok(audit);
  assert.deepEqual(JSON.parse(audit.details_json), {
    sourceAuthorizationType: 'model_association',
    sourceAuthorizationVersion: 7,
    revokedGrants: 1,
    revokedSessions: 1,
  });
  assert.ok(!audit.details_json.includes(pendingTarget.grant));
  assert.ok(!audit.details_json.includes(activeTarget.accessToken));
  recoveryDatabase.close();
  const recoveredPending = await fetch(`${base}/api/v1/sessions/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: rollbackPending.grant }),
  });
  assert.equal(recoveredPending.status, 200, 'audit failure rolls grant deletion back');
  assert.equal((await fetch(`${base}/api/v1/sessions/current`, {
    headers: { Authorization: `Bearer ${rollbackActive.accessToken}` },
  })).status, 200, 'audit failure rolls session revocation back');

  const lostResponseDescriptor = { type: 'model_association', id: 'association-lost-response', version: 4 };
  const lostResponsePending = await issue(firstModel, lostResponseDescriptor);
  const lostResponseActive = await redeem(await issue(firstModel, lostResponseDescriptor));
  const lostResponseBody = JSON.stringify({ sourceAuthorization: lostResponseDescriptor });
  const lostResponseKey = 'source-revoke-lost-response-0001';
  const lostResponseDatabase = openDatabase(databasePath);
  const lostResponseRepository = new ViewerRepository(lostResponseDatabase);
  const lostResponseRequestHash = crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from(`DELETE\n${revokePath}\n`), Buffer.from(lostResponseBody),
  ])).digest('hex');
  assert.equal(lostResponseRepository.reserveIdempotency({
    keyId: 'ops-v1', idempotencyKey: lostResponseKey, method: 'DELETE', path: revokePath,
    requestHash: lostResponseRequestHash, expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }).created, true);
  const committedWithoutResponse = lostResponseRepository.revokePublishedSessionsBySourceAuthorization({
    sourceAuthorization: lostResponseDescriptor,
    idempotency: { keyId: 'ops-v1', idempotencyKey: lostResponseKey, encrypt: encryptReplay },
    audit: {
      actorType: 'service', actorId: 'ops-v1', action: 'published_session.source_authorization_revoked',
      entityType: 'source_authorization',
    },
  });
  assert.deepEqual(committedWithoutResponse, {
    sourceAuthorization: lostResponseDescriptor, revokedGrants: 1, revokedSessions: 1,
  });
  lostResponseDatabase.close();

  const recoveredLostResponse = await signedFetch(base, revokePath, {
    method: 'DELETE', body: lostResponseBody, idempotencyKey: lostResponseKey,
  });
  assert.equal(recoveredLostResponse.status, 200,
    'a retry recovers the committed response after the mutation committed without an HTTP response');
  assert.equal(recoveredLostResponse.headers.get('idempotency-replayed'), 'true');
  assert.deepEqual(await recoveredLostResponse.json(), committedWithoutResponse);
  assert.equal((await fetch(`${base}/api/v1/sessions/redeem`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant: lostResponsePending.grant }),
  })).status, 410);
  assert.equal((await fetch(`${base}/api/v1/sessions/current`, {
    headers: { Authorization: `Bearer ${lostResponseActive.accessToken}` },
  })).status, 401);
  const lostResponseAuditDatabase = openDatabase(databasePath);
  assert.equal(lostResponseAuditDatabase.prepare(`SELECT COUNT(*) count FROM audit_events
    WHERE action='published_session.source_authorization_revoked' AND entity_id=?`
  ).get(lostResponseDescriptor.id).count, 1, 'lost-response replay does not duplicate the audit event');
  lostResponseAuditDatabase.close();

  const logs = Buffer.concat(output).toString('utf8');
  for (const secret of [pendingTarget.grant, activeTarget.accessToken, rollbackPending.grant,
    rollbackActive.accessToken, lostResponsePending.grant, lostResponseActive.accessToken])
    assert.ok(!logs.includes(secret), 'raw grant/session tokens are not logged');
});
