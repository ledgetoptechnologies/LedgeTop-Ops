'use strict';

// A private durability ledger, never a publication or client authorization database.
// managedRoot must be exclusively managed by Viewer: portable Node cannot lock
// directory entries against a different OS process that has write access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const protocol = require('./referenceProtocol');
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const encode = value => protocol.canonicalBytes(value).toString('utf8');
function bounded(value) {
  function check(v, depth = 0) {
    if (depth > 32) fail('METADATA_LIMIT');
    if (Array.isArray(v)) { if (v.length > protocol.LIMITS.objects) fail('METADATA_LIMIT'); for (const child of v) check(child, depth + 1); }
    else if (v && typeof v === 'object') { if (Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length > protocol.LIMITS.objects) fail('INVALID_STORAGE_METADATA'); for (const [key, child] of Object.entries(v)) { if (['__proto__','constructor','prototype'].includes(key)) fail('INVALID_STORAGE_METADATA'); check(child, depth + 1); } }
  }
  check(value);
  const bytes = encode(value);
  if (Buffer.byteLength(bytes) > protocol.LIMITS.metadataBytes) fail('METADATA_LIMIT');
  return bytes;
}
function keys(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length || names.some(k => !Object.hasOwn(value, k))) fail('INVALID_STORAGE_METADATA');
}
function identifier(value) { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) fail('INVALID_IDENTIFIER'); }
function safePath(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1024 || relative.includes('\\') || relative.includes(':') || path.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /[\x00-\x1f<>"|?*]/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('UNSAFE_STORAGE_PATH');
  const absolute = path.resolve(root, relative);
  if (!absolute.startsWith(root + path.sep)) fail('UNSAFE_STORAGE_PATH');
  return absolute;
}
function checkedChain(absolute, directory = false) {
  const parsed = path.parse(absolute); let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (current !== absolute || directory) && !stat.isDirectory()) fail('UNSAFE_STORAGE_PATH');
  }
  return fs.lstatSync(absolute, { bigint: true });
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function syncDirectory(directory) {
  checkedChain(directory, true);
  let fd;
  try { fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY || 0)); fs.fsyncSync(fd); }
  catch (cause) { const error = new Error('DIRECTORY_DURABILITY_UNAVAILABLE', { cause }); error.code = 'DIRECTORY_DURABILITY_UNAVAILABLE'; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

class ReferenceAcceptanceLedger {
  constructor({ databasePath, managedRoot, failpoint = () => {} }) {
    if (!path.isAbsolute(databasePath) || !path.isAbsolute(managedRoot) || typeof failpoint !== 'function') fail('EXPLICIT_STORAGE_PATH_REQUIRED');
    this.root = path.resolve(managedRoot); this.failpoint = failpoint;
    checkedChain(this.root, true); checkedChain(path.dirname(databasePath), true);
    for (const candidate of [databasePath, databasePath + '-wal', databasePath + '-shm']) {
      let present = true;
      try { fs.lstatSync(candidate); } catch (error) { if (error.code === 'ENOENT') present = false; else throw error; }
      if (present) {
        const stat = checkedChain(candidate);
        if (!stat.isFile() || stat.nlink !== 1n) fail('UNSAFE_LEDGER_PATH');
      }
    }
    // Fail closed before creating a ledger on platforms lacking directory barriers.
    syncDirectory(path.dirname(databasePath));
    this.db = new DatabaseSync(databasePath);
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS acceptances(receipt_id TEXT PRIMARY KEY, storage_id TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL, environment TEXT NOT NULL, generation INTEGER NOT NULL,
          binding TEXT NOT NULL, payload TEXT NOT NULL, storage TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ack_outbox(receipt_id TEXT PRIMARY KEY REFERENCES acceptances(receipt_id),
          payload TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS pins(receipt_id TEXT NOT NULL REFERENCES acceptances(receipt_id), object_id TEXT NOT NULL,
          pin_id TEXT NOT NULL, PRIMARY KEY(receipt_id,object_id,pin_id));`);
      if (this.db.prepare('PRAGMA synchronous').get().synchronous !== 2 || this.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') fail('LEDGER_DURABILITY_UNAVAILABLE');
      syncDirectory(path.dirname(databasePath));
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  get(receiptId) {
    const row = this.db.prepare('SELECT payload, storage FROM acceptances WHERE receipt_id=?').get(receiptId);
    return row ? { acceptance: JSON.parse(row.payload), storage: JSON.parse(row.storage) } : null;
  }
  accept({ expected, resultManifest, acceptance, objects, pins = [], reconstruction = {} }) {
    protocol.validateResultManifest(resultManifest, expected);
    protocol.validateAcceptance(acceptance, expected);
    if (expected.resultManifestSha256 !== resultManifest.resultManifestSha256 || encode(expected.objectIds) !== encode(resultManifest.objects.map(o => o.id))) fail('BINDING_MISMATCH');
    if (!acceptance.acceptedObjectIds.length || !Array.isArray(objects) || objects.length !== acceptance.acceptedObjectIds.length || !Array.isArray(pins) || pins.length > protocol.LIMITS.objects) fail('INVALID_ACCEPTED_CLOSURE');
    const payload = bounded(acceptance);
    const binding = encode(Object.fromEntries(['jobId','generation','environment','inputManifestSha256','pipelineDigest','resultManifestSha256'].map(k => [k, acceptance[k]])));
    const mapping = objects.map(o => { keys(o, ['id', 'relativePath']); identifier(o.id); safePath(this.root, o.relativePath); return { ...o }; });
    if (new Set(mapping.map(o => o.id)).size !== mapping.length || new Set(mapping.map(o => o.relativePath.toLowerCase())).size !== mapping.length || mapping.some(o => !acceptance.acceptedObjectIds.includes(o.id))) fail('INVALID_ACCEPTED_CLOSURE');
    for (const pin of pins) { keys(pin, ['objectId','pinId']); identifier(pin.pinId); if (!acceptance.acceptedObjectIds.includes(pin.objectId)) fail('INVALID_PIN'); }
    // Store the complete immutable manifest and mapping, independent of legacy projections.
    const storage = bounded({ managedRoot: this.root, resultManifest, objects: mapping, initialPins: pins, reconstruction });
    const existing = this.db.prepare('SELECT * FROM acceptances WHERE receipt_id=? OR storage_id=?').all(acceptance.receiptId, acceptance.storageReceiptId);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].payload !== payload || existing[0].storage !== storage) fail('ACCEPTANCE_CONFLICT');
      return this.get(acceptance.receiptId);
    }
    const generations = this.db.prepare('SELECT generation,binding FROM acceptances WHERE job_id=? AND environment=?').all(acceptance.jobId, acceptance.environment);
    if (generations.some(r => r.generation > acceptance.generation || r.generation === acceptance.generation && r.binding !== binding)) fail('GENERATION_CONFLICT');
    const handles = [], directories = new Set([this.root, path.dirname(this.root)]);
    try {
      for (const object of mapping) {
        const absolute = safePath(this.root, object.relativePath), before = checkedChain(absolute);
        if (!before.isFile() || before.nlink !== 1n) fail('UNSAFE_STORAGE_OBJECT');
        const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        handles.push({ fd, absolute, before });
        if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) fail('STORAGE_OBJECT_CHANGED');
        const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { digest.update(buffer.subarray(0, count)); bytes += count; }
        const declared = resultManifest.objects.find(o => o.id === object.id);
        if (!declared || bytes !== declared.byteSize || digest.digest('hex') !== declared.sha256) fail('STORAGE_DIGEST_MISMATCH');
        this.failpoint('beforeFileBarrier'); fs.fsyncSync(fd);
        for (let dir = path.dirname(absolute); ; dir = path.dirname(dir)) { directories.add(dir); if (dir === this.root) break; }
      }
      this.failpoint('beforeDirectoryBarrier');
      for (const dir of [...directories].sort((a,b) => b.length - a.length)) syncDirectory(dir);
      for (const h of handles) if (!sameFile(h.before, fs.fstatSync(h.fd, { bigint: true })) || !sameFile(h.before, checkedChain(h.absolute))) fail('STORAGE_OBJECT_CHANGED');
      this.failpoint('beforeLedgerCommit');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const current = this.db.prepare('SELECT generation,binding FROM acceptances WHERE job_id=? AND environment=?').all(acceptance.jobId, acceptance.environment);
        if (current.some(r => r.generation > acceptance.generation || r.generation === acceptance.generation && r.binding !== binding)) fail('GENERATION_CONFLICT');
        this.db.prepare('INSERT INTO acceptances VALUES(?,?,?,?,?,?,?,?)').run(acceptance.receiptId, acceptance.storageReceiptId, acceptance.jobId, acceptance.environment, acceptance.generation, binding, payload, storage);
        this.db.prepare('INSERT INTO ack_outbox(receipt_id,payload) VALUES(?,?)').run(acceptance.receiptId, payload);
        for (const pin of pins) this.db.prepare('INSERT OR IGNORE INTO pins VALUES(?,?,?)').run(acceptance.receiptId, pin.objectId, pin.pinId);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      this.failpoint('afterLedgerCommit');
      return this.get(acceptance.receiptId);
    } finally { for (const { fd } of handles) fs.closeSync(fd); }
  }
  pendingOutbox(now = Date.now(), limit = 100) {
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_OUTBOX_QUERY');
    return this.db.prepare('SELECT receipt_id,payload,attempts,next_at FROM ack_outbox WHERE acked=0 AND next_at<=? ORDER BY next_at,receipt_id LIMIT ?').all(now,limit).map(r => ({ receiptId:r.receipt_id, payload:JSON.parse(r.payload), attempts:r.attempts, nextAt:r.next_at }));
  }
  markAcked(receiptId, exactPayload) {
    const row = this.db.prepare('SELECT payload FROM ack_outbox WHERE receipt_id=?').get(receiptId);
    if (!row || row.payload !== bounded(exactPayload)) fail('ACK_BINDING_MISMATCH');
    this.db.prepare('UPDATE ack_outbox SET acked=1 WHERE receipt_id=?').run(receiptId);
  }
  markFailed(receiptId, now = Date.now()) {
    if (!Number.isSafeInteger(now) || now < 0 || now > Number.MAX_SAFE_INTEGER - 300000) fail('INVALID_OUTBOX_TIME');
    const row = this.db.prepare('SELECT attempts FROM ack_outbox WHERE receipt_id=? AND acked=0').get(receiptId);
    if (!row) fail('OUTBOX_NOT_PENDING');
    const attempts = Math.min(31, row.attempts + 1), delay = Math.min(300000, 1000 * 2 ** Math.min(19, attempts - 1));
    this.db.prepare('UPDATE ack_outbox SET attempts=?,next_at=? WHERE receipt_id=? AND acked=0').run(attempts,now+delay,receiptId);
  }
  addPin(receiptId, objectId, pinId) {
    identifier(pinId); const receipt = this.get(receiptId);
    if (!receipt?.acceptance.acceptedObjectIds.includes(objectId)) fail('INVALID_PIN');
    this.db.prepare('INSERT OR IGNORE INTO pins VALUES(?,?,?)').run(receiptId,objectId,pinId);
  }
  removePin(receiptId, objectId, pinId) { this.db.prepare('DELETE FROM pins WHERE receipt_id=? AND object_id=? AND pin_id=?').run(receiptId,objectId,pinId); }
  membership(receiptId, requiredObjectIds) {
    const receipt = this.get(receiptId); if (!receipt) fail('UNKNOWN_RECEIPT');
    const manifestIds = receipt.storage.resultManifest.objects.map(o => o.id);
    if (!Array.isArray(requiredObjectIds) || !requiredObjectIds.length || requiredObjectIds.length > protocol.LIMITS.objects || new Set(requiredObjectIds).size !== requiredObjectIds.length || requiredObjectIds.some(id => !manifestIds.includes(id))) fail('INVALID_REQUIRED_MEMBERSHIP');
    const row = this.db.prepare('SELECT binding FROM acceptances WHERE receipt_id=?').get(receiptId);
    const accepted = new Set(this.db.prepare('SELECT payload FROM acceptances WHERE binding=?').all(row.binding).flatMap(r => JSON.parse(r.payload).acceptedObjectIds));
    return { acceptedObjectIds: [...accepted].sort(), requiredObjectIds: [...requiredObjectIds], fullyAccepted: requiredObjectIds.every(id => accepted.has(id)) };
  }
  // Advisory producer-source eligibility only: never permission to delete the
  // managed accepted copy, nor a replacement for producer terminal confirmation.
  cleanupEligibility({ receiptId, objectId, terminalConfirmed, target }) {
    const receipt = this.get(receiptId);
    if (target !== 'producer-source' || terminalConfirmed !== true || !receipt?.acceptance.acceptedObjectIds.includes(objectId)) return false;
    const { binding } = this.db.prepare('SELECT binding FROM acceptances WHERE receipt_id=?').get(receiptId);
    return !this.db.prepare('SELECT 1 FROM pins p JOIN acceptances a ON a.receipt_id=p.receipt_id WHERE a.binding=? AND p.object_id=? LIMIT 1').get(binding,objectId);
  }
}
module.exports = { ReferenceAcceptanceLedger, syncDirectory };
