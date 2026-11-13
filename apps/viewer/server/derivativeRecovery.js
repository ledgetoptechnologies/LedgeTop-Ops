'use strict';

const crypto = require('node:crypto');
const { stable } = require('../lod-converter-policy.cjs');

const digest = value => crypto.createHash('sha256').update(stable(value)).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const parse = value => JSON.parse(value || '{}');
const MAX_DURATION_MS = 30 * 60_000;
const LEASE_MS = 60_000;

// Deliberately not connected to HTTP or the ordinary derivative worker. The
// qualified supplement verifier and physical-custody adapter are not installed.
class DerivativeRecovery {
  constructor(processing, { qualifySupplement = null } = {}) {
    this.processing = processing;
    this.db = processing.database;
    this.qualifySupplement = qualifySupplement;
    this.tickets = new WeakMap();
  }

  authorize(sessionId, subject) {
    const row = this.db.prepare('SELECT * FROM admin_sessions WHERE id=?').get(sessionId);
    if (!row || row.subject !== subject || row.revoked_at || !(Date.parse(row.expires_at) > Date.now())
      || !parse(row.permissions_json).includes('viewer.processing.write')) fail('recovery_forbidden');
  }

  context(attemptId, jobId) {
    const attempt = this.db.prepare('SELECT * FROM processing_attempts WHERE id=?').get(attemptId);
    const task = attempt && this.db.prepare('SELECT * FROM processing_tasks WHERE id=?').get(attempt.task_id);
    const project = task && this.db.prepare('SELECT * FROM projects WHERE id=?').get(task.project_id);
    const dataset = attempt && this.db.prepare('SELECT * FROM datasets WHERE id=?').get(attempt.dataset_id);
    const provider = attempt && this.db.prepare('SELECT * FROM processing_providers WHERE id=?').get(attempt.provider_id);
    const output = attempt && this.db.prepare('SELECT * FROM model_outputs WHERE id=?').get(attempt.result_model_version_id);
    const version = output && this.db.prepare('SELECT * FROM model_versions WHERE id=?').get(output.id);
    const model = version && this.db.prepare('SELECT * FROM models WHERE id=?').get(version.model_id);
    const jobs = this.db.prepare('SELECT * FROM derivative_jobs WHERE attempt_id=? ORDER BY id').all(attemptId);
    const job = jobs.find(row => row.id === jobId);
    if (!attempt || attempt.status !== 'failed' || !task || task.status !== 'failed'
      || task.active_attempt_id !== attemptId || project?.status !== 'active'
      || dataset?.status !== 'finalized' || dataset.project_id !== task.project_id
      || !provider?.enabled || !attempt.provider_task_id
      || output?.status !== 'failed' || output.attempt_id !== attemptId || output.task_id !== task.id
      || output.model_id !== attempt.result_model_id || output.project_id !== task.project_id
      || version?.status !== 'failed' || version.model_id !== attempt.result_model_id
      || !model || model.provider !== 'ltds-processing' || version.provider_version_id !== attemptId
      || model.active_version_id === version.id || output.root_key !== 'models' || output.storage_mode !== 'managed'
      || !job || job.derivative_type !== 'mesh_tiles' || job.status !== 'failed' || parse(job.request_json).optional
      || jobs.some(row => row.id !== jobId && (['pending', 'leased'].includes(row.status)
        || (!parse(row.request_json).optional && row.status !== 'complete')))) fail('recovery_not_eligible');
    if (this.db.prepare("SELECT 1 FROM processing_attempts WHERE task_id=? AND attempt_number>? LIMIT 1").get(task.id, attempt.attempt_number)
      || this.db.prepare("SELECT 1 FROM processing_jobs WHERE attempt_id=? AND status IN ('pending','leased') LIMIT 1").get(attemptId)
      || this.db.prepare('SELECT 1 FROM dataset_operations WHERE processing_attempt_id=? LIMIT 1').get(attemptId)
      || this.processing.activeDatasetOperations(dataset.id)
      || this.db.prepare('SELECT 1 FROM model_assets WHERE version_id=? AND kind=? LIMIT 1').get(version.id, 'tiles')) fail('recovery_not_eligible');
    const transfer = this.processing.getAttemptTransferProvenance(attemptId);
    const archive = transfer?.archive;
    const input = this.processing.derivativeInputSnapshot(jobId);
    if (!archive || archive.attemptId !== attemptId || archive.providerTaskId !== attempt.provider_task_id
      || !/^[a-f0-9]{64}$/.test(archive.archiveSha256 || '') || !input?.files?.length) fail('recovery_source_unbound');
    const assets = this.db.prepare('SELECT * FROM model_assets WHERE version_id=? ORDER BY id').all(version.id);
    // The durable fingerprint stores digests, never provider credentials.
    const journal = this.db.prepare('SELECT * FROM derivative_storage_journal WHERE job_id=?').get(jobId);
    for (const kind of ['obj', 'glb']) {
      const asset = assets.find(item => item.kind === kind);
      if (!asset || !input.files.some(file => file.rootKey === asset.root_key
        && file.relativePath === asset.relative_path && file.sha256 === asset.sha256
        && file.byteSize === asset.byte_size)) fail('recovery_source_unbound');
    }
    const identity = { attempt, task, project, dataset, provider, output, version, model, jobs, transfer, input, assets, journal };
    return { attempt, task, output, version, model, job, journal, input, archive, fingerprint: digest(identity) };
  }

  request({ attemptId, jobId, sessionId, subject, requestKey, supplementSha256 }) {
    if (typeof requestKey !== 'string' || !/^[A-Za-z0-9_-]{8,120}$/.test(requestKey)
      || !/^[a-f0-9]{64}$/.test(supplementSha256 || '')) fail('recovery_invalid_request');
    return this.processing.transaction(() => {
      this.authorize(sessionId, subject);
      const requestHash = digest({ attemptId, jobId, supplementSha256 });
      const prior = this.db.prepare('SELECT * FROM derivative_recovery_operations WHERE subject=? AND request_key=?').get(subject, requestKey);
      if (prior) {
        if (prior.request_sha256 !== requestHash || prior.session_id !== sessionId) fail('recovery_idempotency_conflict');
        return prior;
      }
      const context = this.context(attemptId, jobId);
      if (this.db.prepare('SELECT 1 FROM derivative_recovery_operations WHERE attempt_id=?').get(attemptId)) fail('recovery_already_requested');
      const id = crypto.randomUUID(), at = new Date().toISOString();
      const failure = { attempt: context.attempt, task: context.task, output: context.output,
        version: context.version, derivative: context.job, storageJournal: context.journal };
      this.db.prepare(`INSERT INTO derivative_recovery_operations
        (id,attempt_id,job_id,version_id,subject,session_id,request_key,request_sha256,supplement_sha256,
         source_fingerprint,failure_json,status,deadline_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?)`).run(id, attemptId, jobId, context.version.id,
        subject, sessionId, requestKey, requestHash, supplementSha256, context.fingerprint,
        JSON.stringify(failure), new Date(Date.now() + MAX_DURATION_MS).toISOString(), at, at);
      this.processing.insertAudit({ actorId: subject, action: 'derivative_recovery.requested',
        entityType: 'derivative_recovery', entityId: id, details: { attemptId, jobId, versionId: context.version.id } });
      return this.get(id);
    });
  }

  get(id) { return this.db.prepare('SELECT * FROM derivative_recovery_operations WHERE id=?').get(id); }

  unchanged(row) {
    this.authorize(row.session_id, row.subject);
    const context = this.context(row.attempt_id, row.job_id);
    if (context.fingerprint !== row.source_fingerprint) fail('recovery_source_changed');
    return context;
  }

  claim(id, owner) {
    if (typeof owner !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(owner)) fail('recovery_invalid_owner');
    return this.processing.transaction(() => {
      const row = this.get(id), at = new Date().toISOString();
      if (!row || !['queued', 'leased'].includes(row.status) || !(Date.parse(row.deadline_at) > Date.now())
        || (row.status === 'leased' && Date.parse(row.lease_expires_at) > Date.now())) fail('recovery_not_claimable');
      this.unchanged(row);
      if (this.processing.measurementCalculationActive()) fail('recovery_heavy_work_busy');
      const until = new Date(Math.min(Date.now() + LEASE_MS, Date.parse(row.deadline_at))).toISOString();
      const token = crypto.randomBytes(24).toString('hex');
      if (this.db.prepare("UPDATE lod_conversion_lock SET job_id=?,lease_owner=?,lease_token=?,lease_expires_at=?,heartbeat_at=? WHERE id=1 AND (job_id IS NULL OR lease_expires_at<=?)")
        .run(row.job_id, owner, token, until, at, at).changes !== 1) fail('recovery_heavy_work_busy');
      if (this.db.prepare("SELECT 1 FROM derivative_jobs WHERE status='leased' AND lease_expires_at>? LIMIT 1").get(at)) fail('recovery_heavy_work_busy');
      this.db.prepare("UPDATE derivative_recovery_operations SET status='leased',lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=? WHERE id=?")
        .run(owner, token, until, at, id);
      return this.get(id);
    });
  }

  lease(id, owner, token) {
    const row = this.get(id), lock = this.db.prepare('SELECT * FROM lod_conversion_lock WHERE id=1').get();
    if (!row || row.status !== 'leased' || row.lease_owner !== owner || row.lease_token !== token
      || !(Date.parse(row.lease_expires_at) > Date.now()) || !(Date.parse(row.deadline_at) > Date.now())
      || lock?.job_id !== row.job_id || lock.lease_owner !== owner || lock.lease_token !== token
      || !(Date.parse(lock.lease_expires_at) > Date.now())) fail('recovery_lease_lost');
    return row;
  }

  heartbeat(id, owner, token) {
    return this.processing.transaction(() => {
      const row = this.lease(id, owner, token);
      this.unchanged(row);
      const at = new Date().toISOString(), until = new Date(Math.min(Date.now() + LEASE_MS, Date.parse(row.deadline_at))).toISOString();
      this.db.prepare('UPDATE derivative_recovery_operations SET lease_expires_at=?,updated_at=? WHERE id=?').run(until, at, id);
      this.db.prepare('UPDATE lod_conversion_lock SET lease_expires_at=?,heartbeat_at=? WHERE id=1').run(until, at);
      return this.get(id);
    });
  }

  async prepare(id, owner, token, supplement) {
    if (typeof this.qualifySupplement !== 'function') fail('recovery_verifier_unavailable');
    const row = this.lease(id, owner, token), context = this.unchanged(row);
    // Adapter must rehash pinned physical source/output and independently audit
    // the supplement, with cancellation/cleanup. This hook is not yet supplied.
    const qualified = await this.qualifySupplement({ operation: row, context, supplement });
    this.lease(id, owner, token);
    this.unchanged(row);
    if (!qualified || qualified.supplementSha256 !== row.supplement_sha256
      || typeof qualified.register !== 'function') fail('recovery_supplement_unverified');
    const ticket = Object.freeze({});
    this.tickets.set(ticket, { id, owner, token, qualified });
    return ticket;
  }

  commit(ticket) {
    const value = this.tickets.get(ticket);
    if (!value) fail('recovery_supplement_unverified');
    const { id, owner, token, qualified } = value;
    const result = this.processing.transaction(() => {
      const row = this.lease(id, owner, token), context = this.unchanged(row), at = new Date().toISOString();
      const { attempt, task, output, version, model, job } = context;
      // Restoration is never visible by itself: registration and existing
      // all-required finalization must succeed in this SAME transaction.
      this.db.prepare("UPDATE model_outputs SET status='staged',updated_at=? WHERE id=?").run(at, output.id);
      this.db.prepare("UPDATE model_versions SET status='importing',updated_at=? WHERE id=?").run(at, version.id);
      this.db.prepare("UPDATE models SET status='importing',updated_at=? WHERE id=? AND active_version_id IS NULL").run(at, model.id);
      this.db.prepare("UPDATE processing_attempts SET status='derivatives',error_code=NULL,error_message=NULL,completed_at=NULL,updated_at=? WHERE id=?").run(at, attempt.id);
      this.db.prepare("UPDATE processing_tasks SET status='processing',updated_at=? WHERE id=?").run(at, task.id);
      this.db.prepare(`UPDATE derivative_jobs SET status='leased',lease_owner=?,lease_token=?,lease_expires_at=?,
        heartbeat_at=?,deadline_at=?,updated_at=? WHERE id=?`).run(owner, token, row.lease_expires_at, at, row.deadline_at, at, job.id);
      this.db.prepare(`UPDATE derivative_storage_journal SET lease_token=?,state='reserved',
        incomplete_relative_path=NULL,complete_relative_path=NULL,final_relative_path=NULL,
        actual_byte_size=NULL,accounted_byte_size=reserved_byte_size,manifest_sha256=NULL,updated_at=?
        WHERE job_id=? AND state='terminal'`).run(token, at, job.id);
      const verified = qualified.register({ processing: this.processing, context, leaseToken: token });
      if (!verified || verified.verified !== true || typeof verified.then === 'function') fail('recovery_supplement_unverified');
      this.lease(id, owner, token);
      this.authorize(row.session_id, row.subject);
      const completed = this.processing.completeDerivativeAndMaybeReadyInTransaction(job.id, owner, verified,
        { leaseToken: token, event: { eventId: `derivative-recovery-ready-${id}`, schemaVersion: 1,
          type: 'processing.ready_for_review', projectId: task.project_id, taskId: task.id,
          attemptId: attempt.id, requestedBySubject: attempt.created_by } });
      if (!completed?.ready) fail('recovery_readiness_conflict');
      this.db.prepare("UPDATE derivative_recovery_operations SET status='complete',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(at, id);
      this.processing.insertAudit({ actorId: row.subject, action: 'derivative_recovery.completed',
        entityType: 'derivative_recovery', entityId: id, details: { attemptId: attempt.id, versionId: version.id, supplementSha256: row.supplement_sha256 } });
      return completed;
    });
    this.tickets.delete(ticket);
    return result;
  }

  abandon(id, owner, token, code = 'recovery_failed') {
    if (!/^[a-z0-9_]{1,80}$/.test(code)) fail('recovery_invalid_error');
    return this.processing.transaction(() => {
      const row = this.lease(id, owner, token), at = new Date().toISOString();
      this.db.prepare("UPDATE derivative_recovery_operations SET status='failed',error_code=?,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(code, at, id);
      this.db.prepare('UPDATE lod_conversion_lock SET job_id=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=1').run();
      this.processing.insertAudit({ actorType: 'system', action: 'derivative_recovery.failed',
        entityType: 'derivative_recovery', entityId: id, details: { attemptId: row.attempt_id, code } });
      return this.get(id);
    });
  }

  expire(id) {
    return this.processing.transaction(() => {
      const row = this.get(id);
      if (!row || !['queued', 'leased'].includes(row.status) || Date.parse(row.deadline_at) > Date.now()) return false;
      const at = new Date().toISOString();
      this.db.prepare("UPDATE derivative_recovery_operations SET status='failed',error_code='recovery_expired',lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(at, id);
      this.db.prepare('UPDATE lod_conversion_lock SET job_id=NULL,lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,heartbeat_at=NULL WHERE id=1 AND job_id=? AND lease_token=?')
        .run(row.job_id, row.lease_token);
      this.processing.insertAudit({ actorType: 'system', action: 'derivative_recovery.expired',
        entityType: 'derivative_recovery', entityId: id, details: { attemptId: row.attempt_id } });
      return true;
    });
  }
}

module.exports = { DerivativeRecovery };
