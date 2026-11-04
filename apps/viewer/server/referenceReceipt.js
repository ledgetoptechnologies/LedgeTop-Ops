'use strict';

const crypto = require('node:crypto');
const protocol = require('./referenceProtocol');

const DOMAIN = Buffer.from('LTDS-VIEWER-ACCEPTED-COPY-ACK-V1\0', 'ascii');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function createViewerReceiptSigner({ issuerId, keyId, privateKeyPem }) {
  if (typeof issuerId !== 'string' || !IDENTIFIER.test(issuerId)
      || typeof keyId !== 'string' || !IDENTIFIER.test(keyId)
      || typeof privateKeyPem !== 'string' || !privateKeyPem.trim()) fail('VIEWER_RECEIPT_SIGNER_CONFIG_INVALID');
  let privateKey;
  try { privateKey = crypto.createPrivateKey(privateKeyPem.replace(/\\n/g, '\n')); }
  catch { fail('VIEWER_RECEIPT_SIGNER_CONFIG_INVALID'); }
  if (privateKey.asymmetricKeyType !== 'ed25519') fail('VIEWER_RECEIPT_SIGNER_CONFIG_INVALID');
  return ({ expected, resultManifest, acceptedObjectIds }) => {
    if (!expected || !resultManifest || !Array.isArray(acceptedObjectIds) || !acceptedObjectIds.length) fail('VIEWER_RECEIPT_BINDING_INVALID');
    const objects = acceptedObjectIds.map(id => {
      const object = resultManifest.objects.find(item => item.id === id);
      if (!object) fail('VIEWER_RECEIPT_BINDING_INVALID');
      return { id: object.id, byteSize: object.byteSize, sha256: object.sha256 };
    }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const receipt = {
      protocol: 'ltds-viewer-accepted-copy-v1',
      schemaVersion: 1,
      issuerId,
      keyId,
      receiptId: crypto.randomUUID(),
      storageReceiptId: crypto.randomUUID(),
      jobId: expected.jobId,
      generation: expected.generation,
      environment: expected.environment,
      inputManifestSha256: expected.inputManifestSha256,
      pipelineDigest: expected.pipelineDigest,
      resultManifestSha256: expected.resultManifestSha256,
      acceptedObjectIds: objects.map(object => object.id),
      objects,
      acceptedAt: new Date().toISOString(),
      signature: 'A'.repeat(86),
    };
    protocol.validateViewerReceipt(receipt);
    const { signature: _shapeOnly, ...body } = receipt;
    const signature = crypto.sign(null, Buffer.concat([DOMAIN, protocol.canonicalBytes(body)]), privateKey).toString('base64url');
    return { ...body, signature };
  };
}

function verifyViewerReceipt(receipt, trustedKeys) {
  protocol.validateViewerReceipt(receipt);
  if (Object.getPrototypeOf(trustedKeys) !== Object.prototype || !Object.hasOwn(trustedKeys, receipt.keyId)) return false;
  let publicKey;
  try { publicKey = crypto.createPublicKey(trustedKeys[receipt.keyId]); }
  catch { return false; }
  if (publicKey.asymmetricKeyType !== 'ed25519') return false;
  const { signature, ...body } = receipt;
  let signatureBytes;
  try { signatureBytes = Buffer.from(signature, 'base64url'); }
  catch { return false; }
  if (signatureBytes.length !== 64 || signatureBytes.toString('base64url') !== signature) return false;
  return crypto.verify(null, Buffer.concat([DOMAIN, protocol.canonicalBytes(body)]), publicKey, signatureBytes);
}

module.exports = { createViewerReceiptSigner, verifyViewerReceipt };
