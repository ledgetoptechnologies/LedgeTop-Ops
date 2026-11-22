'use strict';
// Direct-client sessions are rechecked immediately before protected bytes are
// sent (after the awaited integrity check), on the asset and camera routes, for
// GET, HEAD and Range. A response that passed the final check is not interrupted.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const auth = require('../server/auth');
const assets = require('../server/assets');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');

const digest = value => crypto.createHash('sha256').update(value).digest('hex');

async function harness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-direct-final-check-'));
  const oldDatasetsMount = config.datasetsMount;
  config.datasetsMount = path.join(root, 'datasets');
  const datasetId = 'synthetic-task';
  const directory = path.join(config.datasetsMount, datasetId);
  fs.mkdirSync(path.join(directory, 'assets', 'odm_report'), { recursive: true });
  const photo = Buffer.from('synthetic-direct-camera-photo');
  const shots = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { filename: 'DJI_0001.JPG' }, geometry: { type: 'Point', coordinates: [-87, 44, 200] } }] }));
  fs.writeFileSync(path.join(directory, 'DJI_0001.JPG'), photo);
  fs.writeFileSync(path.join(directory, 'assets', 'odm_report', 'shots.geojson'), shots);
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const model = repository.upsertModelVersion({
    modelId: 'model-direct', versionId: 'version-direct', provider: 'webodm',
    providerModelId: 'task-import:direct', providerVersionId: 'direct', displayName: 'Synthetic model', status: 'ready',
    sourceLocator: { webodmTaskImport: true },
    assets: [{ kind: 'shots', rootKey: 'datasets', relativePath: `${datasetId}/assets/odm_report/shots.geojson`, contentType: 'application/geo+json', byteSize: shots.length, sha256: digest(shots), published: true }],
    cameraPhotos: [{ filename: 'DJI_0001.JPG', rootKey: 'datasets', relativePath: `${datasetId}/DJI_0001.JPG`, contentType: 'image/jpeg', byteSize: photo.length, sha256: digest(photo) }],
  });
  const sourceAuthorization = { type: 'direct_client_grant', id: 'synthetic-grant', version: 1 };
  const token = 'direct-session-token-0000000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(token), modelId: model.id, modelVersionId: model.activeVersionId,
    sourceAuthorization, subject: 'client:synthetic', audience: 'client',
    permissions: { view: true, cameras: true, download: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  // A second, independent direct session whose own grant is already revoked.
  const staleToken = 'stale-direct-session-token-00000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(staleToken), modelId: model.id, modelVersionId: model.activeVersionId,
    sourceAuthorization: { type: 'direct_client_grant', id: 'stale-grant', version: 1 }, subject: 'client:other', audience: 'client',
    permissions: { view: true, cameras: true, download: false }, expiresAt: new Date(Date.now() + 60_000).toISOString() });
  database.prepare(`INSERT INTO revoked_published_session_authorizations
    (source_authorization_type,source_authorization_id,source_authorization_version,revoked_at) VALUES ('direct_client_grant','stale-grant',1,?)`)
    .run(new Date().toISOString());
  const share = repository.createPublicShare({ modelId: model.id, publicIdHash: crypto.randomBytes(32).toString('hex'),
    permissions: { view: true, cameras: true } });
  const shareToken = auth.sign({ kind: 'share-asset', shareId: share.id, modelId: model.id }, 3_600_000);
  const opsToken = 'ops-session-token-00000000000000000000000';
  repository.createViewerSession({ tokenHash: auth.hashToken(opsToken), modelId: model.id, modelVersionId: model.activeVersionId,
    subject: 'ops:synthetic', audience: 'ops', permissions: { view: true, cameras: true, download: false },
    expiresAt: new Date(Date.now() + 60_000).toISOString() });

  // Land a source-version tombstone after the route's first authorization read,
  // i.e. while the request is between admission and sending bytes.
  let tombstoneAfterReads = Infinity, reads = 0;
  const read = repository.getViewerSessionByHash.bind(repository);
  repository.getViewerSessionByHash = hash => {
    if (++reads === tombstoneAfterReads) database.prepare(`INSERT INTO revoked_published_session_authorizations
      (source_authorization_type,source_authorization_id,source_authorization_version,revoked_at)
      VALUES (?,?,?,?)`).run(sourceAuthorization.type, sourceAuthorization.id, sourceAuthorization.version, new Date().toISOString());
    return read(hash);
  };
  assets.setRepository(repository);
  const app = express();
  app.use((req, _res, next) => { req.cookies = req.get('x-test-viewer-cookie') ? { ltds_viewer: req.get('x-test-viewer-cookie') } : {}; next(); });
  app.use(assets);
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    config.datasetsMount = oldDatasetsMount;
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`, token, opsToken, staleToken, shareToken, model, photo, shots, datasetId, database,
    revokeOnRead(n) { reads = 0; tombstoneAfterReads = n; },
  };
}

test('asset and camera routes recheck a direct-client session immediately before sending bytes', async t => {
  const h = await harness(t);
  const assetPath = token => `/session-assets/${encodeURIComponent(token)}/${h.model.id}/datasets/${h.datasetId}/assets/odm_report/shots.geojson`;
  const photoPath = token => `/session-camera-photos/${encodeURIComponent(token)}/${h.model.id}/DJI_0001.JPG`;

  const ok = await fetch(`${h.base}${assetPath(h.token)}`);
  assert.equal(ok.status, 200);
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), h.shots);
  const range = await fetch(`${h.base}${assetPath(h.token)}`, { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(Buffer.from(await range.arrayBuffer()).toString(), h.shots.subarray(0, 4).toString());
  assert.equal((await fetch(`${h.base}${assetPath(h.token)}`, { method: 'HEAD' })).status, 200);
  assert.equal((await fetch(`${h.base}${photoPath(h.token)}`)).status, 200);

  // Admitted on the first read; the tombstone lands before the final check.
  for (const [label, request] of [
    ['asset GET', () => fetch(`${h.base}${assetPath(h.token)}`)],
    ['asset HEAD', () => fetch(`${h.base}${assetPath(h.token)}`, { method: 'HEAD' })],
    ['asset Range', () => fetch(`${h.base}${assetPath(h.token)}`, { headers: { Range: 'bytes=0-3' } })],
    ['camera GET', () => fetch(`${h.base}${photoPath(h.token)}`)],
  ]) {
    h.database.exec("DELETE FROM revoked_published_session_authorizations WHERE source_authorization_id='synthetic-grant'");
    h.revokeOnRead(2);
    const response = await request();
    assert.equal(response.status, 403, label);
    if (label !== 'asset HEAD') assert.doesNotMatch(await response.text(), /FeatureCollection|synthetic-direct-camera-photo/, label);
  }

  // Cookie admission (/assets) is rechecked the same way.
  const cookieAsset = `/assets/${h.model.id}/datasets/${h.datasetId}/assets/odm_report/shots.geojson`;
  h.database.exec("DELETE FROM revoked_published_session_authorizations WHERE source_authorization_id='synthetic-grant'");
  h.revokeOnRead(Infinity);
  assert.equal((await fetch(`${h.base}${cookieAsset}`, { headers: { 'x-test-viewer-cookie': h.token } })).status, 200);
  h.revokeOnRead(2);
  assert.equal((await fetch(`${h.base}${cookieAsset}`, { headers: { 'x-test-viewer-cookie': h.token } })).status, 403, 'cookie GET');
});

test('the final check revalidates only the authority that admitted the delivery (mixed authorities)', async t => {
  const h = await harness(t);
  const assetPath = token => `/session-assets/${encodeURIComponent(token)}/${h.model.id}/datasets/${h.datasetId}/assets/odm_report/shots.geojson`;
  const photoPath = token => `/session-camera-photos/${encodeURIComponent(token)}/${h.model.id}/DJI_0001.JPG`;
  const stale = { headers: { 'x-test-viewer-cookie': h.staleToken } };
  // The stale direct cookie alone is refused.
  assert.equal((await fetch(`${h.base}/assets/${h.model.id}/datasets/${h.datasetId}/assets/odm_report/shots.geojson`, stale)).status, 403);
  // An unrelated stale direct cookie never blocks an independent valid authority.
  for (const [label, path] of [
    ['valid direct session path', assetPath(h.token)],
    ['staff session path', assetPath(h.opsToken)],
    ['public share path', assetPath(h.shareToken)],
    ['valid direct camera path', photoPath(h.token)],
    ['public share camera path', photoPath(h.shareToken)],
  ]) {
    for (const init of [stale, { ...stale, method: 'HEAD' }, { headers: { ...stale.headers, Range: 'bytes=0-3' } }]) {
      if (label.includes('camera') && init.method === 'HEAD') continue;
      const response = await fetch(`${h.base}${path}`, init);
      assert.ok([200, 206].includes(response.status), `${label} ${init.method || 'GET'} ${init.headers.Range || ''}: ${response.status}`);
    }
  }
  // A tombstone on the admitting session still denies, whatever else is presented.
  h.revokeOnRead(2);
  assert.equal((await fetch(`${h.base}${assetPath(h.token)}`, stale)).status, 403);
  // Staff sessions keep their existing behaviour (no direct-grant recheck applies).
  h.revokeOnRead(2);
  assert.equal((await fetch(`${h.base}${assetPath(h.opsToken)}`)).status, 200);
});

test('the final check re-reads only the recorded admitting session', () => {
  const sessions = new Map([['live', true], ['dead', false]]);
  assets.setRepository({ liveViewerSessionByHash: hash => ([...sessions].find(([key]) => auth.hashToken(key) === hash)?.[1] ? {} : null) });
  assert.equal(assets.admittedDirectSessionStillLive({}), true, 'no direct session admitted this request');
  assert.equal(assets.admittedDirectSessionStillLive({ admittedDirectSessionHash: auth.hashToken('live') }), true);
  assert.equal(assets.admittedDirectSessionStillLive({ admittedDirectSessionHash: auth.hashToken('dead'), cookies: { ltds_viewer: 'live' } }), false);
  assert.equal(assets.admittedDirectSessionStillLive({ params: { token: 'dead' }, cookies: { ltds_viewer: 'dead' } }), true,
    'unrecorded presented credentials are never consulted');
});
