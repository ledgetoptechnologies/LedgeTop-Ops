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
const { createApiV1 } = require('../server/apiV1');
const { config } = require('../server/config');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function write(root, relativePath, body) {
  const absolute = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, body);
}

test('published WebODM imports serve source, scoped EPT, and managed tile derivatives through one session', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-imported-delivery-'));
  const webodmMount = path.join(root, 'webodm');
  const modelsMount = path.join(root, 'models');
  fs.mkdirSync(webodmMount, { recursive: true });
  fs.mkdirSync(modelsMount, { recursive: true });

  const previous = {
    webodmMediaMount: config.webodmMediaMount,
    modelsMount: config.modelsMount,
    xAccelRedirectPrefix: config.xAccelRedirectPrefix,
  };
  config.webodmMediaMount = webodmMount;
  config.modelsMount = modelsMount;
  config.xAccelRedirectPrefix = '';

  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const repository = new ViewerRepository(database);
  const modelId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const token = 'imported-delivery-token-00000000000000000000';
  const sourcePrefix = 'project/17/task/42/assets';
  const paths = {
    glb: `${sourcePrefix}/odm_texturing/odm_textured_model_geo.glb`,
    ortho: `${sourcePrefix}/odm_orthophoto/odm_orthophoto.tif`,
    ept: `${sourcePrefix}/entwine_pointcloud/ept.json`,
    eptChild: `${sourcePrefix}/entwine_pointcloud/ept-data/0-0-0-0.laz`,
    tiles: 'task-17/attempt-42/tiles/tileset.json',
    tileChild: 'task-17/attempt-42/tiles/root.b3dm',
  };
  const bodies = {
    glb: Buffer.from('GLB source'),
    ortho: Buffer.from('ORTHO'),
    ept: Buffer.from('{"dataType":"laszip","schema":[]}'),
    eptChild: Buffer.from('EPT points'),
    tiles: Buffer.from('{"asset":{"version":"1.1"},"root":{}}'),
    tileChild: Buffer.from('B3DM tile'),
  };
  write(webodmMount, paths.glb, bodies.glb);
  write(webodmMount, paths.ortho, bodies.ortho);
  write(webodmMount, paths.ept, bodies.ept);
  write(webodmMount, paths.eptChild, bodies.eptChild);
  write(modelsMount, paths.tiles, bodies.tiles);
  write(modelsMount, paths.tileChild, bodies.tileChild);

  const eptManifest = [
    { relativePath: 'ept.json', byteSize: bodies.ept.length, sha256: sha256(bodies.ept) },
    { relativePath: 'ept-data/0-0-0-0.laz', byteSize: bodies.eptChild.length, sha256: sha256(bodies.eptChild) },
  ];
  const tilesManifest = [
    { relativePath: 'tileset.json', byteSize: bodies.tiles.length, sha256: sha256(bodies.tiles) },
    { relativePath: 'root.b3dm', byteSize: bodies.tileChild.length, sha256: sha256(bodies.tileChild) },
  ];
  const tilesManifestSha256 = sha256(JSON.stringify(tilesManifest));

  const model = repository.upsertModelVersion({
    modelId,
    versionId,
    provider: 'webodm',
    providerModelId: 'catalog:webodm-17-42',
    providerVersionId: sha256('webodm-17-42'),
    displayName: 'Imported WebODM model',
    status: 'ready',
    sourceLocator: {
      catalogImport: true,
      projectId: '17',
      taskId: '42',
      sourceRootKey: 'webodm',
      sourceRelativePath: sourcePrefix,
    },
    versionMetadata: {
      catalogImport: true,
      lodProvenance: {
        schemaVersion: 2,
        sourceAsset: path.posix.basename(paths.glb),
        sourceSha256: sha256(bodies.glb),
        tilesManifestSha256,
        geometry: 'bounded-triangle-equivalence',
        textures: 'byte-identical-material-equivalence',
        leafGeometricError: 0,
        audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', artifactCount: 2 },
      },
    },
    assets: [
      { kind: 'glb', rootKey: 'webodm', relativePath: paths.glb, format: 'glb', byteSize: bodies.glb.length, sha256: sha256(bodies.glb), published: true },
      { kind: 'ortho', rootKey: 'webodm', relativePath: paths.ortho, format: 'tif', byteSize: bodies.ortho.length, sha256: sha256(bodies.ortho), published: true },
      { kind: 'ept', rootKey: `webodm@${versionId}`, relativePath: paths.ept, format: 'ept', byteSize: bodies.ept.length, sha256: sha256(bodies.ept), manifestSha256: sha256(JSON.stringify(eptManifest)), manifestFiles: eptManifest, published: true },
      { kind: 'tiles', rootKey: 'models', relativePath: paths.tiles, format: '3dtiles', byteSize: bodies.tiles.length, sha256: sha256(bodies.tiles), manifestSha256: tilesManifestSha256, manifestFiles: tilesManifest, published: true },
    ],
    makeActive: true,
  });
  repository.createViewerSession({
    tokenHash: auth.hashToken(token),
    modelId: model.id,
    modelVersionId: versionId,
    subject: 'ops:test',
    audience: 'ops',
    permissions: { view: true, measure: true, cameras: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assets.setRepository(repository);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.cookies = {}; next(); });
  app.use(createApiV1(repository));
  app.use(assets);
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    assets.setRepository(null);
    Object.assign(config, previous);
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const origin = `http://127.0.0.1:${server.address().port}`;
  const current = await fetch(`${origin}/api/v1/sessions/current`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(current.status, 200);
  const viewer = (await current.json()).model;
  const probes = [
    ['orthophoto', viewer.assets.ortho, bodies.ortho],
    ['EPT metadata', viewer.assets.ept, bodies.ept],
    ['EPT child', viewer.assets.ept.replace(/ept\.json$/, 'ept-data/0-0-0-0.laz'), bodies.eptChild],
    ['tileset', viewer.assets.tiles, bodies.tiles],
    ['tile child', viewer.assets.tiles.replace(/tileset\.json$/, 'root.b3dm'), bodies.tileChild],
  ];
  for (const [name, url, expected] of probes) {
    assert.ok(url, `${name} URL is present in the session`);
    const response = await fetch(`${origin}${url}`);
    assert.equal(response.status, 200, `${name} is deliverable`);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected, `${name} bytes are exact`);
  }
});

test('storage resolves exact version-scoped provider aliases without accepting malformed roots', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-scoped-root-'));
  const paths = {
    datasetsMount: path.join(root, 'datasets'),
    modelsMount: path.join(root, 'models'),
    cacheMount: path.join(root, 'cache'),
    trashMount: path.join(root, 'trash'),
    terraImportMount: path.join(root, 'terra'),
  };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { recursive: true });
  const storage = new StorageManager({ ...paths, storageReserveBytes: 0, storageReservePercent: 0 });
  const relativePath = 'capture/entwine_pointcloud/ept.json';
  const absolute = path.join(paths.terraImportMount, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, '{}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const versionId = crypto.randomUUID();
  assert.equal(storage.resolve(`terra@${versionId}`, relativePath, { mustExist: true }), absolute);
  assert.throws(
    () => storage.resolve('terra@------------------------------------', relativePath, { mustExist: true }),
    { code: 'invalid_storage_location' },
  );
});
