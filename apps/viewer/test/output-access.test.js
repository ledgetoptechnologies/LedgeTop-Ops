'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const { createApiV1 } = require('../server/apiV1');
const { openDatabase } = require('../server/database');
const { createProcessingApi } = require('../server/processingApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('admin output URLs expose only exact derived files and issue a published viewing grant', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-output-access-'));
  const config = {
    datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash'),
    storageReserveBytes: 0, storageReservePercent: 0,
  };
  for (const directory of Object.values(config).filter((value) => typeof value === 'string')) fs.mkdirSync(directory, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const processing = new ProcessingRepository(database);
  const storage = new StorageManager(config);
  const adminToken = 'output-admin-token-000000000000000000000';
  const viewerToken = 'output-viewer-token-0000000000000000000';
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: 'ops:reader', permissions: ['viewer.processing.read', 'viewer.shares.read', 'viewer.shares.create'], displayUnits: 'imperial', expiresAt });

  const project = processing.createProject({ displayName: 'Output project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Output dataset', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = sha256(Buffer.alloc(0));
  processing.finalizeDataset(dataset.id, [{ relativePath: 'photo.jpg', byteSize: 0, sha256: empty }], empty);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Output task' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:reader' });
  const relativeRoot = `${task.id}/${attempt.id}`;
  const files = {
    dsm: { relativePath: `${relativeRoot}/dsm.tif`, body: Buffer.from('derived-dsm') },
    glb: { relativePath: `${relativeRoot}/model.glb`, body: Buffer.from('derived-mesh') },
    ortho: { relativePath: `${relativeRoot}/orthophoto.tif`, body: Buffer.from('AAAABBBBCCCC') },
    report: { relativePath: `${relativeRoot}/odm_report/report.pdf`, body: Buffer.from('%PDF-safe-report') },
    pointCloud: { relativePath: `${relativeRoot}/raw.laz`, body: Buffer.from('private-point-cloud') },
    obj: { relativePath: `${relativeRoot}/source.obj`, body: Buffer.from('private-source-mesh') },
  };
  for (const file of Object.values(files)) {
    const absolute = path.join(config.modelsMount, ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, file.body);
  }
  const model = repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id,
    displayName: task.displayName, status: 'ready', sourceLocator: { taskId: task.id, attemptId: attempt.id },
    assets: [
      { kind: 'dsm', rootKey: 'models', relativePath: files.dsm.relativePath, format: 'tif', contentType: 'image/tiff', byteSize: files.dsm.body.length, sha256: sha256(files.dsm.body), published: false },
      { kind: 'glb', rootKey: 'models', relativePath: files.glb.relativePath, format: 'glb', byteSize: files.glb.body.length, sha256: sha256(files.glb.body), published: true },
      { kind: 'ortho', rootKey: 'models', relativePath: files.ortho.relativePath, format: 'tif', contentType: 'image/tiff', byteSize: files.ortho.body.length, sha256: sha256(files.ortho.body), chunks: [0, 4, 8].map((byteOffset, chunkIndex) => { const body = files.ortho.body.subarray(byteOffset, byteOffset + 4); return { chunkIndex, byteOffset, byteSize: body.length, sha256: sha256(body) }; }), published: false },
      { kind: 'report', rootKey: 'models', relativePath: files.report.relativePath, format: 'pdf', contentType: 'application/pdf', byteSize: files.report.body.length, sha256: sha256(files.report.body), published: false },
      { kind: 'pointCloud', rootKey: 'models', relativePath: files.pointCloud.relativePath, format: 'laz', byteSize: files.pointCloud.body.length, sha256: sha256(files.pointCloud.body), published: false },
      { kind: 'obj', rootKey: 'models', relativePath: files.obj.relativePath, format: 'obj', byteSize: files.obj.body.length, sha256: sha256(files.obj.body), published: false },
    ],
    makeActive: true,
  });
  const versionId = model.activeVersion.id;
  processing.setAttemptResult(attempt.id, model.id, versionId);
  processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: project.id, relativePath: relativeRoot, byteSize: Object.values(files).reduce((sum, file) => sum + file.body.length, 0), assetCount: 4 });
  database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(versionId);
  repository.createViewerSession({ tokenHash: auth.hashToken(viewerToken), modelId: model.id, modelVersionId: versionId, subject: 'client:one', audience: 'client', permissions: { view: true }, expiresAt });

  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createProcessingApi({ repository, processing, storage }));
  app.use(createApiV1(repository));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Bearer ${adminToken}` };

  const listedResponse = await fetch(`${base}/api/v1/processing/outputs`, { headers });
  assert.equal(listedResponse.status, 200);
  const output = (await listedResponse.json()).outputs[0];
  assert.deepEqual(output.assetKinds, ['dsm', 'glb', 'ortho', 'report']);
  assert.deepEqual(output.assets.map((asset) => asset.kind), ['dsm', 'glb', 'ortho', 'report']);
  assert.equal(output.assets.some((asset) => 'relativePath' in asset || 'rootKey' in asset), false);
  assert.equal(output.downloadUrl, `/api/v1/processing/outputs/${versionId}/assets/glb`, 'the authenticated original mesh remains the primary Operations download even when alphabetically earlier map assets exist');
  assert.equal(output.reportUrl, `/api/v1/processing/outputs/${versionId}/assets/report`);
  assert.equal(output.viewSessionUrl, `/api/v1/processing/outputs/${versionId}/view-sessions`);

  assert.equal((await fetch(`${base}${output.reportUrl}`)).status, 401);
  assert.equal((await fetch(`${base}${output.reportUrl}`, { headers: { authorization: `Bearer ${viewerToken}` } })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/processing/outputs/${versionId}/assets/pointCloud`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/processing/outputs/${versionId}/assets/obj`, { headers })).status, 404);
  const report = await fetch(`${base}${output.reportUrl}`, { headers });
  assert.equal(report.status, 200);
  assert.equal(report.headers.get('content-type'), 'application/pdf');
  assert.equal(report.headers.get('cache-control'), 'no-store');
  assert.match(report.headers.get('content-disposition'), /attachment; filename="report\.pdf"/);
  assert.equal(await report.text(), files.report.body.toString());
  const glb = await fetch(`${base}${output.downloadUrl}`, { headers });
  assert.equal(glb.status, 200);
  assert.equal(await glb.text(), files.glb.body.toString());

  const orthoUrl = `/api/v1/processing/outputs/${versionId}/assets/ortho`;
  let ortho = await fetch(`${base}${orthoUrl}`, { headers: { ...headers, range: 'bytes=0-3' } });
  assert.equal(ortho.status, 206);
  assert.equal(ortho.headers.get('content-range'), `bytes 0-3/${files.ortho.body.length}`);
  assert.equal(await ortho.text(), 'AAAA');
  fs.writeFileSync(path.join(config.modelsMount, ...files.ortho.relativePath.split('/')), Buffer.from('AAAAXBBBCCCC'));
  ortho = await fetch(`${base}${orthoUrl}`, { headers: { ...headers, range: 'bytes=0-3' } });
  assert.equal(ortho.status, 206, 'a changed non-requested chunk does not force a whole-file read');
  assert.equal(await ortho.text(), 'AAAA');
  assert.equal((await fetch(`${base}${orthoUrl}`, { headers: { ...headers, range: 'bytes=4-7' } })).status, 409, 'tampering inside the requested chunk fails closed');

  const viewResponse = await fetch(`${base}${output.viewSessionUrl}`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'published-output-view-0001' }, body: '{}',
  });
  assert.equal(viewResponse.status, 201);
  const issued = await viewResponse.json();
  assert.equal(issued.sessionMode, 'published');
  assert.deepEqual(issued.assetKinds, ['glb']);
  const redeemed = await fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant: issued.grant }) });
  assert.equal(redeemed.status, 200);
  const session = await redeemed.json();
  assert.ok(session.model.assets.glb);
  assert.equal(session.model.assets.pointCloud, null);
  assert.equal(JSON.stringify(session).includes('report.pdf'), false);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM public_shares").get().count, 0);

  repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: crypto.randomUUID(),
    displayName: task.displayName, status: 'ready', sourceLocator: { taskId: task.id },
    assets: [{ kind: 'glb', rootKey: 'models', relativePath: files.glb.relativePath, format: 'glb', byteSize: files.glb.body.length, sha256: sha256(files.glb.body), published: true }],
    makeActive: true,
  });
  const historicalList = await fetch(`${base}/api/v1/processing/outputs`, { headers });
  assert.equal(historicalList.status, 200);
  const historicalOutput = (await historicalList.json()).outputs.find((item) => item.id === versionId);
  assert.equal(historicalOutput.activePublished, false);
  assert.equal(historicalOutput.viewSessionUrl, null);
  assert.equal((await fetch(`${base}/api/v1/processing/outputs/${versionId}/shares`, { headers })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/processing/outputs/${versionId}/shares`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'historical-output-share-0001' },
    body: JSON.stringify({ permissions: { view: true, measure: true, cameras: true, download: false } }),
  })).status, 404);
  assert.equal(database.prepare("SELECT COUNT(*) count FROM public_shares").get().count, 0);

  const changed = Buffer.from('X'.repeat(files.report.body.length));
  fs.writeFileSync(path.join(config.modelsMount, ...files.report.relativePath.split('/')), changed);
  assert.equal((await fetch(`${base}${output.reportUrl}`, { headers })).status, 409);
});
