'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { relative, MAX_FILES, MAX_BYTES } = require('./derivativeSupplement');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
  && a.size === b.size && a.ctimeNs === b.ctimeNs && a.mtimeNs === b.mtimeNs;
function mount(fd) {
  const value = fs.readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8').match(/^mnt_id:\s+(\d+)$/m)?.[1];
  if (!value) fail('supplement_mount_unbound');
  return value;
}
function directoryBelow(base, relativeRoot, mountId) {
  let fd = fs.openSync(`/proc/self/fd/${base}/.`, flags | fs.constants.O_DIRECTORY);
  try {
    for (const part of relativeRoot ? relativeRoot.split('/') : []) {
      const next = fs.openSync(`/proc/self/fd/${fd}/${part}`, flags | fs.constants.O_DIRECTORY);
      fs.closeSync(fd); fd = next;
      if (mount(fd) !== mountId) fail('supplement_mount_changed');
    }
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

// Linux descriptor-relative read pins. This is NOT a cleanup/maintenance fence
// or a durable promotion adapter: an admitted custody owner must provide those.
class PinnedSupplementDirectory {
  constructor(trustedAbsoluteRoot, files, { relativeRoot = '' } = {}) {
    if (process.platform !== 'linux') fail('supplement_platform_unsupported');
    if (typeof trustedAbsoluteRoot !== 'string' || !path.isAbsolute(trustedAbsoluteRoot)
      || trustedAbsoluteRoot.includes('\0')) fail('supplement_root_unsafe');
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) fail('supplement_inventory_limit');
    this.files = new Map();
    this.verified = new Map();
    let totalBytes = 0;
    for (const file of files) {
      if (!file || typeof file !== 'object') fail('supplement_invalid_inventory');
      relative(file.relativePath);
      if (this.files.has(file.relativePath) || !Number.isSafeInteger(file.byteSize) || file.byteSize < 0
        || !/^[a-f0-9]{64}$/.test(file.sha256)) fail('supplement_invalid_inventory');
      totalBytes += file.byteSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > MAX_BYTES) fail('supplement_inventory_limit');
      this.files.set(file.relativePath, Object.freeze({ ...file }));
    }
    this.root = trustedAbsoluteRoot;
    if (relativeRoot) relative(relativeRoot);
    this.relativeRoot = relativeRoot;
    this.baseFd = fs.openSync(trustedAbsoluteRoot, flags | fs.constants.O_DIRECTORY);
    this.fd = null;
    try {
      this.baseStat = fs.fstatSync(this.baseFd, { bigint: true }); this.mountId = mount(this.baseFd);
      this.fd = directoryBelow(this.baseFd, relativeRoot, this.mountId);
      this.stat = fs.fstatSync(this.fd, { bigint: true }); this.mountId = mount(this.fd);
      if (!this.stat.isDirectory()) fail('supplement_root_unsafe');
    } catch (error) { if (this.fd !== null) fs.closeSync(this.fd); fs.closeSync(this.baseFd); this.fd = this.baseFd = null; throw error; }
  }

  assertPinned() {
    if (this.fd === null) fail('supplement_pin_closed');
    let current, base;
    try {
      base = fs.openSync(this.root, flags | fs.constants.O_DIRECTORY);
      const baseStat = fs.fstatSync(base, { bigint: true });
      if (baseStat.dev !== this.baseStat.dev || baseStat.ino !== this.baseStat.ino || mount(base) !== this.mountId) fail('supplement_root_changed');
      current = directoryBelow(base, this.relativeRoot, this.mountId);
      const stat = fs.fstatSync(current, { bigint: true });
      if (stat.dev !== this.stat.dev || stat.ino !== this.stat.ino || mount(current) !== this.mountId) fail('supplement_root_changed');
    } catch (error) {
      if (error.code === 'supplement_root_changed') throw error;
      fail('supplement_root_changed');
    } finally { if (current !== undefined) fs.closeSync(current); if (base !== undefined) fs.closeSync(base); }
  }

  #open(relativePath) {
    relative(relativePath); this.assertPinned();
    let directory = fs.openSync(`/proc/self/fd/${this.fd}/.`, flags | fs.constants.O_DIRECTORY), fd;
    try {
      const parts = relativePath.split('/'), name = parts.pop();
      for (const part of parts) {
        const next = fs.openSync(`/proc/self/fd/${directory}/${part}`, flags | fs.constants.O_DIRECTORY);
        fs.closeSync(directory); directory = next;
        if (mount(directory) !== this.mountId) fail('supplement_mount_changed');
      }
      fd = fs.openSync(`/proc/self/fd/${directory}/${name}`, flags | fs.constants.O_NONBLOCK);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (!stat.isFile() || mount(fd) !== this.mountId) fail('supplement_file_unsafe');
      return { fd, stat };
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      throw error;
    } finally { fs.closeSync(directory); }
  }

  assertNamed(relativePath, original) {
    if (!this.files.has(relativePath)) fail('supplement_file_not_listed');
    const opened = this.#open(relativePath);
    try { if (!sameFile(opened.stat, original)) fail('supplement_file_changed'); }
    finally { fs.closeSync(opened.fd); }
  }

  async withFile(relativePath, reader, { signal = null, assertCurrent = () => {} } = {}) {
    const expected = this.files.get(relativePath);
    if (!expected || typeof reader !== 'function') fail('supplement_file_not_listed');
    assertCurrent(); signal?.throwIfAborted();
    const opened = this.#open(relativePath);
    try {
      if (opened.stat.size !== BigInt(expected.byteSize)) fail('supplement_file_changed');
      const prior = this.verified.get(relativePath);
      if (prior && !sameFile(prior, opened.stat)) fail('supplement_file_changed');
      const hash = crypto.createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024);
      let offset = 0;
      while (offset < expected.byteSize) {
        assertCurrent(); signal?.throwIfAborted();
        const count = await new Promise((resolve, reject) => fs.read(opened.fd, buffer, 0,
          Math.min(buffer.length, expected.byteSize - offset), offset, (error, bytes) => error ? reject(error) : resolve(bytes)));
        if (count <= 0) fail('supplement_file_changed');
        hash.update(buffer.subarray(0, count)); offset += count;
      }
      if (hash.digest('hex') !== expected.sha256 || !sameFile(opened.stat, fs.fstatSync(opened.fd, { bigint: true }))) fail('supplement_file_changed');
      this.assertNamed(relativePath, opened.stat);
      // Trusted verifier may inherit fd into its isolated child. Keep the pin
      // until its returned promise settles; never pass untrusted path/command.
      const result = await reader({ fd: opened.fd, byteSize: expected.byteSize,
        descriptorPath: `/proc/${process.pid}/fd/${opened.fd}`, role: expected.role });
      assertCurrent(); signal?.throwIfAborted();
      if (!sameFile(opened.stat, fs.fstatSync(opened.fd, { bigint: true }))) fail('supplement_file_changed');
      this.assertNamed(relativePath, opened.stat);
      this.verified.set(relativePath, opened.stat);
      return result;
    } finally { fs.closeSync(opened.fd); }
  }

  async verifyAll(options) {
    for (const name of this.files.keys()) await this.withFile(name, () => {}, options);
  }

  assertAllPinned({ signal = null, assertCurrent = () => {} } = {}) {
    if (this.verified.size !== this.files.size) fail('supplement_files_unverified');
    for (const [name, stat] of this.verified) { signal?.throwIfAborted(); assertCurrent(); this.assertNamed(name, stat); }
  }

  assertComplete({ signal = null, assertCurrent = () => {} } = {}) {
    this.assertPinned();
    const actual = new Set(); let directories = 0;
    const visit = (directory, prefix, depth) => {
      if (depth > 32 || ++directories > MAX_FILES * 2) fail('supplement_inventory_limit');
      for (const entry of fs.readdirSync(`/proc/self/fd/${directory}`, { withFileTypes: true })) {
        signal?.throwIfAborted(); assertCurrent();
        const name = prefix ? `${prefix}/${entry.name}` : entry.name; relative(name);
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) fail('supplement_file_unsafe');
        const fd = fs.openSync(`/proc/self/fd/${directory}/${entry.name}`, flags | fs.constants.O_NONBLOCK
          | (entry.isDirectory() ? fs.constants.O_DIRECTORY : 0));
        try {
          const stat = fs.fstatSync(fd, { bigint: true });
          if (mount(fd) !== this.mountId || (entry.isDirectory() ? !stat.isDirectory() : !stat.isFile())) fail('supplement_file_unsafe');
          if (entry.isDirectory()) visit(fd, name, depth + 1);
          else { actual.add(name); if (actual.size > MAX_FILES || !this.files.has(name)) fail('supplement_unlisted_file'); }
        } finally { fs.closeSync(fd); }
      }
    };
    visit(this.fd, '', 0);
    if (actual.size !== this.files.size) fail('supplement_closure_missing');
    this.assertPinned();
  }

  close() {
    const fd = this.fd, base = this.baseFd;
    this.fd = this.baseFd = null;
    try { if (fd !== null) fs.closeSync(fd); }
    finally { if (base !== null) fs.closeSync(base); }
  }
}

function createPinnedReadCustody({ sourceRoot, supplementRoot, acquireFence, registerVerified, relativeSlot = null } = {}) {
  return async ({ operation, context, inventory, totalByteSize, signal, assertCurrent }) => {
    if (typeof acquireFence !== 'function' || typeof registerVerified !== 'function'
      || typeof assertCurrent !== 'function' || !/^[a-f0-9-]{36}$/.test(operation.id)
      || !/^[a-f0-9]{48}$/.test(operation.lease_token || '')) fail('supplement_custody_unqualified');
    if (!Array.isArray(inventory) || !inventory.length || inventory.length > MAX_FILES
      || !Number.isSafeInteger(totalByteSize) || totalByteSize < 0 || totalByteSize > MAX_BYTES
      || inventory.some(file => !Number.isSafeInteger(file?.byteSize) || file.byteSize < 0)
      || inventory.reduce((sum, file) => sum + file.byteSize, 0) !== totalByteSize) fail('supplement_inventory_limit');
    signal?.throwIfAborted(); assertCurrent();
    // Fencing must be implemented by the supported maintenance/storage owner.
    // A descriptor alone does not stop cleanup or an external writer.
    const fence = await acquireFence({ operation, context, totalByteSize, signal, assertCurrent });
    let source, output, released = false;
    const release = () => {
      if (released) return; released = true;
      try { source?.close(); }
      finally { try { output?.close(); } finally { fence?.release?.(); } }
    };
    try {
      if (!fence || typeof fence.assertActive !== 'function' || typeof fence.release !== 'function') fail('supplement_custody_unqualified');
      const assertFence = () => { if (fence.assertActive() !== true) fail('supplement_fence_lost'); };
      signal?.throwIfAborted(); assertCurrent(); assertFence();
      source = new PinnedSupplementDirectory(sourceRoot, context.input.files);
      const slot = relativeSlot ? relativeSlot({ operation, context }) : `${operation.id}/${operation.lease_token}`;
      relative(slot);
      output = new PinnedSupplementDirectory(supplementRoot, inventory, { relativeRoot: slot });
      const check = () => { signal?.throwIfAborted(); assertCurrent(); assertFence(); };
      return { source, output,
        async verifySource(files, options) {
          if (JSON.stringify(files) !== JSON.stringify(context.input.files)) fail('supplement_source_changed');
          check(); await source.verifyAll({ ...options, assertCurrent: check });
        },
        async verifyOutput(files, options) {
          if (JSON.stringify(files) !== JSON.stringify(inventory)) fail('supplement_inventory_mismatch');
          check(); output.assertComplete({ ...options, assertCurrent: check });
          await output.verifyAll({ ...options, assertCurrent: check });
          output.assertComplete({ ...options, assertCurrent: check });
        },
        assertPinned(options = {}) {
          const guard = options.assertCurrent || check;
          guard(); assertFence(); source.assertAllPinned({ signal, assertCurrent: guard }); output.assertAllPinned({ signal, assertCurrent: guard });
        },
        register(args) {
          // Original failed-state fingerprint has been atomically restored at
          // this point, so use the transaction's fresh lease guard instead.
          args.assertLease(); assertFence(); source.assertAllPinned(); output.assertAllPinned();
          output.assertComplete({ signal, assertCurrent: args.assertLease });
          return registerVerified({ ...args, source, output, fence });
        }, release };
    } catch (error) { try { release(); } catch { error.cleanupIncomplete = true; } throw error; }
  };
}

module.exports = { PinnedSupplementDirectory, createPinnedReadCustody };
