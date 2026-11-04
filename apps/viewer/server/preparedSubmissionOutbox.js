'use strict';

const crypto = require('node:crypto');

const PROTOCOL = 'ltds-viewer-prepared-envelope-jcs-v3';
const DOMAIN = Buffer.from(`${PROTOCOL}\0`, 'ascii');
const PATH = '/ltds/prepared/v3/submissions';
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function validUnicode(value) {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function canonicalizeJcs(value, { maxBytes = MAX_BODY_BYTES, maxDepth = 24, maxNodes = 100000 } = {}) {
  let nodes = 0;
  function encode(item, depth) {
    if (++nodes > maxNodes || depth > maxDepth) fail('prepared_envelope_limit');
    if (item === null) return 'null';
    if (typeof item === 'boolean') return item ? 'true' : 'false';
    if (typeof item === 'string') {
      if (!validUnicode(item)) fail('prepared_envelope_invalid_unicode');
      return JSON.stringify(item);
    }
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || Math.abs(item) > Number.MAX_SAFE_INTEGER
          || Number.isInteger(item) && !Number.isSafeInteger(item)) fail('prepared_envelope_invalid_number');
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(value => encode(value, depth + 1)).join(',')}]`;
    if (!item || Object.getPrototypeOf(item) !== Object.prototype) fail('prepared_envelope_invalid_value');
    const keys = Object.keys(item).sort();
    for (const key of keys) if (!validUnicode(key)) fail('prepared_envelope_invalid_unicode');
    return `{${keys.map(key => `${JSON.stringify(key)}:${encode(item[key], depth + 1)}`).join(',')}}`;
  }
  const text = encode(value, 0);
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > maxBytes) fail('prepared_envelope_too_large');
  return bytes;
}

function canonicalEnvelope(envelope) {
  if (!envelope || Object.getPrototypeOf(envelope) !== Object.prototype
      || Object.keys(envelope).sort().join(',') !== 'activationId,protocol,schemaVersion,submission,viewerAttemptId,viewerTaskId'
      || envelope.schemaVersion !== 3 || envelope.protocol !== PROTOCOL
      || !UUID.test(envelope.viewerTaskId) || !UUID.test(envelope.viewerAttemptId) || !UUID.test(envelope.activationId)
      || !envelope.submission || Object.getPrototypeOf(envelope.submission) !== Object.prototype
      || !UUID.test(envelope.submission.submissionId)) fail('prepared_envelope_invalid');
  const bytes = canonicalizeJcs(envelope);
  return { bytes, text: bytes.toString('utf8'), sha256: crypto.createHash('sha256').update(DOMAIN).update(bytes).digest('hex') };
}

function readIntent(row) {
  if (!row) return null;
  const bytes = Buffer.from(row.envelope_canonical, 'utf8');
  const digest = crypto.createHash('sha256').update(DOMAIN).update(bytes).digest('hex');
  if (digest !== row.envelope_sha256) fail('prepared_outbox_integrity_error');
  let envelope;
  try { envelope = JSON.parse(bytes.toString('utf8')); } catch { fail('prepared_outbox_integrity_error'); }
  const checked = canonicalEnvelope(envelope);
  if (!checked.bytes.equals(bytes) || checked.sha256 !== row.envelope_sha256
      || envelope.submission.submissionId !== row.submission_id
      || envelope.viewerTaskId !== row.viewer_task_id || envelope.viewerAttemptId !== row.viewer_attempt_id) {
    fail('prepared_outbox_integrity_error');
  }
  const sourceIntakeCanonical = row.source_intake_canonical || null;
  const sourceIntakeSha256 = row.source_intake_sha256 || null;
  const sourceIntakeCompletionCanonical = row.source_intake_completion_canonical || null;
  const sourceIntakeCompletionSha256 = row.source_intake_completion_sha256 || null;
  const resultManifestCanonical = row.result_manifest_canonical || null;
  const resultManifestSha256 = row.result_manifest_sha256 || null;
  const copyRequestCanonical = row.copy_request_canonical || null;
  const copyRequestSha256 = row.copy_request_sha256 || null;
  const copyAckCanonical = row.copy_ack_canonical || null;
  const copyAckSha256 = row.copy_ack_sha256 || null;
  if ((sourceIntakeCanonical === null) !== (sourceIntakeSha256 === null)) fail('prepared_outbox_integrity_error');
  if ((sourceIntakeCompletionCanonical === null) !== (sourceIntakeCompletionSha256 === null)) fail('prepared_outbox_integrity_error');
  if ((resultManifestCanonical === null) !== (resultManifestSha256 === null)
      || (copyRequestCanonical === null) !== (copyRequestSha256 === null)
      || (copyAckCanonical === null) !== (copyAckSha256 === null)
      || (copyRequestCanonical !== null && resultManifestCanonical === null)
      || (copyAckCanonical !== null && copyRequestCanonical === null)) fail('prepared_outbox_integrity_error');
  if (sourceIntakeCanonical !== null) {
    const sourceBytes = Buffer.from(sourceIntakeCanonical, 'utf8');
    const sourceDigest = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    let sourceRequest;
    try { sourceRequest = JSON.parse(sourceIntakeCanonical); } catch { fail('prepared_outbox_integrity_error'); }
    if (sourceBytes.length > MAX_BODY_BYTES || sourceDigest !== sourceIntakeSha256
        || !canonicalizeJcs(sourceRequest).equals(sourceBytes)) fail('prepared_outbox_integrity_error');
  }
  if (sourceIntakeCompletionCanonical !== null) {
    const completionBytes = Buffer.from(sourceIntakeCompletionCanonical, 'utf8');
    const completionDigest = crypto.createHash('sha256').update(completionBytes).digest('hex');
    let completion;
    try { completion = JSON.parse(sourceIntakeCompletionCanonical); } catch { fail('prepared_outbox_integrity_error'); }
    if (completionBytes.length > 8 * 1024 * 1024 || completionDigest !== sourceIntakeCompletionSha256
        || !canonicalizeJcs(completion).equals(completionBytes)) fail('prepared_outbox_integrity_error');
  }
  for (const [canonical, digest, maximum] of [[resultManifestCanonical,resultManifestSha256,16*1024*1024],
    [copyRequestCanonical,copyRequestSha256,16*1024*1024],[copyAckCanonical,copyAckSha256,16*1024*1024]]) {
    if (canonical === null) continue;
    const bytes=Buffer.from(canonical,'utf8');let value;
    try{value=JSON.parse(canonical);}catch{fail('prepared_outbox_integrity_error');}
    if(bytes.length>maximum||crypto.createHash('sha256').update(bytes).digest('hex')!==digest
        ||!canonicalizeJcs(value,{maxBytes:maximum}).equals(bytes))fail('prepared_outbox_integrity_error');
  }
  return {
    submissionId: row.submission_id,
    viewerTaskId: row.viewer_task_id,
    viewerAttemptId: row.viewer_attempt_id,
    localJobId: row.local_job_id,
    coordinatorOrigin: row.coordinator_origin,
    coordinatorAuthorityId: row.coordinator_authority_id || null,
    authenticatedPrincipal: row.authenticated_principal,
    environment: row.environment,
    protocol: row.protocol,
    envelopeCanonical: row.envelope_canonical,
    envelopeSha256: row.envelope_sha256,
    sourceIntakeCanonical,
    sourceIntakeSha256,
    sourceIntakeCompletionCanonical,
    sourceIntakeCompletionSha256,
    resultManifestCanonical,
    resultManifestSha256,
    copyRequestCanonical,
    copyRequestSha256,
    copyAckCanonical,
    copyAckSha256,
    state: row.state,
    remoteBinding: row.remote_binding_json ? JSON.parse(row.remote_binding_json) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function liveLease(row) {
  const expiry = Date.parse(row?.lease_expires_at || '');
  return Boolean(row && Number.isFinite(expiry) && expiry > Date.now());
}

class PreparedSubmissionOutbox {
  constructor(database) {
    if (!database || typeof database.prepare !== 'function' || typeof database.exec !== 'function') fail('prepared_outbox_database_required');
    this.database = database;
  }

  persistIntent({ localJobId, owner, origin, authorityId, principalId, environment, envelope }) {
    if (typeof localJobId !== 'string' || !localJobId || typeof owner !== 'string' || !owner) fail('prepared_outbox_lease_required');
    const coordinatorOrigin = validateOrigin(origin);
    if (typeof authorityId !== 'string' || !UUID.test(authorityId)) fail('prepared_submission_authority_invalid');
    if (typeof principalId !== 'string' || !ID.test(principalId)) fail('prepared_submission_principal_invalid');
    if (!['staging', 'production'].includes(environment)) fail('prepared_submission_environment_invalid');
    const checked = canonicalEnvelope(envelope);
    const attemptId = envelope.viewerAttemptId;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const now = new Date().toISOString();
      const leased = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
        FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
          AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`).get(localJobId, attemptId, owner, now);
      if (!liveLease(leased) || leased.task_id !== envelope.viewerTaskId) fail('prepared_outbox_lease_lost');
      const existing = this.database.prepare(`SELECT * FROM viewer_prepared_submission_outbox
        WHERE submission_id=? OR viewer_attempt_id=? OR local_job_id=?`).get(envelope.submission.submissionId, attemptId, localJobId);
      if (existing) {
        const prior = readIntent(existing);
        if (prior.submissionId !== envelope.submission.submissionId || prior.viewerTaskId !== envelope.viewerTaskId
            || prior.viewerAttemptId !== attemptId || prior.localJobId !== localJobId
            || prior.coordinatorOrigin !== coordinatorOrigin || prior.coordinatorAuthorityId !== authorityId
            || prior.authenticatedPrincipal !== principalId || prior.environment !== environment
            || prior.envelopeCanonical !== checked.text || prior.envelopeSha256 !== checked.sha256) fail('prepared_outbox_conflict');
        this.database.exec('COMMIT');
        return prior;
      }
      this.database.prepare(`INSERT INTO viewer_prepared_submission_outbox
        (submission_id,viewer_task_id,viewer_attempt_id,local_job_id,coordinator_origin,coordinator_authority_id,authenticated_principal,environment,protocol,envelope_canonical,envelope_sha256,state,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'prepared',?,?)`).run(
        envelope.submission.submissionId, envelope.viewerTaskId, attemptId, localJobId, coordinatorOrigin, authorityId, principalId, environment, PROTOCOL, checked.text, checked.sha256, now, now);
      const created = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(envelope.submission.submissionId);
      this.database.exec('COMMIT');
      return readIntent(created);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  getIntent(attemptId) {
    return readIntent(this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE viewer_attempt_id=?').get(attemptId));
  }

  assertCurrentLease({ attemptId, localJobId, owner }) {
    if (typeof owner !== 'string' || !owner || typeof localJobId !== 'string' || !localJobId) fail('prepared_outbox_lease_required');
    const intent = this.getIntent(attemptId);
    if (!intent || intent.localJobId !== localJobId) fail('prepared_outbox_intent_missing');
    const leased = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
      FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
      JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
      WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
        AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`).get(localJobId, attemptId, owner, new Date().toISOString());
    if (!liveLease(leased) || leased.task_id !== intent.viewerTaskId) fail('prepared_outbox_lease_lost');
    return intent;
  }

  persistSourceIntakeRequest(attemptId, sourceIntakeCanonical, { localJobId, owner } = {}) {
    if (typeof sourceIntakeCanonical !== 'string' || !sourceIntakeCanonical.length) fail('source_intake_request_missing');
    if (Buffer.byteLength(sourceIntakeCanonical, 'utf8') > MAX_BODY_BYTES) fail('source_intake_request_too_large');
    const intent = this.assertCurrentLease({ attemptId, localJobId, owner });
    if (!intent || intent.state !== 'prepared' || intent.remoteBinding) fail('source_intake_outbox_state_invalid');
    let request;
    try { request = JSON.parse(sourceIntakeCanonical); } catch { fail('source_intake_request_invalid_json'); }
    const preparedEnvelope = JSON.parse(intent.envelopeCanonical);
    const sourceBytes = Buffer.from(sourceIntakeCanonical, 'utf8');
    if (!canonicalizeJcs(request).equals(sourceBytes)
        || Object.keys(request).sort().join(',') !== 'capabilityFingerprint,derivedManifest,manifest,pipeline,providerTaskId,schemaVersion,sourceAttestation,sourceManifest,submissionId,viewerTaskId'
        || request.schemaVersion !== 2 || request.submissionId !== intent.viewerAttemptId
        || request.viewerTaskId !== intent.viewerTaskId || !UUID.test(request.providerTaskId || '')
        || !request.sourceManifest || !request.derivedManifest || !request.manifest || !request.pipeline
        || request.sourceManifest.sha256 !== request.sourceAttestation?.proof?.sourceManifestSha256
        || request.derivedManifest.sha256 !== request.sourceAttestation?.proof?.derivedManifestSha256
        || request.manifest.sha256 !== request.sourceAttestation?.proof?.pipelineManifestSha256
        || !canonicalizeJcs(request.pipeline).equals(canonicalizeJcs(preparedEnvelope.submission.pipeline)))
      fail('source_intake_request_binding_invalid');
    const proof = request.sourceAttestation.proof;
    const proofMessage = Buffer.concat([
      Buffer.from('ltds-preclaim-source-attestation-v2\0', 'ascii'),
      canonicalizeJcs(proof, { maxBytes: 8192 }),
    ]);
    const proofDigest = crypto.createHash('sha256').update(proofMessage).digest('hex');
    if (proof.submissionId !== intent.viewerAttemptId || proof.viewerAttemptId !== intent.viewerAttemptId
        || proof.viewerTaskId !== intent.viewerTaskId || proof.providerTaskId !== request.providerTaskId
        || proof.preparedEnvelopeSha256 !== intent.envelopeSha256
        || proof.activationId !== JSON.parse(intent.envelopeCanonical).activationId
        || request.sourceAttestation.attestationSha256 !== proofDigest
        || typeof request.sourceAttestation.signature !== 'string'
        || !/^[A-Za-z0-9_-]{86}$/.test(request.sourceAttestation.signature)) fail('source_intake_request_binding_invalid');
    const sourceIntakeSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      const currentIntent = readIntent(current);
      if (!currentIntent || currentIntent.localJobId !== localJobId) fail('prepared_outbox_intent_missing');
      const currentLease = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
        FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
          AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`)
        .get(localJobId, attemptId, owner, new Date().toISOString());
      if (!liveLease(currentLease) || currentLease.task_id !== intent.viewerTaskId) fail('prepared_outbox_lease_lost');
      if (currentIntent.sourceIntakeCanonical !== null) {
        if (currentIntent.sourceIntakeCanonical !== sourceIntakeCanonical
            || currentIntent.sourceIntakeSha256 !== sourceIntakeSha256) fail('source_intake_request_conflict');
      } else {
        this.database.prepare(`UPDATE viewer_prepared_submission_outbox SET source_intake_canonical=?,source_intake_sha256=?,updated_at=?
          WHERE submission_id=? AND state='prepared' AND source_intake_canonical IS NULL`).run(
          sourceIntakeCanonical, sourceIntakeSha256, new Date().toISOString(), intent.submissionId);
      }
      const saved = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      this.database.exec('COMMIT');
      return readIntent(saved);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  acceptSourceIntakeBinding(attemptId, response, { environment, localJobId, owner } = {}) {
    const intent = this.assertCurrentLease({ attemptId, localJobId, owner });
    if (!intent || !intent.sourceIntakeCanonical) fail('source_intake_request_missing');
    const request = JSON.parse(intent.sourceIntakeCanonical);
    const expected = {
      protocol: 'ltds-viewer-source-intake-binding-v2',
      coordinatorAuthorityId: intent.coordinatorAuthorityId,
      jobId: request.providerTaskId,
      attemptId: request.submissionId,
      providerTaskId: request.providerTaskId,
      generation: response?.generation,
      environment,
      manifestSha256: request.manifest.sha256,
      pipelineManifestSha256: request.manifest.sha256,
      sourceManifestSha256: request.sourceManifest.sha256,
      derivedManifestSha256: request.derivedManifest.sha256,
      pipelineDigest: request.sourceAttestation.proof.pipelineDigest,
      requestSha256: intent.sourceIntakeSha256,
    };
    if (!response || Object.getPrototypeOf(response) !== Object.prototype
        || response.jobId !== expected.jobId || response.attemptId !== expected.attemptId
        || response.providerTaskId !== expected.providerTaskId
        || !Number.isSafeInteger(response.generation) || response.generation < 1
        || response.environment !== environment
        || response.manifestSha256 !== expected.manifestSha256
        || response.pipelineManifestSha256 !== expected.pipelineManifestSha256
        || response.sourceManifestSha256 !== expected.sourceManifestSha256
        || response.derivedManifestSha256 !== expected.derivedManifestSha256
        || response.pipelineDigest !== expected.pipelineDigest
        || response.status !== 'queued' || response.phase !== 'source_receiving'
        || response.sourceState !== 'receiving' || response.derivedState !== 'receiving'
        || response.sourceReceipt !== null || response.derivedReceipt !== null
        || response.sourceReceiptSha256 != null || response.derivedReceiptSha256 != null) fail('source_intake_binding_mismatch');
    const { generation, ...binding } = expected;
    const encoded = JSON.stringify({ ...binding, generation });
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT state,remote_binding_json FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      const leased = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
        FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
          AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`)
        .get(localJobId, attemptId, owner, new Date().toISOString());
      if (!current || !liveLease(leased) || leased.task_id !== intent.viewerTaskId) fail('prepared_outbox_lease_lost');
      if (current.state === 'accepted') {
        if (current.remote_binding_json !== encoded) fail('source_intake_replay_conflict');
      } else {
        if (current.state !== 'prepared') fail('prepared_outbox_held');
        this.database.prepare(`UPDATE viewer_prepared_submission_outbox SET state='accepted',remote_binding_json=?,updated_at=?
          WHERE submission_id=? AND state='prepared'`).run(encoded, new Date().toISOString(), intent.submissionId);
      }
      const accepted = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      this.database.exec('COMMIT');
      return readIntent(accepted);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  persistSourceIntakeCompletion(attemptId, completion, { environment, localJobId, owner } = {}) {
    const intent = this.assertCurrentLease({ attemptId, localJobId, owner });
    if (!intent || intent.state !== 'accepted' || !intent.sourceIntakeCanonical || !intent.remoteBinding
        || intent.remoteBinding.protocol !== 'ltds-viewer-source-intake-binding-v2') fail('source_intake_binding_missing');
    if (!completion || Object.getPrototypeOf(completion) !== Object.prototype) fail('source_intake_completion_invalid');
    const request = JSON.parse(intent.sourceIntakeCanonical);
    const binding = intent.remoteBinding;
    if (binding.environment !== environment || completion.jobId !== binding.jobId
        || completion.attemptId !== request.submissionId || completion.providerTaskId !== request.providerTaskId
        || completion.generation !== binding.generation || completion.environment !== environment
        || completion.sourceManifestSha256 !== request.sourceManifest.sha256
        || completion.derivedManifestSha256 !== request.derivedManifest.sha256
        || completion.pipelineManifestSha256 !== request.manifest.sha256
        || completion.pipelineDigest !== request.sourceAttestation.proof.pipelineDigest
        || completion.status !== 'queued' || completion.phase !== 'queued'
        || completion.sourceState !== 'retained' || completion.derivedState !== 'retained'
        || !completion.sourceReceipt || !completion.derivedReceipt
        || !/^[a-f0-9]{64}$/.test(completion.sourceReceiptSha256 || '')
        || !/^[a-f0-9]{64}$/.test(completion.derivedReceiptSha256 || '')
        || crypto.createHash('sha256').update(canonicalizeJcs(completion.sourceReceipt)).digest('hex') !== completion.sourceReceiptSha256
        || crypto.createHash('sha256').update(canonicalizeJcs(completion.derivedReceipt)).digest('hex') !== completion.derivedReceiptSha256)
      fail('source_intake_completion_binding_mismatch');
    const canonical = canonicalizeJcs(completion, { maxBytes: 8 * 1024 * 1024 }).toString('utf8');
    const digest = crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      const saved = readIntent(current);
      const lease = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
        FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
          AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`)
        .get(localJobId, attemptId, owner, new Date().toISOString());
      if (!saved || !liveLease(lease) || lease.task_id !== intent.viewerTaskId) fail('prepared_outbox_lease_lost');
      if (saved.sourceIntakeCompletionCanonical !== null) {
        if (saved.sourceIntakeCompletionCanonical !== canonical || saved.sourceIntakeCompletionSha256 !== digest)
          fail('source_intake_completion_conflict');
      } else {
        this.database.prepare(`UPDATE viewer_prepared_submission_outbox
          SET source_intake_completion_canonical=?,source_intake_completion_sha256=?,updated_at=?
          WHERE submission_id=? AND state='accepted' AND source_intake_completion_canonical IS NULL`).run(
          canonical, digest, new Date().toISOString(), intent.submissionId);
      }
      const result = readIntent(this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId));
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }

  persistAcceptedResultRequest(attemptId, resultManifest, request, { environment, localJobId, owner,
    issuerId, keyId, publicKeyPem } = {}) {
    const intent=this.getIntent(attemptId);
    if(!intent||intent.state!=='accepted'||!intent.remoteBinding||intent.remoteBinding.protocol!=='ltds-viewer-source-intake-binding-v2'
        ||!intent.sourceIntakeCanonical||!intent.sourceIntakeCompletionCanonical||environment!==intent.environment)
      fail('source_intake_copy_binding_invalid');
    const ReferenceProtocol=require('./referenceProtocol');
    const sourceRequest=JSON.parse(intent.sourceIntakeCanonical),completion=JSON.parse(intent.sourceIntakeCompletionCanonical),binding=intent.remoteBinding;
    const ids=Array.isArray(resultManifest?.objects)?resultManifest.objects.map(object=>object?.id):null;
    const expected={jobId:binding.jobId,generation:binding.generation,environment,
      pipelineDigest:binding.pipelineDigest,resultManifestSha256:resultManifest?.resultManifestSha256,objectIds:ids};
    const manifest=ReferenceProtocol.validateStoredResultManifest(resultManifest,expected);
    if(!request||Object.getPrototypeOf(request)!==Object.prototype||Object.keys(request).sort().join(',')!=='acceptance,viewerReceipt')
      fail('source_intake_copy_request_invalid');
    const proof=sourceRequest.sourceAttestation?.proof;
    const ack=completion.sourceReceipt&&completion.derivedReceipt;
    if(!proof||!ack||sourceRequest.manifest.sha256!==binding.manifestSha256)fail('source_intake_copy_binding_invalid');
    const acceptance=request.acceptance,receipt=request.viewerReceipt;
    const acceptanceExpected={jobId:binding.jobId,generation:binding.generation,environment,
      inputManifestSha256:sourceRequest.manifest.sha256,pipelineDigest:binding.pipelineDigest,
      resultManifestSha256:manifest.resultManifestSha256,objectIds:manifest.objects.map(object=>object.id)};
    ReferenceProtocol.validateAcceptance(acceptance,acceptanceExpected);
    if(JSON.stringify(acceptance.acceptedObjectIds)!==JSON.stringify(acceptanceExpected.objectIds)
        ||!receipt||receipt.protocol!=='ltds-viewer-accepted-copy-v2'||receipt.schemaVersion!==2
        ||receipt.issuerId!==issuerId||receipt.keyId!==keyId
        ||receipt.coordinatorAuthorityId!==binding.coordinatorAuthorityId||receipt.viewerPrincipalId!==intent.authenticatedPrincipal
        ||receipt.submissionId!==intent.submissionId||receipt.activationId!==JSON.parse(intent.envelopeCanonical).activationId
        ||receipt.viewerTaskId!==intent.viewerTaskId||receipt.viewerAttemptId!==intent.viewerAttemptId
        ||receipt.providerTaskId!==binding.providerTaskId||receipt.jobId!==binding.jobId||receipt.generation!==binding.generation
        ||receipt.environment!==environment||receipt.inputManifestSha256!==sourceRequest.manifest.sha256
        ||receipt.pipelineDigest!==binding.pipelineDigest||receipt.resultManifestSha256!==manifest.resultManifestSha256
        ||receipt.sourceManifestSha256!==sourceRequest.sourceManifest.sha256
        ||receipt.derivedManifestSha256!==sourceRequest.derivedManifest.sha256
        ||receipt.sourceReceiptSha256!==completion.sourceReceiptSha256||receipt.derivedReceiptSha256!==completion.derivedReceiptSha256
        ||JSON.stringify(receipt.acceptedObjectIds)!==JSON.stringify(acceptanceExpected.objectIds)
        ||JSON.stringify(receipt.objects)!==JSON.stringify(manifest.objects.map(({id,byteSize,sha256})=>({id,byteSize,sha256}))))
      fail('source_intake_copy_binding_invalid');
    const receiptCandidate=require('./referenceReceiptV2Candidate');
    if(Object.keys(receipt).sort().join(',')!==[...receiptCandidate.RECEIPT_FIELDS].sort().join(',')
        ||!publicKeyPem||!receipt.signature||! /^[A-Za-z0-9_-]{86}$/.test(receipt.signature)
        ||receipt.acceptanceReceiptId!==acceptance.receiptId||receipt.acceptanceStorageReceiptId!==acceptance.storageReceiptId
        ||receipt.acceptancePayloadSha256!==ReferenceProtocol.sha256(Buffer.concat([
          receiptCandidate.ACCEPTANCE_DOMAIN,ReferenceProtocol.canonicalBytes(acceptance)])))
      fail('source_intake_copy_signature_invalid');
    const {signature,...receiptBody}=receipt;
    let publicKey;try{publicKey=require('node:crypto').createPublicKey(publicKeyPem.replace(/\\n/g,'\n'));}
    catch{fail('source_intake_copy_signature_config_invalid');}
    if(publicKey.asymmetricKeyType!=='ed25519'||!require('node:crypto').verify(null,
      Buffer.concat([receiptCandidate.DOMAIN,ReferenceProtocol.canonicalBytes(receiptBody)]),publicKey,Buffer.from(signature,'base64url')))
      fail('source_intake_copy_signature_invalid');
    const manifestBytes=canonicalizeJcs(manifest,{maxBytes:16*1024*1024}),requestBytes=canonicalizeJcs(request,{maxBytes:16*1024*1024});
    const manifestCanonical=manifestBytes.toString('utf8'),requestCanonical=requestBytes.toString('utf8');
    const manifestDigest=crypto.createHash('sha256').update(manifestBytes).digest('hex'),requestDigest=crypto.createHash('sha256').update(requestBytes).digest('hex');
    this.database.exec('BEGIN IMMEDIATE');
    try{
      const lease=this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at FROM processing_jobs j
        JOIN processing_attempts a ON a.id=j.attempt_id JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='reconcile' AND j.status='leased' AND j.lease_owner=? AND j.lease_expires_at>?
          AND a.status IN ('queued_upstream','running')`).get(localJobId,attemptId,owner,new Date().toISOString());
      if(!liveLease(lease)||lease.task_id!==intent.viewerTaskId)fail('prepared_outbox_lease_lost');
      const row=this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      if(!row)fail('prepared_outbox_intent_missing');
      if(row.result_manifest_canonical!==null){
        if(row.result_manifest_canonical!==manifestCanonical||row.result_manifest_sha256!==manifestDigest)fail('source_intake_result_manifest_conflict');
        if(row.copy_request_canonical!==null&&(row.copy_request_canonical!==requestCanonical||row.copy_request_sha256!==requestDigest))fail('source_intake_copy_request_conflict');
      }else{
        this.database.prepare(`UPDATE viewer_prepared_submission_outbox SET result_manifest_canonical=?,result_manifest_sha256=?,
          copy_request_canonical=?,copy_request_sha256=?,updated_at=? WHERE submission_id=? AND result_manifest_canonical IS NULL
          AND copy_request_canonical IS NULL AND copy_ack_canonical IS NULL`).run(manifestCanonical,manifestDigest,requestCanonical,requestDigest,new Date().toISOString(),intent.submissionId);
      }
      const saved=readIntent(this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId));
      this.database.exec('COMMIT');return saved;
    }catch(error){if(this.database.isTransaction)this.database.exec('ROLLBACK');throw error;}
  }

  persistAcceptedResultAck(attemptId, response, { environment, localJobId, owner } = {}) {
    const intent=this.getIntent(attemptId),savedRequest=intent?.copyRequestCanonical&&JSON.parse(intent.copyRequestCanonical);
    if(!intent||!savedRequest||!intent.resultManifestCanonical||environment!==intent.environment)
      fail('source_intake_copy_ack_binding_invalid');
    if(!response||Object.getPrototypeOf(response)!==Object.prototype||Object.keys(response).sort().join(',')!=='acceptedObjectIds,created,fullyAccepted,job,viewerReceipt'
        ||response.fullyAccepted!==true||typeof response.created!=='boolean'
        ||!Array.isArray(response.acceptedObjectIds)
        ||JSON.stringify(response.acceptedObjectIds)!==JSON.stringify([...savedRequest.acceptance.acceptedObjectIds].sort())
        ||!canonicalizeJcs(response.viewerReceipt).equals(canonicalizeJcs(savedRequest.viewerReceipt))
        ||!response.job||response.job.jobId!==intent.remoteBinding.jobId||response.job.generation!==intent.remoteBinding.generation
        ||response.job.environment!==environment||response.job.phase!=='completed'
        ||!['completed','running','succeeded'].includes(response.job.status))fail('source_intake_copy_ack_binding_invalid');
    const canonical=canonicalizeJcs(response,{maxBytes:16*1024*1024}).toString('utf8'),digest=crypto.createHash('sha256').update(canonical).digest('hex');
    this.database.exec('BEGIN IMMEDIATE');
    try{
      const lease=this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at FROM processing_jobs j
        JOIN processing_attempts a ON a.id=j.attempt_id JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='reconcile' AND j.status='leased' AND j.lease_owner=? AND j.lease_expires_at>?
          AND a.status IN ('queued_upstream','running')`).get(localJobId,attemptId,owner,new Date().toISOString());
      if(!liveLease(lease)||lease.task_id!==intent.viewerTaskId)fail('prepared_outbox_lease_lost');
      const row=this.database.prepare('SELECT copy_ack_canonical,copy_ack_sha256 FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      if(!row)fail('prepared_outbox_intent_missing');
      if(row.copy_ack_canonical!==null){if(row.copy_ack_canonical!==canonical||row.copy_ack_sha256!==digest)fail('source_intake_copy_ack_conflict');}
      else this.database.prepare(`UPDATE viewer_prepared_submission_outbox SET copy_ack_canonical=?,copy_ack_sha256=?,updated_at=?
        WHERE submission_id=? AND copy_ack_canonical IS NULL`).run(canonical,digest,new Date().toISOString(),intent.submissionId);
      const updated=readIntent(this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId));
      this.database.exec('COMMIT');return updated;
    }catch(error){if(this.database.isTransaction)this.database.exec('ROLLBACK');throw error;}
  }

  acceptRemoteBinding(attemptId, response, { environment, localJobId, owner }) {
    const row = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE viewer_attempt_id=?').get(attemptId);
    const intent = readIntent(row);
    if (!intent) fail('prepared_outbox_intent_missing');
    if (intent.sourceIntakeCanonical) fail('prepared_outbox_protocol_mismatch');
    if (localJobId !== intent.localJobId) fail('prepared_outbox_intent_mismatch');
    if (!response || Object.getPrototypeOf(response) !== Object.prototype
        || response.authorityId !== intent.coordinatorAuthorityId || !UUID.test(response.authorityId || '')
        || typeof response.jobId !== 'string' || !ID.test(response.jobId)
        || !Number.isSafeInteger(response.generation) || response.generation < 1
        || typeof response.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(response.manifestSha256)
        || typeof response.pipelineDigest !== 'string' || !/^[a-f0-9]{64}$/.test(response.pipelineDigest)
        || response.environment !== environment || response.submissionId !== intent.submissionId
        || response.envelopeSha256 !== intent.envelopeSha256 || response.viewerTaskId !== intent.viewerTaskId
        || response.viewerAttemptId !== intent.viewerAttemptId || response.activationId !== JSON.parse(intent.envelopeCanonical).activationId) {
      fail('prepared_submission_binding_mismatch');
    }
    const binding = {
      authorityId: response.authorityId,
      jobId: response.jobId,
      generation: response.generation,
      environment: response.environment,
      manifestSha256: response.manifestSha256,
      pipelineDigest: response.pipelineDigest,
      submissionId: response.submissionId,
      envelopeSha256: response.envelopeSha256,
      viewerTaskId: response.viewerTaskId,
      viewerAttemptId: response.viewerAttemptId,
      activationId: response.activationId,
    };
    const encoded = JSON.stringify(binding);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT state,remote_binding_json FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      if (!current) fail('prepared_outbox_intent_missing');
      const leased = this.database.prepare(`SELECT j.id,j.attempt_id,a.task_id,j.lease_expires_at
        FROM processing_jobs j JOIN processing_attempts a ON a.id=j.attempt_id
        JOIN processing_tasks t ON t.id=a.task_id AND t.active_attempt_id=a.id
        WHERE j.id=? AND j.attempt_id=? AND j.job_type='submit' AND j.status='leased'
          AND j.lease_owner=? AND j.lease_expires_at>? AND a.status NOT IN ('cancelled','failed','published')`).get(localJobId, attemptId, owner, new Date().toISOString());
      if (!liveLease(leased) || leased.task_id !== intent.viewerTaskId) fail('prepared_outbox_lease_lost');
      if (current.state === 'accepted') {
        if (current.remote_binding_json !== encoded) fail('prepared_submission_replay_conflict');
      } else {
        if (current.state !== 'prepared') fail('prepared_outbox_held');
        this.database.prepare(`UPDATE viewer_prepared_submission_outbox SET state='accepted',remote_binding_json=?,updated_at=?
          WHERE submission_id=? AND state='prepared'`).run(encoded, new Date().toISOString(), intent.submissionId);
      }
      const accepted = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE submission_id=?').get(intent.submissionId);
      this.database.exec('COMMIT');
      return readIntent(accepted);
    } catch (error) {
      if (this.database.isTransaction) this.database.exec('ROLLBACK');
      throw error;
    }
  }
}

function validateOrigin(origin) {
  let parsed;
  try { parsed = new URL(origin); } catch { fail('prepared_submission_origin_invalid'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== origin || parsed.username || parsed.password
      || parsed.pathname !== '/' || parsed.search || parsed.hash) fail('prepared_submission_origin_invalid');
  return parsed.origin;
}

async function boundedJson(response) {
  if (!response.body?.getReader) fail('prepared_submission_response_invalid');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) { await reader.cancel(); fail('prepared_submission_response_too_large'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('prepared_submission_response_invalid'); }
}

class PreparedSubmissionClient {
  constructor({ origin, authorityId, bearerToken, principalId, environment, outbox, timeoutMs = 15000, fetchImpl = globalThis.fetch }) {
    this.origin = validateOrigin(origin);
    if (typeof authorityId !== 'string' || !UUID.test(authorityId)) fail('prepared_submission_authority_invalid');
    if (typeof bearerToken !== 'string' || bearerToken.length < 16 || bearerToken.length > 4096
        || /[^\x21-\x7e]/.test(bearerToken)) fail('prepared_submission_credential_invalid');
    if (!['staging', 'production'].includes(environment)) fail('prepared_submission_environment_invalid');
    if (typeof principalId !== 'string' || !ID.test(principalId)) fail('prepared_submission_principal_invalid');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) fail('prepared_submission_timeout_invalid');
    if (!(outbox instanceof PreparedSubmissionOutbox) || typeof fetchImpl !== 'function') fail('prepared_submission_client_invalid');
    this.bearerToken = bearerToken;
    this.authorityId = authorityId;
    this.environment = environment;
    this.principalId = principalId;
    this.timeoutMs = timeoutMs;
    this.outbox = outbox;
    this.fetch = fetchImpl;
  }

  async request(path, { method, body, signal }) {
    let response;
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      response = await this.fetch(`${this.origin}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.bearerToken}`, 'X-LTDS-Expected-Coordinator-Authority': this.authorityId, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body } : {}),
        redirect: 'error',
        cache: 'no-store',
        credentials: 'omit',
        signal: requestSignal,
      });
    } catch { fail('prepared_submission_transport_uncertain'); }
    if (response.redirected || response.url && new URL(response.url).origin !== this.origin) fail('prepared_submission_redirect_rejected');
    return response;
  }

  async lookup(intent, signal, owner) {
    const response = await this.request(`${PATH}/${encodeURIComponent(intent.submissionId)}`, { method: 'GET', signal });
    if (response.status === 404) { await response.body?.cancel().catch(() => {}); return null; }
    if (response.status !== 200) fail('prepared_submission_lookup_unavailable');
    const body = await boundedJson(response);
    return this.outbox.acceptRemoteBinding(intent.viewerAttemptId, body, { environment: this.environment, localJobId: intent.localJobId, owner });
  }

  async dispatch(intent, { signal, owner } = {}) {
    if (!intent || typeof intent.viewerAttemptId !== 'string') fail('prepared_outbox_intent_missing');
    const saved = this.outbox.assertCurrentLease({ attemptId: intent.viewerAttemptId, localJobId: intent.localJobId, owner });
    if (!saved || saved.envelopeCanonical !== intent.envelopeCanonical || saved.envelopeSha256 !== intent.envelopeSha256) fail('prepared_outbox_intent_mismatch');
    if (saved.coordinatorOrigin !== this.origin || saved.coordinatorAuthorityId !== this.authorityId
        || saved.authenticatedPrincipal !== this.principalId || saved.environment !== this.environment) fail('prepared_outbox_authority_changed');
    if (saved.sourceIntakeCanonical) fail('prepared_outbox_protocol_mismatch');
    if (saved.state === 'accepted') return saved;
    if (saved.state !== 'prepared') fail('prepared_outbox_held');
    let post;
    try { post = await this.request(PATH, { method: 'POST', body: saved.envelopeCanonical, signal }); }
    catch (error) {
      if (error?.code !== 'prepared_submission_transport_uncertain') throw error;
      post = { status: 503 };
    }
    if (![200, 201, 409].includes(post.status) && post.status < 500) {
      await post.body?.cancel().catch(() => {});
      fail('prepared_submission_rejected');
    }
    await post.body?.cancel().catch(() => {});
    // The POST may commit even if its response is lost. Only the authenticated,
    // exact submission lookup can move the durable outbox to accepted.
    const accepted = await this.lookup(saved, signal, owner);
    if (!accepted) fail(post.status >= 500 ? 'prepared_submission_transport_uncertain' : 'prepared_submission_not_found');
    return accepted;
  }
}

module.exports = { DOMAIN, MAX_BODY_BYTES, PATH, PROTOCOL, PreparedSubmissionClient, PreparedSubmissionOutbox, canonicalEnvelope, canonicalizeJcs, validateOrigin };
