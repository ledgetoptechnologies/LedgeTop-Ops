'use strict';

const crypto = require('node:crypto');

// Validate registered range proofs during the same bounded streaming read used
// for whole-file integrity. No extra read of multi-gigabyte EPT/photo products.
function retainedChunkVerifier(chunks, byteSize) {
  const fail = () => { throw Object.assign(new Error('registered retained chunk integrity changed'), { code: 'source_changed' }); };
  if (!chunks?.length) return { update() {}, finish() {} };
  if (!Array.isArray(chunks)) fail();
  let total = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk.chunkIndex !== index || chunk.byteOffset !== total || !Number.isSafeInteger(chunk.byteSize)
      || chunk.byteSize <= 0 || !/^[a-f0-9]{64}$/.test(chunk.sha256)) fail();
    total += chunk.byteSize;
  }
  if (!Number.isSafeInteger(total) || total !== byteSize) fail();
  let index = 0, inChunk = 0, hash = crypto.createHash('sha256');
  return {
    update(buffer) {
      let offset = 0;
      while (offset < buffer.length) {
        const chunk = chunks[index];
        if (!chunk) fail();
        const count = Math.min(buffer.length - offset, chunk.byteSize - inChunk);
        hash.update(buffer.subarray(offset, offset + count));
        offset += count; inChunk += count;
        if (inChunk === chunk.byteSize) {
          if (hash.digest('hex') !== chunk.sha256) fail();
          index += 1; inChunk = 0; hash = crypto.createHash('sha256');
        }
      }
    },
    finish() { if (index !== chunks.length || inChunk !== 0) fail(); },
  };
}

module.exports = { retainedChunkVerifier };
