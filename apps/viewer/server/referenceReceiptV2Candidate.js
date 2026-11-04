'use strict';

// Unmounted candidate only. No runtime route imports this module. It does not
// prove storage durability, peer authentication, replay persistence, or cleanup
// authority; those belong to a separately reviewed acceptance service.
const crypto = require('node:crypto');
const protocol = require('./referenceProtocol');

const DOMAIN = Buffer.from('LTDS-VIEWER-ACCEPTED-COPY-ACK-V2\0', 'ascii');
const ACCEPTANCE_DOMAIN = Buffer.from('LTDS-OUTER-ACCEPTANCE-V1\0', 'ascii');
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
const BINDING_FIELDS = Object.freeze([
  'coordinatorAuthorityId', 'viewerPrincipalId', 'submissionId', 'activationId',
  'viewerTaskId', 'viewerAttemptId', 'providerTaskId', 'preparedEnvelopeSha256', 'jobId', 'generation',
  'environment', 'inputManifestSha256', 'pipelineDigest', 'resultManifestSha256',
  'sourceManifestSha256', 'derivedManifestSha256', 'sourceReceiptSha256', 'derivedReceiptSha256',
]);
const RECEIPT_FIELDS = Object.freeze([
  'protocol', 'schemaVersion', 'issuerId', 'keyId', 'receiptId', 'storageReceiptId',
  'acceptanceReceiptId', 'acceptanceStorageReceiptId', 'acceptancePayloadSha256',
  ...BINDING_FIELDS, 'acceptedObjectIds', 'objects', 'acceptedAt', 'signature',
]);
const ACCEPTANCE_FIELDS = Object.freeze([
  'schemaVersion', 'receiptId', 'storageReceiptId', 'jobId', 'generation', 'environment',
  'inputManifestSha256', 'pipelineDigest', 'resultManifestSha256', 'acceptedObjectIds',
  'acceptedAt', 'validationVersion',
]);

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function closed(value, fields, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length !== fields.length
      || fields.some(field => !Object.hasOwn(value, field))) fail(code);
}

function asciiTree(value, depth = 0) {
  if (depth > 24) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'string') return /^[\x20-\x7e]*$/.test(value);
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0;
  if (Array.isArray(value)) return value.length <= protocol.LIMITS.objects && value.every(item => asciiTree(item, depth + 1));
  if (!value || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, item]) => /^[\x20-\x7e]+$/.test(key) && asciiTree(item, depth + 1));
}

function hash(value) { return typeof value === 'string' && HASH.test(value); }
function timestamp(value) {
  if (typeof value !== 'string' || !TIME.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validateBinding(value) {
  closed(value, BINDING_FIELDS, 'viewer_receipt_v2_binding_invalid');
  if (!asciiTree(value)
      || typeof value.coordinatorAuthorityId !== 'string' || typeof value.viewerPrincipalId !== 'string'
      || typeof value.submissionId !== 'string' || typeof value.activationId !== 'string'
      || typeof value.viewerTaskId !== 'string' || typeof value.viewerAttemptId !== 'string'
      || typeof value.providerTaskId !== 'string'
      || typeof value.jobId !== 'string' || typeof value.environment !== 'string'
      || !ID.test(value.coordinatorAuthorityId) || !ID.test(value.viewerPrincipalId)
      || !UUID.test(value.submissionId) || !UUID.test(value.activationId)
      || !UUID.test(value.viewerTaskId) || !UUID.test(value.viewerAttemptId)
      || !ID.test(value.providerTaskId) || value.providerTaskId !== value.jobId
      || value.submissionId !== value.viewerAttemptId
      || !hash(value.preparedEnvelopeSha256) || !ID.test(value.jobId)
      || !Number.isSafeInteger(value.generation) || value.generation < 1
      || !['staging', 'production'].includes(value.environment)
      || !hash(value.inputManifestSha256) || !hash(value.pipelineDigest)
      || !hash(value.resultManifestSha256) || !hash(value.sourceManifestSha256)
      || !hash(value.derivedManifestSha256) || !hash(value.sourceReceiptSha256)
      || !hash(value.derivedReceiptSha256)) fail('viewer_receipt_v2_binding_invalid');
}

function loadPrivateKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 8192) fail('viewer_receipt_v2_signer_config_invalid');
  let key;
  try { key = crypto.createPrivateKey(value.replace(/\\n/g, '\n')); }
  catch { fail('viewer_receipt_v2_signer_config_invalid'); }
  if (key.asymmetricKeyType !== 'ed25519') fail('viewer_receipt_v2_signer_config_invalid');
  return key;
}

function createViewerReceiptV2SignerCandidate({ issuerId, keyId, privateKeyPem, clock = () => new Date(), idFactory = () => crypto.randomUUID() }) {
  if (typeof issuerId !== 'string' || !ID.test(issuerId)
      || typeof keyId !== 'string' || !ID.test(keyId)
      || typeof clock !== 'function' || typeof idFactory !== 'function') fail('viewer_receipt_v2_signer_config_invalid');
  const privateKey = loadPrivateKey(privateKeyPem);

  return function signViewerReceiptV2Candidate({ expected, acceptance, resultManifest }) {
    validateBinding(expected);
    closed(acceptance, ACCEPTANCE_FIELDS, 'viewer_receipt_v2_acceptance_invalid');
    if (!asciiTree(acceptance)) fail('viewer_receipt_v2_acceptance_invalid');
    const resultExpected = {
      jobId: expected.jobId,
      generation: expected.generation,
      environment: expected.environment,
      pipelineDigest: expected.pipelineDigest,
      resultManifestSha256: expected.resultManifestSha256,
      objectIds: Array.isArray(resultManifest?.objects) ? resultManifest.objects.map(object => object?.id) : null,
    };
    const manifest = protocol.validateStoredResultManifest(resultManifest, resultExpected);
    const objectIds = manifest.objects.map(object => object.id);
    if (!objectIds.length || new Set(objectIds).size !== objectIds.length) fail('viewer_receipt_v2_result_closure_invalid');
    const acceptanceExpected = {
      jobId: expected.jobId,
      generation: expected.generation,
      environment: expected.environment,
      inputManifestSha256: expected.inputManifestSha256,
      pipelineDigest: expected.pipelineDigest,
      resultManifestSha256: expected.resultManifestSha256,
      objectIds,
    };
    protocol.validateAcceptance(acceptance, acceptanceExpected);
    if (JSON.stringify(acceptance.acceptedObjectIds) !== JSON.stringify(objectIds))
      fail('viewer_receipt_v2_incomplete_or_reordered_closure');

    const receiptId = idFactory(), storageReceiptId = idFactory();
    const acceptedAtValue = clock();
    const acceptedAt = acceptedAtValue instanceof Date ? acceptedAtValue.toISOString() : acceptedAtValue;
    if (typeof receiptId !== 'string' || typeof storageReceiptId !== 'string'
        || !ID.test(receiptId) || !ID.test(storageReceiptId) || !timestamp(acceptedAt)
        || new Set([receiptId, storageReceiptId, acceptance.receiptId, acceptance.storageReceiptId]).size !== 4)
      fail('viewer_receipt_v2_receipt_identity_invalid');

    const receipt = {
      protocol: 'ltds-viewer-accepted-copy-v2',
      schemaVersion: 2,
      issuerId,
      keyId,
      receiptId,
      storageReceiptId,
      acceptanceReceiptId: acceptance.receiptId,
      acceptanceStorageReceiptId: acceptance.storageReceiptId,
      acceptancePayloadSha256: protocol.sha256(Buffer.concat([ACCEPTANCE_DOMAIN, protocol.canonicalBytes(acceptance)])),
      ...expected,
      acceptedObjectIds: [...objectIds],
      objects: manifest.objects.map(object => ({ id: object.id, byteSize: object.byteSize, sha256: object.sha256 })),
      acceptedAt,
      signature: 'A'.repeat(86),
    };
    closed(receipt, RECEIPT_FIELDS, 'viewer_receipt_v2_receipt_invalid');
    if (!asciiTree(receipt)) fail('viewer_receipt_v2_receipt_invalid');
    const { signature: _placeholder, ...body } = receipt;
    const signature = crypto.sign(null, Buffer.concat([DOMAIN, protocol.canonicalBytes(body)]), privateKey).toString('base64url');
    return { ...body, signature };
  };
}

module.exports = {
  ACCEPTANCE_DOMAIN,
  BINDING_FIELDS,
  DOMAIN,
  RECEIPT_FIELDS,
  createViewerReceiptV2SignerCandidate,
};
