'use strict';

const crypto = require('node:crypto');
const { stable } = require('../lod-converter-policy.cjs');
const { safeRelativePath } = require('./processingSecurity');
const { canonicalDerivativeInput } = require('./derivativeInputSnapshot');

const MAX_FILES = 10000;
const MAX_BYTES = 64 * 1024 ** 3;
const ROLES = new Set(['render', 'private-proof', 'diagnostic']);
const SHA = /^[a-f0-9]{64}$/;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = (domain, value) => crypto.createHash('sha256').update(`${domain}\0`).update(stable(value)).digest('hex');
function frozen(value) {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); }
  return value;
}

function keys(value, expected) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join('\0') !== [...expected].sort().join('\0')) fail('supplement_invalid_shape');
}

function relative(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f:]/.test(value)
    || safeRelativePath(value) !== value || value.split('/').some(part => !part || part === '.' || part === '..')) fail('supplement_invalid_path');
  return value;
}

function inventory(files) {
  if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('supplement_inventory_limit');
  const names = new Set(); let byteSize = 0;
  const normalized = files.map(file => {
    keys(file, ['relativePath', 'role', 'byteSize', 'sha256']);
    relative(file.relativePath);
    const folded = file.relativePath.toLowerCase();
    if (names.has(folded) || !ROLES.has(file.role) || !Number.isSafeInteger(file.byteSize)
      || file.byteSize < 0 || !SHA.test(file.sha256)) fail('supplement_invalid_inventory');
    names.add(folded); byteSize += file.byteSize;
    if (!Number.isSafeInteger(byteSize) || byteSize > MAX_BYTES) fail('supplement_inventory_limit');
    return { relativePath: file.relativePath, role: file.role, byteSize: file.byteSize, sha256: file.sha256 };
  }).sort((a, b) => Buffer.compare(Buffer.from(a.relativePath), Buffer.from(b.relativePath)));
  if (!normalized.some(file => file.role === 'render' && file.relativePath === 'tileset.json')
    || !normalized.some(file => file.role === 'private-proof')) fail('supplement_closure_missing');
  return { files: normalized, byteSize, manifestSha256: hash('ltds-derivative-supplement-inventory-v1', normalized) };
}

function canonicalSupplement(value) {
  keys(value, ['schemaVersion', 'identity', 'converter', 'coordinateFrame', 'files', 'outputManifestSha256']);
  if (value.schemaVersion !== 1) fail('supplement_schema_unsupported');
  keys(value.identity, ['attemptId', 'versionId', 'providerId', 'providerTaskId', 'initializationGeneration',
    'producerGeneration', 'nativeTaskId', 'environment', 'archiveSha256', 'sourceManifestSha256']);
  for (const name of ['attemptId', 'versionId', 'providerId', 'providerTaskId', 'nativeTaskId']) {
    if (typeof value.identity[name] !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(value.identity[name])) fail('supplement_invalid_identity');
  }
  if (!Number.isSafeInteger(value.identity.initializationGeneration) || value.identity.initializationGeneration < 1
    || !Number.isSafeInteger(value.identity.producerGeneration) || value.identity.producerGeneration < 1
    || !['STAGING', 'PRODUCTION'].includes(value.identity.environment)
    || !SHA.test(value.identity.archiveSha256) || !SHA.test(value.identity.sourceManifestSha256)) fail('supplement_invalid_identity');
  keys(value.converter, ['binarySha256', 'buildInfoSha256', 'commandSha256', 'policyRevision']);
  if (!['binarySha256', 'buildInfoSha256', 'commandSha256'].every(key => SHA.test(value.converter[key]))
    || typeof value.converter.policyRevision !== 'string' || !/^[a-z0-9-]{1,100}$/.test(value.converter.policyRevision)) fail('supplement_invalid_converter');
  keys(value.coordinateFrame, ['kind', 'unit', 'georeferenced']);
  // This first contract is specifically the unscaled local-frame pilot. A
  // georeferenced/metric lane needs its own server-verified frame contract.
  if (value.coordinateFrame.kind !== 'local' || value.coordinateFrame.unit !== 'unknown'
    || value.coordinateFrame.georeferenced !== false) fail('supplement_frame_unsupported');
  const output = inventory(value.files);
  if (value.outputManifestSha256 !== output.manifestSha256) fail('supplement_inventory_mismatch');
  const normalized = frozen({ schemaVersion: 1, identity: { ...value.identity }, converter: { ...value.converter },
    coordinateFrame: { ...value.coordinateFrame }, files: output.files, outputManifestSha256: output.manifestSha256 });
  return { manifest: normalized, byteSize: output.byteSize,
    supplementSha256: hash('ltds-derivative-supplement-v1', normalized) };
}

function expectedIdentity(processing, context, binding, producer) {
  const transfer = processing.getAttemptTransferProvenance(context.attempt.id), init = transfer?.initialization;
  const provider = processing.getProvider(context.attempt.provider_id);
  if (!binding || !['STAGING', 'PRODUCTION'].includes(binding.environment)
    || binding.providerId !== provider?.id || binding.providerEndpoint !== provider.endpoint
    || !processing.getVerifiedAttemptProducerReceipt(context.attempt.id)
    || init?.state !== 'acknowledged' || init.ambiguous || init.attemptId !== context.attempt.id
    || init.providerTaskId !== context.attempt.provider_task_id || !Number.isSafeInteger(init.generation)
    || init.generation < 1) fail('supplement_server_binding_unavailable');
  keys(producer, ['schemaVersion', 'providerEndpoint', 'providerTaskId', 'environment',
    'producerGeneration', 'nativeTaskId', 'archiveSha256']);
  if (producer.schemaVersion !== 1 || producer.providerEndpoint !== binding.providerEndpoint
    || producer.providerTaskId !== context.attempt.provider_task_id || producer.environment !== binding.environment
    || producer.archiveSha256 !== context.archive.archiveSha256
    || !Number.isSafeInteger(producer.producerGeneration) || producer.producerGeneration < 1
    || typeof producer.nativeTaskId !== 'string' || !/^[A-Za-z0-9_-]{1,120}$/.test(producer.nativeTaskId)) fail('supplement_producer_binding_mismatch');
  const source = canonicalDerivativeInput('mesh_tiles', context.input.files);
  if (source.manifestSha256 !== context.input.manifestSha256) fail('supplement_source_changed');
  if (context.archive.layoutVersion !== 2 || !Array.isArray(context.archive.archiveFiles)) fail('supplement_archive_closure_unavailable');
  const prefix = `${context.output.relative_path}/source/`;
  for (const file of source.files) {
    if (file.rootKey !== 'models' || !file.relativePath.startsWith(prefix)) fail('supplement_source_changed');
    const name = file.relativePath.slice(prefix.length);
    const matches = context.archive.archiveFiles.filter(item => item.relativePath === name
      && item.sha256 === file.sha256 && item.byteSize === file.byteSize);
    if (matches.length !== 1) fail('supplement_source_changed');
  }
  return { attemptId: context.attempt.id, versionId: context.version.id, providerId: provider.id,
    providerTaskId: context.attempt.provider_task_id, initializationGeneration: init.generation,
    producerGeneration: producer.producerGeneration, nativeTaskId: producer.nativeTaskId,
    environment: binding.environment, archiveSha256: context.archive.archiveSha256,
    sourceManifestSha256: source.manifestSha256 };
}

// This builds the future trusted qualifier; it does NOT install it. Every
// dependency must be server-owned, never supplied by an HTTP request. In
// particular custody must reserve/pin storage and implement durable promotion.
function createSupplementQualifier({ processing, resolveBinding, resolveProducerBinding, confirmProducerIncarnation, acceptConverter, acquireCustody, independentlyVerify } = {}) {
  return async ({ operation, context, supplement, assertCurrent, signal }) => {
    if (!processing || ![resolveBinding, resolveProducerBinding, confirmProducerIncarnation, acceptConverter, acquireCustody, independentlyVerify].every(item => typeof item === 'function')
      || typeof assertCurrent !== 'function') fail('supplement_adapter_unqualified');
    assertCurrent(); signal?.throwIfAborted();
    const parsed = canonicalSupplement(supplement);
    if (parsed.supplementSha256 !== operation.supplement_sha256) fail('supplement_request_mismatch');
    const binding = await resolveBinding({ operation, context });
    const producer = await resolveProducerBinding({ operation, context, binding });
    if (await confirmProducerIncarnation({ operation, context, binding, producer }) !== true) fail('supplement_producer_incarnation_unbound');
    const expected = expectedIdentity(processing, context, binding, producer);
    if (stable(expected) !== stable(parsed.manifest.identity)
      || stable(binding.coordinateFrame) !== stable(parsed.manifest.coordinateFrame)) fail('supplement_identity_mismatch');
    if (await acceptConverter(parsed.manifest.converter) !== true) fail('supplement_converter_unqualified');
    assertCurrent();
    const custody = await acquireCustody({ operation, context, inventory: parsed.manifest.files,
      totalByteSize: parsed.byteSize, signal, assertCurrent });
    let returned = false, released = false;
    const release = () => { if (!released) { released = true; custody?.release?.(); } };
    try {
      if (!custody || !['verifySource', 'verifyOutput', 'assertPinned', 'register', 'release'].every(key => typeof custody[key] === 'function')) fail('supplement_custody_unqualified');
      await custody.verifySource(context.input.files, { signal, assertCurrent });
      await custody.verifyOutput(parsed.manifest.files, { signal, assertCurrent });
      assertCurrent(); custody.assertPinned();
      const rawReceipt = await independentlyVerify({ operation, context, identity: expected,
        manifest: parsed.manifest, source: custody.source, output: custody.output, signal, assertCurrent });
      keys(rawReceipt, ['schemaVersion', 'policyRevision', 'identity', 'outputManifestSha256', 'checks']);
      keys(rawReceipt.checks, ['geometry', 'sourceUvCoverage', 'atlasPixels', 'finalTextureRelation']);
      if (rawReceipt.schemaVersion !== 1 || rawReceipt.policyRevision !== parsed.manifest.converter.policyRevision
        || stable(rawReceipt.identity) !== stable(expected) || rawReceipt.outputManifestSha256 !== parsed.manifest.outputManifestSha256
        || Object.values(rawReceipt.checks).some(value => value !== true)) fail('supplement_independent_proof_incomplete');
      const receipt = frozen(JSON.parse(stable(rawReceipt)));
      // Rehash after independent verification: a receipt cannot bless files
      // swapped/modified during a decoder run. Custody fences deletion/writes.
      await custody.verifySource(context.input.files, { signal, assertCurrent });
      await custody.verifyOutput(parsed.manifest.files, { signal, assertCurrent });
      assertCurrent(); custody.assertPinned(); signal?.throwIfAborted();
      const receiptSha256 = hash('ltds-derivative-supplement-verification-v1', receipt);
      returned = true;
      return { supplementSha256: parsed.supplementSha256, verificationReceipt: receipt, verificationReceiptSha256: receiptSha256,
        register(args) {
          if (released) fail('supplement_custody_released');
          if (typeof args.assertLease !== 'function') fail('supplement_custody_unqualified');
          args.assertLease(); custody.assertPinned({ assertCurrent: args.assertLease });
          return custody.register({ ...args, manifest: parsed.manifest, receipt, receiptSha256 });
        }, dispose: release };
    } finally {
      if (!returned) {
        try { release(); }
        catch {
          // Preserve the verification error, but retain a separate cleanup
          // incident. Never log a thrown private path or producer payload.
          try { processing.insertAudit({ actorType: 'system', action: 'derivative_recovery.cleanup_failed',
            entityType: 'derivative_recovery', entityId: operation.id, details: { code: 'supplement_release_failed' } }); }
          catch { console.error('[derivative-supplement] cleanup audit unavailable'); }
        }
      }
    }
  };
}

module.exports = { MAX_FILES, MAX_BYTES, relative, inventory, canonicalSupplement, expectedIdentity, createSupplementQualifier };
