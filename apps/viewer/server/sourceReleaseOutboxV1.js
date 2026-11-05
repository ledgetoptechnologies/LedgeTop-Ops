'use strict';

const crypto = require('node:crypto');
const Contract = require('./sourceReleaseContractV1');

const MAX_BYTES = 16 * 1024 * 1024;
const STATUS_RANK = Object.freeze({ waiting_policy: 0, draining: 1, deleting: 2, held: 3, released: 4 });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function pack(value) {
  let bytes;
  try { bytes = Contract.canonical(value, MAX_BYTES); } catch { fail('source_release_outbox_value_invalid'); }
  return { json: bytes.toString('utf8'), sha256: sha(bytes) };
}

function unpack(row, name, digestColumn = `${name}_sha256`) {
  const json = row[`${name}_json`], digest = row[digestColumn];
  if (json === null || json === undefined) {
    if (digest !== null && digest !== undefined) fail('source_release_outbox_integrity_error');
    return null;
  }
  const bytes = Buffer.from(json, 'utf8');
  if (bytes.length > MAX_BYTES || sha(bytes) !== digest) fail('source_release_outbox_integrity_error');
  try {
    const value = JSON.parse(json);
    if (!Contract.canonical(value, MAX_BYTES).equals(bytes)) fail('source_release_outbox_integrity_error');
    return value;
  } catch (error) {
    if (error?.code === 'source_release_outbox_integrity_error') throw error;
    fail('source_release_outbox_integrity_error');
  }
}

function read(row) {
  if (!row) return null;
  return {
    attemptId: row.attempt_id, releaseId: row.release_id, binding: unpack(row, 'binding'),
    readyProof: unpack(row, 'ready_proof'), readyProofSha256: row.ready_proof_sha256,
    sourceManifest: unpack(row, 'source_manifest'), sourceManifestSha256: row.source_manifest_sha256,
    derivedManifest: unpack(row, 'derived_manifest'), derivedManifestSha256: row.derived_manifest_sha256,
    snapshotBinding: unpack(row, 'snapshot_binding'), snapshotBindingSha256: row.snapshot_binding_sha256,
    authorization: unpack(row, 'authorization', 'authorization_json_sha256'), authorizationSha256: row.authorization_sha256,
    request: unpack(row, 'request'), requestSha256: row.request_sha256,
    observation: unpack(row, 'observation'), observationSha256: row.observation_sha256,
    status: unpack(row, 'status'), statusSha256: row.status_sha256,
    receipt: unpack(row, 'receipt'), receiptSha256: row.receipt_sha256,
    state: row.state, holdReason: row.hold_reason, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function sameProofExceptTime(left, right) {
  if (!left || !right) return false;
  const { verifiedAt: _leftTime, ...leftBody } = left;
  const { verifiedAt: _rightTime, ...rightBody } = right;
  return Contract.canonical(leftBody).equals(Contract.canonical(rightBody));
}

class SourceReleaseOutboxV1 {
  constructor(database) {
    if (!database?.prepare || !database?.exec) fail('source_release_outbox_database_invalid');
    this.database = database;
  }

  getIntent(attemptId) {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId)) fail('source_release_attempt_invalid');
    return read(this.database.prepare('SELECT * FROM viewer_source_release_outbox WHERE attempt_id=?').get(attemptId));
  }

  persistReady({ attemptId, releaseId = crypto.randomUUID(), binding, readyProof, sourceManifest, derivedManifest, snapshotBinding } = {}) {
    if (typeof attemptId !== 'string' || !UUID.test(attemptId) || typeof releaseId !== 'string' || !UUID.test(releaseId)
        || !binding || binding.protocol !== 'ltds-viewer-source-intake-binding-v2'
        || binding.attemptId !== attemptId || binding.jobId !== binding.providerTaskId
        || !Number.isSafeInteger(binding.generation) || binding.generation < 1
        || !['production', 'staging'].includes(binding.environment)) fail('source_release_outbox_binding_invalid');
    if (!readyProof || readyProof.kind !== 'verified_outputs_ready' || readyProof.attemptId !== attemptId
        || typeof readyProof.modelId !== 'string' || typeof readyProof.modelVersionId !== 'string') fail('source_release_ready_proof_invalid');
    const verifiedTime = Date.parse(readyProof.verifiedAt);
    if (!Number.isFinite(verifiedTime) || new Date(readyProof.verifiedAt).toISOString() !== readyProof.verifiedAt)
      fail('source_release_timestamp_invalid');
    Contract.retentionClosuresFromManifests(sourceManifest, derivedManifest);
    if (!snapshotBinding || Object.getPrototypeOf(snapshotBinding) !== Object.prototype
        || Object.keys(snapshotBinding).sort().join(',') !== 'attemptId,datasetId,intentSha256,snapshotId,status,taskId'
        || snapshotBinding.status !== 'accepted' || snapshotBinding.datasetId !== sourceManifest.id
        || snapshotBinding.attemptId !== attemptId || derivedManifest.attemptId !== attemptId
        || !UUID.test(snapshotBinding.snapshotId || '') || !UUID.test(snapshotBinding.taskId || '')
        || !/^[a-f0-9]{64}$/.test(snapshotBinding.intentSha256 || ''))
      fail('source_release_snapshot_binding_mismatch');
    const packed = Object.fromEntries(Object.entries({ binding, readyProof, sourceManifest, derivedManifest, snapshotBinding }).map(([key, value]) => [key, pack(value)]));
    const createdAt = new Date().toISOString();
    this.database.prepare(`INSERT INTO viewer_source_release_outbox (
      attempt_id,release_id,binding_json,binding_sha256,ready_proof_json,ready_proof_sha256,source_manifest_json,source_manifest_sha256,
      derived_manifest_json,derived_manifest_sha256,snapshot_binding_json,snapshot_binding_sha256,state,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'ready',?,?) ON CONFLICT(attempt_id) DO NOTHING`)
      .run(attemptId, releaseId, packed.binding.json, packed.binding.sha256, packed.readyProof.json, packed.readyProof.sha256,
        packed.sourceManifest.json, packed.sourceManifest.sha256, packed.derivedManifest.json, packed.derivedManifest.sha256,
        packed.snapshotBinding.json, packed.snapshotBinding.sha256, createdAt, createdAt);
    const intent = this.getIntent(attemptId);
    if (intent.releaseId !== releaseId && !this.database.prepare('SELECT 1 FROM viewer_source_release_outbox WHERE attempt_id=?').get(attemptId))
      fail('source_release_outbox_insert_failed');
    const same = intent.binding && packed.binding.sha256 === pack(intent.binding).sha256
      && packed.sourceManifest.sha256 === intent.sourceManifestSha256
      && packed.derivedManifest.sha256 === intent.derivedManifestSha256
      && packed.snapshotBinding.sha256 === intent.snapshotBindingSha256
      && sameProofExceptTime(intent.readyProof, readyProof);
    if (!same) {
      if (intent.state !== 'released') this.database.prepare(`UPDATE viewer_source_release_outbox
        SET state='held',hold_reason='qualification_changed',updated_at=? WHERE attempt_id=?`).run(new Date().toISOString(), attemptId);
      return this.getIntent(attemptId);
    }
    return intent;
  }

  persistObservation(attemptId, observation) {
    const intent = this.getIntent(attemptId);
    if (!intent || ['held', 'released'].includes(intent.state)) fail('source_release_outbox_not_ready');
    if (observation?.coordinatorAuthorityId !== intent.binding.coordinatorAuthorityId
        || observation?.jobId !== intent.binding.jobId || observation?.generation !== intent.binding.generation)
      fail('source_release_observation_binding_mismatch');
    require('./sourceReleaseClientV1').validateObservation(observation, intent.binding);
    const packed = pack(observation), existing = intent.observation;
    if (existing && pack(existing).sha256 !== packed.sha256) fail('source_release_observation_conflict');
    this.database.prepare(`UPDATE viewer_source_release_outbox SET observation_json=COALESCE(observation_json,?),
      observation_sha256=COALESCE(observation_sha256,?),updated_at=? WHERE attempt_id=?`)
      .run(packed.json, packed.sha256, new Date().toISOString(), attemptId);
    return this.getIntent(attemptId);
  }

  persistRequest(attemptId, authorization, request, { trustedReleaseKeys = [] } = {}) {
    const intent = this.getIntent(attemptId);
    if (!intent || intent.state === 'held' || intent.state === 'released' || !intent.observation)
      fail('source_release_outbox_not_prepared');
    Contract.validateAuthorizationManifests(authorization, intent.sourceManifest, intent.derivedManifest, intent.snapshotBinding);
    if (authorization.releaseId !== intent.releaseId || authorization.viewerAttemptId !== attemptId
        || request?.authorization !== authorization || !request.signature || !request.authorizationSha256
        || authorization.coordinatorAuthorityId !== intent.binding.coordinatorAuthorityId
        || authorization.jobId !== intent.binding.jobId || authorization.generation !== intent.binding.generation
        || authorization.environment !== intent.binding.environment || authorization.providerTaskId !== intent.binding.providerTaskId
        || authorization.inputManifestSha256 !== intent.binding.manifestSha256
        || authorization.pipelineDigest !== intent.binding.pipelineDigest
        || authorization.resultManifestSha256 !== intent.binding.resultManifestSha256
        || authorization.workerObservationId !== intent.observation.observationId
        || authorization.workerObservationAckSha256 !== intent.observation.ackSha256)
      fail('source_release_outbox_request_invalid');
    Contract.verifySignedRequest(request, trustedReleaseKeys);
    const authPacked = pack(authorization), requestPacked = pack(request);
    if (intent.request && (intent.requestSha256 !== requestPacked.sha256 || intent.authorizationSha256 !== request.authorizationSha256))
      fail('source_release_request_conflict');
    this.database.prepare(`UPDATE viewer_source_release_outbox SET authorization_json=COALESCE(authorization_json,?),
      authorization_json_sha256=COALESCE(authorization_json_sha256,?),authorization_sha256=COALESCE(authorization_sha256,?),
      request_json=COALESCE(request_json,?),request_sha256=COALESCE(request_sha256,?),
      state=CASE WHEN state IN ('ready','prepared') THEN 'prepared' ELSE state END,updated_at=? WHERE attempt_id=?`)
      .run(authPacked.json, authPacked.sha256, request.authorizationSha256, requestPacked.json, requestPacked.sha256, new Date().toISOString(), attemptId);
    return this.getIntent(attemptId);
  }

  persistStatus(attemptId, status) {
    const intent = this.getIntent(attemptId);
    if (!intent?.request || intent.state === 'held') fail('source_release_outbox_request_missing');
    const binding = { coordinatorAuthorityId:intent.binding.coordinatorAuthorityId,jobId:intent.binding.jobId,
      generation:intent.binding.generation,releaseId:intent.releaseId,authorizationSha256:intent.authorizationSha256 };
    const checked = Contract.validateReleaseStatus(status, binding), packed = pack(checked);
    if (intent.status && STATUS_RANK[checked.state] < STATUS_RANK[intent.status.state]) fail('source_release_status_regression');
    if (intent.state === 'released' && intent.statusSha256 !== packed.sha256) fail('source_release_status_conflict');
    if (checked.state === 'released') {
      const receipt = Contract.validateTerminalReceipt(checked.receipt, intent.authorization, intent.authorizationSha256,
        intent.sourceManifest, intent.derivedManifest, intent.snapshotBinding);
      const receiptPacked = pack(receipt);
      this.database.prepare(`UPDATE viewer_source_release_outbox SET status_json=?,status_sha256=?,receipt_json=?,receipt_sha256=?,
        state='released',hold_reason=NULL,updated_at=? WHERE attempt_id=?`)
        .run(packed.json, packed.sha256, receiptPacked.json, receiptPacked.sha256, new Date().toISOString(), attemptId);
    } else {
      const nextState = checked.state === 'held' ? 'held' : 'submitted';
      this.database.prepare(`UPDATE viewer_source_release_outbox SET status_json=?,status_sha256=?,state=?,hold_reason=?,updated_at=? WHERE attempt_id=?`)
        .run(packed.json, packed.sha256, nextState, checked.holdReason, new Date().toISOString(), attemptId);
    }
    return this.getIntent(attemptId);
  }
}

module.exports = { SourceReleaseOutboxV1 };
