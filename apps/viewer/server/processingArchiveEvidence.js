'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { extractZipDescriptor } = require('./safeZip');
const { CHUNK_BYTES, createArchiveLedger, createVerifiedArchiveReader } = require('./verifiedArchiveReader');
const { fsyncDirectory, fsyncDirectoryTree } = require('./durableFs');

const DEFAULT_BYTES = 500 * 1024 * 1024 * 1024;
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const failure = (code, message) => Object.assign(new Error(message), { code });
const invalid = () => failure('invalid_archive', 'processing archive evidence is invalid');
const changed = () => failure('processing_archive_changed', 'processing archive no longer matches its receipt');
function cancelled(signal) { if (signal?.aborted) throw failure('lease_lost', 'processing archive operation cancelled'); }
function limits(options) {
  const result = { maxEntries: options.maxEntries ?? 100000, maxBytes: options.maxBytes ?? DEFAULT_BYTES, maxArchiveBytes: options.maxArchiveBytes ?? DEFAULT_BYTES, maxDiskBytes: options.maxDiskBytes ?? DEFAULT_BYTES };
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 1)) throw invalid();
  return result;
}
function same(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
// CIFS can refresh directory timestamps after extraction without a namespace
// change. Directory identity and a complete before/after name listing remain
// mandatory; file content is bound separately to the verified ZIP manifest.
function sameDirectory(a, b) {
  return b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.size === b.size;
}
function safeDirectory(directory) {
  const resolved = path.resolve(directory), stat = fs.lstatSync(resolved, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
  // Do not accept symlink/junction ancestors in this private integrity boundary.
  const real = fs.realpathSync(resolved);
  if (process.platform === 'win32' ? real.toLowerCase() !== resolved.toLowerCase() : real !== resolved) throw invalid();
  return { resolved, stat };
}
function canonical(files) {
  return files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 }))
    .sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}
function validateInventory(files, maxEntries, maxBytes) {
  if (!Array.isArray(files) || !files.length || files.length > maxEntries) throw invalid();
  const spellings = new Map(), paths = new Set(); let total = 0;
  for (const item of files) {
    if (!item || typeof item.relativePath !== 'string' || item.relativePath.length > 4096 || /[\\\x00-\x1f:]/.test(item.relativePath) ||
        !digest(item.sha256) || !Number.isSafeInteger(item.byteSize) || item.byteSize < 0) throw invalid();
    const parts = item.relativePath.split('/');
    if (parts.some(part => !part || part === '.' || part === '..')) throw invalid();
    let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const folded = prefix.toLowerCase();
      if (spellings.has(folded) && spellings.get(folded) !== prefix) throw invalid();
      spellings.set(folded, prefix);
    }
    const folded = item.relativePath.toLowerCase();
    if (paths.has(folded)) throw invalid();
    paths.add(folded);
    total += item.byteSize;
    if (!Number.isSafeInteger(total) || total > maxBytes) throw invalid();
  }
  for (const name of paths) {
    const parts = name.split('/'); parts.pop();
    while (parts.length) { if (paths.has(parts.join('/'))) throw invalid(); parts.pop(); }
  }
  return canonical(files);
}

function validateDirectories(directories, files, maxEntries) {
  if (!Array.isArray(directories) || directories.length > maxEntries) throw invalid();
  const seen = new Set(), names = new Map();
  for (const name of directories) {
    if (typeof name !== 'string' || name.length > 4096 || /[\\\x00-\x1f:]/.test(name) || name.split('/').some(part => !part || part === '.' || part === '..')) throw invalid();
    const folded = name.toLowerCase();
    if (seen.has(folded)) throw invalid();
    seen.add(folded); names.set(folded, name);
  }
  const sorted = [...directories].sort();
  if (JSON.stringify(sorted) !== JSON.stringify(directories)) throw invalid();
  for (const file of files) {
    if (seen.has(file.relativePath.toLowerCase())) throw invalid();
    const parts = file.relativePath.split('/'); parts.pop();
    while (parts.length) { const parent = parts.join('/'); if (names.get(parent.toLowerCase()) !== parent) throw invalid(); parts.pop(); }
  }
  for (const directory of directories) {
    const parts = directory.split('/'); parts.pop();
    while (parts.length) { const parent = parts.join('/'); if (names.get(parent.toLowerCase()) !== parent) throw invalid(); parts.pop(); }
  }
  return sorted;
}

async function inventoryDirectory(directory, { signal, maxEntries, maxBytes }) {
  const root = safeDirectory(directory), files = [], directories = [], spellings = new Map();
  let entryCount = 0, total = 0;
  async function walk(current, prefix) {
    cancelled(signal);
    const initial = fs.lstatSync(current, { bigint: true });
    if (!initial.isDirectory() || initial.isSymbolicLink()) throw changed();
    const initialNames = fs.readdirSync(current).sort();
    for (const name of initialNames) {
      cancelled(signal);
      if (++entryCount > maxEntries) throw invalid();
      const relativePath = prefix ? `${prefix}/${name}` : name, folded = relativePath.toLowerCase();
      if (spellings.has(folded)) throw invalid();
      spellings.set(folded, relativePath);
      const absolute = path.join(current, name), before = fs.lstatSync(absolute, { bigint: true });
      if (before.isSymbolicLink()) throw invalid();
      if (before.isDirectory()) { directories.push(relativePath); await walk(absolute, relativePath); continue; }
      if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
      total += Number(before.size);
      if (!Number.isSafeInteger(total) || total > maxBytes) throw invalid();
      const fd = await fs.promises.open(absolute, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
      try {
        if (!same(before, await fd.stat({ bigint: true }))) throw changed();
        const sha = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let offset = 0;
        while (offset < Number(before.size)) {
          cancelled(signal);
          const requested = Math.min(buffer.length, Number(before.size) - offset);
          const { bytesRead } = await fd.read(buffer, 0, requested, offset);
          if (bytesRead !== requested) throw changed();
          sha.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
        }
        if (!same(before, await fd.stat({ bigint: true })) || !same(before, fs.lstatSync(absolute, { bigint: true }))) throw changed();
        files.push({ relativePath, byteSize: offset, sha256: sha.digest('hex') });
      } finally { await fd.close(); }
    }
    if (!sameDirectory(initial, fs.lstatSync(current, { bigint: true })) || JSON.stringify(initialNames) !== JSON.stringify(fs.readdirSync(current).sort())) throw changed();
  }
  await walk(root.resolved, '');
  if (!sameDirectory(root.stat, fs.lstatSync(root.resolved, { bigint: true }))) throw changed();
  cancelled(signal);
  return { files: validateInventory(files, maxEntries, maxBytes), directories: directories.sort() };
}

/** Fully consumes and hashes the response before validated descriptor extraction.
 * Caller owns an exclusive ingestion lease and persists the returned receipt.
 * An existing destination without that receipt is never proof of completion.
 * maxDiskBytes is combined spool + expansion headroom; maxArchiveBytes and
 * maxBytes are additional response/expansion caps. Linux descriptor extraction
 * is intentional. Temporary spool/partial trees are private siblings, never
 * provider-controlled receipt files. Receipts must be persisted outside target. */
async function captureProcessingArchive(readable, destination, options = {}) {
  const bounds = limits(options), { signal, onProgress = async () => {}, beforePromote = null, allowExistingVerifiedTarget = false } = options;
  const target = path.resolve(destination), parent = safeDirectory(path.dirname(target));
  if (target === parent.resolved || (fs.existsSync(target) && !allowExistingVerifiedTarget)) throw invalid();
  cancelled(signal);
  const temporary = fs.mkdtempSync(path.join(parent.resolved, '.processing-archive-'));
  fs.chmodSync(temporary, 0o700);
  const spool = path.join(temporary, 'response.zip'), staged = path.join(temporary, 'expanded');
  let fd;
  try {
    const archiveHash = crypto.createHash('sha256'), ledger = createArchiveLedger(); let archiveByteSize = 0;
    const meter = new Transform({ transform(chunk, encoding, callback) {
      archiveByteSize += chunk.length;
      if (!Number.isSafeInteger(archiveByteSize) || archiveByteSize > Math.min(bounds.maxArchiveBytes, bounds.maxDiskBytes)) return callback(invalid());
      archiveHash.update(chunk); ledger.update(chunk); callback(null, chunk);
    } });
    await pipeline(readable, meter, fs.createWriteStream(spool, { flags: 'wx', mode: 0o600 }), ...(signal ? [{ signal }] : []));
    cancelled(signal);
    const proof = ledger.finish();
    if (proof.size !== archiveByteSize) throw changed();
    fd = fs.openSync(spool, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
    const initial = fs.fstatSync(fd, { bigint: true });
    if (initial.size !== BigInt(archiveByteSize) || !initial.isFile() || initial.nlink !== 1n) throw changed();
    const archiveReader = createVerifiedArchiveReader(fd, proof, { signal });
    fs.fsyncSync(fd);
    fsyncDirectory(temporary, { code: 'processing_archive_durability_failed' });
    const expansionBytes = Math.min(bounds.maxBytes, bounds.maxDiskBytes - archiveByteSize);
    if (expansionBytes < 1) throw invalid();
    const extracted = await extractZipDescriptor(fd, archiveByteSize, staged, { ...bounds, maxBytes: expansionBytes, signal, workId: 'capture', onProgress, archiveReader, includeManifest: true });
    fsyncDirectoryTree(staged, { code: 'processing_archive_durability_failed' });
    fsyncDirectory(temporary, { code: 'processing_archive_durability_failed' });
    fsyncDirectory(path.dirname(parent.resolved), { code: 'processing_archive_durability_failed' });
    const final = fs.fstatSync(fd, { bigint: true });
    if (!final.isFile() || final.nlink !== 1n || final.dev !== initial.dev || final.ino !== initial.ino || final.size !== initial.size) throw changed();
    archiveReader.clearCache();
    for (let offset = 0; offset < archiveByteSize; offset += CHUNK_BYTES) {
      cancelled(signal);
      archiveReader.readAt(offset, Math.min(CHUNK_BYTES, archiveByteSize - offset));
      await new Promise(resolve => setImmediate(resolve));
    }
    cancelled(signal);
    const inventory = await inventoryDirectory(staged, { ...bounds, signal });
    const archiveFiles = inventory.files;
    if (JSON.stringify(archiveFiles) !== JSON.stringify(canonical(extracted.files)) || JSON.stringify(inventory.directories) !== JSON.stringify(extracted.directories)) throw changed();
    cancelled(signal);
    const archiveDirectories = validateDirectories(inventory.directories, archiveFiles, bounds.maxEntries);
    const receipt = { archiveSha256: archiveHash.digest('hex'), archiveByteSize, archiveFiles, archiveManifestSha256: hash(JSON.stringify(archiveFiles)), archiveDirectories, archiveDirectoriesSha256: hash(JSON.stringify(archiveDirectories)) };
    const parentNow = fs.lstatSync(parent.resolved, { bigint: true });
    if (fs.realpathSync(parent.resolved) !== parent.resolved || parentNow.ino !== parent.stat.ino || parentNow.dev !== parent.stat.dev) throw changed();
    if (fs.existsSync(target)) {
      if (!allowExistingVerifiedTarget) throw changed();
      await verifyProcessingArchive(target, receipt, { ...bounds, signal, ensureDurable: true });
    }
    if (beforePromote) await beforePromote(receipt);
    cancelled(signal);
    const finalInventory = await inventoryDirectory(staged, { ...bounds, signal });
    if (JSON.stringify(finalInventory.files) !== JSON.stringify(archiveFiles) || JSON.stringify(finalInventory.directories) !== JSON.stringify(inventory.directories)) throw changed();
    const parentAfterReceipt = fs.lstatSync(parent.resolved, { bigint: true });
    if (fs.realpathSync(parent.resolved) !== parent.resolved || parentAfterReceipt.ino !== parent.stat.ino || parentAfterReceipt.dev !== parent.stat.dev) throw changed();
    if (fs.existsSync(target)) {
      if (!allowExistingVerifiedTarget) throw changed();
      await verifyProcessingArchive(target, receipt, { ...bounds, signal, ensureDurable: true });
      return receipt;
    }
    fs.renameSync(staged, target);
    fsyncDirectory(parent.resolved, { code: 'processing_archive_durability_failed' });
    return receipt;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (!readable.readableEnded && !readable.destroyed) readable.destroy();
    // Exact mkdtemp child only: never remove target/provider contents or a root.
    if (path.dirname(temporary) !== parent.resolved || !path.basename(temporary).startsWith('.processing-archive-')) throw invalid();
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

async function verifyProcessingArchive(destination, receipt, options = {}) {
  const bounds = limits(options), ensureDurable = options.ensureDurable === true;
  if (!receipt || !digest(receipt.archiveSha256) || !digest(receipt.archiveManifestSha256) ||
      !Number.isSafeInteger(receipt.archiveByteSize) || receipt.archiveByteSize < 22 || receipt.archiveByteSize > bounds.maxArchiveBytes) throw invalid();
  const expected = validateInventory(receipt.archiveFiles, bounds.maxEntries, bounds.maxBytes);
  if (JSON.stringify(expected) !== JSON.stringify(receipt.archiveFiles) || hash(JSON.stringify(expected)) !== receipt.archiveManifestSha256) throw invalid();
  const hasDirectories = receipt.archiveDirectories !== undefined || receipt.archiveDirectoriesSha256 !== undefined;
  const expectedDirectories = hasDirectories ? validateDirectories(receipt.archiveDirectories, expected, bounds.maxEntries) : null;
  if (hasDirectories && (!digest(receipt.archiveDirectoriesSha256) || hash(JSON.stringify(expectedDirectories)) !== receipt.archiveDirectoriesSha256)) throw invalid();
  const actual = await inventoryDirectory(destination, { ...bounds, signal: options.signal });
  if (JSON.stringify(expected) !== JSON.stringify(actual.files) || (hasDirectories && JSON.stringify(expectedDirectories) !== JSON.stringify(actual.directories))) throw changed();
  if (ensureDurable) {
    const target = path.resolve(destination), parent = path.dirname(target);
    fsyncDirectoryTree(target, { code: 'processing_archive_durability_failed' });
    fsyncDirectory(path.dirname(parent), { code: 'processing_archive_durability_failed' });
    fsyncDirectory(parent, { code: 'processing_archive_durability_failed' });
  }
  return true;
}

module.exports = { captureProcessingArchive, verifyProcessingArchive };
