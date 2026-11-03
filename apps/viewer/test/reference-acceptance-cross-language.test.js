'use strict';

// Optional local pairing test for the exact Processing client candidate. Set
// LTDS_PROCESSING_REPO to a checked-out LedgeTop-Processing repository.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const { createReferenceAcceptanceApi, referenceAcceptanceJsonBodyType } = require('../server/referenceAcceptanceApi');
const { createViewerReceiptSigner } = require('../server/referenceReceipt');

const processingRoot = process.env.LTDS_PROCESSING_REPO;
const serviceKeyId = 'synthetic-processing-v1';
const serviceSecret = 'synthetic-processing-service-secret-not-a-credential-0001';
const receiptIssuerId = 'viewer-acceptance';
const receiptKeyId = 'viewer-test-2026';

class MemoryAcceptanceLedger {
  constructor() {
    this.pending = new Map();
    this.accepted = new Map();
    this.commitCount = 0;
    this.requestCounts = new Map();
  }
  count(method, path) {
    const key = `${method} ${path}`;
    this.requestCounts.set(key, (this.requestCounts.get(key) || 0) + 1);
  }
  reserveTransfer({ inputManifest, expected, resultManifest, acceptance }) {
    const receiptId = acceptance.receiptId;
    const payload = { inputManifest, expected, resultManifest, acceptance };
    const existing = this.pending.get(receiptId);
    if (existing) {
      assert.deepEqual(existing.payload, payload);
      return this.getTransfer(receiptId);
    }
    this.pending.set(receiptId, {
      payload,
      objects: new Map(resultManifest.objects.map(object => [object.id, Buffer.alloc(0)])),
    });
    return this.getTransfer(receiptId);
  }
  getTransfer(receiptId) {
    const item = this.pending.get(receiptId);
    if (!item) return null;
    const { expected, resultManifest, acceptance } = item.payload;
    return {
      receiptId, state: 'receiving', expected, acceptance,
      resultManifestSchemaVersion: resultManifest.schemaVersion,
      objects: resultManifest.objects.map(object => {
        const bytes = item.objects.get(object.id);
        return {
          objectId: object.id, expectedBytes: object.byteSize, expectedSha256: object.sha256,
          receivedBytes: bytes.length,
          state: bytes.length === object.byteSize ? 'complete' : (bytes.length ? 'receiving' : 'pending'),
        };
      }),
    };
  }
  getVerified(receiptId) { return this.accepted.get(receiptId) || null; }
  async stageObjectChunk({ receiptId, objectId, offset, contentLength, declaredSha256, source }) {
    const item = this.pending.get(receiptId);
    if (!item) throw Object.assign(new Error('UNKNOWN_TRANSFER'), { code: 'UNKNOWN_TRANSFER' });
    const object = item.payload.resultManifest.objects.find(candidate => candidate.id === objectId);
    if (!object) throw Object.assign(new Error('INVALID_TRANSFER_OBJECT'), { code: 'INVALID_TRANSFER_OBJECT' });
    const chunks = [];
    for await (const chunk of source) chunks.push(Buffer.from(chunk));
    const chunk = Buffer.concat(chunks);
    const digest = crypto.createHash('sha256').update(chunk).digest('hex');
    if (chunk.length !== contentLength || digest !== declaredSha256) {
      throw Object.assign(new Error('TRANSFER_CHUNK_DIGEST'), { code: 'TRANSFER_CHUNK_DIGEST' });
    }
    const prior = item.objects.get(objectId);
    if (offset !== prior.length) throw Object.assign(new Error('TRANSFER_OFFSET_MISMATCH'), { code: 'TRANSFER_OFFSET_MISMATCH' });
    if (prior.length + chunk.length > object.byteSize) throw Object.assign(new Error('TRANSFER_CHUNK_CONFLICT'), { code: 'TRANSFER_CHUNK_CONFLICT' });
    const next = Buffer.concat([prior, chunk]);
    const complete = next.length === object.byteSize;
    if (complete && crypto.createHash('sha256').update(next).digest('hex') !== object.sha256) {
      throw Object.assign(new Error('STORAGE_DIGEST_MISMATCH'), { code: 'STORAGE_DIGEST_MISMATCH' });
    }
    item.objects.set(objectId, next);
    return { receivedBytes: next.length, expectedBytes: object.byteSize, complete };
  }
  commitTransfer(receiptId, receiptSigner) {
    const already = this.accepted.get(receiptId);
    if (already) return already;
    const item = this.pending.get(receiptId);
    if (!item) throw Object.assign(new Error('UNKNOWN_TRANSFER'), { code: 'UNKNOWN_TRANSFER' });
    const { expected, resultManifest, acceptance } = item.payload;
    for (const object of resultManifest.objects) {
      const bytes = item.objects.get(object.id);
      if (bytes.length !== object.byteSize || crypto.createHash('sha256').update(bytes).digest('hex') !== object.sha256) {
        throw Object.assign(new Error('TRANSFER_INCOMPLETE'), { code: 'TRANSFER_INCOMPLETE' });
      }
    }
    const viewerReceipt = receiptSigner({ expected, resultManifest, acceptedObjectIds: acceptance.acceptedObjectIds });
    const record = { receiptId, acceptance, storage: { resultManifest, viewerReceipt } };
    this.accepted.set(receiptId, record);
    this.pending.delete(receiptId);
    this.commitCount += 1;
    return record;
  }
}

function waitForSpawn(child, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`paired Processing test timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', value => { stdout += value; });
    child.stderr.setEncoding('utf8').on('data', value => { stderr += value; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('actual Processing sender pairs with Viewer v1/v2 routes and recovers lost commit responses', {
  skip: !processingRoot || !require('node:fs').existsSync(path.join(processingRoot, 'processing', 'viewer_acceptance_transfer.py')),
}, async t => {
  const keyPair = crypto.generateKeyPairSync('ed25519');
  const signer = createViewerReceiptSigner({
    issuerId: receiptIssuerId,
    keyId: receiptKeyId,
    privateKeyPem: keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  });
  const ledger = new MemoryAcceptanceLedger();
  const usedNonces = new Set();
  const repository = {
    consumeServiceNonce(keyId, nonce) {
      const value = `${keyId}\0${nonce}`;
      if (usedNonces.has(value)) return false;
      usedNonces.add(value);
      return true;
    },
  };
  const app = express();
  app.use(express.json({
    type: referenceAcceptanceJsonBodyType,
    verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes); },
  }));
  app.use((req, _res, next) => { ledger.count(req.method, req.path); next(); });
  app.use(createReferenceAcceptanceApi({
    repository,
    ledger,
    serviceKeyId,
    serviceAuthKeys: { [serviceKeyId]: serviceSecret },
    receiptSigner: signer,
    environment: 'staging',
    chunkBytes: 1024,
  }));
  const server = app.listen(0, '127.0.0.1');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); });
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const child = spawn(process.env.LTDS_PYTHON || 'python', [
    path.join(__dirname, 'fixtures', 'reference_acceptance_cross_language.py'),
  ], {
    cwd: processingRoot,
    env: {
      ...process.env,
      LTDS_PROCESSING_REPO: processingRoot,
      LTDS_VIEWER_ORIGIN: 'https://viewer.synthetic',
      LTDS_VIEWER_LOOPBACK: `http://127.0.0.1:${server.address().port}`,
      LTDS_VIEWER_SERVICE_KEY_ID: serviceKeyId,
      LTDS_VIEWER_SERVICE_SECRET: serviceSecret,
      LTDS_VIEWER_RECEIPT_ISSUER_ID: receiptIssuerId,
      LTDS_VIEWER_RECEIPT_KEY_ID: receiptKeyId,
      LTDS_VIEWER_RECEIPT_PUBLIC_KEY_PEM: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const result = await waitForSpawn(child);
  assert.equal(child.exitCode, 0, `Processing pairing failed (exit ${result.code}, signal ${result.signal})\n${result.stderr}\n${result.stdout}`);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.v1, 'accepted_after_lost_commit_and_status_replay');
  assert.equal(report.v2, 'accepted');
  assert.equal(report.authMismatch, 401);
  assert.equal(report.environmentMismatch, 409);
  assert.equal(report.environmentError, 'BINDING_MISMATCH');
  assert.equal(report.schemaMismatch, 400);
  assert.equal(report.schemaError, 'INVALID_PROTOCOL');
  assert.equal(ledger.commitCount, 2, 'replay must not commit a second copy');
  assert.equal(ledger.getVerified('receipt-pair-v1')?.storage?.viewerReceipt?.keyId, receiptKeyId);
  assert.equal(ledger.getVerified('receipt-pair-v2')?.storage?.viewerReceipt?.keyId, receiptKeyId);
  assert.ok((ledger.requestCounts.get('GET /api/v1/reference/v1/acceptances/receipt-pair-v1') || 0) >= 3,
    'sender must recover the accepted copy through status replay');
  assert.ok((ledger.requestCounts.get('GET /api/v1/reference/v2/acceptances/receipt-pair-v2') || 0) >= 1,
    'TreeDar sender must use the v2 acceptance route');
  t.diagnostic(`Paired contract: ${JSON.stringify(report)}; commits=${ledger.commitCount}; v1 status reads=${ledger.requestCounts.get('GET /api/v1/reference/v1/acceptances/receipt-pair-v1')}`);
});
