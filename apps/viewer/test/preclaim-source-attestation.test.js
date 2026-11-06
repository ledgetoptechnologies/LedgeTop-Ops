'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { createHeldSourceSnapshot } = require('../server/heldSourceSnapshot');
const { PreparedSubmissionOutbox } = require('../server/preparedSubmissionOutbox');
const ReferenceProtocol = require('../server/referenceProtocol');
const { captureHeldSourceExport, SOURCE_DOMAIN, SOURCE_VERSION, SELECTED_DOMAIN, SELECTED_VERSION } = require('../server/viewerPagedSourceExport');
const { DOMAIN, createPreclaimSourceAttestation } = require('../server/preclaimSourceAttestation');

const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111';
const SNAPSHOT_DOMAIN = Buffer.from('ltds-viewer-held-source-snapshot-v1\0', 'ascii');

function createSignedIncompleteSnapshot(processing, dataset, task, attempt, signer, privateKey, { omitSource = false } = {}) {
  const exported = captureHeldSourceExport(processing, { datasetId: dataset.id, taskId: task.id, attemptId: attempt.id });
  const sourceRecords = JSON.parse(exported.sourceFrames.toString('utf8').trim().split('\n')[0]).records;
  const firstSelected = JSON.parse(exported.selectedFrames.toString('utf8').trim().split('\n')[0]).records[0];
  let sourceFrames = exported.sourceFrames;
  let sourcePageHashes = exported.sourcePageHashes;
  let sourceCount = exported.sourceCount;
  if (omitSource) {
    const sourceIntent = { version: SOURCE_VERSION, index: 0, records: [sourceRecords[0]] };
    const sourceRaw = ReferenceProtocol.canonicalBytes(sourceIntent);
    sourceFrames = Buffer.concat([sourceRaw, Buffer.from('\n')]);
    sourcePageHashes = [ReferenceProtocol.sha256(Buffer.concat([SOURCE_DOMAIN, sourceRaw]))];
    sourceCount = 1;
  }
  const selectedIntent = { version: SELECTED_VERSION, index: 0, records: [firstSelected] };
  const selectedBytes = Buffer.concat([ReferenceProtocol.canonicalBytes(selectedIntent), Buffer.from('\n')]);
  const selectedPageHash = ReferenceProtocol.sha256(Buffer.concat([SELECTED_DOMAIN, ReferenceProtocol.canonicalBytes(selectedIntent)]));
  const sourceFiles = [{ relativePath: 'flight/photo.jpg', byteSize: 21, sha256: crypto.createHash('sha256').update('synthetic-photo-bytes').digest('hex') }];
  const now = new Date().toISOString();
  const intent = {
    protocol: 'ltds-viewer-held-source-snapshot-v1', snapshotId: crypto.randomUUID(),
    issuerId: signer.issuerId, keyId: signer.keyId, createdAt: now,
    datasetId: dataset.id, datasetManifestSha256: exported.datasetManifestSha256,
    taskId: task.id, attemptId: attempt.id,
    inputManifestSha256: crypto.createHash('sha256').update(JSON.stringify(sourceFiles)).digest('hex'),
    datasetFileCount: processing.getDataset(dataset.id, true).fileCount, sourceCount, sourcePageHashes,
    sourceFrameBytes: sourceFrames.length, selectedCount: 1,
    selectedPageHashes: [selectedPageHash], selectedFrameBytes: selectedBytes.length, gcp: null,
  };
  const intentBytes = ReferenceProtocol.canonicalBytes(intent);
  const signature = crypto.sign(null, Buffer.concat([SNAPSHOT_DOMAIN, intentBytes]), privateKey);
  processing.database.prepare(`INSERT INTO viewer_source_snapshots(
    snapshot_id,dataset_id,task_id,attempt_id,dataset_manifest_sha256,input_manifest_sha256,
    intent_json,intent_sha256,issuer_id,key_id,signature,source_frames,selected_frames,
    source_page_hashes_json,selected_page_hashes_json,source_frame_bytes,selected_frame_bytes,status,created_at
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'held',?)`).run(
    intent.snapshotId, dataset.id, task.id, attempt.id, intent.datasetManifestSha256, intent.inputManifestSha256,
    intentBytes.toString('utf8'), crypto.createHash('sha256').update(intentBytes).digest('hex'), signer.issuerId, signer.keyId,
    signature, sourceFrames, selectedBytes, JSON.stringify(sourcePageHashes), JSON.stringify([selectedPageHash]),
    sourceFrames.length, selectedBytes.length, now,
  );
}

function fixture(t, { accept = false, gcp = false, secondPhoto = false, incompleteSelection = false, incompleteSource = false, photoRole = undefined } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-preclaim-attestation-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = processing.createProject({ displayName: 'Preclaim test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets' });
  const photoHash = crypto.createHash('sha256').update('synthetic-photo-bytes').digest('hex');
  const files = [{ id: 'photo-1', relativePath: 'flight/photo.jpg', byteSize: 21, sha256: photoHash, contentType: 'image/jpeg', ...(photoRole ? { processingRole: photoRole } : {}) }];
  const gcpContent = 'point_id,label,latitude,longitude,elevation_m\nGCP-01,Target,44.5,-88.1,244\n';
  const gcpHash = crypto.createHash('sha256').update(gcpContent).digest('hex');
  if (secondPhoto) files.push({ id: 'photo-2', relativePath: 'flight/photo-2.jpg', byteSize: 22, sha256: 'a'.repeat(64), contentType: 'image/jpeg' });
  if (gcp) files.push({ id: 'gcp-source', relativePath: 'control.csv', byteSize: Buffer.byteLength(gcpContent), sha256: gcpHash, contentType: 'text/csv', processingRole: 'gcp_source' });
  processing.finalizeDataset(dataset.id, files, 'b'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'ODM task' });
  if (gcp) {
    const { GcpRepository } = require('../server/gcpRepository');
    const repository = new GcpRepository(database);
    const set = repository.importSet({ datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1',
      sourceFileId: 'gcp-source', sourceFilename: 'control.csv', sourceSha256: gcpHash, sourceContent: gcpContent,
      crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:test',
      points: [{ externalId: 'GCP-01', label: 'Target', latitude: 44.5, longitude: -88.1, elevationM: 244, description: null }] });
    repository.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'photo-1', pixelX: 10, pixelY: 20, createdBy: 'ops:test' });
  }
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Test ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, capabilityFingerprint: 'capability-test' });
  const job = processing.claimJob('preclaim-test-owner');
  const outbox = new PreparedSubmissionOutbox(database);
  const snapshotKeys = crypto.generateKeyPairSync('ed25519');
  const snapshotSigner = { issuerId: 'viewer-snapshot-issuer', keyId: 'snapshot-key', sign: bytes => crypto.sign(null, bytes, snapshotKeys.privateKey) };
  if (incompleteSelection || incompleteSource) createSignedIncompleteSnapshot(processing, dataset, task, attempt, snapshotSigner, snapshotKeys.privateKey, { omitSource: incompleteSource });
  else createHeldSourceSnapshot(processing, { datasetId: dataset.id, taskId: task.id, attemptId: attempt.id, signer: snapshotSigner });

  const capabilities = ReferenceProtocol.createCapabilities('staging');
  const sourceObjects = [{ id: 'photo-1', name: 'photo.jpg', byteSize: 21, sha256: photoHash, kind: 'image', mediaType: 'image/jpeg' }];
  const attemptGcp = gcp ? processing.getAttemptGcpSnapshot(attempt.id) : null;
  if (attemptGcp) sourceObjects.push({ id: `gcp_${attempt.id}`, name: 'gcp_list.txt', byteSize: Buffer.byteLength(attemptGcp.content),
    sha256: attemptGcp.sha256, kind: 'auxiliary', mediaType: 'text/plain' });
  const manifest = { id: dataset.id, revision: 1, totalBytes: sourceObjects.reduce((sum, object) => sum + object.byteSize, 0),
    objectCount: sourceObjects.length, inputCounts: { images: 1, lidarObjects: 0, points: 0 }, objects: sourceObjects, sha256: '0'.repeat(64) };
  manifest.sha256 = ReferenceProtocol.manifestSha256(manifest);
  const submission = {
    schemaVersion: 1, submissionId: attempt.id, manifest,
    pipeline: {
      odm: { requested: true, options: {}, optionsFingerprint: capabilities.engines.odm.optionsFingerprint },
      treedar: { requested: false, inputObjectIds: [], provenanceReceiptId: null }, gaussian_splat: { requested: false },
    }, capabilityFingerprint: capabilities.capabilityFingerprint,
  };
  const envelope = { schemaVersion: 3, protocol: 'ltds-viewer-prepared-envelope-jcs-v3', submission, viewerTaskId: task.id, viewerAttemptId: attempt.id, activationId: crypto.randomUUID() };
  const intent = outbox.persistIntent({
    localJobId: job.id, owner: job.lease_owner, origin: 'https://processing.example', authorityId: AUTHORITY_ID,
    principalId: 'viewer-staging', environment: 'staging', envelope,
  });
  const response = {
    authorityId: AUTHORITY_ID, jobId: 'processing-job-1', generation: 1, environment: 'staging',
    manifestSha256: manifest.sha256, pipelineDigest: 'd'.repeat(64), submissionId: intent.submissionId,
    envelopeSha256: intent.envelopeSha256, viewerTaskId: task.id, viewerAttemptId: attempt.id,
    activationId: envelope.activationId,
  };
  if (accept) outbox.acceptRemoteBinding(attempt.id, response, { environment: 'staging', localJobId: job.id, owner: job.lease_owner });
  const attestationKeys = crypto.generateKeyPairSync('ed25519');
  const signer = { issuerId: 'viewer-preclaim-issuer', keyId: 'preclaim-key', publicKey: attestationKeys.publicKey,
    sign: bytes => crypto.sign(null, bytes, attestationKeys.privateKey) };
  return { processing, outbox, attempt, task, dataset, snapshotKeys, signer, capabilities, response, pipeline: submission.pipeline };
}

test('preclaim signer binds a locally prepared envelope to the held source snapshot without a prior V1 job', t => {
  const f = fixture(t);
  const result = createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  });
  const canonical = require('../server/preparedSubmissionOutbox').canonicalizeJcs(result.proof);
  assert.deepEqual(result.raw, canonical);
  assert.deepEqual(Object.keys(result.sourceAttestation).sort(), ['attestationSha256', 'proof', 'signature']);
  assert.equal(result.sourceAttestation.signature, result.signature.toString('base64url'));
  assert.equal(result.sourceAttestation.attestationSha256, result.attestationSha256);
  assert.equal(Object.keys(result.proof).sort().join(','), 'activationId,authorityId,derivedManifestSha256,environment,issuerId,keyId,pipelineDigest,pipelineManifestSha256,preparedEnvelopeSha256,principalId,protocol,providerTaskId,schemaVersion,sourceManifestSha256,sourceSnapshotSha256,submissionId,viewerAttemptId,viewerTaskId');
  assert.equal(result.proof.submissionId, f.attempt.id);
  assert.equal(result.proof.viewerAttemptId, f.attempt.id);
  assert.equal(result.proof.viewerTaskId, f.task.id);
  assert.equal(result.proof.providerTaskId, f.attempt.providerTaskId);
  assert.deepEqual(Object.keys(result.sourceIntakeRequest).sort(), [
    'capabilityFingerprint', 'derivedManifest', 'manifest', 'pipeline', 'providerTaskId',
    'schemaVersion', 'sourceAttestation', 'sourceManifest', 'submissionId', 'viewerTaskId',
  ]);
  assert.equal(result.sourceIntakeRequest.viewerTaskId, f.task.id);
  assert.equal(result.sourceIntakeRequest.submissionId, f.attempt.id);
  assert.equal(result.sourceIntakeRequest.providerTaskId, f.attempt.providerTaskId);
  const { MAX_SOURCE_INTAKE_V2_CANONICAL_NODES, MAX_SOURCE_INTAKE_V2_METADATA_BYTES } =
    require('../server/sourceIntakeLimitsV2');
  assert.deepEqual(Buffer.from(result.sourceIntakeCanonical, 'utf8'),
    require('../server/preparedSubmissionOutbox').canonicalizeJcs(result.sourceIntakeRequest, {
      maxBytes: MAX_SOURCE_INTAKE_V2_METADATA_BYTES,
      maxNodes: MAX_SOURCE_INTAKE_V2_CANONICAL_NODES,
    }), 'the actual preclaim producer serializes its POST body under explicit V2 limits');
  assert.equal(result.proof.pipelineManifestSha256, f.response.manifestSha256);
  assert.equal(result.sourceManifest.sha256, result.proof.sourceManifestSha256);
  assert.equal(result.derivedManifest.sha256, result.proof.derivedManifestSha256);
  assert.equal(result.proof.pipelineDigest, crypto.createHash('sha256')
    .update(require('../server/preparedSubmissionOutbox').canonicalizeJcs(f.pipeline)).digest('hex'));
  assert.throws(() => createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'untrusted-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  }), { code: 'preclaim_snapshot_signer_mismatch' });
  assert.equal(crypto.verify(null, Buffer.concat([DOMAIN, result.raw]), f.signer.publicKey, result.signature), true);
  assert.equal(result.attestationSha256, crypto.createHash('sha256').update(Buffer.concat([DOMAIN, result.raw])).digest('hex'));
  const replay = createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer',
    expectedSnapshotKeyId: 'snapshot-key', signer: f.signer, authorityId: AUTHORITY_ID,
    principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  });
  assert.deepEqual(replay.sourceIntakeCanonical, result.sourceIntakeCanonical,
    'same held source and attempt produce the byte-identical V2 POST body');
  assert.equal(f.processing.hasHeldSourceSnapshot(f.dataset.id), true, 'proof creation must not release held source data');
});

test('preclaim signer uses the prepared intent and retains GCP source plus derived input', t => {
  const pending = fixture(t, { accept: false });
  const pendingArgs = { processing: pending.processing, outbox: pending.outbox, attemptId: pending.attempt.id,
    snapshotPublicKey: pending.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: pending.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: pending.capabilities };
  assert.equal(pending.outbox.getIntent(pending.attempt.id).state, 'prepared');
  assert.equal(createPreclaimSourceAttestation(pendingArgs).sourceAttestation.proof.submissionId, pending.attempt.id);

  const f = fixture(t, { gcp: true });
  const args = { processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities };
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-preclaim-foreign-db-'));
  const otherDatabase = openDatabase(path.join(otherRoot, 'other.sqlite'));
  t.after(() => { otherDatabase.close(); fs.rmSync(otherRoot, { recursive: true, force: true }); });
  assert.throws(() => createPreclaimSourceAttestation({ ...args, outbox: new PreparedSubmissionOutbox(otherDatabase) }), { code: 'preclaim_database_mismatch' });
  assert.throws(() => createPreclaimSourceAttestation({ ...args, principalId: 'other-principal' }), { code: 'preclaim_scope_mismatch' });
  const result = createPreclaimSourceAttestation(args);
  assert.equal(result.sourceManifest.objects.find(object => object.id === 'gcp-source').sourceType, 'gcp_source_csv');
  assert.equal(result.sourceManifest.objects.find(object => object.id === 'gcp-source').retentionClass, 'permanent_viewer_hold');
  assert.equal(result.derivedManifest.objects.length, 1);
  assert.equal(result.derivedManifest.objects[0].name, 'gcp_list.txt');
  assert.equal(result.derivedBytes.get(result.derivedManifest.objects[0].id).toString('utf8'), f.processing.getAttemptGcpSnapshot(f.attempt.id).content);
  assert.equal(f.processing.hasHeldSourceSnapshot(f.dataset.id), true, 'GCP preclaim must keep original source data held');
});

test('preclaim signer rejects a correctly signed snapshot that omits an eligible photo', t => {
  const f = fixture(t, { secondPhoto: true, incompleteSelection: true });
  assert.throws(() => createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  }), { code: 'preclaim_snapshot_selection_incomplete' });
});

test('preclaim signer rejects a correctly signed source inventory that omits a dataset photo', t => {
  const f = fixture(t, { secondPhoto: true, incompleteSource: true });
  assert.throws(() => createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  }), { code: 'preclaim_source_inventory_mismatch' });
});

test('preclaim signer enforces worker role and filename compatibility', t => {
  const f = fixture(t, { photoRole: 'provider_input' });
  assert.throws(() => createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  }), { code: 'preclaim_snapshot_selection_invalid' });
});

test('preclaim signer rejects a snapshot after its owning project is inactive', t => {
  const f = fixture(t);
  f.processing.database.prepare("UPDATE projects SET status='archived' WHERE id=?").run(f.dataset.projectId);
  assert.throws(() => createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  }), { code: 'preclaim_current_source_binding_mismatch' });
});

test('preclaim signer refuses terminal task and attempt states and pending storage mutations', async t => {
  const argsFor = f => ({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, expectedSnapshotIssuerId: 'viewer-snapshot-issuer', expectedSnapshotKeyId: 'snapshot-key', signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  });
  for (const status of ['failed', 'cancelled', 'published']) {
    await t.test(`task ${status}`, t => {
      const f = fixture(t);
      f.processing.database.prepare('UPDATE processing_tasks SET status=? WHERE id=?').run(status, f.task.id);
      assert.throws(() => createPreclaimSourceAttestation(argsFor(f)), { code: 'preclaim_current_source_binding_mismatch' });
    });
  }
  for (const status of ['failed', 'cancelled', 'published']) {
    await t.test(`attempt ${status}`, t => {
      const f = fixture(t);
      f.processing.database.prepare('UPDATE processing_attempts SET status=? WHERE id=?').run(status, f.attempt.id);
      assert.throws(() => createPreclaimSourceAttestation(argsFor(f)), { code: 'preclaim_current_source_binding_mismatch' });
    });
  }
  await t.test('dataset storage mutation in progress', t => {
    const f = fixture(t), timestamp = new Date().toISOString(), trashId = crypto.randomUUID();
    f.processing.database.prepare(`INSERT INTO storage_mutations
      (id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,
       destination_root_key,destination_relative_path,status,actor,created_at,updated_at)
      VALUES (?,'trash','dataset',?,?,'datasets',?,'trash','dataset/in-flight','fs_applied','ops:test',?,?)`)
      .run(crypto.randomUUID(), f.dataset.id, trashId, f.dataset.relativePath, timestamp, timestamp);
    assert.throws(() => createPreclaimSourceAttestation(argsFor(f)), { code: 'preclaim_current_source_binding_mismatch' });
  });
});
