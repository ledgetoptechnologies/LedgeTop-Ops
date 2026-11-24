'use strict';

// Links, sessions and grants that already exist (an earlier version issued some
// after a delete that had stopped partway) are refused while their model is in
// the Recycle Bin, and restoring revokes them for good. Real routes, database
// and files, through the same metadata and asset reads a page makes.

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
const { openDatabase } = require('../server/database');
const { createEphemeralMeasurementApi } = require('../server/ephemeralMeasurementApi');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProcessingApi } = require('../server/processingApi');
const { createPropertyLinesApi } = require('../server/propertyLines');
const { signServiceRequest } = require('../server/serviceAuth');
const { ViewerRepository } = require('../server/repository');
const { createUtmProjection } = require('../utm-conversion.mjs');

const digest = (value) => crypto.createHash('sha256').update(value).digest('hex');
const GLB = 'synthetic-mesh', PHOTO = 'synthetic-photo', DSM = 'synthetic-dsm', OWNER = 'SAMPLE FARMS LLC';
const BOX = 'bbox=-89.402,43.074,-89.4,43.0755';
function georef() {
  const [e, n] = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' }).latLonToUtm(43.07475, -89.401);
  return { utmZone: 16, hemisphere: 'N', utmZoneLon0Deg: -87, rtc: { e: e - 12, n: n + 8, z: 250 }, bboxCenter: { x: 12, y: -8, z: 3 } };
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-stored-access-')), assetRoot = path.join(root, 'assets');
  fs.mkdirSync(assetRoot, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite')), repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });
  function makeProject(displayName) {
    const project = processing.createProject({ displayName });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', storageMode: 'external_reference', rootKey: 'imports', relativePath: crypto.randomUUID() });
    processing.finalizeDataset(dataset.id, [], 'c'.repeat(64));
    processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Sibling' });
    return { project, dataset };
  }
  function attemptOutput(site, task, state, versionOf = null) {
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {}, createdBy: 'ops:test' }), key = crypto.randomUUID();
    const file = (name, body) => { fs.writeFileSync(path.join(assetRoot, `${key}-${name}`), body); return { rootKey: 'webodm', relativePath: `${key}-${name}`, byteSize: Buffer.byteLength(body), sha256: digest(body) }; };
    const photo = file('photo.jpg', PHOTO), published = state !== 'failed';
    const model = repository.upsertModelVersion({
      provider: 'webodm', providerModelId: versionOf || task.id, providerVersionId: key, displayName: task.displayName, status: 'ready', makeActive: state === 'published',
      georef: georef(), metadata: { processingMetrics: { surveyedAreaM2: 200_000 } }, sourceLocator: { legacyAssetRoots: { webodm: assetRoot } },
      assets: [{ kind: 'glb', format: 'glb', published, ...file('model.glb', GLB) }, { kind: 'shots', format: 'json', published, ...file('shots.geojson', '{}') }, { kind: 'dsm', format: 'tif', published, ...file('dsm.tif', DSM) }],
      cameraPhotos: [{ filename: 'photo.jpg', contentType: 'image/jpeg', ...photo }],
    });
    const versionId = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, key).id, now = new Date().toISOString();
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: site.project.id, rootKey: 'webodm', relativePath: versionId, storageMode: 'external_reference', byteSize: 4, assetCount: 3 });
    if (state === 'published') {
      database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now, now, attempt.id);
      database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id, model.id, now, task.id);
      database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now, versionId);
    } else if (state === 'ready') processing.transitionAttempt(attempt.id, 'ready_for_review', { progress: 1 });
    else {
      database.prepare("UPDATE processing_attempts SET status='failed',completed_at=? WHERE id=?").run(now, attempt.id);
      database.prepare("UPDATE model_outputs SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(versionId);
    }
    return { attempt, modelId: model.id, versionId };
  }
  // The task's older output cannot be moved to the bin, so a delete stops (409)
  // after the task itself is in the bin and before its model is taken down.
  function makeTask(site, name, { state = 'published', incomplete = true } = {}) {
    const task = processing.createTask({ projectId: site.project.id, datasetId: site.dataset.id, displayName: name }), blocker = incomplete ? attemptOutput(site, task, 'failed') : null, output = attemptOutput(site, task, state);
    if (blocker) database.prepare("UPDATE processing_attempts SET status='derivatives' WHERE id=?").run(blocker.attempt.id);
    return { task, project: site.project, ...output };
  }

  const staffToken = 'stored-access-admin-token-000000000000';
  processing.createAdminSession({ tokenHash: auth.hashToken(staffToken), subject: 'ops:test', displayUnits: 'imperial',
    permissions: ['viewer.processing.read', 'viewer.processing.write', 'viewer.processing.publish', 'viewer.projects.write', 'viewer.storage.purge', 'viewer.shares.read', 'viewer.shares.create', 'viewer.shares.revoke'], expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const keys = ['serviceAuthKeyId', 'serviceAuthSecret', 'publishedSessionSourceRevocationEnabled'], previous = Object.fromEntries(keys.map((key) => [key, config[key]]));
  Object.assign(config, { serviceAuthKeyId: 'stored-access', serviceAuthSecret: 's'.repeat(40), publishedSessionSourceRevocationEnabled: false });
  t.after(() => Object.assign(config, previous));
  assets.setRepository(repository);
  assets.setProcessingRepository(processing);
  shareApi.setRepository(repository);
  const app = express();
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => { req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('='))); next(); });
  app.use(shareApi);
  app.use(createApiV1(repository));
  app.use(createPropertyLinesApi({ repository, source: { parcels: async () => ({ status: 'ok', parcels: [{ id: 1, owner: OWNER, rings: [[[-89.401, 43.075], [-89.4005, 43.075], [-89.4005, 43.0752], [-89.401, 43.075]]] }] }) } }));
  app.use('/temporary', createEphemeralMeasurementApi(repository, { preflightRaster: async () => {}, validator: { allows: async () => true } }));
  app.use(createProcessingApi({ repository, processing, storage: { pathExistsStrict: () => true } }));
  app.use(assets);
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ code: error.code, message: error.message }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  let sequence = 0;
  const staff = (method, route, body = {}, key = `stored-access-${sequence += 1}`) => fetch(base + route, { method, body: JSON.stringify(body), headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json', 'idempotency-key': key } });
  const service = (method, route, body, key = `stored-access-service-${sequence += 1}`) => {
    const raw = JSON.stringify(body);
    return fetch(base + route, { method, body: raw, headers: { 'content-type': 'application/json', 'idempotency-key': key, ...signServiceRequest({ keyId: config.serviceAuthKeyId, secret: config.serviceAuthSecret, method, path: route, body: raw }) } });
  };

  // Everything stored for one model: rows as any version wrote them.
  function store(item) {
    const future = new Date(Date.now() + 600_000).toISOString(), now = new Date().toISOString(), link = auth.newShareToken(), pinned = auth.newShareToken();
    const share = (id, hash, versionId) => database.prepare("INSERT INTO public_shares(id,model_id,version_policy,model_version_id,public_id_hash,permissions_json,created_at,updated_at) VALUES (?,?,?,?,?,'{\"view\":true,\"measure\":true,\"cameras\":true,\"download\":true}',?,?)").run(id, item.modelId, versionId ? 'pinned' : 'latest', versionId, hash, now, now);
    const stored = { item, link: link.token, pinned: pinned.token, shareIds: [crypto.randomUUID(), crypto.randomUUID()], sessions: {}, grants: {} };
    share(stored.shareIds[0], link.tokenHash, null);
    share(stored.shareIds[1], pinned.tokenHash, item.versionId);
    for (const [name, audience, mode] of [['client', 'client', 'published'], ['staff', 'ops', 'published'], ...(item.review ? [['review', 'ops', 'review']] : [])]) {
      const token = crypto.randomBytes(24).toString('base64url'), id = crypto.randomUUID(), grant = crypto.randomUUID(), permissions = JSON.stringify({ view: true, measure: true, cameras: true, download: true, personalMeasurements: true, __versionId: item.versionId });
      database.prepare('INSERT INTO viewer_sessions(id,token_hash,model_id,model_version_id,review_attempt_id,session_mode,subject,audience,permissions_json,display_units,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,\'imperial\',?,?,?)').run(id, auth.hashToken(token), item.modelId, item.versionId, mode === 'review' ? item.attempt.id : null, mode, `${audience}:one`, audience, permissions, future, now, now);
      database.prepare('INSERT INTO session_grants(id,model_id,model_version_id,review_attempt_id,session_mode,subject,audience,permissions_json,display_units,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,\'imperial\',?,?)').run(grant, item.modelId, item.versionId, mode === 'review' ? item.attempt.id : null, mode, `${audience}:two`, audience, permissions, future, now);
      stored.sessions[name] = { id, token };
      stored.grants[name] = grant;
    }
    return stored;
  }
  // As an earlier version left them: issued, or not revoked, after the delete.
  function reissue(stored) {
    const grants = Object.values(stored.grants).map((id) => ({ id, row: database.prepare('SELECT 1 FROM session_grants WHERE id=?').get(id) }));
    for (const id of stored.shareIds) database.prepare('UPDATE public_shares SET revoked_at=NULL,revoked_by=NULL,revoke_reason=NULL WHERE id=?').run(id);
    for (const { id } of Object.values(stored.sessions)) database.prepare('UPDATE viewer_sessions SET revoked_at=NULL WHERE id=?').run(id);
    for (const [name, { id, row }] of Object.entries(stored.grants).map(([key], index) => [key, grants[index]])) if (!row) {
      const audience = name === 'client' ? 'client' : 'ops', mode = name === 'review' ? 'review' : 'published';
      database.prepare('INSERT INTO session_grants(id,model_id,model_version_id,review_attempt_id,session_mode,subject,audience,permissions_json,display_units,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,\'imperial\',?,?)').run(id, stored.item.modelId, stored.item.versionId, mode === 'review' ? stored.item.attempt.id : null, mode, `${audience}:two`, audience, JSON.stringify({ view: true, __versionId: stored.item.versionId }), new Date(Date.now() + 600_000).toISOString(), new Date().toISOString());
    }
  }
  // The page a link or session opened, with everything it was given.
  async function openAll(stored) {
    const pages = {}, model = encodeURIComponent(stored.item.modelId);
    const add = async (name, capability, headers, entry) => {
      const prefix = `${base}/session-assets/${encodeURIComponent(capability)}/${model}/webodm/`, asset = repository.getModelVersion(stored.item.modelId, stored.item.versionId).activeVersion.assets.find((value) => value.kind === 'glb');
      const grant = await fetch(`${base}/session-products/${encodeURIComponent(capability)}/${model}/glb/download-grants`, { method: 'POST' });
      pages[name] = { entry, headers, capability, glb: prefix + asset.relativePath, cookieGlb: `${base}/assets/${model}/webodm/${asset.relativePath}`, photo: `${base}/session-camera-photos/${encodeURIComponent(capability)}/${model}/photo.jpg`, products: `${base}/session-products/${encodeURIComponent(capability)}/${model}`, download: grant.status === 201 ? base + (await grant.json()).url : null };
    };
    for (const [name, token] of [['link', stored.link], ['pinned link', stored.pinned]]) {
      const response = await fetch(`${base}/api/share/${token}`);
      if (response.status === 200) { const body = await response.json(); if (body.assets?.glb) await add(name, decodeURIComponent(body.assets.glb.split('/')[2]), { cookie: response.headers.get('set-cookie').split(';')[0] }, `${base}/api/share/${token}`); }
    }
    for (const [name, { token }] of Object.entries(stored.sessions)) await add(name, token, { authorization: `Bearer ${token}`, cookie: `ltds_viewer=${token}` }, `${base}/api/v1/sessions/current`);
    return pages;
  }
  // Every read a page makes: metadata, whole, partial and HEAD assets, photos,
  // product list, a prepared and a new download, property lines, measurements.
  async function reads(stored, page, name) {
    const review = name === 'review', out = {}, get = async (key, url, options = {}) => {
      const response = await fetch(url, options), body = await response.text();
      out[key] = response.status;
      out.leaked ||= response.status >= 400 && [GLB, PHOTO, DSM, OWNER].some((value) => body.includes(value));
    };
    await get('metadata', page.entry, { headers: page.headers });
    await get('asset', page.glb);
    await get('range', page.glb, { headers: { range: 'bytes=2-5' } });
    await get('head', page.glb, { method: 'HEAD' });
    if (!review && name !== 'pinned link') await get('cookie asset', page.cookieGlb, { headers: { cookie: page.headers.cookie } });
    await get('photo', page.photo);
    await get('products', page.products);
    if (page.download) await get('download', page.download);
    await get('new download', `${page.products}/glb/download-grants`, { method: 'POST' });
    await get('property lines', `${base}/api/v1/property-lines/parcels?${BOX}&model=${stored.item.modelId}`, { headers: page.headers });
    await get('measurements', `${base}/temporary/capabilities`, { headers: { authorization: `Bearer ${page.capability}`, 'X-Measurement-Page': crypto.randomBytes(32).toString('base64url'), 'X-Measurement-Model-Version': stored.item.versionId } });
    if (page.headers.authorization) await get('saved measurements', `${base}/api/v1/measurements`, { headers: { authorization: page.headers.authorization } });
    return out;
  }
  async function allServed(stored, pages, note) {
    for (const [name, page] of Object.entries(pages)) {
      const result = await reads(stored, page, name);
      for (const [read, status] of Object.entries(result)) if (read !== 'leaked') assert.ok(status < 300, `${note} ${name} ${read}: ${status}`);
    }
  }
  async function allRefused(stored, pages, note) {
    for (const [name, page] of Object.entries(pages)) {
      const result = await reads(stored, page, name);
      assert.equal(result.leaked, false, `${note} ${name}`);
      for (const [read, status] of Object.entries(result)) if (read !== 'leaked') assert.ok([401, 403, 404, 410].includes(status), `${note} ${name} ${read}: ${status}`);
    }
    for (const token of [stored.link, stored.pinned]) {
      assert.equal((await fetch(`${base}/api/share/${token}`)).status, 410, note);
      assert.equal((await fetch(`${base}/api/share/${token}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"x"}' })).status, 410, note);
    }
    for (const [name, grant] of Object.entries(stored.grants)) assert.equal((await redeem(grant)).status, 410, `${note} ${name} grant`);
  }
  const redeem = (grant) => fetch(`${base}/api/v1/sessions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ grant }) });
  function assertRevoked(stored, note) {
    for (const id of stored.shareIds) assert.ok(database.prepare('SELECT revoked_at FROM public_shares WHERE id=?').get(id).revoked_at, `${note} link`);
    for (const { id } of Object.values(stored.sessions)) assert.ok(database.prepare('SELECT revoked_at FROM viewer_sessions WHERE id=?').get(id).revoked_at, `${note} session`);
    for (const id of Object.values(stored.grants)) assert.equal(database.prepare('SELECT 1 FROM session_grants WHERE id=? AND redeemed_at IS NULL').get(id), undefined, `${note} grant`);
  }
  const bin = (item) => processing.activeTrashForEntity('task', item.task.id);
  const restore = (trash) => staff('POST', `/api/v1/storage/trash/${trash.id}/restore`);
  return { database, repository, processing, base, makeProject, makeTask, attemptOutput, staff, service, store, reissue, openAll, allServed, allRefused, assertRevoked, redeem, bin, restore };
}

test('stored links, sessions and grants of a deleted task are refused, and stay refused after it is restored', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted'), kept = f.makeTask(site, 'Kept');
  const stored = f.store(item), keptStored = f.store(kept), pages = await f.openAll(stored), keptPages = await f.openAll(keptStored);
  assert.deepEqual(Object.keys(pages), ['link', 'pinned link', 'client', 'staff']);
  await f.allServed(stored, pages, 'before');
  assert.equal((await f.staff('DELETE', `/api/v1/tasks/${item.task.id}`)).status, 409);
  assert.equal(f.repository.getModel(item.modelId).status, 'ready', 'the case under test');
  f.reissue(stored);
  await f.allRefused(stored, pages, 'deleted');
  // Refusing changed nothing: they are still stored, and only the restore revokes them.
  assert.equal(f.database.prepare('SELECT revoked_at FROM public_shares WHERE id=?').get(stored.shareIds[0]).revoked_at, null);
  await f.allServed(keptStored, keptPages, 'other task');
  const audits = () => f.database.prepare("SELECT details_json FROM audit_events WHERE action='task.deleted_access_revoked'").all().map((row) => JSON.parse(row.details_json));
  const trash = f.bin(item);
  assert.equal((await f.restore(trash)).status, 200);
  f.assertRevoked(stored, 'restored');
  assert.deepEqual(audits(), [{ trashId: trash.id, shares: 2, sessions: 2, grants: 2 }]);
  await f.allRefused(stored, pages, 'restored');
  await f.allServed(keptStored, keptPages, 'other task after');
  // What is issued after the restore works.
  const again = f.store(item);
  await f.allServed(again, await f.openAll(again), 'issued after the restore');
  for (const grant of Object.values(again.grants)) assert.equal((await f.redeem(grant)).status, 200);
});

test('stored access of a deleted project is refused, and stays refused after the project is restored', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), reached = f.makeTask(site, 'Reached'), notReached = f.makeTask(site, 'Not reached', { incomplete: false });
  f.database.prepare("UPDATE processing_tasks SET created_at='2020-01-01T00:00:00.000Z' WHERE id=?").run(reached.task.id);
  const stored = [f.store(reached), f.store(notReached)], pages = [await f.openAll(stored[0]), await f.openAll(stored[1])];
  for (const [index, value] of stored.entries()) await f.allServed(value, pages[index], 'before');
  assert.equal((await f.staff('DELETE', `/api/v1/projects/${site.project.id}`)).status, 409);
  assert.equal(f.bin(notReached), null, 'the delete stopped before this task');
  stored.forEach(f.reissue);
  for (const [index, value] of stored.entries()) await f.allRefused(value, pages[index], 'deleted');
  const trash = f.processing.activeTrashForEntity('project', site.project.id);
  assert.equal((await f.restore(trash)).status, 200);
  for (const [index, value] of stored.entries()) { f.assertRevoked(value, 'restored'); await f.allRefused(value, pages[index], 'restored'); }
  const again = f.store(notReached);
  await f.allServed(again, await f.openAll(again), 'issued after the restore');
});

test('a stored review session is refused and revoked the same way', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = { ...f.makeTask(site, 'In review', { state: 'ready' }), review: true };
  const stored = f.store(item), pages = { review: (await f.openAll(stored)).review };
  stored.shareIds = []; stored.link = stored.pinned = 'not-used-in-this-test-000000000000'; stored.sessions = { review: stored.sessions.review }; stored.grants = { review: stored.grants.review };
  const entry = async () => (await fetch(pages.review.entry, { headers: pages.review.headers })).status;
  assert.equal(await entry(), 200);
  assert.equal((await fetch(pages.review.glb)).status, 200);
  assert.equal((await f.staff('DELETE', `/api/v1/tasks/${item.task.id}`)).status, 409);
  f.reissue(stored);
  f.database.prepare("UPDATE processing_tasks SET status='ready_for_review' WHERE id=?").run(item.task.id);
  for (const when of ['deleted', 'restored']) {
    assert.equal(await entry(), 401, when);
    assert.equal((await fetch(pages.review.glb)).status, 403, when);
    assert.equal((await f.redeem(stored.grants.review)).status, 410, when);
    if (when === 'restored') break;
    f.database.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(item.task.id);
    assert.equal((await f.restore(f.bin(item))).status, 200);
    f.assertRevoked(stored, 'restored');
  }
});

test('only the deleted version\'s access is refused and revoked; archived and imported models keep theirs', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), live = f.makeTask(site, 'Live', { incomplete: false }), gone = f.makeTask(site, 'Deleted');
  // An older arrangement: one model with versions from two tasks.
  f.database.prepare('UPDATE model_outputs SET model_id=? WHERE id=?').run(live.modelId, gone.versionId);
  f.database.prepare('UPDATE model_versions SET model_id=? WHERE id=?').run(live.modelId, gone.versionId);
  assert.ok(f.processing.trashTask(gone.task.id, 'ops:test'));
  const stored = f.store(live), other = f.store({ ...gone, modelId: live.modelId }), pages = await f.openAll(stored);
  await f.allServed(stored, pages, 'live version');
  for (const { token } of Object.values(other.sessions)) assert.equal((await fetch(`${f.base}/api/v1/sessions/current`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  assert.equal((await fetch(`${f.base}/api/share/${other.pinned}`)).status, 410);
  assert.ok(f.processing.restoreMetadataEntity(f.bin(gone).id, 'ops:test'));
  await f.allServed(stored, pages, 'live version after');
  for (const grant of Object.values(stored.grants)) assert.equal((await f.redeem(grant)).status, 200, 'live version grant');
  for (const grant of Object.values(other.grants)) assert.equal((await f.redeem(grant)).status, 410, 'deleted version grant');
  assert.ok(f.database.prepare('SELECT revoked_at FROM public_shares WHERE id=?').get(other.shareIds[1]).revoked_at, 'pinned to the deleted version');
  assert.equal(f.database.prepare('SELECT revoked_at FROM public_shares WHERE id=?').get(other.shareIds[0]).revoked_at, null, 'follows the live version');
  for (const { id } of Object.values(other.sessions)) assert.ok(f.database.prepare('SELECT revoked_at FROM viewer_sessions WHERE id=?').get(id).revoked_at);

  const archived = f.makeTask(site, 'Archived', { incomplete: false }), archivedStored = f.store(archived), archivedPages = await f.openAll(archivedStored);
  assert.equal((await f.staff('POST', `/api/v1/tasks/${archived.task.id}/archive`)).status, 200);
  await f.allServed(archivedStored, archivedPages, 'archived');
  const imported = f.makeTask(site, 'Imported', { incomplete: false });
  f.database.prepare('DELETE FROM model_outputs WHERE id=?').run(imported.versionId);
  const importedStored = f.store(imported);
  await f.allServed(importedStored, await f.openAll(importedStored), 'imported');
});

test('a refusal because the model is deleted is not kept under its idempotency key', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), item = f.makeTask(site, 'Deleted');
  const body = { modelVersionId: item.versionId, subject: 'client:one', audience: 'client', permissions: { view: true }, displayUnits: 'imperial', authorizationExpiresAt: new Date(Date.now() + 600_000).toISOString() };
  const calls = {
    session: (key) => f.service('POST', `/api/v1/models/${item.modelId}/sessions`, body, key),
    link: (key) => f.service('POST', `/api/v1/models/${item.modelId}/shares`, { permissions: { view: true } }, key),
    view: (key) => f.staff('POST', `/api/v1/processing/outputs/${item.versionId}/view-sessions`, {}, key),
    'workspace link': (key) => f.staff('POST', `/api/v1/processing/outputs/${item.versionId}/shares`, {}, key),
  };
  assert.equal((await f.staff('DELETE', `/api/v1/tasks/${item.task.id}`)).status, 409);
  for (const [name, call] of Object.entries(calls)) for (let i = 0; i < 2; i += 1) {
    const response = await call(`same-key-for-${name.replace(' ', '-')}`);
    assert.equal(response.status, 404, name);
    assert.equal(response.headers.get('idempotency-replayed'), null, name);
  }
  // Other refusals are kept as before.
  const bad = () => f.service('POST', `/api/v1/models/${item.modelId}/sessions`, { ...body, subject: '' }, 'kept-refusal-key');
  f.database.prepare("UPDATE storage_trash SET permanently_deleted_at=created_at WHERE entity_type='task' AND entity_id=?").run(item.task.id);
  assert.equal((await bad()).status, 400);
  assert.equal((await bad()).headers.get('idempotency-replayed'), 'true');
  f.database.prepare("UPDATE storage_trash SET permanently_deleted_at=NULL WHERE entity_type='task' AND entity_id=?").run(item.task.id);
  assert.equal((await f.restore(f.bin(item))).status, 200);
  for (const [name, call] of Object.entries(calls)) {
    const key = `same-key-for-${name.replace(' ', '-')}`, response = await call(key);
    assert.equal(response.status, 201, `${name} ${await response.clone().text()}`);
    assert.equal((await call(key)).headers.get('idempotency-replayed'), 'true', `${name}: a success is kept`);
  }
});

test('a stored expiry that cannot be read never keeps a link, session or grant alive', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project');
  for (const expiry of ['not-a-date', '2099-13-45T00:00:00.000Z', ' ', '0000', '2099-01-01T00:00:00.000Z-x']) {
    const item = f.makeTask(site, `Expiry ${expiry}`), stored = f.store(item), pages = await f.openAll(stored);
    await f.allServed(stored, pages, expiry);
    const spoil = () => {
      for (const id of stored.shareIds) f.database.prepare('UPDATE public_shares SET expires_at=? WHERE id=?').run(expiry, id);
      for (const { id } of Object.values(stored.sessions)) f.database.prepare('UPDATE viewer_sessions SET expires_at=? WHERE id=?').run(expiry, id);
      for (const id of Object.values(stored.grants)) f.database.prepare('UPDATE session_grants SET expires_at=? WHERE id=?').run(expiry, id);
    };
    spoil();
    await f.allRefused(stored, pages, `${expiry} live model`);
    assert.equal((await f.staff('DELETE', `/api/v1/tasks/${item.task.id}`)).status, 409);
    f.reissue(stored);
    spoil();
    await f.allRefused(stored, pages, `${expiry} deleted`);
    assert.equal((await f.restore(f.bin(item))).status, 200);
    await f.allRefused(stored, pages, `${expiry} restored`);
    // A link with no expiry, and one in the future, are unaffected.
    const good = f.store(item);
    f.database.prepare('UPDATE public_shares SET expires_at=? WHERE id=?').run(new Date(Date.now() + 600_000).toISOString(), good.shareIds[0]);
    await f.allServed(good, await f.openAll(good), `${expiry} good`);
  }
});

test('an older grant that names its version only in its permissions is judged by that version', async (t) => {
  const f = await fixture(t), site = f.makeProject('Project'), live = f.makeTask(site, 'Live', { incomplete: false }), gone = f.makeTask(site, 'Deleted');
  f.database.prepare('UPDATE model_outputs SET model_id=? WHERE id=?').run(live.modelId, gone.versionId);
  f.database.prepare('UPDATE model_versions SET model_id=? WHERE id=?').run(live.modelId, gone.versionId);
  assert.ok(f.processing.trashTask(gone.task.id, 'ops:test'));
  const old = f.store(live), dead = f.store({ ...gone, modelId: live.modelId });
  for (const stored of [old, dead]) for (const id of Object.values(stored.grants)) f.database.prepare('UPDATE session_grants SET model_version_id=NULL WHERE id=?').run(id);
  // Not even the one whose version happens to be active again is spent or revived.
  f.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(gone.versionId, live.modelId);
  for (const grant of Object.values(dead.grants)) assert.equal((await f.redeem(grant)).status, 410);
  f.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(live.versionId, live.modelId);
  for (const grant of Object.values(dead.grants)) assert.equal((await f.redeem(grant)).status, 410);
  assert.equal((await f.redeem(old.grants.client)).status, 200, 'the live version');
  assert.ok(f.processing.restoreMetadataEntity(f.bin(gone).id, 'ops:test'));
  for (const grant of Object.values(dead.grants)) assert.equal(f.database.prepare('SELECT 1 FROM session_grants WHERE id=?').get(grant), undefined, 'revoked');
  assert.equal((await f.redeem(old.grants.staff)).status, 200, 'the live version after');
});
