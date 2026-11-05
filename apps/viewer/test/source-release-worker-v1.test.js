'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { releaseBinding } = require('../server/sourceReleaseWorkerV1');

function fixture() {
  const receiptHash = 'a'.repeat(64), derivedHash = 'b'.repeat(64), resultHash = 'c'.repeat(64);
  const activationId = '11111111-1111-4111-8111-111111111111';
  const remoteBinding = {
    protocol: 'ltds-viewer-source-intake-binding-v2', attemptId: '22222222-2222-4222-8222-222222222222',
    coordinatorAuthorityId: 'coordinator-1', jobId: 'job-1', providerTaskId: 'job-1', generation: 1,
    environment: 'staging', manifestSha256: 'd'.repeat(64), pipelineDigest: 'e'.repeat(64),
    resultManifestSha256: resultHash,
  };
  const intent = {
    submissionId: remoteBinding.attemptId, viewerTaskId: '33333333-3333-4333-8333-333333333333',
    envelopeCanonical: JSON.stringify({ activationId }), envelopeSha256: 'f'.repeat(64), remoteBinding,
    sourceIntakeCanonical: JSON.stringify({ submissionId: remoteBinding.attemptId, manifest: { sha256: remoteBinding.manifestSha256 },
      sourceAttestation: { proof: { activationId, pipelineDigest: remoteBinding.pipelineDigest } } }),
    sourceIntakeCompletionCanonical: JSON.stringify({ sourceReceipt: {}, derivedReceipt: {}, sourceReceiptSha256: receiptHash,
      derivedReceiptSha256: derivedHash }),
    resultManifestCanonical: JSON.stringify({ resultManifestSha256: resultHash }),
    copyRequestCanonical: JSON.stringify({ acceptance: {}, viewerReceipt: { sourceReceiptSha256: receiptHash,
      derivedReceiptSha256: derivedHash } }),
    copyAckCanonical: JSON.stringify({ fullyAccepted: true, job: { jobId: 'job-1', generation: 1, phase: 'completed' } }),
  };
  return { intent, receiptHash, derivedHash };
}

test('source-release binding uses receipt hashes from the durable completion record', () => {
  const { intent, receiptHash, derivedHash } = fixture();
  const result = releaseBinding(intent);
  assert.equal(result.binding.sourceReceiptSha256, receiptHash);
  assert.equal(result.binding.derivedReceiptSha256, derivedHash);
  assert.equal(result.binding.viewerTaskId, intent.viewerTaskId);
});

test('source-release binding rejects copy receipts detached from retained completion hashes', () => {
  const { intent } = fixture();
  const copy = JSON.parse(intent.copyRequestCanonical);
  copy.viewerReceipt.sourceReceiptSha256 = '0'.repeat(64);
  intent.copyRequestCanonical = JSON.stringify(copy);
  assert.throws(() => releaseBinding(intent), { code: 'source_release_binding_changed' });
});
