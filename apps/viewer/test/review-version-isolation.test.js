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
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

test('an exact ready review version remains accessible after a newer recovery fails', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-review-version-isolation-'));
  const modelsMount = path.join(root, 'models');
  fs.mkdirSync(modelsMount, { recursive: true });
  const previous = {
    modelsMount: config.modelsMount,
    xAccelRedirectPrefix: config.xAccelRedirectPrefix,
  };
  config.modelsMount = modelsMount;
  config.xAccelRedirectPrefix = '';

  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const repository = new ViewerRepository(database);
  const write = (relativePath, body) => {
    const absolute = path.join(modelsMount, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, body);
  };

  const project = processing.createProject({ displayName: 'Rome Dam' });
  const dataset = processing.createDataset({
    projectId: project.id,
    displayName: 'Rome Dam source',
    storageMode: 'managed',
    rootKey: 'datasets',
    relativePath: 'rome-dam-source',
  });
  processing.finalizeDataset(dataset.id, [
    { relativePath: 'source.zip', byteSize: 1, sha256: digest('x') },
  ], digest('dataset'));
  const task = processing.createTask({
    projectId: project.id,
    datasetId: dataset.id,
    displayName: 'Rome Dam',
  });
  const sourceAttempt = processing.createImportedAttempt({
    id: crypto.randomUUID(),
    taskId: task.id,
    datasetId: dataset.id,
    providerTaskId: 'rome-dam:source',
    createdBy: 'ops:test',
    staged: false,
  });
  const sourceVersionId = crypto.randomUUID();
  const prefix = `${task.id}/${sourceAttempt.id}`;
  const bodies = {
    glb: Buffer.from('glb'),
    ortho: Buffer.from('ortho'),
    dsm: Buffer.from('dsm'),
    dtm: Buffer.from('dtm'),
    shots: Buffer.from('{"type":"FeatureCollection","features":[]}'),
    photo: Buffer.from('jpeg'),
    ept: Buffer.from('{"bounds":[0,0,0,1,1,1],"boundsConforming":[0,0,0,1,1,1],"span":128,"dataType":"laszip","schema":[]}'),
    eptChild: Buffer.from('laz'),
  };
  const paths = {
    glb: `${prefix}/model.glb`,
    ortho: `${prefix}/ortho.tif`,
    dsm: `${prefix}/dsm.tif`,
    dtm: `${prefix}/dtm.tif`,
    shots: `${prefix}/shots.geojson`,
    photo: `${prefix}/DJI_001.JPG`,
    ept: `${prefix}/ept/ept.json`,
    eptChild: `${prefix}/ept/ept-data/0-0-0-0.laz`,
  };
  for (const [kind, relativePath] of Object.entries(paths)) write(relativePath, bodies[kind]);
  const eptManifest = [
    { relativePath: 'ept.json', byteSize: bodies.ept.length, sha256: digest(bodies.ept) },
    { relativePath: 'ept-data/0-0-0-0.laz', byteSize: bodies.eptChild.length, sha256: digest(bodies.eptChild) },
  ];
  const model = repository.upsertModelVersion({
    modelId: crypto.randomUUID(),
    versionId: sourceVersionId,
    provider: 'ltds-processing',
    providerModelId: task.id,
    providerVersionId: sourceAttempt.id,
    displayName: task.displayName,
    status: 'ready',
    makeActive: false,
    assets: [
      ...['glb', 'ortho', 'dsm', 'dtm', 'shots'].map((kind) => ({
        kind,
        rootKey: 'models',
        relativePath: paths[kind],
        byteSize: bodies[kind].length,
        sha256: digest(bodies[kind]),
        published: false,
      })),
      {
        kind: 'ept',
        rootKey: 'models',
        relativePath: paths.ept,
        byteSize: bodies.ept.length,
        sha256: digest(bodies.ept),
        manifestSha256: digest(JSON.stringify(eptManifest)),
        manifestFiles: eptManifest,
        published: false,
      },
    ],
    cameraPhotos: [{
      filename: 'DJI_001.JPG',
      rootKey: 'models',
      relativePath: paths.photo,
      contentType: 'image/jpeg',
      byteSize: bodies.photo.length,
      sha256: digest(bodies.photo),
    }],
  });
  processing.setAttemptResult(sourceAttempt.id, model.id, sourceVersionId);
  processing.registerModelOutput({
    versionId: sourceVersionId,
    modelId: model.id,
    taskId: task.id,
    attemptId: sourceAttempt.id,
    projectId: project.id,
    relativePath: prefix,
    status: 'ready',
    byteSize: Object.values(bodies).reduce((sum, body) => sum + body.length, 0),
    assetCount: 6,
  });

  const reviewToken = 'rome-review-token-000000000000000000000';
  const reviewSession = repository.createViewerSession({
    tokenHash: auth.hashToken(reviewToken),
    modelId: model.id,
    modelVersionId: sourceVersionId,
    reviewAttemptId: sourceAttempt.id,
    sessionMode: 'review',
    subject: 'ops:test',
    audience: 'ops',
    permissions: { view: true, cameras: true },
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const publishedToken = 'rome-published-token-00000000000000000';
  repository.createViewerSession({
    tokenHash: auth.hashToken(publishedToken),
    modelId: model.id,
    modelVersionId: sourceVersionId,
    sessionMode: 'published',
    subject: 'ops:test',
    audience: 'ops',
    permissions: { view: true, cameras: true },
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
  const currentSession = async (token) => fetch(`${origin}/api/v1/sessions/current`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const initial = await currentSession(reviewToken);
  assert.equal(initial.status, 200);
  const initialBody = await initial.json();
  assert.equal(initialBody.model.available, true);
  const reviewUrls = [
    initialBody.model.assets.glb,
    initialBody.model.assets.ept,
    initialBody.model.assets.ept.replace(/ept\.json$/, 'ept-data/0-0-0-0.laz'),
    initialBody.model.assets.ortho,
    initialBody.model.assets.dsm,
    initialBody.model.assets.dtm,
    initialBody.model.assets.shots,
    `${initialBody.model.assets.cameraPhotos}/DJI_001.JPG`,
  ];
  for (const url of reviewUrls) {
    assert.equal((await fetch(`${origin}${url}`)).status, 200, `initial exact review asset: ${url}`);
  }

  const recoveryAttempt = processing.createImportedAttempt({
    id: crypto.randomUUID(),
    taskId: task.id,
    datasetId: dataset.id,
    providerTaskId: 'lod-recovery:new',
    createdBy: 'ops:test',
    staged: true,
    expectedActiveAttemptId: sourceAttempt.id,
  });
  const failedVersionId = crypto.randomUUID();
  repository.upsertModelVersion({
    modelId: model.id,
    versionId: failedVersionId,
    provider: 'ltds-processing',
    providerModelId: task.id,
    providerVersionId: 'lod-recovery:new',
    displayName: task.displayName,
    status: 'importing',
    makeActive: false,
    assets: [],
  });
  processing.setAttemptResult(recoveryAttempt.id, model.id, failedVersionId);
  processing.registerModelOutput({
    versionId: failedVersionId,
    modelId: model.id,
    taskId: task.id,
    attemptId: recoveryAttempt.id,
    projectId: project.id,
    relativePath: `${task.id}/${recoveryAttempt.id}`,
    status: 'staged',
    byteSize: 0,
    assetCount: 0,
  });
  processing.transitionAttempt(recoveryAttempt.id, 'failed', {
    errorCode: 'lod_surface_equivalence_failed',
    errorMessage: 'controlled audit failed',
  });

  const exactSource = repository.getModelVersion(model.id, sourceVersionId);
  assert.equal(repository.viewerSessionLive(repository.getViewerSessionByHash(auth.hashToken(reviewToken))), true);
  assert.equal(exactSource.activeVersion.status, 'ready');
  assert.equal(exactSource.status, 'failed', 'the shared parent reflects the newer recovery failure');
  const afterFailure = await currentSession(reviewToken);
  assert.equal(afterFailure.status, 200);
  assert.equal((await afterFailure.json()).model.available, true, 'review availability follows the exact ready version');
  for (const url of reviewUrls) {
    assert.equal((await fetch(`${origin}${url}`)).status, 200, `old exact review asset after recovery failure: ${url}`);
  }

  const publishedGlb = reviewUrls[0].replace(reviewToken, publishedToken);
  assert.equal((await currentSession(publishedToken)).status, 404, 'a published session cannot select a non-active version');
  assert.equal((await fetch(`${origin}${publishedGlb}`)).status, 403, 'review isolation does not relax published asset authorization');

  repository.publishModelVersion(model.id, sourceVersionId, ['glb', 'ept', 'ortho', 'dsm', 'dtm', 'shots']);
  assert.equal((await currentSession(publishedToken)).status, 200, 'the published capability works only after its version becomes active');
  assert.equal((await fetch(`${origin}${publishedGlb}`)).status, 200);

  database.prepare("UPDATE model_versions SET status='failed' WHERE id=?").run(sourceVersionId);
  assert.equal((await currentSession(reviewToken)).status, 401, 'review liveness fails closed when its exact version is no longer ready');
  assert.equal((await fetch(`${origin}${reviewUrls[0]}`)).status, 403);
});
