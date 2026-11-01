'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { sanitizeLogMessage } = require('./processingSecurity');
const { hashTree } = require('./storageManager');
const { verifyLodProvenance } = require('./lodProvenance');
const { verifyRecoveryCompanionPlan } = require('./lodRecoveryCompanions');
const {
  discoverMeshDerivativeInput,
  discoverPointDerivativeInput,
  verifyDerivativeInputSnapshot,
  registeredPointDerivativeInput,
} = require('./derivativeInputSnapshot');
const {
  CONTROLLED_CONVERTER_COMMAND_SHA256,
  CONTROLLED_SURFACE_AUDIT_POLICY_V4,
  SERIAL_RETRY_CONVERTER_COMMAND_SHA256,
  obj2TilesArguments,
} = require('../lod-converter-policy.cjs');

const RESOURCE_PRESSURE_PATTERN = /(?:taskschedulerexception|an exception was thrown by a taskscheduler|outofmemoryexception|insufficientmemoryexception|cannot allocate memory|resource temporarily unavailable|failed to (?:create|start).{0,24}thread|pthread_create)/i;
const DIAGNOSTIC_PREFIX = 'OBJ2TILES_DIAGNOSTIC ';

function readResourceMetric(file) {
  try {
    const value = fs.readFileSync(file, 'utf8').trim();
    return /^(?:max|\d{1,32})$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

function derivativeResourceSnapshot() {
  const memory = process.memoryUsage();
  const usage = process.resourceUsage?.() || {};
  return {
    schemaVersion: 1,
    pid: process.pid,
    cpuCount: require('node:os').availableParallelism?.() || require('node:os').cpus().length,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    externalBytes: memory.external,
    maxRssKilobytes: Number(usage.maxRSS) || null,
    cgroupPidsCurrent: readResourceMetric('/sys/fs/cgroup/pids.current'),
    cgroupPidsMax: readResourceMetric('/sys/fs/cgroup/pids.max'),
    cgroupMemoryCurrent: readResourceMetric('/sys/fs/cgroup/memory.current'),
    cgroupMemoryMax: readResourceMetric('/sys/fs/cgroup/memory.max'),
  };
}

function safeDiagnosticValue(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return value ?? null;
  if (typeof value === 'string') return sanitizeLogMessage(value).slice(0, 512);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 16).map((item) => safeDiagnosticValue(item, depth + 1));
  if (typeof value !== 'object') return null;
  const result = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    if (/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(key)) result[key] = safeDiagnosticValue(item, depth + 1);
  }
  return result;
}

function obj2TilesDiagnostics(stderr) {
  const diagnostics = [];
  for (const line of String(stderr || '').split(/\r?\n/)) {
    if (!line.startsWith(DIAGNOSTIC_PREFIX)) continue;
    try {
      const parsed = JSON.parse(line.slice(DIAGNOSTIC_PREFIX.length));
      if (parsed?.schemaVersion === 1) diagnostics.push(safeDiagnosticValue(parsed));
    } catch {}
  }
  return diagnostics.slice(-8);
}

function structuredCommandFailure(stderr) {
  try {
    const value = JSON.parse(String(stderr || '').trim());
    if (value?.valid !== false || typeof value.error !== 'string') return null;
    return { code: typeof value.code === 'string' ? value.code : null, error: sanitizeLogMessage(value.error).slice(0, 1000), details: safeDiagnosticValue(value.details) };
  } catch {
    return null;
  }
}

function isExplicitResourcePressure(error) {
  if (error?.resourcePressure === true) return true;
  return RESOURCE_PRESSURE_PATTERN.test(String(error?.message || ''));
}

function logObj2TilesDiagnostics(result, outcome) {
  const diagnostics = result?.converterDiagnostics || [];
  if (!diagnostics.length && !result?.resourcePressure) return;
  console.warn(`[derivative-resource] ${JSON.stringify({
    schemaVersion: 1,
    component: 'obj2tiles',
    outcome,
    resourcePressure: Boolean(result?.resourcePressure),
    converterDiagnostics: diagnostics,
    workerResources: result?.resourceDiagnostics || derivativeResourceSnapshot(),
  })}`);
}

function remainingCommandMs(deadlineAt) {
  const remaining = Number(deadlineAt) - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw Object.assign(new Error('derivative wall-clock deadline expired'), { code: 'derivative_timeout' });
  }
  return remaining;
}

async function runObj2TilesWithResourceRetry({ bin, source, output, deadlineAt, signal, clearIncomplete, runCommand = run }) {
  let serialRetry = false;
  try {
    const result = await runCommand(bin, obj2TilesArguments(source, output), {
      timeoutMs: remainingCommandMs(deadlineAt),
      signal,
    });
    return { result, serialRetry };
  } catch (error) {
    if (!isExplicitResourcePressure(error) || signal?.aborted) throw error;
    const resourcePressureEvidence = {
      resourcePressure: true,
      ...(Number.isSafeInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
      converterDiagnostics: error.converterDiagnostics || [],
      workerResources: error.resourceDiagnostics || derivativeResourceSnapshot(),
    };
    logObj2TilesDiagnostics(error, 'retrying-serial');
    try {
      clearIncomplete();
      if (signal?.aborted) throw signal.reason;
      serialRetry = true;
      const result = await runCommand(bin, obj2TilesArguments(source, output, { serialRetry: true }), {
        timeoutMs: remainingCommandMs(deadlineAt),
        signal,
      });
      return { result, serialRetry };
    } catch (retryError) {
      if (retryError && typeof retryError === 'object') {
        retryError.resourcePressureEvidence = resourcePressureEvidence;
        retryError.serialRetryAttempted = true;
      }
      throw retryError;
    }
  }
}

function stopProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function run(bin, args, { timeoutMs = 24 * 3600_000, signal, killGraceMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true, detached: process.platform !== 'win32' });
    let stderr = '';
    let settled = false;
    let terminationError = null;
    let timer = null;
    let hardKillTimer = null;
    const finish = (error, result = undefined) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const terminate = (error) => {
      if (settled || terminationError) return;
      terminationError = error;
      stopProcessTree(child, 'SIGTERM');
      hardKillTimer = setTimeout(
        () => stopProcessTree(child, 'SIGKILL'),
        Math.max(0, Math.min(Number(killGraceMs) || 0, 60_000)),
      );
    };
    const abort = () => {
      const reason = signal?.reason;
      terminate(reason instanceof Error ? reason : Object.assign(new Error('derivative operation cancelled'), { code: 'lease_lost' }));
    };
    timer = setTimeout(() => {
      terminate(Object.assign(new Error('derivative command timed out'), { code: 'derivative_timeout' }));
    }, Math.max(1, Number(timeoutMs) || 1));
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-64000); });
    child.once('error', (error) => finish(error));
    child.once('exit', (code) => {
      if (terminationError) return finish(terminationError);
      const safeStderr = sanitizeLogMessage(stderr);
      const converterDiagnostics = obj2TilesDiagnostics(stderr);
      const resourceDiagnostics = derivativeResourceSnapshot();
      const resourcePressure = converterDiagnostics.some((item) => item.resourcePressure === true)
        || RESOURCE_PRESSURE_PATTERN.test(safeStderr);
      if (code === 0) return finish(null, { converterDiagnostics, resourceDiagnostics, resourcePressure });
      const structuredFailure = structuredCommandFailure(stderr);
      return finish(Object.assign(
        new Error(structuredFailure?.error || `derivative command failed (${code}): ${safeStderr.slice(-1000)}`),
        { code: code === 3 && structuredFailure?.code === 'lod_surface_equivalence_failed' ? 'lod_surface_equivalence_failed' : 'derivative_failed', exitCode: code, auditEvidence: structuredFailure?.details || null, converterDiagnostics, resourceDiagnostics, resourcePressure },
      ));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
  });
}

function derivativePhase(processing, job, owner, phase) {
  if (!processing.updateDerivativeProgress(job.id, owner, phase, job.lease_token)) {
    throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
  }
  const type = ['lod_audit', 'mesh_tiles', 'ept'].includes(job.derivative_type)
    ? job.derivative_type
    : 'unsupported';
  console.info(`[derivative] type=${type} phase=${phase}`);
}

function readyEvent(processing, config, attempt) {
  const task = processing.getTask(attempt.taskId);
  const project = processing.getProject(task.projectId);
  return {
    eventId: `processing-ready-${attempt.id}`,
    schemaVersion: 1,
    type: 'processing.ready_for_review',
    projectId: project.id,
    projectDisplayName: project.displayName,
    taskId: task.id,
    taskDisplayName: task.displayName,
    attemptId: attempt.id,
    requestedBySubject: attempt.createdBy,
    status: 'ready_for_review',
    reviewUrl: `${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`,
  };
}

function emitReady(processing, config, attempt, job, owner, result) {
  const completed = processing.completeDerivativeAndMaybeReady(job.id, owner, result, { event: readyEvent(processing, config, attempt), leaseToken: job.lease_token });
  if (!completed) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
  return completed;
}

function assertLodArtifactsMatchSnapshot(artifacts, integrity) {
  const snapshot = new Map(integrity.files.map((file) => [file.relativePath, file]));
  for (const artifact of artifacts) {
    const file = snapshot.get(artifact.uri);
    if (!file || file.byteSize !== artifact.byteLength || file.sha256 !== artifact.sha256) {
      throw Object.assign(new Error(`LOD artifact changed before registration (${artifact.uri})`), { code: 'lod_provenance_invalid' });
    }
  }
  const tileset = snapshot.get('tileset.json');
  if (!tileset) throw Object.assign(new Error('verified LOD tree has no tileset.json'), { code: 'lod_provenance_invalid' });
  return tileset;
}

async function verifiedLodAsset(input, directory, fullMeshPath) {
  const checked = await verifyLodProvenance(path.join(directory, 'lod-provenance.json'), fullMeshPath);
  if (!checked.verified) throw Object.assign(new Error(`LOD provenance verification failed: ${checked.errors.join('; ')}`), { code: 'lod_provenance_invalid' });
  const integrity = await hashTree(directory);
  const tileset = assertLodArtifactsMatchSnapshot(checked.artifacts, integrity);
  return {
    asset: {
      ...input,
      sha256: tileset.sha256,
      byteSize: tileset.byteSize,
      manifestSha256: integrity.manifestSha256,
      manifestFiles: integrity.files,
    },
    provenance: checked.provenance,
  };
}

function successfulLodAuditEvidence(provenance) {
  const audit = provenance?.audit;
  if (provenance?.schemaVersion !== 4
    || audit?.algorithm !== 'ltds-obj2tiles-surface-equivalence-v4'
    || audit.policyRevision !== CONTROLLED_SURFACE_AUDIT_POLICY_V4.revision
    || !['normal', 'gray-zone'].includes(audit.acceptance)
    || !Number.isFinite(audit.areaRelativeDelta)
    || !Number.isFinite(audit.numericalAgreement?.maximumRelativeDelta)
    || !/^[a-f0-9]{64}$/i.test(String(audit.equivalenceSha256 || ''))) return null;
  return {
    policyRevision: audit.policyRevision,
    acceptance: audit.acceptance,
    metric: 'areaRelativeDelta',
    observed: audit.areaRelativeDelta,
    limit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.normalAreaRelativeDeltaLimit,
    grayZoneLimit: CONTROLLED_SURFACE_AUDIT_POLICY_V4.grayAreaRelativeDeltaLimit,
    numericalAgreement: audit.numericalAgreement?.maximumRelativeDelta,
    equivalenceSha256: audit.equivalenceSha256,
  };
}

function manifestTreeBytes(files) {
  return (files || []).reduce((sum, file) => sum + Math.max(0, Number(file.byteSize) || 0), 0);
}

function previousManagedTilesDirectory(storage, base, asset) {
  if (!asset || asset.root_key !== 'models' || !asset.relative_path) return null;
  try {
    const manifest = storage.resolve('models', asset.relative_path, { mustExist: true });
    const directory = path.dirname(manifest);
    const relative = path.relative(base, directory);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return directory;
  } catch {
    return null;
  }
}

async function generateMeshTiles({ processing, storage, config, attempt, job, owner, task, obj, glb, inputSnapshot, previousTiles = null, audit, signal, onPhase = () => {} }) {
  if (!config.meshDerivativesEnabled) throw Object.assign(new Error('mesh derivative fallback is disabled'), { code: 'derivative_unavailable' });
  if (!obj || !glb) throw Object.assign(new Error('verified Obj2Tiles generation requires both OBJ and GLB mesh sources'), { code: 'unsupported_mesh_derivative_source' });
  const workId = String(job.id || ''), leaseToken = String(job.lease_token || '');
  if (!/^[a-f0-9-]{16,64}$/i.test(workId) || !/^[a-f0-9]{32}$/.test(leaseToken)) throw Object.assign(new Error('derivative job identity is invalid'), { code: 'invalid_storage_location' });
  const relativeBase = `${task.id}/${attempt.id}`;
  const baseCandidate = storage.resolve('models', relativeBase);
  fs.mkdirSync(baseCandidate, { recursive: true });
  const base = storage.resolve('models', relativeBase, { mustExist: true });
  if (base !== baseCandidate || fs.statSync(base).dev !== fs.statSync(storage.roots.models).dev) {
    throw Object.assign(new Error('derivative activation must use an unaliased path on one filesystem'), { code: 'invalid_storage_location' });
  }
  const outputName = `tiles-ktx2-etc1s-${job.id}`;
  const outputRelative = `${task.id}/${attempt.id}/${outputName}`;
  const output = path.join(base, outputName);
  const incomplete = `${output}.${leaseToken}.incomplete`;
  const complete = `${output}.${leaseToken}.complete`;
  const previousBytes = previousTiles?.id
    ? Number(processing.database.prepare('SELECT COALESCE(SUM(byte_size),0) AS n FROM model_asset_files WHERE asset_id=?').get(previousTiles.id)?.n || 0)
    : 0;
  const source = storage.resolve(obj.root_key, obj.relative_path, { mustExist: true });
  const auditSource = storage.resolve(glb.root_key, glb.relative_path, { mustExist: true });
  const reservation=processing.derivativeStorageReservation(job.id);
  const admission = storage.requireDerivativeSpace('models', { sourceBytes: inputSnapshot.totalByteSize, expectedFiles: 10_000, reservedBytes: reservation?.accountedByteSize || 0, otherReservedBytes: processing.activeDerivativeReservationBytes(job.id), reservedDatasetBytes: processing.activeProcessingReservationBytes(attempt.id) });
  const assetInput = (directory) => ({
    versionId: attempt.resultModelVersionId,
    rootKey: 'models',
    relativePath: `${outputRelative}/tileset.json`,
    format: '3dtiles',
    contentType: 'application/json',
    byteSize: fs.statSync(path.join(directory, 'tileset.json')).size,
    attemptId: attempt.id,
  });
  const register = (verified, promote = null) => processing.registerVerifiedLodAsset(
    job.id, owner, verified.asset, verified.provenance, { leaseToken, promote },
  );

  if (fs.existsSync(output)) {
    onPhase('verifying');
    let existing;
    try { existing = await verifiedLodAsset(assetInput(output), output, auditSource); }
    catch (error) {
      const previousDirectory = previousManagedTilesDirectory(storage, base, previousTiles);
      if (previousDirectory === output) throw Object.assign(new Error('a referenced derivative final failed re-verification'), { code: 'lod_referenced_asset_invalid', cause: error });
      const quarantine = `${output}.${Date.now()}.quarantine`;
      fs.renameSync(output, quarantine);
      throw Object.assign(new Error('an unreferenced derivative final failed re-verification'), { code: 'lod_provenance_invalid', cause: error });
    }
    if (![CONTROLLED_CONVERTER_COMMAND_SHA256, SERIAL_RETRY_CONVERTER_COMMAND_SHA256]
      .includes(existing.provenance?.converter?.commandSha256)) {
      throw Object.assign(new Error('existing derivative does not use the current KTX2 policy'), { code: 'lod_provenance_invalid' });
    }
    onPhase('registering');
    if (!register(existing)) throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
    const auditEvidence = successfulLodAuditEvidence(existing.provenance);
    return {
      retainedBytes: manifestTreeBytes(existing.asset.manifestFiles),
      fileCount: existing.asset.manifestFiles.length,
      priorTreeBytes: previousBytes,
      replacedBytes: 0,
      resumed: true,
      ...(auditEvidence ? { auditEvidence } : {}),
    };
  }

  fs.rmSync(incomplete, { recursive: true, force: true });
  fs.rmSync(complete, { recursive: true, force: true });
  const pressure = new AbortController();
  const combinedSignal = AbortSignal.any([signal, pressure.signal]);
  const guard = () => {
    try {
      const current = storage.space('models', 0);
      if (current.available <= current.reserve + 5 * 1024 ** 3
        || !Number.isFinite(current.ffree) || current.ffree <= admission.inodeReserve) {
        pressure.abort(Object.assign(new Error('derivative storage headroom fell below the safety reserve'), { code: 'insufficient_storage' }));
      }
    } catch (error) {
      pressure.abort(Object.assign(new Error('derivative storage headroom could not be verified'), { code: 'insufficient_storage', cause: error }));
    }
  };
  guard();
  if (pressure.signal.aborted) throw pressure.signal.reason;
  const guardTimer = setInterval(guard, 1000);
  const remainingMs = Date.parse(job.deadline_at || '') - Date.now();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    clearInterval(guardTimer);
    throw Object.assign(new Error('derivative wall-clock deadline expired'), { code: 'derivative_timeout' });
  }

  try {
    onPhase('generating');
    let conversion;
    let converterSerialRetry = false;
    try {
      ({ result: conversion, serialRetry: converterSerialRetry } = await runObj2TilesWithResourceRetry({
        bin: config.obj2TilesBin,
        source,
        output: incomplete,
        deadlineAt: Date.parse(job.deadline_at || ''),
        signal: combinedSignal,
        clearIncomplete: () => fs.rmSync(incomplete, { recursive: true, force: true }),
      }));
      logObj2TilesDiagnostics(conversion, 'complete');
    } catch (error) {
      if (isExplicitResourcePressure(error)) logObj2TilesDiagnostics(error, 'failed');
      throw error;
    }
    if (pressure.signal.aborted) throw pressure.signal.reason;
    onPhase('auditing');
    await run(process.execPath, [
      audit,
      incomplete,
      auditSource,
      '--external-source',
      '--controlled-obj2tiles',
      source,
      config.obj2TilesBin,
      ...(converterSerialRetry ? ['--converter-serial-retry'] : []),
    ], { timeoutMs: Math.max(1, Date.parse(job.deadline_at) - Date.now()), signal: combinedSignal });
    if (pressure.signal.aborted) throw pressure.signal.reason;
    onPhase('verifying');
    const verified = await verifiedLodAsset(assetInput(incomplete), incomplete, auditSource);
    if (verified.asset.manifestFiles.length > 100_000) throw Object.assign(new Error('derivative contains too many files'), { code: 'invalid_asset_tree' });
    fs.renameSync(incomplete, complete);
    onPhase('registering');
    const registered = register(verified, () => {
      if (fs.existsSync(output)) throw Object.assign(new Error('derivative final appeared during activation'), { code: 'derivative_activation_conflict' });
      if (fs.statSync(complete).dev !== fs.statSync(base).dev) throw Object.assign(new Error('derivative activation crossed filesystems'), { code: 'invalid_storage_location' });
      fs.renameSync(complete, output);
    });
    if (!registered) throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
    const auditEvidence = successfulLodAuditEvidence(verified.provenance);
    return {
      retainedBytes: manifestTreeBytes(verified.asset.manifestFiles),
      fileCount: verified.asset.manifestFiles.length,
      priorTreeBytes: previousBytes,
      replacedBytes: 0,
      resumed: false,
      ...(auditEvidence ? { auditEvidence } : {}),
    };
  } catch (error) {
    fs.rmSync(incomplete, { recursive: true, force: true });
    fs.rmSync(complete, { recursive: true, force: true });
    throw error;
  } finally {
    clearInterval(guardTimer);
  }
}

async function processOneDerivative({ processing, storage, config, lodAuditScript = null, generateMeshTilesImpl = generateMeshTiles }, owner) {
  const job = processing.claimDerivative(owner);
  if (!job) return false;
  const startedAt = Date.now();
  const attempt = processing.getAttempt(job.attempt_id);
  const controller = new AbortController();
  let lost = false;
  let request = {};
  const heartbeat = setInterval(() => {
    if (!processing.heartbeatDerivative(job.id, owner, job.lease_token)) {
      lost = true;
      controller.abort(Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' }));
    }
  }, 20000);
  heartbeat.unref?.();
  try {
    derivativePhase(processing, job, owner, 'claimed');
    if (['cancelled', 'failed'].includes(attempt.status)) throw Object.assign(new Error('attempt is no longer active'), { code: 'lease_lost' });
    request = JSON.parse(job.request_json || '{}');
    if (request.optional && ['lod_audit', 'mesh_tiles'].includes(job.derivative_type)
      && ['ready_for_review', 'published'].includes(attempt.status)) {
      throw Object.assign(new Error('ready and published model versions are immutable; create a new processing attempt'), { code: 'derivative_in_place_disabled' });
    }
    const assets = processing.database.prepare('SELECT * FROM model_assets WHERE version_id=?').all(attempt.resultModelVersionId);
    const task = processing.getTask(attempt.taskId);
    const obj = assets.find((asset) => asset.kind === 'obj');
    const glb = assets.find((asset) => asset.kind === 'glb');
    let point = assets.find((asset) => asset.kind === 'pointCloud');
    const previousTiles = assets.find((asset) => asset.kind === 'tiles') || null;
    const audit = lodAuditScript || path.join(__dirname, '..', 'scripts', 'audit-lod-equivalence.mjs');
    let inputSnapshot = processing.derivativeInputSnapshot(job.id);
    if (!inputSnapshot) {
      const discovered = job.derivative_type === 'ept'
        ? await discoverPointDerivativeInput(storage, point, { signal: controller.signal })
        : await discoverMeshDerivativeInput(storage, obj, glb, { signal: controller.signal });
      inputSnapshot = processing.persistDerivativeInputSnapshot(job.id, job.derivative_type, discovered.files);
    }
    if (job.derivative_type === 'ept') point = registeredPointDerivativeInput(inputSnapshot, assets);
    await verifyDerivativeInputSnapshot(storage, inputSnapshot, { signal: controller.signal });
    let derivativeResult;

    if (job.derivative_type === 'lod_audit') {
      if (!glb) {
        derivativeResult = { verified: false, fallback: obj ? 'obj' : null, reason: 'LOD equivalence requires a GLB source' };
      } else {
        const tilesRootKey = request.tilesRootKey || 'models';
        const tiles = storage.resolve(tilesRootKey, request.tilesRelativePath, { mustExist: true });
        const source = storage.resolve(glb.root_key, glb.relative_path, { mustExist: true });
        try {
          derivativePhase(processing, job, owner, 'auditing');
          let reusedManifest = null;
          if (request.reuseVerifiedProvenance === true) {
            const operation = processing.database.prepare("SELECT payload_json FROM dataset_operations WHERE processing_attempt_id=? AND status='awaiting_derivatives'").get(attempt.id);
            const payload = JSON.parse(operation?.payload_json || '{}');
            const repair = payload.companionRepair && processing.companionRepairCandidate(payload.sourceOutputId, { replacementAttemptId: attempt.id });
            if (!repair || repair.sourceVersionId !== payload.companionSourceOutputId
              || payload.ids?.versionId !== attempt.resultModelVersionId || tilesRootKey !== 'models'
              || request.tilesRelativePath !== `${payload.targetRelativePath}/recovery-companions/tiles`) {
              throw Object.assign(new Error('verified mesh reuse has no authorized companion-repair lineage'), { code: 'lod_provenance_invalid' });
            }
            reusedManifest = verifyRecoveryCompanionPlan(processing.database, payload.sourceVersionId, payload.reusedTiles, { meshTilesOnly: true });
          } else {
            await run(process.execPath, [audit, tiles, source, '--external-source'], { signal: controller.signal });
          }
          derivativePhase(processing, job, owner, 'verifying');
          const verified = await verifiedLodAsset({
            versionId: attempt.resultModelVersionId,
            rootKey: tilesRootKey,
            relativePath: path.posix.join(request.tilesRelativePath, 'tileset.json'),
            format: '3dtiles',
            contentType: 'application/json',
            byteSize: fs.statSync(path.join(tiles, 'tileset.json')).size,
            attemptId: attempt.id,
          }, tiles, source);
          if (reusedManifest && verified.asset.manifestSha256 !== reusedManifest.assets[0]?.manifestSha256) {
            throw Object.assign(new Error('copied verified mesh artifacts changed before registration'), { code: 'lod_provenance_invalid' });
          }
          derivativePhase(processing, job, owner, 'registering');
          if (!processing.registerVerifiedLodAsset(job.id, owner, verified.asset, verified.provenance, { leaseToken: job.lease_token })) {
            throw Object.assign(new Error('derivative lease was lost before verified tile registration'), { code: 'lease_lost' });
          }
          const auditEvidence = successfulLodAuditEvidence(verified.provenance);
          derivativeResult = { verified: true, reused: true, ...(auditEvidence ? { auditEvidence } : {}) };
        } catch (error) {
          if (error.code === 'lease_lost') throw error;
          if (error.exitCode !== 3) throw error;
          if (!request.optional) {
            throw Object.assign(new Error('required native tiles failed equivalence verification'), { code: 'lod_audit_failed', cause: error });
          }
          derivativeResult = { verified: false, fallback: 'glb', reason: sanitizeLogMessage(error.message).slice(0, 500) };
        }
      }
    } else if (job.derivative_type === 'ept') {
      if (!config.localDerivativesEnabled) throw Object.assign(new Error('local point-cloud derivative fallback is disabled'), { code: 'derivative_unavailable' });
      if (!point) throw new Error('point cloud source is missing');
      const source = storage.resolve(point.root_key, point.relative_path, { mustExist: true });
      const base = storage.resolve('models', `${task.id}/${attempt.id}`);
      fs.mkdirSync(base, { recursive: true });
      const outputName = `ept-${job.id}`, outputRelative = `${task.id}/${attempt.id}/${outputName}`, output = path.join(base, outputName);
      const incomplete = `${output}.${job.lease_token}.incomplete`, complete = `${output}.${job.lease_token}.complete`;
      const {EptConversionReceiptRepository}=require('./eptConversionReceiptRepository');
      const {inspectEptConversionOutput}=require('./eptConversionReceipt');
      const {captureEptConverterIdentity,assertEptConverterIdentity}=require('./eptConverterIdentity');
      const receipts=new EptConversionReceiptRepository(processing);
      let durableReceipt=receipts.get(job.id);
      const verifiedAsset = async (directory) => {
        const integrity=await hashTree(directory),manifest=integrity.files.find((file)=>file.relativePath==='ept.json');
        if(!manifest)throw Object.assign(new Error('Entwine did not produce ept.json'),{code:'invalid_asset_tree'});
        return{asset:{versionId:attempt.resultModelVersionId,rootKey:'models',relativePath:`${outputRelative}/ept.json`,format:'ept',contentType:'application/json',byteSize:manifest.byteSize,attemptId:attempt.id,sha256:manifest.sha256,manifestSha256:integrity.manifestSha256,manifestFiles:integrity.files},retainedBytes:manifestTreeBytes(integrity.files)};
      };
      try {
        if(durableReceipt){
          if(!/^[A-Za-z0-9-]{1,200}$/.test(durableReceipt.generationLeaseToken))throw Object.assign(new Error('Invalid EPT recovery token'),{code:'ept_conversion_receipt_invalid'});
          const retainedComplete=`${output}.${durableReceipt.generationLeaseToken}.complete`;
          const recovery=fs.existsSync(output)?output:retainedComplete;
          if(!fs.existsSync(recovery))throw Object.assign(new Error('Receipted EPT output is missing; a new conversion job is required'),{code:'ept_conversion_output_missing'});
          derivativePhase(processing,job,owner,'verifying');
          const verified=await verifiedAsset(recovery);
          if(!receipts.validate(job.id,owner,verified.asset,{leaseToken:job.lease_token}))throw Object.assign(new Error('EPT recovery bytes or source evidence changed'),{code:'ept_conversion_receipt_invalid'});
          const registered=processing.registerVerifiedEptAsset(job.id,owner,verified.asset,{leaseToken:job.lease_token,...(recovery!==output?{promote:()=>{
            if(fs.existsSync(output)||fs.statSync(recovery).dev!==fs.statSync(base).dev)throw Object.assign(new Error('EPT recovery activation conflict'),{code:'derivative_activation_conflict'});
            fs.renameSync(recovery,output);
          }}:{})});
          if(!registered)throw Object.assign(new Error('EPT recovery lease was lost'),{code:'lease_lost'});
          derivativeResult={verified:true,resumed:true,retainedBytes:verified.retainedBytes,fileCount:verified.asset.manifestFiles.length};
        }else if(fs.existsSync(output)){
          derivativePhase(processing,job,owner,'verifying');const verified=await verifiedAsset(output);derivativePhase(processing,job,owner,'registering');if(!processing.registerVerifiedEptAsset(job.id,owner,verified.asset,{leaseToken:job.lease_token}))throw Object.assign(new Error('derivative lease was lost before verified EPT registration'),{code:'lease_lost'});derivativeResult={verified:true,resumed:true,retainedBytes:verified.retainedBytes,fileCount:verified.asset.manifestFiles.length};
        }else{
          fs.rmSync(incomplete,{recursive:true,force:true});fs.rmSync(complete,{recursive:true,force:true});
          const reservation=processing.derivativeStorageReservation(job.id);storage.requireDerivativeSpace('models',{sourceBytes:inputSnapshot.totalByteSize,expectedFiles:100000,reservedBytes:reservation?.accountedByteSize||0,otherReservedBytes:processing.activeDerivativeReservationBytes(job.id),reservedDatasetBytes:processing.activeProcessingReservationBytes(attempt.id)});
          derivativePhase(processing, job, owner, 'indexing');
          const inputEvidence=receipts.inputEvidence(job.id);
          const converter=inputEvidence?await captureEptConverterIdentity(config.entwineBin,{signal:controller.signal}):null;
          await run(converter?.executablePath||config.entwineBin, ['build', '-i', source, '-o', incomplete], { signal: controller.signal });
          // Conversion must still refer to the exact bytes verified before it
          // started. This is required before any later unit-proof inheritance.
          await verifyDerivativeInputSnapshot(storage, inputSnapshot, { signal: controller.signal });
          if(converter)await assertEptConverterIdentity(converter,{signal:controller.signal});
          derivativePhase(processing,job,owner,'verifying');const verified=await verifiedAsset(incomplete);
          if(inputEvidence){
            const headerPath=path.join(incomplete,'ept.json');
            if(fs.statSync(headerPath).size>1024*1024)throw Object.assign(new Error('EPT metadata exceeds inspection limit'),{code:'measurement_ept_schema_unsupported'});
            await inspectEptConversionOutput(JSON.parse(fs.readFileSync(headerPath,'utf8')),inputEvidence);
          }
          fs.renameSync(incomplete,complete);
          if(converter){
            durableReceipt=receipts.create(job.id,owner,{converter,outputAsset:verified.asset},{leaseToken:job.lease_token});
            if(!durableReceipt)throw Object.assign(new Error('EPT conversion lease or source proof was lost'),{code:'lease_lost'});
          }
          derivativePhase(processing,job,owner,'registering');
          const registered=processing.registerVerifiedEptAsset(job.id,owner,verified.asset,{leaseToken:job.lease_token,promote:()=>{if(fs.existsSync(output))throw Object.assign(new Error('EPT final appeared during activation'),{code:'derivative_activation_conflict'});if(fs.statSync(complete).dev!==fs.statSync(base).dev)throw Object.assign(new Error('EPT activation crossed filesystems'),{code:'invalid_storage_location'});fs.renameSync(complete,output);}});
          if(!registered)throw Object.assign(new Error('derivative lease was lost before verified EPT registration'),{code:'lease_lost'});derivativeResult={verified:true,resumed:false,retainedBytes:verified.retainedBytes,fileCount:verified.asset.manifestFiles.length};
        }
      } catch (error) {
        fs.rmSync(incomplete, { recursive: true, force: true });
        // A committed receipt must retain its completed generation for a later
        // lease to recover, including a failure between rename and SQL commit.
        if(!durableReceipt)fs.rmSync(complete,{recursive:true,force:true});
        throw error;
      }
    } else if (job.derivative_type === 'mesh_tiles') {
      const generation = await generateMeshTilesImpl({ processing, storage, config, attempt, job, owner, task, obj, glb, inputSnapshot, previousTiles, audit, signal: controller.signal, onPhase: (phase) => derivativePhase(processing, job, owner, phase) });
      derivativeResult = { verified: true, reused: false, ...generation };
    } else throw new Error('unsupported derivative type');

    if (lost) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    const completedResult = {
      ...derivativeResult,
      phase: 'complete',
      summary: derivativeResult.verified === false
        ? 'Existing streaming artifacts were rejected; no derivative was registered.'
        : 'Verified derivative registered and ready for the Viewer.',
      durationMs: Math.max(0, Date.now() - startedAt),
    };
    if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) {
      if (!processing.completeOptionalDerivative(job.id, owner, completedResult, job.lease_token)) throw Object.assign(new Error('derivative lease was lost'), { code: 'lease_lost' });
    } else emitReady(processing, config, attempt, job, owner, completedResult);
    console.info(`[derivative] type=${job.derivative_type} outcome=complete durationMs=${completedResult.durationMs}`);
    return true;
  } catch (error) {
    const safe = sanitizeLogMessage(error.message).slice(0, 1000);
    const errorCode = String(error.code || 'derivative_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 80) || 'derivative_failed';
    console.error(`[derivative] type=${['lod_audit','mesh_tiles','ept'].includes(job.derivative_type)?job.derivative_type:'unsupported'} outcome=failed durationMs=${Math.max(0,Date.now()-startedAt)} code=${errorCode}`);
    const pressureEvidence = error.resourcePressureEvidence || (isExplicitResourcePressure(error) ? {
      resourcePressure: true,
      ...(Number.isSafeInteger(error.exitCode) ? { exitCode: error.exitCode } : {}),
      converterDiagnostics: error.converterDiagnostics || [],
      workerResources: error.resourceDiagnostics || derivativeResourceSnapshot(),
    } : null);
    if (job.derivative_type === 'mesh_tiles' && error.code !== 'lease_lost' && pressureEvidence) {
      try {
        processing.recordProcessingEvent({
          attemptId: attempt.id,
          derivativeJobId: job.id,
          eventType: 'obj2tiles.resource_pressure',
          phase: 'generating',
          severity: 'error',
          errorCode: 'obj2tiles_resource_pressure',
          message: error.serialRetryAttempted
            ? 'Obj2Tiles encountered scheduler or memory pressure and its one serial retry did not complete.'
            : 'Obj2Tiles encountered scheduler or memory pressure.',
          details: { derivativeType: 'mesh_tiles', ...pressureEvidence },
        });
      } catch (diagnosticError) {
        console.error(`[derivative] type=mesh_tiles outcome=diagnostic_persist_failed code=${String(diagnosticError.code || 'processing_event_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}`);
      }
    }
    if (error.code !== 'lease_lost') {
      try {
        processing.recordProcessingEvent({attemptId:attempt.id,derivativeJobId:job.id,eventType:'derivative.diagnostic',phase:'failed',severity:'error',errorCode,message:safe,details:{derivativeType:job.derivative_type,exitCode:pressureEvidence?.exitCode??error.exitCode,resourcePressure:Boolean(pressureEvidence?.resourcePressure||error.resourcePressure),metric:error.auditEvidence?.metric,observed:error.auditEvidence?.observed,limit:error.auditEvidence?.limit,grayZoneLimit:error.auditEvidence?.grayZoneLimit,converterDiagnostics:pressureEvidence?.converterDiagnostics||error.converterDiagnostics,workerResources:pressureEvidence?.workerResources||error.resourceDiagnostics}});
      } catch (diagnosticError) {
        console.error(`[derivative] type=${job.derivative_type} outcome=diagnostic_persist_failed code=${String(diagnosticError.code || 'processing_event_failed').replace(/[^a-z0-9_-]/gi, '').slice(0, 80)}`);
      }
      if (request.optional && ['ready_for_review', 'published'].includes(attempt.status)) processing.failOptionalDerivative(job.id, owner, safe, errorCode, job.lease_token);
      else processing.failDerivative(job.id, owner, safe, errorCode, job.lease_token, error.auditEvidence);
    }
    return true;
  } finally {
    clearInterval(heartbeat);
  }
}

module.exports = {
  assertLodArtifactsMatchSnapshot,
  derivativeResourceSnapshot,
  generateMeshTiles,
  isExplicitResourcePressure,
  obj2TilesDiagnostics,
  structuredCommandFailure,
  successfulLodAuditEvidence,
  processOneDerivative,
  run,
  runObj2TilesWithResourceRetry,
  stopProcessTree,
};
