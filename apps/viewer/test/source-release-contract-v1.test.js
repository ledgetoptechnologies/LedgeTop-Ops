'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  canonical, digest, retentionClosuresFromManifests, signAuthorization, validateTerminalReceipt, verifySignedRequest,
} = require('../server/sourceReleaseContractV1');

const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'source-release-v1-vectors.json'), 'utf8'));

function releaseManifests(authorization) {
  const sourceBody = {
    schemaVersion: 1,
    id: 'dataset-one',
    datasetManifestSha256: '1'.repeat(64),
    totalBytes: 30,
    objectCount: 2,
    objects: [
      { id: 'gcp-csv', name: 'control.csv', byteSize: 10, sha256: 'a'.repeat(64), sourceType: 'gcp_source_csv', retentionClass: 'permanent_viewer_hold', retentionHoldId: 'gcp-csv' },
      { id: 'image-one', name: 'photo.jpg', byteSize: 20, sha256: 'b'.repeat(64), sourceType: 'raw_input', retentionClass: 'release_after_acceptance', retentionHoldId: null },
    ],
  };
  const derivedBody = { schemaVersion: 1, attemptId: authorization.viewerAttemptId, objects: [
    { id: 'gcp-generated', name: 'gcp_list.txt', byteSize: 5, sha256: 'c'.repeat(64), snapshotAttemptId: authorization.viewerAttemptId, snapshotContentSha256: 'c'.repeat(64), snapshotEvidenceSha256: 'd'.repeat(64), sourceType: 'attempt_derived_gcp_list', retentionClass: 'release_after_acceptance', retentionHoldId: null },
  ] };
  const sourceManifest = { ...sourceBody, sha256: digest(sourceBody) };
  const derivedManifest = { ...derivedBody, sha256: digest(derivedBody) };
  const closures = retentionClosuresFromManifests(sourceManifest, derivedManifest);
  authorization.sourceManifestSha256 = sourceManifest.sha256;
  authorization.derivedManifestSha256 = derivedManifest.sha256;
  authorization.eligibleObjects = closures.eligibleObjects;
  authorization.eligibleClosureSha256 = closures.eligibleClosureSha256;
  const sourceSnapshotBinding = {
    snapshotId: authorization.sourceSnapshotId,
    datasetId: sourceManifest.id,
    taskId: authorization.viewerTaskId,
    attemptId: authorization.viewerAttemptId,
    intentSha256: authorization.sourceSnapshotSha256,
    status: 'accepted',
  };
  return { sourceManifest, derivedManifest, closures, sourceSnapshotBinding };
}

test('source release v1 accepts the Processing positive Ed25519 vector and matches canonical bytes', () => {
  const { request, authorizationCanonical, requestCanonicalSha256 } = vectors.positive;
  assert.equal(canonical(request.authorization).toString('utf8'), authorizationCanonical);
  assert.equal(crypto.createHash('sha256').update(canonical(request)).digest('hex'), requestCanonicalSha256);
  assert.deepEqual(verifySignedRequest(request, vectors.trustedReleaseKeys), request.authorization);
});

test('source release v1 rejects every Processing negative vector', () => {
  for (const vector of vectors.negative) {
    assert.throws(() => verifySignedRequest(vector.request, vectors.trustedReleaseKeys), undefined, vector.name);
  }
});

test('Viewer release signer emits a wire request accepted by the independently supplied key pin', () => {
  const keyDer = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    Buffer.from(vectors.testOnlyPrivateSeedHex, 'hex'),
  ]);
  const privateKeyPem = crypto.createPrivateKey({ key: keyDer, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' });
  const authorization = structuredClone(vectors.positive.request.authorization);
  const { sourceManifest, derivedManifest, sourceSnapshotBinding } = releaseManifests(authorization);
  const signer = vectors.trustedReleaseKeys[0];
  const signed = signAuthorization(authorization, { ...signer, privateKeyPem, sourceManifest, derivedManifest, sourceSnapshotBinding });
  assert.deepEqual(verifySignedRequest(signed, vectors.trustedReleaseKeys), authorization);
});

test('source and derived manifests split releasable files from permanent GCP CSV custody', () => {
  const authorization = structuredClone(vectors.positive.request.authorization);
  const { sourceManifest, derivedManifest, closures, sourceSnapshotBinding } = releaseManifests(authorization);
  assert.equal(closures.eligibleObjects.length, 2);
  assert.equal(closures.eligibleObjects[0].id, 'gcp-generated');
  assert.equal(closures.preservedObjects.length, 1);
  assert.equal(closures.preservedObjects[0].id, 'gcp-csv');
  assert.equal(closures.preservedClosureSha256, digest(closures.preservedObjects));

  const lostRawGcpHold = structuredClone(sourceManifest);
  lostRawGcpHold.objects[0].retentionClass = 'release_after_acceptance';
  lostRawGcpHold.objects[0].retentionHoldId = null;
  const { sha256: _ignored, ...lostRawGcpBody } = lostRawGcpHold;
  lostRawGcpHold.sha256 = digest(lostRawGcpBody);
  assert.throws(() => retentionClosuresFromManifests(lostRawGcpHold, derivedManifest), /source_release_gcp_retention_invalid/);
  const mismatchedAuthorization = structuredClone(authorization);
  mismatchedAuthorization.eligibleObjects[0].byteSize += 1;
  mismatchedAuthorization.eligibleClosureSha256 = digest(mismatchedAuthorization.eligibleObjects);
  assert.throws(() => require('../server/sourceReleaseContractV1').validateAuthorizationManifests(mismatchedAuthorization, sourceManifest, derivedManifest, sourceSnapshotBinding), /source_release_manifest_binding_mismatch/);
  assert.throws(() => require('../server/sourceReleaseContractV1').validateAuthorizationManifests(authorization, sourceManifest, derivedManifest, { ...sourceSnapshotBinding, status: 'released' }), /source_release_snapshot_binding_mismatch/);
});

test('terminal receipt validation binds exact removed count and bytes to the signed closure', () => {
  const authorization = structuredClone(vectors.positive.request.authorization);
  const { sourceManifest, derivedManifest, closures, sourceSnapshotBinding } = releaseManifests(authorization);
  const authorizationSha256 = crypto.createHash('sha256').update(Buffer.concat([
    Buffer.from('ltds-viewer-source-release-v1\0', 'ascii'), canonical(authorization),
  ])).digest('hex');
  const receipt = {
    schemaVersion: 1,
    protocol: 'ltds-source-release-receipt-v1',
    coordinatorAuthorityId: authorization.coordinatorAuthorityId,
    jobId: authorization.jobId,
    generation: authorization.generation,
    environment: authorization.environment,
    principalId: authorization.principalId,
    releaseId: authorization.releaseId,
    authorizationSha256,
    sourceSnapshotId: authorization.sourceSnapshotId,
    sourceSnapshotSha256: authorization.sourceSnapshotSha256,
    workerObservationAckSha256: authorization.workerObservationAckSha256,
    eligibleClosureSha256: authorization.eligibleClosureSha256,
    preservedClosureSha256: closures.preservedClosureSha256,
    removedObjectCount: closures.eligibleObjects.length,
    removedBytes: closures.eligibleObjects.reduce((sum, object) => sum + object.byteSize, 0),
    completedAt: '2026-11-05T12:00:00.000Z',
  };
  receipt.receiptSha256 = digest(receipt);
  assert.equal(validateTerminalReceipt(receipt, authorization, authorizationSha256, sourceManifest, derivedManifest, sourceSnapshotBinding), receipt);
  const wrongPreserved = { ...receipt, preservedClosureSha256: digest([]) };
  const { receiptSha256: _wrongDigest, ...wrongPayload } = wrongPreserved;
  wrongPreserved.receiptSha256 = digest(wrongPayload);
  assert.throws(() => validateTerminalReceipt(wrongPreserved, authorization, authorizationSha256, sourceManifest, derivedManifest, sourceSnapshotBinding), /source_release_preserved_closure_mismatch/);
  const partial = { ...receipt, removedObjectCount: 1 };
  const { receiptSha256: _ignored, ...partialPayload } = partial;
  partial.receiptSha256 = digest(partialPayload);
  assert.throws(() => validateTerminalReceipt(partial, authorization, authorizationSha256, sourceManifest, derivedManifest, sourceSnapshotBinding), /source_release_receipt_removal_mismatch/);
});
