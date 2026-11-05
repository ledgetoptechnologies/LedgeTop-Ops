'use strict';

const crypto = require('node:crypto');
const { canonicalizeJcs } = require('./preparedSubmissionOutbox');

const PROTOCOL = 'ltds-viewer-source-release-v1';
const DOMAIN = Buffer.from(`${PROTOCOL}\0`, 'ascii');
const POLICY = Object.freeze({ id: 'viewer-ready-plus-24h-v1', minimumAgeSeconds: 86400 });
const MAX_BYTES = 4 * 1024 * 1024;
const MAX_OBJECTS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const SIGNED_FIELDS = ['authorization', 'signature', 'authorizationSha256'];
const AUTHORIZATION_FIELDS = [
  'schemaVersion', 'protocol', 'releaseId', 'issuerId', 'keyId', 'principalId',
  'coordinatorAuthorityId', 'jobId', 'generation', 'environment', 'viewerTaskId',
  'providerTaskId', 'viewerAttemptId', 'activationId', 'sourceSnapshotId',
  'preparedEnvelopeSha256', 'sourceSnapshotSha256', 'inputManifestSha256', 'pipelineDigest',
  'resultManifestSha256', 'sourceManifestSha256', 'derivedManifestSha256',
  'sourceReceiptSha256', 'derivedReceiptSha256', 'workerObservationId',
  'workerObservationAckSha256', 'receipts', 'readyProof', 'policy', 'eligibleObjects',
  'eligibleClosureSha256',
];
const RECEIPT_PAIR_FIELDS = ['acceptanceReceiptId', 'acceptanceSha256', 'viewerReceiptId', 'viewerReceiptSha256'];
const READY_PROOF_FIELDS = ['kind', 'attemptId', 'modelId', 'modelVersionId', 'outputInventorySha256', 'verifiedAt'];
const OBJECT_FIELDS = ['id', 'objectKind', 'byteSize', 'sha256'];
const HOLD_REASONS = new Set([
  'disabled', 'release_role_unavailable', 'qualification_changed', 'custody_held', 'binding_changed',
  'timer_clock_invalid', 'active_source_io', 'metadata_quota', 'source_identity_changed', 'source_missing',
  'quarantine_conflict', 'durability_uncertain', 'filesystem_unsupported', 'journal_invalid',
  'filesystem_unavailable',
]);

function fail(code) { throw Object.assign(new Error(code), { code }); }
function closed(value, fields) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).sort().join(',') === [...fields].sort().join(',');
}
function requireHash(value, code) { if (typeof value !== 'string' || !HASH.test(value)) fail(code); }
function requireSlug(value, code) { if (typeof value !== 'string' || !SLUG.test(value)) fail(code); }
function requireUuid(value, code) { if (typeof value !== 'string' || !UUID.test(value)) fail(code); }
function requireInteger(value, code, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) fail(code);
}
function canonical(value, maxBytes = MAX_BYTES) {
  try { return canonicalizeJcs(value, { maxBytes, maxNodes: 300_000, maxDepth: 40 }); }
  catch { fail('source_release_canonicalization_invalid'); }
}
function digest(value, maxBytes = MAX_BYTES) {
  return crypto.createHash('sha256').update(canonical(value, maxBytes)).digest('hex');
}
function canonicalTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
      || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) fail('source_release_timestamp_invalid');
}

function eligibleClosure(objects) {
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS * 2) fail('source_release_object_closure_invalid');
  const result = objects.map((object) => {
    if (!closed(object, OBJECT_FIELDS)) fail('source_release_object_closure_invalid');
    requireSlug(object.id, 'source_release_object_id_invalid');
    if (!['source', 'derived'].includes(object.objectKind)) fail('source_release_object_kind_invalid');
    requireInteger(object.byteSize, 'source_release_object_size_invalid', true);
    requireHash(object.sha256, 'source_release_object_hash_invalid');
    return { id: object.id, objectKind: object.objectKind, byteSize: object.byteSize, sha256: object.sha256 };
  });
  const identities = result.map((object) => `${object.objectKind}\0${object.id}`);
  if (identities.some((identity, index) => index > 0 && identities[index - 1] >= identity)
      || result.reduce((sum, object) => sum + object.byteSize, 0) > Number.MAX_SAFE_INTEGER)
    fail('source_release_object_closure_invalid');
  return result;
}

function retentionClosuresFromManifests(sourceManifest, derivedManifest) {
  const sourceFields = ['schemaVersion', 'id', 'datasetManifestSha256', 'totalBytes', 'objectCount', 'objects', 'sha256'];
  const derivedFields = ['schemaVersion', 'attemptId', 'objects', 'sha256'];
  if (!closed(sourceManifest, sourceFields) || sourceManifest.schemaVersion !== 1
      || !Array.isArray(sourceManifest.objects) || sourceManifest.objects.length > MAX_OBJECTS) fail('source_release_manifest_invalid');
  if (!closed(derivedManifest, derivedFields) || derivedManifest.schemaVersion !== 1
      || !Array.isArray(derivedManifest.objects) || derivedManifest.objects.length > MAX_OBJECTS) fail('source_release_manifest_invalid');
  const { sha256: sourceSha256, ...sourceBody } = sourceManifest;
  const { sha256: derivedSha256, ...derivedBody } = derivedManifest;
  requireHash(sourceSha256, 'source_release_manifest_invalid');
  requireHash(derivedSha256, 'source_release_manifest_invalid');
  requireHash(sourceManifest.datasetManifestSha256, 'source_release_manifest_invalid');
  requireSlug(sourceManifest.id, 'source_release_manifest_invalid');
  requireUuid(derivedManifest.attemptId, 'source_release_manifest_invalid');
  requireInteger(sourceManifest.objectCount, 'source_release_manifest_invalid', true);
  requireInteger(sourceManifest.totalBytes, 'source_release_manifest_invalid', true);
  if (digest(sourceBody) !== sourceSha256 || digest(derivedBody) !== derivedSha256
      || sourceManifest.objectCount !== sourceManifest.objects.length) fail('source_release_manifest_digest_mismatch');

  const convert = (objects, objectKind, fields) => {
    let previous = '';
    let totalBytes = 0;
    const eligible = [], preserved = [];
    for (const object of objects) {
      if (!closed(object, fields)) fail('source_release_manifest_invalid');
      requireSlug(object.id, 'source_release_manifest_invalid');
      requireInteger(object.byteSize, 'source_release_manifest_invalid', true);
      requireHash(object.sha256, 'source_release_manifest_invalid');
      if (typeof object.name !== 'string' || !object.name || object.name.length > 4096
          || !['release_after_acceptance', 'permanent_viewer_hold'].includes(object.retentionClass)
          || typeof object.sourceType !== 'string' || !object.sourceType) fail('source_release_manifest_invalid');
      if (previous && Buffer.compare(Buffer.from(previous, 'ascii'), Buffer.from(object.id, 'ascii')) >= 0)
        fail('source_release_manifest_invalid');
      previous = object.id;
      totalBytes += object.byteSize;
      if (!Number.isSafeInteger(totalBytes)) fail('source_release_manifest_invalid');
      const isHeld = object.retentionClass === 'permanent_viewer_hold';
      if ((isHeld && object.retentionHoldId !== object.id) || (!isHeld && object.retentionHoldId !== null))
        fail('source_release_manifest_invalid');
      if (objectKind === 'source' && object.sourceType === 'gcp_source_csv'
          && (!isHeld || object.retentionHoldId !== object.id)) fail('source_release_gcp_retention_invalid');
      const closureObject = { id: object.id, objectKind, byteSize: object.byteSize, sha256: object.sha256 };
      (isHeld ? preserved : eligible).push(closureObject);
    }
    return { eligible, preserved, totalBytes };
  };

  const source = convert(sourceManifest.objects, 'source', ['id', 'name', 'byteSize', 'sha256', 'sourceType', 'retentionClass', 'retentionHoldId']);
  const derived = convert(derivedManifest.objects, 'derived', ['id', 'name', 'byteSize', 'sha256', 'snapshotAttemptId', 'snapshotContentSha256', 'snapshotEvidenceSha256', 'sourceType', 'retentionClass', 'retentionHoldId']);
  if (source.totalBytes !== sourceManifest.totalBytes) fail('source_release_manifest_invalid');
  const eligibleObjects = eligibleClosure([...source.eligible, ...derived.eligible]
    .sort((a, b) => Buffer.compare(Buffer.from(`${a.objectKind}\0${a.id}`, 'ascii'), Buffer.from(`${b.objectKind}\0${b.id}`, 'ascii'))));
  const preservedObjects = eligibleClosure([...source.preserved, ...derived.preserved]
    .sort((a, b) => Buffer.compare(Buffer.from(`${a.objectKind}\0${a.id}`, 'ascii'), Buffer.from(`${b.objectKind}\0${b.id}`, 'ascii'))));
  return {
    sourceManifestSha256: sourceSha256,
    derivedManifestSha256: derivedSha256,
    eligibleObjects,
    eligibleClosureSha256: digest(eligibleObjects),
    preservedObjects,
    preservedClosureSha256: digest(preservedObjects),
  };
}

function validateAuthorization(value) {
  if (!closed(value, AUTHORIZATION_FIELDS) || value.schemaVersion !== 1 || value.protocol !== PROTOCOL)
    fail('source_release_authorization_invalid');
  for (const key of ['releaseId', 'viewerTaskId', 'providerTaskId', 'viewerAttemptId', 'activationId', 'sourceSnapshotId', 'workerObservationId'])
    requireUuid(value[key], 'source_release_identity_invalid');
  for (const key of ['issuerId', 'keyId', 'principalId', 'coordinatorAuthorityId', 'jobId']) requireSlug(value[key], 'source_release_identity_invalid');
  requireInteger(value.generation, 'source_release_generation_invalid');
  if (value.providerTaskId !== value.jobId || !['production', 'staging'].includes(value.environment)) fail('source_release_scope_invalid');
  for (const key of AUTHORIZATION_FIELDS) if (key.endsWith('Sha256') || key === 'pipelineDigest') requireHash(value[key], 'source_release_digest_invalid');
  if (!closed(value.policy, ['id', 'minimumAgeSeconds']) || value.policy.id !== POLICY.id
      || value.policy.minimumAgeSeconds !== POLICY.minimumAgeSeconds) fail('source_release_policy_invalid');
  const ready = value.readyProof;
  if (!closed(ready, READY_PROOF_FIELDS) || ready.kind !== 'verified_outputs_ready') fail('source_release_ready_proof_invalid');
  for (const key of ['attemptId', 'modelId', 'modelVersionId']) requireUuid(ready[key], 'source_release_ready_proof_invalid');
  if (ready.attemptId !== value.viewerAttemptId) fail('source_release_ready_proof_invalid');
  requireHash(ready.outputInventorySha256, 'source_release_ready_proof_invalid');
  canonicalTimestamp(ready.verifiedAt);

  const objects = eligibleClosure(value.eligibleObjects);
  if (digest(objects) !== value.eligibleClosureSha256) fail('source_release_object_closure_digest_mismatch');
  if (!Array.isArray(value.receipts) || value.receipts.length < 1 || value.receipts.length > MAX_OBJECTS)
    fail('source_release_receipts_invalid');
  const acceptanceIds = [], viewerIds = [];
  for (const pair of value.receipts) {
    if (!closed(pair, RECEIPT_PAIR_FIELDS)) fail('source_release_receipts_invalid');
    requireSlug(pair.acceptanceReceiptId, 'source_release_receipts_invalid');
    requireSlug(pair.viewerReceiptId, 'source_release_receipts_invalid');
    requireHash(pair.acceptanceSha256, 'source_release_receipts_invalid');
    requireHash(pair.viewerReceiptSha256, 'source_release_receipts_invalid');
    acceptanceIds.push(pair.acceptanceReceiptId); viewerIds.push(pair.viewerReceiptId);
  }
  if (acceptanceIds.some((id, index) => index > 0 && acceptanceIds[index - 1] >= id)
      || new Set(viewerIds).size !== viewerIds.length) fail('source_release_receipts_invalid');
  canonical(value);
  return value;
}

function validateAuthorizationManifests(authorization, sourceManifest, derivedManifest, sourceSnapshotBinding) {
  const checked = validateAuthorization(authorization);
  if (!closed(sourceSnapshotBinding, ['snapshotId', 'datasetId', 'taskId', 'attemptId', 'intentSha256', 'status'])
      || sourceSnapshotBinding.status !== 'accepted'
      || sourceSnapshotBinding.snapshotId !== checked.sourceSnapshotId
      || sourceSnapshotBinding.datasetId !== sourceManifest?.id
      || sourceSnapshotBinding.taskId !== checked.viewerTaskId
      || sourceSnapshotBinding.attemptId !== checked.viewerAttemptId
      || sourceSnapshotBinding.intentSha256 !== checked.sourceSnapshotSha256
      || derivedManifest?.attemptId !== checked.viewerAttemptId)
    fail('source_release_snapshot_binding_mismatch');
  const closures = retentionClosuresFromManifests(sourceManifest, derivedManifest);
  if (closures.sourceManifestSha256 !== checked.sourceManifestSha256
      || closures.derivedManifestSha256 !== checked.derivedManifestSha256
      || closures.eligibleClosureSha256 !== checked.eligibleClosureSha256
      || canonical(closures.eligibleObjects).compare(canonical(checked.eligibleObjects)) !== 0)
    fail('source_release_manifest_binding_mismatch');
  return closures;
}

function signAuthorization(authorization, { issuerId, keyId, principalId, environment, privateKeyPem, sourceManifest, derivedManifest, sourceSnapshotBinding } = {}) {
  validateAuthorizationManifests(authorization, sourceManifest, derivedManifest, sourceSnapshotBinding);
  if (!issuerId || !keyId || !principalId || environment !== authorization.environment
      || issuerId !== authorization.issuerId || keyId !== authorization.keyId || principalId !== authorization.principalId
      || typeof privateKeyPem !== 'string' || !privateKeyPem.trim()) fail('source_release_signer_unavailable');
  let key;
  try { key = crypto.createPrivateKey(privateKeyPem); } catch { fail('source_release_signer_invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('source_release_signer_invalid');
  const message = Buffer.concat([DOMAIN, canonical(authorization)]);
  const signature = crypto.sign(null, message, key).toString('base64url');
  const request = { authorization, signature, authorizationSha256: crypto.createHash('sha256').update(message).digest('hex') };
  canonical(request);
  return request;
}

function verifySignedRequest(request, trustedReleaseKeys) {
  if (!closed(request, SIGNED_FIELDS) || !Array.isArray(trustedReleaseKeys)) fail('source_release_request_invalid');
  const authorization = validateAuthorization(request.authorization);
  requireHash(request.authorizationSha256, 'source_release_authorization_digest_invalid');
  if (typeof request.signature !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(request.signature)) fail('source_release_signature_invalid');
  const signature = Buffer.from(request.signature, 'base64url');
  if (signature.length !== 64 || signature.toString('base64url') !== request.signature) fail('source_release_signature_invalid');
  const message = Buffer.concat([DOMAIN, canonical(authorization)]);
  if (crypto.createHash('sha256').update(message).digest('hex') !== request.authorizationSha256) fail('source_release_authorization_digest_invalid');
  const matches = trustedReleaseKeys.filter((key) => key?.environment === authorization.environment
    && key?.issuerId === authorization.issuerId && key?.keyId === authorization.keyId);
  if (matches.length !== 1 || matches[0].principalId !== authorization.principalId) fail('source_release_trusted_key_invalid');
  let publicKey;
  try { publicKey = crypto.createPublicKey(matches[0].publicKeyPem); } catch { fail('source_release_trusted_key_invalid'); }
  if (publicKey.asymmetricKeyType !== 'ed25519' || !crypto.verify(null, message, publicKey, signature)) fail('source_release_signature_rejected');
  canonical(request);
  return authorization;
}

function validateReleaseStatus(status, binding) {
  const fields = ['schemaVersion', 'protocol', 'coordinatorAuthorityId', 'jobId', 'generation', 'releaseId', 'authorizationSha256',
    'state', 'remainingMinimumAgeSeconds', 'holdReason', 'receipt'];
  if (!closed(status, fields) || status.schemaVersion !== 1 || status.protocol !== 'ltds-source-release-status-v1'
      || status.coordinatorAuthorityId !== binding.coordinatorAuthorityId || status.jobId !== binding.jobId
      || status.generation !== binding.generation || status.releaseId !== binding.releaseId
      || status.authorizationSha256 !== binding.authorizationSha256
      || !['waiting_policy', 'draining', 'deleting', 'held', 'released'].includes(status.state)) fail('source_release_status_binding_mismatch');
  requireInteger(status.remainingMinimumAgeSeconds, 'source_release_status_invalid', true);
  if (status.holdReason !== null && (typeof status.holdReason !== 'string' || !HOLD_REASONS.has(status.holdReason))) fail('source_release_status_invalid');
  if (status.state === 'released' && status.holdReason !== null) fail('source_release_status_invalid');
  if ((status.state === 'released') !== (status.receipt !== null)) fail('source_release_status_invalid');
  canonical(status);
  return status;
}

function validateTerminalReceipt(receipt, authorization, authorizationSha256, sourceManifest, derivedManifest, sourceSnapshotBinding) {
  const fields = ['schemaVersion', 'protocol', 'coordinatorAuthorityId', 'jobId', 'generation', 'environment', 'principalId',
    'releaseId', 'authorizationSha256', 'sourceSnapshotId', 'sourceSnapshotSha256', 'workerObservationAckSha256',
    'eligibleClosureSha256', 'preservedClosureSha256', 'removedObjectCount', 'removedBytes', 'completedAt', 'receiptSha256'];
  if (!closed(receipt, fields) || receipt.schemaVersion !== 1 || receipt.protocol !== 'ltds-source-release-receipt-v1')
    fail('source_release_receipt_invalid');
  for (const key of ['coordinatorAuthorityId', 'jobId', 'generation', 'environment', 'principalId', 'releaseId', 'sourceSnapshotId',
    'sourceSnapshotSha256', 'workerObservationAckSha256', 'eligibleClosureSha256']) {
    const expected = key === 'coordinatorAuthorityId' ? authorization.coordinatorAuthorityId
      : key === 'jobId' ? authorization.jobId : key === 'generation' ? authorization.generation
        : key === 'environment' ? authorization.environment : key === 'principalId' ? authorization.principalId
          : key === 'releaseId' ? authorization.releaseId : key === 'sourceSnapshotId' ? authorization.sourceSnapshotId
            : key === 'sourceSnapshotSha256' ? authorization.sourceSnapshotSha256
              : key === 'workerObservationAckSha256' ? authorization.workerObservationAckSha256 : authorization.eligibleClosureSha256;
    if (receipt[key] !== expected) fail('source_release_receipt_binding_mismatch');
  }
  if (receipt.authorizationSha256 !== authorizationSha256) fail('source_release_receipt_binding_mismatch');
  requireHash(receipt.preservedClosureSha256, 'source_release_receipt_invalid');
  const closures = validateAuthorizationManifests(authorization, sourceManifest, derivedManifest, sourceSnapshotBinding);
  if (closures.preservedClosureSha256 !== receipt.preservedClosureSha256) fail('source_release_preserved_closure_mismatch');
  requireInteger(receipt.removedObjectCount, 'source_release_receipt_invalid', true);
  requireInteger(receipt.removedBytes, 'source_release_receipt_invalid', true);
  const expectedCount = authorization.eligibleObjects.length;
  const expectedBytes = authorization.eligibleObjects.reduce((sum, object) => sum + object.byteSize, 0);
  if (receipt.removedObjectCount !== expectedCount || receipt.removedBytes !== expectedBytes)
    fail('source_release_receipt_removal_mismatch');
  canonicalTimestamp(receipt.completedAt);
  const { receiptSha256, ...payload } = receipt;
  requireHash(receiptSha256, 'source_release_receipt_invalid');
  if (digest(payload) !== receiptSha256) fail('source_release_receipt_digest_mismatch');
  return receipt;
}

module.exports = {
  AUTHORIZATION_FIELDS, DOMAIN, HOLD_REASONS, MAX_BYTES, POLICY, PROTOCOL,
  canonical, digest, eligibleClosure, signAuthorization, validateAuthorization,
  validateReleaseStatus, validateTerminalReceipt, verifySignedRequest,
  retentionClosuresFromManifests, validateAuthorizationManifests,
};
