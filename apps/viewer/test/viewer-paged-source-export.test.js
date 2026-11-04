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
const {
  captureHeldSourceExport, HeldSourceExport, frameStream, gcpEvidenceStream,
  generatedGcpFileStream, MAX_FRAME_BYTES, MAX_GCP_EVIDENCE_BYTES, MAX_GCP_CONTENT_BYTES, MAX_GCP_EVIDENCE_CHUNK_BYTES,
  GCP_EVIDENCE_DOMAIN, GCP_EVIDENCE_VERSION, GCP_FILE_DOMAIN, GCP_FILE_VERSION, SOURCE_VERSION, SOURCE_DOMAIN, SELECTED_DOMAIN,
} = require('../server/viewerPagedSourceExport');

const rawGcp = 'point_id,label,latitude,longitude,elevation_m\nA,Target,44.5,-88.1,244\n';
const rawGcpSha = crypto.createHash('sha256').update(rawGcp).digest('hex');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t, { dng = false, noGcp = false, imageCount = 1, mixedCaseSourceIds = false, badPath = null } = {}) {
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
  if (!dng && !noGcp) gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'photo-1', pixelX: 100, pixelY: 200, createdBy: 'ops:test' });
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

function assertGcpEvidenceFrames(buffer, pageHashes, pageBytes, expectedAttemptId, expectedBytes) {
  const wire = buffer.toString('utf8');
  assert.ok(wire.endsWith('\n'));
  const lines = wire.slice(0, -1).split('\n');
  assert.equal(lines.length, pageHashes.length);
  assert.equal(lines.length, pageBytes.length);
  const frames = lines.map((line, index) => {
    const frame = JSON.parse(line);
    const raw = canonicalBytes(frame);
    assert.equal(Buffer.compare(Buffer.from(line, 'utf8'), raw), 0, 'each page is canonical JCS');
    assert.equal(Buffer.byteLength(line, 'utf8'), pageBytes[index], 'signed page bytes exclude LF');
    assert.equal(sha(Buffer.concat([GCP_EVIDENCE_DOMAIN, raw])), pageHashes[index]);
    assert.ok(pageBytes[index] <= 65_535);
    assert.equal(frame.version, GCP_EVIDENCE_VERSION);
    assert.equal(frame.attemptId, expectedAttemptId);
    return frame;
  });
  const dataFrames = frames.slice(0, -1);
  const trailer = frames.at(-1);
  assert.deepEqual(Object.keys(trailer).sort(), ['attemptId', 'complete', 'evidenceSha256', 'index', 'offset', 'totalBytes', 'version'].sort());
  assert.equal(trailer.complete, true);
  assert.equal(trailer.index, dataFrames.length);
  assert.equal(trailer.offset, expectedBytes.length);
  assert.equal(trailer.totalBytes, expectedBytes.length);
  const chunks = [];
  let offset = 0;
  let digest = null;
  dataFrames.forEach((frame, index) => {
    assert.deepEqual(Object.keys(frame).sort(), ['attemptId', 'data', 'decodedByteCount', 'evidenceSha256', 'index', 'offset', 'version'].sort());
    assert.equal(frame.index, index);
    assert.equal(frame.offset, offset);
    assert.match(frame.data, /^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(frame.data, 'base64url');
    assert.equal(decoded.toString('base64url'), frame.data, 'base64url spelling is canonical and unpadded');
    assert.ok(decoded.length > 0 && decoded.length <= MAX_GCP_EVIDENCE_CHUNK_BYTES);
    assert.equal(frame.decodedByteCount, decoded.length);
    assert.equal(frame.evidenceSha256, trailer.evidenceSha256);
    chunks.push(decoded);
    offset += decoded.length;
    digest = frame.evidenceSha256;
  });
  assert.equal(offset, trailer.totalBytes);
  assert.equal(digest, sha(expectedBytes));
  const decodedBytes = Buffer.concat(chunks);
  assert.deepEqual(decodedBytes, expectedBytes);
  JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes));
  return { frames, decodedBytes };
}

function assertGcpFileFrames(buffer, pageHashes, pageBytes, expectedAttemptId, expectedEvidenceSha256, expectedBytes) {
  const wire = buffer.toString('utf8');
  assert.ok(wire.endsWith('\n'));
  const lines = wire.slice(0, -1).split('\n');
  assert.equal(lines.length, pageHashes.length);
  assert.equal(lines.length, pageBytes.length);
  const frames = lines.map((line, index) => {
    const frame = JSON.parse(line);
    const raw = canonicalBytes(frame);
    assert.equal(Buffer.compare(Buffer.from(line, 'utf8'), raw), 0, 'each GCP file page is canonical JCS');
    assert.equal(Buffer.byteLength(line, 'utf8'), pageBytes[index], 'signed page bytes exclude LF');
    assert.equal(sha(Buffer.concat([GCP_FILE_DOMAIN, raw])), pageHashes[index]);
    assert.ok(pageBytes[index] <= 65_535);
    assert.equal(frame.version, GCP_FILE_VERSION);
    assert.equal(frame.attemptId, expectedAttemptId);
    assert.equal(frame.evidenceSha256, expectedEvidenceSha256);
    return frame;
  });
  const dataFrames = frames.slice(0, -1);
  const trailer = frames.at(-1);
  assert.deepEqual(Object.keys(trailer).sort(), ['attemptId', 'complete', 'evidenceSha256', 'fileSha256', 'index', 'offset', 'totalBytes', 'version'].sort());
  assert.equal(trailer.complete, true);
  assert.equal(trailer.index, dataFrames.length);
  assert.equal(trailer.offset, expectedBytes.length);
  assert.equal(trailer.totalBytes, expectedBytes.length);
  const chunks = [];
  let offset = 0;
  let digest = null;
  dataFrames.forEach((frame, index) => {
    assert.deepEqual(Object.keys(frame).sort(), ['attemptId', 'data', 'decodedByteCount', 'evidenceSha256', 'fileSha256', 'index', 'offset', 'version'].sort());
    assert.equal(frame.index, index);
    assert.equal(frame.offset, offset);
    assert.match(frame.data, /^[A-Za-z0-9_-]+$/);
    const decoded = Buffer.from(frame.data, 'base64url');
    assert.equal(decoded.toString('base64url'), frame.data, 'base64url spelling is canonical and unpadded');
    assert.ok(decoded.length > 0 && decoded.length <= MAX_GCP_EVIDENCE_CHUNK_BYTES);
    assert.equal(frame.decodedByteCount, decoded.length);
    assert.equal(frame.fileSha256, trailer.fileSha256);
    chunks.push(decoded);
    offset += decoded.length;
    digest = frame.fileSha256;
  });
  assert.equal(offset, trailer.totalBytes);
  assert.equal(digest, sha(expectedBytes));
  const decodedBytes = Buffer.concat(chunks);
  assert.deepEqual(decodedBytes, expectedBytes);
  assert.equal(new TextDecoder('utf-8', { fatal: true }).decode(decodedBytes).length > 0, true);
  return { frames, decodedBytes };
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
  assert.equal(value.sourceCount, 5, 'sourceCount includes the retained raw GCP CSV among original dataset files');
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

  const evidenceText = f.database.prepare('SELECT evidence_json FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(f.attempt.id).evidence_json;
  const evidenceBytes = Buffer.from(evidenceText, 'utf8');
  assert.equal(value.gcpEvidenceVersion, GCP_EVIDENCE_VERSION);
  assert.equal(value.gcpEvidenceByteCount, evidenceBytes.length);
  assert.equal(value.gcpEvidenceSha256, sha(evidenceBytes));
  assert.equal(value.gcpEvidencePageCount, value.gcpEvidencePageHashes.length);
  assert.equal(value.gcpEvidencePageCount, value.gcpEvidencePageBytes.length);
  const evidence = assertGcpEvidenceFrames(value.gcpEvidenceFrames, value.gcpEvidencePageHashes,
    value.gcpEvidencePageBytes, f.attempt.id, evidenceBytes);
  assert.equal(evidence.frames.length, value.gcpEvidencePageCount);
  assert.equal(value.generatedGcp.sha256, JSON.parse(evidence.decodedBytes.toString('utf8')).snapshot.sha256,
    'the generated ODM file digest is distinct from the full evidence JSON digest');
  const storedGcpContent = f.database.prepare('SELECT content_text FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(f.attempt.id).content_text;
  const generatedFileBytes = Buffer.from(storedGcpContent, 'utf8');
  assert.equal(value.gcpFileVersion, GCP_FILE_VERSION);
  assert.equal(value.gcpFileByteCount, generatedFileBytes.length);
  assert.equal(value.gcpFileSha256, sha(generatedFileBytes));
  assert.equal(value.gcpFileSha256, value.generatedGcp.sha256);
  assert.equal(value.gcpFilePageCount, value.gcpFilePageHashes.length);
  assert.equal(value.gcpFilePageCount, value.gcpFilePageBytes.length);
  const generatedFile = assertGcpFileFrames(value.gcpFileFrames, value.gcpFilePageHashes, value.gcpFilePageBytes,
    f.attempt.id, value.gcpEvidenceSha256, generatedFileBytes);
  assert.deepEqual(generatedFile.decodedBytes, generatedFileBytes, 'the actual stored ODM file bytes are transported separately from evidence_json');
  assert.equal(value.totalStreamBytes, value.sourceFrames.length + value.selectedFrames.length
    + value.gcpEvidenceFrames.length + value.gcpFileFrames.length);
});

test('source export frames 16,832 photos with raw and generated GCP records inside the configured bounds', (t) => {
  const f = fixture(t, { imageCount: 16_832 });
  const value = captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id });
  assert.equal(value.state, 'held_authenticated_source_unavailable');
  assert.equal(value.sourceCount, 16_836, 'sourceCount includes the retained raw GCP CSV and excludes the generated GCP object');
  assert.equal(value.selectedCount, 16_834);
  assert.equal(value.sourcePageHashes.length, 33);
  assert.equal(value.selectedPageHashes.length, 33);
  assert.ok(value.sourceFrames.length <= 12 * 1024 * 1024);
  assert.ok(value.selectedFrames.length <= 12 * 1024 * 1024);
  assert.equal(assertFrames(value.sourceFrames, SOURCE_DOMAIN, value.sourcePageHashes).flatMap((frame) => frame.records).filter((record) => record.kind === 'image').length, 16_832);
});

test('attempt without immutable GCP snapshot emits all-null evidence pins', (t) => {
  const f = fixture(t, { noGcp: true });
  const value = captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id });
  assert.equal(value.generatedGcp, null);
  assert.equal(value.gcpEvidenceVersion, null);
  assert.equal(value.gcpEvidencePageHashes, null);
  assert.equal(value.gcpEvidencePageBytes, null);
  assert.equal(value.gcpEvidencePageCount, null);
  assert.equal(value.gcpEvidenceByteCount, null);
  assert.equal(value.gcpEvidenceSha256, null);
  assert.equal(value.gcpEvidenceFrames, null);
  assert.equal(value.gcpFileVersion, null);
  assert.equal(value.gcpFilePageHashes, null);
  assert.equal(value.gcpFilePageBytes, null);
  assert.equal(value.gcpFilePageCount, null);
  assert.equal(value.gcpFileByteCount, null);
  assert.equal(value.gcpFileSha256, null);
  assert.equal(value.gcpFileFrames, null);
});

test('source export rejects generated GCP content that no longer matches the attempt input inventory', (t) => {
  const f = fixture(t);
  const readSnapshot = f.processing.getAttemptGcpSnapshot.bind(f.processing);
  f.processing.getAttemptGcpSnapshot = (attemptId) => ({ ...readSnapshot(attemptId), content: 'EPSG:4326\ntampered\n' });
  assert.throws(() => captureHeldSourceExport(f.processing, { datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id }),
    (error) => error instanceof HeldSourceExport && error.code === 'attempt_input_inventory_changed');
});

test('GCP evidence stream reaches its exact byte limit and rejects overflow and invalid UTF-8', () => {
  const evidenceBytes = Buffer.alloc(MAX_GCP_EVIDENCE_BYTES, 0x20);
  evidenceBytes.write('{}', evidenceBytes.length - 2);
  const stream = gcpEvidenceStream(evidenceBytes, 'attempt-1');
  const expectedDataFrames = Math.ceil(evidenceBytes.length / MAX_GCP_EVIDENCE_CHUNK_BYTES);
  assert.equal(stream.pageCount, expectedDataFrames + 1, 'the mandatory completion trailer is signed as its own page');
  assert.equal(stream.pageHashes.length, stream.pageCount);
  assert.equal(stream.pageBytes.length, stream.pageCount);
  assert.ok(stream.streamBytes <= 24 * 1024 * 1024);
  assert.equal(stream.bytes.length, stream.streamBytes, 'stream budget includes one LF for every page');
  assertGcpEvidenceFrames(stream.bytes, stream.pageHashes, stream.pageBytes, 'attempt-1', evidenceBytes);
  assert.throws(() => gcpEvidenceStream(Buffer.alloc(MAX_GCP_EVIDENCE_BYTES + 1, 0x20), 'attempt-1'),
    (error) => error instanceof HeldSourceExport && error.code === 'gcp_evidence_stream_invalid');
  assert.throws(() => gcpEvidenceStream(Buffer.from([0xff]), 'attempt-1'),
    (error) => error instanceof HeldSourceExport && error.code === 'gcp_evidence_utf8_invalid');
});

test('generated ODM GCP file stream pins exact file bytes to its evidence snapshot and fails closed on invalid inputs', () => {
  const fileBytes = Buffer.from('EPSG:4326\n-88.1 44.5 244 100 200 IMG_01.jpg\n', 'utf8');
  const evidenceSha256 = 'e'.repeat(64);
  const stream = generatedGcpFileStream(fileBytes, 'attempt-1', evidenceSha256);
  assert.equal(stream.sha256, sha(fileBytes));
  assert.equal(stream.evidenceSha256, evidenceSha256);
  assert.equal(stream.bytes.length, stream.streamBytes);
  assert.ok(stream.streamBytes <= 24 * 1024 * 1024);
  assertGcpFileFrames(stream.bytes, stream.pageHashes, stream.pageBytes, 'attempt-1', evidenceSha256, fileBytes);
  assert.throws(() => generatedGcpFileStream(Buffer.alloc(MAX_GCP_CONTENT_BYTES + 1, 0x20), 'attempt-1', evidenceSha256),
    (error) => error instanceof HeldSourceExport && error.code === 'gcp_file_stream_invalid');
  assert.throws(() => generatedGcpFileStream(Buffer.from([0xff]), 'attempt-1', evidenceSha256),
    (error) => error instanceof HeldSourceExport && error.code === 'gcp_file_utf8_invalid');
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
