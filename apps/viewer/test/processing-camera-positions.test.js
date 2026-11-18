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
const { backfillProcessingCameraPositions, reconcileMissingCameraPositions, repairUndoStatements, MAX_TRANSIENT_TRIES, REPAIR_KEY_PREFIX } = require('../server/processingCameraBackfill');
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

// Builds an isolated database and storage with processed models for the repair.
function repairFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-camera-repair-'));
  const config = { datasetsMount: path.join(root, 'datasets'), modelsMount: path.join(root, 'models'), cacheMount: path.join(root, 'cache'), trashMount: path.join(root, 'trash') };
  for (const directory of Object.values(config)) fs.mkdirSync(directory, { recursive: true });
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const processing = new ProcessingRepository(database), repository = new ViewerRepository(database), storage = new StorageManager(config);
  const project = processing.createProject({ displayName: 'Project' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Fixture', enabled: true, endpoint: 'http://127.0.0.1:9' });
  const photo = 'jpeg-bytes';
  const processed = (name, { shotsBody = shots('DJI_0001_V.JPG'), existingShots = false, output = null, writeOutput = true } = {}) => {
    const dataset = processing.createDataset({ projectId: project.id, displayName: name, rootKey: 'datasets', relativePath: `photos-${name}` });
    write(config.datasetsMount, `photos-${name}/Flight/DJI_0001_V.JPG`, photo);
    const files = [{ relativePath: 'Flight/DJI_0001_V.JPG', byteSize: photo.length, sha256: sha(photo), processingRole: 'image' }];
    processing.finalizeDataset(dataset.id, files, sha(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))));
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: name });
    const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id });
    const source = `${task.id}/${attempt.id}.v2/source`;
    const writeFiles = () => {
      write(config.modelsMount, `${source}/odm_report/shots.geojson`, shotsBody);
      write(config.modelsMount, `${source}/odm_report/report.pdf`, 'pdf');
    };
    if (writeOutput) writeFiles();
    const assets = [{ kind: 'report', rootKey: 'models', relativePath: `${source}/odm_report/report.pdf`, format: 'pdf', byteSize: 3, storageMode: 'managed', published: true, sha256: sha('pdf') }];
    if (existingShots) assets.push({ kind: 'shots', rootKey: 'models', relativePath: `${source}/odm_report/shots.geojson`, format: 'geojson', byteSize: Buffer.byteLength(shotsBody), storageMode: 'managed', published: true, sha256: sha(shotsBody) });
    const model = repository.upsertModelVersion({
      provider: 'ltds-processing', providerModelId: task.id, providerVersionId: attempt.id, displayName: name,
      sourceLocator: { taskId: task.id, attemptId: attempt.id }, status: 'ready', makeActive: false, assets,
    });
    const version = database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id, attempt.id);
    database.prepare("UPDATE processing_attempts SET status='ready_for_review',result_model_id=?,result_model_version_id=? WHERE id=?").run(model.id, version.id, attempt.id);
    if (output) {
      const t0 = new Date().toISOString();
      database.prepare('INSERT INTO model_outputs(id,model_id,task_id,attempt_id,project_id,root_key,relative_path,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
        .run(version.id, model.id, task.id, attempt.id, project.id, 'models', `${task.id}/${attempt.id}.v2`, output, t0, t0);
    }
    return { attemptId: attempt.id, versionId: version.id, writeFiles };
  };
  const rows = (versionId) => ({
    assets: database.prepare('SELECT kind,relative_path,sha256,published FROM model_assets WHERE version_id=? ORDER BY kind').all(versionId).map((row) => ({ ...row })),
    photos: database.prepare('SELECT filename,relative_path,sha256 FROM model_camera_photos WHERE version_id=? ORDER BY filename').all(versionId).map((row) => ({ ...row })),
  });
  const record = (attemptId) => {
    const row = database.prepare('SELECT value FROM app_state WHERE key=?').get(REPAIR_KEY_PREFIX + attemptId);
    return row ? JSON.parse(row.value) : null;
  };
  const lines = [];
  const deps = { database, processing, repository, storage, log: { log: (line) => lines.push(line) } };
  return { config, database, processing, repository, storage, processed, rows, record, lines, deps };
}

test('worker repair registers missing camera positions once, skips lasting problems and only adds rows', async (t) => {
  const { database, processing, processed, rows, record, lines, deps } = repairFixture(t);
  const good = processed('good');
  const alreadyHasShots = processed('existing', { existingShots: true });
  const invalid = processed('invalid', { shotsBody: '{not json' });
  const linkedOnly = processed('linked');
  deps.repository.replaceCameraPhotos(linkedOnly.versionId, [{ filename: 'DJI_0001_V.JPG', rootKey: 'datasets', relativePath: 'photos-linked/elsewhere/DJI_0001_V.JPG', contentType: 'image/jpeg', byteSize: 1, sha256: sha('x') }]);
  const before = Object.fromEntries([alreadyHasShots, invalid, linkedOnly].map((m) => [m.versionId, rows(m.versionId)]));
  const publishedBefore = database.prepare('SELECT id FROM model_assets WHERE published=1 ORDER BY id').all().map((row) => row.id);

  const first = await reconcileMissingCameraPositions(deps);
  assert.deepEqual([first.scanned, first.registered, first.skipped, first.retrying], [3, 1, 2, 0]);
  const second = await reconcileMissingCameraPositions(deps);
  assert.equal(second.scanned, 0, 'nothing is selected again');

  const goodRows = rows(good.versionId);
  assert.equal(goodRows.assets.find((asset) => asset.kind === 'shots')?.published, 0, 'the shots asset is added unpublished');
  // Every dataset holds a DJI_0001_V.JPG; the link must be to this attempt's own dataset.
  assert.deepEqual(goodRows.photos.map((photo) => photo.relative_path), ['photos-good/Flight/DJI_0001_V.JPG']);
  for (const [versionId, snapshot] of Object.entries(before)) assert.deepEqual(rows(versionId), snapshot, 'skipped and already-repaired models are not changed');
  assert.deepEqual(database.prepare('SELECT id FROM model_assets WHERE published=1 ORDER BY id').all().map((row) => row.id), publishedBefore, 'nothing new is published');
  assert.equal(record(good.attemptId).state, 'registered');
  assert.deepEqual([record(invalid.attemptId).state, record(invalid.attemptId).status], ['skipped', 'shots_file_invalid']);
  assert.deepEqual([record(linkedOnly.attemptId).state, record(linkedOnly.attemptId).status], ['skipped', 'conflicting_photo_links']);
  assert.equal(record(alreadyHasShots.attemptId), null);
  assert.ok(lines.some((line) => line.includes(`attempt=${good.attemptId} registered cameras=1 photos=1`)));
  assert.ok(lines.some((line) => line.includes(`attempt=${invalid.attemptId} skipped status=shots_file_invalid`)));
  assert.ok(lines.some((line) => line.includes(`attempt=${linkedOnly.attemptId} skipped status=conflicting_photo_links`)));
  assert.deepEqual(repairUndoStatements(database), [
    'PRAGMA foreign_keys=ON;',
    `DELETE FROM model_camera_photos WHERE version_id='${good.versionId}';`,
    `DELETE FROM model_assets WHERE version_id='${good.versionId}' AND kind='shots';`,
  ]);

  const [again] = await backfillProcessingCameraPositions({ ...deps, processing, attemptIds: [good.attemptId], apply: true });
  assert.equal(again.status, 'already_present');
  assert.deepEqual(rows(good.versionId), goodRows);
});

test('a thrown error is retried on later passes, then skipped with its reason', async (t) => {
  const { processing, processed, record, lines, deps } = repairFixture(t);
  const failing = processed('failing');
  const other = processed('other');
  const flaky = Object.create(processing);
  flaky.getAttempt = (id) => { if (id === failing.attemptId) throw Object.assign(new Error('busy'), { code: 'SQLITE_BUSY' }); return processing.getAttempt(id); };
  const first = await reconcileMissingCameraPositions({ ...deps, processing: flaky });
  assert.deepEqual([first.registered, first.retrying], [1, 1], 'an error in one model does not stop the others');
  assert.deepEqual([record(failing.attemptId).state, record(failing.attemptId).tries], ['retrying', 1]);
  assert.equal(record(other.attemptId).state, 'registered');
  for (let pass = 2; pass < MAX_TRANSIENT_TRIES; pass += 1) await reconcileMissingCameraPositions({ ...deps, processing: flaky });
  assert.deepEqual([record(failing.attemptId).state, record(failing.attemptId).tries], ['retrying', MAX_TRANSIENT_TRIES - 1]);
  const last = await reconcileMissingCameraPositions({ ...deps, processing: flaky });
  assert.equal(last.skipped, 1);
  assert.deepEqual([record(failing.attemptId).state, record(failing.attemptId).status, record(failing.attemptId).tries], ['skipped', 'error:SQLITE_BUSY', MAX_TRANSIENT_TRIES]);
  assert.ok(lines.some((line) => line.includes(`attempt=${failing.attemptId} skipped status=error:SQLITE_BUSY after ${MAX_TRANSIENT_TRIES} tries`)));
  assert.equal((await reconcileMissingCameraPositions({ ...deps, processing: flaky })).scanned, 0);
});

test('a missing mount does nothing, and a missing output folder is retried until it appears', async (t) => {
  const { config, processed, rows, record, deps } = repairFixture(t);
  const late = processed('late', { writeOutput: false });
  // Models mount present but empty, as when the share is not mounted yet.
  const emptyMount = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-empty-mount-'));
  t.after(() => fs.rmSync(emptyMount, { recursive: true, force: true }));
  const unmounted = new StorageManager({ ...config, modelsMount: emptyMount });
  const idle = await reconcileMissingCameraPositions({ ...deps, storage: unmounted });
  assert.equal(idle.stopped, 'storage_unreachable');
  assert.equal(record(late.attemptId), null, 'nothing is recorded while storage is unreachable');

  write(config.modelsMount, 'other/marker', 'x');
  const pending = await reconcileMissingCameraPositions(deps);
  assert.equal(pending.retrying, 1);
  assert.deepEqual([record(late.attemptId).state, record(late.attemptId).status], ['retrying', 'output_unreachable']);
  late.writeFiles();
  const done = await reconcileMissingCameraPositions(deps);
  assert.equal(done.registered, 1);
  assert.equal(record(late.attemptId).state, 'registered');
  assert.equal(rows(late.versionId).photos.length, 1);
});

test('a failure between the asset and photo-link writes leaves nothing behind', async (t) => {
  const { repository, processed, rows, record, deps } = repairFixture(t);
  const model = processed('atomic');
  const broken = Object.create(repository);
  const fail = () => { throw Object.assign(new Error('interrupted'), { code: 'SQLITE_BUSY' }); };
  broken.writeCameraPhotos = fail;
  broken.replaceCameraPhotos = fail;
  const first = await reconcileMissingCameraPositions({ ...deps, repository: broken });
  assert.equal(first.retrying, 1);
  assert.deepEqual(rows(model.versionId).assets.map((asset) => asset.kind), ['report'], 'no shots row without its links');
  assert.equal(rows(model.versionId).photos.length, 0);
  assert.equal(record(model.attemptId).state, 'retrying');
  const second = await reconcileMissingCameraPositions(deps);
  assert.equal(second.registered, 1);
  assert.equal(rows(model.versionId).photos.length, 1);
});

test('the repair record is saved with the rows, so a crash after the write keeps the undo list complete', async (t) => {
  const { database, processed, deps } = repairFixture(t);
  const model = processed('crash');
  const crashing = { log: (line) => { if (line.includes('registered')) throw new Error('process stopped'); } };
  await assert.rejects(reconcileMissingCameraPositions({ ...deps, log: crashing }), /process stopped/);
  assert.ok(repairUndoStatements(database).includes(`DELETE FROM model_camera_photos WHERE version_id='${model.versionId}';`));
});

test('an unreadable repair record stops the repair without overwriting it', async (t) => {
  const { database, processed, rows, lines, deps } = repairFixture(t);
  const model = processed('blocked');
  const key = `${REPAIR_KEY_PREFIX}some-attempt`;
  database.prepare('INSERT INTO app_state(key,value,updated_at) VALUES (?,?,?)').run(key, '{corrupt', new Date().toISOString());
  const result = await reconcileMissingCameraPositions(deps);
  assert.equal(result.stopped, 'corrupt_record');
  assert.equal(database.prepare('SELECT value FROM app_state WHERE key=?').get(key).value, '{corrupt');
  assert.deepEqual(rows(model.versionId).assets.map((asset) => asset.kind), ['report']);
  assert.ok(lines.some((line) => line.includes(`stopped, unreadable repair record ${key}`)));
});

test('archived or trashed outputs are not selected', async (t) => {
  const { processed, rows, record, deps } = repairFixture(t);
  const archived = processed('archived', { output: 'archived' });
  const trashed = processed('trashed', { output: 'trashed' });
  const ready = processed('ready', { output: 'ready' });
  const result = await reconcileMissingCameraPositions(deps);
  assert.deepEqual([result.scanned, result.registered], [1, 1]);
  for (const model of [archived, trashed]) {
    assert.deepEqual(rows(model.versionId).assets.map((asset) => asset.kind), ['report']);
    assert.equal(record(model.attemptId), null);
  }
  assert.equal(record(ready.attemptId).state, 'registered');
});
