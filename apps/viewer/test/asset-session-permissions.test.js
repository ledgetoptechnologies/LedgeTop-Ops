'use strict';

// A Viewer session's permissions hold on every asset route, and again right before bytes leave. Synthetic data only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { createAssetRateLimiter } = require('../server/assetRateLimiter');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SHOTS = '{"type":"FeatureCollection","features":[]}', MESH = 'mesh', PHOTO = 'photo';
const FULL = { view: true, measure: true, cameras: true, download: false };

async function fixture(t, { accelerated = false, permissions = FULL } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-asset-permission-'));
  for (const [name, body] of [['model.glb', MESH], ['shots.geojson', SHOTS], ['photo.jpg', PHOTO]]) fs.writeFileSync(path.join(root, name), body);
  const database = openDatabase(path.join(root, 'viewer.sqlite')), repository = new ViewerRepository(database);
  const before = [config.xAccelRedirectPrefix, config.modelsMount];
  config.modelsMount = root;
  config.xAccelRedirectPrefix = accelerated ? '/protected' : '';
  const version = (modelId, versionId) => repository.upsertModelVersion({ modelId, versionId, provider: 'webodm', providerModelId: modelId, providerVersionId: versionId, displayName: modelId, status: 'ready',
    sourceLocator: {}, assets: [['glb', 'model.glb', MESH], ['shots', 'shots.geojson', SHOTS]].map(([kind, relativePath, body]) => ({ kind, rootKey: 'models', relativePath, byteSize: body.length, sha256: sha(body), published: true })) });
  version('model', 'version'); version('other', 'other-version');
  repository.replaceCameraPhotos?.('version', [{ filename: 'photo.jpg', rootKey: 'models', relativePath: 'photo.jpg', byteSize: PHOTO.length, sha256: sha(PHOTO), contentType: 'image/jpeg' }]);
  const session = (token, input = {}) => repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId: 'model', modelVersionId: 'version', subject: 's', audience: 'ops', permissions, expiresAt: new Date(Date.now() + 60_000).toISOString(), ...input });
  const admitted = session('session');
  assets.setRepository(repository); assets.assetIntegrityCache.clear();
  const app = express();
  app.use((req, _res, next) => { req.cookies = Object.fromEntries([['x-viewer', 'ltds_viewer'], ['x-share', 'ltds_share']].filter(([header]) => req.get(header)).map(([header, cookie]) => [cookie, req.get(header)])); next(); });
  app.use(assets);
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  // Something changes while this response's bytes are being checked.
  const cache = assets.assetIntegrityCache, whole = cache.verifyWholeFile;
  const during = change => { cache.verifyWholeFile = async function (...args) { const result = await whole.apply(this, args); if (change) { const run = change; change = null; run(); } return result; }; };
  t.after(async () => {
    cache.verifyWholeFile = whole; cache.clear();
    await new Promise(resolve => server.close(resolve));
    assets.setRepository(null); assets.setAssetRateLimiter(createAssetRateLimiter());
    [config.xAccelRedirectPrefix, config.modelsMount] = before;
    database.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async (url, { cookie = false, headers = {}, method = 'GET' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { ...(cookie ? { 'x-viewer': 'session' } : {}), ...headers } });
    return { status: response.status, body: await response.text(), accel: response.headers.get('x-accel-redirect') };
  };
  return { database, repository, admitted, session, version, during, get };
}
const reduce = (state, change) => state.repository.renewViewerSession(state.admitted.id, { permissions: { ...FULL, ...change }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
const ROUTES = [['cookie', file => `/assets/model/models/${file}`, { cookie: true }], ['path token', file => `/session-assets/session/model/models/${file}`, {}]];
const WAYS = [['GET', {}, 200], ['HEAD', { method: 'HEAD' }, 200], ['Range', { headers: { Range: 'bytes=0-1' } }, 206]];

for (const [route, url, options] of ROUTES) {
  test(`${route}: camera positions need the cameras permission, whatever the method`, async t => {
    const off = await fixture(t, { permissions: { ...FULL, cameras: false } });
    for (const [way, extra, status] of WAYS) {
      const request = { ...options, ...extra };
      const shots = await off.get(url('shots.geojson'), request);
      assert.equal(shots.status, 403, way); assert.equal(shots.body.includes('FeatureCollection'), false);
      assert.equal((await off.get(url('model.glb'), request)).status, status, way);
    }
    reduce(off, { cameras: true });
    for (const [way, extra, status] of WAYS) assert.equal((await off.get(url('shots.geojson'), { ...options, ...extra })).status, status, way);
  });

  test(`${route}: accelerated delivery applies the same rule`, async t => {
    const state = await fixture(t, { accelerated: true, permissions: { ...FULL, cameras: false } });
    const refused = await state.get(url('shots.geojson'), options); assert.equal(refused.status, 403); assert.equal(refused.accel, null);
    assert.equal((await state.get(url('model.glb'), options)).accel, '/protected/models/model.glb');
  });
}

// The same session may stay live with less than it was admitted with.
const LATE = [['cameras reduced', state => reduce(state, { cameras: false }), 'shots only'], ['view withdrawn', state => reduce(state, { view: false }), 'all'],
  ['session revoked', state => state.repository.revokeViewerSession(state.admitted.id), 'all'], ['a newer version published', state => state.version('model', 'version-two'), 'all']];
const PLACES = [...ROUTES.flatMap(([route, url, options]) => [[`${route} shots`, url('shots.geojson'), options, true], [`${route} mesh`, url('model.glb'), options, false]]),
  ['camera photo', '/session-camera-photos/session/model/photo.jpg', {}, true]];
for (const accelerated of [false, true]) for (const [place, url, options, isCameras] of PLACES)
  test(`${place}${accelerated ? ' (accelerated)' : ''}: a change during the integrity check decides, and another authority is not asked`, async t => {
    for (const [way, extra, status] of WAYS) {
      const plain = await fixture(t, { accelerated });
      assert.equal((await plain.get(url, { ...options, ...extra })).status, accelerated ? 200 : status, way);
      for (const [label, change, reach] of LATE) {
        const state = await fixture(t, { accelerated });
        // Another live session and another cookie on the request could have admitted it, but did not.
        state.session('second');
        let changed = false; state.during(() => { changed = true; change(state); });
        const result = await state.get(url, { ...options, ...extra, ...(options.cookie ? {} : { headers: { ...extra.headers, 'x-viewer': 'second' } }) });
        assert.equal(changed, true, `${label} ${way}`);
        if (reach === 'all' || isCameras) {
          assert.equal(result.status, 403, `${label} ${way}`); assert.equal(result.accel, null); assert.doesNotMatch(result.body, /mesh|photo|FeatureCollection/);
        } else assert.equal(result.status, accelerated ? 200 : status, `${label} ${way}`);
      }
    }
  });

test('a session for one model opens nothing of another, and staff and share links are as before', async t => {
  const state = await fixture(t);
  for (const url of ['/assets/other/models/model.glb', '/session-assets/session/other/models/model.glb']) assert.equal((await state.get(url, { cookie: url.startsWith('/assets') })).status, 403);
  const share = permissions => { const id = crypto.randomUUID();
    const created = state.repository.createPublicShare({ id, modelId: 'other', modelVersionId: 'other-version', permissions, publicIdHash: sha(id), expiresAt: new Date(Date.now() + 60_000).toISOString() });
    return auth.sign({ shareId: created.id, modelId: 'other', shareRevision: created.authorizationRevision }, 60_000); };
  for (const [permissions, shots] of [[FULL, 200], [{ ...FULL, cameras: false }, 403]]) {
    // A Viewer cookie for another model does not stand in the way of the link, and does not lend it anything.
    const headers = { 'x-share': share(permissions) };
    assert.equal((await state.get('/assets/other/models/model.glb', { cookie: true, headers })).status, 200);
    assert.equal((await state.get('/assets/other/models/shots.geojson', { cookie: true, headers })).status, shots);
  }
  // Nor does a link lend its cameras to a session that has none.
  reduce(state, { cameras: false });
  const own = crypto.randomUUID(), link = state.repository.createPublicShare({ id: own, modelId: 'model', modelVersionId: 'version', permissions: FULL, publicIdHash: sha(own), expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal((await state.get('/assets/model/models/shots.geojson', { cookie: true, headers: { 'x-share': auth.sign({ shareId: link.id, modelId: 'model', shareRevision: link.authorizationRevision }, 60_000) } })).status, 403);
});
