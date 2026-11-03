'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { GcpRepository } = require('../server/gcpRepository');
const { canonicalBytes } = require('../server/referenceProtocol');
const { captureHeldSourceExport, HeldSourceExport, frameStream, MAX_FRAME_BYTES, SOURCE_VERSION, SOURCE_DOMAIN, SELECTED_DOMAIN } = require('../server/viewerPagedSourceExport');

const rawGcp = 'point_id,label,latitude,longitude,elevation_m\nA,Target,44.5,-88.1,244\n';
const rawGcpSha = crypto.createHash('sha256').update(rawGcp).digest('hex');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { dng = false, imageCount = 1, mixedCaseSourceIds = false, badPath = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-paged-source-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const gcp = new GcpRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = processing.createProject({ displayName: 'Source export fixture' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Survey', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const photoPath = dng ? 'flight/IMG_01.dng' : 'flight/IMG_01.jpg';
  const photoType = dng ? 'image/x-adobe-dng' : 'image/jpeg';
  const files = [
    ...Array.from({ length: imageCount }, (_, index) => ({
      id: `photo-${index + 1}`, relativePath: index === 0 && badPath ? badPath : dng ? photoPath : `flight/IMG_${String(index + 1).padStart(5, '0')}.jpg`,
      byteSize: 10, sha256: 'a'.repeat(64), contentType: photoType,
      metadata: { width: 4000, height: 3000 },
    })),
    { id: 'control', relativePath: 'control/raw.csv', byteSize: Buffer.byteLength(rawGcp), sha256: rawGcpSha, contentType: 'text/csv' },
    ...(mixedCaseSourceIds ? [{ id: 'Control', relativePath: 'control/second.csv', byteSize: Buffer.byteLength(rawGcp), sha256: rawGcpSha, contentType: 'text/csv' }] : []),
    { id: 'lidar', relativePath: 'survey/site.las', byteSize: 11, sha256: 'b'.repeat(64), contentType: 'application/vnd.las', processingRole: 'provider_input' },
    { id: 'old-gcp', relativePath: 'legacy/gcp_list.txt', byteSize: 9, sha256: 'c'.repeat(64), contentType: 'text/plain', processingRole: 'provider_input' },
  ];
  processing.finalizeDataset(dataset.id, files, 'd'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'ODM task' });
  const set = gcp.importSet({
    datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceFileId: 'control',
    sourceFilename: 'raw.csv', sourceSha256: rawGcpSha, sourceContent: rawGcp, crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:test',
    points: [{ externalId: 'A', label: 'Target', latitude: 44.5, longitude: -88.1, elevationM: 244, description: null }],
  });
  if (!dng) gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'photo-1', pixelX: 100, pixelY: 200, createdBy: 'ops:test' });
  if (mixedCaseSourceIds) {
    const second = gcp.importSet({ datasetId: dataset.id, displayName: 'Control B', sourceFormat: 'generic-csv-v1', sourceFileId: 'Control',
      sourceFilename: 'second.csv', sourceSha256: rawGcpSha, sourceContent: rawGcp, crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:test',
      points: [{ externalId: 'B', label: 'Target B', latitude: 44.6, longitude: -88.2, elevationM: 245, description: null }] });
    gcp.createCorrespondence({ taskId: task.id, pointId: second.points[0].id, imageFileId: 'photo-1', pixelX: 101, pixelY: 201, createdBy: 'ops:test' });
  }
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  return { database, processing, project, dataset, task, attempt };
}

function assertFrames(buffer, domain, pins) {
  const lines = buffer.toString('utf8').trimEnd().split('\n');
  assert.equal(lines.length, pins.length);
  return lines.map((line, index) => {
    const frame = JSON.parse(line);
    const raw = canonicalBytes(frame);
    assert.equal(frame.index, index);
    assert.equal(sha(Buffer.concat([domain, raw])), pins[index]);
    return frame;
  });
}

test('source export binds real Viewer rows and attempt GCP evidence in one held read transaction', (t) => {
  const f = fixture(t);
  const expectedInputHash = f.processing.getAttemptProvenance(f.attempt.id).submission.inputManifestSha256;
  let checkedReads = 0;
  for (const method of ['getDataset', 'getTask', 'getAttempt', 'getProject', 'getAttemptProvenance', 'getAttemptGcpSnapshot', 'getAttemptGcpEvidence']) {
    const original = f.processing[method].bind(f.processing);
    f.processing[method] = (...args) => { assert.equal(f.database.isTransaction, true, `${method} must run in the snapshot transaction`); checkedReads++; return original(...args); };
  }

  const value = captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id });
  assert.equal(f.database.isTransaction, false);
  assert.ok(checkedReads >= 7);
  assert.equal(value.state, 'held_authenticated_source_unavailable');
  assert.equal(value.enabled, false);
  assert.equal(value.authority, null);
  assert.equal(value.principal, null);
  assert.equal(value.revocationEpoch, null);
  assert.equal(value.inputManifestSha256, expectedInputHash);
  assert.equal(value.sourceCount, 5, 'raw source files plus the immutable generated GCP record');
  assert.equal(value.selectedCount, 3, 'photo first, LiDAR, then generated GCP; old gcp_list.txt is replaced');

  const sourceFrames = assertFrames(value.sourceFrames, SOURCE_DOMAIN, value.sourcePageHashes);
  const selectedFrames = assertFrames(value.selectedFrames, SELECTED_DOMAIN, value.selectedPageHashes);
  const sourceRecords = sourceFrames.flatMap((frame) => frame.records);
  const selectedRecords = selectedFrames.flatMap((frame) => frame.records);
  assert.equal(sourceRecords.find((record) => record.datasetFileId === 'lidar').kind, 'lidar');
  assert.equal(sourceRecords.filter((record) => record.type === 'attempt_generated_gcp').length, 1);
  assert.deepEqual(selectedRecords.map((record) => record.type), ['dataset_file', 'dataset_file', 'attempt_generated_gcp']);
  assert.deepEqual(selectedRecords.slice(0, 2).map((record) => record.datasetFileId), ['photo-1', 'lidar']);
  assert.equal(selectedRecords[2].pageObjectId, `gcp_${f.attempt.id}`);
  assert.equal(selectedRecords[2].mediaType, 'text/plain');
  assert.equal(value.generatedGcp.sourceFiles[0].datasetFileId, 'control');
});

test('source export frames 16,832 photos with raw and generated GCP records inside the configured bounds', (t) => {
  const f = fixture(t, { imageCount: 16_832 });
  const value = captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id });
  assert.equal(value.state, 'held_authenticated_source_unavailable');
  assert.equal(value.sourceCount, 16_836);
  assert.equal(value.selectedCount, 16_834);
  assert.equal(value.sourcePageHashes.length, 33);
  assert.equal(value.selectedPageHashes.length, 33);
  assert.ok(value.sourceFrames.length <= 12 * 1024 * 1024);
  assert.ok(value.selectedFrames.length <= 12 * 1024 * 1024);
  assert.equal(assertFrames(value.sourceFrames, SOURCE_DOMAIN, value.sourcePageHashes).flatMap((frame) => frame.records).filter((record) => record.kind === 'image').length, 16_832);
});

test('source export rejects a stale, missing, or non-current attempt without creating a route', (t) => {
  const f = fixture(t);
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: crypto.randomUUID() }),
    (error) => error instanceof HeldSourceExport && error.code === 'current_attempt_unavailable');
  f.processing.cancelAttempt(f.attempt.id);
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id }),
    (error) => error instanceof HeldSourceExport && error.code === 'current_attempt_unavailable');
});

test('source export refuses to roll back a caller-owned SQLite transaction', (t) => {
  const f = fixture(t);
  f.database.exec('BEGIN');
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id }),
    (error) => error instanceof HeldSourceExport && error.code === 'read_transaction_unavailable');
  assert.equal(f.database.isTransaction, true);
  f.database.exec('ROLLBACK');
});

test('frame writer accepts an exact 256 KiB canonical page and rejects one byte over', () => {
  const version = SOURCE_VERSION;
  const emptyFrameBytes = canonicalBytes({ version, index: 0, records: [] }).length;
  const emptyRecordBytes = canonicalBytes({ value: '' }).length;
  const textLength = MAX_FRAME_BYTES - emptyFrameBytes - emptyRecordBytes;
  const exact = frameStream([{ value: 'x'.repeat(textLength) }], version, SOURCE_DOMAIN);
  assert.equal(exact.frames.length, 1);
  assert.equal(exact.frames[0].bytes.length, MAX_FRAME_BYTES + 1, 'the LF delimiter is additional to the exact raw-frame limit');
  assert.throws(() => frameStream([{ value: 'x'.repeat(textLength + 1) }], version, SOURCE_DOMAIN),
    (error) => error instanceof HeldSourceExport && error.code === 'source_record_limit');
});

test('source export holds unsupported image media rather than relabeling bytes', (t) => {
  const f = fixture(t, { dng: true });
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id }),
    (error) => error instanceof HeldSourceExport && error.code === 'unsupported_image_media_type');
  assert.equal(f.database.isTransaction, false);
});

test('source GCP references use protocol code-point ordering for mixed-case file IDs', (t) => {
  const f = fixture(t, { mixedCaseSourceIds: true });
  const value = captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id });
  const generated = assertFrames(value.sourceFrames, SOURCE_DOMAIN, value.sourcePageHashes)
    .flatMap((frame) => frame.records).find((record) => record.type === 'attempt_generated_gcp');
  assert.deepEqual(generated.sourceFiles.map((file) => file.datasetFileId), ['Control', 'control']);
});

test('source export rejects drive-rooted paths that Processing will not accept', (t) => {
  const f = fixture(t, { badPath: 'C:/flight/IMG_00001.jpg' });
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id }),
    (error) => error instanceof HeldSourceExport && error.code === 'unsupported_source_file');
});
