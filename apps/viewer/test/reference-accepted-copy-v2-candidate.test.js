'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const protocol = require('../server/referenceProtocol');
const candidate = require('../server/referenceReceiptV2Candidate');
const { createFixture } = require('./helpers/accepted-copy-v2-candidate-fixture');

test('candidate signs the bound complete result closure in persisted order with the outer acceptance digest', () => {
  const fixture = createFixture();
  const receipt = fixture.viewerReceipt;
  const { signature, ...body } = receipt;
  const publicKey = crypto.createPublicKey(fixture.trustedKeys[receipt.keyId].publicKeyPem);
  const bytes = Buffer.from(signature, 'base64url');

  assert.equal(receipt.protocol, 'ltds-viewer-accepted-copy-v2');
  assert.equal(receipt.schemaVersion, 2);
  assert.deepEqual(Object.keys(receipt).sort(), [...candidate.RECEIPT_FIELDS].sort());
  assert.deepEqual(receipt.acceptedObjectIds, ['object-b', 'object-a']);
  assert.notDeepEqual(receipt.acceptedObjectIds, [...receipt.acceptedObjectIds].sort());
  assert.deepEqual(receipt.objects.map(object => object.id), receipt.acceptedObjectIds);
  assert.equal(receipt.acceptanceReceiptId, fixture.acceptance.receiptId);
  assert.equal(receipt.acceptanceStorageReceiptId, fixture.acceptance.storageReceiptId);
  assert.equal(receipt.providerTaskId, fixture.expected.providerTaskId);
  assert.equal(receipt.providerTaskId, receipt.jobId);
  for (const field of ['sourceManifestSha256', 'derivedManifestSha256', 'sourceReceiptSha256', 'derivedReceiptSha256'])
    assert.equal(receipt[field], fixture.expected[field], `${field} is signed into the Viewer ACK`);
  assert.equal(receipt.acceptancePayloadSha256, protocol.sha256(Buffer.concat([
    candidate.ACCEPTANCE_DOMAIN, protocol.canonicalBytes(fixture.acceptance),
  ])));
  assert.equal(bytes.length, 64);
  assert.equal(bytes.toString('base64url'), signature);
  assert.equal(crypto.verify(null, Buffer.concat([candidate.DOMAIN, protocol.canonicalBytes(body)]), publicKey, bytes), true);
});

test('candidate rejects partial or reordered closure, open acceptance objects, non-ASCII and non-string identities', () => {
  const fixture = createFixture();
  const signer = candidate.createViewerReceiptV2SignerCandidate({
    issuerId: 'viewer-test-issuer',
    keyId: 'viewer-test-key',
    privateKeyPem: crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(Array.from({ length: 32 }, (_, i) => i))]),
      format: 'der', type: 'pkcs8',
    }).export({ type: 'pkcs8', format: 'pem' }).toString(),
    clock: () => new Date('2026-11-04T00:00:01.000Z'),
    idFactory: (() => {
      let index = 0;
      return () => ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'][index++];
    })(),
  });
  const input = () => structuredClone({ expected: fixture.expected, acceptance: fixture.acceptance, resultManifest: fixture.resultManifest });

  let value = input();
  value.acceptance.acceptedObjectIds.pop();
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_incomplete_or_reordered_closure' });

  value = input();
  value.acceptance.acceptedObjectIds.reverse();
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_incomplete_or_reordered_closure' });

  value = input();
  value.acceptance.extra = 'not signed by the closed contract';
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_acceptance_invalid' });

  value = input();
  value.expected.viewerPrincipalId = 'viewer-\u2603';
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_binding_invalid' });

  for (const field of ['sourceManifestSha256', 'derivedManifestSha256', 'sourceReceiptSha256', 'derivedReceiptSha256']) {
    value = input();
    value.expected[field] = 'not-a-hash';
    assert.throws(() => signer(value), { code: 'viewer_receipt_v2_binding_invalid' }, `${field} must be a SHA-256 digest`);
  }

  value = input();
  value.expected.providerTaskId = 'another-job';
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_binding_invalid' }, 'providerTaskId must bind to jobId');

  value = input();
  value.expected.submissionId = '99999999-9999-4999-8999-999999999999';
  assert.throws(() => signer(value), { code: 'viewer_receipt_v2_binding_invalid' }, 'submissionId must bind to viewerAttemptId');

  for (const field of ['coordinatorAuthorityId', 'viewerPrincipalId', 'submissionId', 'activationId', 'viewerTaskId', 'viewerAttemptId', 'providerTaskId', 'jobId']) {
    value = input();
    value.expected[field] = 42;
    assert.throws(() => signer(value), { code: 'viewer_receipt_v2_binding_invalid' }, `${field} must be a string`);
  }

  let idIndex = 0;
  const numericIdSigner = candidate.createViewerReceiptV2SignerCandidate({
    issuerId: 'viewer-test-issuer', keyId: 'viewer-test-key',
    privateKeyPem: crypto.createPrivateKey({
      key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(Array.from({ length: 32 }, (_, i) => i))]),
      format: 'der', type: 'pkcs8',
    }).export({ type: 'pkcs8', format: 'pem' }).toString(),
    idFactory: () => [42, '22222222-2222-4222-8222-222222222222'][idIndex++],
  });
  assert.throws(() => numericIdSigner(input()), { code: 'viewer_receipt_v2_receipt_identity_invalid' });
});

const processingIntegrationTest = process.env.PROCESSING_SOURCE ? test : test.skip;
processingIntegrationTest('actual Node candidate receipt verifies with the current Processing V2 verifier', () => {
  const source = process.env.PROCESSING_SOURCE;
  const helper = path.join(__dirname, 'helpers', 'accepted-copy-v2-candidate-fixture.js');
  const generated = spawnSync(process.execPath, [helper], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(generated.status, 0, generated.stderr);
  const script = String.raw`import json
import sys
from processing.viewer_copy_receipt_v2 import verify_viewer_copy_receipt_v2
value=json.load(sys.stdin)
trust=value['trustedKeys']['viewer-test-key']
checked=verify_viewer_copy_receipt_v2(
    value['viewerReceipt'],
    acceptance=value['acceptance'],
    result_manifest=value['resultManifest'],
    expected=value['expected'],
    trusted_keys={'viewer-test-key': {'issuerId':trust['issuerId'],'publicKeyPem':trust['publicKeyPem']}},
)
receipt=checked.receipt
print(json.dumps({'protocol':receipt['protocol'],'acceptedObjectIds':receipt['acceptedObjectIds']}))`;
  const checked = spawnSync('python', ['-c', script], {
    cwd: source,
    encoding: 'utf8',
    input: generated.stdout,
    timeout: 15_000,
    env: { ...process.env, PYTHONPATH: source },
  });
  assert.equal(checked.status, 0, checked.stderr);
  assert.deepEqual(JSON.parse(checked.stdout), { protocol: 'ltds-viewer-accepted-copy-v2', acceptedObjectIds: ['object-b', 'object-a'] });
});
