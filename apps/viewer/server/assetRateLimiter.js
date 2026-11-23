// In-memory abuse limiter for asset delivery only. Same decisions as
// ViewerRepository.rateLimited (fixed window, then a block as long as the
// window), without a SQLite write transaction for every tile: that write
// blocked the whole process whenever the worker held the database write lock.
//
// Limits are per process and a restart starts fresh windows. Asset delivery
// runs in the single viewer-api process. Credential and grant limits (unlock,
// redeem, download grants) stay in SQLite and survive a restart.
'use strict';

const crypto = require('node:crypto');

function createAssetRateLimiter({ windowMs = 5 * 60_000, maxEntries = 20_000, now = Date.now } = {}) {
  // Ordered by the time each entry stops mattering: an entry is re-inserted
  // when its window starts and whenever a block starts or is extended.
  const entries = new Map();

  function rateLimited(bucket, max) {
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
    if (!entry || entry.startedAt + windowMs <= at) {
      entries.delete(key);
      // Memory bound: forget the entry that would have been released soonest.
      while (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
      entries.set(key, { startedAt: at, hits: 1, blockedUntil: 0, releaseAt: at + windowMs });
      return false;
    }
    entry.hits += 1;
    if (entry.hits <= max) return false;
    entry.blockedUntil = entry.releaseAt = at + windowMs;
    entries.delete(key);
    entries.set(key, entry);
    return true;
  }

  return { rateLimited, get size() { return entries.size; } };
}

module.exports = { createAssetRateLimiter };
