'use strict';

// Default-off runtime composition for the resumable source-range candidate.
// This mounts only the byte-serving plane; the reference dispatcher remains
// separately gated until its durable scheduling and grant-delivery lane is
// reviewed and enabled.
const fs = require('node:fs');
const path = require('node:path');
const { HEADER_NAME, constantTimeSecretEqual } = require('./proxyGate');
const { SourceRangeV2BrokerCandidate, createSourceRangeV2Handler, deriveSourceRangeGrantTokenKey } = require('./sourceRangeV2Candidate');
const { resolveSourceRangeV2Candidate } = require('./sourceRangeV2ResolverCandidate');
const { ReferenceTransferGrantVault, deriveReferenceTransferGrantKey } = require('./referenceTransferGrantVault');
const { ReferenceTransferOutbox } = require('./referenceTransferOutbox');
const { createSourceRangeV2TransferDispatcher } = require('./sourceRangeV2TransferDispatcher');

function fail(code) { throw Object.assign(new Error(code), { code }); }

function assertNoSymlinkPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  let cursor = path.parse(value).root;
  for (const segment of path.relative(cursor, value).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    let stat;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if (error.code === 'ENOENT') continue;
      fail('SOURCE_RANGE_STATE_UNAVAILABLE');
    }
    if (stat.isSymbolicLink()) fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  }
}

function ensurePrivateStateDirectory(dataDir) {
  assertNoSymlinkPath(dataDir);
  const directory = path.join(dataDir, 'source-range-v2');
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') fail('SOURCE_RANGE_STATE_UNAVAILABLE'); }
  let stat;
  try { stat = fs.lstatSync(directory); } catch { fail('SOURCE_RANGE_STATE_UNAVAILABLE'); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  if (process.platform !== 'win32' && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0))
    fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  return fs.realpathSync(directory);
}

function createSourceRangeV2RuntimeCandidate({ config, database, storage } = {}) {
  if (!config || typeof config.processingSourceRangeV2Enabled !== 'boolean') fail('SOURCE_RANGE_CONFIGURATION_INVALID');
  if (!config.processingSourceRangeV2Enabled) return null;
  if (config.processingPlatformEnabled !== true || !database?.prepare || !storage?.resolve
      || typeof config.dataDir !== 'string' || typeof config.datasetsMount !== 'string') fail('SOURCE_RANGE_CONFIGURATION_INVALID');
  if (typeof config.processingSourceRangeGrantSecret !== 'string' || Buffer.byteLength(config.processingSourceRangeGrantSecret) < 32)
    fail('SOURCE_RANGE_GRANT_KEY_CONFIGURATION_INVALID');
  if (config.production && (!config.trustedProxyAllowlist?.entries?.length
      || typeof config.proxySharedSecret !== 'string' || !config.proxySharedSecret
      || !Number.isSafeInteger(config.trustProxyHops) || config.trustProxyHops < 1)) fail('SOURCE_RANGE_TRANSPORT_CONFIGURATION_INVALID');

  const privateDirectory = ensurePrivateStateDirectory(config.dataDir);
  let broker, grantTokenKey;
  try {
    grantTokenKey = deriveSourceRangeGrantTokenKey(config.processingSourceRangeGrantSecret);
    broker = new SourceRangeV2BrokerCandidate({
      databasePath: path.join(privateDirectory, 'broker.sqlite'),
      managedRoot: config.datasetsMount,
      grantTokenKey,
      allowCreate: true,
    });
  } catch {
    fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  } finally {
    grantTokenKey?.fill(0);
  }

  const handler = createSourceRangeV2Handler({
    broker,
    enabled: true,
    isProtectedTransport: req => {
      if (config.production) {
        return req.secure === true
          && config.trustedProxyAllowlist.allows(req.socket?.remoteAddress)
          && constantTimeSecretEqual(config.proxySharedSecret, req.get?.(HEADER_NAME));
      }
      return req.socket?.encrypted === true;
    },
  });
  let grantVault, grantVaultKey;
  try {
    grantVaultKey = deriveReferenceTransferGrantKey(config.processingSourceRangeGrantSecret);
    grantVault = new ReferenceTransferGrantVault(database, { key: grantVaultKey });
    grantVault.validateActive();
  } catch {
    try { broker.close(); } catch {}
    try { grantVault?.close(); } catch {}
    fail('SOURCE_RANGE_STATE_UNAVAILABLE');
  } finally {
    grantVaultKey?.fill(0);
  }
  const runtime = {
    handler,
    grantVault,
    createTransferOutbox(journal) { return new ReferenceTransferOutbox(database, { journal, grantVault }); },
    // Kept in-process for the eventual journaled dispatcher integration; no
    // public grant-minting route is exposed by this candidate.
    mintGrant(job) {
      return broker.mintGrant({
        job,
        resolveSource: binding => resolveSourceRangeV2Candidate({ database, storage, job: { ...job, ...binding } }),
      });
    },
    close() { try { broker.close(); } finally { grantVault.close(); } },
  };
  runtime.createTransferDispatcher = journal => createSourceRangeV2TransferDispatcher({
    runtime, journal, outbox: runtime.createTransferOutbox(journal),
  });
  return runtime;
}

function sourceRangeV2Middleware(handler) {
  if (typeof handler !== 'function') throw new TypeError('source range handler is required');
  return (req, res, next) => {
    Promise.resolve().then(() => handler(req, res)).then(handled => {
      if (!handled) next();
    }, next);
  };
}

module.exports = { assertNoSymlinkPath, createSourceRangeV2RuntimeCandidate, ensurePrivateStateDirectory, sourceRangeV2Middleware };
