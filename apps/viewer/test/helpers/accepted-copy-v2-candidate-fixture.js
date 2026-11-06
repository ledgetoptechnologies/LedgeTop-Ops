'use strict';

// Published synthetic seed only. It matches the public key used by the
// Processing proposal fixture and must never be used for a real identity.
const crypto = require('node:crypto');
const protocol = require('../../server/referenceProtocol');
const { createViewerReceiptV2SignerCandidate } = require('../../server/referenceReceiptV2Candidate');

const seed = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const privateDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privateKey = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' });
const publicKeyPem = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString();

function createFixture() {
  const resultManifest = {
    schemaVersion: 1,
    jobId: 'job-test',
    generation: 1,
    environment: 'staging',
    pipelineDigest: 'c'.repeat(64),
    objects: [
      { id: 'object-b', role: 'report', byteSize: 0, sha256: crypto.createHash('sha256').update('').digest('hex') },
      { id: 'object-a', role: 'pointcloud', byteSize: 3, sha256: crypto.createHash('sha256').update('abc').digest('hex') },
    ],
    engineVersions: { odm: 'synthetic-1.0.0' },
  };
  resultManifest.resultManifestSha256 = protocol.resultManifestSha256(resultManifest);
  const expected = {
    coordinatorAuthorityId: 'coord-test',
    viewerPrincipalId: 'viewer-test',
    submissionId: '88888888-8888-4888-8888-888888888888',
    activationId: '66666666-6666-4666-8666-666666666666',
    viewerTaskId: '77777777-7777-4777-8777-777777777777',
    viewerAttemptId: '88888888-8888-4888-8888-888888888888',
    providerTaskId: resultManifest.jobId,
    preparedEnvelopeSha256: 'a'.repeat(64),
    jobId: resultManifest.jobId,
    generation: resultManifest.generation,
    environment: resultManifest.environment,
    inputManifestSha256: 'b'.repeat(64),
    pipelineDigest: resultManifest.pipelineDigest,
    resultManifestSha256: resultManifest.resultManifestSha256,
    sourceManifestSha256: 'd'.repeat(64),
    derivedManifestSha256: 'e'.repeat(64),
    sourceReceiptSha256: 'f'.repeat(64),
    derivedReceiptSha256: '0'.repeat(64),
  };
  const acceptance = {
    schemaVersion: 1,
    receiptId: 'outer-acceptance-receipt',
    storageReceiptId: 'outer-storage-receipt',
    jobId: expected.jobId,
    generation: expected.generation,
    environment: expected.environment,
    inputManifestSha256: expected.inputManifestSha256,
    pipelineDigest: expected.pipelineDigest,
    resultManifestSha256: expected.resultManifestSha256,
    acceptedObjectIds: resultManifest.objects.map(object => object.id),
    acceptedAt: '2026-11-04T00:00:00.000Z',
    validationVersion: 'ltds-reference-v1',
  };
  const ids = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ];
  let nextId = 0;
  const signer = createViewerReceiptV2SignerCandidate({
    issuerId: 'viewer-test-issuer',
    keyId: 'viewer-test-key',
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    clock: () => new Date('2026-11-04T00:00:01.000Z'),
    idFactory: () => ids[nextId++],
  });
  const viewerReceipt = signer({ expected, acceptance, resultManifest });
  const raw = protocol.canonicalBytes({ acceptance, viewerReceipt });
  const trustedKeys = {
    'viewer-test-key': {
      issuerId: 'viewer-test-issuer',
      publicKeyPem,
      coordinatorAuthorityId: expected.coordinatorAuthorityId,
      viewerPrincipalId: expected.viewerPrincipalId,
      environment: expected.environment,
    },
  };
  return { expected, acceptance, resultManifest, viewerReceipt, rawBase64: raw.toString('base64'), trustedKeys };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(createFixture())}\n`);
module.exports = { createFixture };
