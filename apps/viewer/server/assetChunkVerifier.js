'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');

const identityFields = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];
function identity(stat) {
  if (!stat.isFile() || identityFields.some(key => typeof stat[key] !== 'bigint')) return null;
  return identityFields.map(key => stat[key].toString());
}
const sameIdentity = (a, b) => a && b && a.every((value, index) => value === b[index]);

// Share only reads that are currently running. Retaining completed successes
// would weaken the existing per-request integrity check on mutable mounts.
function createAssetChunkVerifier({ filesystem = fs.promises, maxInFlight = 32 } = {}) {
  if (!Number.isSafeInteger(maxInFlight) || maxInFlight < 1) throw new Error('invalid integrity coalescing limit');
  const inFlight = new Map();

  async function readChunk(handle, chunk) {
    const buffer = Buffer.allocUnsafe(chunk.byteSize);
    const { bytesRead } = await handle.read(buffer, 0, chunk.byteSize, chunk.byteOffset);
    return bytesRead === chunk.byteSize && crypto.createHash('sha256').update(buffer).digest('hex') === chunk.sha256;
  }

  async function verifyChunk(handle, chunk, filePath, stamp) {
    const key = stamp && JSON.stringify([filePath, ...stamp, chunk.byteOffset, chunk.byteSize, chunk.sha256]);
    if (key && inFlight.has(key)) return inFlight.get(key);
    const running = readChunk(handle, chunk);
    // Saturation falls back to independent verification; it never skips work
    // or grows the bookkeeping map beyond its bound.
    if (!key || inFlight.size >= maxInFlight) return running;
    inFlight.set(key, running);
    try { return await running; }
    finally { if (inFlight.get(key) === running) inFlight.delete(key); }
  }

  return async function verifyChunks(filePath, chunks, range, totalSize) {
    if (!Number.isSafeInteger(totalSize) || totalSize < 0 || !Array.isArray(chunks)) return false;
    if (chunks.some(chunk => !Number.isSafeInteger(chunk.byteOffset) || chunk.byteOffset < 0 ||
      !Number.isSafeInteger(chunk.byteSize) || chunk.byteSize <= 0 || chunk.byteOffset + chunk.byteSize > totalSize ||
      !/^[a-f0-9]{64}$/.test(chunk.sha256))) return false;
    const selected = range ? chunks.filter(chunk => chunk.byteOffset <= range.end &&
      chunk.byteOffset + chunk.byteSize - 1 >= range.start) : chunks;
    if (!selected.length) return false;
    if (!range) {
      let offset = 0;
      for (const chunk of chunks) {
        if (chunk.byteOffset !== offset) return false;
        offset += chunk.byteSize;
      }
      if (offset !== totalSize) return false;
    }
    const handle = await filesystem.open(filePath, 'r');
    try {
      const before = await handle.stat({ bigint: true }), stamp = identity(before);
      if (!stamp || before.size !== BigInt(totalSize)) return false;
      for (const chunk of selected) if (!await verifyChunk(handle, chunk, filePath, stamp)) return false;
      // Every caller checks its own open descriptor even when another request
      // performed the shared read. Permission checks remain in the asset route.
      return Boolean(sameIdentity(stamp, identity(await handle.stat({ bigint: true }))));
    } finally { await handle.close(); }
  };
}

module.exports = { createAssetChunkVerifier };
