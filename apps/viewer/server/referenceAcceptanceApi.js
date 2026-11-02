'use strict';

const protocol = require('./referenceProtocol');
const { verifyServiceRequest, verifyServiceRequestDigest } = require('./serviceAuth');

const PATH = '/api/v1/reference/v1/acceptances';
const TREEDAR_PATH = '/api/v1/reference/v2/acceptances';
const ACCEPTANCE_PATHS = Object.freeze([{ path: PATH, schemaVersion: 1 }, { path: TREEDAR_PATH, schemaVersion: 2 }]);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
function referenceAcceptanceJsonBodyType(req) {
  const binaryReferencePath = req.method === 'PUT'
    && /^\/api\/v1\/reference\/v[12]\/acceptances\/[^/]+\/objects\/[^/]+\/?$/i.test(req.path || '');
  if (binaryReferencePath) return false;
  return Boolean(req.is('application/json'));
}
function exactKeys(value, names) {
  return value && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === names.length
    && names.every(name => Object.hasOwn(value, name));
}
function safeError(error) {
  const code = error?.code || 'acceptance_unavailable';
  if (['INVALID_ACCEPTANCE_REQUEST', 'INVALID_IDENTIFIER', 'INVALID_PROTOCOL', 'METADATA_LIMIT',
    'UNSAFE_STORAGE_PATH', 'INVALID_TRANSFER_CHUNK', 'TRANSFER_CHUNK_SIZE'].includes(code)) return [400, code];
  if (['BINDING_MISMATCH', 'DIGEST_MISMATCH', 'STORAGE_DIGEST_MISMATCH', 'STORAGE_OBJECT_CHANGED',
    'ACCEPTANCE_CONFLICT', 'ACCEPTANCE_RESERVATION_CONFLICT', 'GENERATION_CONFLICT',
    'INVALID_ACCEPTED_CLOSURE', 'UNSAFE_STORAGE_OBJECT', 'TRANSFER_CHUNK_DIGEST',
    'TRANSFER_CHUNK_CONFLICT', 'TRANSFER_OFFSET_MISMATCH', 'TRANSFER_INCOMPLETE',
    'INVALID_TRANSFER_OBJECT', 'TRANSFER_STATE_CHANGED'].includes(code)) return [409, code];
  if (code === 'UNKNOWN_TRANSFER') return [404, 'acceptance_not_found'];
  if (code === 'STORAGE_QUOTA_EXCEEDED') return [507, code];
  return [503, 'acceptance_unavailable'];
}
function publicStatus(record) {
  const acceptedObjectIds = record.acceptance.acceptedObjectIds;
  const manifestObjectIds = record.storage.resultManifest.objects.map(object => object.id);
  return {
    receiptId: record.acceptance.receiptId,
    state: 'accepted',
    acceptedObjectIds,
    fullyAccepted: manifestObjectIds.every(id => acceptedObjectIds.includes(id)),
    acceptance: record.acceptance,
    viewerReceipt: record.storage.viewerReceipt,
  };
}
function publicTransfer(transfer) {
  return {
    receiptId: transfer.receiptId,
    state: transfer.state,
    jobId: transfer.expected.jobId,
    generation: transfer.expected.generation,
    environment: transfer.expected.environment,
    inputManifestSha256: transfer.expected.inputManifestSha256,
    resultManifestSha256: transfer.expected.resultManifestSha256,
    acceptedObjectIds: transfer.acceptance.acceptedObjectIds,
    objects: transfer.objects.map(({ objectId, expectedBytes, expectedSha256, receivedBytes, state }) => ({
      objectId, expectedBytes, expectedSha256, receivedBytes, state,
    })),
  };
}

function createReferenceAcceptanceApi({ repository, ledger, serviceKeyId, serviceAuthKeys, receiptSigner, environment, chunkBytes = 16 * 1024 * 1024, routerFactory = () => require('express').Router() }) {
  if (!repository || typeof repository.consumeServiceNonce !== 'function'
      || !ledger || typeof ledger.reserveTransfer !== 'function' || typeof ledger.stageObjectChunk !== 'function'
      || typeof ledger.commitTransfer !== 'function' || typeof ledger.getVerified !== 'function'
      || typeof ledger.getTransfer !== 'function' || typeof serviceKeyId !== 'string' || !serviceAuthKeys?.[serviceKeyId]
      || typeof receiptSigner !== 'function'
      || !['staging', 'production'].includes(environment) || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1) fail('REFERENCE_ACCEPTANCE_CONFIG_INVALID');

  const router = routerFactory();
  let activeUploads = 0;
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Binary transfers use signed chunk digests and are bounded before reading.
  // The ledger compares the digest to the actual chunk bytes before writing.
  for (const { path: basePath, schemaVersion } of ACCEPTANCE_PATHS) router.put(`${basePath}/:receiptId/objects/:objectId`, async (req, res) => {
    try {
      if (req.get('Content-Type') !== 'application/octet-stream') return res.status(415).json({ error: 'application/octet-stream required', code: 'invalid_content_type' });
      const suppliedDigest = req.get('X-LTDS-Content-SHA256');
      const checked = verifyServiceRequestDigest({
        headers: req.headers, method: req.method, path: req.originalUrl,
        bodySha256: suppliedDigest, repository, keys: serviceAuthKeys,
      });
      if (!checked.ok) return res.status(401).json({ error: 'service authentication failed' });
      if (checked.keyId !== serviceKeyId) return res.status(403).json({ error: 'reference acceptance service required' });
      req.servicePrincipal = { keyId: checked.keyId };
      const lengthText = req.get('Content-Length');
      if (!/^\d{1,10}$/.test(lengthText || '')) return res.status(411).json({ error: 'content length required', code: 'content_length_required' });
      const contentLength = Number(lengthText);
      if (!Number.isSafeInteger(contentLength) || contentLength > chunkBytes) return res.status(413).json({ error: 'transfer chunk too large', code: 'transfer_chunk_too_large' });
      const offsetText = req.query.offset;
      if (typeof offsetText !== 'string' || !/^\d{1,16}$/.test(offsetText)) return res.status(400).json({ error: 'invalid transfer offset', code: 'invalid_transfer_offset' });
      // A chunk is held in memory for digest verification. Reject excess
      // concurrent streams before allocating that buffer; callers retry safely.
      if (activeUploads >= 2) return res.status(503).json({ error: 'transfer busy; retry the chunk', code: 'transfer_busy' });
      activeUploads++;
      let result;
      try {
        result = await ledger.stageObjectChunk({
          receiptId: req.params.receiptId,
          objectId: req.params.objectId,
          offset: Number(offsetText),
          contentLength,
          declaredSha256: suppliedDigest,
          source: req,
          maxChunkBytes: chunkBytes,
          schemaVersion,
        });
      } finally { activeUploads--; }
      // A completed object chunk is not a job acceptance. Only /commit can
      // issue the signed accepted-copy receipt after every declared object verifies.
      return res.json({ ...result, state: result.complete ? 'object_complete' : 'receiving' });
    } catch (error) {
      const [status, code] = safeError(error);
      return res.status(status).json({ error: status < 500 ? code : 'acceptance unavailable', code });
    }
  });

  function authenticateJson(req, res, next) {
    const checked = verifyServiceRequest({
      headers: req.headers, method: req.method, path: req.originalUrl,
      rawBody: req.rawBody || Buffer.alloc(0), repository, keys: serviceAuthKeys,
    });
    if (!checked.ok) return res.status(401).json({ error: 'service authentication failed' });
    if (checked.keyId !== serviceKeyId) return res.status(403).json({ error: 'reference acceptance service required' });
    req.servicePrincipal = { keyId: checked.keyId };
    return next();
  }
  router.use(authenticateJson);

  for (const { path: basePath, schemaVersion } of ACCEPTANCE_PATHS) router.put(`${basePath}/:receiptId`, (req, res) => {
    try {
      const body = req.body;
      if (!exactKeys(body, ['inputManifest', 'expected', 'resultManifest', 'acceptance'])) fail('INVALID_ACCEPTANCE_REQUEST');
      if (!exactKeys(body.expected, ['jobId', 'generation', 'environment', 'inputManifestSha256', 'pipelineDigest', 'resultManifestSha256', 'objectIds'])) fail('INVALID_ACCEPTANCE_REQUEST');
      const { inputManifest, expected, resultManifest, acceptance } = body;
      if (req.params.receiptId !== acceptance?.receiptId || expected.environment !== environment) fail('BINDING_MISMATCH');
      protocol.validateManifest(inputManifest);
      if (protocol.manifestSha256(inputManifest) !== expected.inputManifestSha256 || inputManifest.sha256 !== expected.inputManifestSha256) fail('BINDING_MISMATCH');
      if (schemaVersion === 1) {
        protocol.validateResultManifest(resultManifest, expected);
        if (Object.keys(resultManifest.engineVersions).length !== 1 || !Object.hasOwn(resultManifest.engineVersions, 'odm')) fail('INVALID_PROTOCOL');
      } else {
        protocol.validateTreeDarResultManifest(resultManifest, expected);
        if (JSON.stringify(acceptance.acceptedObjectIds) !== JSON.stringify(resultManifest.objects.map(object => object.id))) fail('INVALID_ACCEPTED_CLOSURE');
      }
      protocol.validateAcceptance(acceptance, expected);
      const transfer = ledger.reserveTransfer({ inputManifest, expected, resultManifest, acceptance });
      return res.status(202).json(publicTransfer(transfer));
    } catch (error) {
      const [status, code] = safeError(error);
      return res.status(status).json({ error: status < 500 ? code : 'acceptance unavailable', code });
    }
  });

  for (const { path: basePath, schemaVersion } of ACCEPTANCE_PATHS) router.post(`${basePath}/:receiptId/commit`, (req, res) => {
    try {
      if (req.rawBody?.length) fail('INVALID_ACCEPTANCE_REQUEST');
      const existing = ledger.getVerified(req.params.receiptId);
      if (existing && existing.storage.resultManifest.schemaVersion !== schemaVersion) fail('UNKNOWN_TRANSFER');
      if (existing && !existing.storage.viewerReceipt) fail('VIEWER_RECEIPT_MISSING');
      const pending = existing ? null : ledger.getTransfer(req.params.receiptId);
      if (!existing && (!pending || pending.resultManifestSchemaVersion !== schemaVersion)) fail('UNKNOWN_TRANSFER');
      const record = ledger.commitTransfer(req.params.receiptId, receiptSigner, { schemaVersion });
      const verified = existing || ledger.getVerified(req.params.receiptId);
      if (!verified || !verified.storage.viewerReceipt || verified.acceptance.receiptId !== record.acceptance.receiptId) fail('ACCEPTANCE_CONFLICT');
      return res.status(existing ? 200 : 201).json(publicStatus(verified));
    } catch (error) {
      const [status, code] = safeError(error);
      return res.status(status).json({ error: status < 500 ? code : 'acceptance unavailable', code });
    }
  });

  for (const { path: basePath, schemaVersion } of ACCEPTANCE_PATHS) router.get(`${basePath}/:receiptId`, (req, res) => {
    try {
      const accepted = ledger.getVerified(req.params.receiptId);
      if (accepted) {
        if (accepted.storage.resultManifest.schemaVersion !== schemaVersion) fail('UNKNOWN_TRANSFER');
        if (!accepted.storage.viewerReceipt) fail('VIEWER_RECEIPT_MISSING');
        return res.json(publicStatus(accepted));
      }
      const transfer = ledger.getTransfer(req.params.receiptId);
      if (transfer && transfer.resultManifestSchemaVersion !== schemaVersion) fail('UNKNOWN_TRANSFER');
      return transfer ? res.status(202).json(publicTransfer(transfer)) : res.status(404).json({ error: 'acceptance not found', code: 'acceptance_not_found' });
    } catch (error) {
      const [status, code] = safeError(error);
      return res.status(status).json({ error: status < 500 ? code : 'acceptance unavailable', code });
    }
  });

  return router;
}

module.exports = { PATH, TREEDAR_PATH, createReferenceAcceptanceApi, referenceAcceptanceJsonBodyType };
