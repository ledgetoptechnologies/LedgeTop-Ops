// In-memory abuse limiter for asset delivery only. Same decisions as
// ViewerRepository.rateLimited (fixed window, then a block as long as the
// window), without a SQLite write transaction for every tile: that write
// blocked the whole process whenever the worker held the database write lock.
//
// Scope: limits are per process and a restart starts fresh windows. Credential
// and grant limits (unlock, redeem, download grants) stay in SQLite and survive
// a restart.
//
// Memory is bounded without ever forgetting a live window: a new bucket that
// finds the table full is counted by the SQLite limiter instead.
'use strict';

const crypto = require('node:crypto');

function createAssetRateLimiter({ windowMs = 5 * 60_000, maxEntries = 20_000, now = Date.now } = {}) {
  // Ordered by the time each entry stops mattering: an entry is re-inserted
  // when its window starts and whenever a block starts.
  const entries = new Map();
  // Until then SQLite may hold a live window for a bucket that overflowed.
  let overflowUntil = 0;

  // `overflow` is the ViewerRepository.
  function rateLimited(bucket, max, overflow) {
    const at = now();
    // An elapsed entry decides exactly like a missing one, so dropping it
    // changes nothing. Each entry is dropped once.
    for (const [key, entry] of entries) {
      if (entry.releaseAt > at) break;
      entries.delete(key);
    }
    const key = crypto.createHash('sha256').update(String(bucket).normalize('NFKC')).digest('base64');
    const entry = entries.get(key);
    if (entry && entry.blockedUntil > at) return true;
    if (entry && entry.startedAt + windowMs > at) {
      entry.hits += 1;
      if (entry.hits <= max) return false;
      entry.blockedUntil = entry.releaseAt = at + windowMs;
      entries.delete(key);
      entries.set(key, entry);
      return true;
    }
    if (entry) entries.delete(key);
    // A bucket stays in SQLite while its window or block there is live, even
    // when the table has room again. The read never waits for the write lock.
    if (entries.size >= maxEntries || (at < overflowUntil && overflow.abuseWindowLive(bucket, windowMs, { at }))) {
      // Every window or block this call can leave ends within windowMs.
      overflowUntil = at + windowMs;
      return overflow.rateLimited(bucket, max, windowMs, { at });
    }
    entries.set(key, { startedAt: at, hits: 1, blockedUntil: 0, releaseAt: at + windowMs });
    return false;
  }

  return { rateLimited, get size() { return entries.size; } };
}

module.exports = { createAssetRateLimiter };
