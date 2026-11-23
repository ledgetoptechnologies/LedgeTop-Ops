'use strict';

// Invented, isolated fixtures only: random bytes in a temporary directory.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { VIEWER_COOKIE } = require('../server/apiV1');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { SourceAuthorizationValidator, sourceAuthorizationValidator } = require('../server/sourceAuthorization');

const CHUNK = 4 * 1024 * 1024;
const NO_STORE = 'private, no-store';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
// 5 minutes from the authorization decision, so a little less at the send.
const fullTime = (response, label) => assert.ok(maxAge(response) >= 290 && maxAge(response) <= 300, `${label}: ${response.status} ${response.headers['cache-control']}`);
const maxAge = (response) => Number(/^private, max-age=(\d+), must-revalidate$/.exec(response.headers['cache-control'])?.[1] ?? NaN);

function chunksOf(body) {
  const chunks = [];
  for (let offset = 0, index = 0; offset < body.length; offset += CHUNK, index += 1) {
    const slice = body.subarray(offset, Math.min(body.length, offset + CHUNK));
    chunks.push({ chunkIndex: index, byteOffset: offset, byteSize: slice.length, sha256: sha256(slice) });
  }
  return chunks;
}

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-browser-cache-'));
  const modelsMount = path.join(root, 'models');
  const previous = { modelsMount: config.modelsMount, xAccelRedirectPrefix: config.xAccelRedirectPrefix };
  Object.assign(config, { modelsMount, xAccelRedirectPrefix: '' });
  const files = {}, bodies = {};
  const write = (name, rel, body) => {
    files[name] = path.join(modelsMount, ...rel.split('/'));
    bodies[name] = Buffer.from(body);
    fs.mkdirSync(path.dirname(files[name]), { recursive: true });
    fs.writeFileSync(files[name], body);
  };
  const asset = (kind, rel, body, extra = {}) => {
    write(kind, `task/${rel}`, body);
    return { kind, rootKey: 'models', relativePath: `task/${rel}`, format: path.extname(rel).slice(1), byteSize: body.length, sha256: sha256(body), storageMode: 'managed', published: true, ...extra };
  };
  const tree = (kind, rel, childRel) => {
    const index = Buffer.from(`{"${kind}":1}`), child = crypto.randomBytes(9000);
    write(`${kind} child`, `task/${kind}/${childRel}`, child);
    const manifestFiles = [{ relativePath: rel, byteSize: index.length, sha256: sha256(index) }, { relativePath: childRel, byteSize: child.length, sha256: sha256(child) }];
    return asset(kind, `${kind}/${rel}`, index, { manifestFiles, manifestSha256: sha256(JSON.stringify(manifestFiles)) });
  };
  const ortho = crypto.randomBytes(CHUNK + 70_000);
  const list = [
    tree('tiles', 'tileset.json', '0/tile.b3dm'), tree('ept', 'ept.json', 'ept-data/0-0-0-0.laz'),
    asset('glb', 'model.glb', crypto.randomBytes(5000)), asset('ortho', 'ortho.tif', ortho, { chunks: chunksOf(ortho) }),
    asset('orthoCutline', 'cutline.geojson', Buffer.from('{}')), asset('dtm', 'dtm.tif', crypto.randomBytes(5000)),
    asset('dsm', 'dsm.tif', crypto.randomBytes(CHUNK + 5)), // no chunk records: streamed
    asset('obj', 'mesh.obj', crypto.randomBytes(900)), asset('pointCloud', 'cloud.laz', crypto.randomBytes(900)),
    asset('shots', 'shots.geojson', Buffer.from('{}')), asset('report', 'report.pdf', crypto.randomBytes(900)),
  ];
  write('photo', 'task/photo.jpg', crypto.randomBytes(800));
  const database = openDatabase(path.join(root, 'viewer.sqlite')), repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID(), versionId = crypto.randomUUID(), token = crypto.randomBytes(32).toString('base64url');
  // upsertModelVersion replaces the assets of the same version.
  const register = (entries) => repository.upsertModelVersion({ modelId, versionId, provider: 'webodm', providerModelId: 'cache', providerVersionId: sha256('cache'), displayName: 'Cache', status: 'ready', sourceLocator: {}, versionMetadata: {}, makeActive: true, assets: entries });
  register(list);
  repository.replaceCameraPhotos(versionId, [{ filename: 'photo.jpg', rootKey: 'models', relativePath: 'task/photo.jpg', contentType: 'image/jpeg', byteSize: 800, sha256: sha256(bodies.photo) }]);
  const session = repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId, modelVersionId: versionId, subject: 'ops:test', audience: 'ops', permissions: { view: true, download: true, cameras: true }, expiresAt: new Date(Date.now() + 3_600_000).toISOString() });
  assets.setRepository(repository);
  assets.setSourceAuthorizationValidator({ allows: async () => true });
  const integrity = assets.assetIntegrityCache;
  const saved = { platform: integrity.platform, maxQueuedStreams: integrity.maxQueuedStreams };
  integrity.platform = 'win32'; // uncached, so every body is checked
  integrity.clear();
  const app = express();
  app.use((req, _res, next) => { req.cookies = req.get('x-test-cookie') ? { [VIEWER_COOKIE]: req.get('x-test-cookie') } : {}; next(); });
  app.use(assets);
  const server = await new Promise((resolve) => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    assets.setRepository(null);
    assets.setProcessingRepository(null);
    assets.setSourceAuthorizationValidator(sourceAuthorizationValidator);
    Object.assign(integrity, saved);
    integrity.clear();
    Object.assign(config, previous);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  // node:http, because fetch() adds `Cache-Control: no-cache` to conditional requests.
  const request = (url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: server.address().port, path: url, method, headers, agent: false }, (response) => {
      const parts = [];
      response.on('data', (part) => parts.push(part)).on('error', reject)
        .on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(parts) }));
    }).on('error', reject).end();
  });
  const url = (rel, capability = token) => `/session-assets/${encodeURIComponent(capability)}/${modelId}/models/task/${rel}`;
  return { request, url, files, bodies, repository, database, integrity, modelId, versionId, session, token, register, list };
}

const CACHEABLE = {
  tiles: 'tiles/tileset.json', 'tiles child': 'tiles/0/tile.b3dm', ept: 'ept/ept.json', 'ept child': 'ept/ept-data/0-0-0-0.laz',
  glb: 'model.glb', ortho: 'ortho.tif', orthoCutline: 'cutline.geojson', dtm: 'dtm.tif',
};
const NEVER = { 'legacy raster without chunk records': 'dsm.tif', obj: 'mesh.obj', pointCloud: 'cloud.laz', shots: 'shots.geojson', report: 'report.pdf' };

test('map and model assets on capability URLs are kept by the browser for 5 minutes with a strong ETag', async (t) => {
  const f = await fixture(t);
  for (const [name, rel] of Object.entries(CACHEABLE)) {
    const etag = `"sha256-${sha256(f.bodies[name])}"`;
    const responses = {
      full: [200, await f.request(f.url(rel))],
      head: [200, await f.request(f.url(rel), {}, 'HEAD')],
      range: [206, await f.request(f.url(rel), { range: 'bytes=0-0' })],
      tail: [206, await f.request(f.url(rel), { range: 'bytes=-1' })],
      notModified: [304, await f.request(f.url(rel), { 'if-none-match': etag })],
      weak: [304, await f.request(f.url(rel), { 'if-none-match': `"x", W/${etag}` })],
      rangeNotModified: [304, await f.request(f.url(rel), { 'if-none-match': etag, range: 'bytes=0-0' })],
    };
    for (const [label, [status, response]] of Object.entries(responses)) {
      assert.equal(response.status, status, `${name} ${label}`);
      fullTime(response, `${name} ${label}`);
      assert.equal(response.headers.etag, etag, `${name} ${label}`);
      // Nothing but the URL (which carries the capability) selects the content.
      assert.equal(response.headers.vary, undefined, `${name} ${label}`);
      if (status === 304) {
        assert.equal(response.body.length, 0);
        assert.equal(response.headers['content-length'], undefined);
      }
    }
    assert.deepEqual(responses.full[1].body, f.bodies[name]);
    assert.deepEqual(responses.tail[1].body, f.bodies[name].subarray(-1));
  }
});

test('a cookie does not change a capability URL response', async (t) => {
  const f = await fixture(t);
  const [plain, withCookie] = [await f.request(f.url('model.glb')), await f.request(f.url('model.glb'), { 'x-test-cookie': 'other', origin: 'https://elsewhere.test' })];
  for (const response of [plain, withCookie]) delete response.headers.date;
  assert.deepEqual(withCookie, plain);
  const refused = await f.request(f.url('model.glb', 'A'.repeat(43)), { 'x-test-cookie': f.token });
  assert.deepEqual([refused.status, refused.headers['cache-control']], [403, NO_STORE]);
});

test('everything else stays no-store', async (t) => {
  const f = await fixture(t);
  for (const [name, rel] of Object.entries(NEVER)) {
    for (const headers of [{}, { range: 'bytes=0-0' }, { 'if-modified-since': new Date(Date.now() + 60_000).toUTCString() }]) {
      const response = await f.request(f.url(rel), headers);
      assert.ok([200, 206, 304].includes(response.status), `${name} ${response.status}`);
      assert.equal(response.headers['cache-control'], NO_STORE, name);
      assert.ok(!String(response.headers.etag).includes('sha256'), name);
    }
  }
  // The cookie route, photos and downloads are not part of the approval.
  const cookie = await f.request(`/assets/${f.modelId}/models/task/model.glb`, { 'x-test-cookie': f.token });
  assert.deepEqual([cookie.status, cookie.headers['cache-control']], [200, NO_STORE]);
  const photo = await f.request(`/session-camera-photos/${f.token}/${f.modelId}/photo.jpg`);
  assert.deepEqual([photo.status, photo.headers['cache-control']], [200, NO_STORE]);
  const grant = JSON.parse((await f.request(`/session-products/${f.token}/${f.modelId}/glb/download-grants`, {}, 'POST')).body);
  const download = await f.request(grant.url);
  assert.deepEqual([download.status, download.headers['cache-control']], [200, NO_STORE]);
  assert.match(download.headers.etag, /^W\//);
  // An asset with no registered hash is served unverified, so never kept.
  f.database.prepare("UPDATE model_assets SET sha256=NULL WHERE kind='dtm'").run();
  const unhashed = await f.request(f.url('dtm.tif'));
  assert.deepEqual([unhashed.status, unhashed.headers['cache-control']], [200, NO_STORE]);
});

test('errors and denials on a cacheable asset are never cacheable', async (t) => {
  const f = await fixture(t);
  const etag = `"sha256-${sha256(f.bodies.glb)}"`;
  const denied = async (label, status, url, headers, method) => {
    const response = await f.request(url, headers, method);
    assert.equal(response.status, status, label);
    assert.equal(response.headers['cache-control'], NO_STORE, label);
    return response;
  };
  const glb = f.url('model.glb');
  await denied('412', 412, glb, { 'if-match': '"other"' });
  await denied('416', 416, glb, { range: 'bytes=999999-' });
  await denied('unknown token', 403, f.url('model.glb', 'A'.repeat(43)));
  await denied('forged token', 403, f.url('model.glb', 'a.b'));
  await denied('unknown file', 404, f.url('other.glb'));
  await denied('unknown tile', 404, f.url('tiles/0/none.b3dm'));
  await denied('other model', 403, glb.replace(f.modelId, 'other-model'));
  // Busy before the headers, and busy while taking the first region.
  f.integrity.maxQueuedStreams = 0;
  await f.integrity.reserve(f.integrity.bufferedBudgetBytes);
  const busy = await denied('503', 503, glb);
  f.integrity.unreserve(f.integrity.bufferedBudgetBytes);
  assert.equal(busy.headers['retry-after'], '1');
  const { verifiedSlice } = f.integrity;
  f.integrity.verifiedSlice = async () => { throw Object.assign(new Error('busy'), { code: 'integrity_busy' }); };
  const late = await denied('503 after the headers were prepared', 503, glb);
  assert.ok(!String(late.headers.etag).includes('sha256'));
  delete f.integrity.verifiedSlice;
  assert.equal(f.integrity.verifiedSlice, verifiedSlice);
  // Tampered, truncated and missing files.
  fs.writeFileSync(f.files.glb, Buffer.alloc(5000, 1));
  await denied('tampered', 404, glb);
  await denied('tampered range', 404, glb, { range: 'bytes=0-9' });
  fs.writeFileSync(f.files.glb, 'short');
  await denied('wrong size', 404, glb, { 'if-none-match': etag });
  fs.rmSync(f.files.glb);
  await denied('missing', 404, glb, { 'if-none-match': etag });
  fs.writeFileSync(f.files.glb, f.bodies.glb);
  fullTime(await f.request(glb), 'and it serves again');
  f.repository.rateLimited = () => true;
  await denied('429', 429, glb);
  delete f.repository.rateLimited;
  // Revocation: nothing new is served, and a revalidation is refused.
  f.database.prepare('UPDATE viewer_sessions SET revoked_at=? WHERE id=?').run(new Date().toISOString(), f.session.id);
  await denied('revoked', 403, glb);
  await denied('revoked 304', 403, glb, { 'if-none-match': etag });
  await denied('revoked HEAD', 403, glb, {}, 'HEAD');
  await denied('revoked range', 403, glb, { range: 'bytes=0-9', 'if-range': etag });
});

test('a kept copy never outlives the session, share or grant', async (t) => {
  const f = await fixture(t);
  const inSeconds = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
  const within = (response, seconds, label) => {
    const age = maxAge(response);
    assert.ok(age <= seconds && age >= seconds - 5, `${label}: ${response.status} ${response.headers['cache-control']}`);
  };
  const etag = `"sha256-${sha256(f.bodies.glb)}"`;
  const expire = (at) => f.database.prepare('UPDATE viewer_sessions SET expires_at=? WHERE id=?').run(at, f.session.id);
  expire(inSeconds(3000)); fullTime(await f.request(f.url('model.glb')), 'session');
  expire(inSeconds(40)); within(await f.request(f.url('model.glb')), 40, 'session');
  within(await f.request(f.url('model.glb'), { range: 'bytes=0-1' }), 40, 'session, range');
  within(await f.request(f.url('model.glb'), { 'if-none-match': etag }), 40, 'session, 304');
  expire(inSeconds(0.9));
  const last = await f.request(f.url('model.glb'));
  assert.equal(last.headers['cache-control'], NO_STORE, 'less than a second left');
  // The time left is measured when the headers are sent, not when checked.
  expire(inSeconds(30));
  const { verifyWholeFile } = f.integrity;
  f.integrity.verifyWholeFile = async (...args) => { await new Promise((resolve) => setTimeout(resolve, 2100)); return verifyWholeFile.apply(f.integrity, args); };
  assert.ok(maxAge(await f.request(f.url('model.glb'))) <= 27);
  delete f.integrity.verifyWholeFile;

  // Public and client shares: token, share or source grant, whichever ends first.
  const share = { id: 'share', modelId: f.modelId, versionPolicy: 'active', authorizationRevision: 0, allowedViews: null, permissions: {}, expiresAt: null, shareClass: 'staff', sourceAuthorization: null };
  f.repository.getPublicShare = () => share;
  const shareUrl = (seconds) => f.url('model.glb', auth.sign({ kind: 'share-asset', shareId: 'share', shareRevision: 0, modelId: f.modelId }, seconds * 1000));
  fullTime(await f.request(shareUrl(3600)), 'share');
  within(await f.request(shareUrl(50)), 50, 'share token');
  share.expiresAt = inSeconds(60); within(await f.request(shareUrl(3600)), 60, 'share expiry');
  Object.assign(share, { expiresAt: inSeconds(90), shareClass: 'client', sourceAuthorization: { type: 'client_grant', id: 'g', version: 1, subject: 's', expiresAt: inSeconds(20) } });
  within(await f.request(shareUrl(3600)), 20, 'source grant expiry');
  share.sourceAuthorization.expiresAt = null; within(await f.request(shareUrl(3600)), 90, 'open-ended source grant');
  share.sourceAuthorization.expiresAt = 'not a date';
  assert.equal((await f.request(shareUrl(3600))).headers['cache-control'], NO_STORE, 'an unreadable expiry is never cacheable');
  share.sourceAuthorization.expiresAt = null; share.revokedAt = inSeconds(-1);
  const revoked = await f.request(shareUrl(3600), { 'if-none-match': etag });
  assert.deepEqual([revoked.status, revoked.headers['cache-control']], [403, NO_STORE]);

  // Project shares.
  const projectShare = { id: 'ps', projectId: 'p', permissions: {}, expiresAt: inSeconds(70), revokedAt: null };
  f.repository.getProjectShare = () => projectShare;
  assets.setProcessingRepository({ getActivePublishedProjectTask: () => ({ modelId: f.modelId, modelVersionId: f.versionId }) });
  const projectUrl = (seconds) => f.url('model.glb', auth.sign({ kind: 'project-share-asset', shareId: 'ps', projectId: 'p', taskId: 't', modelId: f.modelId, modelVersionId: f.versionId }, seconds * 1000));
  within(await f.request(projectUrl(3600)), 70, 'project share expiry');
  within(await f.request(projectUrl(25)), 25, 'project share token');
  projectShare.revokedAt = inSeconds(-1);
  const revokedProject = await f.request(projectUrl(3600), { 'if-none-match': etag });
  assert.deepEqual([revokedProject.status, revokedProject.headers['cache-control']], [403, NO_STORE]);
});

test('access removed while a file is being checked is refused and not cacheable', async (t) => {
  const f = await fixture(t);
  const share = { id: 'share', modelId: f.modelId, versionPolicy: 'active', authorizationRevision: 0, allowedViews: null, permissions: {}, expiresAt: null, shareClass: 'staff' };
  f.repository.getPublicShare = () => ({ ...share });
  const { verifyWholeFile } = f.integrity;
  f.integrity.verifyWholeFile = async (...args) => { share.revokedAt = new Date().toISOString(); return verifyWholeFile.apply(f.integrity, args); };
  t.after(() => { delete f.integrity.verifyWholeFile; });
  const response = await f.request(f.url('model.glb', auth.sign({ kind: 'share-asset', shareId: 'share', shareRevision: 0, modelId: f.modelId }, 60_000)));
  assert.deepEqual([response.status, response.headers['cache-control']], [403, NO_STORE]);
  assert.ok(!String(response.headers.etag).includes('sha256'));
});

test('If-Range needs the exact strong ETag, and replaced content gets a new one', async (t) => {
  const f = await fixture(t);
  const etag = `"sha256-${sha256(f.bodies.ortho)}"`;
  const ranged = async (ifRange) => { const { status, body } = await f.request(f.url('ortho.tif'), { range: 'bytes=10-19', 'if-range': ifRange }); return [status, body.length]; };
  assert.deepEqual(await ranged(etag), [206, 10]);
  for (const other of [`W/${etag}`, `"sha256-${'0'.repeat(64)}"`, `${etag}, "x"`, '"x"', 'Thu, 01 Jan 1970 00:00:00 GMT']) {
    assert.deepEqual(await ranged(other), [200, f.bodies.ortho.length], other);
  }
  const replacement = crypto.randomBytes(f.bodies.glb.length);
  fs.writeFileSync(f.files.glb, replacement);
  f.register(f.list.map((asset) => (asset.kind === 'glb' ? { ...asset, sha256: sha256(replacement) } : asset)));
  const before = `"sha256-${sha256(f.bodies.glb)}"`;
  const response = await f.request(f.url('model.glb'), { 'if-none-match': before });
  assert.equal(response.status, 200);
  assert.equal(response.headers.etag, `"sha256-${sha256(replacement)}"`);
  assert.deepEqual(response.body, replacement);
  const resumed = await f.request(f.url('model.glb'), { range: 'bytes=10-', 'if-range': before });
  assert.deepEqual([resumed.status, resumed.body.equals(replacement)], [200, true], 'never mixes old and new bytes');
});

test('the 5 minutes start at the authorization decision, not at the response', async (t) => {
  const f = await fixture(t);
  const { verifyWholeFile } = f.integrity;
  t.after(() => { delete f.integrity.verifyWholeFile; });
  const during = (action) => { f.integrity.verifyWholeFile = async (...args) => { await action(); return verifyWholeFile.apply(f.integrity, args); }; };
  const slow = () => new Promise((resolve) => setTimeout(resolve, 3100));
  during(slow);
  // Viewer session, public share and project share: none is extended by a slow check.
  f.repository.getPublicShare = () => ({ id: 'share', modelId: f.modelId, versionPolicy: 'active', authorizationRevision: 0, allowedViews: null, permissions: {}, expiresAt: null, shareClass: 'staff' });
  f.repository.getProjectShare = () => ({ id: 'ps', projectId: 'p', permissions: {}, expiresAt: null, revokedAt: null });
  assets.setProcessingRepository({ getActivePublishedProjectTask: () => ({ modelId: f.modelId, modelVersionId: f.versionId }) });
  const urls = {
    session: f.url('model.glb'),
    share: f.url('model.glb', auth.sign({ kind: 'share-asset', shareId: 'share', shareRevision: 0, modelId: f.modelId }, 3_600_000)),
    'project share': f.url('model.glb', auth.sign({ kind: 'project-share-asset', shareId: 'ps', projectId: 'p', taskId: 't', modelId: f.modelId, modelVersionId: f.versionId }, 3_600_000)),
  };
  const responses = await Promise.all(Object.entries(urls).map(async ([name, url]) => [name, await f.request(url)]));
  for (const [name, response] of responses) {
    assert.equal(response.status, 200, name);
    assert.ok(maxAge(response) <= 296, `${name}: ${response.headers['cache-control']}`);
    assert.ok(maxAge(response) >= 290, `${name}: ${response.headers['cache-control']}`);
  }
  // A wall clock set back during the check lengthens neither limit.
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  during(async () => { await slow(); Date.now = () => realNow() - 120_000; });
  assert.ok(maxAge(await f.request(urls.session)) <= 296);
  Date.now = realNow;
  f.database.prepare('UPDATE viewer_sessions SET expires_at=? WHERE id=?').run(new Date(realNow() + 20_000).toISOString(), f.session.id);
  during(async () => { await slow(); Date.now = () => realNow() - 120_000; });
  assert.ok(maxAge(await f.request(urls.session)) <= 16);
  Date.now = realNow;
  // A check longer than the whole window (seen as a jump of the wall clock).
  f.database.prepare('UPDATE viewer_sessions SET expires_at=? WHERE id=?').run(new Date(realNow() + 3_600_000).toISOString(), f.session.id);
  during(() => { Date.now = () => realNow() + 301_000; });
  assert.equal((await f.request(urls.session)).headers['cache-control'], NO_STORE);
  Date.now = realNow;
});

test('an already known source decision shortens the copy by its greatest possible age', async (t) => {
  const f = await fixture(t);
  const source = { type: 'client_grant', id: 'grant', version: 1, subject: 'client', expiresAt: null };
  f.repository.getPublicShare = () => ({ id: 'share', modelId: f.modelId, versionPolicy: 'active', authorizationRevision: 0, allowedViews: null, permissions: {}, expiresAt: null, shareClass: 'client', sourceAuthorization: source });
  let active = true, decisions = 0, decidedAt = 0;
  const validator = new SourceAuthorizationValidator({ enabled: true, baseUrl: 'https://ops.test', keyId: 'key', secret: 's'.repeat(32),
    fetchImpl: async () => { decisions += 1; decidedAt = performance.now(); return Response.json({ active, authorizationId: source.id, authorizationVersion: 1, subject: source.subject, modelId: f.modelId, expiresAt: null }); } });
  assert.ok(validator.positiveMs <= 5000 && validator.timeoutMs <= 5000, 'the age limit assets.js relies on');
  const limits = new SourceAuthorizationValidator({ positiveMs: 600_000, timeoutMs: 600_000 });
  assert.deepEqual([limits.positiveMs, limits.timeoutMs], [5000, 5000], 'and no setting can raise it');
  assets.setSourceAuthorizationValidator(validator);
  const url = f.url('model.glb', auth.sign({ kind: 'share-asset', shareId: 'share', shareRevision: 0, modelId: f.modelId }, 3_600_000));
  const first = await f.request(url);
  assert.equal(first.status, 200);
  assert.ok(maxAge(first) <= 295 && maxAge(first) >= 285, first.headers['cache-control']);
  active = false; // access is removed in Operations right after its decision
  await new Promise((resolve) => setTimeout(resolve, 2500)); // still within every refresh time
  for (const headers of [{}, { range: 'bytes=0-9' }, { 'if-none-match': `"sha256-${sha256(f.bodies.glb)}"` }]) {
    const stale = await f.request(url, headers);
    assert.equal(decisions, 1, 'served on the known decision');
    const sinceDecision = (performance.now() - decidedAt) / 1000;
    assert.ok(sinceDecision >= 2.4, 'the decision is old');
    assert.ok(sinceDecision + maxAge(stale) <= 300, `${sinceDecision.toFixed(1)} s old + ${stale.headers['cache-control']}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 2800));
  const refused = await f.request(url, { 'if-none-match': `"sha256-${sha256(f.bodies.glb)}"` });
  assert.deepEqual([refused.status, refused.headers['cache-control'], decisions], [403, NO_STORE, 2]);
});

// A client share behind the real validator; `ops` answers for Operations.
function clientShare(f, ops) {
  const source = { type: 'client_grant', id: 'grant', version: 1, subject: 'client', expiresAt: null };
  f.repository.getPublicShare = () => ({ id: 'share', modelId: f.modelId, versionPolicy: 'active', authorizationRevision: 0, allowedViews: null, permissions: {}, expiresAt: null, shareClass: 'client', sourceAuthorization: source });
  const state = { active: true, decisions: 0, decidedAt: 0 };
  assets.setSourceAuthorizationValidator(new SourceAuthorizationValidator({ enabled: true, baseUrl: 'https://ops.test', keyId: 'key', secret: 's'.repeat(32),
    fetchImpl: async () => {
      const active = state.active; // what Operations decided, when it was asked
      state.decisions += 1;
      state.decidedAt = performance.now();
      await ops?.(state);
      return Response.json({ active, authorizationId: source.id, authorizationVersion: 1, subject: source.subject, modelId: f.modelId, expiresAt: null });
    } }));
  state.url = f.url('model.glb', auth.sign({ kind: 'share-asset', shareId: 'share', shareRevision: 0, modelId: f.modelId }, 3_600_000));
  return state;
}
// The copy must end within 300 s (real time) of the decision that allowed it.
function endsInTime(response, state, label) {
  const age = (performance.now() - state.decidedAt) / 1000;
  assert.ok([200, 206, 304].includes(response.status), `${label}: ${response.status}`);
  assert.ok(age + (Number.isNaN(maxAge(response)) ? 0 : maxAge(response)) <= 300, `${label}: ${age.toFixed(1)} s old, ${response.headers['cache-control']}`);
}

test('client shares: a wall clock set back or forward never lengthens the window', async (t) => {
  const realNow = Date.now;
  t.after(() => { Date.now = realNow; });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const shifted = (ms) => { Date.now = () => realNow() + ms; };
  const f = await fixture(t);
  const revalidate = { 'if-none-match': `"sha256-${sha256(f.bodies.glb)}"` };

  // Set back after the decision: a kept allow still ends 5 s after it was made.
  let state = clientShare(f);
  endsInTime(await f.request(state.url), state, 'first');
  state.active = false; // access removed in Operations
  shifted(-120_000);
  await wait(2000);
  for (const headers of [{}, { range: 'bytes=0-9' }, revalidate]) endsInTime(await f.request(state.url, headers), state, 'known decision, clock set back');
  assert.equal(state.decisions, 1);
  await wait(3300);
  let refused = await f.request(state.url, revalidate);
  assert.deepEqual([refused.status, refused.headers['cache-control']], [403, NO_STORE], 'not extended by 120 s');
  assert.equal(state.decisions, 2);
  Date.now = realNow;

  // Set back while Operations is being asked, and while the file is checked.
  state = clientShare(f, async () => { await wait(1500); shifted(-120_000); });
  endsInTime(await f.request(state.url), state, 'clock set back during the decision');
  state.active = false;
  await wait(3800);
  refused = await f.request(state.url, revalidate);
  assert.deepEqual([refused.status, refused.headers['cache-control']], [403, NO_STORE]);
  Date.now = realNow;
  const { verifyWholeFile } = f.integrity;
  state = clientShare(f);
  f.integrity.verifyWholeFile = async (...args) => { await wait(2100); shifted(-120_000); return verifyWholeFile.apply(f.integrity, args); };
  endsInTime(await f.request(state.url), state, 'clock set back during the file check');
  delete f.integrity.verifyWholeFile;
  Date.now = realNow;

  // Set forward: the decision is over at once and Operations is asked again.
  state = clientShare(f);
  endsInTime(await f.request(state.url), state, 'before the jump');
  state.active = false;
  shifted(6000);
  refused = await f.request(state.url, revalidate);
  assert.deepEqual([refused.status, refused.headers['cache-control'], state.decisions], [403, NO_STORE, 2]);
});

test('client shares: requests that join a running decision get its age, not their own', async (t) => {
  const f = await fixture(t);
  const state = clientShare(f, () => new Promise((resolve) => setTimeout(resolve, 2500)));
  const first = f.request(state.url);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  state.active = false; // removed after Operations decided
  for (const response of await Promise.all([first, f.request(state.url), f.request(state.url, { range: 'bytes=0-9' })])) endsInTime(response, state, 'joined');
  assert.equal(state.decisions, 1);
});

test('a failure in the integrity setup of a tree child closes the file and is not cacheable', async (t) => {
  const f = await fixture(t);
  const handles = [];
  const { open } = fs.promises;
  t.mock.method(fs.promises, 'open', async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  let lookups = 0;
  f.repository.getModelAssetFile = () => { lookups += 1; throw new Error('database failed'); };
  for (const rel of ['tiles/0/tile.b3dm', 'tiles/tileset.json', 'ept/ept-data/0-0-0-0.laz']) {
    for (const [label, options] of Object.entries({ GET: [], range: [{ range: 'bytes=0-9' }], HEAD: [{}, 'HEAD'], conditional: [{ 'if-none-match': '"x"' }] })) {
      handles.length = 0;
      lookups = 0;
      const response = await f.request(f.url(rel), ...options);
      assert.equal(response.status, 500, `${rel} ${label}`);
      assert.ok(!String(response.headers['cache-control']).includes('max-age'), `${rel} ${label}`);
      assert.deepEqual([lookups, handles.length], [1, 1], `${rel} ${label}: it failed with the file open`);
      assert.equal(handles[0].fd, -1, `${rel} ${label}: the descriptor is closed before the error is sent`);
    }
  }
  delete f.repository.getModelAssetFile;
  fullTime(await f.request(f.url('tiles/0/tile.b3dm')), 'and it serves again');
});

test('a failure while the strong ETag is looked up closes the file and is not cacheable', async (t) => {
  const f = await fixture(t);
  const handles = [];
  const { open } = fs.promises;
  t.mock.method(fs.promises, 'open', async (...args) => { const handle = await open(...args); handles.push(handle); return handle; });
  const { getModelAssetChunks } = f.repository;
  for (const [label, options] of Object.entries({ GET: [], range: [{ range: 'bytes=0-9' }], HEAD: [{}, 'HEAD'], conditional: [{ 'if-none-match': '"x"' }] })) {
    let calls = 0;
    f.repository.getModelAssetChunks = (...args) => { calls += 1; if (calls === 1) throw new Error('database failed'); return getModelAssetChunks.apply(f.repository, args); };
    handles.length = 0;
    const response = await f.request(f.url('ortho.tif'), ...options);
    assert.equal(response.status, 500, label);
    assert.ok(!String(response.headers['cache-control']).includes('max-age'), label);
    assert.ok(!String(response.headers.etag).includes('sha256'), label);
    assert.equal(calls, 1, `${label}: the ETag lookup failed`);
    assert.equal(handles.length, 1, label);
    for (let i = 0; i < 100 && handles[0].fd !== -1; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(handles[0].fd, -1, `${label}: the descriptor is closed`);
  }
  delete f.repository.getModelAssetChunks;
  fullTime(await f.request(f.url('ortho.tif')), 'and it serves again');
});

test('If-Match compares strongly: a weak tag never matches the strong one', async (t) => {
  const f = await fixture(t);
  const etag = `"sha256-${sha256(f.bodies.glb)}"`;
  const status = async (ifMatch, method) => { const response = await f.request(f.url('model.glb'), { 'if-match': ifMatch }, method); if (response.status === 412) assert.equal(response.headers['cache-control'], NO_STORE); return response.status; };
  for (const method of ['GET', 'HEAD']) {
    for (const matching of [etag, '*', `"other", ${etag}`, `W/"other", ${etag}`]) assert.equal(await status(matching, method), 200, `${method} ${matching}`);
    for (const other of [`W/${etag}`, `"other", W/${etag}`, '"other"', 'W/"other"', etag.slice(1, -1)]) assert.equal(await status(other, method), 412, `${method} ${other}`);
  }
  // Files without a strong tag keep send's comparison.
  const legacy = (await f.request(f.url('dsm.tif'), {}, 'HEAD')).headers.etag;
  assert.match(legacy, /^W\//);
  assert.equal((await f.request(f.url('dsm.tif'), { 'if-match': legacy }, 'HEAD')).status, 200);
  assert.equal((await f.request(f.url('dsm.tif'), { 'if-match': etag }, 'HEAD')).status, 412);
});
