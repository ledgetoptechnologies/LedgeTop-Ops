'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { releaseBinding } = require('../server/sourceReleaseWorkerV1');
const { sourceReleaseAuthorization } = require('../server/sourceReleaseWorkerV1');
const Contract = require('../server/sourceReleaseContractV1');

function fixture() {
  const receiptHash = 'a'.repeat(64), derivedHash = 'b'.repeat(64), resultHash = 'c'.repeat(64);
  const activationId = '11111111-1111-4111-8111-111111111111';
  const remoteBinding = {
    protocol: 'ltds-viewer-source-intake-binding-v2', attemptId: '22222222-2222-4222-8222-222222222222',
    coordinatorAuthorityId: 'coordinator-1', jobId: 'job-1', providerTaskId: 'job-1', generation: 1,
    environment: 'staging', manifestSha256: 'd'.repeat(64), pipelineDigest: 'e'.repeat(64),
  };
  const resultManifestCanonical = JSON.stringify({ resultManifestSha256: resultHash });
  const viewerReceipt = { resultManifestSha256: resultHash, sourceReceiptSha256: receiptHash, derivedReceiptSha256: derivedHash };
  const intent = {
    submissionId: remoteBinding.attemptId, viewerTaskId: '33333333-3333-4333-8333-333333333333',
    envelopeCanonical: JSON.stringify({ activationId }), envelopeSha256: 'f'.repeat(64), remoteBinding,
    sourceIntakeCanonical: JSON.stringify({ submissionId: remoteBinding.attemptId, manifest: { sha256: remoteBinding.manifestSha256 },
      sourceAttestation: { proof: { activationId, pipelineDigest: remoteBinding.pipelineDigest } } }),
    sourceIntakeCompletionCanonical: JSON.stringify({ sourceReceipt: {}, derivedReceipt: {}, sourceReceiptSha256: receiptHash,
      derivedReceiptSha256: derivedHash }),
    resultManifestCanonical,
    resultManifestSha256: require('node:crypto').createHash('sha256').update(resultManifestCanonical, 'utf8').digest('hex'),
    copyRequestCanonical: JSON.stringify({ acceptance: { resultManifestSha256: resultHash }, viewerReceipt }),
    copyAckCanonical: JSON.stringify({ fullyAccepted: true, viewerReceipt,
      job: { jobId: 'job-1', generation: 1, phase: 'completed' } }),
  };
  return { intent, receiptHash, derivedHash };
}

test('source-release binding uses receipt hashes from the durable completion record', () => {
  const { intent, receiptHash, derivedHash } = fixture();
  const result = releaseBinding(intent);
  assert.equal(result.binding.sourceReceiptSha256, receiptHash);
  assert.equal(result.binding.derivedReceiptSha256, derivedHash);
  assert.equal(result.binding.resultManifestSha256, JSON.parse(intent.resultManifestCanonical).resultManifestSha256);
  assert.equal(Object.hasOwn(intent.remoteBinding, 'resultManifestSha256'), false, 'the admission binding has no result digest field');
  assert.equal(result.binding.viewerTaskId, intent.viewerTaskId);
});

test('source-release binding rejects copy receipts detached from retained completion hashes', () => {
  const { intent } = fixture();
  const copy = JSON.parse(intent.copyRequestCanonical);
  copy.viewerReceipt.sourceReceiptSha256 = '0'.repeat(64);
  intent.copyRequestCanonical = JSON.stringify(copy);
  assert.throws(() => releaseBinding(intent), { code: 'source_release_binding_changed' });
});

test('authorization takes immutable identity from binding, not nonexistent release-outbox aliases', () => {
  const vectors = require('./fixtures/source-release-v1-vectors.json');
  const original = vectors.positive.request.authorization;
  const crypto = require('node:crypto');
  const sourceBody = { schemaVersion: 1, id: 'dataset-one', datasetManifestSha256: '1'.repeat(64),
    totalBytes: 1, objectCount: 1, objects: [{ id: 'photo-one', name: 'photo.jpg', byteSize: 1,
      sha256: '2'.repeat(64), sourceType: 'raw_input', retentionClass: 'release_after_acceptance', retentionHoldId: null }] };
  const derivedBody = { schemaVersion: 1, attemptId: original.viewerAttemptId, objects: [] };
  const sourceManifest = { ...sourceBody, sha256: Contract.digest(sourceBody) };
  const derivedManifest = { ...derivedBody, sha256: Contract.digest(derivedBody) };
  const privateKeyPem = crypto.createPrivateKey({ key: Buffer.from(
    '302e020100300506032b657004220420' + vectors.testOnlyPrivateSeedHex, 'hex'), format: 'der', type: 'pkcs8' })
    .export({ format: 'pem', type: 'pkcs8' });
  const binding = { coordinatorAuthorityId: original.coordinatorAuthorityId, jobId: original.jobId,
    generation: original.generation, environment: original.environment, viewerTaskId: original.viewerTaskId,
    providerTaskId: original.providerTaskId, attemptId: original.viewerAttemptId, activationId: original.activationId,
    preparedEnvelopeSha256: original.preparedEnvelopeSha256, pipelineDigest: original.pipelineDigest,
    resultManifestSha256: original.resultManifestSha256 };
  const intent = { releaseId: original.releaseId, attemptId: original.viewerAttemptId };
  const signed = sourceReleaseAuthorization({ intent, binding,
    request: { sourceManifest, derivedManifest, manifest: { sha256: original.inputManifestSha256 } },
    completion: { sourceReceiptSha256: original.sourceReceiptSha256, derivedReceiptSha256: original.derivedReceiptSha256 },
    copy: { acceptance: { receiptId: original.receipts[0].acceptanceReceiptId },
      viewerReceipt: { receiptId: original.receipts[0].viewerReceiptId } },
    observation: { observationId: original.workerObservationId, ackSha256: original.workerObservationAckSha256 },
    readyProof: original.readyProof,
    snapshotBinding: { snapshotId: original.sourceSnapshotId, datasetId: sourceBody.id, taskId: original.viewerTaskId,
      attemptId: original.viewerAttemptId, intentSha256: original.sourceSnapshotSha256, status: 'accepted' },
    signer: { issuerId: original.issuerId, keyId: original.keyId, principalId: original.principalId, privateKeyPem } });
  assert.equal(signed.authorization.viewerTaskId, original.viewerTaskId);
  assert.equal(signed.authorization.viewerAttemptId, original.viewerAttemptId);
  assert.equal(signed.authorization.preparedEnvelopeSha256, original.preparedEnvelopeSha256);
  Contract.verifySignedRequest(signed, vectors.trustedReleaseKeys);
});

test('accepted source snapshots retain the dataset guard until terminal retirement', () => {
  const { DatabaseSync } = require('node:sqlite');
  const { ProcessingRepository } = require('../server/processingRepository');
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE viewer_source_snapshots(dataset_id TEXT,status TEXT)');
    const hasHold = id => ProcessingRepository.prototype.hasHeldSourceSnapshot.call({ database: db }, id);
    for (const status of ['held', 'accepted', 'released']) {
      db.prepare('INSERT INTO viewer_source_snapshots VALUES(?,?)').run(status, status);
      assert.equal(hasHold(status), status !== 'released');
    }
  } finally { db.close(); }
});
