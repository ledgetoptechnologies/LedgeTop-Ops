// An R2-shaped object store on a local filesystem, for the fully local Logs host.
//
// Layout under the store root (an isolated flight-logs directory):
//   index.sqlite      key -> blob mapping and metadata (WAL, synchronous FULL): the ONLY commit point
//   blobs/xx/<uuid>   object bodies, written once and never modified
//   tmp/              bodies being written
//
// A put streams the body to tmp/ (size cap, SHA-256 as it goes), fsyncs it, renames it into blobs/,
// fsyncs that directory, and only then commits the index row in one SQLite transaction. The promise
// resolves after that commit, so a caller that is told "stored" can rely on bytes and metadata being durable.
// Conditions (create-only, ETag match) are decided inside that transaction, so they hold across processes.
// Object keys are never used as file names: a key cannot reach outside the store.
//
// Immutable prefixes (raw/ by default) hold originals forever: create-only, never replaced, never deleted.
// Re-sending identical bytes is an idempotent no-op that returns the stored object; different bytes are refused.
// Nothing here ever evicts an object. A crash can leave an unreferenced blob (never acknowledged to anyone);
// those are counted by audit() and left in place, never deleted automatically.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { walSafeSqlite } from './sqlite-d1.mjs';

export const OBJECT_LIMITS = Object.freeze({
  maxKeyBytes: 1024,
  maxCustomMetadataBytes: 2048,
  maxObjectBytes: 64 * 1024 * 1024,
  minFreeBytes: 1024 * 1024 * 1024,
  maxListLimit: 1000,
});

const HTTP_FIELDS = ['contentType', 'contentLanguage', 'contentDisposition', 'contentEncoding', 'cacheControl'];
const SHA256 = /^[0-9a-f]{64}$/;
const TMP_STALE_MS = 60 * 60 * 1000;

export class ObjectStoreError extends Error {
  constructor(code, status, message) { super(message); this.name = 'ObjectStoreError'; this.code = code; this.status = status; }
}

function validateKey(key) {
  if (typeof key !== 'string' || !key) throw new ObjectStoreError('invalid_key', 400, 'Object key must be a non-empty string.');
  if (Buffer.byteLength(key) > OBJECT_LIMITS.maxKeyBytes) throw new ObjectStoreError('invalid_key', 400, 'Object key is too long.');
  if (key.includes('\0')) throw new ObjectStoreError('invalid_key', 400, 'Object key contains NUL.');
  return key;
}

function cleanHttpMetadata(input = {}) {
  if (input instanceof Headers) input = Object.fromEntries(HTTP_FIELDS.map(f => [f, input.get(f.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`))]));
  const out = {};
  for (const field of HTTP_FIELDS) if (input[field] != null) out[field] = String(input[field]);
  return out;
}

function cleanCustomMetadata(input = {}) {
  const out = {};
  for (const [k, v] of Object.entries(input ?? {})) out[String(k)] = String(v);
  if (Buffer.byteLength(JSON.stringify(out)) > OBJECT_LIMITS.maxCustomMetadataBytes)
    throw new ObjectStoreError('metadata_too_large', 400, 'Custom metadata is too large.');
  return out;
}

const unquote = etag => String(etag).trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
const etagList = value => (value == null ? null : (Array.isArray(value) ? value : String(value).split(',')).map(unquote));

function conditionFrom(onlyIf) {
  if (!onlyIf) return null;
  if (onlyIf instanceof Headers)
    return { etagMatches: onlyIf.get('if-match'), etagDoesNotMatch: onlyIf.get('if-none-match'),
      uploadedBefore: onlyIf.get('if-unmodified-since'), uploadedAfter: onlyIf.get('if-modified-since') };
  return onlyIf;
}

/** R2 semantics: true when the condition allows the operation on `row` (null = no object). */
function conditionHolds(onlyIf, row) {
  const c = conditionFrom(onlyIf);
  if (!c) return true;
  const match = etagList(c.etagMatches), noneMatch = etagList(c.etagDoesNotMatch);
  if (match && !(row && (match.includes('*') || match.includes(row.etag)))) return false;
  if (noneMatch && row && (noneMatch.includes('*') || noneMatch.includes(row.etag))) return false;
  const uploaded = row ? Date.parse(row.uploaded) : null;
  if (c.uploadedBefore != null && row && !(uploaded < new Date(c.uploadedBefore).getTime())) return false;
  if (c.uploadedAfter != null && row && !(uploaded > new Date(c.uploadedAfter).getTime())) return false;
  return true;
}

async function* chunksOf(value) {
  if (value == null) return;
  if (typeof value === 'string') { yield Buffer.from(value); return; }
  if (value instanceof ArrayBuffer) { yield new Uint8Array(value); return; }
  if (ArrayBuffer.isView(value)) { yield new Uint8Array(value.buffer, value.byteOffset, value.byteLength); return; }
  if (typeof Blob !== 'undefined' && value instanceof Blob) value = value.stream();
  if (typeof value.getReader === 'function') {
    const reader = value.getReader();
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) return;
        yield chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
      }
    } finally { reader.releaseLock(); }
  }
  if (value instanceof Readable || typeof value[Symbol.asyncIterator] === 'function') {
    for await (const chunk of value) yield typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    return;
  }
  throw new ObjectStoreError('invalid_body', 400, 'Unsupported object body type.');
}

function objectFrom(row) {
  const httpEtag = `"${row.etag}"`;
  const httpMetadata = JSON.parse(row.http_metadata);
  return {
    key: row.key, version: row.version, size: row.size, etag: row.etag, httpEtag,
    uploaded: new Date(row.uploaded), httpMetadata, customMetadata: JSON.parse(row.custom_metadata),
    checksums: { sha256: row.etag }, storageClass: 'Standard',
    writeHttpMetadata(headers) {
      for (const [field, value] of Object.entries(httpMetadata)) headers.set(field.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`), value);
    },
  };
}

function bodyFrom(object, handle) {
  let used = false;
  const take = () => {
    if (used) throw new TypeError('Body has already been used.');
    used = true;
    return handle;
  };
  const readAll = async () => { const h = take(); try { return await h.readFile(); } finally { await h.close(); } };
  // defineProperties, not Object.assign: assign would call the getters and consume the body.
  return Object.defineProperties(object, Object.getOwnPropertyDescriptors({
    get bodyUsed() { return used; },
    get body() { return Readable.toWeb(take().createReadStream({ autoClose: true })); },
    async arrayBuffer() { const b = await readAll(); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
    async bytes() { return new Uint8Array(await readAll()); },
    async text() { return (await readAll()).toString('utf8'); },
    async json() { return JSON.parse((await readAll()).toString('utf8')); },
    async blob() { return new Blob([await readAll()], { type: object.httpMetadata.contentType ?? '' }); },
    /** Releases the file handle when the caller decides not to read the body. */
    async cancel() { if (!used) { used = true; await handle.close(); } },
  }));
}

export class FsR2 {
  #root; #db; #limits; #immutable; #statfs; #faults; #closed = false;

  /**
   * @param {string} root the isolated object directory (created if missing, mode 0700)
   * @param {object} [options]
   * @param {string[]} [options.immutablePrefixes] create-only, never-deleted prefixes (originals)
   * @param {Partial<typeof OBJECT_LIMITS>} [options.limits]
   * @param {(dir: string) => {bavail: number|bigint, bsize: number|bigint}} [options.statfs] for tests
   * @param {object} [options.faults] test-only hooks called at each durability step; a throw simulates a crash there
   */
  constructor(root, { immutablePrefixes = ['raw/'], limits = {}, statfs = fs.statfsSync, faults = {} } = {}) {
    this.#root = path.resolve(root);
    this.#limits = { ...OBJECT_LIMITS, ...limits };
    this.#immutable = [...immutablePrefixes];
    this.#statfs = statfs;
    this.#faults = faults;
    for (const dir of [this.#root, this.#path('blobs'), this.#path('tmp')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(this.#path('index.sqlite'));
    const version = this.#db.prepare('SELECT sqlite_version() AS v').get().v;
    if (!walSafeSqlite(version)) { this.#db.close(); throw new ObjectStoreError('sqlite_version', 500, `SQLite ${version} lacks the WAL-reset fix.`); }
    this.#db.exec('PRAGMA busy_timeout = 5000');
    this.#db.exec('PRAGMA journal_mode = WAL');
    this.#db.exec('PRAGMA synchronous = FULL');
    this.#db.exec(`CREATE TABLE IF NOT EXISTS objects (
      key TEXT PRIMARY KEY, blob TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, etag TEXT NOT NULL,
      version TEXT NOT NULL, uploaded TEXT NOT NULL, http_metadata TEXT NOT NULL, custom_metadata TEXT NOT NULL)`);
    this.durability = { fileSync: 'enforced', dirSync: process.platform === 'win32' ? 'unavailable-on-win32' : 'enforced', platform: process.platform };
    this.#sweepTmp();
  }

  isImmutable(key) { return this.#immutable.some(prefix => key.startsWith(prefix)); }

  async head(key) {
    const row = this.#row(validateKey(key));
    return row ? objectFrom(row) : null;
  }

  async get(key, { onlyIf, range } = {}) {
    validateKey(key);
    if (range) throw new ObjectStoreError('range_unsupported', 400, 'Range reads are not supported.');
    // A replaced blob can disappear between the lookup and the open; look again (bounded).
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = this.#row(key);
      if (!row) return null;
      if (!conditionHolds(onlyIf, row)) return objectFrom(row);
      try {
        return bodyFrom(objectFrom(row), await fsp.open(this.#blobPath(row.blob), 'r'));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    throw new ObjectStoreError('object_unavailable', 503, 'The object changed while it was being read. Try again.');
  }

  /** Resolves after bytes and metadata are durable; null when `onlyIf` fails (R2 semantics). */
  async put(key, value, { httpMetadata, customMetadata, onlyIf, sha256 } = {}) {
    this.#open();
    validateKey(key);
    const http = cleanHttpMetadata(httpMetadata), custom = cleanCustomMetadata(customMetadata);
    if (sha256 != null && !SHA256.test(String(sha256).toLowerCase())) throw new ObjectStoreError('invalid_checksum', 400, 'sha256 must be 64 hex characters.');
    const immutable = this.isImmutable(key);
    // Cheap early answers before any bytes are written; decided again, authoritatively, at commit.
    const before = this.#row(key);
    if (!conditionHolds(onlyIf, before)) return null;
    if (immutable && before && sha256 && before.etag === String(sha256).toLowerCase()) return objectFrom(before);
    this.#requireFreeSpace();

    const blob = randomUUID();
    const written = await this.#writeBlob(blob, value, sha256);
    let committed = null, superseded = null;
    try {
      await this.#fault('beforeCommit', { key, blob });
      committed = this.#transaction(() => {
        const current = this.#row(key);
        if (immutable && current) {
          if (current.etag === written.etag) return { row: current, duplicate: true };
          throw new ObjectStoreError('immutable_object', 409, 'An original with this key already holds different bytes.');
        }
        if (!conditionHolds(onlyIf, current)) return null;
        const row = { key, blob, size: written.size, etag: written.etag, version: randomUUID().replaceAll('-', ''),
          uploaded: new Date().toISOString(), http_metadata: JSON.stringify(http), custom_metadata: JSON.stringify(custom) };
        this.#db.prepare(`INSERT INTO objects (key, blob, size, etag, version, uploaded, http_metadata, custom_metadata)
          VALUES (:key, :blob, :size, :etag, :version, :uploaded, :http_metadata, :custom_metadata)
          ON CONFLICT(key) DO UPDATE SET blob = excluded.blob, size = excluded.size, etag = excluded.etag, version = excluded.version,
            uploaded = excluded.uploaded, http_metadata = excluded.http_metadata, custom_metadata = excluded.custom_metadata`).run(row);
        superseded = current?.blob ?? null;
        return { row, duplicate: false };
      });
    } finally {
      // Our blob is unreferenced unless it was committed; it was never acknowledged, so removing it is safe.
      if (!committed || committed.duplicate) await this.#discardBlob(blob);
    }
    if (!committed) return null;
    // A replaced (mutable) object's old body is no longer referenced by anything.
    if (superseded) await this.#discardBlob(superseded);
    await this.#fault('afterCommit', { key, blob });
    return objectFrom(committed.row);
  }

  async delete(keys) {
    this.#open();
    const list = (Array.isArray(keys) ? keys : [keys]).map(validateKey);
    const frozen = list.find(key => this.isImmutable(key));
    if (frozen) throw new ObjectStoreError('immutable_object', 409, 'Originals are kept forever and cannot be deleted.');
    const blobs = this.#transaction(() => list.map(key => {
      const row = this.#row(key);
      if (row) this.#db.prepare('DELETE FROM objects WHERE key = ?').run(key);
      return row?.blob;
    }).filter(Boolean));
    for (const blob of blobs) await this.#discardBlob(blob);
  }

  async list({ prefix = '', limit = this.#limits.maxListLimit, cursor, startAfter } = {}) {
    this.#open();
    const take = Math.max(1, Math.min(Number(limit) || this.#limits.maxListLimit, this.#limits.maxListLimit));
    const after = cursor ? Buffer.from(String(cursor), 'base64url').toString('utf8') : (startAfter ?? '');
    const rows = this.#db.prepare('SELECT * FROM objects WHERE key > ? AND substr(key, 1, length(?)) = ? ORDER BY key LIMIT ?')
      .all(after, prefix, prefix, take + 1);
    const truncated = rows.length > take;
    const page = rows.slice(0, take).map(row => objectFrom({ ...row }));
    return { objects: page, truncated, cursor: truncated ? Buffer.from(page.at(-1).key).toString('base64url') : undefined, delimitedPrefixes: [] };
  }

  /** Read-only health numbers: objects, bytes, and blobs no row references (left behind by a crash; never deleted). */
  async audit() {
    this.#open();
    const totals = this.#db.prepare('SELECT COUNT(*) AS objects, COALESCE(SUM(size), 0) AS bytes FROM objects').get();
    const referenced = new Set(this.#db.prepare('SELECT blob FROM objects').all().map(r => r.blob));
    let unreferenced = 0;
    for (const shard of await fsp.readdir(this.#path('blobs')))
      for (const name of await fsp.readdir(this.#path('blobs', shard))) if (!referenced.has(name)) unreferenced++;
    return { objects: Number(totals.objects), bytes: Number(totals.bytes), unreferencedBlobs: unreferenced };
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #path(...parts) { return path.join(this.#root, ...parts); }
  #blobPath(blob) { return this.#path('blobs', blob.slice(0, 2), blob); }
  #row(key) { const row = this.#db.prepare('SELECT * FROM objects WHERE key = ?').get(key); return row ? { ...row } : null; }
  #open() { if (this.#closed) throw new ObjectStoreError('store_closed', 503, 'The object store is closed.'); }
  async #fault(step, detail) { await this.#faults[step]?.(detail); }

  #transaction(fn) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec('ROLLBACK');
      throw error;
    }
  }

  #requireFreeSpace(extra = 0) {
    const { bavail, bsize } = this.#statfs(this.#root);
    const free = Number(bavail) * Number(bsize);
    if (free - extra < this.#limits.minFreeBytes)
      throw new ObjectStoreError('storage_full', 507, 'Flight log storage is nearly full. Uploads will resume when space is freed.');
  }

  async #writeBlob(blob, value, expectedSha) {
    const tmp = this.#path('tmp', `${blob}.part`);
    const hash = createHash('sha256');
    let size = 0;
    const handle = await fsp.open(tmp, 'wx', 0o600);
    let moved = false;
    try {
      for await (const chunk of chunksOf(value)) {
        size += chunk.byteLength;
        if (size > this.#limits.maxObjectBytes) throw new ObjectStoreError('object_too_large', 413, 'The object is larger than the store allows.');
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
      await handle.close();
      const etag = hash.digest('hex');
      if (expectedSha && etag !== String(expectedSha).toLowerCase()) throw new ObjectStoreError('checksum_mismatch', 422, 'The body does not match its SHA-256.');
      this.#requireFreeSpace();
      await this.#fault('afterBodySync', { blob });
      const shard = this.#path('blobs', blob.slice(0, 2));
      await fsp.mkdir(shard, { recursive: true, mode: 0o700 });
      await fsp.rename(tmp, this.#blobPath(blob));
      moved = true;
      await this.#fault('afterRename', { blob });
      await this.#syncDir(shard);
      await this.#syncDir(this.#path('tmp'));
      await this.#fault('afterDirSync', { blob });
      return { size, etag };
    } catch (error) {
      await handle.close().catch(() => {});
      if (moved) await this.#discardBlob(blob); else await fsp.rm(tmp, { force: true });
      throw error;
    }
  }

  /** Directory fsync makes the rename durable on Linux. Windows cannot open a directory for fsync; that is reported, not hidden. */
  async #syncDir(dir) {
    if (process.platform === 'win32') return;
    const handle = await fsp.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  }

  async #discardBlob(blob) {
    // Only ever called for a blob no committed row references (never an acknowledged original).
    if (this.#db.prepare('SELECT 1 FROM objects WHERE blob = ?').get(blob)) return;
    await fsp.rm(this.#blobPath(blob), { force: true }).catch(() => {});
  }

  #sweepTmp() {
    // tmp/ only ever holds bodies that were never committed or acknowledged. Recent files may belong to a
    // write still in progress in another process, so only stale ones are removed.
    const cutoff = Date.now() - TMP_STALE_MS;
    for (const name of fs.readdirSync(this.#path('tmp'))) {
      const file = this.#path('tmp', name);
      if (name.endsWith('.part') && fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }
}
