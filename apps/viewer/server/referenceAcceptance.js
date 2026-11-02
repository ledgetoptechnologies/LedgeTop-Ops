'use strict';

// A private durability ledger, never a publication or client authorization database.
// managedRoot must be exclusively managed by Viewer: portable Node cannot lock
// directory entries against a different OS process that has write access.
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
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
  constructor({ databasePath, managedRoot, maxManagedBytes = 100 * 1024 ** 3, failpoint = () => {} }) {
    if (!path.isAbsolute(databasePath) || !path.isAbsolute(managedRoot) || !Number.isSafeInteger(maxManagedBytes) || maxManagedBytes < 1 || typeof failpoint !== 'function') fail('EXPLICIT_STORAGE_PATH_REQUIRED');
    this.root = path.resolve(managedRoot); this.maxManagedBytes = maxManagedBytes; this.failpoint = failpoint;
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
      this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        CREATE TABLE IF NOT EXISTS acceptances(receipt_id TEXT PRIMARY KEY, storage_id TEXT NOT NULL UNIQUE,
          job_id TEXT NOT NULL, environment TEXT NOT NULL, generation INTEGER NOT NULL,
          binding TEXT NOT NULL, payload TEXT NOT NULL, storage TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS ack_outbox(receipt_id TEXT PRIMARY KEY REFERENCES acceptances(receipt_id),
          payload TEXT NOT NULL, acked INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS pins(receipt_id TEXT NOT NULL REFERENCES acceptances(receipt_id), object_id TEXT NOT NULL,
          pin_id TEXT NOT NULL, PRIMARY KEY(receipt_id,object_id,pin_id));
        CREATE TABLE IF NOT EXISTS transfer_intents(receipt_id TEXT PRIMARY KEY, payload TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('receiving','accepted','held')), created_at TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS transfer_objects(receipt_id TEXT NOT NULL REFERENCES transfer_intents(receipt_id),
          object_id TEXT NOT NULL, relative_path TEXT NOT NULL, expected_bytes INTEGER NOT NULL,
          expected_sha256 TEXT NOT NULL, received_bytes INTEGER NOT NULL DEFAULT 0,
          state TEXT NOT NULL CHECK(state IN ('pending','receiving','complete','held')),
          PRIMARY KEY(receipt_id,object_id), UNIQUE(receipt_id,relative_path));`);
      if (this.db.prepare('PRAGMA synchronous').get().synchronous !== 2 || this.db.prepare('PRAGMA journal_mode').get().journal_mode !== 'wal') fail('LEDGER_DURABILITY_UNAVAILABLE');
      this.auditManagedRoot();
      syncDirectory(path.dirname(databasePath));
    } catch (error) { this.db.close(); throw error; }
  }
  close() { this.db.close(); }
  auditManagedRoot() {
    const intents = new Map(this.db.prepare('SELECT receipt_id FROM transfer_intents').all().map(row => [row.receipt_id, new Map()]));
    const objects = this.db.prepare('SELECT receipt_id,object_id,relative_path,expected_bytes FROM transfer_objects').all();
    for (const object of objects) {
      const group = intents.get(object.receipt_id);
      if (!group) fail('UNMANAGED_STORAGE_CONTENT');
      group.set(object.object_id, object);
    }
    const inodeEntries = new Map();
    let actualBytes = 0n;
    for (const directoryEntry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink() || !intents.has(directoryEntry.name)) fail('UNMANAGED_STORAGE_CONTENT');
      const receiptId = directoryEntry.name, entries = intents.get(receiptId);
      const directory = safePath(this.root, receiptId);
      checkedChain(directory, true);
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || entry.isSymbolicLink()) fail('UNMANAGED_STORAGE_CONTENT');
        let owner = null, kind = '';
        for (const object of entries.values()) {
          if (entry.name === `${object.object_id}.partial`) { owner = object; kind = 'partial'; break; }
          if (entry.name === `${object.object_id}.bin`) { owner = object; kind = 'final'; break; }
          const escaped = object.object_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (new RegExp(`^${escaped}\\.[a-f0-9]{64}\\.rejected\\.[0-9a-f-]{36}$`).test(entry.name)) { owner = object; kind = 'quarantine'; break; }
        }
        if (!owner) fail('UNMANAGED_STORAGE_CONTENT');
        const absolute = safePath(this.root, `${receiptId}/${entry.name}`), stat = checkedChain(absolute);
        if (!stat.isFile() || stat.size > BigInt(owner.expected_bytes)
            || (kind === 'final' || kind === 'quarantine') && stat.size !== BigInt(owner.expected_bytes)) fail('UNMANAGED_STORAGE_CONTENT');
        const inode = `${stat.dev}:${stat.ino}`;
        const record = inodeEntries.get(inode) || { size: stat.size, links: 0, expectedLinks: stat.nlink };
        if (record.size !== stat.size || record.expectedLinks !== stat.nlink) fail('UNMANAGED_STORAGE_CONTENT');
        record.links++;
        inodeEntries.set(inode, record);
      }
    }
    for (const inode of inodeEntries.values()) {
      if (BigInt(inode.links) !== inode.expectedLinks) fail('UNMANAGED_STORAGE_CONTENT');
      actualBytes += inode.size;
    }
    if (actualBytes > BigInt(this.maxManagedBytes)) fail('STORAGE_QUOTA_EXCEEDED');
  }
  reserveTransfer({ inputManifest, expected, resultManifest, acceptance }) {
    protocol.validateManifest(inputManifest);
    protocol.validateResultManifest(resultManifest, expected);
    protocol.validateAcceptance(acceptance, expected);
    if (inputManifest.sha256 !== expected.inputManifestSha256
        || protocol.manifestSha256(inputManifest) !== expected.inputManifestSha256
        || expected.resultManifestSha256 !== resultManifest.resultManifestSha256
        || encode(expected.objectIds) !== encode(resultManifest.objects.map(object => object.id))) fail('BINDING_MISMATCH');
    const payload = bounded({ inputManifest, expected, resultManifest, acceptance });
    const current = this.db.prepare('SELECT payload FROM transfer_intents WHERE receipt_id=?').get(acceptance.receiptId);
    if (current) {
      if (current.payload !== payload) fail('ACCEPTANCE_RESERVATION_CONFLICT');
      return this.getTransfer(acceptance.receiptId);
    }
    if (this.get(acceptance.receiptId)) fail('ACCEPTANCE_RESERVATION_CONFLICT');
    this.failpoint('beforeTransferReservationTransaction');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raced = this.db.prepare('SELECT payload FROM transfer_intents WHERE receipt_id=?').get(acceptance.receiptId);
      if (raced) {
        if (raced.payload !== payload) fail('ACCEPTANCE_RESERVATION_CONFLICT');
        this.db.exec('COMMIT');
        return this.getTransfer(acceptance.receiptId);
      }
      const requestedBytes = acceptance.acceptedObjectIds.reduce((sum, objectId) => {
        const object = resultManifest.objects.find(item => item.id === objectId);
        if (!object) fail('INVALID_ACCEPTED_CLOSURE');
        return sum + BigInt(object.byteSize);
      }, 0n);
      const reserved = this.db.prepare('SELECT COALESCE(SUM(expected_bytes),0) AS bytes FROM transfer_objects').get().bytes;
      if (BigInt(reserved) + requestedBytes > BigInt(this.maxManagedBytes)) fail('STORAGE_QUOTA_EXCEEDED');
      this.db.prepare('INSERT INTO transfer_intents(receipt_id,payload,state,created_at) VALUES(?,?,?,?)')
        .run(acceptance.receiptId, payload, 'receiving', new Date().toISOString());
      for (const objectId of acceptance.acceptedObjectIds) {
        const object = resultManifest.objects.find(item => item.id === objectId);
        if (!object) fail('INVALID_ACCEPTED_CLOSURE');
        this.db.prepare('INSERT INTO transfer_objects(receipt_id,object_id,relative_path,expected_bytes,expected_sha256,state) VALUES(?,?,?,?,?,?)')
          .run(acceptance.receiptId, objectId, `${acceptance.receiptId}/${objectId}.bin`, object.byteSize, object.sha256, 'pending');
      }
      this.db.exec('COMMIT');
      return this.getTransfer(acceptance.receiptId);
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  getTransfer(receiptId) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db.prepare('SELECT payload,state FROM transfer_intents WHERE receipt_id=?').get(receiptId);
      if (!row) { this.db.exec('COMMIT'); return null; }
      const payload = JSON.parse(row.payload);
      let transferState = row.state;
      const quarantines = [];
      const rows = this.db.prepare('SELECT object_id,relative_path,expected_bytes,expected_sha256,received_bytes,state FROM transfer_objects WHERE receipt_id=? ORDER BY object_id').all(receiptId);
      const objects = rows.map(object => {
        const finalPath = safePath(this.root, object.relative_path);
        const partialPath = safePath(this.root, `${receiptId}/${object.object_id}.partial`);
        const directory = path.dirname(finalPath);
        let state = object.state, receivedBytes = object.received_bytes;
        if (row.state === 'held' || object.state === 'held') {
          state = 'held';
        } else {
          let finalStat = null, partialStat = null;
          try { finalStat = checkedChain(finalPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          try { partialStat = checkedChain(partialPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }

          const inspect = (absolute, allowedLinks) => {
            const before = checkedChain(absolute);
            if (!before.isFile() || before.nlink !== allowedLinks || before.size !== BigInt(object.expected_bytes)) fail('UNSAFE_STORAGE_OBJECT');
            const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
            try {
              if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) fail('STORAGE_OBJECT_CHANGED');
              const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count;
              while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) { bytes += count; digest.update(buffer.subarray(0, count)); }
              const sha256 = digest.digest('hex');
              if (bytes !== object.expected_bytes || sha256 !== object.expected_sha256) fail('STORAGE_DIGEST_MISMATCH');
              fs.fsyncSync(fd);
              if (!sameFile(before, fs.fstatSync(fd, { bigint: true })) || !sameFile(before, checkedChain(absolute))) fail('STORAGE_OBJECT_CHANGED');
              return before;
            } finally { fs.closeSync(fd); }
          };

          if (finalStat) {
            if (partialStat) {
              if (finalStat.dev !== partialStat.dev || finalStat.ino !== partialStat.ino || finalStat.nlink !== 2n || partialStat.nlink !== 2n) fail('UNSAFE_STORAGE_OBJECT');
              inspect(finalPath, 2n);
              fs.unlinkSync(partialPath);
              syncDirectory(directory);
            } else inspect(finalPath, 1n);
            const published = checkedChain(finalPath);
            if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n) fail('UNSAFE_STORAGE_OBJECT');
            syncDirectory(directory);
            state = 'complete'; receivedBytes = object.expected_bytes;
          } else if (partialStat) {
            if (!partialStat.isFile() || partialStat.isSymbolicLink() || partialStat.nlink !== 1n || partialStat.size > BigInt(object.expected_bytes)) fail('UNSAFE_STORAGE_OBJECT');
            receivedBytes = Number(partialStat.size);
            state = receivedBytes > 0 ? 'receiving' : 'pending';
            if (receivedBytes === object.expected_bytes) {
              const fd = fs.openSync(partialPath, fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0));
              try {
                if (!sameFile(partialStat, fs.fstatSync(fd, { bigint: true }))) fail('STORAGE_OBJECT_CHANGED');
                const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count;
                while ((count = fs.readSync(fd, buffer, 0, buffer.length, bytes))) { bytes += count; digest.update(buffer.subarray(0, count)); }
                const sha256 = digest.digest('hex');
                if (bytes !== object.expected_bytes) fail('STORAGE_SIZE_MISMATCH');
                fs.fsyncSync(fd);
                if (!sameFile(partialStat, fs.fstatSync(fd, { bigint: true })) || !sameFile(partialStat, checkedChain(partialPath))) fail('STORAGE_OBJECT_CHANGED');
                if (sha256 === object.expected_sha256) {
                  fs.linkSync(partialPath, finalPath);
                  fs.unlinkSync(partialPath);
                  syncDirectory(directory);
                  inspect(finalPath, 1n);
                  state = 'complete';
                } else {
                  // Preserve the invalid bytes, then hold the immutable receipt.
                  // Repeated retries must use a new receipt so a bad sender cannot
                  // consume unbounded retained storage under one reservation.
                  const quarantine = safePath(this.root, `${receiptId}/${object.object_id}.${sha256}.rejected.${randomUUID()}`);
                  quarantines.push({ partialPath, quarantine, directory });
                  receivedBytes = 0;
                  state = 'held';
                  transferState = 'held';
                  this.db.prepare("UPDATE transfer_intents SET state='held' WHERE receipt_id=?").run(receiptId);
                }
              } finally { fs.closeSync(fd); }
            }
          } else {
            state = 'pending'; receivedBytes = 0;
          }
        }
        if (state !== object.state || receivedBytes !== object.received_bytes) {
          this.db.prepare('UPDATE transfer_objects SET state=?,received_bytes=? WHERE receipt_id=? AND object_id=?')
            .run(state, receivedBytes, receiptId, object.object_id);
        }
        return { objectId: object.object_id, expectedBytes: object.expected_bytes, expectedSha256: object.expected_sha256, receivedBytes, state };
      });
      this.db.exec('COMMIT');
      // Persist the terminal hold before changing names. A crash here leaves
      // durable held state and recoverable bytes under the partial name.
      if (quarantines.length) this.failpoint('beforeTransferQuarantineRename');
      for (const item of quarantines) {
        fs.renameSync(item.partialPath, item.quarantine);
        syncDirectory(item.directory);
      }
      return { receiptId, state: transferState, expected: payload.expected, acceptance: payload.acceptance, objects };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }
  async stageObjectChunk({ receiptId, objectId, offset, contentLength, declaredSha256, source, maxChunkBytes = 16 * 1024 * 1024 }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(contentLength) || contentLength < 0
        || contentLength > maxChunkBytes || !/^[a-f0-9]{64}$/.test(declaredSha256 || '') || !source?.[Symbol.asyncIterator]) fail('INVALID_TRANSFER_CHUNK');
    const transfer = this.getTransfer(receiptId);
    if (!transfer) fail('UNKNOWN_TRANSFER');
    const entry = transfer.objects.find(object => object.objectId === objectId);
    if (!entry) fail('INVALID_TRANSFER_OBJECT');
    const chunk = Buffer.allocUnsafe(contentLength); let received = 0;
    for await (const part of source) {
      if (!(part instanceof Uint8Array)) fail('INVALID_TRANSFER_CHUNK');
      const bytes = Buffer.from(part); received += bytes.length;
      if (!Number.isSafeInteger(received) || received > maxChunkBytes || received > contentLength) fail('TRANSFER_CHUNK_SIZE');
      bytes.copy(chunk, received - bytes.length);
    }
    if (received !== contentLength) fail('TRANSFER_CHUNK_SIZE');
    const chunkSha256 = createHash('sha256').update(chunk).digest('hex');
    if (chunkSha256 !== declaredSha256) fail('TRANSFER_CHUNK_DIGEST');

    const relativeDirectory = receiptId;
    const directory = safePath(this.root, relativeDirectory);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    checkedChain(directory, true); syncDirectory(this.root);
    const finalPath = safePath(this.root, entry.objectId ? `${receiptId}/${objectId}.bin` : entry.relativePath);
    const partialPath = safePath(this.root, `${receiptId}/${objectId}.partial`);
    this.db.exec('BEGIN IMMEDIATE');
    let fd;
    try {
      // Re-read durable intent under the same writer lock used for filesystem
      // mutation. This serializes cooperating Viewer processes sharing the DB.
      const intent = this.db.prepare('SELECT state FROM transfer_intents WHERE receipt_id=?').get(receiptId);
      const currentObject = this.db.prepare('SELECT state,expected_bytes,expected_sha256 FROM transfer_objects WHERE receipt_id=? AND object_id=?').get(receiptId, objectId);
      if (!intent || !currentObject || intent.state !== 'receiving' || currentObject.state === 'held'
          || currentObject.expected_bytes !== entry.expectedBytes || currentObject.expected_sha256 !== entry.expectedSha256) fail('TRANSFER_STATE_CHANGED');
      let finalExists = false;
      try { checkedChain(finalPath); finalExists = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (finalExists) {
        const finalFd = fs.openSync(finalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        try {
          const stat = fs.fstatSync(finalFd, { bigint: true });
          if (!stat.isFile() || stat.nlink !== 1n || stat.size !== BigInt(entry.expectedBytes) || offset + chunk.length > entry.expectedBytes) fail('STORAGE_OBJECT_CHANGED');
          const existing = Buffer.alloc(chunk.length); const count = fs.readSync(finalFd, existing, 0, existing.length, offset);
          if (count !== chunk.length || !existing.equals(chunk)) fail('TRANSFER_CHUNK_CONFLICT');
        } finally { fs.closeSync(finalFd); }
        this.db.prepare("UPDATE transfer_objects SET state='complete',received_bytes=expected_bytes WHERE receipt_id=? AND object_id=?").run(receiptId, objectId);
        this.db.exec('COMMIT');
        return { receiptId, objectId, receivedBytes: entry.expectedBytes, expectedBytes: entry.expectedBytes, complete: true, replayed: true };
      }
      try { fd = fs.openSync(partialPath, fs.constants.O_RDWR | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0), 0o600); }
      catch (error) { throw error; }
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || stat.nlink !== 1n || stat.size > BigInt(entry.expectedBytes)) fail('UNSAFE_STORAGE_OBJECT');
      let current = Number(stat.size);
      if (offset > current || offset + chunk.length > entry.expectedBytes) fail('TRANSFER_OFFSET_MISMATCH');
      let overlap = 0;
      if (offset < current) {
        overlap = Math.min(chunk.length, current - offset);
        const existing = Buffer.alloc(overlap); const count = fs.readSync(fd, existing, 0, overlap, offset);
        if (count !== overlap || !existing.equals(chunk.subarray(0, overlap))) fail('TRANSFER_CHUNK_CONFLICT');
      }
      const remaining = chunk.subarray(overlap);
      for (let position = 0; position < remaining.length;) {
        const wrote = fs.writeSync(fd, remaining, position, remaining.length - position, current + position);
        if (wrote <= 0) fail('TRANSFER_CHUNK_WRITE');
        position += wrote;
      }
      current += remaining.length;
      this.failpoint('beforeTransferFileBarrier');
      fs.fsyncSync(fd);
      syncDirectory(directory);
      let complete = false;
      if (current === entry.expectedBytes) {
        const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0, count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, bytes))) { bytes += count; digest.update(buffer.subarray(0, count)); }
        if (bytes !== entry.expectedBytes || digest.digest('hex') !== entry.expectedSha256) fail('STORAGE_DIGEST_MISMATCH');
        this.failpoint('beforeTransferPublish');
        fs.linkSync(partialPath, finalPath);
        this.failpoint('afterTransferLinkBeforeUnlink');
        fs.unlinkSync(partialPath);
        syncDirectory(directory);
        const published = checkedChain(finalPath);
        if (!published.isFile() || published.isSymbolicLink() || published.nlink !== 1n || published.size !== BigInt(entry.expectedBytes)) fail('STORAGE_OBJECT_CHANGED');
        complete = true;
      }
      this.db.prepare('UPDATE transfer_objects SET state=?,received_bytes=? WHERE receipt_id=? AND object_id=?')
        .run(complete ? 'complete' : 'receiving', current, receiptId, objectId);
      this.failpoint('beforeTransferLedgerCommit');
      this.db.exec('COMMIT');
      return { receiptId, objectId, receivedBytes: current, expectedBytes: entry.expectedBytes, complete, replayed: overlap === chunk.length };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  }
  commitTransfer(receiptId, receiptSigner) {
    const transfer = this.getTransfer(receiptId);
    if (!transfer) fail('UNKNOWN_TRANSFER');
    const already = this.getVerified(receiptId);
    if (already) {
      if (!already.storage.viewerReceipt) fail('VIEWER_RECEIPT_MISSING');
      return already;
    }
    if (typeof receiptSigner !== 'function') fail('VIEWER_RECEIPT_SIGNER_REQUIRED');
    if (transfer.objects.some(object => object.state !== 'complete' || object.receivedBytes !== object.expectedBytes)) fail('TRANSFER_INCOMPLETE');
    const payload = this.db.prepare('SELECT payload FROM transfer_intents WHERE receipt_id=?').get(receiptId);
    const record = JSON.parse(payload.payload);
    const objects = record.acceptance.acceptedObjectIds.map(objectId => ({ id: objectId, relativePath: `${receiptId}/${objectId}.bin` }));
    const viewerReceipt = receiptSigner({ expected: record.expected, resultManifest: record.resultManifest,
      acceptedObjectIds: record.acceptance.acceptedObjectIds });
    const accepted = this.accept({ expected: record.expected, resultManifest: record.resultManifest,
      acceptance: record.acceptance, objects, viewerReceipt, queueAcknowledgement: false });
    return this.getVerified(receiptId) || accepted;
  }
  get(receiptId) {
    const row = this.db.prepare('SELECT payload, storage FROM acceptances WHERE receipt_id=?').get(receiptId);
    return row ? { acceptance: JSON.parse(row.payload), storage: JSON.parse(row.storage) } : null;
  }
  getVerified(receiptId) {
    const record = this.get(receiptId);
    if (!record) return null;
    const { acceptance, storage } = record;
    if (storage.managedRoot !== this.root || !Array.isArray(storage.objects)) fail('LEDGER_STORAGE_ROOT_MISMATCH');
    const expected = {
      jobId: acceptance.jobId,
      generation: acceptance.generation,
      environment: acceptance.environment,
      inputManifestSha256: acceptance.inputManifestSha256,
      pipelineDigest: acceptance.pipelineDigest,
      resultManifestSha256: acceptance.resultManifestSha256,
      objectIds: storage.resultManifest?.objects?.map(object => object.id),
    };
    protocol.validateResultManifest(storage.resultManifest, expected);
    protocol.validateAcceptance(acceptance, expected);
    if (acceptance.acceptedObjectIds.length !== storage.objects.length
        || encode(acceptance.acceptedObjectIds) !== encode(storage.objects.map(object => object.id))) fail('INVALID_ACCEPTED_CLOSURE');

    const directories = new Set([this.root, path.dirname(this.root)]), handles = [];
    try {
      for (const object of storage.objects) {
        keys(object, ['id', 'relativePath']);
        identifier(object.id);
        if (!acceptance.acceptedObjectIds.includes(object.id)) fail('INVALID_ACCEPTED_CLOSURE');
        const absolute = safePath(this.root, object.relativePath), before = checkedChain(absolute);
        if (!before.isFile() || before.nlink !== 1n) fail('UNSAFE_STORAGE_OBJECT');
        const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
        handles.push({ fd, absolute, before });
        if (!sameFile(before, fs.fstatSync(fd, { bigint: true }))) fail('STORAGE_OBJECT_CHANGED');
        const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
        let bytes = 0, count;
        while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) {
          bytes += count;
          if (bytes > protocol.LIMITS.integer) fail('STORAGE_SIZE_LIMIT');
          digest.update(buffer.subarray(0, count));
        }
        const declared = storage.resultManifest.objects.find(item => item.id === object.id);
        if (!declared || bytes !== declared.byteSize || digest.digest('hex') !== declared.sha256) fail('STORAGE_DIGEST_MISMATCH');
        fs.fsyncSync(fd);
        for (let dir = path.dirname(absolute); ; dir = path.dirname(dir)) {
          directories.add(dir);
          if (dir === this.root) break;
        }
      }
      for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
      for (const handle of handles) {
        if (!sameFile(handle.before, fs.fstatSync(handle.fd, { bigint: true }))
            || !sameFile(handle.before, checkedChain(handle.absolute))) fail('STORAGE_OBJECT_CHANGED');
      }
      return record;
    } finally {
      for (const { fd } of handles) fs.closeSync(fd);
    }
  }
  accept({ expected, resultManifest, acceptance, objects, pins = [], reconstruction = {}, viewerReceipt = null, queueAcknowledgement = true }) {
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
    if (viewerReceipt !== null) protocol.validateViewerReceipt(viewerReceipt);
    const storage = bounded({ managedRoot: this.root, resultManifest, objects: mapping, initialPins: pins, reconstruction, viewerReceipt });
    const existing = this.db.prepare('SELECT * FROM acceptances WHERE receipt_id=? OR storage_id=?').all(acceptance.receiptId, acceptance.storageReceiptId);
    if (existing.length) {
      if (existing.length !== 1 || existing[0].payload !== payload || existing[0].storage !== storage) fail('ACCEPTANCE_CONFLICT');
      return this.getVerified(acceptance.receiptId);
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
        if (queueAcknowledgement) this.db.prepare('INSERT INTO ack_outbox(receipt_id,payload) VALUES(?,?)').run(acceptance.receiptId, payload);
        this.db.prepare("UPDATE transfer_intents SET state='accepted' WHERE receipt_id=?").run(acceptance.receiptId);
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
