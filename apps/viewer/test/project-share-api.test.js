'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProjectShareApi } = require('../server/projectShareApi');
const { ViewerRepository } = require('../server/repository');

function digest(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function assertRawTokenAbsentFromTables(database, token) {
  const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  for (const { name } of tables) {
    const quoted = `"${String(name).replaceAll('"', '""')}"`;
    for (const row of database.prepare(`SELECT * FROM ${quoted}`).all()) {
      for (const value of Object.values(row)) {
        if (typeof value === 'string') assert.equal(value.includes(token), false, `raw share token persisted in ${name}`);
      }
    }
  }
}

test('one project link dynamically exposes only active published derivatives and revokes live capabilities', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-project-share-'));
  const assetRoot = path.join(root, 'assets');
  fs.mkdirSync(assetRoot, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const adminToken = 'project-share-admin-token-0000000000000';
  const revokeOnlyToken = 'project-share-revoke-token-000000000000';
  const project = processing.createProject({ displayName: 'Shared project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  database.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?")
    .run('a'.repeat(64), new Date().toISOString(), dataset.id);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Published flight' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });

  function publish(providerVersionId, contents) {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:share' });
    const glbName = `${providerVersionId}.glb`;
    const reportName = `${providerVersionId}.pdf`;
    fs.writeFileSync(path.join(assetRoot, glbName), contents);
    fs.writeFileSync(path.join(assetRoot, reportName), '%PDF-private-report');
    const model = repository.upsertModelVersion({
      provider: 'webodm', providerModelId: task.id, providerVersionId, displayName: task.displayName,
      status: 'ready', sourceLocator: { legacyAssetRoots: { webodm: assetRoot } }, makeActive: true,
      assets: [
        { kind: 'glb', rootKey: 'webodm', relativePath: glbName, format: 'glb', byteSize: Buffer.byteLength(contents), sha256: digest(contents), published: true },
        { kind: 'report', rootKey: 'webodm', relativePath: reportName, format: 'pdf', contentType: 'application/pdf', byteSize: 19, sha256: digest('%PDF-private-report'), published: true },
      ],
    });
    const versionId = model.activeVersion.id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, rootKey: 'webodm', relativePath: providerVersionId, storageMode: 'external_reference', byteSize: Buffer.byteLength(contents), assetCount: 2 });
    const now = new Date().toISOString();
    database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now, now, attempt.id);
    database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id, model.id, now, task.id);
    database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now, versionId);
    return { attempt, model: repository.getModel(model.id), versionId, glbName, reportName };
  }

  const first = publish('version-one', 'first-public-mesh');
  processing.createAdminSession({
    tokenHash: auth.hashToken(adminToken), subject: 'ops:share',
    permissions: ['viewer.shares.read', 'viewer.shares.create', 'viewer.shares.revoke'],
    displayUnits: 'imperial', expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });
  processing.createAdminSession({
    tokenHash: auth.hashToken(revokeOnlyToken), subject: 'ops:revoke-only',
    permissions: ['viewer.shares.revoke'], displayUnits: 'imperial',
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  });

  assets.setRepository(repository);
  assets.setProcessingRepository(processing);
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
    next();
  });
  app.use(createProjectShareApi({ repository, processing }));
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  app.use(assets);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const adminHeaders = { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' };
  const revokeOnlyHeaders = { authorization: `Bearer ${revokeOnlyToken}`, 'content-type': 'application/json' };
  const createBody = JSON.stringify({ label: 'Client review', password: 'password123', permissions: { view: true, measure: true, cameras: false, download: false } });

  let response = await fetch(`${base}/api/v1/projects/${project.id}/public-shares`, { method: 'POST', headers: { ...adminHeaders, 'idempotency-key': 'project-share-audit-failure' }, body: createBody });
  assert.equal(response.status, 410);
  assert.equal((await response.json()).code,'project_public_sharing_disabled');
  assert.equal(database.prepare('SELECT COUNT(*) n FROM public_project_shares').get().n, 0);
  // Existing project links retain their behavior; only new creation is disabled.
  const publicToken=auth.newShareToken().token;
  const created={share:repository.createProjectShare({projectId:project.id,publicIdHash:auth.hashToken(publicToken),passwordHash:await auth.hashPassword('password123'),permissions:{view:true,measure:true,cameras:false,download:false},label:'Existing client review'})};
  const stored = database.prepare('SELECT public_id_hash,password_hash FROM public_project_shares WHERE id=?').get(created.share.id);
  assert.equal(stored.public_id_hash, auth.hashToken(publicToken));
  assert.equal(JSON.stringify(stored).includes(publicToken), false);
  response = await fetch(`${base}/api/v1/projects/${project.id}/public-shares`, { method: 'POST', headers: { ...adminHeaders, 'idempotency-key': 'project-share-create-0001' }, body: createBody });
  assert.equal(response.status, 410);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM public_project_shares').get().n, 1);
  assertRawTokenAbsentFromTables(database, publicToken);

  assert.equal((await fetch(`${base}/api/project-share/${publicToken}`)).status, 401);
  assert.equal((await fetch(`${base}/api/project-share/${publicToken}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong password' }) })).status, 401);
  const unlocked = await fetch(`${base}/api/project-share/${publicToken}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'password123' }) });
  assert.equal(unlocked.status, 200);
  const cookie = unlocked.headers.get('set-cookie').split(';')[0];
  const catalog = await unlocked.json();
  assert.deepEqual(catalog.tasks.map((item) => item.id), [task.id]);
  assert.equal(JSON.stringify(catalog).includes(first.reportName), false);

  response = await fetch(`${base}/api/project-share/${publicToken}/tasks/${task.id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const config = await response.json();
  assert.ok(config.assets.glb);
  assert.equal(config.assets.obj, null);
  assert.equal(config.assets.pointCloud, null);
  assert.equal(JSON.stringify(config).includes(first.reportName), false);
  const firstAssetUrl = config.assets.glb;
  assert.equal((await fetch(`${base}${firstAssetUrl}`)).status, 200);
  const capabilityPrefix = firstAssetUrl.slice(0, firstAssetUrl.indexOf(`/${first.model.id}/`));
  assert.equal((await fetch(`${base}${capabilityPrefix}/${first.model.id}/webodm/${first.reportName}`)).status, 404);

  const second = publish('version-two', 'second-public-mesh');
  assert.equal((await fetch(`${base}${firstAssetUrl}`)).status, 403, 'the former version capability fails after active publication changes');
  response = await fetch(`${base}/api/project-share/${publicToken}/tasks/${task.id}`, { headers: { cookie } });
  assert.equal(response.status, 200);
  const currentConfig = await response.json();
  assert.equal(currentConfig.activeVersion.id, second.versionId);
  assert.equal(await (await fetch(`${base}${currentConfig.assets.glb}`)).text(), 'second-public-mesh');

  response = await fetch(`${base}/api/v1/projects/${project.id}/public-shares`, { headers: adminHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).shares.map((item) => item.id), [created.share.id]);
  response = await fetch(`${base}/api/v1/projects/${project.id}/public-shares`, { headers: revokeOnlyHeaders });
  assert.equal(response.status, 200, 'revoke-only staff can list the metadata needed to select a link');
  assert.deepEqual((await response.json()).shares.map((item) => item.id), [created.share.id]);
  response = await fetch(`${base}/api/v1/project-shares/${created.share.id}`, { method: 'DELETE', headers: { ...revokeOnlyHeaders, 'idempotency-key': 'project-share-revoke-0001' }, body: '{}' });
  assert.equal(response.status, 200);
  assert.equal((await fetch(`${base}${currentConfig.assets.glb}`)).status, 403, 'revocation is checked for an already-issued asset capability');
  assert.equal((await fetch(`${base}/api/project-share/${publicToken}`, { headers: { cookie } })).status, 410);
  assert.equal(database.prepare('SELECT COUNT(*) n FROM public_shares').get().n, 0, 'model/client shares remain untouched');
});
