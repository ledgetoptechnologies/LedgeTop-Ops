'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonical, digest } = require('./sourceReleaseContractV1');
const ReferenceProtocol = require('./referenceProtocol');
const { receiptVerifiedLodProvenance } = require('./lodDerivativePolicy');

const MAX_ASSETS = 256;
const MAX_FILES = 100_000;
const MAX_BYTES = Number.MAX_SAFE_INTEGER;
const REQUIRED_ASSET_KINDS = Object.freeze(['ept', 'glb', 'obj', 'tiles']);
const REQUIRED_DERIVATIVES = Object.freeze(['mesh_tiles']);
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sameIdentity = (left, right) => left && right
  && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
  && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;

function requiredOutputState(database, attemptId) {
  const row = database.prepare(`SELECT a.id AS attempt_id,a.task_id,a.status AS attempt_status,
      a.result_model_id AS model_id,a.result_model_version_id AS version_id,
      t.active_attempt_id,t.status AS task_status,m.status AS model_status,
      m.active_version_id,v.status AS version_status,v.model_id AS version_model_id,v.metadata_json,
      o.id AS output_id,o.status AS output_status,o.attempt_id AS output_attempt_id,
      o.model_id AS output_model_id,o.root_key AS output_root_key,o.relative_path AS output_relative_path
    FROM processing_attempts a
    JOIN processing_tasks t ON t.id=a.task_id
    JOIN models m ON m.id=a.result_model_id
    JOIN model_versions v ON v.id=a.result_model_version_id AND v.model_id=m.id
    JOIN model_outputs o ON o.id=v.id AND o.attempt_id=a.id AND o.model_id=m.id
    WHERE a.id=?`).get(attemptId);
  return row ? { ...row } : null;
}

function assertReadyState(state, attemptId, historicalProof) {
  if (!state || state.attempt_id !== attemptId
      || !['ready_for_review', 'published'].includes(state.attempt_status)
      || !['ready', 'published'].includes(state.output_status)
      || state.output_attempt_id !== attemptId || state.output_model_id !== state.model_id
      || state.version_model_id !== state.model_id || state.version_status !== 'ready'
      || state.model_status !== 'ready')
    fail('source_release_outputs_not_ready');
  if (historicalProof) {
    if (historicalProof.kind !== 'verified_outputs_ready' || historicalProof.attemptId !== attemptId
        || historicalProof.modelId !== state.model_id || historicalProof.modelVersionId !== state.version_id)
      fail('source_release_output_binding_invalid');
  } else if (state.active_attempt_id !== attemptId || !['ready_for_review', 'published'].includes(state.task_status)
      || ((state.task_status === 'published' || state.attempt_status === 'published') && state.active_version_id !== state.version_id))
    fail('source_release_outputs_not_ready');
  if (![state.model_id, state.version_id, state.task_id].every((id) => typeof id === 'string' && id.length > 0))
    fail('source_release_output_binding_invalid');
}

function assetRows(database, versionId) {
  const assets = database.prepare(`SELECT * FROM model_assets WHERE version_id=?
    AND kind IN ('ept','glb','obj','pointCloud','tiles') ORDER BY kind,id`).all(versionId);
  if (!assets.length || assets.length > MAX_ASSETS) fail('source_release_output_inventory_invalid');
  let count = 0;
  const result = [];
  for (const asset of assets) {
    const files = database.prepare('SELECT relative_path,byte_size,sha256 FROM model_asset_files WHERE asset_id=? ORDER BY relative_path').all(asset.id);
    count += files.length || 1;
    if (count > MAX_FILES) fail('source_release_output_inventory_invalid');
    result.push({ asset, files });
  }
  return result;
}

function acceptedResultIntent(sourceIntake, attemptId) {
  const intent = sourceIntake?.outbox?.getIntent?.(attemptId);
  if (!intent || intent.state !== 'accepted' || !intent.remoteBinding || !intent.sourceIntakeCanonical
      || !intent.resultManifestCanonical || !intent.copyRequestCanonical || !intent.copyAckCanonical
      || intent.remoteBinding.protocol !== 'ltds-viewer-source-intake-binding-v2')
    fail('source_release_accepted_result_unavailable');
  let manifest;
  let request;
  try {
    manifest = JSON.parse(intent.resultManifestCanonical);
    request = JSON.parse(intent.sourceIntakeCanonical);
  } catch { fail('source_release_accepted_result_unavailable'); }
  if (!Array.isArray(manifest.objects) || !manifest.objects.length) fail('source_release_accepted_result_unavailable');
  const binding = intent.remoteBinding;
  const expected = { jobId: binding.jobId, generation: binding.generation, environment: binding.environment,
    pipelineDigest: binding.pipelineDigest, resultManifestSha256: manifest.resultManifestSha256,
    objectIds: manifest.objects.map((item) => item.id) };
  const requestedEngines = ['odm', 'treedar'].filter((engine) => request.pipeline?.[engine]?.requested === true);
  if (requestedEngines.length) expected.requestedEngines = requestedEngines;
  try { ReferenceProtocol.validateStoredResultManifest(manifest, expected); }
  catch { fail('source_release_accepted_result_unavailable'); }
  if (manifest.schemaVersion === 1 && (Object.keys(manifest.engineVersions).length !== 1
      || !Object.hasOwn(manifest.engineVersions, 'odm')
      || manifest.objects.filter((item) => item.role === 'odm_archive').length !== 1))
    fail('source_release_required_output_policy_unknown');
  // Combined/TreeDar manifests remain held until every required role has an
  // authoritative typed Viewer registration and its own readiness check.
  if (manifest.schemaVersion !== 1) fail('source_release_required_output_policy_unknown');
  return { intent, manifest };
}

function requiredOutputClosure(database, attemptId, versionId, registrations, state) {
  const byKind = new Map();
  for (const row of registrations) {
    const items = byKind.get(row.asset.kind) || [];
    items.push(row);
    byKind.set(row.asset.kind, items);
  }
  const required = [];
  for (const kind of REQUIRED_ASSET_KINDS) {
    const matches = byKind.get(kind) || [];
    if (matches.length !== 1) fail('source_release_required_output_missing');
    required.push(matches[0]);
  }
  const derivativeRows = database.prepare(`SELECT id,attempt_id,derivative_type,status,request_json
    FROM derivative_jobs WHERE attempt_id=? ORDER BY derivative_type,id`).all(attemptId).map((row) => ({ ...row }));
  const byType = new Map();
  for (const derivative of derivativeRows) {
    if (byType.has(derivative.derivative_type)) fail('source_release_required_derivative_invalid');
    byType.set(derivative.derivative_type, derivative);
  }
  for (const type of REQUIRED_DERIVATIVES) {
    const derivative = byType.get(type);
    let request;
    try { request = JSON.parse(derivative?.request_json || 'null'); } catch { request = null; }
    if (!derivative || derivative.attempt_id !== attemptId || derivative.status !== 'complete'
        || !request || Object.getPrototypeOf(request) !== Object.prototype || request.optional !== false)
      fail('source_release_required_derivative_not_ready');
  }
  const meshJob = byType.get('mesh_tiles');
  const meshRequest = JSON.parse(meshJob.request_json);
  const meshTilesRoot = `${state.task_id}/${attemptId}/tiles-ktx2-etc1s-${meshJob.id}`;
  const registeredTiles = byKind.get('tiles') || [];
  if (registeredTiles.length !== 1 || registeredTiles[0].asset.relative_path !== `${meshTilesRoot}/tileset.json`
      || (meshRequest.tilesRelativePath != null && meshRequest.tilesRelativePath !== meshTilesRoot))
    fail('source_release_required_derivative_not_ready');
  const receiptRows = database.prepare(`SELECT id,details_json FROM audit_events
    WHERE action='derivative.tiles_verified' AND entity_type='derivative_job' AND entity_id=? AND actor_type='system' AND actor_id IS NULL`)
    .all(meshJob.id);
  let metadata;
  try { metadata = JSON.parse(state.metadata_json || '{}'); } catch { metadata = {}; }
  const assetValues = registrations.map(({ asset }) => ({ kind: asset.kind, sha256: asset.sha256,
    relativePath: asset.relative_path, manifestSha256: asset.manifest_sha256 }));
  const tilesReceipts = receiptRows.flatMap((row) => {
    try { return [{ eventId: row.id, derivativeJobId: meshJob.id, details: JSON.parse(row.details_json) }]; }
    catch { return []; }
  });
  if (tilesReceipts.length !== 1 || !receiptVerifiedLodProvenance(metadata, assetValues, tilesReceipts[0], versionId))
    fail('source_release_required_derivative_not_ready');
  return { assets: required, derivatives: derivativeRows.filter((row) => REQUIRED_DERIVATIVES.includes(row.derivative_type)), meshJob };
}

function sameRegistrations(left, right) {
  const serialize = (rows) => rows.map(({ asset, files }) => ({
    asset: { id: asset.id, version_id: asset.version_id, kind: asset.kind, root_key: asset.root_key,
      relative_path: asset.relative_path, storage_mode: asset.storage_mode, byte_size: asset.byte_size,
      sha256: asset.sha256, manifest_sha256: asset.manifest_sha256, source_attempt_id: asset.source_attempt_id },
    files: files.map((file) => ({ relative_path: file.relative_path, byte_size: file.byte_size, sha256: file.sha256 })),
  }));
  return canonical(serialize(left)).equals(canonical(serialize(right)));
}

function memberBasePath(asset, files) {
  if (!files.length) return null;
  const primary = files.filter((file) => file.byte_size === asset.byte_size && file.sha256 === asset.sha256);
  if (primary.length !== 1) fail('source_release_output_inventory_invalid');
  const assetPath = String(asset.relative_path).replace(/\\/g, '/');
  const primaryPath = primary[0].relative_path;
  if (assetPath === primaryPath) return path.posix.dirname(primaryPath);
  if (assetPath.endsWith(`/${primaryPath}`)) return assetPath.slice(0, -(primaryPath.length + 1));
  if (assetPath.endsWith(`/${path.posix.basename(primaryPath)}`)) return path.posix.dirname(assetPath);
  return assetPath;
}

function openAndHash(absolutePath, expectedSize, expectedSha256, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { code: 'lease_lost' }));
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    let fd;
    try {
      fd = fs.openSync(absolutePath, fs.constants.O_RDONLY | noFollow);
      const before = fs.fstatSync(fd, { bigint: true });
      const pathBefore = fs.lstatSync(absolutePath, { bigint: true });
      if (!before.isFile() || pathBefore.isSymbolicLink() || !sameIdentity(before, pathBefore)
          || before.size !== BigInt(expectedSize)) throw Object.assign(new Error('changed'), { code: 'source_release_output_changed' });
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      return reject(error?.code === 'source_release_output_changed' ? error
        : Object.assign(new Error('source_release_output_unavailable'), { code: 'source_release_output_unavailable' }));
    }
    const before = fs.fstatSync(fd, { bigint: true });
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let offset = 0;
    const read = () => {
      if (signal?.aborted) {
        try { fs.closeSync(fd); } catch {}
        return reject(Object.assign(new Error('aborted'), { code: 'lease_lost' }));
      }
      if (offset >= Number(before.size)) {
        try {
          const after = fs.fstatSync(fd, { bigint: true });
          const pathAfter = fs.lstatSync(absolutePath, { bigint: true });
          const actual = hash.digest('hex');
          if (!sameIdentity(before, after) || !sameIdentity(after, pathAfter) || pathAfter.isSymbolicLink()
              || actual !== expectedSha256) throw Object.assign(new Error('changed'), { code: 'source_release_output_changed' });
          fs.closeSync(fd);
          return resolve(actual);
        } catch (error) {
          try { fs.closeSync(fd); } catch {}
          return reject(error?.code === 'source_release_output_changed' ? error
            : Object.assign(new Error('source_release_output_changed'), { code: 'source_release_output_changed' }));
        }
      }
      fs.read(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset, (error, bytesRead) => {
        if (error || bytesRead <= 0) {
          try { fs.closeSync(fd); } catch {}
          return reject(Object.assign(new Error('source_release_output_changed'), { code: 'source_release_output_changed' }));
        }
        offset += bytesRead;
        hash.update(buffer.subarray(0, bytesRead));
        read();
      });
    };
    read();
  });
}

async function verifiedOutputProof({ processing, storage, sourceIntake, attemptId, signal, historicalProof,
  now = () => new Date().toISOString() } = {}) {
  if (!processing?.database || !storage?.resolve || typeof attemptId !== 'string') fail('source_release_output_context_invalid');
  const database = processing.database;
  const initialState = requiredOutputState(database, attemptId);
  assertReadyState(initialState, attemptId, historicalProof);
  const accepted = acceptedResultIntent(sourceIntake, attemptId);
  if (initialState.output_root_key !== 'models'
      || initialState.output_relative_path !== `${initialState.task_id}/${attemptId}/reference-v2-results`)
    fail('source_release_output_binding_invalid');
  const registrations = assetRows(database, initialState.version_id);
  const closure = requiredOutputClosure(database, attemptId, initialState.version_id, registrations, initialState);
  const objects = [];
  for (const { asset, files } of closure.assets) {
    const isGeneratedTiles = asset.kind === 'tiles';
    const expectedRelativePath = isGeneratedTiles
      ? `${initialState.task_id}/${attemptId}/tiles-ktx2-etc1s-${closure.meshJob.id}/tileset.json`
      : null;
    if (asset.root_key !== 'models' || (asset.storage_mode && asset.storage_mode !== 'managed')
        || asset.source_attempt_id !== attemptId || !Number.isSafeInteger(asset.byte_size) || asset.byte_size < 1
        || (isGeneratedTiles
          ? String(asset.relative_path || '').replace(/\\/g, '/') !== expectedRelativePath
          : !String(asset.relative_path || '').replace(/\\/g, '/').startsWith(`${initialState.output_relative_path}/output/`))
        || !/^[a-f0-9]{64}$/.test(asset.sha256 || '')) fail('source_release_output_inventory_invalid');
    const members = files.length ? files : [{ relative_path: '', byte_size: asset.byte_size, sha256: asset.sha256 }];
    let totalBytes = 0;
    const verifiedFiles = [];
    const basePath = memberBasePath(asset, files);
    for (const member of members) {
      signal?.throwIfAborted();
      if (typeof member.relative_path !== 'string' || (member.relative_path && (path.posix.isAbsolute(member.relative_path)
          || member.relative_path.split('/').some((part) => !part || part === '.' || part === '..')))
          || !Number.isSafeInteger(member.byte_size) || member.byte_size < 0 || !/^[a-f0-9]{64}$/.test(member.sha256 || ''))
        fail('source_release_output_inventory_invalid');
      totalBytes += member.byte_size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BYTES) fail('source_release_output_inventory_invalid');
      const relative = member.relative_path ? path.posix.join(basePath, member.relative_path) : asset.relative_path;
      const absolute = storage.resolve('models', relative, { mustExist: true });
      await openAndHash(absolute, member.byte_size, member.sha256, signal);
      verifiedFiles.push({ relativePath: member.relative_path || path.posix.basename(asset.relative_path),
        byteSize: member.byte_size, sha256: member.sha256 });
    }
    if (files.length && asset.manifest_sha256) {
      const expectedManifestSha256 = crypto.createHash('sha256').update(JSON.stringify(files.map((file) => ({
        relativePath: file.relative_path, byteSize: file.byte_size, sha256: file.sha256,
      })))).digest('hex');
      if (expectedManifestSha256 !== asset.manifest_sha256) fail('source_release_output_inventory_invalid');
    } else if (files.length) fail('source_release_output_inventory_invalid');
    objects.push({ assetId: asset.id, kind: asset.kind, byteSize: asset.byte_size, sha256: asset.sha256,
      manifestSha256: asset.manifest_sha256 || null, files: verifiedFiles });
  }
  const archive = accepted.manifest.objects.find((object) => object.role === 'odm_archive');
  if (!archive) fail('source_release_required_output_policy_unknown');
  const acceptedArchivePath = storage.resolve('models',
    `${initialState.task_id}/${attemptId}/reference-v2-results/accepted_objects/${archive.id}.bin`, { mustExist: true });
  await openAndHash(acceptedArchivePath, archive.byteSize, archive.sha256, signal);
  objects.push({ acceptedObjectId: archive.id, role: archive.role, byteSize: archive.byteSize, sha256: archive.sha256 });
  const currentState = requiredOutputState(database, attemptId);
  const currentRegistrations = assetRows(database, initialState.version_id);
  const currentAccepted = acceptedResultIntent(sourceIntake, attemptId);
  const currentClosure = requiredOutputClosure(database, attemptId, initialState.version_id, currentRegistrations, currentState);
  assertReadyState(currentState, attemptId, historicalProof);
  if (canonical(currentState).compare(canonical(initialState)) !== 0
      || !sameRegistrations(closure.assets, currentClosure.assets)
      || accepted.intent.resultManifestSha256 !== currentAccepted.intent.resultManifestSha256
      || accepted.intent.copyAckSha256 !== currentAccepted.intent.copyAckSha256
      || !canonical(closure.derivatives).equals(canonical(currentClosure.derivatives)))
    fail('source_release_output_binding_changed');
  const verifiedAt = now();
  if (typeof verifiedAt !== 'string' || !Number.isFinite(Date.parse(verifiedAt)) || new Date(verifiedAt).toISOString() !== verifiedAt)
    fail('source_release_timestamp_invalid');
  return {
    kind: 'verified_outputs_ready', attemptId, modelId: initialState.model_id,
    modelVersionId: initialState.version_id,
    outputInventorySha256: digest({ resultManifestSha256: accepted.manifest.resultManifestSha256, objects }), verifiedAt,
  };
}

module.exports = { verifiedOutputProof };
