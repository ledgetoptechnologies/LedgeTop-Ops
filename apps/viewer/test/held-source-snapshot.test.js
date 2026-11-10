'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const {
  createHeldSourceSnapshot, getHeldSourceSnapshot, verifyHeldSourceSnapshot,
  acceptHeldSourceSnapshot, releaseHeldSourceSnapshot,
} = require('../server/heldSourceSnapshot');

function fixture(t, { withGcp = false, correspondGcp = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-viewer-source-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = processing.createProject({ displayName: 'Held source fixture' });
  const dataset = processing.createDataset({
    projectId: project.id, displayName: 'Flight', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID(),
  });
  const content = 'point_id,label,latitude,longitude,elevation_m\nA,Target,44.5,-88.1,244\n';
  const gcpSha256 = crypto.createHash('sha256').update(content).digest('hex');
  const files = [{ id: 'photo-1', relativePath: 'flight/photo.jpg', byteSize: 12, sha256: 'a'.repeat(64), contentType: 'image/jpeg' }];
  if (withGcp) files.push({ id: 'gcp-file', relativePath: 'control.csv', byteSize: Buffer.byteLength(content), sha256: gcpSha256, contentType: 'text/csv' });
  processing.finalizeDataset(dataset.id, files, 'b'.repeat(64));
  if (withGcp) {
    const { GcpRepository } = require('../server/gcpRepository');
    const gcp = new GcpRepository(database);
    const set = gcp.importSet({ datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceFileId: 'gcp-file',
      sourceFilename: 'control.csv', sourceSha256: gcpSha256, sourceContent: content, crs: 'EPSG:4326', elevationUnits: 'm',
      createdBy: 'ops:test', points: [{ externalId: 'A', label: 'Target', latitude: 44.5, longitude: -88.1, elevationM: 244, description: null }] });
    const { recordScan } = require('../server/gcpScanLedger');
    processing.transaction(() => recordScan(database, { datasetId: dataset.id, fileId: 'gcp-file', sha256: gcpSha256, outcome: 'imported', setId: set.id, pointCount: 1 }));
    const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'ODM task' });
    if (correspondGcp) gcp.createCorrespondence({ taskId: task.id,
      pointId: set.points[0].id, imageFileId: 'photo-1', pixelX: 10, pixelY: 20, createdBy: 'ops:test' });
  }
  const task = withGcp
    ? processing.database.prepare('SELECT id FROM processing_tasks WHERE dataset_id=?').get(dataset.id).id
    : processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'ODM task' }).id;
  const taskRecord = processing.getTask(task);
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = withGcp && !correspondGcp ? null : processing.createAttempt({ taskId: taskRecord.id, providerId: provider.id, options: {}, preparedGcp: withGcp });
  return { database, processing, project, dataset, task: taskRecord, attempt, provider };
}

test('source snapshot is signed, immutable, nonreusable, and holds its dataset until verified downstream acceptance', (t) => {
  const { database, processing, project, dataset, task, attempt } = fixture(t);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = { issuerId: 'viewer-test-issuer', keyId: 'test-key-1', sign: (bytes) => crypto.sign(null, bytes, privateKey) };
  const snapshotId = 'b7c3e491-d0b9-4a1a-9d0c-f0d52b622377';
  const created = createHeldSourceSnapshot(processing, {
    datasetId: dataset.id, taskId: task.id, attemptId: attempt.id, snapshotId, signer,
    now: () => '2026-11-03T12:00:00.000Z',
  });

  assert.equal(created.status, 'held');
  const stored = getHeldSourceSnapshot(processing, snapshotId);
  assert.ok(verifyHeldSourceSnapshot(created, publicKey));
  assert.ok(verifyHeldSourceSnapshot(stored, publicKey));
  const changedFrames = { ...stored, sourceFrames: Buffer.from(stored.sourceFrames) };
  changedFrames.sourceFrames[0] ^= 1;
  assert.equal(verifyHeldSourceSnapshot(changedFrames, publicKey), false, 'persisted frame tampering invalidates the snapshot');
  assert.equal(verifyHeldSourceSnapshot({ ...stored, sourcePageHashes: ['0'.repeat(64)] }, publicKey), false,
    'frame hashes must equal the descriptors covered by the signed intent');
  assert.equal(verifyHeldSourceSnapshot({ ...stored, attemptId: 'another-attempt' }, publicKey), false,
    'snapshot identity must equal the signed attempt identity');
  assert.throws(() => database.prepare('INSERT OR REPLACE INTO viewer_source_snapshots SELECT * FROM viewer_source_snapshots WHERE snapshot_id=?').run(snapshotId),
    /never reusable or replaceable/);
  assert.equal(processing.hasRetainedSourceSnapshot(dataset.id), true);
  assert.equal(processing.beginTrashMutation(dataset.id, 'ops:test'), null);
  assert.equal(processing.trashProject(project.id, 'ops:test'), null);
  assert.equal(processing.trashTask(task.id, 'ops:test'), null);
  const trashId = crypto.randomUUID(), timestamp = new Date().toISOString();
  database.prepare("UPDATE datasets SET status='trashed',trashed_at=?,updated_at=? WHERE id=?").run(timestamp, timestamp, dataset.id);
  database.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,purge_after,created_at) VALUES (?,'dataset',?,'trash','dataset/source-held',?,?)")
    .run(trashId, dataset.id, new Date(Date.now() + 60_000).toISOString(), timestamp);
  assert.equal(processing.beginPurgeMutation(trashId, 'ops:test'), null, 'a pre-existing trash row cannot purge held source data');
  assert.throws(() => createHeldSourceSnapshot(processing, {
    datasetId: dataset.id, taskId: task.id, attemptId: attempt.id,
    snapshotId: 'f3f4a9f2-11a2-4864-aa5c-b2060accc39c', signer,
  }), { code: 'snapshot_identity_reused' });
  const receipt = { snapshotId, downstreamJobId: 'job-1', signature: 'test-receipt-signature' };
  assert.equal(releaseHeldSourceSnapshot(processing, snapshotId, { verifyAcceptance: () => true }), null,
    'a snapshot cannot release before acceptance');
  assert.equal(acceptHeldSourceSnapshot(processing, snapshotId, { receipt }), null,
    'an unverified downstream receipt cannot lift the source hold');
  const accepted = acceptHeldSourceSnapshot(processing, snapshotId, {
    receipt, verifyAcceptance: (snapshot, observedReceipt) => snapshot.snapshotId === snapshotId && observedReceipt === receipt,
  });
  assert.equal(accepted.status, 'accepted');
  assert.deepEqual(accepted.acceptanceReceipt, receipt);
  assert.equal(processing.hasRetainedSourceSnapshot(dataset.id), true, 'acceptance alone keeps the source retained');
  assert.equal(releaseHeldSourceSnapshot(processing, snapshotId, {
    verifyAcceptance: () => false,
  }), null, 'the release receipt must match the accepted receipt');
  const released = releaseHeldSourceSnapshot(processing, snapshotId, {
    verifyAcceptance: (snapshot, observedReceipt) => snapshot.snapshotId === snapshotId && observedReceipt.downstreamJobId === 'job-1',
  });
  assert.equal(released.status, 'released');
  assert.equal(processing.hasRetainedSourceSnapshot(dataset.id), true, 'release records a verified handoff but keeps the Viewer source permanently retained');
  assert.equal(processing.hasDatasetRetentionHold(dataset.id), true);
  assert.equal(processing.trashTask(task.id, 'ops:test'), null, 'released snapshots continue blocking task trash');
  assert.equal(processing.trashProject(project.id, 'ops:test'), null, 'released snapshots continue blocking project trash');
  assert.equal(processing.beginPurgeMutation(trashId, 'ops:test'), null, 'pre-existing trash rows cannot purge a released snapshot source');
  assert.throws(() => database.prepare('DELETE FROM viewer_source_snapshots WHERE snapshot_id=?').run(snapshotId), /never reusable/);
  assert.throws(() => database.prepare("UPDATE viewer_source_snapshots SET status='held' WHERE snapshot_id=?").run(snapshotId), /lifecycle transition/);
});

test('source snapshot creation rejects a dataset with an in-flight filesystem lifecycle journal', (t) => {
  const { database, processing, dataset, task, attempt } = fixture(t);
  const timestamp = new Date().toISOString();
  database.prepare(`INSERT INTO storage_mutations
    (id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,
     destination_root_key,destination_relative_path,status,actor,created_at,updated_at)
    VALUES (?,'trash','dataset',?,?,'datasets',?,'trash',?,'fs_applied','ops:test',?,?)`)
    .run(crypto.randomUUID(), dataset.id, crypto.randomUUID(), dataset.relativePath, 'dataset/in-flight', timestamp, timestamp);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => createHeldSourceSnapshot(processing, {
    datasetId: dataset.id, taskId: task.id, attemptId: attempt.id,
    signer: { issuerId: 'viewer-test-issuer', keyId: 'test-key-1', sign: (bytes) => crypto.sign(null, bytes, privateKey) },
  }), { code: 'current_attempt_unavailable' });
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM viewer_source_snapshots').get().n, 0);
});

test('snapshot binds raw GCP evidence and generated NodeODM file into the held source proof', (t) => {
  const { processing, dataset, task, attempt } = fixture(t, { withGcp: true });
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const signer = { issuerId: 'viewer-test-issuer', keyId: 'test-key-1', sign: (bytes) => crypto.sign(null, bytes, privateKey) };
  const snapshot = createHeldSourceSnapshot(processing, {
    datasetId: dataset.id, taskId: task.id, attemptId: attempt.id, signer,
  });
  assert.equal(snapshot.status, 'held');
  const sourceCount = processing.getDataset(dataset.id, true).fileCount;
  assert.equal(snapshot.intent.datasetFileCount, sourceCount);
  assert.equal(snapshot.intent.sourceCount, sourceCount + 1, 'the signed source stream includes its generated GCP file');
  assert.ok(snapshot.intent.gcp.evidenceSha256);
  assert.ok(snapshot.intent.gcp.fileSha256);
  assert.equal(snapshot.intent.gcp.generatedGcp.attemptId, attempt.id);
  assert.equal(snapshot.intent.gcp.generatedGcp.sha256, snapshot.intent.gcp.fileSha256);
  assert.ok(snapshot.gcpEvidenceFrames.length > 0);
  assert.ok(snapshot.gcpFileFrames.length > 0);
  assert.ok(verifyHeldSourceSnapshot(snapshot, publicKey));
  const changedEvidence = { ...snapshot, gcpEvidenceFrames: Buffer.from(snapshot.gcpEvidenceFrames) };
  changedEvidence.gcpEvidenceFrames[0] ^= 1;
  assert.equal(verifyHeldSourceSnapshot(changedEvidence, publicKey), false, 'GCP evidence bytes are signed and immutable');
  const changedFile = { ...snapshot, gcpFileFrames: Buffer.from(snapshot.gcpFileFrames) };
  changedFile.gcpFileFrames[0] ^= 1;
  assert.equal(verifyHeldSourceSnapshot(changedFile, publicKey), false, 'generated GCP bytes are signed and immutable');
  assert.equal(processing.hasRetainedSourceSnapshot(dataset.id), true);
});

test('raw GCP source without task correspondences cannot start an attempt', (t) => {
  const { processing, dataset, task, provider } = fixture(t, { withGcp: true, correspondGcp: false });
  assert.throws(() => processing.createAttempt({ taskId: task.id, providerId: provider.id, preparedGcp: true }),
    { code: 'gcp_correspondences_required' });
  assert.equal(processing.hasRetainedGcpSource(dataset.id), true, 'the original GCP CSV remains in permanent custody');
  assert.equal(processing.hasRetainedSourceSnapshot(dataset.id), false);
});
