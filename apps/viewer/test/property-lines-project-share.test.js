'use strict';

// Property lines on whole-project public links, with the real server code:
// the project-share and single-model share routes issue the cookies, the real
// database decides, and only the outside parcel service is a fixture.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const adminAuth = require('../server/adminAuth');
const shareApi = require('../server/shareApi');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { createProjectShareApi } = require('../server/projectShareApi');
const { createPropertyLinesApi, resolvePropertyLinesCaller, LIMITS } = require('../server/propertyLines');
const { createBoundaryStore, parseBoundaryFile } = require('../server/propertyLinesBoundary');
const { createProcessingApi } = require('../server/processingApi');
const { ViewerRepository } = require('../server/repository');
const { createUtmProjection } = require('../utm-conversion.mjs');

const BOX = 'bbox=-89.402,43.074,-89.4,43.0755';
const PARCELS = [{ id: 1, owner: 'SAMPLE FARMS LLC', rings: [[[-89.401, 43.075], [-89.4005, 43.075], [-89.4005, 43.0752], [-89.401, 43.075]]] }];

// A model centred on the Madison test box, verified UTM zone 16N.
function georef() {
  const [e, n] = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' }).latLonToUtm(43.07475, -89.401);
  return { utmZone: 16, hemisphere: 'N', utmZoneLon0Deg: -87, rtc: { e: e - 12, n: n + 8, z: 250 }, bboxCenter: { x: 12, y: -8, z: 3 } };
}

async function fixture(t, { validator, boundaries = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-project-share-parcels-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), processing = new ProcessingRepository(database);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Synthetic', endpoint: 'http://127.0.0.1:3000', enabled: true });

  function makeProject(displayName) {
    const project = processing.createProject({ displayName });
    const dataset = processing.createDataset({ projectId: project.id, displayName: 'Dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
    database.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?").run('a'.repeat(64), new Date().toISOString(), dataset.id);
    return { project, dataset };
  }
  // A processed output of a task; published unless told otherwise.
  function output({ project, dataset }, { task = null, name = 'Flight', publish = true, assets } = {}) {
    const owner = task || processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: name });
    const attempt = processing.createAttempt({ taskId: owner.id, providerId: provider.id, options: {}, createdBy: 'ops:test' });
    const model = repository.upsertModelVersion({
      provider: 'webodm', providerModelId: owner.id, providerVersionId: crypto.randomUUID(), displayName: owner.displayName, status: 'ready',
      georef: georef(), metadata: { processingMetrics: { surveyedAreaM2: 200_000 } }, makeActive: true,
      assets: assets || [{ kind: 'glb', rootKey: 'webodm', relativePath: 'model.glb', format: 'glb', byteSize: 4, sha256: 'b'.repeat(64), published: true }],
    });
    const versionId = model.activeVersion.id;
    processing.setAttemptResult(attempt.id, model.id, versionId);
    processing.registerModelOutput({ versionId, modelId: model.id, taskId: owner.id, attemptId: attempt.id, projectId: project.id, rootKey: 'webodm', relativePath: versionId, storageMode: 'external_reference', byteSize: 4, assetCount: 1 });
    if (publish) {
      const now = new Date().toISOString();
      database.prepare("UPDATE processing_attempts SET status='published',completed_at=?,updated_at=? WHERE id=?").run(now, now, attempt.id);
      database.prepare("UPDATE processing_tasks SET status='published',active_attempt_id=?,published_model_id=?,updated_at=? WHERE id=?").run(attempt.id, model.id, now, owner.id);
      database.prepare("UPDATE model_outputs SET status='published',updated_at=? WHERE id=?").run(now, versionId);
    }
    return { task: processing.getTask(owner.id), modelId: model.id, versionId };
  }
  async function link(project, { password = null, permissions = { view: true, measure: true, cameras: false, download: false }, expiresAt = null } = {}) {
    const { token, tokenHash } = auth.newShareToken();
    const share = repository.createProjectShare({ projectId: project.id, publicIdHash: tokenHash, permissions, expiresAt, passwordHash: password ? await auth.hashPassword(password) : null });
    return { token, share };
  }

  const seen = [];
  const source = { parcels: async (bounds, options) => { seen.push(options.caller); return { status: 'ok', parcels: structuredClone(PARCELS) }; } };
  const store = boundaries ? createBoundaryStore({ baseDir: path.join(root, 'boundaries'), database }) : null;
  shareApi.setRepository(repository);
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ verify: (req, _res, buffer) => { req.rawBody = Buffer.from(buffer); } }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries(String(req.headers.cookie || '').split(';').filter(Boolean).map((part) => part.trim().split('=')));
    next();
  });
  app.use(shareApi);
  app.use(createProjectShareApi({ repository, processing }));
  app.use(createPropertyLinesApi({ repository, processing, source, boundaries: store, ...(validator ? { validator } : {}) }));
  app.use(createProcessingApi({ repository, processing, storage: {} }));
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cookieOf = (response) => response.headers.get('set-cookie')?.split(';')[0];
  // Opens the link as a browser does, through the real route, and returns the
  // cookie that route set.
  async function open(token, password = null) {
    const response = password
      ? await fetch(`${base}/api/project-share/${token}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
      : await fetch(`${base}/api/project-share/${token}`);
    return { status: response.status, cookie: cookieOf(response) };
  }
  const headersOf = (value) => (typeof value === 'string' ? { cookie: value } : value || {});
  const offer = (modelId, headers) => fetch(`${base}/api/v1/property-lines?model=${modelId}`, { headers: headersOf(headers) });
  const parcels = (modelId, headers) => fetch(`${base}/api/v1/property-lines/parcels?${BOX}&model=${modelId}`, { headers: headersOf(headers) });
  async function refused(modelId, headers, status = 403, note = '') {
    const before = seen.length;
    for (const call of [offer, parcels]) {
      const response = await call(modelId, headers), text = await response.text();
      assert.equal(response.status, status, `${note} ${call.name}`);
      assert.equal(response.headers.get('cache-control'), 'no-store', note);
      assert.deepEqual(Object.keys(JSON.parse(text)).sort(), ['code', 'error'], note);
      assert.equal(/SAMPLE FARMS|rings|source/.test(text), false, note);
    }
    assert.equal(seen.length, before, `${note}: the parcel service is never asked`);
  }
  async function allowed(modelId, headers, note = '') {
    const offered = await offer(modelId, headers);
    assert.equal(offered.status, 200, `${note} offer`);
    assert.equal(offered.headers.get('cache-control'), 'no-store');
    assert.equal((await offered.json()).offered, true, note);
    const response = await parcels(modelId, headers);
    assert.equal(response.status, 200, `${note} parcels`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { status: 'ok', parcels: PARCELS }, note);
  }
  return { database, repository, processing, base, seen, store, makeProject, output, link, open, offer, parcels, refused, allowed, cookieOf };
}

const projectCookie = (payload, ttl = 60_000) => `ltds_project_share=${auth.sign(payload, ttl)}`;

test('a whole-project link gets the same property lines and owner names as a single-model link', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), first = f.output(site);
  const { token } = await f.link(site.project);
  await f.refused(first.modelId, undefined, 401, 'before the link is opened');
  const opened = await f.open(token);
  assert.equal(opened.status, 200);
  assert.match(opened.cookie, /^ltds_project_share=/);
  await f.allowed(first.modelId, opened.cookie, 'project link');

  // The single-model link, through its own real route, answers the same.
  const single = auth.newShareToken();
  f.repository.createPublicShare({ modelId: first.modelId, publicIdHash: single.tokenHash, permissions: { view: true, measure: true } });
  const singleCookie = f.cookieOf(await fetch(`${f.base}/api/share/${single.token}`));
  assert.match(singleCookie, /^ltds_share=/);
  await f.allowed(first.modelId, singleCookie, 'single-model link');
  assert.deepEqual(await (await f.offer(first.modelId, opened.cookie)).json(), await (await f.offer(first.modelId, singleCookie)).json());

  // A task published later joins the link, exactly as its assets do.
  const later = f.output(site, { name: 'Later flight' });
  await f.allowed(later.modelId, opened.cookie, 'task added later');
  // A new published version of a covered task stays covered; moving the task
  // into a folder of the project changes nothing.
  f.output(site, { task: first.task });
  await f.allowed(first.modelId, opened.cookie, 'newer version');
  const folder = f.processing.createProjectFolder(site.project.id, { displayName: 'Folder' }, 'ops:test');
  f.processing.moveTaskToFolder(first.task.id, folder.id, 'ops:test');
  await f.allowed(first.modelId, opened.cookie, 'in a folder');
});

test('a project link covers only the published tasks it can open', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), other = f.makeProject('Other project');
  const published = f.output(site);
  const draft = f.output(site, { name: 'Draft', publish: false });
  const foreign = f.output(other, { name: 'Foreign' });
  const loose = f.repository.upsertModelVersion({ provider: 'webodm', providerModelId: 'loose', providerVersionId: 'v1', displayName: 'No task', status: 'ready', georef: georef(), makeActive: true,
    assets: [{ kind: 'glb', rootKey: 'webodm', relativePath: 'loose.glb', format: 'glb', byteSize: 4, sha256: 'c'.repeat(64), published: true }] });
  const reportOnly = f.output(site, { name: 'Report only', assets: [{ kind: 'report', rootKey: 'webodm', relativePath: 'report.pdf', format: 'pdf', byteSize: 4, sha256: 'd'.repeat(64), published: true }] });
  const unverified = f.output(site, { name: 'No checksum', assets: [{ kind: 'glb', rootKey: 'webodm', relativePath: 'raw.glb', format: 'glb', byteSize: 4, published: true }] });
  const { token, share } = await f.link(site.project);
  const { cookie } = await f.open(token);
  await f.allowed(published.modelId, cookie);
  for (const [note, modelId] of Object.entries({ draft: draft.modelId, 'another project': foreign.modelId, 'model without a task': loose.id,
    'no public derivative': reportOnly.modelId, 'derivative without a checksum': unverified.modelId, 'unknown model': 'no-such-model' }))
    await f.refused(modelId, cookie, 403, note);
  // The same two outputs are refused by the link's own task route.
  for (const item of [reportOnly, unverified])
    assert.equal((await fetch(`${f.base}/api/project-share/${token}/tasks/${item.task.id}`, { headers: { cookie } })).status, 409);

  // Cross-project, both directions, including a signed cookie whose project
  // does not match its share (the server never signs one).
  const otherLink = await f.link(other.project), otherCookie = (await f.open(otherLink.token)).cookie;
  await f.allowed(foreign.modelId, otherCookie);
  await f.refused(published.modelId, otherCookie, 403, 'other project link');
  await f.refused(foreign.modelId, projectCookie({ kind: 'project-share', shareId: share.id, projectId: other.project.id }), 403, 'mismatched project');
  await f.refused(published.modelId, projectCookie({ kind: 'project-share', shareId: otherLink.share.id, projectId: site.project.id }), 403, 'mismatched share');
  await f.refused(published.modelId, projectCookie({ kind: 'project-share', shareId: share.id, projectId: other.project.id }), 403, 'own model, wrong project');
  await f.refused(foreign.modelId, projectCookie({ kind: 'project-share', shareId: otherLink.share.id, projectId: site.project.id }), 403, 'own model, wrong project');

  // A task here that points at a model whose active output belongs to another
  // project does not bring that model into this link.
  f.database.prepare('UPDATE processing_tasks SET published_model_id=? WHERE id=?').run(foreign.modelId, draft.task.id);
  await f.refused(foreign.modelId, cookie, 403, 'borrowed model');
  await f.allowed(foreign.modelId, otherCookie);
});

test('a covered model is dropped as soon as it leaves the link', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project');
  const { token } = await f.link(site.project);
  const changes = {
    'unpublished task': (item) => f.database.prepare('UPDATE processing_tasks SET published_model_id=NULL WHERE id=?').run(item.task.id),
    'output no longer published': (item) => f.database.prepare("UPDATE model_outputs SET status='archived' WHERE id=?").run(item.versionId),
    'model unregistered': (item) => f.database.prepare("UPDATE models SET status='unregistered' WHERE id=?").run(item.modelId),
    'version no longer ready': (item) => f.database.prepare("UPDATE model_versions SET status='failed' WHERE id=?").run(item.versionId),
    'asset unpublished': (item) => f.database.prepare('UPDATE model_assets SET published=0 WHERE version_id=?').run(item.versionId),
    'task in the recycle bin': (item) => assert.ok(f.processing.trashTask(item.task.id, 'ops:test')),
  };
  for (const [note, change] of Object.entries(changes)) {
    const item = f.output(site, { name: note });
    const { cookie } = await f.open(token);
    await f.allowed(item.modelId, cookie, note);
    change(item);
    await f.refused(item.modelId, cookie, 403, note);
  }
  const item = f.output(site), { cookie } = await f.open(token);
  await f.allowed(item.modelId, cookie);
  f.database.prepare("UPDATE projects SET status='archived' WHERE id=?").run(site.project.id);
  await f.refused(item.modelId, cookie, 403, 'project not active');
});

test('expired, revoked, locked and forged project links', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), item = f.output(site);

  // Expiry: of the link, and of the session cookie.
  const expiring = await f.link(site.project, { expiresAt: new Date(Date.now() + 60 * 60_000).toISOString() });
  const expiringCookie = (await f.open(expiring.token)).cookie;
  await f.allowed(item.modelId, expiringCookie);
  f.database.prepare('UPDATE public_project_shares SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), expiring.share.id);
  await f.refused(item.modelId, expiringCookie, 403, 'link expired');
  const live = await f.link(site.project);
  const payload = { kind: 'project-share', shareId: live.share.id, projectId: site.project.id };
  await f.allowed(item.modelId, projectCookie(payload));
  await f.refused(item.modelId, projectCookie(payload, -1), 403, 'cookie expired');

  // Revocation through the real staff route, on the very next request.
  const staffToken = 'project-parcels-admin-token-000000000000';
  f.processing.createAdminSession({ tokenHash: auth.hashToken(staffToken), subject: 'ops:test', permissions: ['viewer.shares.read', 'viewer.shares.revoke'], displayUnits: 'imperial', expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const revocable = await f.link(site.project), revocableCookie = (await f.open(revocable.token)).cookie;
  await f.allowed(item.modelId, revocableCookie);
  const revoke = await fetch(`${f.base}/api/v1/project-shares/${revocable.share.id}`, { method: 'DELETE', headers: { authorization: `Bearer ${staffToken}`, 'content-type': 'application/json', 'idempotency-key': 'project-parcels-revoke-0001' }, body: '{}' });
  assert.equal(revoke.status, 200);
  await f.refused(item.modelId, revocableCookie, 403, 'revoked');
  await f.allowed(item.modelId, projectCookie(payload), 'another live link is unaffected');

  // Password: no cookie, and so no property lines, until it is unlocked.
  const locked = await f.link(site.project, { password: 'password123' });
  const before = await f.open(locked.token);
  assert.equal(before.status, 401);
  assert.equal(before.cookie, undefined);
  await f.refused(item.modelId, undefined, 401, 'locked');
  const wrong = await f.open(locked.token, 'wrong password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.cookie, undefined);
  await f.allowed(item.modelId, (await f.open(locked.token, 'password123')).cookie, 'unlocked');

  // The link's own unlock check is unchanged: another kind does not unlock it.
  for (const [kind, status] of [['project-share-asset', 401], ['project-share', 200]]) {
    const cookie = projectCookie({ kind, shareId: locked.share.id, projectId: site.project.id });
    assert.equal((await fetch(`${f.base}/api/project-share/${locked.token}`, { headers: { cookie } })).status, status, kind);
  }

  // Forged, altered, unknown, malformed and view-less.
  const genuine = auth.sign(payload, 60_000);
  for (const value of ['x'.repeat(40), `${genuine}x`, `${Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 90_000 })).toString('base64url')}.${genuine.split('.')[1]}`])
    await f.refused(item.modelId, `ltds_project_share=${value}`, 403, 'forged');
  await f.refused(item.modelId, projectCookie({ ...payload, shareId: crypto.randomUUID() }), 403, 'unknown link');
  for (const odd of [{ shareId: 7 }, { shareId: null }, { shareId: { id: live.share.id } }, { projectId: null }, { projectId: undefined }])
    await f.refused(item.modelId, projectCookie({ ...payload, ...odd }), 403, 'malformed payload');
  const noView = await f.link(site.project, { permissions: { view: false, measure: true } });
  await f.refused(item.modelId, (await f.open(noView.token)).cookie, 403, 'link without view permission');
  // The raw link token is not a credential here, in any position.
  await f.refused(item.modelId, `ltds_project_share=${live.token}`, 403, 'raw token cookie');
  await f.refused(item.modelId, { authorization: `Bearer ${live.token}` }, 403, 'raw token bearer');
  await f.refused(item.modelId, { authorization: `Bearer ${genuine}` }, 403, 'cookie value as bearer');
});

test('source authorization is checked the same way as for a single-model link', async (t) => {
  let allow = true, onCheck = () => {};
  const shares = [];
  const f = await fixture(t, { validator: { allows: async (share) => { shares.push(share.id); onCheck(); return allow; } } });
  const site = f.makeProject('Shared project'), item = f.output(site), { token, share } = await f.link(site.project);
  const { cookie } = await f.open(token);
  await f.allowed(item.modelId, cookie);
  assert.deepEqual([...new Set(shares)], [share.id]);
  allow = false;
  await f.refused(item.modelId, cookie, 403, 'authorization withdrawn');
  // Revoked while that check is pending: the link is read again after it.
  allow = true;
  onCheck = () => f.repository.revokeProjectShare(share.id, { reason: 'test' });
  await f.refused(item.modelId, cookie, 403, 'revoked during the check');
});

test('cookie confusion: each credential is accepted only in its own place and kind', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), item = f.output(site), sibling = f.output(site, { name: 'Sibling' });
  const { token, share } = await f.link(site.project);
  const project = (await f.open(token)).cookie, projectValue = project.slice('ltds_project_share='.length);
  const single = auth.newShareToken();
  const modelShare = f.repository.createPublicShare({ modelId: item.modelId, publicIdHash: single.tokenHash, permissions: { view: true } });
  const model = f.cookieOf(await fetch(`${f.base}/api/share/${single.token}`)), modelValue = model.slice('ltds_share='.length);
  await f.allowed(item.modelId, model);
  await f.refused(sibling.modelId, model, 403, 'a single-model link still covers one model');

  // A project cookie anywhere else, and other cookies in the project slot.
  for (const name of ['ltds_share', 'ltds_viewer', 'ltds_admin']) await f.refused(item.modelId, `${name}=${projectValue}`, 403, `project cookie as ${name}`);
  await f.refused(item.modelId, `ltds_project_share=${modelValue}`, 403, 'single-model cookie as project cookie');
  const scope = { shareId: share.id, projectId: site.project.id };
  for (const payload of [scope, { ...scope, kind: 'project-share-asset', taskId: item.task.id, modelId: item.modelId, modelVersionId: item.versionId },
    { ...scope, kind: 'share-asset', modelId: item.modelId }, { ...scope, kind: 'Project-share' }, { ...scope, kind: ['project-share'] },
    { kind: 'project-share', shareId: modelShare.id, projectId: site.project.id }, { role: 'admin' }, { role: 'admin', kind: 'project-share', projectId: site.project.id }])
    await f.refused(item.modelId, projectCookie(payload), 403, JSON.stringify(payload));
  // Asset capabilities are for asset paths only.
  await f.refused(item.modelId, `ltds_share=${auth.sign({ kind: 'project-share-asset', ...scope, taskId: item.task.id, modelId: item.modelId, modelVersionId: item.versionId }, 60_000)}`, 403, 'asset capability');
  const opened = await (await fetch(`${f.base}/api/project-share/${token}/tasks/${item.task.id}`, { headers: { cookie: project } })).json();
  const capability = decodeURIComponent(opened.assets.glb.split('/')[2]);
  assert.equal(auth.verify(capability).kind, 'project-share-asset');
  for (const name of ['ltds_project_share', 'ltds_share', 'ltds_viewer']) await f.refused(item.modelId, `${name}=${capability}`, 403, `issued asset capability as ${name}`);

  // Staff and client sessions: unchanged, first, and still bound to their model.
  const session = (audience) => {
    const value = crypto.randomBytes(24).toString('base64url');
    f.repository.createViewerSession({ tokenHash: auth.hashToken(value), modelId: item.modelId, modelVersionId: item.versionId, subject: `${audience}:test`, audience, permissions: { view: true }, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    return { value, id: f.repository.getViewerSessionByHash(auth.hashToken(value)).id };
  };
  for (const audience of ['ops', 'client']) {
    const own = session(audience);
    for (const headers of [{ authorization: `Bearer ${own.value}` }, { cookie: `ltds_viewer=${own.value}` }]) {
      await f.allowed(item.modelId, headers, audience);
      await f.refused(sibling.modelId, headers, 403, `${audience} session on another model`);
    }
    await f.allowed(item.modelId, { authorization: `Bearer ${own.value}`, cookie: project }, audience);
    assert.equal(f.seen.at(-1), `session:${own.id}`, 'a signed-in session is used before any link');
    // A session that does not cover the model adds nothing to the link and
    // takes nothing from it (as with a single-model link).
    await f.allowed(sibling.modelId, { authorization: `Bearer ${own.value}`, cookie: project }, audience);
    assert.match(f.seen.at(-1), /^share:project:/);
    f.database.prepare('UPDATE viewer_sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), own.id);
    await f.refused(item.modelId, { authorization: `Bearer ${own.value}` }, 403, `${audience} session revoked`);
  }
  // Dead project cookie beside a live single-model cookie, and the reverse.
  await f.allowed(item.modelId, `${model}; ltds_project_share=${'x'.repeat(40)}`, 'live single link');
  assert.match(f.seen.at(-1), new RegExp(`^share:${modelShare.id}:`));
  await f.allowed(item.modelId, `ltds_share=${'x'.repeat(40)}; ${project}`, 'live project link');
  await f.refused(item.modelId, `ltds_share=${'x'.repeat(40)}; ltds_project_share=${'x'.repeat(40)}`, 403, 'both dead');
  // The project cookie opens nothing on the staff routes.
  assert.equal((await fetch(`${f.base}/api/v1/projects/${site.project.id}/public-shares`, { headers: { cookie: project } })).status, 401);
});

test('emergency admin access is unchanged', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), draft = f.output(site, { name: 'Draft', publish: false });
  const previous = config.emergencyAdminEnabled;
  t.after(() => { config.emergencyAdminEnabled = previous; });
  const admin = `${adminAuth.COOKIE_NAME}=${auth.sign({ role: 'admin' }, 60_000)}`;
  config.emergencyAdminEnabled = true;
  await f.allowed(draft.modelId, admin);
  assert.equal(f.seen.at(-1), 'admin');
  config.emergencyAdminEnabled = false;
  await f.refused(draft.modelId, admin, 403, 'admin disabled');
});

test('an uploaded boundary stays hidden from project links until staff allow public links', async (t) => {
  const f = await fixture(t, { boundaries: true });
  const site = f.makeProject('Shared project'), item = f.output(site), { token } = await f.link(site.project), { cookie } = await f.open(token);
  const ring = [[-89.4012, 43.0748], [-89.4005, 43.0748], [-89.4005, 43.0752], [-89.4012, 43.0748]];
  f.store.save(site.project.id, parseBoundaryFile(Buffer.from(JSON.stringify({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }))), { bytes: 1, sha256: 'e'.repeat(64) });
  assert.deepEqual(await (await f.offer(item.modelId, cookie)).json(), { offered: false, source: null });
  const hidden = await f.parcels(item.modelId, cookie);
  assert.equal(hidden.status, 403);
  assert.equal((await hidden.json()).code, 'property_lines_not_offered');
  f.store.update(site.project.id, { publicVisible: true });
  assert.equal((await (await f.offer(item.modelId, cookie)).json()).source.kind, 'upload');
  assert.deepEqual(await (await f.parcels(item.modelId, cookie)).json(), { status: 'ok', parcels: [{ id: 1, rings: [ring] }] });
  assert.equal(f.seen.length, 0, 'the state service is not asked');
});

test('project links keep the request limits, the area limits and the per-address caller', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), item = f.output(site), sibling = f.output(site, { name: 'Sibling' });
  const { token, share } = await f.link(site.project), { cookie } = await f.open(token);
  const get = (query, address = '198.51.100.7') => fetch(`${f.base}/api/v1/property-lines/parcels?${query}`, { headers: { cookie, 'x-forwarded-for': address } });
  const away = await get(`bbox=-87.915,43.035,-87.905,43.045&model=${item.modelId}`);
  assert.equal(away.status, 403);
  assert.equal((await away.json()).code, 'outside_model');
  for (const extra of ['&outFields=*', '&projectId=x', '&task=x', '&token=x']) assert.equal((await get(`${BOX}&model=${item.modelId}${extra}`)).status, 400, extra);
  assert.equal(f.seen.length, 0);

  for (const [modelId, address] of [[item.modelId, '198.51.100.7'], [item.modelId, '203.0.113.9'], [sibling.modelId, '198.51.100.7']])
    assert.equal((await get(`${BOX}&model=${modelId}`, address)).status, 200);
  assert.notEqual(f.seen[0], f.seen[1], 'different addresses are different callers');
  assert.equal(f.seen[0], f.seen[2], 'one link and address share one allowance across the models of the project');
  for (const caller of f.seen) assert.match(caller, new RegExp(`^share:project:${share.id}:[0-9a-f]{16}$`));
  let last;
  for (let i = 0; i < LIMITS.callerRatePerMinute; i += 1) {
    last = await get(`${BOX}&model=${item.modelId}`);
    await last.arrayBuffer();
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('cache-control'), 'no-store');
});

test('property-lines requests leave the same record as for a single-model link: none', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), item = f.output(site), { token, share } = await f.link(site.project), { cookie } = await f.open(token);
  const single = auth.newShareToken(), modelShare = f.repository.createPublicShare({ modelId: item.modelId, publicIdHash: single.tokenHash, permissions: { view: true } });
  const model = f.cookieOf(await fetch(`${f.base}/api/share/${single.token}`));
  const snapshot = () => JSON.stringify([f.database.prepare('SELECT COUNT(*) n FROM audit_events').get().n, f.repository.getProjectShare(share.id), f.repository.getPublicShare(modelShare.id)]);
  assert.equal(f.repository.getProjectShare(share.id).accessCount, 1, 'opening the link is what is counted');
  const before = snapshot();
  await f.allowed(item.modelId, model);
  assert.equal(snapshot(), before);
  await f.allowed(item.modelId, cookie);
  assert.equal(snapshot(), before);
  await f.refused(item.modelId, 'ltds_project_share=x', 403);
  assert.equal(snapshot(), before);
});

test('without the processing platform a project cookie grants nothing', async (t) => {
  const f = await fixture(t);
  const site = f.makeProject('Shared project'), item = f.output(site), { token } = await f.link(site.project), { cookie } = await f.open(token);
  const req = { headers: {}, get: () => undefined, ip: '198.51.100.7', cookies: { ltds_project_share: cookie.slice('ltds_project_share='.length) } };
  assert.equal((await resolvePropertyLinesCaller(req, f.repository, item.modelId, { processing: f.processing }))?.audience, 'public');
  assert.equal(await resolvePropertyLinesCaller(req, f.repository, item.modelId), null);
});

test('the server gives property lines the processing repository', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'index.js'), 'utf8');
  assert.match(source, /createPropertyLinesApi\(\{ repository, processing: processingRepository, boundaries: propertyLinesBoundaries \}\)/);
});
