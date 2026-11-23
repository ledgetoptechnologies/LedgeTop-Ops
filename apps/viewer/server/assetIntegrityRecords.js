'use strict';

// Delivery hashes a registered file of at least this size whole, for every
// range request, unless the file has chunk rows. New files must never land in
// that state, so every writer goes through the two functions below.
const CHUNKED_FILE_MIN_BYTES = 4 * 1024 * 1024;
const HIERARCHICAL_KINDS = new Set(['ept', 'tiles']);

// Exactly one contiguous run of chunk hashes from byte 0 to the last byte.
function chunksCover(chunks, byteSize) {
  if (!Array.isArray(chunks) || !chunks.length || !Number.isSafeInteger(byteSize)) return false;
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    if (chunk?.chunkIndex !== index || chunk.byteOffset !== offset
      || !Number.isSafeInteger(chunk.byteSize) || chunk.byteSize < 1 || chunk.byteSize > CHUNKED_FILE_MIN_BYTES
      || typeof chunk.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(chunk.sha256)) return false;
    offset += chunk.byteSize;
  }
  return offset === byteSize;
}

function needsChunkRows({ byteSize, sha256, chunks }) {
  return Boolean(sha256) && Number.isSafeInteger(byteSize) && byteSize >= CHUNKED_FILE_MIN_BYTES && !chunksCover(chunks, byteSize);
}

function checkFile(file, recoveryCopy) {
  // An LOD recovery copy keeps exactly the rows of its authorized source plan,
  // which can predate chunk hashes. Anything it does carry must still be valid.
  if (recoveryCopy && !file.chunks?.length) return;
  if (needsChunkRows(file)) throw Object.assign(new Error('a registered file has no complete chunk hashes; re-scan its source'), { code: 'asset_chunks_missing' });
}

// Call before any file is promoted or any row is written.
function assertAssetIntegrity({ kind, byteSize, sha256, chunks, manifestFiles }, { recoveryCopy = false } = {}) {
  // Hierarchical products are delivered child by child, so their own row needs
  // no chunk hashes: the entry document is also one of the manifest files.
  if (!HIERARCHICAL_KINDS.has(kind)) checkFile({ byteSize, sha256, chunks }, recoveryCopy);
  for (const file of manifestFiles || []) checkFile(file, recoveryCopy);
}

function insertAssetIntegrity(database, assetId, { chunks, manifestFiles }) {
  const insertFile = database.prepare('INSERT INTO model_asset_files(asset_id,relative_path,byte_size,sha256) VALUES (?,?,?,?)');
  const insertChunk = database.prepare('INSERT INTO model_asset_chunks(asset_id,relative_path,chunk_index,byte_offset,byte_size,sha256) VALUES (?,?,?,?,?,?)');
  const insertChunks = (relativePath, rows) => {
    for (const chunk of rows || []) insertChunk.run(assetId, relativePath, chunk.chunkIndex, chunk.byteOffset, chunk.byteSize, chunk.sha256);
  };
  insertChunks('', chunks);
  for (const file of manifestFiles || []) {
    insertFile.run(assetId, file.relativePath, file.byteSize, file.sha256);
    insertChunks(file.relativePath, file.chunks);
  }
}

module.exports = { CHUNKED_FILE_MIN_BYTES, assertAssetIntegrity, chunksCover, insertAssetIntegrity, needsChunkRows };
