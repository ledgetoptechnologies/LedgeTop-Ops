'use strict';

const crypto = require('node:crypto');
const Contract = require('./sourceReleaseContractV1');
const { verifiedOutputProof } = require('./sourceReleaseReadyProofV1');
const { getHeldSourceSnapshot, verifyHeldSourceSnapshot, acceptHeldSourceSnapshot,
  releaseHeldSourceSnapshot } = require('./heldSourceSnapshot');
const { validateCompletionReceipt } = require('./sourceIntakeClientV2');
const { validateSnapshotSelection } = require('./preclaimSourceAttestation');

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
  const resultManifestDigest = crypto.createHash('sha256').update(intent.resultManifestCanonical, 'utf8').digest('hex');
  if (ack.fullyAccepted !== true || ack.job?.jobId !== intent.remoteBinding.jobId
      || ack.job?.generation !== intent.remoteBinding.generation || ack.job?.phase !== 'completed'
      || !completion.sourceReceipt || !completion.derivedReceipt || !copy.acceptance || !copy.viewerReceipt
      || resultManifestDigest !== intent.resultManifestSha256
      || result.resultManifestSha256 !== copy.acceptance.resultManifestSha256
      || result.resultManifestSha256 !== copy.viewerReceipt.resultManifestSha256
      || !ack.viewerReceipt || Contract.canonical(ack.viewerReceipt).compare(Contract.canonical(copy.viewerReceipt)) !== 0
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

function verifiedSnapshot(processing, sourceIntake, intent) {
  const row = processing.database.prepare('SELECT snapshot_id FROM viewer_source_snapshots WHERE attempt_id=?')
    .get(intent.submissionId);
  if (!row) fail('source_release_snapshot_missing');
  const snapshot = getHeldSourceSnapshot(processing, row.snapshot_id);
  const { binding, request, completion } = releaseBinding(intent);
  if (!sourceIntake.snapshotPublicKey || !sourceIntake.snapshotSigner
      || snapshot.issuerId !== sourceIntake.snapshotSigner.issuerId || snapshot.keyId !== sourceIntake.snapshotSigner.keyId
      || !verifyHeldSourceSnapshot(snapshot, sourceIntake.snapshotPublicKey)
      || snapshot.attemptId !== intent.submissionId || snapshot.taskId !== intent.viewerTaskId
      || snapshot.datasetId !== request.sourceManifest.id
      || snapshot.intentSha256 !== request.sourceAttestation.proof.sourceSnapshotSha256)
    fail('source_release_snapshot_binding_mismatch');
  validateSnapshotSelection(snapshot, request);
  // Reconstruct only deterministic per-object ACK projections omitted from the
  // compact durable completion; the retained source/derived receipts are checked
  // in full by the same validator used by the real intake client.
  const acks = (manifest, kind) => manifest.objects.map(object => ({ objectId: object.id,
    objectKind: kind, byteSize: object.byteSize, sha256: object.sha256,
    generation: binding.generation, manifestSha256: manifest.sha256 }));
  validateCompletionReceipt({ ...completion,
    sourceObjectReceipts: acks(request.sourceManifest, 'source'),
    derivedObjectReceipts: acks(request.derivedManifest, 'derived') }, binding, {
    sourceManifest: request.sourceManifest, derivedManifest: request.derivedManifest,
    sourceManifestSha256: request.sourceManifest.sha256, derivedManifestSha256: request.derivedManifest.sha256,
    pipelineManifestSha256: request.manifest.sha256 });
  return { snapshot, completion };
}

function acceptSnapshot(processing, sourceIntake, intent) {
  let { snapshot, completion } = verifiedSnapshot(processing, sourceIntake, intent);
  const verify = (candidate, receipt) => {
    const live = sourceIntake.outbox.getIntent(intent.submissionId);
    const checked = verifiedSnapshot(processing, sourceIntake, live);
    return candidate.snapshotId === checked.snapshot.snapshotId
      && Contract.canonical(receipt).equals(Contract.canonical(checked.completion));
  };
  if (snapshot.status === 'held') snapshot = acceptHeldSourceSnapshot(processing, snapshot.snapshotId,
    { receipt: completion, verifyAcceptance: verify });
  if (!snapshot || !['accepted', 'released'].includes(snapshot.status)
      || !verify(snapshot, snapshot.acceptanceReceipt)) fail('source_release_snapshot_binding_mismatch');
  return { snapshot, binding: { snapshotId: snapshot.snapshotId, datasetId: snapshot.datasetId,
    taskId: snapshot.taskId, attemptId: snapshot.attemptId, intentSha256: snapshot.intentSha256,
    status: snapshot.status } };
}

function retireSnapshot(processing, sourceIntake, sourceRelease, attemptId) {
    const retained = sourceRelease.outbox.getIntent(attemptId);
    if (retained?.state !== 'released' || !retained.receipt || !retained.request)
      fail('source_release_terminal_receipt_missing');
    Contract.verifySignedRequest(retained.request, sourceRelease.trustedReleaseKeys);
    Contract.validateTerminalReceipt(retained.receipt, retained.authorization, retained.authorizationSha256,
      retained.sourceManifest, retained.derivedManifest, retained.snapshotBinding);
    const intent = sourceIntake.outbox.getIntent(attemptId);
    const { snapshot, binding } = acceptSnapshot(processing, sourceIntake, intent);
    if (!Contract.canonical({ ...binding, status: 'accepted' }).equals(Contract.canonical(retained.snapshotBinding)))
      fail('source_release_snapshot_binding_mismatch');
    if (snapshot.status === 'released') return snapshot;
    const released = releaseHeldSourceSnapshot(processing, snapshot.snapshotId, { verifyAcceptance(candidate, receipt) {
      const live = sourceRelease.outbox.getIntent(attemptId);
      if (live?.state !== 'released' || live.receiptSha256 !== retained.receiptSha256) return false;
      Contract.validateTerminalReceipt(live.receipt, live.authorization, live.authorizationSha256,
        live.sourceManifest, live.derivedManifest, live.snapshotBinding);
      const current = verifiedSnapshot(processing, sourceIntake, sourceIntake.outbox.getIntent(attemptId));
      return candidate.intentSha256 === current.snapshot.intentSha256
        && candidate.snapshotId === snapshot.snapshotId
        && Contract.canonical(receipt).equals(Contract.canonical(current.completion));
    } });
    if (!released) fail('source_release_snapshot_retirement_held');
    return released;
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
    environment: binding.environment, viewerTaskId: binding.viewerTaskId, providerTaskId: binding.providerTaskId,
    viewerAttemptId: binding.attemptId, activationId: binding.activationId,
    sourceSnapshotId: snapshotBinding.snapshotId, preparedEnvelopeSha256: binding.preparedEnvelopeSha256,
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
  const prior = sourceRelease.outbox.getIntent(attemptId);
  if (prior?.state === 'released') {
    retireSnapshot(processing, sourceIntake, sourceRelease, attemptId);
    return { status: 'released', state: 'released' };
  }
  const nowIso = now();
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs) || new Date(nowMs).toISOString() !== nowIso) {
    const intent = sourceRelease.outbox.getIntent(attemptId);
    if (intent) sourceRelease.outbox.hold(attemptId, 'timer_clock_invalid');
    return { status: 'held', reason: 'timer_clock_invalid' };
  }
  const readyProof = prior?.readyProof ||
    await verifiedOutputProof({ processing, storage, sourceIntake, attemptId, signal, now: () => nowIso });
  const { binding: snapshotBinding } = acceptSnapshot(processing, sourceIntake, current);
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
    if (prior?.readyProof) {
      const fresh = await verifiedOutputProof({ processing, storage, sourceIntake, attemptId, signal, now: () => nowIso });
      if (!Contract.canonical({ ...fresh, verifiedAt: intent.readyProof.verifiedAt }).equals(Contract.canonical(intent.readyProof)))
        fail('source_release_output_binding_changed');
    }
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
  if (status.state === 'released') {
    const fresh = await verifiedOutputProof({ processing, storage, sourceIntake, attemptId, signal, now: () => nowIso });
    if (!Contract.canonical({ ...fresh, verifiedAt: intent.readyProof.verifiedAt }).equals(Contract.canonical(intent.readyProof)))
      fail('source_release_output_binding_changed');
  }
  intent = sourceRelease.outbox.persistStatus(attemptId, status);
  if (intent.state === 'released') retireSnapshot(processing, sourceIntake, sourceRelease, attemptId);
  return { status: intent.state, state: intent.status?.state, holdReason: intent.holdReason };
}

async function reconcileSourceReleaseQueue({ processing, storage, sourceIntake, sourceRelease, signal, limit = 2, now } = {}) {
  if (!sourceRelease?.enabled) return { scanned: 0, disabled: true };
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) fail('source_release_scan_limit_invalid');
  const timestamp = now ? now() : new Date().toISOString();
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp)
    fail('source_release_timestamp_invalid');
  const due = new Date(Date.parse(timestamp) - 30_000).toISOString();
  const policyDue = new Date(Date.parse(timestamp) - 300_000).toISOString();
  const rows = processing.database.prepare(`SELECT p.viewer_attempt_id AS attempt_id
    FROM viewer_prepared_submission_outbox p
    JOIN processing_attempts a ON a.id=p.viewer_attempt_id AND a.status IN ('ready_for_review','published')
    JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
    LEFT JOIN viewer_source_release_outbox r ON r.attempt_id=p.viewer_attempt_id
    WHERE p.source_intake_canonical IS NOT NULL AND p.source_intake_completion_canonical IS NOT NULL
      AND p.result_manifest_canonical IS NOT NULL AND p.copy_request_canonical IS NOT NULL AND p.copy_ack_canonical IS NOT NULL
      AND (r.attempt_id IS NULL OR r.state IN ('ready','prepared','submitted') OR
        (r.state='released' AND EXISTS (SELECT 1 FROM viewer_source_snapshots s
          WHERE s.attempt_id=p.viewer_attempt_id AND s.status<>'released')))
      AND COALESCE(r.updated_at,p.updated_at) <= CASE WHEN json_valid(r.status_json)
        THEN CASE WHEN json_extract(r.status_json,'$.state')='waiting_policy' THEN ? ELSE ? END ELSE ? END
    ORDER BY COALESCE(r.updated_at,p.updated_at),p.viewer_attempt_id LIMIT ?`).all(policyDue, due, due, limit);
  const results = [];
  for (const row of rows) {
    if (signal?.aborted) break;
    try {
      results.push({ attemptId: row.attempt_id, ...(await processSourceReleaseAttempt({ attemptId: row.attempt_id,
        processing, storage, sourceIntake, sourceRelease, signal, now })) });
    } catch (error) {
      if (sourceRelease.outbox.getIntent(row.attempt_id)) sourceRelease.outbox.noteRetry(row.attempt_id, timestamp);
      else processing.database.prepare(`UPDATE viewer_prepared_submission_outbox SET updated_at=?
        WHERE viewer_attempt_id=? AND copy_ack_canonical IS NOT NULL`).run(timestamp, row.attempt_id);
      results.push({ attemptId: row.attempt_id, status: 'pending', code: String(error?.code || 'source_release_error').slice(0, 80) });
    }
  }
  return { scanned: results.length, results };
}

module.exports = { processSourceReleaseAttempt, reconcileSourceReleaseQueue, releaseBinding, sourceReleaseAuthorization };
