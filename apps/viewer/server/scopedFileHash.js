'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const CHUNK_BYTES = 4 * 1024 * 1024;
const IDENTITY = ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs'];

function refuse(reason) {
  throw Object.assign(new Error(`registered file could not be proven: ${reason}`), { code: 'scoped_file_changed' });
}

// Opens one regular file inside root, following no symbolic link, and proves
// that the DESCRIPTOR is that file: a name or directory swapped between a check
// and the open is refused. Read-only.
async function openScopedFile(root, relativePath) {
  const relative = String(relativePath ?? '');
  if (!root || !relative || relative.includes('\0') || relative.includes('\\') || path.win32.isAbsolute(relative)
    || relative.split('/').some((segment) => !segment || segment === '.' || segment === '..')) refuse('unsafe path');
  const realRoot = await fs.promises.realpath(path.resolve(root));
  let current = realRoot;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    if ((await fs.promises.lstat(current)).isSymbolicLink()) refuse('symbolic link');
  }
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = fs.constants;
  const handle = await fs.promises.open(current, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) refuse('not a regular file');
    if (process.platform === 'linux') {
      if (await fs.promises.readlink(`/proc/self/fd/${handle.fd}`) !== current) refuse('opened outside its registered path');
    } else {
      const opened = await fs.promises.realpath(current), named = await fs.promises.stat(opened, { bigint: true });
      if (!opened.startsWith(`${realRoot}${path.sep}`) || named.dev !== stat.dev || named.ino !== stat.ino) refuse('opened outside its registered path');
    }
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Chunk hashes of a file whose size and SHA-256 are already recorded. One
// buffer feeds both hashes; the descriptor must hold exactly the recorded bytes
// to EOF and must not change while it is read. Never returns unproven chunks.
async function hashRecordedFile(root, relativePath, { byteSize, sha256, signal = null } = {}) {
  try {
    if (!Number.isSafeInteger(byteSize) || byteSize < 0 || !/^[a-f0-9]{64}$/.test(String(sha256))) refuse('no recorded identity');
    const { handle, stat } = await openScopedFile(root, relativePath);
    try {
      if (stat.size !== BigInt(byteSize)) refuse('size');
      const whole = crypto.createHash('sha256'), chunks = [], buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, byteSize));
      for (let offset = 0; offset < byteSize;) {
        if (signal?.aborted) throw Object.assign(new Error('file operation cancelled'), { code: 'lease_lost' });
        const size = Math.min(CHUNK_BYTES, byteSize - offset);
        let filled = 0;
        while (filled < size) {
          const { bytesRead } = await handle.read(buffer, filled, size - filled, offset + filled);
          if (!bytesRead) refuse('shorter than recorded');
          filled += bytesRead;
        }
        const bytes = buffer.subarray(0, size);
        whole.update(bytes);
        chunks.push({ chunkIndex: chunks.length, byteOffset: offset, byteSize: size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
        offset += size;
      }
      if ((await handle.read(Buffer.allocUnsafe(1), 0, 1, byteSize)).bytesRead) refuse('longer than recorded');
      if (whole.digest('hex') !== sha256) refuse('content');
      const after = await handle.stat({ bigint: true });
      if (IDENTITY.some((key) => after[key] !== stat[key])) refuse('changed while it was read');
      if (signal?.aborted) throw Object.assign(new Error('file operation cancelled'), { code: 'lease_lost' });
      return chunks;
    } finally { await handle.close(); }
  } catch (error) {
    // Missing or replaced by a link, a directory or another kind of file.
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EISDIR', 'ENXIO'].includes(error.code)) refuse(error.code);
    throw error;
  }
}

module.exports = { hashRecordedFile, openScopedFile };
