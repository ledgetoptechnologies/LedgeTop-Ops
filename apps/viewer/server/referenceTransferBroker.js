'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Readable } = require('node:stream');
const p = require('./referenceProtocol');
class ReferenceTransferError extends Error {
  constructor(code) { super(code); this.name = 'ReferenceTransferError'; this.code = code; }
}
const fail = code => { throw new ReferenceTransferError(code); };
// readObject returns a paused Readable in body. Consume or destroy it; destroy/EOF/error
// releases the unconsumed reservation. Bytes pushed into the stream count as spent,
// including buffered bytes on cancellation. No plaintext token is recoverable on retry.
const ERROR_CODES = Object.freeze(['INVALID_INTEGER','INVALID_ID','EXTRA_FIELDS','INVALID_ENVIRONMENT','INVALID_LIMIT','DURABLE_DATABASE_REQUIRED','UNSAFE_SOURCE','SYMLINK_SOURCE','SOURCE_UNAVAILABLE','RESERVATION_REQUIRED','CAPABILITY_BINDING','INVALID_EXPIRY','RESERVATION_BINDING','OBJECT_SET_BINDING','STALE_RESERVATION','INVALID_REQUEST','UNAUTHORIZED','OBJECT_NOT_GRANTED','INVALID_RANGE','TRANSFER_LIMIT','SOURCE_CHANGED','TRANSFER_ACCOUNTING_UNAVAILABLE']);
function safeInt(n) { if (!Number.isSafeInteger(n) || n < 0) fail('INVALID_INTEGER'); return n; }
function slug(s) { if (typeof s !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)) fail('INVALID_ID'); }
function exact(o, fields) { if (!o || typeof o !== 'object' || Array.isArray(o) || ![Object.prototype,null].includes(Object.getPrototypeOf(o)) || Object.keys(o).some(k => !fields.includes(k))) fail('EXTRA_FIELDS'); }
class ReferenceTransferBroker {
  constructor({ databasePath, managedRoot, environment, now = Date.now, maxGrantTtlMs = 300000, maxConcurrentRequests = 2, maxConcurrentBytes = 67108864, maxResponseBytes = 16777216, maxRequests = 100 }) {
    if (!['staging', 'production'].includes(environment)) fail('INVALID_ENVIRONMENT');
    this.environment = environment; this.now = now; this.root = fs.realpathSync(managedRoot);
    this.streams = new Set();
    this.settings = { maxGrantTtlMs, maxConcurrentRequests, maxConcurrentBytes, maxResponseBytes, maxRequests };
    for (const v of Object.values(this.settings)) if (!safeInt(v)) fail('INVALID_LIMIT');
    if (typeof databasePath !== 'string' || databasePath === ':memory:') fail('DURABLE_DATABASE_REQUIRED');
    this.db = new DatabaseSync(databasePath);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS reference_grants (id TEXT PRIMARY KEY, job_id TEXT NOT NULL, reservation_id TEXT NOT NULL, identity TEXT NOT NULL, token_hash TEXT NOT NULL, metadata TEXT NOT NULL, files TEXT NOT NULL, expires_ms INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, used_bytes INTEGER NOT NULL DEFAULT 0, reserved_bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0, in_flight INTEGER NOT NULL DEFAULT 0); CREATE INDEX IF NOT EXISTS reference_grants_job ON reference_grants(job_id); CREATE TABLE IF NOT EXISTS reference_job_usage (job_id TEXT PRIMARY KEY, environment TEXT NOT NULL, manifest_sha256 TEXT NOT NULL, byte_limit INTEGER NOT NULL, request_limit INTEGER NOT NULL, charged_bytes INTEGER NOT NULL DEFAULT 0, requests INTEGER NOT NULL DEFAULT 0);');
    try { fs.chmodSync(databasePath, 0o600); } catch (e) { this.db.close(); throw e; }
  }
  tx(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  source(file) {
    try {
    if (typeof file !== 'string' || !path.isAbsolute(file)) fail('UNSAFE_SOURCE');
    const relative = path.relative(this.root, path.resolve(file));
    if (!relative || relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) fail('UNSAFE_SOURCE');
    let cursor = this.root;
    for (const part of relative.split(path.sep)) { cursor = path.join(cursor, part); if (fs.lstatSync(cursor).isSymbolicLink()) fail('SYMLINK_SOURCE'); }
    const real = fs.realpathSync(file); if (real !== path.resolve(file)) fail('UNSAFE_SOURCE');
    if (!fs.statSync(real).isFile()) fail('UNSAFE_SOURCE'); return real;
    } catch (error) { if (error instanceof ReferenceTransferError) throw error; fail('SOURCE_UNAVAILABLE'); }
  }
  mintGrant(input) {
    exact(input, ['jobId', 'generation', 'manifest', 'reservation', 'reservationAvailable', 'objectFiles', 'capabilities', 'capabilityFingerprint', 'replace']);
    const { jobId, generation, manifest, reservation, objectFiles, capabilities } = input;
    if (input.reservationAvailable !== true || !reservation) fail('RESERVATION_REQUIRED');
    slug(jobId); safeInt(generation); p.validateCapabilities(capabilities); p.validateManifest(manifest);
    if (capabilities.environment !== this.environment || input.capabilityFingerprint !== capabilities.capabilityFingerprint) fail('CAPABILITY_BINDING');
    p.validateTransferRequest(reservation);
    const expires = Date.parse(reservation.expiresAt), now = safeInt(this.now());
    if (expires <= now || expires - now > this.settings.maxGrantTtlMs) fail('INVALID_EXPIRY');
    if (reservation.generation !== generation || reservation.manifestSha256 !== manifest.sha256) fail('RESERVATION_BINDING');
    p.validateTransferByteBudget(manifest.totalBytes, reservation.byteBudget);
    if (!objectFiles || typeof objectFiles !== 'object' || Array.isArray(objectFiles) || Object.keys(objectFiles).length !== manifest.objects.length) fail('OBJECT_SET_BINDING');
    const files = {};
    for (const o of manifest.objects) { if (!Object.hasOwn(objectFiles, o.id)) fail('OBJECT_SET_BINDING'); files[o.id] = { path: this.source(objectFiles[o.id]), byteSize: o.byteSize, sha256: o.sha256 }; }
    const metadata = { jobId, generation, reservationId: reservation.reservationId, manifestSha256: manifest.sha256, environment: this.environment, objectIds: manifest.objects.map(o => o.id), nonce: reservation.nonce, byteBudget: reservation.byteBudget, expiresAt: reservation.expiresAt };
    const identity = JSON.stringify({ metadata, files, capabilityFingerprint: input.capabilityFingerprint });
    return this.tx(() => {
      const usage=this.db.prepare('SELECT * FROM reference_job_usage WHERE job_id=?').get(jobId);
      const legacy=this.db.prepare('SELECT 1 FROM reference_grants WHERE job_id=? LIMIT 1').get(jobId);
      if(!usage&&legacy)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      const byteLimit=p.transferByteBudgetLimit(manifest.totalBytes);
      if(usage&&(usage.environment!==this.environment||usage.manifest_sha256!==manifest.sha256||usage.byte_limit!==byteLimit||usage.request_limit!==this.settings.maxRequests))fail('RESERVATION_BINDING');
      if(!usage)this.db.prepare('INSERT INTO reference_job_usage(job_id,environment,manifest_sha256,byte_limit,request_limit) VALUES(?,?,?,?,?)').run(jobId,this.environment,manifest.sha256,byteLimit,this.settings.maxRequests);
      const previous = this.db.prepare('SELECT * FROM reference_grants WHERE job_id=? AND revoked=0 AND expires_ms>? ORDER BY rowid DESC LIMIT 1').get(jobId, now);
      if (previous && previous.identity === identity && input.replace !== true) return { grantId: previous.id, grant: JSON.parse(previous.metadata), reused: true, tokenRecoverable: false };
      const latest = this.db.prepare('SELECT * FROM reference_grants WHERE job_id=? ORDER BY rowid DESC LIMIT 1').get(jobId);
      if (latest) {
        const latestMeta = JSON.parse(latest.metadata);
        if (latestMeta.manifestSha256 !== metadata.manifestSha256 || (generation === latestMeta.generation && latest.files !== JSON.stringify(files))) fail('RESERVATION_BINDING');
        const seen = this.db.prepare('SELECT metadata FROM reference_grants WHERE job_id=?').all(jobId).some(row => JSON.parse(row.metadata).nonce === reservation.nonce);
        if (generation < latestMeta.generation || (seen && (latestMeta.nonce !== reservation.nonce || latest.revoked || latest.expires_ms <= now))) fail('STALE_RESERVATION');
      }
      this.db.prepare('UPDATE reference_grants SET revoked=1 WHERE job_id=?').run(jobId);
      const grantId = randomUUID(), token = randomBytes(32).toString('base64url');
      this.db.prepare('INSERT INTO reference_grants(id,job_id,reservation_id,identity,token_hash,metadata,files,expires_ms) VALUES(?,?,?,?,?,?,?,?)').run(grantId, jobId, reservation.reservationId, identity, p.sha256(Buffer.from(token)), JSON.stringify(metadata), JSON.stringify(files), expires);
      return { grantId, grant: { ...metadata, token }, reused: false, tokenRecoverable: true };
    });
  }
  revokeGrant(grantId) { slug(grantId); this.db.prepare('UPDATE reference_grants SET revoked=1 WHERE id=?').run(grantId); }
  async readAuthorizedObject(request) {
    exact(request, ['objectId', 'authorization', 'method', 'range', 'query']);
    const authorization = request.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail('UNAUTHORIZED');
    const tokenHash = p.sha256(Buffer.from(authorization.slice(7)));
    const row = this.db.prepare('SELECT id FROM reference_grants WHERE token_hash=? AND revoked=0 AND expires_ms>?').get(tokenHash, this.now());
    if (!row) fail('UNAUTHORIZED');
    return this.readObject({ ...request, grantId: row.id });
  }
  async readObject(request) {
    exact(request, ['grantId', 'objectId', 'authorization', 'method', 'range', 'query']);
    const { grantId, objectId, authorization, range } = request; slug(grantId); slug(objectId);
    if (request.method !== 'GET' || (request.query !== undefined && (!request.query || typeof request.query !== 'object' || Array.isArray(request.query) || ![Object.prototype,null].includes(Object.getPrototypeOf(request.query)) || Object.keys(request.query).length))) fail('INVALID_REQUEST');
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) fail('UNAUTHORIZED');
    const tokenHash = p.sha256(Buffer.from(authorization.slice(7)));
    let reserved;
    this.tx(() => {
      const row = this.db.prepare('SELECT * FROM reference_grants WHERE id=?').get(grantId);
      if (!row || !timingSafeEqual(Buffer.from(row.token_hash), Buffer.from(tokenHash)) || row.revoked || row.expires_ms <= this.now()) fail('UNAUTHORIZED');
      const metadata = JSON.parse(row.metadata), files = JSON.parse(row.files), file = files[objectId]; if (!file || !metadata.objectIds.includes(objectId)) fail('OBJECT_NOT_GRANTED');
      const totalBytes = metadata.objectIds.reduce((sum, id) => sum + BigInt(files[id].byteSize), 0n);
      if (totalBytes > BigInt(Number.MAX_SAFE_INTEGER)) fail('RESERVATION_BINDING');
      p.validateTransferByteBudget(Number(totalBytes), metadata.byteBudget);
      let start = 0, end = file.byteSize - 1;
      if (range !== undefined) {
        if (typeof range !== 'string' || !/^bytes=(0|[1-9][0-9]*)-(0|[1-9][0-9]*)?$/.test(range)) fail('INVALID_RANGE');
        const match = /^bytes=(\d+)-(\d*)$/.exec(range); start = Number(match[1]); end = match[2] ? Number(match[2]) : end;
        safeInt(start); safeInt(end); if (start > end || end >= file.byteSize) fail('INVALID_RANGE');
      }
      const length = file.byteSize === 0 && range === undefined ? 0 : end - start + 1;
      const totals = this.db.prepare('SELECT COALESCE(SUM(in_flight),0) requests, COALESCE(SUM(reserved_bytes),0) bytes FROM reference_grants WHERE expires_ms>?').get(this.now());
      const usage=this.db.prepare('SELECT * FROM reference_job_usage WHERE job_id=?').get(row.job_id);
      if(!usage||usage.environment!==this.environment||usage.manifest_sha256!==metadata.manifestSha256)fail('TRANSFER_ACCOUNTING_UNAVAILABLE');
      if (length > this.settings.maxResponseBytes || totals.requests >= this.settings.maxConcurrentRequests || totals.bytes + length > this.settings.maxConcurrentBytes || row.used_bytes + row.reserved_bytes + length > metadata.byteBudget || row.requests >= this.settings.maxRequests || usage.requests>=usage.request_limit || length>usage.byte_limit-usage.charged_bytes) fail('TRANSFER_LIMIT');
      // Charge the full reservation before opening the source. It is never
      // refunded, even if a process dies or a stream is cancelled; no crash
      // can manufacture fresh budget across grant epochs.
      this.db.prepare('UPDATE reference_job_usage SET charged_bytes=charged_bytes+?,requests=requests+1 WHERE job_id=?').run(length,row.job_id);
      this.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes+?,requests=requests+1,in_flight=in_flight+1 WHERE id=?').run(length, grantId);
      reserved = { file, start, end, length, partial: range !== undefined };
    });
    let handle, handedOff = false;
    const release = () => { if (reserved) { this.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes-?,in_flight=in_flight-1 WHERE id=?').run(reserved.remaining ?? reserved.length, grantId); reserved = null; } };
    try {
      const source = this.source(reserved.file.path);
      handle = await fsp.open(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      const before = await handle.stat({ bigint: true }); if (!before.isFile() || before.size !== BigInt(reserved.file.byteSize)) fail('SOURCE_CHANGED');
      const unchanged = stat => stat.size === before.size && stat.mtimeNs === before.mtimeNs && stat.ctimeNs === before.ctimeNs && stat.ino === before.ino && stat.dev === before.dev;
      const blockSize = 65536, blockHashes = new Map();
      const readBlock = async offset => {
        const block = Buffer.alloc(Math.min(blockSize, reserved.file.byteSize - offset)); let filled = 0;
        while (filled < block.length) { const { bytesRead } = await handle.read(block, filled, block.length - filled, offset + filled); if (!bytesRead) fail('SOURCE_CHANGED'); filled += bytesRead; }
        return block;
      };
      // Verify the whole object first. Retain only hashes for blocks intersecting the
      // bounded requested range; never retain a full source copy or trust timestamps
      // as proof of content identity. Each served buffer is rehashed before delivery.
      const { createHash } = require('node:crypto'); const digest = createHash('sha256'); let offset = 0;
      while (offset < reserved.file.byteSize) {
        const block = await readBlock(offset); digest.update(block);
        if (offset <= reserved.end && offset + block.length > reserved.start) blockHashes.set(offset, p.sha256(block));
        offset += block.length;
        const active = this.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId); if (active.revoked || active.expires_ms <= this.now()) fail('UNAUTHORIZED');
      }
      if (digest.digest('hex') !== reserved.file.sha256) fail('SOURCE_CHANGED');
      const after = await handle.stat({ bigint: true }); if (!unchanged(after)) fail('SOURCE_CHANGED');
      this.source(reserved.file.path);
      const row = this.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId); if (row.revoked || row.expires_ms <= this.now()) fail('UNAUTHORIZED');
      reserved.remaining = reserved.length; let transferOffset = reserved.start, reading = false;
      const broker = this;
      const body = new Readable({ highWaterMark: 65536,
        read() {
          if (reading) return; reading = true;
          (async () => {
            if (!reserved || this.destroyed) return;
            if (!reserved.remaining) { if (!unchanged(await handle.stat({ bigint: true }))) fail('SOURCE_CHANGED'); this.push(null); return; }
            const active = broker.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId);
            if (active.revoked || active.expires_ms <= broker.now()) fail('UNAUTHORIZED');
            broker.source(reserved.file.path);
            const stat = await handle.stat({ bigint: true }); if (!unchanged(stat)) fail('SOURCE_CHANGED');
            const blockOffset = Math.floor(transferOffset / blockSize) * blockSize;
            const block = await readBlock(blockOffset);
            if (p.sha256(block) !== blockHashes.get(blockOffset)) fail('SOURCE_CHANGED');
            const withinBlock = transferOffset - blockOffset;
            const chunk = block.subarray(withinBlock, withinBlock + Math.min(block.length - withinBlock, reserved.remaining));
            const bytesRead = chunk.length;
            if (this.destroyed || !reserved) return;
            const afterRead = await handle.stat({ bigint: true }); if (!unchanged(afterRead)) fail('SOURCE_CHANGED');
            if (this.destroyed || !reserved) return;
            const current = broker.db.prepare('SELECT revoked,expires_ms FROM reference_grants WHERE id=?').get(grantId);
            if (current.revoked || current.expires_ms <= broker.now()) fail('UNAUTHORIZED');
            const charged=broker.db.prepare('UPDATE reference_grants SET reserved_bytes=reserved_bytes-?,used_bytes=used_bytes+? WHERE id=? AND revoked=0 AND expires_ms>? AND reserved_bytes>=?').run(bytesRead,bytesRead,grantId,broker.now(),bytesRead);
            if(charged.changes!==1)fail('UNAUTHORIZED');
            reserved.remaining -= bytesRead; transferOffset += bytesRead; reading = false; this.push(chunk);
          })().catch(error => { reading = false; this.destroy(error instanceof ReferenceTransferError ? error : new ReferenceTransferError('SOURCE_UNAVAILABLE')); });
        },
        destroy(error, callback) {
          broker.streams.delete(this);
          try { release(); } catch (e) { error = error || e; }
          handle.close().then(() => callback(error), e => callback(error || e));
        }
      });
      this.streams.add(body); handedOff = true;
      const headers = { 'Content-Length': String(reserved.length), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Accept-Ranges': 'bytes' };
      if (reserved.partial) headers['Content-Range'] = `bytes ${reserved.start}-${reserved.end}/${reserved.file.byteSize}`;
      return { status: reserved.partial ? 206 : 200, headers, body };
    } catch(error) { if (error instanceof ReferenceTransferError) throw error; fail('SOURCE_UNAVAILABLE'); } finally {
      if (!handedOff) { if (handle) await handle.close(); release(); }
    }
  }
  close() { for (const stream of this.streams) stream.destroy(); this.db.close(); }
}
module.exports = { ReferenceTransferBroker, ReferenceTransferError, ERROR_CODES };
