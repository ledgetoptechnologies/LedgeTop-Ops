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
// A positive verification may be remembered for a short time, keyed by the
// file identity (device, inode, size, mtime and ctime in nanoseconds) plus the
// expected digest and byte region. File timestamps have a finite tick, so a
// same-size rewrite inside the tick that produced the current timestamps can
// leave that identity unchanged. As in Git's "racily clean" rule, a result is
// therefore remembered only when the read began more than RACY_WINDOW_MS after
// the file's newest timestamp (max of mtime and ctime); any later write then
// necessarily produces a different ctime, so the next request misses the cache,
// re-hashes the bytes and fails closed exactly as before. Recently written
// files are re-hashed on every request. Failures are never remembered.
//
// The bytes are read and hashed from one open descriptor whose identity is
// checked before and after the read. Concurrent requests for the same region
// share one verification. Buffered hashing (WebCrypto, off the event loop) is
// limited per file and by a global in-flight byte budget; anything else is
// streamed through a small fixed buffer, with a bounded number of concurrent
// streams.
//
// Filesystem assumption: the identity rule relies on ctime being set only by
// the local kernel on every change, from one clock, with attributes read
// fresh. That holds for local POSIX filesystems (the deployed ZFS bind mount,
// ext2/3/4, XFS, btrfs, overlayfs, tmpfs). It does not hold on Windows/NTFS
// (a writer can set the change time) or network filesystems such as NFS/CIFS
// (cached attributes, clock skew). On any filesystem outside the allowlist,
// on Windows, or when statfs fails, nothing is remembered or shared: every
// request hashes its own bytes, exactly as before this cache existed.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');

const DEFAULT_TTL_MS = 120_000;
const DEFAULT_MAX_ENTRIES = 50_000;
// Equal to the registered chunk size, so chunk checks stay single-read.
const BUFFERED_HASH_MAX_BYTES = 4 * 1024 * 1024;
// Process-wide ceiling on bytes held for buffered hashing at once.
const BUFFERED_HASH_BUDGET_BYTES = 64 * 1024 * 1024;
const STREAM_BUFFER_BYTES = 256 * 1024;
// Below this, a thread-pool round trip costs more than hashing inline.
const INLINE_HASH_MAX_BYTES = 1024 * 1024;
const RACY_WINDOW_MS = 2_000;
const MAX_CONCURRENT_STREAMS = 8;
// Streamed checks waiting for a slot; beyond this, requests get a fast 503.
// The same bound applies to requests waiting for buffer budget.
const MAX_QUEUED_STREAMS = 64;
// A response whose headers are already sent cannot get a 503, only an aborted
// transfer. It may therefore wait for the buffer budget in a longer (still
// bounded) queue: this many times the bound above. It holds no budget itself.
const STARTED_QUEUE_FACTOR = 8;
// Verified region bytes (4 MiB chunks, small whole files) kept so responses
// can send exactly the bytes that were hashed without re-reading them.
const VERIFIED_BYTES_CACHE_MAX_BYTES = 256 * 1024 * 1024;
// Uncached path (no remembered results): verified region bytes one response
// may hold from its pre-header check until they are sent, so a region is read
// and hashed once per request. Regions beyond this are hashed when sent.
const REQUEST_CARRY_MAX_BYTES = 16 * 1024 * 1024;
// Linux statfs f_type magic numbers of local filesystems where ctime is
// kernel-maintained and attributes are not cached remotely.
const CACHEABLE_FILESYSTEMS = new Map([
  [0x2fc12fc1, 'zfs'],
  [0xef53, 'ext2/ext3/ext4'],
  [0x58465342, 'xfs'],
  [0x9123683e, 'btrfs'],
  [0x794c7630, 'overlay'],
  [0x01021994, 'tmpfs'],
]);

function busyError() {
  return Object.assign(new Error('integrity verification queue is full'), { code: 'integrity_busy', status: 503 });
}
function abortError() {
  return Object.assign(new Error('integrity verification cancelled'), { name: 'AbortError', code: 'ABORT_ERR' });
}
const isAbort = (error) => error?.name === 'AbortError';
const isBusy = (error) => error?.code === 'integrity_busy';

function fileIdentity(stat) {
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String).join(':');
}

function newestTimestampMs(stat) {
  const newest = stat.mtimeNs > stat.ctimeNs ? stat.mtimeNs : stat.ctimeNs;
  return Number(newest / 1_000_000n);
}

async function sha256Hex(buffer) {
  if (buffer.length <= INLINE_HASH_MAX_BYTES) return crypto.createHash('sha256').update(buffer).digest('hex');
  const digest = await crypto.webcrypto.subtle.digest('SHA-256', buffer);
  return Buffer.from(digest).toString('hex');
}

class AssetIntegrityCache {
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    maxEntries = DEFAULT_MAX_ENTRIES,
    bufferedHashMaxBytes = BUFFERED_HASH_MAX_BYTES,
    bufferedBudgetBytes = BUFFERED_HASH_BUDGET_BYTES,
    racyWindowMs = RACY_WINDOW_MS,
    now = () => performance.now(), // monotonic, for TTL only
    wallNow = () => Date.now(), // wall clock, compared with file timestamps
    openFile = (filePath) => fs.promises.open(filePath, 'r'),
    statfs = (filePath) => fs.promises.statfs(filePath),
    platform = process.platform,
    maxConcurrentStreams = MAX_CONCURRENT_STREAMS,
    maxQueuedStreams = MAX_QUEUED_STREAMS,
    bytesCacheMaxBytes = VERIFIED_BYTES_CACHE_MAX_BYTES,
    carryMaxBytes = REQUEST_CARRY_MAX_BYTES,
  } = {}) {
    this.ttlMs = Math.max(0, Number(ttlMs) || 0);
    this.maxEntries = Math.max(1, Number(maxEntries) || 1);
    this.bufferedHashMaxBytes = Math.max(0, Number(bufferedHashMaxBytes) || 0);
    this.bufferedBudgetBytes = Math.max(0, Number(bufferedBudgetBytes) || 0);
    this.racyWindowMs = Math.max(0, Number(racyWindowMs) || 0);
    this.now = now;
    this.wallNow = wallNow;
    this.openFile = openFile;
    this.statfs = statfs;
    this.platform = platform;
    this.filesystems = new Map(); // stat.dev -> Promise<boolean>
    this.maxConcurrentStreams = Math.max(1, Number(maxConcurrentStreams) || 1);
    this.activeStreams = 0;
    this.maxQueuedStreams = Math.max(0, Number(maxQueuedStreams) || 0);
    this.streamWaiters = [];
    this.verified = new Map();
    this.pending = new Map();
    this.generation = 0;
    this.bufferedBytes = 0;
    this.bufferWaiters = [];
    this.carryMaxBytes = Math.max(0, Number(carryMaxBytes) || 0);
    this.bytesCacheMaxBytes = Math.max(0, Number(bytesCacheMaxBytes) || 0);
    this.bytes = new Map(); // region key -> { buffer, until }
    this.bytesTotal = 0;
    this.stats = { carried: 0, legacy: 0, bytesHits: 0, bytesMisses: 0, hits: 0, misses: 0, failures: 0, racy: 0, streamed: 0, peakBufferedBytes: 0, peakStreams: 0, uncached: 0, busy: 0, cancelled: 0 };
  }

  clear() {
    this.generation += 1;
    this.verified.clear();
    this.pending.clear();
    this.bytes.clear();
    this.bytesTotal = 0;
  }

  regionKey(filePath, identity, region) {
    return region.kind === 'file'
      ? `file\0${filePath}\0${identity}\0${region.sha256}`
      : `chunk\0${filePath}\0${identity}\0${region.offset}\0${region.size}\0${region.sha256}`;
  }

  canBuffer(size) { return size <= this.bufferedHashMaxBytes; }

  // Per-response hand-off of verified region bytes on the uncached path.
  //
  // Budget rule (no hold-and-wait): a response either reserves its whole carry
  // at once, before it reads anything and while it holds no other budget, or
  // takes no carry. deliverVerified carries the first region only; a region
  // that does not fit the carry is never reserved during the check. All other
  // regions are hashed when sent, one at a time, after the carry has been
  // fully released (acquire, hash, write, release). So no response ever waits
  // for budget while holding budget.
  createCarry() { return { budget: 0, reserved: 0, held: 0, entries: new Map(), deferred: 0, closed: false }; }

  // Bytes of the leading regions that fit one carry (capped by the global budget).
  carryBytesFor(regions) {
    const cap = Math.min(this.carryMaxBytes, this.bufferedBudgetBytes);
    let total = 0;
    for (const region of regions) {
      const capacity = region.toEof ? region.size + 1 : region.size;
      if (total + capacity > cap) break;
      total += capacity;
    }
    return total;
  }

  // Reserves the whole carry atomically (may wait in the bounded queue or fail
  // fast with integrity_busy). The caller holds nothing else at this point.
  async reserveCarry(carry, bytes, signal = null) {
    if (bytes <= 0) return;
    await this.reserve(bytes, signal);
    carry.budget = bytes;
    carry.reserved = bytes;
  }

  // Returns every byte the carry still holds to the global budget. Pieces that
  // were already released returned their own share; late releases after this
  // are ignored.
  releaseCarry(carry) {
    if (!carry || carry.closed) return;
    carry.closed = true;
    carry.entries.clear();
    if (carry.reserved > 0) this.unreserve(carry.reserved);
    carry.reserved = 0;
    carry.held = 0;
  }


  // Uncached path with a carry: hash the region now and keep its buffer for
  // the same response, so it is never hashed twice. A region that would
  // exceed the carry is not read here; verifiedSlice hashes it right before
  // it is sent (a mismatch then aborts the response).
  async verifyIntoCarry(filePath, identity, key, region, carry, { handle, signal }) {
    const capacity = region.toEof ? region.size + 1 : region.size;
    if (carry.entries.has(key)) return true;
    // Never reserve here: only the carry's pre-reserved budget is used.
    if (carry.closed || carry.held + capacity > carry.budget) { carry.deferred += 1; return true; }
    carry.held += capacity;
    const result = await this.hashRegion(filePath, identity, region.offset, region.size, { toEof: Boolean(region.toEof), handle, signal, preReserved: true });
    if (!result?.buffer || result.digest !== region.sha256) { this.stats.failures += 1; return false; }
    carry.entries.set(key, { buffer: result.buffer, capacity });
    return true;
  }


  // A whole file too large to hold in memory, i.e. a legacy asset registered
  // without chunk records. OUTSIDE THE BYTE-INTEGRITY GUARANTEE of this module:
  // it keeps the behaviour inherited from before this cache (hash the whole
  // file on every request, then stream it), with none of the optimisations
  // here: no remembered result, no shared in-flight check, no kept bytes.
  // Backfilling chunk records moves such assets onto the guaranteed path.
  isLegacyWholeFile(size) { return !this.canBuffer(Number(size) + 1); }

  storeBytes(key, buffer) {
    if (!buffer || buffer.length > this.bytesCacheMaxBytes || this.ttlMs <= 0) return;
    const previous = this.bytes.get(key);
    if (previous) { this.bytes.delete(key); this.bytesTotal -= previous.buffer.length; }
    this.bytes.set(key, { buffer, until: this.now() + this.ttlMs });
    this.bytesTotal += buffer.length;
    while (this.bytesTotal > this.bytesCacheMaxBytes) {
      const [oldest, entry] = this.bytes.entries().next().value;
      this.bytes.delete(oldest);
      this.bytesTotal -= entry.buffer.length;
    }
  }

  // Waits (FIFO, bounded) until `size` bytes fit in the global buffer budget.
  reserve(size, signal = null, started = false) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (size > this.bufferedBudgetBytes) { this.stats.busy += 1; return Promise.reject(busyError()); }
    if (!this.bufferWaiters.length && this.bufferedBytes + size <= this.bufferedBudgetBytes) {
      this.bufferedBytes += size;
      this.stats.peakBufferedBytes = Math.max(this.stats.peakBufferedBytes, this.bufferedBytes);
      return Promise.resolve();
    }
    if (this.bufferWaiters.length >= this.maxQueuedStreams * (started ? STARTED_QUEUE_FACTOR : 1)) { this.stats.busy += 1; return Promise.reject(busyError()); }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.bufferWaiters.indexOf(waiter);
        if (index >= 0) this.bufferWaiters.splice(index, 1);
        this.stats.cancelled += 1;
        reject(abortError());
        this.unreserve(0);
      };
      const waiter = { size, grant: () => { signal?.removeEventListener('abort', onAbort); resolve(); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.bufferWaiters.push(waiter);
    });
  }

  unreserve(size) {
    this.bufferedBytes -= size;
    while (this.bufferWaiters.length && this.bufferedBytes + this.bufferWaiters[0].size <= this.bufferedBudgetBytes) {
      const waiter = this.bufferWaiters.shift();
      this.bufferedBytes += waiter.size;
      this.stats.peakBufferedBytes = Math.max(this.stats.peakBufferedBytes, this.bufferedBytes);
      waiter.grant();
    }
  }

  // Returns exactly-verified bytes [start, endExclusive) of one registered
  // region (a chunk, or a whole small file), for sending. The bytes are either
  // a copy of bytes hashed earlier for this exact identity (kept in memory) or
  // read now through `handle` and hashed before being returned. The caller
  // must call release() once the bytes have been written. null = mismatch.
  async verifiedSlice(filePath, stat, region, start, endExclusive, { handle = null, signal = null, carry = null, started = false, waited = false } = {}) {
    const identity = fileIdentity(stat);
    const key = this.regionKey(filePath, identity, region);
    const carried = carry && !carry.closed ? carry.entries.get(key) : undefined;
    if (carried) {
      carry.entries.delete(key);
      this.stats.carried += 1;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        if (carry.closed) return; // releaseCarry already returned this share
        carry.reserved -= carried.capacity;
        this.unreserve(carried.capacity);
      };
      return { bytes: carried.buffer.subarray(start - region.offset, endExclusive - region.offset), release };
    }
    // Not carried: return whatever the carry still holds before waiting for
    // budget, so this response never waits while holding budget.
    if (carry && !carry.closed && carry.reserved > 0) this.releaseCarry(carry);
    const eligible = await this.filesystemCacheable(filePath, stat.dev);
    const entry = eligible ? this.bytes.get(key) : undefined;
    if (entry && entry.until > this.now()) {
      // Most of the region: hand out a view and account for the whole buffer
      // it keeps alive. A small slice: copy it so eviction can free the rest.
      const length = endExclusive - start, view = length * 2 >= entry.buffer.length;
      const accounted = view ? entry.buffer.length : length;
      await this.reserve(accounted, signal, started);
      this.stats.bytesHits += 1;
      const slice = entry.buffer.subarray(start - region.offset, endExclusive - region.offset);
      const bytes = view ? slice : Buffer.from(slice);
      let released = false;
      return { bytes, release: () => { if (!released) { released = true; this.unreserve(accounted); } } };
    }
    if (entry) { this.bytes.delete(key); this.bytesTotal -= entry.buffer.length; }
    // Another request is hashing this region: wait for it (holding no budget),
    // then use the bytes it kept. If it kept none, hash them here.
    const inflight = eligible && !waited ? this.pending.get(key) : undefined;
    if (inflight) {
      await inflight.catch(() => {});
      return this.verifiedSlice(filePath, stat, region, start, endExclusive, { handle, signal, carry, started, waited: true });
    }
    const capacity = region.toEof ? region.size + 1 : region.size;
    await this.reserve(capacity, signal, started);
    // Another request may have started (or finished) this region meanwhile.
    if (eligible && !waited && (this.pending.has(key) || this.bytes.get(key)?.until > this.now())) {
      this.unreserve(capacity);
      return this.verifiedSlice(filePath, stat, region, start, endExclusive, { handle, signal, carry, started, waited });
    }
    this.stats.bytesMisses += 1;
    if (eligible && started) this.stats.misses += 1; // the first region was counted when it was checked
    let handedOut = false;
    try {
      const generation = this.generation;
      const hashing = (async () => {
        const result = await this.hashRegion(filePath, identity, region.offset, region.size, { toEof: Boolean(region.toEof), handle, signal, preReserved: true });
        if (!result?.buffer || result.digest !== region.sha256) return null;
        if (eligible && result.cacheable && generation === this.generation) {
          this.storeBytes(key, result.buffer);
          this.verified.set(key, this.now() + this.ttlMs);
          while (this.verified.size > this.maxEntries) this.verified.delete(this.verified.keys().next().value);
        }
        return result;
      })();
      // Requests for the same region share this check, as in remember().
      if (eligible && !this.pending.has(key)) {
        const shared = hashing.then(Boolean, (error) => { if (isAbort(error) || isBusy(error)) throw error; return false; })
          .finally(() => { if (this.pending.get(key) === shared) this.pending.delete(key); });
        shared.catch(() => {}); // the owner reports its own cancellation
        this.pending.set(key, shared);
      }
      const result = await hashing;
      if (!result) { this.stats.failures += 1; return null; }
      handedOut = true;
      let released = false;
      return { bytes: result.buffer.subarray(start - region.offset, endExclusive - region.offset), release: () => { if (!released) { released = true; this.unreserve(capacity); } } };
    } finally {
      if (!handedOut) this.unreserve(capacity);
    }
  }

  // Whether results for files on this device may be remembered (see the
  // filesystem assumption above). Decided once per device id.
  filesystemCacheable(filePath, dev) {
    if (this.platform === 'win32' || this.ttlMs <= 0) return Promise.resolve(false);
    const key = String(dev);
    let decision = this.filesystems.get(key);
    if (!decision) {
      decision = Promise.resolve().then(() => this.statfs(filePath))
        .then((info) => CACHEABLE_FILESYSTEMS.has(Number(info?.type)))
        // A failed statfs is not a decision: stay uncached and ask again later.
        .catch(() => { if (this.filesystems.get(key) === decision) this.filesystems.delete(key); return false; });
      this.filesystems.set(key, decision);
      while (this.filesystems.size > 64) this.filesystems.delete(this.filesystems.keys().next().value);
    }
    return decision;
  }

  // Admits one streamed check. Waits FIFO for a slot, rejects with a busy error
  // when the queue is full, and leaves the queue if the request goes away.
  acquireStream(signal = null) {
    if (signal?.aborted) return Promise.reject(abortError());
    if (this.activeStreams < this.maxConcurrentStreams) {
      this.activeStreams += 1;
      this.stats.peakStreams = Math.max(this.stats.peakStreams, this.activeStreams);
      return Promise.resolve();
    }
    if (this.streamWaiters.length >= this.maxQueuedStreams) { this.stats.busy += 1; return Promise.reject(busyError()); }
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = this.streamWaiters.indexOf(waiter);
        if (index >= 0) this.streamWaiters.splice(index, 1);
        this.stats.cancelled += 1;
        reject(abortError());
      };
      const waiter = () => { signal?.removeEventListener('abort', onAbort); resolve(); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.streamWaiters.push(waiter);
    });
  }


  releaseStream() {
    const next = this.streamWaiters.shift();
    if (next) next(); // the slot passes directly to the next waiter
    else this.activeStreams -= 1;
  }

  // Verifies with the cache on an eligible filesystem; elsewhere every request
  // performs its own verification with no sharing or remembering.
  async check(filePath, stat, key, verify, signal = null) {
    if (await this.filesystemCacheable(filePath, stat.dev)) return this.remember(key, verify, signal);
    this.stats.uncached += 1;
    return this.verifyAlone(verify, signal);
  }

  // One verification for one request, never shared or remembered.
  async verifyAlone(verify, signal) {
    try { return (await verify(signal))?.ok === true; } catch (error) { if (isAbort(error) || isBusy(error)) throw error; return false; }
  }


  // Returns true only when `verify()` (or an identical in-flight/remembered
  // verification of the same identity and region) proved the bytes match.
  // `verify()` resolves to { ok, cacheable }.
  async remember(key, verify, signal = null) {
    const until = this.verified.get(key);
    if (until !== undefined) {
      if (until > this.now()) { this.stats.hits += 1; return true; }
      this.verified.delete(key);
    }
    const inflight = this.pending.get(key);
    if (inflight) {
      try { return await inflight; } catch (error) {
        // The request that owned the shared check went away; check for this one.
        if (isAbort(error) && !signal?.aborted) return this.verifyAlone(verify, signal);
        throw error;
      }
    }
    this.stats.misses += 1;
    const generation = this.generation;
    const promise = (async () => {
      let result;
      try { result = await verify(signal); } catch (error) { if (isAbort(error) || isBusy(error)) throw error; result = null; }
      const ok = result?.ok === true;
      if (!ok) { this.stats.failures += 1; return false; }
      if (!result.cacheable) { this.stats.racy += 1; return true; }
      if (this.ttlMs > 0 && generation === this.generation) {
        this.verified.set(key, this.now() + this.ttlMs);
        while (this.verified.size > this.maxEntries) this.verified.delete(this.verified.keys().next().value);
        if (result.buffer) this.storeBytes(key, result.buffer);
      }
      return true;
    })().finally(() => { if (this.pending.get(key) === promise) this.pending.delete(key); });
    this.pending.set(key, promise);
    return promise;
  }


  reserveBuffer(size) {
    if (size > this.bufferedHashMaxBytes || this.bufferWaiters.length || this.bufferedBytes + size > this.bufferedBudgetBytes) return false;
    this.bufferedBytes += size;
    this.stats.peakBufferedBytes = Math.max(this.stats.peakBufferedBytes, this.bufferedBytes);
    return true;
  }

  // Hashes `size` bytes at `offset` of the exact file whose identity the caller
  // recorded, from one descriptor that must keep that identity before and after
  // the read. With `toEof`, the file must also end exactly at offset + size.
  // With `preReserved`, the caller already holds buffer budget for the read.
  // Buffered reads return the hashed bytes as `buffer`.
  async hashRegion(filePath, identity, offset, size, { toEof = false, handle: openHandle = null, signal = null, preReserved = false } = {}) {
    if (signal?.aborted) throw abortError();
    // One extra byte proves end-of-file in the same read when required.
    const capacity = toEof ? size + 1 : size;
    const buffered = preReserved || this.reserveBuffer(capacity);
    if (!buffered) await this.acquireStream(signal);
    try {
      const readStartedAt = this.wallNow();
      const handle = openHandle || await this.openFile(filePath);
      try {
        const before = await handle.stat({ bigint: true });
        if (fileIdentity(before) !== identity) return null;
        if (signal?.aborted) throw abortError();
        let digest;
        let kept = null;
        let atEof = !toEof;
        if (buffered) {
          const buffer = Buffer.allocUnsafe(capacity);
          let filled = 0;
          while (filled < capacity) {
            const { bytesRead } = await handle.read(buffer, filled, capacity - filled, offset + filled);
            if (!bytesRead) break;
            filled += bytesRead;
          }
          if (filled !== size) return null;
          atEof = true;
          kept = buffer.subarray(0, size);
          digest = await sha256Hex(kept);
        } else {
          this.stats.streamed += 1;
          const hash = crypto.createHash('sha256');
          const buffer = Buffer.allocUnsafe(Math.min(STREAM_BUFFER_BYTES, Math.max(1, size)));
          let position = 0;
          while (position < size) {
            if (signal?.aborted) throw abortError();
            const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - position), offset + position);
            if (!bytesRead) return null;
            hash.update(buffer.subarray(0, bytesRead));
            position += bytesRead;
          }
          digest = hash.digest('hex');
        }
        if (!atEof) {
          const probe = Buffer.allocUnsafe(1);
          if ((await handle.read(probe, 0, 1, offset + size)).bytesRead !== 0) return null;
        }
        if (fileIdentity(await handle.stat({ bigint: true })) !== identity) return null;
        return { digest, buffer: kept, cacheable: readStartedAt - newestTimestampMs(before) > this.racyWindowMs };
      } finally {
        if (!openHandle) await handle.close();
      }
    } finally {
      if (!buffered) this.releaseStream();
      else if (!preReserved) this.unreserve(capacity);
    }
  }


  // Exact whole-file SHA-256 check (nested manifest files, small assets, and
  // legacy assets without chunk rows).
  // With `handle`, the check reads that already-open descriptor (whose fstat
  // is `stat`); `signal` cancels a queued or running check.
  async verifyWholeFile(filePath, stat, expectedSha256, { handle = null, signal = null, carry = null } = {}) {
    const identity = fileIdentity(stat);
    const key = this.regionKey(filePath, identity, { kind: 'file', sha256: expectedSha256 });
    const verify = async (activeSignal) => {
      const result = await this.hashRegion(filePath, identity, 0, Number(stat.size), { toEof: true, handle, signal: activeSignal });
      return { ok: Boolean(result) && result.digest === expectedSha256, cacheable: Boolean(result?.cacheable), buffer: result?.buffer || null };
    };
    if (this.isLegacyWholeFile(stat.size)) {
      this.stats.legacy += 1;
      return this.verifyAlone(verify, signal);
    }
    if (carry) {
      this.stats.uncached += 1;
      return this.verifyIntoCarry(filePath, identity, key, { kind: 'file', offset: 0, size: Number(stat.size), sha256: expectedSha256, toEof: true }, carry, { handle, signal });
    }
    return this.check(filePath, stat, key, verify, signal);
  }

  // Exact registered-chunk check for one 4 MiB (or shorter tail) region.
  async verifyChunk(filePath, stat, chunk, { handle = null, signal = null, carry = null } = {}) {
    const identity = fileIdentity(stat);
    const region = { kind: 'chunk', offset: chunk.byteOffset, size: chunk.byteSize, sha256: chunk.sha256 };
    const key = this.regionKey(filePath, identity, region);
    if (carry) {
      this.stats.uncached += 1;
      return this.verifyIntoCarry(filePath, identity, key, region, carry, { handle, signal });
    }
    return this.check(filePath, stat, key, async (activeSignal) => {
      const result = await this.hashRegion(filePath, identity, chunk.byteOffset, chunk.byteSize, { handle, signal: activeSignal });
      return { ok: Boolean(result) && result.digest === chunk.sha256, cacheable: Boolean(result?.cacheable), buffer: result?.buffer || null };
    }, signal);
  }
}

const assetIntegrityCache = new AssetIntegrityCache();

module.exports = {
  AssetIntegrityCache, assetIntegrityCache, fileIdentity, sha256Hex,
  BUFFERED_HASH_MAX_BYTES, BUFFERED_HASH_BUDGET_BYTES, DEFAULT_TTL_MS, RACY_WINDOW_MS,
  CACHEABLE_FILESYSTEMS, MAX_CONCURRENT_STREAMS, MAX_QUEUED_STREAMS, VERIFIED_BYTES_CACHE_MAX_BYTES, REQUEST_CARRY_MAX_BYTES, busyError, abortError,
};
