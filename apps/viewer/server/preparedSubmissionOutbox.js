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

  acceptRemoteBinding(attemptId, response, { environment, localJobId, owner }) {
    const row = this.database.prepare('SELECT * FROM viewer_prepared_submission_outbox WHERE viewer_attempt_id=?').get(attemptId);
    const intent = readIntent(row);
    if (!intent) fail('prepared_outbox_intent_missing');
    if (localJobId !== intent.localJobId) fail('prepared_outbox_intent_mismatch');
    if (!response || Object.getPrototypeOf(response) !== Object.prototype
        || response.authorityId !== intent.coordinatorAuthorityId || !UUID.test(response.authorityId || '')
        || typeof response.jobId !== 'string' || !ID.test(response.jobId)
        || !Number.isSafeInteger(response.generation) || response.generation < 1
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
        headers: { Authorization: `Bearer ${this.bearerToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
