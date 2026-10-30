'use strict';

// Pure metadata validation only. An authenticated issuer must enforce real NAS
// retention against every purge path (or retain an immutable managed copy).
// Global receipt-role uniqueness and durable worker/outbox authorization after
// execution ends belong to the future persistence/API layer, not this validator.
const protocol = require('./referenceProtocol');
const { TextDecoder } = require('node:util');
const VALIDATION_VERSION = 'ltds-source-retention-v1';
const RETENTION_GUARANTEE = 'until_release_ack_v1';
const FIELDS = ['schemaVersion', 'receiptType', 'receiptId', 'storageReceiptId', 'jobId',
  'generation', 'environment', 'inputManifestSha256', 'pipelineDigest',
  'retainedObjectIds', 'retainedAt', 'validationVersion', 'retentionGuarantee'];
function fail(path) { throw new protocol.ReferenceProtocolError('INVALID_SOURCE_RETENTION', path); }
function id(value, path) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail(path); }
function integer(value, path) { if (!Number.isSafeInteger(value) || value < 1) fail(path); }
function hash(value, path) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail(path); }
function environment(value) { if (!['staging', 'production'].includes(value)) fail('environment'); }

// JSON.parse alone discards duplicate keys. Parse bounded wire input while
// retaining key identity, including escaped spellings such as schema\u0056ersion.
function decodeReceipt(wire) {
  if (Buffer.byteLength(wire) > protocol.LIMITS.metadataBytes) fail('metadata.limit');
  let source;
  try { source = typeof wire === 'string' ? wire : new TextDecoder('utf-8', { fatal: true }).decode(wire); }
  catch { fail('metadata.utf8'); }
  let index = 0;
  const token = /[\x20\t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null|[{}\[\],:])/y;
  function next() {
    token.lastIndex = index; const match = token.exec(source);
    if (!match) fail('metadata.json'); index = token.lastIndex; return match[1];
  }
  function value(first, depth) {
    if (depth > 32) fail('metadata.depth');
    if (first === '{') {
      const result = {}, keys = new Set(); let key = next();
      if (key === '}') return result;
      while (true) {
        if (key[0] !== '"') fail('metadata.key');
        key = JSON.parse(key); if (keys.has(key)) fail('metadata.duplicateKey'); keys.add(key);
        if (next() !== ':') fail('metadata.json');
        Object.defineProperty(result, key, { value: value(next(), depth + 1), enumerable: true, writable: true, configurable: true });
        const separator = next(); if (separator === '}') return result;
        if (separator !== ',') fail('metadata.json'); key = next();
      }
    }
    if (first === '[') {
      const result = []; let item = next(); if (item === ']') return result;
      while (true) {
        if (result.length >= protocol.LIMITS.objects) fail('metadata.array');
        result.push(value(item, depth + 1)); const separator = next();
        if (separator === ']') return result;
        if (separator !== ',') fail('metadata.json'); item = next();
      }
    }
    // These receipts contain integer fields only. Preserve Python's distinction
    // between JSON integers and 1.0/1e0 rather than silently coercing the latter.
    if (/^-?\d/.test(first) && !/^(?:0|[1-9]\d*)$/.test(first)) fail('metadata.integer');
    try { return JSON.parse(first); } catch { fail('metadata.json'); }
  }
  const result = value(next(), 0);
  if (!/^[\x20\t\r\n]*$/.test(source.slice(index))) fail('metadata.trailing');
  return result;
}

function validateSourceRetention(payload, expected) {
  if (typeof payload === 'string' || Buffer.isBuffer(payload)) payload = decodeReceipt(payload);
  if (!payload || Object.getPrototypeOf(payload) !== Object.prototype || Object.keys(payload).length !== FIELDS.length || FIELDS.some(key => !Object.hasOwn(payload, key))) fail('receipt.fields');
  if (protocol.canonicalBytes(payload).length > protocol.LIMITS.metadataBytes) fail('metadata.limit');
  if (payload.schemaVersion !== 1 || payload.receiptType !== 'source_retention' || payload.validationVersion !== VALIDATION_VERSION || payload.retentionGuarantee !== RETENTION_GUARANTEE) fail('receipt.versionOrGuarantee');
  for (const key of ['receiptId', 'storageReceiptId', 'jobId']) id(payload[key], key);
  if (payload.receiptId === payload.storageReceiptId) fail('receipt.roles');
  if (!expected) fail('expected');
  id(expected.jobId, 'expected.jobId'); integer(expected.generation, 'expected.generation'); environment(expected.environment); hash(expected.pipelineDigest, 'expected.pipelineDigest');
  integer(payload.generation, 'generation'); environment(payload.environment);
  hash(payload.pipelineDigest, 'pipelineDigest'); hash(payload.inputManifestSha256, 'inputManifestSha256');
  for (const key of ['jobId', 'generation', 'environment', 'pipelineDigest']) if (payload[key] !== expected[key]) fail('binding.' + key);
  const manifest = protocol.validateManifest(expected.inputManifest);
  if (!manifest.objects.length || payload.inputManifestSha256 !== manifest.sha256) fail('binding.inputManifest');
  const ids = manifest.objects.map(object => object.id).sort(); // ASCII, never localeCompare.
  const retained = payload.retainedObjectIds;
  if (!Array.isArray(retained) || retained.length !== ids.length) fail('retainedObjectIds');
  retained.forEach((value, index) => { id(value, 'retainedObjectIds'); if (value !== ids[index]) fail('retainedObjectIds.closure'); });
  const timestamp = payload.retainedAt;
  if (typeof timestamp !== 'string' || !/^(?!0000)\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) fail('retainedAt');
  return structuredClone(payload);
}

module.exports = { VALIDATION_VERSION, RETENTION_GUARANTEE, validateSourceRetention, decodeReceipt };
