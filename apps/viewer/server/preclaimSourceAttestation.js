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
const { fileFacts } = require('./viewerPagedSourceExport');

const PROTOCOL = 'ltds-preclaim-source-attestation-v1';
const DOMAIN = Buffer.from(`${PROTOCOL}\0`, 'ascii');
const MAX_PROOF_BYTES = 8192;
const MAX_SOURCE_STREAM_BYTES = 12 * 1024 * 1024;
const PHOTO = /\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i;
const PROVIDER_INPUT = /\.(?:txt|geojson|json|zip|las|laz)$/i;
const PROOF_FIELDS = Object.freeze([
  'schemaVersion', 'protocol', 'issuerId', 'keyId', 'authorityId', 'principalId',
  'environment', 'submissionId', 'viewerTaskId', 'viewerAttemptId', 'activationId',
  'preparedEnvelopeSha256', 'manifestSha256', 'pipelineDigest', 'sourceSnapshotSha256',
]);
const SNAPSHOT_FIELDS = Object.freeze([
  'protocol', 'snapshotId', 'issuerId', 'keyId', 'createdAt', 'datasetId',
  'datasetManifestSha256', 'taskId', 'attemptId', 'inputManifestSha256',
  'sourceCount', 'sourcePageHashes', 'sourceFrameBytes', 'selectedCount',
  'selectedPageHashes', 'selectedFrameBytes',
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

function validateSnapshotSelection(snapshot, submission) {
  const selected = parseFrameRecords(snapshot.selectedFrames);
  const source = parseFrameRecords(snapshot.sourceFrames);
  if (!Array.isArray(source) || !Array.isArray(selected) || !selected.length) fail('preclaim_snapshot_selection_invalid');
  const byId = new Map();
  for (const record of source) {
    if (!record || record.type !== 'dataset_file' || typeof record.datasetFileId !== 'string'
        || byId.has(record.datasetFileId)) fail('preclaim_snapshot_source_invalid');
    byId.set(record.datasetFileId, record);
  }
  // This v1 proof intentionally holds any dataset containing raw GCP inputs.
  if (source.some(record => record.processingRole === 'gcp_source')) fail('preclaim_gcp_extension_unavailable');
  const eligible = source.filter(record => record.type === 'dataset_file'
    && !['gcp_source', 'administrative'].includes(record.processingRole)
    && (record.processingRole !== 'auto' || PHOTO.test(record.relativePath)));
  const orderedEligible = [
    ...eligible.filter(record => PHOTO.test(record.relativePath)),
    ...eligible.filter(record => !PHOTO.test(record.relativePath)),
  ];
  const expectedSelection = orderedEligible.map((record, ordinal) => ({
    type: 'dataset_file', ordinal, pageObjectId: record.datasetFileId, datasetFileId: record.datasetFileId,
  }));
  const comparisonLimits = { maxBytes: MAX_SOURCE_STREAM_BYTES };
  if (!canonicalizeJcs(selected, comparisonLimits).equals(canonicalizeJcs(expectedSelection, comparisonLimits))) fail('preclaim_snapshot_selection_incomplete');
  const mapped = [];
  const inputFiles = [];
  let hasImage = false;
  for (let index = 0; index < selected.length; index++) {
    const mark = selected[index];
    if (!mark || mark.type !== 'dataset_file' || mark.ordinal !== index
        || mark.pageObjectId !== mark.datasetFileId) fail('preclaim_snapshot_selection_invalid');
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
  if (!hasImage || !canonicalizeJcs(mapped).equals(canonicalizeJcs(submission.manifest.objects))) fail('preclaim_manifest_selection_mismatch');
  const inputDigest = crypto.createHash('sha256').update(JSON.stringify(inputFiles), 'utf8').digest('hex');
  if (inputDigest !== snapshot.intent.inputManifestSha256) fail('preclaim_input_manifest_mismatch');
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
  if (!intent || intent.state !== 'accepted' || !intent.remoteBinding) fail('preclaim_submission_not_accepted');
  if (intent.coordinatorAuthorityId !== authorityId || intent.authenticatedPrincipal !== principalId
      || intent.environment !== environment) fail('preclaim_scope_mismatch');
  const remote = intent.remoteBinding;
  if (remote.authorityId !== authorityId || remote.environment !== environment
      || remote.submissionId !== intent.submissionId || remote.viewerTaskId !== intent.viewerTaskId
      || remote.viewerAttemptId !== intent.viewerAttemptId) fail('preclaim_remote_binding_mismatch');

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
      || !task || task.status === 'archived' || task.purgedAt || task.activeAttemptId !== attemptId
      || task.datasetId !== dataset.id || task.projectId !== dataset.projectId
      || !project || project.status !== 'active'
      || !attempt || attempt.taskId !== task.id || attempt.datasetId !== dataset.id
      || ['failed', 'cancelled', 'published'].includes(attempt.status)) fail('preclaim_current_source_binding_mismatch');
  let currentSource;
  try { currentSource = dataset.files.map(fileFacts); } catch { fail('preclaim_current_source_invalid'); }
  const snapshotSource = parseFrameRecords(snapshot.sourceFrames);
  const sourceComparisonLimits = { maxBytes: MAX_SOURCE_STREAM_BYTES };
  if (!canonicalizeJcs(snapshotSource, sourceComparisonLimits).equals(canonicalizeJcs(currentSource, sourceComparisonLimits))) fail('preclaim_source_inventory_mismatch');

  const envelopeBytes = Buffer.from(intent.envelopeCanonical, 'utf8');
  let envelope;
  try { envelope = JSON.parse(envelopeBytes.toString('utf8')); } catch { fail('preclaim_envelope_invalid'); }
  const canonical = canonicalEnvelope(envelope);
  if (!canonical.bytes.equals(envelopeBytes) || canonical.sha256 !== intent.envelopeSha256
      || envelope.viewerTaskId !== intent.viewerTaskId || envelope.viewerAttemptId !== attemptId
      || envelope.submission.submissionId !== intent.submissionId) fail('preclaim_envelope_binding_mismatch');
  try { ReferenceProtocol.validateSubmission(envelope.submission, { capabilities, trustedLidarEvidence }); }
  catch { fail('preclaim_envelope_policy_rejected'); }
  validateSnapshotSelection(snapshot, envelope.submission);

  const manifestSha256 = envelope.submission.manifest.sha256;
  // Processing owns the normalized pipeline identity. The exact digest is
  // taken from the authenticated accepted binding, never re-derived from the
  // client's raw options or from a Viewer-side approximation.
  const pipelineDigest = remote.pipelineDigest;
  if (!isHash(manifestSha256) || !isHash(pipelineDigest)
      || remote.manifestSha256 !== manifestSha256) fail('preclaim_remote_policy_binding_mismatch');

  const proof = {
    schemaVersion: 1,
    protocol: PROTOCOL,
    issuerId: signer.issuerId,
    keyId: signer.keyId,
    authorityId,
    principalId,
    environment,
    submissionId: intent.submissionId,
    viewerTaskId: intent.viewerTaskId,
    viewerAttemptId: attemptId,
    activationId: envelope.activationId,
    preparedEnvelopeSha256: intent.envelopeSha256,
    manifestSha256,
    pipelineDigest,
    sourceSnapshotSha256: snapshot.intentSha256,
  };
  if (Object.keys(proof).sort().join(',') !== [...PROOF_FIELDS].sort().join(',')) fail('preclaim_proof_shape_invalid');
  const raw = canonicalizeJcs(proof, { maxBytes: MAX_PROOF_BYTES });
  const message = Buffer.concat([DOMAIN, raw]);
  const signature = Buffer.from(signer.sign(message));
  if (signature.length !== 64 || !crypto.verify(null, message, signer.publicKey, signature)) fail('preclaim_signature_invalid');
  return { proof, raw, signature, attestationSha256: crypto.createHash('sha256').update(message).digest('hex') };
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

module.exports = { DOMAIN, MAX_PROOF_BYTES, PROOF_FIELDS, PROTOCOL, createPreclaimSourceAttestation };
