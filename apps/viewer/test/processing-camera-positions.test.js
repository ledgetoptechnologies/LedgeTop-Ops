'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { processingCameraPhotoLinks, readShotsDocument } = require('../server/cameraPhotos');
const { openDatabase } = require('../server/database');
const { discoverOutputs } = require('../server/processingWorker');
const { backfillProcessingCameraPositions } = require('../server/processingCameraBackfill');
const { ProcessingRepository } = require('../server/processingRepository');
const { ViewerRepository } = require('../server/repository');
const { StorageManager } = require('../server/storageManager');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const shots = (...filenames) => JSON.stringify({
  type: 'FeatureCollection',
  features: filenames.map((filename, index) => ({
    type: 'Feature',
    properties: { filename, translation: [500000 + index, 4800000, 300], rotation: [0, 0, 0] },
    geometry: { type: 'Point', coordinates: [-90, 44, 300] },
  })),
});
const write = (root, relative, data) => {
  const target = path.join(root, ...relative.split('/'));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, data);
  return target;
};

test('processing output discovery registers ODM camera positions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-processing-shots-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  write(root, 'odm_orthophoto/odm_orthophoto.tif', 'tif');
  write(root, 'odm_report/report.pdf', 'pdf');
  write(root, 'odm_report/shots.geojson', shots('a.jpg'));
  const found = discoverOutputs(root);
  const camera = found.find((asset) => asset.kind === 'shots');
  assert.ok(camera, 'shots.geojson must be registered as the shots asset');
  assert.equal(camera.relativePath, 'odm_report/shots.geojson');
  assert.equal(camera.format, 'geojson');
});

test('processing photo links match ODM basenames to nested dataset files', () => {
  const document = JSON.parse(shots('DJI_0001_V.JPG', 'DJI_0002_V.JPG', 'DJI_0003_V.JPG', 'missing.jpg'));
  const file = (relativePath, body) => ({ relativePath, byteSize: body.length, sha256: sha(body) });
  const links = processingCameraPhotoLinks(document, {
    datasetRootKey: 'datasets',
    datasetRelativePath: 'dataset-1',
    files: [
      file('Client/Flight A/DJI_0001_V.JPG', 'one'),
      file('Client/Flight A/DJI_0002_V.JPG', 'two'),
      // Ambiguous within the dataset: never guess between the two.
      file('Client/Flight A/DJI_0003_V.JPG', 'three-a'),
      file('Client/Flight B/dji_0003_v.jpg', 'three-b'),
      file('Client/Flight A/notes.txt', 'text'),
    ],
  });
  assert.deepEqual(links.map((link) => [link.filename, link.relativePath]), [
    ['DJI_0001_V.JPG', 'dataset-1/Client/Flight A/DJI_0001_V.JPG'],
    ['DJI_0002_V.JPG', 'dataset-1/Client/Flight A/DJI_0002_V.JPG'],
  ]);
  assert.ok(links.every((link) => link.rootKey === 'datasets' && link.contentType === 'image/jpeg'));
  assert.equal(links[0].sha256, sha('one'));
  for (const unsafe of ['../escape', '/absolute', 'a\\b', 'a/../b', ''])
    assert.deepEqual(processingCameraPhotoLinks(document, { datasetRootKey: 'datasets', datasetRelativePath: unsafe, files: [file('DJI_0001_V.JPG', 'one')] }), []);
  assert.deepEqual(processingCameraPhotoLinks(document, { datasetRootKey: 'models', datasetRelativePath: 'dataset-1', files: [file('DJI_0001_V.JPG', 'one')] }), []);
});

test('shots documents outside the camera contract are rejected', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-shots-doc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readShotsDocument(write(root, 'bad.geojson', '{not json')), null);
  assert.equal(readShotsDocument(write(root, 'list.geojson', '[]')), null);
  assert.equal(readShotsDocument(path.join(root, 'absent.geojson')), null);
  assert.equal(readShotsDocument(write(root, 'ok.geojson', shots('a.jpg'))).features.length, 1);
});

test('camera backfill is dry-run by default, then registers once and stays idempotent', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-backfill-'));
  const config = { datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash') };
  for (const directory of Object.values(config)) fs.mkdirSync(directory, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const processing = new ProcessingRepository(database), repository = new ViewerRepository(database), storage = new StorageManager(config);

  const project = processing.createProject({ displayName: 'Project' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Photos', rootKey: 'datasets', relativePath: 'photos-1' });
  const photo = 'jpeg-bytes';
  write(config.datasetsMount, 'photos-1/Flight/DJI_0001_V.JPG', photo);
  const files = [{ relativePath: 'Flight/DJI_0001_V.JPG', byteSize: photo.length, sha256: sha(photo), processingRole: 'image' }];
  processing.finalizeDataset(dataset.id, files, sha(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))));
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Fixture', enabled: true, endpoint: 'http://127.0.0.1:9' });
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Task' });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id });

  const source = `${task.id}/${attempt.id}.v2/source`;
  const body = shots('DJI_0001_V.JPG', 'DJI_0002_V.JPG');
  write(config.modelsMount, `${source}/odm_report/shots.geojson`, body);
  write(config.modelsMount, `${source}/odm_report/report.pdf`, 'pdf');
  const model = repository.upsertModelVersion({
    provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: 'Task',
    sourceLocator: { taskId: task.id, attemptId: attempt.id }, status: 'importing', makeActive: false,
    assets: [{ kind: 'report', rootKey: 'models', relativePath: `${source}/odm_report/report.pdf`, format: 'pdf', byteSize: 3, storageMode: 'managed', published: false, sha256: sha('pdf') }],
  });
  const version = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, attempt.id);
  database.prepare('UPDATE processing_attempts SET result_model_id=?,result_model_version_id=? WHERE id=?').run(model.id, version.id, attempt.id);
  const deps = { database, processing, repository, storage, attemptIds: [attempt.id] };
  const count = (sql) => database.prepare(sql).get(version.id).count;

  const [dry] = await backfillProcessingCameraPositions(deps);
  assert.equal(dry.status, 'would_register');
  assert.equal(dry.cameraCount, 2);
  assert.equal(dry.photosMatched, 1);
  assert.equal(count("SELECT COUNT(*) AS count FROM model_assets WHERE version_id=? AND kind='shots'"), 0);
  assert.equal(count('SELECT COUNT(*) AS count FROM model_camera_photos WHERE version_id=?'), 0);

  const [applied] = await backfillProcessingCameraPositions({ ...deps, apply: true });
  assert.equal(applied.status, 'registered');
  assert.equal(applied.photosLinked, 1);
  const asset = database.prepare("SELECT * FROM model_assets WHERE version_id=? AND kind='shots'").get(version.id);
  assert.equal(asset.relative_path, `${source}/odm_report/shots.geojson`);
  assert.equal(asset.sha256, sha(body));
  assert.equal(asset.published, 0);
  assert.deepEqual(repository.getCameraPhoto(version.id, 'DJI_0001_V.JPG'), {
    filename: 'DJI_0001_V.JPG', rootKey: 'datasets', relativePath: 'photos-1/Flight/DJI_0001_V.JPG', contentType: 'image/jpeg', byteSize: photo.length, sha256: sha(photo),
  });

  const [again] = await backfillProcessingCameraPositions({ ...deps, apply: true });
  assert.equal(again.status, 'already_present');
  assert.equal(count("SELECT COUNT(*) AS count FROM model_assets WHERE version_id=? AND kind='shots'"), 1);
  assert.equal(count('SELECT COUNT(*) AS count FROM model_camera_photos WHERE version_id=?'), 1);

  const [unknown] = await backfillProcessingCameraPositions({ ...deps, attemptIds: ['missing-attempt'], apply: true });
  assert.equal(unknown.status, 'attempt_not_found');
});
