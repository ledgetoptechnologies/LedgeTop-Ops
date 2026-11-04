'use strict';

// Unmounted candidate. It signs only after a Viewer-held snapshot and the exact
// prepared envelope have been re-read and validated under independent pins.
const crypto = require('node:crypto');
const path = require('node:path');
const ReferenceProtocol = require('./referenceProtocol');
const { canonicalEnvelope, canonicalizeJcs } = require('./preparedSubmissionOutbox');
const { PreparedSubmissionOutbox } = require('./preparedSubmissionOutbox');
const { ProcessingRepository } = require('./processingRepository');
const { getHeldSourceSnapshot, verifyHeldSourceSnapshot } = require('./heldSourceSnapshot');
const { captureHeldSourceExport, fileFacts } = require('./viewerPagedSourceExport');
const { buildSourceIntakeManifests } = require('./sourceIntakeManifestV2');

const PROTOCOL = 'ltds-preclaim-source-attestation-v2';
const DOMAIN = Buffer.from(`${PROTOCOL}\0`, 'ascii');
const MAX_PROOF_BYTES = 8192;
const MAX_SOURCE_STREAM_BYTES = 12 * 1024 * 1024;
const PHOTO = /\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i;
const PROVIDER_INPUT = /\.(?:txt|geojson|json|zip|las|laz)$/i;
const PROOF_FIELDS = Object.freeze([
  'schemaVersion', 'protocol', 'issuerId', 'keyId', 'authorityId', 'principalId',
  'environment', 'submissionId', 'viewerTaskId', 'providerTaskId', 'viewerAttemptId', 'activationId',
  'preparedEnvelopeSha256', 'sourceSnapshotSha256', 'sourceManifestSha256',
  'derivedManifestSha256', 'pipelineManifestSha256', 'pipelineDigest',
]);
const SNAPSHOT_FIELDS = Object.freeze([
  'protocol', 'snapshotId', 'issuerId', 'keyId', 'createdAt', 'datasetId',
  'datasetManifestSha256', 'taskId', 'attemptId', 'inputManifestSha256', 'datasetFileCount',
  'sourceCount', 'sourcePageHashes', 'sourceFrameBytes', 'selectedCount',
  'selectedPageHashes', 'selectedFrameBytes', 'gcp',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function isHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function isUuid(value) { return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }
function isId(value) { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value); }
function publicRawEd25519(key) {
  let publicKey;
  try { publicKey = key?.type === 'public' ? key : crypto.createPublicKey(key); } catch { fail('preclaim_public_key_invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519') fail('preclaim_public_key_invalid');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) fail('preclaim_public_key_invalid');
  return der.subarray(prefix.length);
}
function parseFrameRecords(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.at(-1) !== 0x0a) fail('preclaim_snapshot_frames_invalid');
  let lines;
  try { lines = bytes.subarray(0, -1).toString('utf8').split('\n'); } catch { fail('preclaim_snapshot_frames_invalid'); }
  const records = [];
  for (const line of lines) {
    let frame;
    try { frame = JSON.parse(line); } catch { fail('preclaim_snapshot_frames_invalid'); }
    if (!Array.isArray(frame.records)) fail('preclaim_snapshot_frames_invalid');
    records.push(...frame.records);
  }
  return records;
}

function validateSnapshotSelection(snapshot, submission = null) {
  const selected = parseFrameRecords(snapshot.selectedFrames);
  const source = parseFrameRecords(snapshot.sourceFrames);
  if (!Array.isArray(source) || !Array.isArray(selected) || !selected.length) fail('preclaim_snapshot_selection_invalid');
  const generatedGcpRecords = source.filter(record => record?.type === 'attempt_generated_gcp');
  const generatedGcp = snapshot.intent.gcp?.generatedGcp || null;
  if (generatedGcpRecords.length > 1 || Boolean(generatedGcpRecords.length) !== Boolean(generatedGcp)
      || Boolean(snapshot.gcpEvidenceFrames) !== Boolean(generatedGcp)
      || Boolean(snapshot.gcpFileFrames) !== Boolean(generatedGcp)) fail('preclaim_gcp_extension_incomplete');
  const byId = new Map();
  for (const record of source) {
    if (record?.type === 'attempt_generated_gcp') continue;
    if (!record || record.type !== 'dataset_file' || typeof record.datasetFileId !== 'string' || byId.has(record.datasetFileId)) fail('preclaim_snapshot_source_invalid');
    byId.set(record.datasetFileId, record);
  }
  const datasetRecords = source.filter(record => record?.type === 'dataset_file');
  if (datasetRecords.length !== snapshot.intent.datasetFileCount) fail('preclaim_source_inventory_mismatch');
  if (datasetRecords.length + generatedGcpRecords.length !== source.length) fail('preclaim_snapshot_source_invalid');
  if (datasetRecords.some(record => record.processingRole === 'gcp_source') && !generatedGcp) fail('preclaim_gcp_extension_unavailable');
  if (generatedGcp && (generatedGcp.attemptId !== snapshot.attemptId
      || !isHash(generatedGcp.sha256) || !Number.isSafeInteger(generatedGcp.byteSize) || generatedGcp.byteSize < 1
      || !Array.isArray(generatedGcp.sourceFiles) || !generatedGcp.sourceFiles.length)) fail('preclaim_gcp_extension_invalid');
  const gcpSourceIds = new Set(datasetRecords.filter(record => record.processingRole === 'gcp_source').map(record => record.datasetFileId));
  if (generatedGcp && generatedGcp.sourceFiles.some(file => !file || !gcpSourceIds.has(file.datasetFileId)
      || byId.get(file.datasetFileId)?.relativePath !== file.relativePath
      || byId.get(file.datasetFileId)?.sha256 !== file.sha256)) fail('preclaim_gcp_source_binding_mismatch');
  const eligible = datasetRecords.filter(record => record.type === 'dataset_file'
    && !['gcp_source', 'administrative'].includes(record.processingRole)
    && (record.processingRole !== 'auto' || PHOTO.test(record.relativePath)));
  const filteredEligible = generatedGcp
    ? eligible.filter(record => path.posix.basename(record.relativePath).toLowerCase() !== 'gcp_list.txt') : eligible;
  const orderedEligible = [
    ...filteredEligible.filter(record => PHOTO.test(record.relativePath)),
    ...filteredEligible.filter(record => !PHOTO.test(record.relativePath)),
  ];
  const expectedSelection = orderedEligible.map((record, ordinal) => ({
    type: 'dataset_file', ordinal, pageObjectId: record.datasetFileId, datasetFileId: record.datasetFileId,
  }));
  if (generatedGcp) expectedSelection.push({ type: 'attempt_generated_gcp', ordinal: expectedSelection.length,
    pageObjectId: `gcp_${snapshot.attemptId}`, attemptId: snapshot.attemptId, mediaType: 'text/plain' });
  const comparisonLimits = { maxBytes: MAX_SOURCE_STREAM_BYTES };
  if (!canonicalizeJcs(selected, comparisonLimits).equals(canonicalizeJcs(expectedSelection, comparisonLimits))) fail('preclaim_snapshot_selection_incomplete');
  const mapped = [];
  const inputFiles = [];
  let hasImage = false;
  for (let index = 0; index < selected.length; index++) {
    const mark = selected[index];
    if (generatedGcp && mark?.type === 'attempt_generated_gcp') {
      if (mark.ordinal !== index || mark.pageObjectId !== `gcp_${snapshot.attemptId}` || mark.attemptId !== snapshot.attemptId
          || mark.mediaType !== 'text/plain' || index !== selected.length - 1) fail('preclaim_snapshot_selection_invalid');
      mapped.push({ id: mark.pageObjectId, name: 'gcp_list.txt', byteSize: generatedGcp.byteSize,
        sha256: generatedGcp.sha256, kind: 'auxiliary', mediaType: 'text/plain' });
      inputFiles.push({ relativePath: 'gcp_list.txt', byteSize: generatedGcp.byteSize, sha256: generatedGcp.sha256 });
      continue;
    }
    if (!mark || mark.type !== 'dataset_file' || mark.ordinal !== index || mark.pageObjectId !== mark.datasetFileId) fail('preclaim_snapshot_selection_invalid');
    const file = byId.get(mark.datasetFileId);
    if (!file || ['gcp_source', 'administrative'].includes(file.processingRole)
        || (file.processingRole === 'auto' && file.kind !== 'image')
        || (file.processingRole === 'image' && !PHOTO.test(file.relativePath))
        || (file.processingRole === 'provider_input' && !PROVIDER_INPUT.test(file.relativePath))) fail('preclaim_snapshot_selection_invalid');
    hasImage ||= file.kind === 'image';
    inputFiles.push({ relativePath: file.relativePath, byteSize: file.byteSize, sha256: file.sha256 });
    mapped.push({
      id: file.datasetFileId,
      name: path.posix.basename(file.relativePath),
      byteSize: file.byteSize,
      sha256: file.sha256,
      kind: file.kind,
      mediaType: file.mediaType,
    });
  }
  if (!hasImage || (submission && !canonicalizeJcs(mapped).equals(canonicalizeJcs(submission.manifest.objects)))) fail('preclaim_manifest_selection_mismatch');
  const inputDigest = crypto.createHash('sha256').update(JSON.stringify(inputFiles), 'utf8').digest('hex');
  if (inputDigest !== snapshot.intent.inputManifestSha256) fail('preclaim_input_manifest_mismatch');
  return { mapped, inputFiles };
}

// Caller must hold its database transaction while reading dataset and snapshot.
function assertCurrentSnapshotSource(dataset, snapshot) {
  let currentSource;
  try { currentSource = dataset.files.map(fileFacts); } catch { fail('preclaim_current_source_invalid'); }
  const snapshotSource = parseFrameRecords(snapshot.sourceFrames);
  const sourceComparisonLimits = { maxBytes: MAX_SOURCE_STREAM_BYTES };
  if (!canonicalizeJcs(snapshotSource, sourceComparisonLimits).equals(canonicalizeJcs(currentSource, sourceComparisonLimits))) fail('preclaim_source_inventory_mismatch');
}

function assertCurrentSnapshotExport(processing, dataset, snapshot) {
  let currentSource;
  try { currentSource = dataset.files.map(fileFacts); } catch { fail('preclaim_current_source_invalid'); }
  const snapshotSource = parseFrameRecords(snapshot.sourceFrames).filter(record => record?.type === 'dataset_file');
  const sourceComparisonLimits = { maxBytes: MAX_SOURCE_STREAM_BYTES };
  if (!canonicalizeJcs(snapshotSource, sourceComparisonLimits).equals(canonicalizeJcs(currentSource, sourceComparisonLimits))) fail('preclaim_source_inventory_mismatch');
  let currentExport;
  try { currentExport = captureHeldSourceExport(processing, { datasetId: dataset.id, taskId: snapshot.taskId, attemptId: snapshot.attemptId, joinTransaction: true }); }
  catch { fail('preclaim_current_source_export_unavailable'); }
  const sameBytes = (left, right) => Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  const currentGcp = currentExport.generatedGcp ? {
    evidenceVersion: currentExport.gcpEvidenceVersion,
    evidencePageHashes: currentExport.gcpEvidencePageHashes,
    evidencePageBytes: currentExport.gcpEvidencePageBytes,
    evidencePageCount: currentExport.gcpEvidencePageCount,
    evidenceByteCount: currentExport.gcpEvidenceByteCount,
    evidenceSha256: currentExport.gcpEvidenceSha256,
    fileVersion: currentExport.gcpFileVersion,
    filePageHashes: currentExport.gcpFilePageHashes,
    filePageBytes: currentExport.gcpFilePageBytes,
    filePageCount: currentExport.gcpFilePageCount,
    fileByteCount: currentExport.gcpFileByteCount,
    fileSha256: currentExport.gcpFileSha256,
    generatedGcp: { byteSize: currentExport.generatedGcp.byteSize, sha256: currentExport.generatedGcp.sha256,
      attemptId: currentExport.generatedGcp.attemptId, correspondenceSha256: currentExport.generatedGcp.correspondenceSha256,
      sourceFiles: currentExport.generatedGcp.sourceFiles },
  } : null;
  if (!sameBytes(currentExport.sourceFrames, snapshot.sourceFrames)
      || !sameBytes(currentExport.selectedFrames, snapshot.selectedFrames)
      || (currentExport.gcpEvidenceFrames ? !sameBytes(currentExport.gcpEvidenceFrames, snapshot.gcpEvidenceFrames) : snapshot.gcpEvidenceFrames !== null)
      || (currentExport.gcpFileFrames ? !sameBytes(currentExport.gcpFileFrames, snapshot.gcpFileFrames) : snapshot.gcpFileFrames !== null)
      || !canonicalizeJcs(snapshot.intent.gcp).equals(canonicalizeJcs(currentGcp))) fail('preclaim_snapshot_export_mismatch');
  return currentExport;
}

function buildPreclaimSourceAttestation({
  processing, outbox, attemptId, snapshotPublicKey, expectedSnapshotIssuerId, expectedSnapshotKeyId, signer,
  authorityId, principalId, environment, capabilities, trustedLidarEvidence = null,
} = {}) {
  if (!(processing instanceof ProcessingRepository) || !(outbox instanceof PreparedSubmissionOutbox)
      || !isUuid(attemptId) || !isUuid(authorityId) || !isId(principalId)
      || !['staging', 'production'].includes(environment)) fail('preclaim_request_invalid');
  if (!isId(expectedSnapshotIssuerId) || !isId(expectedSnapshotKeyId)) fail('preclaim_snapshot_pin_unavailable');
  if (!capabilities || capabilities.environment !== environment) fail('preclaim_policy_unavailable');
  if (!signer || !isId(signer.issuerId) || !isId(signer.keyId) || typeof signer.sign !== 'function' || !signer.publicKey) fail('preclaim_signer_unavailable');
  const signerPublicBytes = publicRawEd25519(signer.publicKey);
  const snapshotPublicBytes = publicRawEd25519(snapshotPublicKey);
  if (signerPublicBytes.equals(snapshotPublicBytes)) fail('preclaim_signer_key_reused');

  const intent = outbox.getIntent(attemptId);
  if (!intent || intent.state !== 'prepared' || intent.remoteBinding) fail('preclaim_submission_not_prepared');
  if (intent.coordinatorAuthorityId !== authorityId || intent.authenticatedPrincipal !== principalId
      || intent.environment !== environment) fail('preclaim_scope_mismatch');

  const snapshotRow = processing.database.prepare('SELECT snapshot_id FROM viewer_source_snapshots WHERE attempt_id=?').get(attemptId);
  if (!snapshotRow) fail('preclaim_snapshot_unavailable');
  const snapshot = getHeldSourceSnapshot(processing, snapshotRow.snapshot_id);
  if (!snapshot || snapshot.status !== 'held' || !verifyHeldSourceSnapshot(snapshot, snapshotPublicKey)) fail('preclaim_snapshot_invalid');
  if (snapshot.issuerId !== expectedSnapshotIssuerId || snapshot.keyId !== expectedSnapshotKeyId) fail('preclaim_snapshot_signer_mismatch');
  if (Object.keys(snapshot.intent).sort().join(',') !== [...SNAPSHOT_FIELDS].sort().join(',')
      || snapshot.intent.sourceCount < 1 || snapshot.intent.selectedCount < 1
      || snapshot.datasetId !== snapshot.intent.datasetId || snapshot.taskId !== intent.viewerTaskId
      || snapshot.attemptId !== attemptId || snapshot.intent.taskId !== intent.viewerTaskId
      || snapshot.intent.attemptId !== attemptId) fail('preclaim_snapshot_binding_mismatch');

  const dataset = processing.getDataset(snapshot.datasetId, true);
  const task = processing.getTask(intent.viewerTaskId);
  const attempt = processing.getAttempt(attemptId);
  const project = task && processing.getProject(task.projectId);
  const pendingStorageMutation = dataset && processing.database.prepare(`SELECT 1 FROM storage_mutations
    WHERE entity_type='dataset' AND entity_id=? AND status IN ('intent','fs_applied','failed') LIMIT 1`).get(dataset.id);
  if (!dataset || dataset.storageMode !== 'managed' || dataset.rootKey !== 'datasets'
      || dataset.status !== 'finalized' || dataset.manifestSha256 !== snapshot.datasetManifestSha256 || pendingStorageMutation
      || !task || ['archived', 'failed', 'cancelled', 'published'].includes(task.status) || task.purgedAt || task.activeAttemptId !== attemptId
      || task.datasetId !== dataset.id || task.projectId !== dataset.projectId
      || !project || project.status !== 'active'
      || !attempt || attempt.taskId !== task.id || attempt.datasetId !== dataset.id
      || ['failed', 'cancelled', 'published'].includes(attempt.status)) fail('preclaim_current_source_binding_mismatch');
  const envelopeBytes = Buffer.from(intent.envelopeCanonical, 'utf8');
  let envelope;
  try { envelope = JSON.parse(envelopeBytes.toString('utf8')); } catch { fail('preclaim_envelope_invalid'); }
  const canonical = canonicalEnvelope(envelope);
  if (!canonical.bytes.equals(envelopeBytes) || canonical.sha256 !== intent.envelopeSha256
      || envelope.viewerTaskId !== intent.viewerTaskId || envelope.viewerAttemptId !== attemptId
      || envelope.submission.submissionId !== intent.submissionId) fail('preclaim_envelope_binding_mismatch');
  let validatedSubmission;
  try { validatedSubmission = ReferenceProtocol.validateSubmission(envelope.submission, { capabilities, trustedLidarEvidence }); }
  catch { fail('preclaim_envelope_policy_rejected'); }
  validateSnapshotSelection(snapshot, envelope.submission);
  assertCurrentSnapshotExport(processing, dataset, snapshot);

  const pipelineManifestSha256 = envelope.submission.manifest.sha256;
  // The shared wire contract hashes the validated pipeline object; this is
  // deterministic across retries and is checked again by Processing.
  const pipelineDigest = crypto.createHash('sha256')
    .update(canonicalizeJcs(validatedSubmission.pipeline)).digest('hex');
  if (!isHash(pipelineManifestSha256) || !isHash(pipelineDigest) || !isUuid(attempt.providerTaskId))
    fail('preclaim_remote_policy_binding_mismatch');

  const manifests = buildSourceIntakeManifests(processing, {
    dataset, attempt, snapshot, pipelineManifest: envelope.submission.manifest,
  });

  const proof = {
    schemaVersion: 2,
    protocol: PROTOCOL,
    issuerId: signer.issuerId,
    keyId: signer.keyId,
    authorityId,
    principalId,
    environment,
    submissionId: attempt.id,
    viewerTaskId: intent.viewerTaskId,
    providerTaskId: attempt.providerTaskId,
    viewerAttemptId: attemptId,
    activationId: envelope.activationId,
    preparedEnvelopeSha256: intent.envelopeSha256,
    sourceManifestSha256: manifests.sourceManifestSha256,
    derivedManifestSha256: manifests.derivedManifestSha256,
    pipelineManifestSha256: manifests.pipelineManifestSha256,
    pipelineDigest,
    sourceSnapshotSha256: manifests.sourceSnapshotSha256,
  };
  if (Object.keys(proof).sort().join(',') !== [...PROOF_FIELDS].sort().join(',')) fail('preclaim_proof_shape_invalid');
  const raw = canonicalizeJcs(proof, { maxBytes: MAX_PROOF_BYTES });
  const message = Buffer.concat([DOMAIN, raw]);
  const signature = Buffer.from(signer.sign(message));
  if (signature.length !== 64 || !crypto.verify(null, message, signer.publicKey, signature)) fail('preclaim_signature_invalid');
  const attestationSha256 = crypto.createHash('sha256').update(message).digest('hex');
  const sourceAttestation = { proof, signature: signature.toString('base64url'), attestationSha256 };
  const sourceIntakeRequest = {
    schemaVersion: 2,
    submissionId: attempt.id,
    viewerTaskId: task.id,
    providerTaskId: attempt.providerTaskId,
    sourceManifest: manifests.sourceManifest,
    derivedManifest: manifests.derivedManifest,
    manifest: manifests.pipelineManifest,
    pipeline: validatedSubmission.pipeline,
    capabilityFingerprint: envelope.submission.capabilityFingerprint,
    sourceAttestation,
  };
  const sourceIntakeCanonical = canonicalizeJcs(sourceIntakeRequest).toString('utf8');
  return {
    proof,
    raw,
    signature,
    attestationSha256,
    sourceAttestation,
    sourceIntakeRequest,
    sourceIntakeCanonical,
    sourceManifest: manifests.sourceManifest,
    derivedManifest: manifests.derivedManifest,
    pipelineManifest: manifests.pipelineManifest,
    sourceManifestSha256: manifests.sourceManifestSha256,
    derivedManifestSha256: manifests.derivedManifestSha256,
    pipelineManifestSha256: manifests.pipelineManifestSha256,
    derivedBytes: manifests.derivedBytes,
  };
}

function createPreclaimSourceAttestation(input = {}) {
  const database = input.processing?.database;
  if (!database || typeof database.exec !== 'function') fail('preclaim_request_invalid');
  if (input.outbox?.database !== database) fail('preclaim_database_mismatch');
  if (database.isTransaction) fail('preclaim_transaction_conflict');
  // A single SQLite read view prevents mixing an accepted binding, old
  // snapshot and changed source inventory into one signed statement.
  database.exec('BEGIN');
  try {
    const result = buildPreclaimSourceAttestation(input);
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.isTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

module.exports = { DOMAIN, MAX_PROOF_BYTES, PROOF_FIELDS, PROTOCOL, createPreclaimSourceAttestation,
  assertCurrentSnapshotExport, assertCurrentSnapshotSource, validateSnapshotSelection };
