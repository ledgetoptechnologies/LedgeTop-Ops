'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Readable } = require('node:stream');

const CHUNK_BYTES = 4 * 1024 * 1024;
const changed = () => Object.assign(new Error('processing archive no longer matches its receipt'), { code: 'processing_archive_changed' });
const cancelled = () => Object.assign(new Error('processing archive operation cancelled'), { code: 'lease_lost' });

// Proofs are made from the incoming bytes, before the spool can be changed.
function createArchiveLedger(chunkBytes = CHUNK_BYTES) {
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES) throw changed();
  const proofs = []; let pending = Buffer.alloc(chunkBytes), used = 0, size = 0, finished = false;
  return {
    update(bytes) {
      if (finished || !Buffer.isBuffer(bytes)) throw changed();
      size += bytes.length;
      if (!Number.isSafeInteger(size)) throw changed();
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(chunkBytes - used, bytes.length - offset);
        bytes.copy(pending, used, offset, offset + count); used += count; offset += count;
        if (used === chunkBytes) { proofs.push(crypto.createHash('sha256').update(pending).digest('hex')); pending = Buffer.alloc(chunkBytes); used = 0; }
      }
    },
    finish() {
      if (finished) throw changed(); finished = true;
      if (used) proofs.push(crypto.createHash('sha256').update(pending.subarray(0, used)).digest('hex'));
      pending = null;
      return Object.freeze({ size, chunkBytes, proofs: Object.freeze(proofs.slice()) });
    },
  };
}

function createVerifiedArchiveReader(fd, ledger, { signal } = {}) {
  const { size, chunkBytes, proofs } = ledger || {};
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK_BYTES || !Array.isArray(proofs) || proofs.length !== Math.ceil(size / chunkBytes) || proofs.some(p => !/^[a-f0-9]{64}$/.test(p))) throw changed();
  let cachedIndex = -1, cachedBuffer = null;
  function readAt(offset, length) {
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > size || !Number.isSafeInteger(offset + length)) throw changed();
    const result = Buffer.alloc(length); let output = 0;
    while (output < length) {
      if (signal?.aborted) throw cancelled();
      const position = offset + output, index = Math.floor(position / chunkBytes), start = index * chunkBytes;
      const count = Math.min(chunkBytes, size - start); let buffer = cachedBuffer;
      if (cachedIndex !== index) {
        buffer = Buffer.allocUnsafe(count); let read = 0;
        while (read < count) { if (signal?.aborted) throw cancelled(); const n = fs.readSync(fd, buffer, read, count - read, start + read); if (!n) throw changed(); read += n; }
        if (crypto.createHash('sha256').update(buffer).digest('hex') !== proofs[index]) throw changed();
        cachedIndex = index; cachedBuffer = buffer;
      }
      const within = position - start, copy = Math.min(length - output, count - within);
      buffer.copy(result, output, within, within + copy); output += copy;
    }
    return result;
  }
  function stream(offset, length) {
    const end = length == null ? size : Math.min(size, offset + length);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > size || !Number.isSafeInteger(end) || end < offset || (length != null && (!Number.isSafeInteger(length) || length <= 0 || !Number.isSafeInteger(offset + length)))) throw changed();
    return Readable.from((function* () { for (let position = offset; position < end;) { const count = Math.min(chunkBytes - position % chunkBytes, end - position); yield readAt(position, count); position += count; } })());
  }
  return { readAt, size: () => Promise.resolve(size), stream, clearCache() { cachedIndex = -1; cachedBuffer = null; } };
}

module.exports = { CHUNK_BYTES, createArchiveLedger, createVerifiedArchiveReader };
