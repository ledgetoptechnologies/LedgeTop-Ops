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
const { hooks } = require('../server/verifiedDelivery');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const SHOTS = '{"type":"FeatureCollection","features":[]}', MESH = 'mesh', PHOTO = 'photo', BIG = 'bigbig'.repeat(40_000);
const FULL = { view: true, measure: true, cameras: true, download: false };

async function fixture(t, { accelerated = false, permissions = FULL, big = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-asset-permission-'));
  for (const [name, body] of [['model.glb', MESH], ['shots.geojson', SHOTS], ['photo.jpg', PHOTO], ...(big ? [['big.bin', BIG]] : [])]) fs.writeFileSync(path.join(root, name), body);
  const database = openDatabase(path.join(root, 'viewer.sqlite')), repository = new ViewerRepository(database);
  const before = [config.xAccelRedirectPrefix, config.modelsMount];
  config.modelsMount = root;
  config.xAccelRedirectPrefix = accelerated ? '/protected' : '';
  const version = (modelId, versionId) => repository.upsertModelVersion({ modelId, versionId, provider: 'webodm', providerModelId: modelId, providerVersionId: versionId, displayName: modelId, status: 'ready',
    sourceLocator: {}, assets: [['glb', 'model.glb', MESH], ['shots', 'shots.geojson', SHOTS], ...(big ? [['dsm', 'big.bin', BIG]] : [])].map(([kind, relativePath, body]) => ({ kind, rootKey: 'models', relativePath, byteSize: body.length, sha256: sha(body), published: true })) });
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
  // After the check of a delivered file (also when nothing is hashed, as for HEAD), or of an accelerated one.
  const during = change => {
    const land = () => { if (change) { const run = change; change = null; run(); } };
    hooks.afterVerify = land;
    if (accelerated) cache.verifyWholeFile = async function (...args) { const result = await whole.apply(this, args); land(); return result; };
  };
  t.after(async () => {
    cache.verifyWholeFile = whole; hooks.afterVerify = null; cache.clear();
    await new Promise(resolve => server.close(resolve));
    assets.setRepository(null); assets.setAssetRateLimiter(createAssetRateLimiter());
    [config.xAccelRedirectPrefix, config.modelsMount] = before;
    database.close(); fs.rmSync(root, { recursive: true, force: true });
  });
  const get = async (url, { cookie = false, headers = {}, method = 'GET' } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { method, headers: { ...(cookie ? { 'x-viewer': 'session' } : {}), ...headers } });
    return { status: response.status, body: await response.text(), accel: response.headers.get('x-accel-redirect'), headers: response.headers };
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

// After the check passes the body still waits for its first bytes. What changes in that wait decides too.
for (const [label, url, name, arm] of [
  ['registered bytes, waiting for the first slice', '/assets/model/models/model.glb', 'model.glb', 'slice'],
  ['camera photo, waiting for its slice', '/session-camera-photos/session/model/photo.jpg', 'photo.jpg', 'slice'],
  ['streamed file, waiting for the first read', '/session-assets/session/model/models/big.bin', 'big.bin', 'read'],
  ['small streamed file, waiting for its only read', '/session-assets/session/model/models/model.glb', 'model.glb', 'read'],
  ['small streamed file, waiting for the closing identity check', '/session-assets/session/model/models/model.glb', 'model.glb', 'stat'],
]) test(`first write: ${label}`, async t => {
  const cache = assets.assetIntegrityCache, delivery = require('../server/verifiedDelivery'), real = { slice: cache.verifiedSlice, buffer: cache.canBuffer };
  const opened = await fs.promises.open(__filename, 'r'), proto = Object.getPrototypeOf(opened), io = { read: proto.read, stat: proto.stat }; await opened.close();
  let armed = null, reads = 0;
  const land = () => { const change = armed; armed = null; change?.(); };
  t.after(() => { cache.verifiedSlice = real.slice; cache.canBuffer = real.buffer; Object.assign(proto, io); delivery.hooks.afterVerify = null; });
  if (arm !== 'slice') cache.canBuffer = () => false;
  cache.verifiedSlice = async function (...args) { const value = await real.slice.apply(this, args); if (arm === 'slice') land(); return value; };
  proto.read = async function (...args) { const value = await io.read.apply(this, args); if (armed) { reads += 1; if (arm === 'read') land(); } return value; };
  proto.stat = async function (...args) { const value = await io.stat.apply(this, args); if (arm === 'stat' && armed && reads) land(); return value; };
  for (const [change, reach] of [[state => state.repository.revokeViewerSession(state.admitted.id), true], [state => reduce(state, { view: false }), true], [state => reduce(state, { cameras: false }), name === 'photo.jpg'], [() => {}, false]])
    for (const headers of [{}, { Range: 'bytes=0-1' }]) {
      const state = await fixture(t, { big: name === 'big.bin' });
      let landed = false; reads = 0;
      delivery.hooks.afterVerify = () => { armed = () => { landed = true; change(state); }; };
      const response = await state.get(url, { cookie: url.startsWith('/assets'), headers });
      assert.equal(landed, true, 'the change landed in the wait');
      assert.equal(response.status, reach ? 403 : headers.Range ? 206 : 200);
      if (reach) {
        assert.doesNotMatch(response.body, /mesh|photo|bigbig/);
        for (const header of ['content-range', 'last-modified']) assert.equal(response.headers.get(header), null, `no ${header} of the file`);
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(response.body));
      }
    }
});

// The decision and the first write are one step: a change queued while deciding lands after the bytes are on their way, and
// a change queued before is seen. Every gate of deliverVerified is measured against the response object itself.
for (const asynchronous of [false, true]) test(`the gate sends in the ${asynchronous ? 'continuation of a promised' : 'same turn as a synchronous'} answer, once`, async t => {
  const { deliverVerified, openForDelivery } = require('../server/verifiedDelivery');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gate-')), small = path.join(root, 'small.bin'), big = path.join(root, 'big.bin');
  fs.writeFileSync(small, MESH); fs.writeFileSync(big, BIG);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const region = body => [{ kind: 'file', offset: 0, size: body.length, sha256: sha(body), toEof: true }];
  const modified = new Date(Date.now() + 60_000).toUTCString(), past = new Date(0).toUTCString();
  const cases = [['registered', small, MESH, {}, 'GET', true, 200], ['registered range', small, MESH, { Range: 'bytes=0-1' }, 'GET', true, 206], ['small stream', small, MESH, {}, 'GET', false, 200],
    ['large stream', big, BIG, {}, 'GET', false, 200], ['HEAD', small, MESH, {}, 'HEAD', true, 200], ['304', small, MESH, { 'If-Modified-Since': modified, 'Cache-Control': 'max-age=0' }, 'GET', true, 304],
    ['412', small, MESH, { 'If-Unmodified-Since': past }, 'GET', true, 412], ['416', small, MESH, { Range: 'bytes=99-' }, 'GET', true, 416]];
  for (const allowed of [true, false, 'throws']) for (const [label, filePath, body, headers, method, registered, status] of cases) {
    const order = []; let asked = 0, released = 0;
    const cache = Object.create(assets.assetIntegrityCache);
    cache.verifiedSlice = async (...args) => { const piece = await assets.assetIntegrityCache.verifiedSlice(...args); return piece && { bytes: piece.bytes, release() { released += 1; piece.release(); } }; };
    const app = express();
    app.use(async (req, res) => {
      for (const name of ['write', 'end', 'status']) { const real = res[name]; res[name] = function (...args) { if (asked && !order.includes('sent')) order.push('sent'); return real.apply(this, args); }; }
      const answer = () => { asked += 1; queueMicrotask(() => order.push('queued change')); if (allowed === 'throws') throw new Error('authorizer failed'); if (!allowed) res.status(403).json({ error: 'not authorized' }); return allowed; };
      try {
        const opened = await openForDelivery(filePath);
        await deliverVerified(req, res, { ...opened, filePath, cache, headers: { 'X-File': 'yes' }, verify: async () => true, regions: registered ? () => region(body) : null,
          beforeSend: asynchronous ? async () => answer() : answer, onFailure: () => res.sendStatus(404), onError: error => res.status(error.status).end() });
      } catch (error) { order.push(error.message); res.status(500).end(); }
    });
    const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { method, headers }), text = await response.text();
    await new Promise(resolve => server.close(resolve));
    const name = `${label} ${allowed}`;
    assert.equal(asked, 1, name);
    assert.equal(response.status, allowed === 'throws' ? 500 : allowed ? status : 403, name);
    assert.equal(response.headers.get('x-file'), allowed === true ? 'yes' : null, name);
    if (allowed === true) {
      // A synchronous answer: the bytes are dispatched before anything queued runs. A promise settles first; its continuation sends.
      assert.deepEqual(order, asynchronous ? ['queued change', 'sent'] : ['sent', 'queued change'], name);
      if (status === 200 && method === 'GET') assert.equal(text, body);
    } else assert.doesNotMatch(text, /mesh|bigbig/, name);
    if (registered && method === 'GET' && status < 300) assert.equal(released, 1, `${name}: the buffered region is released`);
  }
});

test('a conditional request is decided when it is answered', async t => {
  for (const [route, url, options] of ROUTES) {
    const state = await fixture(t), first = await state.get(url('model.glb'), options), headers = { 'If-Modified-Since': first.headers.get('last-modified'), 'Cache-Control': 'max-age=0' };
    assert.equal((await state.get(url('model.glb'), { ...options, headers })).status, 304, route);
    state.during(() => state.repository.revokeViewerSession(state.admitted.id));
    const refused = await state.get(url('model.glb'), { ...options, headers });
    assert.equal(refused.status, 403, route); assert.equal(refused.headers.get('last-modified'), null);
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
