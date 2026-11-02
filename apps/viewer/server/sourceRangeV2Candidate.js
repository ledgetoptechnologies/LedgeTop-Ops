'use strict';

// Isolated candidate only. This broker and handler are intentionally not mounted
// by the Viewer runtime. A future integration must inject a trusted resolver that
// binds every object path to the active job, manifest and immutable source version.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { createHash, createHmac, hkdfSync, randomUUID, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Readable } = require('node:stream');
const protocol = require('./referenceProtocol');

const CHUNK_BYTES = 8 * 1024 * 1024;
const PREFIX = '/api/processing/source-range/v2/objects/';
const REQUEST_HEADER = 'x-processing-request-id';
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const PRIVATE_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const DB_SCHEMA = [
  `CREATE TABLE source_range_usage (identity_key TEXT PRIMARY KEY, identity_json TEXT NOT NULL, transfer_json TEXT NOT NULL, objects_json TEXT NOT NULL, request_budget INTEGER NOT NULL, byte_budget INTEGER NOT NULL, attempt_budget INTEGER NOT NULL, requests_used INTEGER NOT NULL DEFAULT 0, bytes_used INTEGER NOT NULL DEFAULT 0, attempts_used INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE source_range_objects (identity_key TEXT NOT NULL, object_id TEXT NOT NULL, source_path TEXT NOT NULL, byte_size INTEGER NOT NULL, object_sha256 TEXT NOT NULL, PRIMARY KEY(identity_key, object_id))`,
  `CREATE TABLE source_range_grants (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, token_hash TEXT NOT NULL, expires_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`,
  `CREATE INDEX source_range_grants_token ON source_range_grants(token_hash)`,
  `CREATE TABLE source_range_requests (identity_key TEXT NOT NULL, object_id TEXT NOT NULL, request_id TEXT NOT NULL, start_byte INTEGER NOT NULL, byte_length INTEGER NOT NULL, PRIMARY KEY(identity_key, object_id, request_id), UNIQUE(identity_key, object_id, start_byte))`,
];

class SourceRangeV2Error extends Error {
  constructor(code) { super(code); this.name = 'SourceRangeV2Error'; this.code = code; }
}
const fail = code => { throw new SourceRangeV2Error(code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');
function deriveSourceRangeGrantTokenKey(grantSecret) {
  if (typeof grantSecret !== 'string' || Buffer.byteLength(grantSecret) < 32) fail('GRANT_TOKEN_KEY_UNAVAILABLE');
  return Buffer.from(hkdfSync('sha256', Buffer.from(grantSecret, 'utf8'), Buffer.from('ledgetop-viewer-source-range-v2'), Buffer.from('source-range-grant-token-hmac-v1'), 32));
}
function tokenForGrant(key, identityJson, grantId) {
  if (!Buffer.isBuffer(key) || key.length !== 32 || typeof grantId !== 'string' || !ID.test(grantId)) fail('GRANT_TOKEN_KEY_UNAVAILABLE');
  return createHmac('sha256', key).update('LTDS-SOURCE-RANGE-GRANT-V1\0').update(identityJson).update('\0').update(grantId).digest('base64url');
}
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => keys.includes(key));
const slug = value => typeof value === 'string' && ID.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const usageFields = ['identity_key', 'identity_json', 'transfer_json', 'objects_json', 'request_budget', 'byte_budget', 'attempt_budget', 'requests_used', 'bytes_used', 'attempts_used'];
const tables = ['source_range_usage', 'source_range_objects', 'source_range_grants', 'source_range_requests'];
function identityFor(job, transfer) {
  return {
    environment: job.environment,
    generation: job.generation,
    jobId: job.jobId,
    manifestSha256: job.manifestSha256,
    reservationId: transfer.reservationId,
    sourceVersion: transfer.sourceVersion,
  };
}
function canonicalIdentity(identity) {
  // Matches Python json.dumps(identity, sort_keys=True, separators=(',', ':')).
  return JSON.stringify({
    environment: identity.environment,
    generation: identity.generation,
    jobId: identity.jobId,
    manifestSha256: identity.manifestSha256,
    reservationId: identity.reservationId,
    sourceVersion: identity.sourceVersion,
  });
}
function requestIdFor(identityJson, object, start, length) {
  return sha256(Buffer.from(JSON.stringify([identityJson, object.id, object.byteSize, object.sha256, start, length]), 'utf8'));
}
function expectedChunk(object, start, end) {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= object.byteSize
    || start % CHUNK_BYTES !== 0
    || BigInt(end) !== (BigInt(start) + BigInt(CHUNK_BYTES) < BigInt(object.byteSize) ? BigInt(start) + BigInt(CHUNK_BYTES) : BigInt(object.byteSize)) - 1n) fail('INVALID_RANGE');
  return end - start + 1;
}
function canonicalTransfer(job) {
  const transfer = job?.transferRequest;
  const keys = ['protocol', 'reservationId', 'generation', 'expiresAt', 'manifestSha256', 'sourceVersion', 'objectIds', 'chunkBytes', 'requestBudget', 'byteBudget', 'nonce', 'attemptBudget'];
  if (!exact(transfer, keys) || transfer.protocol !== 'source-range-v2' || !slug(transfer.reservationId) || !slug(transfer.nonce)
    || !Number.isSafeInteger(transfer.generation) || transfer.generation < 1 || !timestamp(transfer.expiresAt)
    || !HASH.test(transfer.manifestSha256) || typeof transfer.sourceVersion !== 'string'
    || !/^[\x21-\x7e]{1,256}$/.test(transfer.sourceVersion) || transfer.chunkBytes !== CHUNK_BYTES
    || !Array.isArray(transfer.objectIds) || transfer.objectIds.length > protocol.LIMITS.objects
    || transfer.objectIds.some(id => !slug(id)) || new Set(transfer.objectIds).size !== transfer.objectIds.length
    || !['requestBudget', 'byteBudget', 'attemptBudget'].every(key => Number.isSafeInteger(transfer[key]) && transfer[key] > 0)) fail('INVALID_TRANSFER_REQUEST');
  return transfer;
}

class SourceRangeV2BrokerCandidate {
  constructor({ databasePath, managedRoot, grantTokenKey, now = Date.now, maxGrantTtlMs = 300000, allowCreate = false } = {}) {
    if (typeof databasePath !== 'string' || !path.isAbsolute(databasePath) || databasePath === ':memory:') fail('DURABLE_DATABASE_REQUIRED');
    if (!Number.isSafeInteger(maxGrantTtlMs) || maxGrantTtlMs < 1000 || maxGrantTtlMs > 3600000 || typeof now !== 'function') fail('INVALID_CONFIGURATION');
    if (typeof managedRoot !== 'string' || !path.isAbsolute(managedRoot)) fail('UNSAFE_SOURCE');
    this.root = fs.realpathSync(managedRoot);
    if (!fs.statSync(this.root).isDirectory()) fail('UNSAFE_SOURCE');
    this.databasePath = databasePath;
    this.now = now;
    this.maxGrantTtlMs = maxGrantTtlMs;
    this.grantTokenKey = Buffer.isBuffer(grantTokenKey) && grantTokenKey.length === 32 ? Buffer.from(grantTokenKey) : null;
    this.streams = new Set();
    const fresh = !fs.existsSync(databasePath);
    if (fresh && allowCreate !== true) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    const parentPath = path.dirname(databasePath), parentInfo = fs.statSync(parentPath);
    let cursor = path.parse(parentPath).root;
    for (const segment of path.relative(cursor, parentPath).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    }
    if (process.platform !== 'win32' && (parentInfo.uid !== process.getuid() || (parentInfo.mode & 0o077) !== 0)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    if (!fresh && fs.lstatSync(databasePath).isSymbolicLink()) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    if (fresh) {
      const fd = fs.openSync(databasePath, 'wx', 0o600);
      fs.closeSync(fd);
    }
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
      if (fresh) this.db.exec(DB_SCHEMA.join(';') + ';');
      else this.#inspect();
      if (process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
    } catch (error) {
      this.db.close();
      this.grantTokenKey?.fill(0);
      if (error instanceof SourceRangeV2Error) throw error;
      fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    }
  }

  #inspect() {
    const actual = this.db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    const expected = DB_SCHEMA.map(sql => {
      const match = /^CREATE (TABLE|INDEX) ([^( ]+)/.exec(sql);
      return { type: match[1].toLowerCase(), name: match[2], sql };
    }).sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
    if (actual.length !== expected.length || actual.some((row, index) => row.type !== expected[index].type || row.name !== expected[index].name || row.sql !== expected[index].sql)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    const use = this.db.prepare('SELECT * FROM source_range_usage LIMIT 10001').all();
    const grants = this.db.prepare('SELECT * FROM source_range_grants LIMIT 10001').all();
    const objects = this.db.prepare('SELECT * FROM source_range_objects LIMIT 100001').all();
    const ranges = this.db.prepare('SELECT * FROM source_range_requests LIMIT 100001').all();
    if (use.length > 10000 || grants.length > 10000 || objects.length > 100000 || ranges.length > 100000) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    const useMap = new Map();
    for (const row of use) {
      if (Object.keys(row).join(',') !== usageFields.join(',') || !HASH.test(row.identity_key) || sha256(row.identity_json) !== row.identity_key
        || !Number.isSafeInteger(row.request_budget) || !Number.isSafeInteger(row.byte_budget) || !Number.isSafeInteger(row.attempt_budget)
        || !Number.isSafeInteger(row.requests_used) || !Number.isSafeInteger(row.bytes_used) || !Number.isSafeInteger(row.attempts_used)
        || row.requests_used < 0 || row.bytes_used < 0 || row.attempts_used < 0 || row.requests_used > row.request_budget
        || row.bytes_used > row.byte_budget || row.attempts_used > row.attempt_budget) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      let transfer, objectList;
      try { transfer = JSON.parse(row.transfer_json); objectList = JSON.parse(row.objects_json); } catch { fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
      if (!exact(transfer, ['protocol', 'reservationId', 'generation', 'expiresAt', 'manifestSha256', 'sourceVersion', 'objectIds', 'chunkBytes', 'requestBudget', 'byteBudget', 'nonce', 'attemptBudget'])
        || transfer.protocol !== 'source-range-v2' || !Array.isArray(objectList) || JSON.stringify(objectList) !== row.objects_json
        || !Array.isArray(transfer.objectIds) || transfer.requestBudget !== row.request_budget || transfer.byteBudget !== row.byte_budget
        || transfer.attemptBudget !== row.attempt_budget || transfer.chunkBytes !== CHUNK_BYTES || !slug(transfer.reservationId)
        || !slug(transfer.nonce) || !Number.isSafeInteger(transfer.generation) || transfer.generation < 1
        || !timestamp(transfer.expiresAt) || !HASH.test(transfer.manifestSha256) || typeof transfer.sourceVersion !== 'string'
        || !/^[\x21-\x7e]{1,256}$/.test(transfer.sourceVersion) || !Number.isSafeInteger(transfer.requestBudget)
        || !Number.isSafeInteger(transfer.byteBudget) || !Number.isSafeInteger(transfer.attemptBudget)
        || transfer.requestBudget < 1 || transfer.byteBudget < 1 || transfer.attemptBudget < 1) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      let identity;
      try { identity = JSON.parse(row.identity_json); } catch { fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
      if (!exact(identity, ['environment', 'generation', 'jobId', 'manifestSha256', 'reservationId', 'sourceVersion'])
        || canonicalIdentity(identity) !== row.identity_json || identity.reservationId !== transfer.reservationId
        || identity.generation !== transfer.generation || identity.manifestSha256 !== transfer.manifestSha256
        || identity.sourceVersion !== transfer.sourceVersion || !['staging', 'production'].includes(identity.environment)
        || !slug(identity.jobId) || !slug(identity.reservationId) || !HASH.test(identity.manifestSha256)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      useMap.set(row.identity_key, { row, transfer, identity, objectList, requestCount: 0, requestedBytes: 0 });
    }
    const objectMap = new Map();
    for (const row of objects) {
      const parent = useMap.get(row.identity_key);
      if (!parent || typeof row.object_id !== 'string' || !slug(row.object_id) || typeof row.source_path !== 'string'
        || !Number.isSafeInteger(row.byte_size) || row.byte_size < 0 || !HASH.test(row.object_sha256)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const identity = parent.identity;
      const expected = parent.objectList.find(object => object.id === row.object_id);
      if (!expected || expected.byteSize !== row.byte_size || expected.sha256 !== row.object_sha256 || !parent.transfer.objectIds.includes(row.object_id)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      try { this.#source(row.source_path); } catch { fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
      objectMap.set(`${row.identity_key}:${row.object_id}`, { ...row, parent });
    }
    for (const parent of useMap.values()) {
      if (parent.objectList.length !== parent.transfer.objectIds.length
        || parent.objectList.some(object => !object || !slug(object.id) || !Number.isSafeInteger(object.byteSize) || object.byteSize < 0 || !HASH.test(object.sha256)
          || !parent.transfer.objectIds.includes(object.id) || !objectMap.has(`${parent.row.identity_key}:${object.id}`))
        || parent.objectList.reduce((sum, object) => sum + object.byteSize, 0) > parent.transfer.byteBudget) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    }
    const requestIds = new Set();
    for (const row of ranges) {
      const parent = useMap.get(row.identity_key), object = objectMap.get(`${row.identity_key}:${row.object_id}`);
      if (!parent || !object || typeof row.request_id !== 'string' || !HASH.test(row.request_id)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      let length;
      try { length = expectedChunk({ id: row.object_id, byteSize: object.byte_size, sha256: object.object_sha256 }, row.start_byte, row.start_byte + row.byte_length - 1); }
      catch { fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
      const expectedId = requestIdFor(parent.row.identity_json, { id: row.object_id, byteSize: object.byte_size, sha256: object.object_sha256 }, row.start_byte, length);
      const unique = `${row.identity_key}:${row.object_id}:${row.request_id}`;
      if (requestIds.has(unique) || row.request_id !== expectedId || row.byte_length !== length) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      requestIds.add(unique); parent.requestCount++; parent.requestedBytes += length;
    }
    for (const parent of useMap.values()) {
      const minimumRequests = parent.objectList.reduce((sum, object) => sum + Math.ceil(object.byteSize / CHUNK_BYTES), 0);
      if (parent.requestCount !== parent.row.requests_used || parent.requestedBytes !== parent.row.bytes_used
        || parent.row.request_budget < minimumRequests || parent.row.attempt_budget < minimumRequests) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
    }
    for (const row of grants) {
      if (!useMap.has(row.identity_key) || !HASH.test(row.token_hash) || !Number.isSafeInteger(row.expires_ms)
        || ![0, 1].includes(row.revoked) || !slug(row.id)) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      if (row.revoked === 0 && row.expires_ms > this.now()) {
        const identityJson = useMap.get(row.identity_key).row.identity_json;
        const expectedHash = Buffer.from(sha256(tokenForGrant(this.grantTokenKey, identityJson, row.id)), 'hex');
        const storedHash = Buffer.from(row.token_hash, 'hex');
        if (storedHash.length !== expectedHash.length || !timingSafeEqual(storedHash, expectedHash))
          fail('GRANT_TOKEN_KEY_ROTATION_BLOCKED');
      }
    }
  }

  #tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }

  #source(file) {
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file)) fail('UNSAFE_SOURCE');
      const absolute = path.resolve(file), relative = path.relative(this.root, absolute);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('UNSAFE_SOURCE');
      let cursor = this.root;
      for (const segment of relative.split(path.sep)) { cursor = path.join(cursor, segment); if (fs.lstatSync(cursor).isSymbolicLink()) fail('UNSAFE_SOURCE'); }
      if (fs.realpathSync(absolute) !== absolute || !fs.statSync(absolute).isFile()) fail('UNSAFE_SOURCE');
      return absolute;
    } catch (error) { if (error instanceof SourceRangeV2Error) throw error; fail('SOURCE_UNAVAILABLE'); }
  }

  mintGrant({ job, resolveSource } = {}) {
    if (!this.grantTokenKey) fail('GRANT_TOKEN_KEY_UNAVAILABLE');
    if (typeof resolveSource !== 'function' || !job || typeof job !== 'object' || Array.isArray(job)) fail('SOURCE_RESOLVER_REQUIRED');
    const transfer = canonicalTransfer(job);
    if (!slug(job.jobId) || !['staging', 'production'].includes(job.environment) || !Number.isSafeInteger(job.generation) || job.generation < 1 || !HASH.test(job.manifestSha256)) fail('INVALID_JOB_BINDING');
    if (job.generation !== transfer.generation || job.manifestSha256 !== transfer.manifestSha256) fail('INVALID_JOB_BINDING');
    const manifest = job.submission?.manifest;
    try { protocol.validateManifest(manifest); } catch { fail('INVALID_MANIFEST'); }
    if (manifest.sha256 !== job.manifestSha256) fail('INVALID_MANIFEST');
    const manifestObjects = manifest.objects;
    if (manifestObjects.length !== transfer.objectIds.length || manifestObjects.some(object => !transfer.objectIds.includes(object.id))) fail('INVALID_OBJECT_CLOSURE');
    const minimumRequests = manifestObjects.reduce((sum, object) => sum + Math.ceil(object.byteSize / CHUNK_BYTES), 0);
    if (transfer.byteBudget < manifest.totalBytes || transfer.requestBudget < minimumRequests || transfer.attemptBudget < minimumRequests) fail('INVALID_TRANSFER_BUDGET');
    const identity = identityFor(job, transfer), identityJson = canonicalIdentity(identity), identityKey = sha256(identityJson);
    const transferJson = JSON.stringify(transfer);
    const resolved = resolveSource({
      jobId: job.jobId, generation: job.generation, environment: job.environment,
      manifestSha256: manifest.sha256, sourceVersion: transfer.sourceVersion,
      manifest: structuredClone(manifest),
    });
    const requiredResolverKeys = ['jobId', 'generation', 'environment', 'manifestSha256', 'sourceVersion', 'objects'];
    if (!exact(resolved, requiredResolverKeys) || resolved.jobId !== job.jobId || resolved.generation !== job.generation
      || resolved.environment !== job.environment || resolved.manifestSha256 !== manifest.sha256 || resolved.sourceVersion !== transfer.sourceVersion
      || !Array.isArray(resolved.objects) || resolved.objects.length !== manifestObjects.length) fail('SOURCE_BINDING_MISMATCH');
    const objectById = new Map(manifestObjects.map(object => [object.id, object]));
    const resolvedById = new Map();
    for (const raw of resolved.objects) {
      if (!exact(raw, ['id', 'path', 'byteSize', 'sha256']) || !slug(raw.id) || typeof raw.path !== 'string'
        || !Number.isSafeInteger(raw.byteSize) || raw.byteSize < 0 || !HASH.test(raw.sha256) || resolvedById.has(raw.id)) fail('SOURCE_BINDING_MISMATCH');
      const manifestObject = objectById.get(raw.id);
      if (!manifestObject || raw.byteSize !== manifestObject.byteSize || raw.sha256 !== manifestObject.sha256) fail('SOURCE_BINDING_MISMATCH');
      resolvedById.set(raw.id, { id: raw.id, path: this.#source(raw.path), byteSize: raw.byteSize, sha256: raw.sha256 });
    }
    if (manifestObjects.some(object => !resolvedById.has(object.id))) fail('SOURCE_BINDING_MISMATCH');
    const objectsJson = JSON.stringify(manifestObjects.map(object => ({ id: object.id, byteSize: object.byteSize, sha256: object.sha256 })));
    const now = this.now(), leaseExpiry = Date.parse(transfer.expiresAt);
    if (!Number.isSafeInteger(now) || leaseExpiry <= now) fail('STALE_RESERVATION');
    const expiresMs = Math.min(now + this.maxGrantTtlMs, leaseExpiry);
    const expiresAt = new Date(expiresMs).toISOString();
    const grantId = randomUUID(), token = tokenForGrant(this.grantTokenKey, identityJson, grantId), tokenHash = sha256(token);
    try {
      const issued = this.#tx(() => {
        const old = this.db.prepare('SELECT * FROM source_range_usage WHERE identity_key=?').get(identityKey);
        if (old) {
          if (old.identity_json !== identityJson || old.transfer_json !== transferJson || old.objects_json !== objectsJson
            || old.request_budget !== transfer.requestBudget || old.byte_budget !== transfer.byteBudget || old.attempt_budget !== transfer.attemptBudget) fail('TRANSFER_BINDING_CONFLICT');
          for (const object of resolvedById.values()) {
            const stored = this.db.prepare('SELECT source_path,byte_size,object_sha256 FROM source_range_objects WHERE identity_key=? AND object_id=?').get(identityKey, object.id);
            if (!stored || stored.source_path !== object.path || stored.byte_size !== object.byteSize || stored.object_sha256 !== object.sha256) fail('TRANSFER_BINDING_CONFLICT');
          }
        } else {
          this.db.prepare('INSERT INTO source_range_usage(identity_key,identity_json,transfer_json,objects_json,request_budget,byte_budget,attempt_budget) VALUES(?,?,?,?,?,?,?)')
            .run(identityKey, identityJson, transferJson, objectsJson, transfer.requestBudget, transfer.byteBudget, transfer.attemptBudget);
          const insertObject = this.db.prepare('INSERT INTO source_range_objects(identity_key,object_id,source_path,byte_size,object_sha256) VALUES(?,?,?,?,?)');
          for (const object of resolvedById.values()) insertObject.run(identityKey, object.id, object.path, object.byteSize, object.sha256);
        }
        const active = this.db.prepare('SELECT id,token_hash,expires_ms FROM source_range_grants WHERE identity_key=? AND revoked=0 ORDER BY id LIMIT 2').all(identityKey);
        if (active.length > 1) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
        if (active.length === 1 && active[0].expires_ms > now) {
          const replayToken = tokenForGrant(this.grantTokenKey, identityJson, active[0].id);
          const storedHash = Buffer.from(active[0].token_hash, 'hex'), replayHash = Buffer.from(sha256(replayToken), 'hex');
          if (storedHash.length === replayHash.length && timingSafeEqual(storedHash, replayHash)) {
            return { protocol: 'source-range-v2', reservationId: transfer.reservationId, generation: job.generation,
              expiresAt: new Date(active[0].expires_ms).toISOString(), manifestSha256: manifest.sha256,
              sourceVersion: transfer.sourceVersion, jobId: job.jobId, environment: job.environment,
              objectIds: transfer.objectIds, nonce: transfer.nonce, token: replayToken, chunkBytes: CHUNK_BYTES,
              requestBudget: transfer.requestBudget, byteBudget: transfer.byteBudget, attemptBudget: transfer.attemptBudget };
          }
        }
        // If issuance committed but the caller crashed before persisting its
        // delivery outbox, the id lets us reconstruct the exact bearer. Legacy
        // or expired rows are revoked before issuing a fresh, unique token.
        this.db.prepare('UPDATE source_range_grants SET revoked=1 WHERE identity_key=? AND revoked=0').run(identityKey);
        this.db.prepare('INSERT INTO source_range_grants(id,identity_key,token_hash,expires_ms) VALUES(?,?,?,?)').run(grantId, identityKey, tokenHash, expiresMs);
        return { protocol: 'source-range-v2', reservationId: transfer.reservationId, generation: job.generation,
          expiresAt, manifestSha256: manifest.sha256, sourceVersion: transfer.sourceVersion,
          jobId: job.jobId, environment: job.environment, objectIds: transfer.objectIds,
          nonce: transfer.nonce, token, chunkBytes: CHUNK_BYTES, requestBudget: transfer.requestBudget,
          byteBudget: transfer.byteBudget, attemptBudget: transfer.attemptBudget };
      });
      return structuredClone(issued);
    } catch (error) { if (error instanceof SourceRangeV2Error) throw error; fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
  }

  async readAuthorizedRange({ objectId, authorization, method, range, ifMatch, requestId } = {}) {
    if (method !== 'GET' || !slug(objectId) || typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) fail('INVALID_REQUEST');
    const token = authorization.slice(7);
    if (!PRIVATE_TOKEN.test(token)) fail('UNAUTHORIZED');
    const suppliedTokenHash = Buffer.from(sha256(token), 'hex');
    let grant;
    try {
      const row = this.db.prepare('SELECT g.*,u.identity_json,u.transfer_json,u.objects_json,u.request_budget,u.byte_budget,u.attempt_budget FROM source_range_grants g JOIN source_range_usage u USING(identity_key) WHERE g.token_hash=?').get(suppliedTokenHash.toString('hex'));
      if (!row) fail('UNAUTHORIZED');
      const storedHash = Buffer.from(row.token_hash, 'hex');
      if (storedHash.length !== suppliedTokenHash.length || !timingSafeEqual(storedHash, suppliedTokenHash) || row.revoked || row.expires_ms <= this.now()) fail('UNAUTHORIZED');
      grant = row;
    } catch (error) { if (error instanceof SourceRangeV2Error) throw error; fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
    let transfer;
    try { transfer = JSON.parse(grant.transfer_json); } catch { fail('TRANSFER_ACCOUNTING_UNAVAILABLE'); }
    const object = this.db.prepare('SELECT source_path,byte_size,object_sha256 FROM source_range_objects WHERE identity_key=? AND object_id=?').get(grant.identity_key, objectId);
    if (!object) fail('OBJECT_NOT_GRANTED');
    if (typeof range !== 'string' || !/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)$/.test(range)) fail('INVALID_RANGE');
    const match = /^bytes=(\d+)-(\d+)$/.exec(range), start = Number(match[1]), end = Number(match[2]);
    const item = { id: objectId, byteSize: object.byte_size, sha256: object.object_sha256 };
    const length = expectedChunk(item, start, end);
    const etag = `"sha256-${item.sha256}"`;
    if (ifMatch !== etag) fail('SOURCE_CHANGED');
    const canonicalId = requestIdFor(grant.identity_json, item, start, length);
    if (typeof requestId !== 'string' || !HASH.test(requestId) || requestId !== canonicalId) fail('INVALID_REQUEST_ID');
    const newRange = this.#tx(() => {
      const latest = this.db.prepare('SELECT revoked,expires_ms FROM source_range_grants WHERE id=?').get(grant.id);
      if (!latest || latest.revoked || latest.expires_ms <= this.now()) fail('UNAUTHORIZED');
      const usage = this.db.prepare('SELECT request_budget,byte_budget,attempt_budget,requests_used,bytes_used,attempts_used FROM source_range_usage WHERE identity_key=?').get(grant.identity_key);
      if (!usage) fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const existing = this.db.prepare('SELECT start_byte,byte_length FROM source_range_requests WHERE identity_key=? AND object_id=? AND request_id=?').get(grant.identity_key, objectId, requestId);
      if (existing && (existing.start_byte !== start || existing.byte_length !== length)) fail('REQUEST_ID_CONFLICT');
      if (!existing) {
        if (usage.requests_used + 1 > usage.request_budget || usage.bytes_used + length > usage.byte_budget) fail('TRANSFER_LIMIT');
        this.db.prepare('INSERT INTO source_range_requests(identity_key,object_id,request_id,start_byte,byte_length) VALUES(?,?,?,?,?)').run(grant.identity_key, objectId, requestId, start, length);
        this.db.prepare('UPDATE source_range_usage SET requests_used=requests_used+1,bytes_used=bytes_used+? WHERE identity_key=?').run(length, grant.identity_key);
      }
      if (usage.attempts_used + 1 > usage.attempt_budget) fail('TRANSFER_LIMIT');
      this.db.prepare('UPDATE source_range_usage SET attempts_used=attempts_used+1 WHERE identity_key=?').run(grant.identity_key);
      return !existing;
    });
    const { handle, blockHashes, before } = await this.#openAndVerify(object.source_path, item, start, end);
    let remaining = length, offset = start, reading = false;
    const broker = this;
    const body = new Readable({ highWaterMark: 65536,
      read() {
        if (reading || this.destroyed) return;
        reading = true;
        (async () => {
          if (!remaining) {
            const current = await handle.stat({ bigint: true });
            if (!broker.#unchanged(before, current)) fail('SOURCE_CHANGED');
            this.push(null); return;
          }
          const currentGrant = broker.db.prepare('SELECT revoked,expires_ms FROM source_range_grants WHERE id=?').get(grant.id);
          if (!currentGrant || currentGrant.revoked || currentGrant.expires_ms <= broker.now()) fail('UNAUTHORIZED');
          broker.#source(object.source_path);
          const stat = await handle.stat({ bigint: true });
          if (!broker.#unchanged(before, stat)) fail('SOURCE_CHANGED');
          const blockSize = 65536, blockStart = Math.floor(offset / blockSize) * blockSize;
          const blockLength = Math.min(blockSize, item.byteSize - blockStart), block = Buffer.alloc(blockLength);
          let read = 0;
          while (read < block.length) { const value = await handle.read(block, read, block.length - read, blockStart + read); if (!value.bytesRead) fail('SOURCE_CHANGED'); read += value.bytesRead; }
          if (sha256(block) !== blockHashes.get(blockStart)) fail('SOURCE_CHANGED');
          const within = offset - blockStart, chunk = block.subarray(within, within + Math.min(block.length - within, remaining));
          const after = await handle.stat({ bigint: true });
          if (!broker.#unchanged(before, after)) fail('SOURCE_CHANGED');
          offset += chunk.length; remaining -= chunk.length; reading = false;
          if (!this.destroyed) this.push(chunk);
        })().catch(error => { reading = false; this.destroy(error instanceof SourceRangeV2Error ? error : new SourceRangeV2Error('SOURCE_UNAVAILABLE')); });
      },
      destroy(error, callback) {
        broker.streams.delete(this);
        handle.close().then(() => callback(error), closeError => callback(error || closeError));
      },
    });
    this.streams.add(body);
    const contentRange = `bytes ${start}-${end}/${item.byteSize}`;
    return { status: 206, headers: {
      'Content-Type': 'application/octet-stream', 'Content-Length': String(length),
      'Content-Range': contentRange, 'Accept-Ranges': 'bytes', ETag: etag,
      [REQUEST_HEADER]: requestId, 'Cache-Control': 'no-store',
    }, body, firstUniqueRequest: newRange };
  }

  async #openAndVerify(sourcePath, object, start, end) {
    const source = this.#source(sourcePath);
    let handle;
    try {
      handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size !== BigInt(object.byteSize)) fail('SOURCE_CHANGED');
      const digest = createHash('sha256'), blockHashes = new Map(), blockSize = 65536;
      let offset = 0;
      while (offset < object.byteSize) {
        const length = Math.min(blockSize, object.byteSize - offset), buffer = Buffer.alloc(length);
        let filled = 0;
        while (filled < length) { const result = await handle.read(buffer, filled, length - filled, offset + filled); if (!result.bytesRead) fail('SOURCE_CHANGED'); filled += result.bytesRead; }
        digest.update(buffer);
        if (offset <= end && offset + length > start) blockHashes.set(offset, sha256(buffer));
        offset += length;
      }
      const after = await handle.stat({ bigint: true });
      if (!this.#unchanged(before, after) || digest.digest('hex') !== object.sha256) fail('SOURCE_CHANGED');
      this.#source(source);
      return { handle, blockHashes, before };
    } catch (error) {
      await handle?.close().catch(() => {});
      if (error instanceof SourceRangeV2Error) throw error;
      fail('SOURCE_UNAVAILABLE');
    }
  }

  #unchanged(a, b) { return a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.ino === b.ino && a.dev === b.dev; }

  revoke(identityKey) {
    if (!HASH.test(identityKey)) fail('INVALID_IDENTITY');
    this.db.prepare('UPDATE source_range_grants SET revoked=1 WHERE identity_key=?').run(identityKey);
  }

  close() { for (const stream of this.streams) stream.destroy(); this.db.close(); this.grantTokenKey?.fill(0); }
}

function json(res, status, error) {
  if (res.headersSent) { res.destroy(); return; }
  for (const name of ['content-length', 'content-range', 'accept-ranges', 'etag', REQUEST_HEADER, 'transfer-encoding']) res.removeHeader(name);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.setHeader('referrer-policy', 'no-referrer');
  res.end(JSON.stringify({ error }));
}

function createSourceRangeV2Handler({ broker, enabled = false, isProtectedTransport = req => req.socket?.encrypted === true } = {}) {
  if (typeof enabled !== 'boolean' || typeof isProtectedTransport !== 'function'
    || (enabled && typeof broker?.readAuthorizedRange !== 'function')) throw new Error('invalid source range handler configuration');
  return async function sourceRangeV2Handler(req, res) {
    if (typeof req.url !== 'string' || !req.url.startsWith(PREFIX)) return false;
    if (!enabled) { json(res, 404, 'not_found'); return true; }
    if (isProtectedTransport(req) !== true) { json(res, 503, 'protected_transport_required'); return true; }
    const suffix = req.url.slice(PREFIX.length), query = suffix.indexOf('?');
    if (query !== -1) { json(res, 400, 'query_not_allowed'); return true; }
    if (!slug(suffix)) { json(res, 404, 'not_found'); return true; }
    if (req.method !== 'GET') { json(res, 405, 'method_not_allowed'); return true; }
    if (req.aborted || (req.destroyed && !req.complete)) return true;
    let result;
    try {
      result = await broker.readAuthorizedRange({ objectId: suffix, authorization: req.headers?.authorization,
        method: req.method, range: req.headers?.range, ifMatch: req.headers?.['if-match'], requestId: req.headers?.[REQUEST_HEADER] });
      const body = result.body;
      if (!body || typeof body.pipe !== 'function' || result.status !== 206) throw new Error('invalid source range response');
      const stop = () => { if (!body.destroyed) body.destroy(); };
      const requestClosed = () => { if (req.aborted || !req.complete) stop(); };
      const responseClosed = () => { if (!res.writableFinished) stop(); };
      const cleanup = () => { req.removeListener('aborted', stop); req.removeListener('close', requestClosed); res.removeListener('close', responseClosed); res.removeListener('error', stop); };
      body.once('close', cleanup);
      body.once('error', () => { if (!res.headersSent) json(res, 409, 'source_unavailable'); else res.destroy(); });
      req.once('aborted', stop); req.once('close', requestClosed); res.once('close', responseClosed); res.once('error', stop);
      if (req.aborted || (req.destroyed && !req.complete) || res.destroyed) { stop(); return true; }
      res.statusCode = result.status;
      const responseHeaders = new Map(Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]));
      for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', REQUEST_HEADER]) {
        const value = responseHeaders.get(name);
        if (value !== undefined) res.setHeader(name, value);
      }
      res.setHeader('cache-control', 'no-store'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('x-content-type-options', 'nosniff');
      body.pipe(res); return true;
    } catch (error) {
      result?.body?.destroy();
      const code = error?.code;
      if (code === 'UNAUTHORIZED' || code === 'OBJECT_NOT_GRANTED') json(res, 401, 'unauthorized');
      else if (code === 'INVALID_RANGE') json(res, 416, 'invalid_range');
      else if (code === 'TRANSFER_LIMIT') json(res, 429, 'transfer_limit');
      else if (code === 'TRANSFER_ACCOUNTING_UNAVAILABLE') json(res, 503, 'transfer_accounting_unavailable');
      else if (['SOURCE_CHANGED', 'SOURCE_UNAVAILABLE', 'UNSAFE_SOURCE'].includes(code)) json(res, 409, 'source_unavailable');
      else json(res, 400, 'invalid_source_range');
      return true;
    }
  };
}

module.exports = { CHUNK_BYTES, PREFIX, REQUEST_HEADER, SourceRangeV2Error, SourceRangeV2BrokerCandidate, createSourceRangeV2Handler, canonicalIdentity, requestIdFor, deriveSourceRangeGrantTokenKey };
