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
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(assets);
  const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    config.datasetsMount = oldDatasetsMount;
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    base: `http://127.0.0.1:${server.address().port}`, token, opsToken, model, photo, shots, datasetId, database,
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
    h.database.exec('DELETE FROM revoked_published_session_authorizations');
    h.revokeOnRead(2);
    const response = await request();
    assert.equal(response.status, 403, label);
    if (label !== 'asset HEAD') assert.doesNotMatch(await response.text(), /FeatureCollection|synthetic-direct-camera-photo/, label);
  }

  // Staff/ops sessions keep their existing behaviour (no direct-grant recheck applies).
  h.database.exec('DELETE FROM revoked_published_session_authorizations');
  h.revokeOnRead(2);
  assert.equal((await fetch(`${h.base}${assetPath(h.opsToken)}`)).status, 200);
});

test('the final check accepts only live direct sessions and ignores signed share tokens', () => {
  const sessions = new Map([
    ['live', { sourceAuthorization: { type: 'direct_client_grant' }, live: true }],
    ['dead', { sourceAuthorization: { type: 'direct_client_grant' }, live: false }],
    ['restricted-dead', { restrictedScope: {}, live: false }],
    ['ops-dead', { sourceAuthorization: null, live: false }],
  ]);
  assets.setRepository({
    getViewerSessionByHash: hash => [...sessions].find(([key]) => auth.hashToken(key) === hash)?.[1] || null,
    viewerSessionLive: session => session.live,
  });
  const check = token => assets.presentedDirectSessionsStillLive({ params: { token }, cookies: {} });
  assert.equal(check('live'), true);
  assert.equal(check('dead'), false);
  assert.equal(check('restricted-dead'), false);
  assert.equal(check('ops-dead'), true);
  assert.equal(check('not-a-session'), true);
  assert.equal(assets.presentedDirectSessionsStillLive({ params: {}, cookies: { ltds_viewer: 'dead' } }), false);
});
