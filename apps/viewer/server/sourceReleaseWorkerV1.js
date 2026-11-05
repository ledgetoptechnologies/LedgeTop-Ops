'use strict';

const crypto = require('node:crypto');
const Contract = require('./sourceReleaseContractV1');
const { verifiedOutputProof } = require('./sourceReleaseReadyProofV1');

const fail = code => { throw Object.assign(new Error(code), { code }); };

function releaseBinding(intent) {
  if (!intent?.remoteBinding || !intent.sourceIntakeCanonical || !intent.sourceIntakeCompletionCanonical
      || !intent.resultManifestCanonical || !intent.copyRequestCanonical || !intent.copyAckCanonical)
    fail('source_release_custody_held');
  const request = JSON.parse(intent.sourceIntakeCanonical);
  const completion = JSON.parse(intent.sourceIntakeCompletionCanonical);
  const envelope = JSON.parse(intent.envelopeCanonical);
  const result = JSON.parse(intent.resultManifestCanonical);
  const copy = JSON.parse(intent.copyRequestCanonical);
  const ack = JSON.parse(intent.copyAckCanonical);
  if (ack.fullyAccepted !== true || ack.job?.jobId !== intent.remoteBinding.jobId
      || ack.job?.generation !== intent.remoteBinding.generation || ack.job?.phase !== 'completed'
      || !completion.sourceReceipt || !completion.derivedReceipt || !copy.acceptance || !copy.viewerReceipt
      || result.resultManifestSha256 !== intent.remoteBinding.resultManifestSha256
      || request.submissionId !== intent.submissionId || envelope.activationId !== request.sourceAttestation.proof.activationId
      || copy.viewerReceipt.sourceReceiptSha256 !== completion.sourceReceiptSha256
      || copy.viewerReceipt.derivedReceiptSha256 !== completion.derivedReceiptSha256)
    fail('source_release_binding_changed');
  const binding = {
    ...intent.remoteBinding, viewerTaskId: intent.viewerTaskId, activationId: envelope.activationId,
    preparedEnvelopeSha256: intent.envelopeSha256, resultManifestSha256: result.resultManifestSha256,
    sourceReceiptSha256: completion.sourceReceiptSha256, derivedReceiptSha256: completion.derivedReceiptSha256,
  };
  if (binding.protocol !== 'ltds-viewer-source-intake-binding-v2' || binding.attemptId !== intent.submissionId
      || binding.providerTaskId !== binding.jobId || request.manifest.sha256 !== binding.manifestSha256
      || request.sourceAttestation.proof.pipelineDigest !== binding.pipelineDigest)
    fail('source_release_binding_changed');
  return { binding, request, completion, envelope, result, copy, ack };
}

function snapshotBindingFor(database, intent) {
  const row = database.prepare(`SELECT snapshot_id,dataset_id,task_id,attempt_id,intent_sha256,status
    FROM viewer_source_snapshots WHERE attempt_id=?`).get(intent.submissionId);
  if (!row) fail('source_release_snapshot_missing');
  return { snapshotId: row.snapshot_id, datasetId: row.dataset_id, taskId: row.task_id,
    attemptId: row.attempt_id, intentSha256: row.intent_sha256, status: row.status };
}

function sourceReleaseAuthorization({ intent, binding, request, completion, copy, observation, readyProof, snapshotBinding, signer }) {
  const closures = Contract.retentionClosuresFromManifests(request.sourceManifest, request.derivedManifest);
  const receipts = [{
    acceptanceReceiptId: copy.acceptance.receiptId,
    acceptanceSha256: Contract.digest(copy.acceptance),
    viewerReceiptId: copy.viewerReceipt.receiptId,
    viewerReceiptSha256: Contract.digest(copy.viewerReceipt),
  }].sort((left, right) => left.acceptanceReceiptId.localeCompare(right.acceptanceReceiptId));
  const authorization = {
    schemaVersion: 1, protocol: Contract.PROTOCOL, releaseId: intent.releaseId,
    issuerId: signer.issuerId, keyId: signer.keyId, principalId: signer.principalId,
    coordinatorAuthorityId: binding.coordinatorAuthorityId, jobId: binding.jobId, generation: binding.generation,
    environment: binding.environment, viewerTaskId: intent.viewerTaskId, providerTaskId: binding.providerTaskId,
    viewerAttemptId: intent.submissionId, activationId: binding.activationId,
    sourceSnapshotId: snapshotBinding.snapshotId, preparedEnvelopeSha256: intent.envelopeSha256,
    sourceSnapshotSha256: snapshotBinding.intentSha256, inputManifestSha256: request.manifest.sha256,
    pipelineDigest: binding.pipelineDigest, resultManifestSha256: binding.resultManifestSha256,
    sourceManifestSha256: request.sourceManifest.sha256, derivedManifestSha256: request.derivedManifest.sha256,
    sourceReceiptSha256: completion.sourceReceiptSha256, derivedReceiptSha256: completion.derivedReceiptSha256,
    workerObservationId: observation.observationId, workerObservationAckSha256: observation.ackSha256,
    receipts, readyProof, policy: Contract.POLICY,
    eligibleObjects: closures.eligibleObjects, eligibleClosureSha256: closures.eligibleClosureSha256,
  };
  return Contract.signAuthorization(authorization, {
    issuerId: signer.issuerId, keyId: signer.keyId, principalId: signer.principalId,
    environment: binding.environment, privateKeyPem: signer.privateKeyPem,
    sourceManifest: request.sourceManifest, derivedManifest: request.derivedManifest, sourceSnapshotBinding: snapshotBinding,
  });
}

async function processSourceReleaseAttempt({ attemptId, processing, storage, sourceIntake, sourceRelease, signal,
  now = () => new Date().toISOString() } = {}) {
  if (!sourceRelease?.enabled || !sourceRelease.client || !sourceRelease.outbox || !sourceRelease.signer)
    return { status: 'disabled' };
  const current = sourceIntake?.outbox?.getIntent(attemptId);
  if (!current) return { status: 'waiting_for_accepted_copy' };
  const { binding, request, completion, copy } = releaseBinding(current);
  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== nowIso) {
    const intent = sourceRelease.outbox.getIntent(attemptId);
    if (intent) sourceRelease.outbox.hold(attemptId, 'timer_clock_invalid');
    return { status: 'held', reason: 'timer_clock_invalid' };
  }
  const readyProof = await verifiedOutputProof({ processing, storage, sourceIntake, attemptId, signal, now: () => nowIso });
  const snapshotBinding = snapshotBindingFor(processing.database, current);
  let intent = sourceRelease.outbox.persistReady({ attemptId, binding, readyProof,
    sourceManifest: request.sourceManifest, derivedManifest: request.derivedManifest, snapshotBinding });
  if (intent.state === 'held' || intent.state === 'released') return { status: intent.state, reason: intent.holdReason };
  if (!Number.isFinite(nowMs - Date.parse(intent.readyProof.verifiedAt)) || nowMs < Date.parse(intent.readyProof.verifiedAt)) {
    intent = sourceRelease.outbox.hold(attemptId, 'timer_clock_invalid');
    return { status: 'held', reason: intent.holdReason };
  }

  if (!intent.observation) {
    const observation = await sourceRelease.client.acceptanceObservation(binding, { signal });
    intent = sourceRelease.outbox.persistObservation(attemptId, observation);
  }
  if (!intent.request) {
    const signed = sourceReleaseAuthorization({ intent, binding, request, completion, copy,
      observation: intent.observation, readyProof: intent.readyProof, snapshotBinding, signer: sourceRelease.signer });
    intent = sourceRelease.outbox.persistRequest(attemptId, signed.authorization, signed,
      { trustedReleaseKeys: sourceRelease.trustedReleaseKeys });
  }
  const statusBinding = { coordinatorAuthorityId: binding.coordinatorAuthorityId, jobId: binding.jobId,
    generation: binding.generation, environment: binding.environment, releaseId: intent.releaseId,
    authorizationSha256: intent.authorizationSha256 };
  let status;
  try {
    status = await sourceRelease.client.status(statusBinding, { signal });
  } catch (error) {
    if (error?.code !== 'source_release_status_not_found') throw error;
  }
  if (!status) status = await sourceRelease.client.submit(binding.jobId,
    Contract.canonical(intent.request).toString('utf8'), statusBinding, { signal });
  intent = sourceRelease.outbox.persistStatus(attemptId, status);
  return { status: intent.state, state: intent.status?.state, holdReason: intent.holdReason };
}

async function reconcileSourceReleaseQueue({ processing, storage, sourceIntake, sourceRelease, signal, limit = 2, now } = {}) {
  if (!sourceRelease?.enabled) return { scanned: 0, disabled: true };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('source_release_scan_limit_invalid');
  const rows = processing.database.prepare(`SELECT p.viewer_attempt_id AS attempt_id
    FROM viewer_prepared_submission_outbox p
    LEFT JOIN viewer_source_release_outbox r ON r.attempt_id=p.viewer_attempt_id
    WHERE p.source_intake_canonical IS NOT NULL AND p.source_intake_completion_canonical IS NOT NULL
      AND p.result_manifest_canonical IS NOT NULL AND p.copy_request_canonical IS NOT NULL AND p.copy_ack_canonical IS NOT NULL
      AND (r.attempt_id IS NULL OR r.state IN ('ready','prepared','submitted'))
    ORDER BY p.updated_at,p.viewer_attempt_id LIMIT ?`).all(limit);
  const results = [];
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      results.push({ attemptId: row.attempt_id, ...(await processSourceReleaseAttempt({ attemptId: row.attempt_id,
        processing, storage, sourceIntake, sourceRelease, signal, now })) });
    } catch (error) {
      results.push({ attemptId: row.attempt_id, status: 'pending', code: String(error?.code || 'source_release_error').slice(0, 80) });
    }
  }
  return { scanned: results.length, results };
}

module.exports = { processSourceReleaseAttempt, reconcileSourceReleaseQueue, releaseBinding, sourceReleaseAuthorization };
