'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const Contract = require('../server/sourceReleaseContractV1');
const { SourceReleaseOutboxV1 } = require('../server/sourceReleaseOutboxV1');
const vectors = require('./fixtures/source-release-v1-vectors.json');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-source-release-outbox-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const project = processing.createProject({ displayName: 'Release test' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Dataset', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id, [{ id: 'photo', relativePath: 'photo.jpg', byteSize: 0, sha256: empty, contentType: 'image/jpeg' }], empty);
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Task' });
  const provider = processing.upsertProvider({ type: 'nodeodm', displayName: 'Coordinator', endpoint: 'https://processing.example', enabled: true });
  const attempt = processing.createAttempt({ taskId: task.id, providerId: provider.id, options: {} });
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, processing, project, dataset, task, attempt };
}

function releaseFixture(f) {
  const sourceBody = { schemaVersion: 1, id: f.dataset.id, datasetManifestSha256: '1'.repeat(64), totalBytes: 10, objectCount: 2,
    objects: [
      { id: 'gcp-csv', name: 'control.csv', byteSize: 4, sha256: 'a'.repeat(64), sourceType: 'gcp_source_csv', retentionClass: 'permanent_viewer_hold', retentionHoldId: 'gcp-csv' },
      { id: 'raw-photo', name: 'photo.jpg', byteSize: 6, sha256: 'b'.repeat(64), sourceType: 'raw_input', retentionClass: 'release_after_acceptance', retentionHoldId: null },
    ] };
  const derivedBody = { schemaVersion: 1, attemptId: f.attempt.id, objects: [
    { id: 'gcp-derived', name: 'gcp_list.txt', byteSize: 5, sha256: 'c'.repeat(64), snapshotAttemptId: f.attempt.id,
      snapshotContentSha256: 'c'.repeat(64), snapshotEvidenceSha256: 'd'.repeat(64), sourceType: 'attempt_derived_gcp_list',
      retentionClass: 'release_after_acceptance', retentionHoldId: null },
  ] };
  const sourceManifest = { ...sourceBody, sha256: Contract.digest(sourceBody) };
  const derivedManifest = { ...derivedBody, sha256: Contract.digest(derivedBody) };
  const snapshotBinding = { snapshotId: crypto.randomUUID(), datasetId: f.dataset.id, taskId: f.task.id, attemptId: f.attempt.id,
    intentSha256: 'e'.repeat(64), status: 'accepted' };
  const binding = { protocol: 'ltds-viewer-source-intake-binding-v2', coordinatorAuthorityId: 'coordinator-one',
    attemptId: f.attempt.id, jobId: 'c7e09ee8-2eeb-4fc3-9d3f-28f3638a11fa', providerTaskId: 'c7e09ee8-2eeb-4fc3-9d3f-28f3638a11fa', generation: 1, environment: 'staging',
    manifestSha256: 'f'.repeat(64), pipelineDigest: '0'.repeat(64), resultManifestSha256: '9'.repeat(64) };
  const readyProof = { kind: 'verified_outputs_ready', attemptId: f.attempt.id, modelId: f.project.id, modelVersionId: crypto.randomUUID(),
    outputInventorySha256: '8'.repeat(64), verifiedAt: '2026-11-05T12:00:00.000Z' };
  return { binding, readyProof, sourceManifest, derivedManifest, snapshotBinding };
}

function authFor(intent, observation, f) {
  const authorization = structuredClone(vectors.positive.request.authorization);
  const closures = Contract.retentionClosuresFromManifests(intent.sourceManifest, intent.derivedManifest);
  Object.assign(authorization, {
    releaseId: intent.releaseId, coordinatorAuthorityId: intent.binding.coordinatorAuthorityId,
    issuerId: 'viewer-test-release', keyId: 'test-release-key', principalId: 'viewer-staging',
    jobId: intent.binding.jobId, generation: intent.binding.generation, environment: intent.binding.environment,
    viewerTaskId: f.task.id, providerTaskId: intent.binding.providerTaskId, viewerAttemptId: f.attempt.id,
    sourceSnapshotId: intent.snapshotBinding.snapshotId, sourceSnapshotSha256: intent.snapshotBinding.intentSha256,
    inputManifestSha256: intent.binding.manifestSha256, pipelineDigest: intent.binding.pipelineDigest,
    resultManifestSha256: intent.binding.resultManifestSha256, sourceManifestSha256: intent.sourceManifest.sha256,
    derivedManifestSha256: intent.derivedManifest.sha256, workerObservationId: observation.observationId,
    workerObservationAckSha256: observation.ackSha256, readyProof: intent.readyProof,
    eligibleObjects: closures.eligibleObjects, eligibleClosureSha256: closures.eligibleClosureSha256,
  });
  return authorization;
}

test('source release intent survives restart with anchored readyAt and immutable exact request', t => {
  const f = fixture(t), outbox = new SourceReleaseOutboxV1(f.database), input = releaseFixture(f);
  assert.deepEqual(Object.keys(input.snapshotBinding).sort(), ['attemptId','datasetId','intentSha256','snapshotId','status','taskId']);
  assert.equal(input.snapshotBinding.datasetId, input.sourceManifest.id);
  assert.equal(input.snapshotBinding.attemptId, f.attempt.id);
  assert.equal(input.derivedManifest.attemptId, f.attempt.id);
  assert.match(input.snapshotBinding.intentSha256, /^[a-f0-9]{64}$/);
  assert.match(input.snapshotBinding.snapshotId, /^[0-9a-f-]{36}$/);
  let intent = outbox.persistReady({ attemptId: f.attempt.id, ...input });
  assert.equal(intent.state, 'ready');
  assert.equal(intent.readyProof.verifiedAt, '2026-11-05T12:00:00.000Z');
  assert.deepEqual(Contract.retentionClosuresFromManifests(intent.sourceManifest, intent.derivedManifest).preservedObjects.map(x => x.id), ['gcp-csv']);
  intent = outbox.persistReady({ attemptId: f.attempt.id, ...input,
    readyProof: { ...input.readyProof, verifiedAt: '2026-11-06T12:00:00.000Z' } });
  assert.equal(intent.state, 'ready');
  assert.equal(intent.readyProof.verifiedAt, '2026-11-05T12:00:00.000Z', 'repeat verification does not restart the 24-hour policy clock');

  const observationBody = { schemaVersion: 1, protocol: 'ltds-worker-acceptance-observed-ack-v1',
    coordinatorAuthorityId: input.binding.coordinatorAuthorityId, jobId: input.binding.jobId, generation: input.binding.generation,
    observationId: crypto.randomUUID(), requestSha256: '7'.repeat(64), nodeId: 'node-1', workerId: 'worker-1',
    workerInstanceId: 'instance-1', observedAt: '2026-11-05T12:00:00.000Z' };
  const observation = { ...observationBody, ackSha256: Contract.digest(observationBody) };
  intent = outbox.persistObservation(f.attempt.id, observation);
  const privateDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.testOnlyPrivateSeedHex, 'hex')]);
  const privateKeyPem = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' });
  const trusted = { ...vectors.trustedReleaseKeys[0], environment: 'staging', principalId: 'viewer-staging' };
  const authorization = authFor(intent, observation, f);
  const signedRequest = Contract.signAuthorization(authorization, { ...trusted, privateKeyPem,
    sourceManifest: intent.sourceManifest, derivedManifest: intent.derivedManifest, sourceSnapshotBinding: intent.snapshotBinding });
  intent = outbox.persistRequest(f.attempt.id, authorization, signedRequest, { trustedReleaseKeys: [trusted] });
  assert.equal(intent.state, 'prepared');
  const exactRequest = Contract.canonical(intent.request);

  const reopened = new SourceReleaseOutboxV1(f.database);
  assert.deepEqual(Contract.canonical(reopened.getIntent(f.attempt.id).request), exactRequest);
  const changedProof = { ...input.readyProof, verifiedAt: '2026-11-06T12:00:00.000Z', outputInventorySha256: '6'.repeat(64) };
  const held = reopened.persistReady({ attemptId: f.attempt.id, ...input, readyProof: changedProof });
  assert.equal(held.state, 'held');
  assert.equal(held.holdReason, 'qualification_changed');
  assert.equal(held.readyProof.verifiedAt, input.readyProof.verifiedAt, 'a restart cannot reset the policy clock');
  assert.deepEqual(Contract.canonical(held.request), exactRequest, 'a qualification change cannot rewrite the signed request');
  assert.throws(() => f.database.prepare('DELETE FROM viewer_source_release_outbox WHERE attempt_id=?').run(f.attempt.id), /Viewer source release intent is retained/);
});

test('source release status transitions are monotonic and retain terminal evidence', t => {
  const f = fixture(t), outbox = new SourceReleaseOutboxV1(f.database), input = releaseFixture(f);
  const intent = outbox.persistReady({ attemptId: f.attempt.id, ...input });
  const observationBody = { schemaVersion: 1, protocol: 'ltds-worker-acceptance-observed-ack-v1',
    coordinatorAuthorityId: input.binding.coordinatorAuthorityId, jobId: input.binding.jobId, generation: input.binding.generation,
    observationId: crypto.randomUUID(), requestSha256: '7'.repeat(64), nodeId: 'node-1', workerId: 'worker-1',
    workerInstanceId: 'instance-1', observedAt: '2026-11-05T12:00:00.000Z' };
  const observation = { ...observationBody, ackSha256: Contract.digest(observationBody) };
  outbox.persistObservation(f.attempt.id, observation);
  const privateDer = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(vectors.testOnlyPrivateSeedHex, 'hex')]);
  const privateKeyPem = crypto.createPrivateKey({ key: privateDer, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' });
  const trusted = { ...vectors.trustedReleaseKeys[0], environment: 'staging', principalId: 'viewer-staging' }, authorization = authFor(intent, observation, f);
  const signedRequest = Contract.signAuthorization(authorization, { ...trusted, privateKeyPem,
    sourceManifest: intent.sourceManifest, derivedManifest: intent.derivedManifest, sourceSnapshotBinding: intent.snapshotBinding });
  const prepared = outbox.persistRequest(f.attempt.id, authorization, signedRequest, { trustedReleaseKeys: [trusted] });
  const status = (state, remainingMinimumAgeSeconds) => ({ schemaVersion: 1, protocol: 'ltds-source-release-status-v1',
    coordinatorAuthorityId: input.binding.coordinatorAuthorityId, jobId: input.binding.jobId, generation: input.binding.generation,
    releaseId: prepared.releaseId, authorizationSha256: prepared.authorizationSha256, state, remainingMinimumAgeSeconds,
    holdReason: null, receipt: null });
  assert.equal(outbox.persistStatus(f.attempt.id, status('waiting_policy', 86400)).state, 'submitted');
  assert.equal(outbox.persistStatus(f.attempt.id, status('draining', 0)).status.state, 'draining');
  assert.throws(() => outbox.persistStatus(f.attempt.id, status('waiting_policy', 1)), { code: 'source_release_status_regression' });
});
