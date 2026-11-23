'use strict';

// A task in the Recycle Bin is not listed, opened or served by a whole-project
// link, nor listed for signed-in clients. Real routes and database; the task is
// deleted and restored through the staff routes.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const shareApi = require('../server/shareApi');
const { config } = require('../server/config');
const { createApiV1 } = require('../server/apiV1');
const { createClientDeliveryCatalog } = require('../server/clientDeliveryCatalog');
const { openDatabase } = require('../server/database');
const { createEphemeralMeasurementApi } = require('../server/ephemeralMeasurementApi');
const { EphemeralMeasurementRepository } = require('../server/ephemeralMeasurementRepository');
const { processOneEphemeralMeasurement } = require('../server/ephemeralMeasurementWorker');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { createProjectShareApi } = require('../server/projectShareApi');
const { signServiceRequest } = require('../server/serviceAuth');
const { ViewerRepository } = require('../server/repository');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const GLB = 'synthetic-public-mesh', PHOTO = 'synthetic-camera-photo', DSM = 'synthetic-dsm';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-project-share-bin-')), assetRoot = path.join(root, 'assets');
  fs.mkdirSync(assetRoot, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });

  function makeProject(displayName) {
    const project = processing.createProject({ displayName });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', storageMode: 'external_reference', rootKey: 'imports', relativePath: crypto.randomUUID() });
    processing.finalizeDataset(dataset.id, [], 'c'.repeat(64));
    // A second task on the same photos, so deleting one task does not also try
    // to delete the photos another task needs.
    processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Unpublished sibling' });
    return { project, dataset };
  }
  function attemptOutput(site, task, { storageMode = 'external_reference', active = true } = {}) {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const key = crypto.randomUUID(), file = (name, body) => { fs.writeFileSync(path.join(assetRoot, `${key}-${name}`), body); return { rootKey: 'webodm', relativePath: `${key}-${name}`, byteSize: Buffer.byteLength(body), sha256: digest(body), published: true }; };
    const photo = file('photo.jpg', PHOTO);
    const model = repository.upsertModelVersion({
      provider: 'webodm', providerModelId: task.id, providerVersionId: key, displayName: task.displayName, status: 'ready', makeActive: active,
      sourceLocator: { legacyAssetRoots: { webodm: assetRoot } },
      assets: [
        { kind: 'glb', format: 'glb', ...file('model.glb', GLB) },
        { kind: 'shots', format: 'json', ...file('shots.geojson', '{}') },
        { kind: 'dsm', format: 'tif', ...file('dsm.tif', DSM) },
      ],
      cameraPhotos: [{ filename: 'photo.jpg', rootKey: 'webodm', relativePath: photo.relativePath, contentType: 'image/jpeg', byteSize: photo.byteSize, sha256: photo.sha256 }],
    });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, key).id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: site.project.id,
      rootKey: storageMode === 'managed' ? 'models' : 'webodm', relativePath: versionId, storageMode, byteSize: 4, assetCount: 3 });
    const now = new Date().toISOString();
    if (!active) {
      database.prepare("UPDATE processing_attempts SET status='failed',completed_at=? WHERE id=?").run(now, attempt.id);
      database.prepare("UPDATE model_outputs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(versionId);
    } else {
      database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now, now, attempt.id);
      database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id, model.id, now, task.id);
      database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now, versionId);
    }
    return { attempt, modelId: model.id, versionId };
  }
  // incomplete: an older output of the task that cannot be moved to the bin, so
  // the delete stops after the task itself is in the bin (409) and before its
  // published output is taken down.
  function publishedTask(site, name, { incomplete = false } = {}) {
    const task = processing.createTask({ projectId: site.project.id, datasetId: site.dataset.id, displayName: name });
    const blocker = incomplete ? attemptOutput(site, task, { active: false }) : null;
    const output = attemptOutput(site, task);
    if (blocker) database.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(blocker.attempt.id);
    return { task, blocker, ...output };
  }
  function link(project, permissions = { view: true, measure: true, cameras: true, download: true }) {
    const { token, tokenHash } = auth.newShareToken();
    return { token, share: repository.createProjectShare({ projectId: project.id, publicIdHash: tokenHash, permissions }) };
  }

  const staffToken = 'project-share-bin-admin-token-0000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(staffToken), subject: 'ops:test', displayUnits: 'imperial',
    permissions: ['viewer.processing.read', 'viewer.processing.write', 'viewer.projects.write', 'viewer.storage.purge', 'viewer.shares.read', 'viewer.shares.revoke'], expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const previous = { serviceAuthKeyId: config.serviceAuthKeyId, serviceAuthSecret: config.serviceAuthSecret };
  const serviceKey = { id: 'project-share-bin', secret: 'p'.repeat(40) };
  Object.assign(config, { serviceAuthKeyId: serviceKey.id, serviceAuthSecret: serviceKey.secret });
  t.after(() => Object.assign(config, previous));

  assets.setRepository(repository);
  assets.setProcessingRepository(processing);
  shareApi.setRepository(repository);
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
    next();
  });
  app.use(shareApi);
  app.use(createProjectShareApi({ repository, processing }));
  app.use(createApiV1(repository));
  app.use(createClientDeliveryCatalog(repository));
  app.use('/temporary', createEphemeralMeasurementApi(repository, { preflightRaster: async () => {}, validator: { allows: async () => true } }));
  app.use(createProcessingApi({ repository, processing, storage: { pathExistsStrict: () => true } }));
  app.use(assets);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  const staff = (method, route, body = {}) => fetch(base + route, { method, body: JSON.stringify(body),
    headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json', 'idempotency-key': `project-share-bin-${sequence += 1}` } });
  const signed = (route, method = 'GET', body) => {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const headers = signServiceRequest({ keyId: serviceKey.id, secret: serviceKey.secret, method, path: route, body: raw });
    return fetch(base + route, { method, headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': `project-share-bin-${sequence += 1}` }, ...(raw ? { body: raw } : {}) });
  };
  const listed = async (token) => (await (await fetch(`${base}/api/project-share/${token}`)).json()).tasks.map((item) => item.id);
  const taskRoute = (token, taskId) => fetch(`${base}/api/project-share/${token}/tasks/${taskId}`);
  // Everything a page opened before the delete still holds.
  async function openPage(token, item) {
    const response = await taskRoute(token, item.task.id);
    assert.equal(response.status, 200);
    const page = await response.json(), capability = page.assets.glb.split('/')[2], encodedModel = encodeURIComponent(item.modelId);
    const products = await fetch(`${base}/session-products/${capability}/${encodedModel}`);
    assert.equal(products.status, 200);
    const grant = await fetch(`${base}/session-products/${capability}/${encodedModel}/glb/download-grants`, { method: 'POST' });
    assert.equal(grant.status, 201);
    return { item, token, glb: base + page.assets.glb, capability, photo: `${base}/session-camera-photos/${capability}/${encodedModel}/photo.jpg`,
      products: `${base}/session-products/${capability}/${encodedModel}`, download: base + (await grant.json()).url };
  }
  const measure = (page, method = 'GET', route = '/capabilities', body) => fetch(`${base}/temporary${route}`, { method, ...(body ? { body: JSON.stringify(body) } : {}),
    headers: { authorization: `Bearer ${decodeURIComponent(page.capability)}`, 'X-Measurement-Page': page.measurementPage ||= crypto.randomBytes(32).toString('base64url'), 'X-Measurement-Model-Version': page.item.versionId, 'content-type': 'application/json' } });
  async function served(page, note) {
    assert.ok((await listed(page.token)).includes(page.item.task.id), `${note} listed`);
    assert.equal((await taskRoute(page.token, page.item.task.id)).status, 200, `${note} task`);
    const glb = await fetch(page.glb);
    assert.equal(glb.status, 200, `${note} asset`);
    assert.equal(await glb.text(), GLB);
    const range = await fetch(page.glb, { headers: { range: 'bytes=4-7' } });
    assert.equal(range.status, 206, `${note} range`);
    assert.equal(await range.text(), GLB.slice(4, 8));
    assert.equal((await fetch(page.glb, { method: 'HEAD' })).status, 200, `${note} head`);
    const photo = await fetch(page.photo);
    assert.equal(photo.status, 200, `${note} photo`);
    assert.equal(await photo.text(), PHOTO);
    assert.equal((await fetch(page.products)).status, 200, `${note} products`);
    assert.equal((await fetch(page.download)).status, 200, `${note} download`);
    assert.equal((await measure(page)).status, 200, `${note} measure`);
  }
  async function refused(page, note) {
    assert.equal((await listed(page.token)).includes(page.item.task.id), false, `${note} listed`);
    const task = await taskRoute(page.token, page.item.task.id), body = await task.text();
    assert.equal(task.status, 404, `${note} task`);
    assert.equal(JSON.parse(body).code, 'published_task_not_found');
    for (const [name, url, options] of [['asset', page.glb], ['range', page.glb, { headers: { range: 'bytes=4-7' } }], ['head', page.glb, { method: 'HEAD' }],
      ['dsm', page.glb.replace('model.glb', 'dsm.tif')], ['photo', page.photo], ['products', page.products], ['download', page.download],
      ['new download', `${page.products}/glb/download-grants`, { method: 'POST' }]]) {
      const response = await fetch(url, options), text = await response.text();
      assert.equal(response.status, 403, `${note} ${name}`);
      assert.equal([GLB, PHOTO, DSM].some((bytes) => text.includes(bytes)), false, `${note} ${name}`);
    }
    assert.equal((await measure(page)).status, 403, `${note} measure`);
  }
  const bin = (item) => processing.activeTrashForEntity('task', item.task.id);
  return { database, repository, processing, base, makeProject, publishedTask, attemptOutput, link, staff, signed, listed, taskRoute, openPage, measure, served, refused, bin };
}

const deleteTask = (f, item) => f.staff('DELETE', `/api/v1/tasks/${item.task.id}`);
const restore = (f, item) => f.staff('POST', `/api/v1/storage/trash/${f.bin(item).id}/restore`);

test('a deleted task leaves the project link at once, and only that task', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project');
  const kept = f.publishedTask(site, 'Kept'), item = f.publishedTask(site, 'Deleted'), { token } = f.link(site.project);
  const page = await f.openPage(token, item), keptPage = await f.openPage(token, kept);
  await f.served(page, 'before');
  const response = await deleteTask(f, item);
  assert.equal(response.status, 200, await response.text());
  assert.ok(f.bin(item));
  await f.refused(page, 'deleted');
  await f.served(keptPage, 'other task');
});

test('a task in the Recycle Bin whose output is still published leaves the project link too', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Deleted', { incomplete: true }), { token } = f.link(site.project);
  const single = auth.newShareToken();
  f.repository.createPublicShare({ modelId: item.modelId, publicIdHash: single.tokenHash, permissions: { view: true } });
  assert.equal((await fetch(`${f.base}/api/share/${single.token}`)).status, 200);
  const page = await f.openPage(token, item);
  await f.served(page, 'before');
  // The delete stops at the older output, after the task is in the bin.
  assert.equal((await deleteTask(f, item)).status, 409);
  assert.ok(f.bin(item));
  assert.equal(f.processing.getModelOutput(item.versionId).status, 'published', 'the case under test');
  assert.equal((await fetch(`${f.base}/api/share/${single.token}`)).status, 410, 'single-model link');
  await f.refused(page, 'in the bin');

  // Restored: back on the link, and for the page that was already open, because
  // the link is live and the output is still published. A download refused in
  // between stays refused, and the single-model link stays revoked.
  assert.equal((await restore(f, item)).status, 200);
  await f.served(await f.openPage(token, item), 'restored');
  assert.equal(await (await fetch(page.glb)).text(), GLB);
  assert.equal((await fetch(page.download)).status, 403);
  assert.equal((await fetch(`${f.base}/api/share/${single.token}`)).status, 410);
});

test('restoring does not bring a task back to a link that is revoked or expired, or whose output is no longer published', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project');
  const item = f.publishedTask(site, 'Deleted', { incomplete: true }), gone = f.publishedTask(site, 'Unpublished while deleted', { incomplete: true });
  const revoked = f.link(site.project), expired = f.link(site.project), live = f.link(site.project);
  const pages = { revoked: await f.openPage(revoked.token, item), expired: await f.openPage(expired.token, item) };
  const livePage = await f.openPage(live.token, item), gonePage = await f.openPage(live.token, gone);
  for (const task of [item, gone]) assert.equal((await deleteTask(f, task)).status, 409);
  assert.equal((await f.staff('DELETE', `/api/v1/project-shares/${revoked.share.id}`)).status, 200);
  f.database.prepare('UPDATE public_project_shares SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expired.share.id);
  f.database.prepare('UPDATE processing_tasks SET published_model_id=NULL WHERE id=?').run(gone.task.id);
  for (const task of [item, gone]) assert.equal((await restore(f, task)).status, 200);
  for (const [note, page] of Object.entries(pages)) {
    assert.equal((await fetch(`${f.base}/api/project-share/${page.token}`)).status, 410, note);
    assert.equal((await f.taskRoute(page.token, item.task.id)).status, 410, note);
    for (const url of [page.glb, page.photo, page.products, page.download]) assert.equal((await fetch(url)).status, 403, note);
    assert.equal((await f.measure(page)).status, 403, note);
  }
  await f.served(livePage, 'live link');
  await f.refused(gonePage, 'no longer published');
});

test('an output restored on its own does not bring back a task that is still in the Recycle Bin', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Deleted'), { token } = f.link(site.project);
  const page = await f.openPage(token, item);
  assert.equal((await deleteTask(f, item)).status, 200);
  const output = f.processing.activeTrashForEntity('output', item.versionId);
  assert.equal((await f.staff('POST', `/api/v1/storage/trash/${output.id}/restore`)).status, 200);
  assert.equal(f.processing.getTask(item.task.id).status, 'archived');
  await f.refused(page, 'output restored');
  // Even if that output is then published again (the state publishing writes).
  f.database.prepare("UPDATE models SET status='ready',active_version_id=? WHERE id=?").run(item.versionId, item.modelId);
  f.database.prepare('UPDATE model_assets SET published=1 WHERE version_id=?').run(item.versionId);
  f.database.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(item.versionId);
  f.database.prepare("UPDATE processing_tasks SET status='published',published_model_id=? WHERE id=?").run(item.modelId, item.task.id);
  assert.ok(f.bin(item));
  await f.refused(page, 'published again in the bin');
});

test('the open trash item decides, whatever the task status says', async (t) => {
  // Deleting a task's active output sets the task back to draft, and an output
  // can be restored and published on its own while its task is in the bin.
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Deleted', { incomplete: true }), { token } = f.link(site.project);
  const page = await f.openPage(token, item);
  assert.equal((await deleteTask(f, item)).status, 409);
  for (const status of ['draft', 'ready_for_review', 'published']) {
    f.database.prepare('UPDATE processing_tasks SET status=?,archived_at=NULL WHERE id=?').run(status, item.task.id);
    await f.refused(page, status);
  }
  // The bin item of something else never hides a task.
  f.database.prepare("UPDATE storage_trash SET entity_type='dataset' WHERE id=?").run(f.bin(item).id);
  await f.served(await f.openPage(token, item), 'another kind of trash item');
});

test('archived, purged and not-ready tasks follow the same rule as the client catalog', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), { token } = f.link(site.project);
  const changes = {
    archived: (item) => f.staff('POST', `/api/v1/tasks/${item.task.id}/archive`).then((response) => assert.equal(response.status, 200)),
    purged: (item) => f.database.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(), item.task.id),
    'version not ready': (item) => f.database.prepare("UPDATE model_versions SET status='failed' WHERE id=?").run(item.versionId),
  };
  for (const [note, change] of Object.entries(changes)) {
    const item = f.publishedTask(site, note), page = await f.openPage(token, item);
    await f.served(page, note);
    await change(item);
    await f.refused(page, note);
    const catalog = await f.signed(`/api/v1/client-delivery-catalog?projectId=${site.project.id}&taskId=${item.task.id}`);
    assert.equal(catalog.status, 404, note);
  }
});

test('the project link is checked again before the first byte, as a single-model link is', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), { token } = f.link(site.project);
  const integrity = assets.assetIntegrityCache, original = { verifyWholeFile: integrity.verifyWholeFile, canBuffer: integrity.canBuffer };
  t.after(() => Object.assign(integrity, original));
  for (const kind of ['glb', 'photo']) {
    for (const buffered of [true, false]) {
      const item = f.publishedTask(site, `Slow ${kind} ${buffered}`, { incomplete: true }), page = await f.openPage(token, item);
      let deleted = null;
      integrity.clear();
      integrity.canBuffer = buffered ? original.canBuffer : () => false;
      integrity.verifyWholeFile = async function verify(...args) {
        const result = await original.verifyWholeFile.apply(this, args);
        deleted ||= deleteTask(f, item);
        await deleted;
        return result;
      };
      const response = await fetch(page[kind]), text = await response.text();
      integrity.verifyWholeFile = original.verifyWholeFile;
      if (!deleted) { assert.equal(buffered, true, 'only the buffered path may verify without this hook'); continue; }
      assert.equal((await deleted).status, 409);
      assert.equal(response.status, 403, `${kind} buffered ${buffered}`);
      assert.equal(text.includes(GLB) || text.includes(PHOTO), false);
    }
  }
});

test('a temporary measurement queued or finished before the delete gives nothing after it', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Measured', { incomplete: true }), { token } = f.link(site.project);
  const page = await f.openPage(token, item), dsm = f.repository.getModel(item.modelId).activeVersion.assets.find((asset) => asset.kind === 'dsm');
  const measurement = { id: crypto.randomUUID(), name: 'Pile', kind: 'polygon', collection: 'map', vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]], coordinateReference: { crs: 'EPSG:32616', verticalUnit: 'm' } };
  const request = { revision: 1, method: 'surface-cut-fill', sourceAssetId: dsm.id, reference: { type: 'custom', elevationM: 0 }, sourceVerticalUnit: 'm' };
  const created = await f.measure(page, 'POST', '/calculations', { measurement, request });
  assert.equal(created.status, 202, await created.clone().text());
  const { calculation } = await created.json();
  assert.equal((await f.measure(page, 'GET', `/calculations/${calculation.id}`)).status, 200);
  assert.equal((await deleteTask(f, item)).status, 409);
  assert.equal((await f.measure(page, 'GET', `/calculations/${calculation.id}`)).status, 403);
  assert.equal((await f.measure(page, 'POST', '/calculations', { measurement: { ...measurement, id: crypto.randomUUID() }, request })).status, 403);
  let ran = false;
  await processOneEphemeralMeasurement({ repository: f.repository, storage: { resolve: () => 'unused' }, config, runCalculation: async () => { ran = true; return {}; }, validator: { allows: async () => true } }, 'worker');
  assert.equal(ran, false, 'the queued job never reads the model');
  assert.equal(new EphemeralMeasurementRepository(f.database).claim('worker'), null);
});

test('signed-in clients: the catalog, project list and sessions drop a task in the Recycle Bin', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Deleted', { incomplete: true });
  const catalog = (taskId) => f.signed(`/api/v1/client-delivery-catalog?projectId=${site.project.id}${taskId ? `&taskId=${taskId}` : ''}`);
  const projects = async () => (await (await f.signed('/api/v1/client-delivery-projects')).json()).projects.map((project) => project.id);
  const value = crypto.randomBytes(24).toString('base64url');
  f.repository.createViewerSession({ tokenHash: auth.hashToken(value), modelId: item.modelId, modelVersionId: item.versionId, subject: 'client:test', audience: 'client', permissions: { view: true }, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const current = () => fetch(`${f.base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${value}` } });
  const visible = async () => ({ list: (await (await catalog()).json()).tasks.map((task) => task.id), task: (await catalog(item.task.id)).status, project: (await projects()).includes(site.project.id) });
  assert.deepEqual(await visible(), { list: [item.task.id], task: 200, project: true });
  assert.equal((await current()).status, 200);
  assert.equal((await deleteTask(f, item)).status, 409);
  const hidden = { list: [], task: 404, project: false };
  assert.deepEqual(await visible(), hidden);
  assert.equal((await current()).status, 401, 'the client session is revoked');
  // Published again on its own while the task is still in the bin.
  for (const status of ['draft', 'published']) {
    f.database.prepare('UPDATE processing_tasks SET status=?,archived_at=NULL WHERE id=?').run(status, item.task.id);
    assert.deepEqual(await visible(), hidden, status);
  }
  f.database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(item.task.id);
  assert.equal((await restore(f, item)).status, 200);
  assert.deepEqual(await visible(), { list: [item.task.id], task: 200, project: true });
  assert.equal((await current()).status, 401, 'restoring does not revive a session');
});

test('a deleted and restored project keeps its links revoked', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), item = f.publishedTask(site, 'Task'), { token } = f.link(site.project), page = await f.openPage(token, item);
  const trash = f.processing.trashProject(site.project.id, 'ops:test');
  assert.equal((await fetch(page.glb)).status, 403);
  assert.ok(f.processing.restoreMetadataEntity(trash.id, 'ops:test'));
  assert.equal((await fetch(`${f.base}/api/project-share/${token}`)).status, 410);
  for (const url of [page.glb, page.photo, page.products, page.download]) assert.equal((await fetch(url)).status, 403);
});

test('paging a project link lists every task once and skips tasks in the Recycle Bin', async (t) => {
  const f = await fixture(t), site = f.makeProject('Shared project'), { token } = f.link(site.project);
  const items = Array.from({ length: 5 }, (_, index) => f.publishedTask(site, `Task ${index}`, { incomplete: index === 2 }));
  const pageOf = async () => {
    const found = [];
    for (let cursor = null, pages = 0; pages < 6; pages += 1) {
      const body = await (await fetch(`${f.base}/api/project-share/${token}?limit=2${cursor ? `&cursor=${cursor}` : ''}`)).json();
      found.push(...body.tasks.map((task) => task.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return found;
  };
  assert.deepEqual((await pageOf()).sort(), items.map((item) => item.task.id).sort());
  assert.equal((await deleteTask(f, items[2])).status, 409);
  assert.deepEqual((await pageOf()).sort(), items.filter((_, index) => index !== 2).map((item) => item.task.id).sort());
});
