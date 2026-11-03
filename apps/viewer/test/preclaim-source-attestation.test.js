'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { createHeldSourceSnapshot } = require('../server/heldSourceSnapshot');
const { PreparedSubmissionOutbox } = require('../server/preparedSubmissionOutbox');
const ReferenceProtocol = require('../server/referenceProtocol');
const { DOMAIN, createPreclaimSourceAttestation } = require('../server/preclaimSourceAttestation');

const AUTHORITY_ID = '11111111-1111-4111-8111-111111111111';

function fixture(t, { accept = true, gcp = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-preclaim-attestation-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const project = processing.createProject({ displayName: 'Preclaim test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Source', storageMode: 'managed', rootKey: 'datasets' });
  const photoHash = crypto.createHash('sha256').update('synthetic-photo-bytes').digest('hex');
  const files = [{ id: 'photo-1', relativePath: 'flight/photo.jpg', byteSize: 21, sha256: photoHash, contentType: 'image/jpeg' }];
  if (gcp) files.push({ id: 'gcp-source', relativePath: 'control.csv', byteSize: 12, sha256: 'c'.repeat(64), contentType: 'text/csv', processingRole: 'gcp_source' });
  processing.finalizeDataset(dataset.id, files, 'b'.repeat(64));
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'ODM task' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Test ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, capabilityFingerprint: 'capability-test' });
  const job = processing.claimJob('preclaim-test-owner');
  const outbox = new PreparedSubmissionOutbox(database);
  const snapshotKeys = crypto.generateKeyPairSync('ed25519');
  const snapshotSigner = { issuerId: 'viewer-snapshot-issuer', keyId: 'snapshot-key', sign: bytes => crypto.sign(null, bytes, snapshotKeys.privateKey) };
  createHeldSourceSnapshot(processing, { datasetId: dataset.id, taskId: task.id, attemptId: attempt.id, signer: snapshotSigner });

  const capabilities = ReferenceProtocol.createCapabilities('staging');
  const sourceObject = { id: 'photo-1', name: 'photo.jpg', byteSize: 21, sha256: photoHash, kind: 'image', mediaType: 'image/jpeg' };
  const manifest = { id: dataset.id, revision: 1, totalBytes: 21, objectCount: 1, inputCounts: { images: 1, lidarObjects: 0, points: 0 }, objects: [sourceObject], sha256: '0'.repeat(64) };
  manifest.sha256 = ReferenceProtocol.manifestSha256(manifest);
  const submission = {
    schemaVersion: 1, submissionId: attempt.id, manifest,
    pipeline: {
      odm: { requested: true, options: {}, optionsFingerprint: capabilities.engines.odm.optionsFingerprint },
      treedar: { requested: false, inputObjectIds: [], provenanceReceiptId: null }, gaussian_splat: { requested: false },
    }, capabilityFingerprint: capabilities.capabilityFingerprint,
  };
  const envelope = { schemaVersion: 3, protocol: 'ltds-viewer-prepared-envelope-jcs-v3', submission, viewerTaskId: task.id, viewerAttemptId: attempt.id, activationId: crypto.randomUUID() };
  const intent = outbox.persistIntent({
    localJobId: job.id, owner: job.lease_owner, origin: 'https://processing.example', authorityId: AUTHORITY_ID,
    principalId: 'viewer-staging', environment: 'staging', envelope,
  });
  const response = {
    authorityId: AUTHORITY_ID, jobId: 'processing-job-1', generation: 1, environment: 'staging',
    manifestSha256: manifest.sha256, pipelineDigest: 'd'.repeat(64), submissionId: intent.submissionId,
    envelopeSha256: intent.envelopeSha256, viewerTaskId: task.id, viewerAttemptId: attempt.id,
    activationId: envelope.activationId,
  };
  if (accept) outbox.acceptRemoteBinding(attempt.id, response, { environment: 'staging', localJobId: job.id, owner: job.lease_owner });
  const attestationKeys = crypto.generateKeyPairSync('ed25519');
  const signer = { issuerId: 'viewer-preclaim-issuer', keyId: 'preclaim-key', publicKey: attestationKeys.publicKey,
    sign: bytes => crypto.sign(null, bytes, attestationKeys.privateKey) };
  return { processing, outbox, attempt, task, dataset, snapshotKeys, signer, capabilities, response };
}

test('preclaim signer binds accepted envelope to verified held source snapshot and signs the closed v1 claim', t => {
  const f = fixture(t);
  const result = createPreclaimSourceAttestation({
    processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities,
  });
  const canonical = require('../server/preparedSubmissionOutbox').canonicalizeJcs(result.proof);
  assert.deepEqual(result.raw, canonical);
  assert.equal(Object.keys(result.proof).sort().join(','), 'activationId,authorityId,environment,issuerId,keyId,manifestSha256,pipelineDigest,preparedEnvelopeSha256,principalId,protocol,schemaVersion,sourceSnapshotSha256,submissionId,viewerAttemptId,viewerTaskId');
  assert.equal(result.proof.manifestSha256, f.response.manifestSha256);
  assert.equal(result.proof.pipelineDigest, f.response.pipelineDigest);
  assert.equal(crypto.verify(null, Buffer.concat([DOMAIN, result.raw]), f.signer.publicKey, result.signature), true);
  assert.equal(result.attestationSha256, crypto.createHash('sha256').update(Buffer.concat([DOMAIN, result.raw])).digest('hex'));
  assert.equal(f.processing.hasHeldSourceSnapshot(f.dataset.id), true, 'proof creation must not release held source data');
});

test('preclaim signer holds GCP, scope mismatch, and an unaccepted outbox intent', t => {
  const pending = fixture(t, { accept: false });
  const pendingArgs = { processing: pending.processing, outbox: pending.outbox, attemptId: pending.attempt.id,
    snapshotPublicKey: pending.snapshotKeys.publicKey, signer: pending.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: pending.capabilities };
  assert.throws(() => createPreclaimSourceAttestation(pendingArgs), { code: 'preclaim_submission_not_accepted' });

  const f = fixture(t, { gcp: true });
  const args = { processing: f.processing, outbox: f.outbox, attemptId: f.attempt.id,
    snapshotPublicKey: f.snapshotKeys.publicKey, signer: f.signer,
    authorityId: AUTHORITY_ID, principalId: 'viewer-staging', environment: 'staging', capabilities: f.capabilities };
  assert.throws(() => createPreclaimSourceAttestation({ ...args, principalId: 'other-principal' }), { code: 'preclaim_scope_mismatch' });
  assert.throws(() => createPreclaimSourceAttestation(args), { code: 'preclaim_gcp_extension_unavailable' });
});
