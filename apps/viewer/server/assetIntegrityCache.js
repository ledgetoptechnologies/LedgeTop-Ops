'use strict';

// Byte-integrity verification for served assets.
//
// Every managed asset response must carry bytes that match the SHA-256 values
// registered at ingest (whole file, nested manifest file, or 4 MiB chunk).
// Re-reading and re-hashing the same immutable bytes on every request made a
// 256 KiB orthophoto block cost a 4 MiB read+hash, a legacy unchunked raster
// cost a whole-file hash per range, and every 3D Tiles/EPT child cost a full
// hash on the event loop.
//
// A positive verification is remembered for a short time, keyed by the exact
// file identity (device, inode, size, mtime and ctime in nanoseconds) plus the
// expected digest and byte region. Any write, truncate, replace, rename-over or
// timestamp change alters that identity, so the next request misses the cache
// and re-hashes the bytes, failing closed exactly as before. Failures are never
// cached. Concurrent requests for the same region share one verification.
// Hashing of bounded buffers runs on the libuv thread pool (WebCrypto) instead
// of blocking the request event loop.

const crypto = require('node:crypto');
const fs = require('node:fs');

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_ENTRIES = 50_000;
// Whole files at or below this size are read once and hashed off-thread.
// Larger legacy files keep the bounded-memory streaming hash.
const BUFFERED_HASH_MAX_BYTES = 16 * 1024 * 1024;

async function sha256Hex(buffer) {
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', buffer);
  return Buffer.from(digest).toString('hex');
}

function streamSha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

// Reads `size` bytes at `offset` from the file whose identity was recorded in
// the cache key. The opened handle must still be that exact file, so a rename
// or rewrite between stat and open can never verify one file under another
// file's identity. With `toEof`, the file must also end exactly there.
async function readExact(filePath, identity, offset, size, { toEof = false } = {}) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    if (fileIdentity(await handle.stat({ bigint: true })) !== identity) return null;
    const capacity = toEof ? size + 1 : size;
    const buffer = Buffer.allocUnsafe(capacity);
    let filled = 0;
    while (filled < capacity) {
      const { bytesRead } = await handle.read(buffer, filled, capacity - filled, offset + filled);
      if (!bytesRead) break;
      filled += bytesRead;
    }
    return filled === size ? buffer.subarray(0, size) : null;
  } finally {
    await handle.close();
  }
}

class AssetIntegrityCache {
  constructor({ ttlMs = DEFAULT_TTL_MS, maxEntries = DEFAULT_MAX_ENTRIES, bufferedHashMaxBytes = BUFFERED_HASH_MAX_BYTES, now = () => Date.now() } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.bufferedHashMaxBytes = Math.max(0, Number(bufferedHashMaxBytes) || 0);
    this.now = now;
    this.verified = new Map();
    this.pending = new Map();
    this.stats = { hits: 0, misses: 0, failures: 0 };
  }

  clear() { this.verified.clear(); this.pending.clear(); }

  // Returns true only when `verify()` (or an identical in-flight/remembered
  // verification of the same identity and region) proved the bytes match.
  async remember(key, verify) {
    const at = this.now();
    const until = this.verified.get(key);
    if (until !== undefined) {
      if (until > at) { this.stats.hits += 1; return true; }
      this.verified.delete(key);
    }
    const inflight = this.pending.get(key);
    if (inflight) return inflight;
    this.stats.misses += 1;
    const promise = (async () => {
      let ok = false;
      try { ok = await verify() === true; } catch { ok = false; }
      if (ok && this.ttlMs > 0) {
        this.verified.set(key, this.now() + this.ttlMs);
        while (this.verified.size > this.maxEntries) this.verified.delete(this.verified.keys().next().value);
      }
      if (!ok) this.stats.failures += 1;
      return ok;
    })().finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }

  // Exact whole-file SHA-256 check (nested manifest files, small assets, and
  // legacy assets without chunk rows).
  async verifyWholeFile(filePath, stat, expectedSha256) {
    const identity = fileIdentity(stat);
    const key = `file\0${filePath}\0${identity}\0${expectedSha256}`;
    return this.remember(key, async () => {
      const size = Number(stat.size);
      if (size <= this.bufferedHashMaxBytes) {
        const buffer = await readExact(filePath, identity, 0, size, { toEof: true });
        return Boolean(buffer) && await sha256Hex(buffer) === expectedSha256;
      }
      if (await streamSha256(filePath) !== expectedSha256) return false;
      // The streamed bytes must belong to the identity being remembered.
      return fileIdentity(await fs.promises.stat(filePath, { bigint: true })) === identity;
    });
  }

  // Exact registered-chunk check for one 4 MiB (or shorter tail) region.
  async verifyChunk(filePath, stat, chunk) {
    const identity = fileIdentity(stat);
    const key = `chunk\0${filePath}\0${identity}\0${chunk.byteOffset}\0${chunk.byteSize}\0${chunk.sha256}`;
    return this.remember(key, async () => {
      const buffer = await readExact(filePath, identity, chunk.byteOffset, chunk.byteSize);
      return Boolean(buffer) && await sha256Hex(buffer) === chunk.sha256;
    });
  }
}

const assetIntegrityCache = new AssetIntegrityCache();

module.exports = { AssetIntegrityCache, assetIntegrityCache, fileIdentity, sha256Hex, BUFFERED_HASH_MAX_BYTES, DEFAULT_TTL_MS };
