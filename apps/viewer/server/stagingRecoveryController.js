'use strict';

const crypto = require('node:crypto');
const { stable } = require('../lod-converter-policy.cjs');
const { DerivativeRecovery } = require('./derivativeRecovery');
const { expectedIdentity, canonicalSupplement } = require('./derivativeSupplement');
const { stageDerivativeSupplement, createStagedSupplementLoader } = require('./derivativeSupplementIntake');
const { createStagingImmutableSupplementQualifier } = require('./derivativeSupplementRegistration');
const { createReadOnlyRecoveryFence } = require('./derivativeRecoveryFence');
const { runDerivativeRecovery } = require('./derivativeRecoveryRunner');
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Server-owned, one-operation host entrypoint API. No caller-supplied filesystem
// paths, functions, lease tokens or deploy flags are accepted by its methods.
// The host must install a compatible image and qualify every dependency first.
function createStagingRecoveryController({ environment, processing, storage, operator, target,
  resolveBinding, resolveProducerBinding, confirmProducerIncarnation, acceptConverter,
  verifyCandidate, assertWriteAdmission, assertExclusiveMaintenance, readFile } = {}) {
  if (environment !== 'STAGING') fail('recovery_runner_staging_only');
  if (!processing || !storage?.roots?.models || typeof operator?.sessionId !== 'string' || !operator.sessionId
    || typeof operator.subject !== 'string' || !operator.subject
    || typeof target?.attemptId !== 'string' || !target.attemptId || typeof target.jobId !== 'string' || !target.jobId
    || ![resolveBinding, resolveProducerBinding, confirmProducerIncarnation, acceptConverter, verifyCandidate,
      assertWriteAdmission, assertExclusiveMaintenance, readFile].every(value => typeof value === 'function')) fail('recovery_controller_unavailable');
  const actor = Object.freeze({ sessionId: operator.sessionId, subject: operator.subject });
  const scope = Object.freeze({ attemptId: target.attemptId, jobId: target.jobId });
  const owner = `staging-recovery-${crypto.randomUUID()}`, busy = new Set();
  let selectedId = null, cachedManifest = null;
  const acquireFence = createReadOnlyRecoveryFence({ modelsRoot: storage.roots.models, assertExclusiveMaintenance });
  const qualifier = createStagingImmutableSupplementQualifier({ processing, modelsRoot: storage.roots.models, acquireFence,
    resolveBinding, resolveProducerBinding, confirmProducerIncarnation, acceptConverter, verifyCandidate });
  const service = new DerivativeRecovery(processing, { qualifySupplement: qualifier });
  const loadSupplement = createStagedSupplementLoader({ service, storage, environment });
  const owned = id => {
    service.authorize(actor.sessionId, actor.subject);
    if (typeof id !== 'string' || !id) fail('recovery_forbidden');
    const row = service.get(id);
    if (!row || row.subject !== actor.subject || row.session_id !== actor.sessionId || row.attempt_id !== scope.attemptId || row.job_id !== scope.jobId) fail('recovery_forbidden');
    return row;
  };
  const status = row => ({ id: row.id, status: row.status, deadlineAt: row.deadline_at,
    ...(row.error_code ? { errorCode: row.error_code } : {}) });
  const exclusive = async (id, action) => {
    if (busy.has(id)) fail('recovery_controller_busy');
    busy.add(id);
    try { return await action(); } finally { busy.delete(id); }
  };
  return Object.freeze({
    async request({ requestKey, manifest, signal = null } = {}) {
      signal?.throwIfAborted(); service.authorize(actor.sessionId, actor.subject);
      const parsed = canonicalSupplement(manifest), context = service.context(scope.attemptId, scope.jobId);
      if (assertWriteAdmission({ operation: null, context, byteSize: parsed.byteSize }) !== true) fail('supplement_intake_admission_lost');
      if (parsed.manifest.identity.environment !== 'STAGING') fail('supplement_staging_only');
      // Dependencies explicitly support a read-only preflight with operation:null.
      const binding = await resolveBinding({ operation: null, context, signal });
      if (binding?.environment !== 'STAGING') fail('supplement_staging_only');
      const producer = await resolveProducerBinding({ operation: null, context, binding, signal });
      if (await confirmProducerIncarnation({ operation: null, context, binding, producer, signal }) !== true) fail('supplement_producer_incarnation_unbound');
      const expected = expectedIdentity(processing, context, binding, producer);
      if (stable(expected) !== stable(parsed.manifest.identity) || stable(binding.coordinateFrame) !== stable(parsed.manifest.coordinateFrame)) fail('supplement_identity_mismatch');
      if (await acceptConverter(parsed.manifest.converter) !== true) fail('supplement_converter_unqualified');
      signal?.throwIfAborted();
      service.authorize(actor.sessionId, actor.subject);
      if (assertWriteAdmission({ operation: null, context, byteSize: parsed.byteSize }) !== true) fail('supplement_intake_admission_lost');
      if (service.context(scope.attemptId, scope.jobId).fingerprint !== context.fingerprint) fail('recovery_source_changed');
      const row = service.request({ ...scope, requestKey, ...actor, supplementSha256: parsed.supplementSha256 });
      if (row.source_fingerprint !== context.fingerprint) fail('recovery_source_changed');
      selectedId = row.id; cachedManifest = parsed.manifest;
      return status(row);
    },
    stage(id, { signal = null } = {}) {
      return exclusive(id, async () => {
        let row = owned(id);
        if (['complete', 'failed'].includes(row.status)) return status(row);
        if (selectedId !== row.id || !cachedManifest) fail('recovery_intake_manifest_unavailable');
        if (row.status === 'queued') row = service.claim(row.id, owner);
        const result = await stageDerivativeSupplement({ service, storage, operationId: row.id, owner: row.lease_owner,
          leaseToken: row.lease_token, manifest: cachedManifest, readFile, assertWriteAdmission, environment, signal });
        cachedManifest = null; return result;
      });
    },
    run(id, { signal = null } = {}) {
      return exclusive(id, async () => {
        const row = owned(id);
        if (['complete', 'failed'].includes(row.status)) return status(row);
        service.heartbeat(row.id, row.lease_owner, row.lease_token);
        // A not-yet-RO handoff is refused before the runner can abandon work.
        // The qualifier reacquires and holds the real fence throughout proof.
        const fence = await acquireFence({ operation: row, signal, assertCurrent: () => {
          service.lease(row.id, row.lease_owner, row.lease_token); service.unchanged(row);
        } });
        fence.release();
        return runDerivativeRecovery({ service, operationId: row.id, owner: row.lease_owner,
          leaseToken: row.lease_token, loadSupplement, environment, signal });
      });
    },
    renew(id) {
      const row = owned(id);
      return status(service.heartbeat(row.id, row.lease_owner, row.lease_token));
    },
    status(id) { return status(owned(id)); },
  });
}

module.exports = { createStagingRecoveryController };
