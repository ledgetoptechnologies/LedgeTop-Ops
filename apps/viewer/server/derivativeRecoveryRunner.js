'use strict';

const fail = code => Object.assign(new Error(code), { code });
const deferred = new Set(['recovery_not_claimable', 'recovery_heavy_work_busy']);
function safeCode(error) {
  return /^(?:recovery|supplement|lod)_[a-z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'recovery_failed';
}

// One explicitly selected operation; no polling loop, startup work or route is
// installed by importing this module. The caller owns the service/database and
// supplies a trusted, signal-aware loader for the immutable local supplement.
async function runDerivativeRecovery({ service, operationId, owner, loadSupplement, environment, leaseToken = null, signal = null, heartbeatMs = 10_000 } = {}) {
  if (environment !== 'STAGING') throw fail('recovery_runner_staging_only');
  if (!service || typeof loadSupplement !== 'function' || !Number.isSafeInteger(heartbeatMs)
    || heartbeatMs < 250 || heartbeatMs > 20_000
    || (leaseToken !== null && !/^[a-f0-9]{48}$/.test(leaseToken))) throw fail('recovery_runner_invalid');
  signal?.throwIfAborted();
  let row = service.get(operationId);
  if (!row) return { id: operationId, status: 'missing' };
  if (row.status === 'complete' || row.status === 'failed') return { id: row.id, status: row.status };
  if (!(Date.parse(row.deadline_at) > Date.now())) {
    service.expire(row.id);
    return { id: row.id, status: service.get(row.id).status, errorCode: 'recovery_expired' };
  }
  // A controlled intake phase may already hold this exact private lease while
  // populating its slot. Resume only with its token and fresh auth/source checks.
  try { row = leaseToken === null ? service.claim(row.id, owner) : service.heartbeat(row.id, owner, leaseToken); }
  catch (error) {
    if (deferred.has(error.code)) return { id: row.id, status: 'deferred', errorCode: error.code };
    throw error;
  }
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const stop = error => { if (!controller.signal.aborted) controller.abort(error); };
  const heartbeat = setInterval(() => {
    try { service.heartbeat(row.id, owner, row.lease_token); }
    catch (error) { stop(error); }
  }, heartbeatMs);
  const deadline = setTimeout(() => stop(fail('recovery_deadline_exceeded')), Math.max(1, Date.parse(row.deadline_at) - Date.now()));
  let ticket = null;
  try {
    combined.throwIfAborted();
    const supplement = await loadSupplement({ operation: row, signal: combined });
    combined.throwIfAborted();
    // Revalidate after loading and immediately before any proof work.
    service.heartbeat(row.id, owner, row.lease_token);
    ticket = await service.prepare(row.id, owner, row.lease_token, supplement, { signal: combined });
    combined.throwIfAborted();
    const result = service.commit(ticket);
    ticket = null; // Commit consumes/disposes the ticket, even on SQL rejection.
    return { id: row.id, status: 'complete', ready: result.ready, cleanupComplete: result.cleanupComplete };
  } catch (error) {
    // prepare must finish its signal-aware child work before this point; never
    // release shared ownership while a verifier/reader is still running.
    if (ticket) { service.discard(ticket); ticket = null; }
    const code = signal?.aborted ? 'recovery_cancelled' : combined.aborted ? safeCode(combined.reason) : safeCode(error);
    try {
      if (Date.parse(row.deadline_at) <= Date.now()) service.expire(row.id);
      else service.abandon(row.id, owner, row.lease_token, code);
    } catch (recordError) {
      // An expired/reclaimed lease belongs to another worker. Never overwrite
      // its state, release its lock, or present a failed SQL write as durable.
      if (recordError.code === 'recovery_lease_lost') return { id: row.id, status: 'lost', errorCode: 'recovery_lease_lost' };
      return { id: row.id, status: 'held', errorCode: 'recovery_failure_not_recorded' };
    }
    return { id: row.id, status: service.get(row.id).status, errorCode: code };
  } finally {
    clearInterval(heartbeat); clearTimeout(deadline);
    if (ticket) service.discard(ticket);
  }
}

module.exports = { runDerivativeRecovery };
