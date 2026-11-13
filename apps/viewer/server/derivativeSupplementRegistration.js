'use strict';

const crypto = require('node:crypto');
const { canonicalSupplement, inventory, relative } = require('./derivativeSupplement');
const fail = code => { throw Object.assign(new Error(code), { code }); };

function immutableSupplementSlot(operation, context) {
  if (!/^[a-f0-9-]{36}$/.test(operation?.id || '') || !/^[a-f0-9]{48}$/.test(operation?.lease_token || '')
    || operation.attempt_id !== context?.attempt?.id || operation.version_id !== context?.version?.id
    || operation.job_id !== context?.job?.id || context.output?.root_key !== 'models'
    || context.output.storage_mode !== 'managed') fail('supplement_registration_unbound');
  relative(context.output.relative_path);
  return `${context.output.relative_path}/derived/recovery/${operation.id}/${operation.lease_token}`;
}

// The trusted independent verifier supplies a full pinned-tree hash and audited
// render closure. Never publish its entire directory: it also contains proofs.
function supplementRenderRegistration(operation, context, manifest, verified) {
  const slot = immutableSupplementSlot(operation, context), parsed = canonicalSupplement(manifest), output = inventory(parsed.manifest.files);
  if (parsed.supplementSha256 !== operation.supplement_sha256) fail('supplement_request_mismatch');
  if (output.manifestSha256 !== manifest.outputManifestSha256
    || manifest.identity?.attemptId !== context.attempt.id || manifest.identity?.versionId !== context.version.id)
    fail('supplement_registration_unbound');
  const all = verified?.asset?.manifestFiles, artifacts = verified?.renderArtifacts;
  if (!Array.isArray(all) || all.length !== output.files.length || !Array.isArray(artifacts)) fail('supplement_render_closure_invalid');
  const hashed = new Map();
  for (const file of all) {
    if (hashed.has(file.relativePath)) fail('supplement_render_closure_invalid');
    hashed.set(file.relativePath, file);
  }
  for (const file of output.files) {
    const actual = hashed.get(file.relativePath);
    if (!actual || actual.byteSize !== file.byteSize || actual.sha256 !== file.sha256) fail('supplement_render_closure_invalid');
  }
  const render = output.files.filter(file => file.role === 'render');
  const audited = new Map();
  for (const artifact of artifacts) {
    if (audited.has(artifact.uri)) fail('supplement_render_closure_invalid');
    audited.set(artifact.uri, artifact);
  }
  if (render.length < 2 || audited.size !== render.length || verified.provenance?.audit?.artifactCount !== render.length) fail('supplement_render_closure_invalid');
  for (const file of render) {
    const artifact = audited.get(file.relativePath);
    if (!artifact || artifact.byteLength !== file.byteSize || artifact.sha256 !== file.sha256) fail('supplement_render_closure_invalid');
  }
  const files = render.map(file => {
    const actual = hashed.get(file.relativePath);
    return { relativePath: file.relativePath, byteSize: file.byteSize, sha256: file.sha256,
      ...(actual.chunks ? { chunks: actual.chunks } : {}) };
  }).sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  // Match the repository's existing hashTree contract, including ordering.
  const manifestSha256 = crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex');
  const tileset = files.find(file => file.relativePath === 'tileset.json');
  if (!tileset || verified.asset.sha256 !== tileset.sha256 || verified.asset.byteSize !== tileset.byteSize) fail('supplement_render_closure_invalid');
  const renderBytes = files.reduce((sum, file) => sum + file.byteSize, 0);
  return { slot, totalBytes: output.byteSize, privateBytes: output.byteSize - renderBytes, renderBytes,
    files: output.files, inventorySha256: output.manifestSha256,
    asset: { versionId: context.version.id, attemptId: context.attempt.id, rootKey: 'models',
      relativePath: `${slot}/tileset.json`, format: '3dtiles', contentType: 'application/json',
      byteSize: tileset.byteSize, sha256: tileset.sha256, manifestSha256, manifestFiles: files } };
}

// Called ONLY by the pinned custody adapter after independent proof, fresh
// rehash and a physical write/maintenance fence. No rename or filesystem write
// occurs here. It shares recovery's restore/register/ready/ACK SQL transaction.
function registerImmutableSupplement({ processing, operation, context, manifest, verified, assertLease }) {
  if (!processing?.database?.isTransaction || typeof assertLease !== 'function') fail('readiness_transaction_required');
  assertLease();
  const registered = supplementRenderRegistration(operation, context, manifest, verified);
  const row = processing.database.prepare('SELECT * FROM derivative_recovery_operations WHERE id=?').get(operation.id);
  if (!row || row.status !== 'leased' || row.lease_owner !== operation.lease_owner || row.lease_token !== operation.lease_token
    || row.attempt_id !== operation.attempt_id || row.job_id !== operation.job_id || row.version_id !== operation.version_id)
    fail('recovery_lease_lost');
  const assetId = processing.registerVerifiedLodAssetInTransaction(context.job.id, row.lease_owner,
    registered.asset, verified.provenance, { leaseToken: row.lease_token });
  if (!assetId) fail('supplement_registration_rejected');
  assertLease();
  const at = new Date().toISOString();
  processing.database.prepare(`INSERT INTO model_output_storage_components
    (output_id,component_key,root_key,relative_path,byte_size,manifest_sha256,created_at,updated_at)
    VALUES (?,?,'models',?,?,?,?,?)`).run(context.version.id, `recovery-private:${operation.id}`,
    registered.slot, registered.privateBytes, registered.inventorySha256, at, at);
  // Keep the full private inventory in the internal transaction journal, never
  // model_assets/model_asset_files or a client-facing model metadata field.
  processing.insertAudit({ actorType: 'system', action: 'derivative_recovery.retained_inventory',
    entityType: 'derivative_recovery', entityId: operation.id,
    details: { relativePath: registered.slot, inventorySha256: registered.inventorySha256,
      totalBytes: registered.totalBytes, renderBytes: registered.renderBytes, privateBytes: registered.privateBytes,
      files: registered.files } });
  return { verified: true, retainedBytes: registered.totalBytes, renderBytes: registered.renderBytes,
    privateProofBytes: registered.privateBytes, fileCount: registered.files.length };
}

// Compose the existing source/producer/proof checks with the real immutable-slot
// registration path. All dependencies are server-owned, never HTTP fields.
// The actual proof engine and maintenance/write fence remain deployment gates.
function createStagingImmutableSupplementQualifier({ modelsRoot, acquireFence, verifyCandidate, ...options } = {}) {
  if (typeof verifyCandidate !== 'function' || typeof options.resolveBinding !== 'function') fail('supplement_adapter_unqualified');
  const { createSupplementQualifier } = require('./derivativeSupplement');
  const { createPinnedReadCustody } = require('./derivativeSupplementFiles');
  return async request => {
    let verified = null;
    const custodyFactory = createPinnedReadCustody({ sourceRoot: modelsRoot, supplementRoot: modelsRoot, acquireFence,
      relativeSlot: ({ operation, context }) => immutableSupplementSlot(operation, context),
      registerVerified: args => registerImmutableSupplement({ ...args, operation: request.operation, verified }) });
    const qualifier = createSupplementQualifier({ ...options,
      resolveBinding: async args => {
        const binding = await options.resolveBinding(args);
        if (binding?.environment !== 'STAGING') fail('supplement_staging_only');
        return binding;
      },
      acquireCustody: async args => {
        const custody = await custodyFactory(args), release = custody.release;
        custody.release = () => { verified = null; return release(); };
        return custody;
      },
      independentlyVerify: async args => {
        const result = await verifyCandidate(args);
        if (!result?.verified || !result?.receipt) fail('supplement_independent_proof_incomplete');
        // Capture metadata, not file descriptors or whole source/output bytes.
        verified = structuredClone(result.verified);
        supplementRenderRegistration(request.operation, request.context, args.manifest, verified);
        return result.receipt;
      } });
    return qualifier(request);
  };
}

module.exports = { immutableSupplementSlot, supplementRenderRegistration, registerImmutableSupplement, createStagingImmutableSupplementQualifier };
