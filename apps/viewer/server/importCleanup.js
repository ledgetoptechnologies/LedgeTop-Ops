'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { hashDescriptor } = require('./importSourceSnapshot');
const { safeRelativePath, sanitizeLogMessage } = require('./processingSecurity');
const { descriptorMountId } = require('./storageManager');

const DIRECTORY_FLAGS = fs.constants.O_RDONLY
  | fs.constants.O_DIRECTORY
  | fs.constants.O_NOFOLLOW
  | fs.constants.O_CLOEXEC;
const FILE_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;
const MAX_CLEANUP_ENTRIES = 100000;
const MAX_CLEANUP_DEPTH = 128;
const QUARANTINE_PAYLOAD = 'payload';
// A job that keeps failing the same way stops after this many claims instead
// of retrying hourly forever. Operators can re-queue it from Diagnostics.
const MAX_CLEANUP_ATTEMPTS = 12;
// Files that are not present by content in a registered dataset are moved
// here (same cache mount, so a rename) instead of being deleted.
const KEPT_FILES_ROOT = 'import-kept-files';
const FAILED_IMPORT_PREFIX = 'failed-import:';
const FAILED_IMPORT_GRACE_MS = 7 * 24 * 3600_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanupError(code, message = code, cause = null) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function procEntry(directoryFd, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw cleanupError('invalid_cleanup_path', 'cleanup path component is invalid');
  }
  return `/proc/self/fd/${directoryFd}/${name}`;
}

function sameEntry(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function sameNode(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function lstatOptional(directoryFd, name) {
  try {
    return fs.lstatSync(procEntry(directoryFd, name), { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function quarantineIsEmpty(directoryFd) {
  return fs.readdirSync(`/proc/self/fd/${directoryFd}`).length === 0;
}

function removeEmptyQuarantine(parentFd, name, heldFd, rootStat) {
  try {
    if (!Number.isInteger(heldFd)) throw cleanupError('cleanup_path_changed', 'cleanup quarantine descriptor is unavailable');
    if (!quarantineIsEmpty(heldFd)) {
      throw cleanupError('cleanup_quarantine_conflict', 'cleanup quarantine contains unexpected entries');
    }
    const held = fs.fstatSync(heldFd, { bigint: true });
    const named = fs.lstatSync(procEntry(parentFd, name), { bigint: true });
    if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameNode(named, held)) {
      throw cleanupError('cleanup_path_changed', 'cleanup quarantine was replaced before deletion');
    }
    requirePrivateDirectory(held, rootStat);
    fs.rmdirSync(procEntry(parentFd, name));
    if (!sameNode(held, fs.fstatSync(heldFd, { bigint: true }))) {
      throw cleanupError('cleanup_path_changed', 'deleted cleanup quarantine descriptor changed');
    }
  } catch (error) {
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
      throw cleanupError('cleanup_quarantine_conflict', 'cleanup quarantine contains unexpected entries', error);
    }
    throw error;
  }
}

function requireOwned(stat, type) {
  const expectedUid = typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : stat.uid;
  if (stat.uid !== expectedUid) {
    throw cleanupError('cleanup_path_untrusted', `${type} cleanup path is not owned by the worker`);
  }
}

function workerIdentity() {
  return {
    uid: typeof process.geteuid === 'function' ? BigInt(process.geteuid()) : null,
    gid: typeof process.getegid === 'function' ? BigInt(process.getegid()) : null,
  };
}

// The quarantine holds a staging tree while it is validated and deleted. Its
// privacy check exists so that no other account can add, swap or read entries
// between validation and deletion. Every deleted entry is also identity-checked
// (no symlinks, nlink 1, same mount, owned by the worker) and, for staging trees,
// verified by content against a registered dataset copy, so privacy is one of
// several guards rather than the only one.
//
// POSIX filesystems honour the explicit chmod to 0700, and that is the normal
// path. ZFS datasets with inherited NFSv4 ACLs (aclmode=restricted) refuse or
// ignore chmod, so a new directory keeps the group bits its parent's ACL grants.
// There the quarantine cannot be more private than the storage root it lives
// in, and requiring 0700 made every cleanup fail forever. On such a filesystem
// the quarantine is accepted only when:
//   - it is owned by the worker user and its group is the worker's own group;
//   - it grants nothing to "other" (no world access);
//   - it is on the same device as the pinned cleanup root;
//   - the pinned cleanup root is itself private in the same sense (owned by the
//     worker user and group, no world access), so the quarantine is no more
//     exposed than everything else under that root already is.
// Anything else (foreign owner or group, world bits, another device, a symlink,
// a non-directory) is refused exactly as before.
function privateToWorker(stat, ids) {
  const mode = Number(stat.mode) & 0o777;
  return (ids.uid === null || stat.uid === ids.uid) && (mode & 0o077) === 0;
}

function sharedOnlyWithWorkerGroup(stat, ids) {
  const mode = Number(stat.mode) & 0o777;
  return (ids.uid === null || stat.uid === ids.uid)
    && (ids.gid === null || stat.gid === ids.gid)
    && (mode & 0o007) === 0;
}

function quarantinePrivacy(stat, rootStat, ids = workerIdentity()) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'not_a_directory' };
  if (ids.uid !== null && stat.uid !== ids.uid) return { ok: false, reason: 'not_owned_by_worker' };
  if (!rootStat || stat.dev !== rootStat.dev) return { ok: false, reason: 'outside_cleanup_root' };
  if (privateToWorker(stat, ids)) return { ok: true, method: 'mode' };
  if ((Number(stat.mode) & 0o007) !== 0) return { ok: false, reason: 'other_users_have_access' };
  if (!sharedOnlyWithWorkerGroup(stat, ids)) return { ok: false, reason: 'foreign_group_has_access' };
  if (!rootStat.isDirectory() || !sharedOnlyWithWorkerGroup(rootStat, ids)) return { ok: false, reason: 'cleanup_root_not_private' };
  return { ok: true, method: 'inherited_acl' };
}

function requirePrivateDirectory(stat, rootStat, ids = workerIdentity()) {
  requireOwned(stat, 'directory');
  const verdict = quarantinePrivacy(stat, rootStat, ids);
  if (!verdict.ok) {
    throw cleanupError('cleanup_path_untrusted', `cleanup quarantine is not private to the worker (${verdict.reason})`);
  }
  return verdict;
}

// Creates the quarantine and applies an explicit chmod through the new
// directory's descriptor (never a path, so a symlink cannot redirect it).
// mkdir's mode is filtered by the umask and, on ACL filesystems, replaced by
// inherited entries; the chmod is the explicit attempt. Only a directory this
// job just created is chmodded: a pre-existing entry at the intent path keeps
// whatever mode it has and must pass requirePrivateDirectory on its own.
function createPrivateDirectory(parentFd, name, hooks = {}) {
  fs.mkdirSync(procEntry(parentFd, name), { mode: 0o700 });
  const fd = fs.openSync(procEntry(parentFd, name), DIRECTORY_FLAGS);
  try {
    const chmod = typeof hooks.chmodQuarantine === 'function' ? hooks.chmodQuarantine : fs.fchmodSync;
    try { chmod(fd, 0o700); } catch { /* ACL filesystems may refuse chmod; requirePrivateDirectory decides */ }
  } finally {
    fs.closeSync(fd);
  }
}

function openDirectoryAt(parentFd, name, expectedMountId) {
  const candidate = procEntry(parentFd, name);
  const before = fs.lstatSync(candidate, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup directory changed');
  let fd;
  try {
    fd = fs.openSync(candidate, DIRECTORY_FLAGS);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameEntry(before, opened)) throw cleanupError('cleanup_path_changed', 'cleanup directory identity changed');
    if (descriptorMountId(fd) !== expectedMountId) throw cleanupError('cleanup_cross_mount', 'cleanup directory crossed a mount boundary');
    return { fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

function openFileAt(parentFd, name, expectedMountId) {
  const candidate = procEntry(parentFd, name);
  const before = fs.lstatSync(candidate, { bigint: true });
  if (!before.isFile() || before.isSymbolicLink()) throw cleanupError('source_changed', 'cleanup source is not a regular file');
  let fd;
  try {
    fd = fs.openSync(candidate, FILE_FLAGS);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameEntry(before, opened)) throw cleanupError('source_changed', 'cleanup source identity changed while opening');
    if (descriptorMountId(fd) !== expectedMountId) throw cleanupError('cleanup_cross_mount', 'cleanup source crossed a mount boundary');
    return { fd, stat: opened };
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw error;
  }
}

function openCleanupParent(storage, rootKey, relativePath) {
  const relative = safeRelativePath(relativePath);
  if (!relative || relative !== relativePath) throw cleanupError('invalid_cleanup_path');
  const segments = relative.split('/');
  const name = segments.pop();
  const root = storage.openCleanupRoot(rootKey);
  let directoryFd = root.fd;
  try {
    for (const segment of segments) {
      const opened = openDirectoryAt(directoryFd, segment, root.mountId);
      fs.closeSync(directoryFd);
      directoryFd = opened.fd;
    }
    return { directoryFd, mountId: root.mountId, rootStat: root.stat, name, relativePath: relative };
  } catch (error) {
    fs.closeSync(directoryFd);
    throw error;
  }
}

// Ready imports own webodm-task-imports/<retained import id>. A failed import
// never got a retained import, so it is journaled under a synthetic
// "failed-import:<operation id>" row that owns webodm-task-imports/<operation id>.
function stagingOwnerName(retainedImportId) {
  const id = String(retainedImportId || '');
  if (!id.startsWith(FAILED_IMPORT_PREFIX)) return id;
  const operationId = id.slice(FAILED_IMPORT_PREFIX.length);
  return UUID.test(operationId) ? operationId : null;
}

function validateStagingJob(job) {
  const owner = stagingOwnerName(job.retained_import_id);
  const expected = owner ? `webodm-task-imports/${owner}` : null;
  if (job.cleanup_type !== 'staging_tree' || job.root_key !== 'cache' || !expected || job.relative_path !== expected) {
    throw cleanupError('invalid_cleanup_target', 'staging cleanup target is not operation-owned');
  }
}

function validateZipJob(job) {
  const relative = safeRelativePath(job.relative_path);
  if (job.cleanup_type !== 'source_zip' || job.root_key !== 'dataset_import' || !relative || relative !== job.relative_path
    || !Number.isSafeInteger(Number(job.expected_byte_size)) || Number(job.expected_byte_size) < 0
    || !/^[a-f0-9]{64}$/.test(String(job.expected_sha256 || ''))
    || ![job.expected_dev, job.expected_ino, job.expected_ctime_ns, job.expected_mtime_ns]
      .every((value) => /^\d+$/.test(String(value || '')))) {
    throw cleanupError('invalid_cleanup_target', 'ZIP cleanup target is invalid');
  }
}

function zipSnapshotMatches(stat, job, { originalTimes = true } = {}) {
  return stat.isFile()
    && !stat.isSymbolicLink()
    && stat.size === BigInt(job.expected_byte_size)
    && String(stat.dev) === String(job.expected_dev)
    && String(stat.ino) === String(job.expected_ino)
    && String(stat.mtimeNs) === String(job.expected_mtime_ns)
    && (!originalTimes || String(stat.ctimeNs) === String(job.expected_ctime_ns));
}

function guardedFilesystemMutation(processing, job, owner, now, mutate) {
  const current = now();
  if (!processing.heartbeatImportCleanup(
    job.id,
    owner,
    job.lease_token,
    job.lease_generation,
    { leaseSeconds: 300, at: current },
  )) throw cleanupError('lease_lost', 'cleanup lease was lost before heartbeat');
  const applied = processing.mutateImportCleanupFilesystem(
    job.id,
    owner,
    job.lease_token,
    job.lease_generation,
    mutate,
    { at: current },
  );
  if (!applied) throw cleanupError('lease_lost', 'cleanup lease was lost before filesystem mutation');
}

function validatePrivateTree(directoryFd, expectedMountId, budget = { entries: 0 }, depth = 0, snapshot = [], prefix = '') {
  if (depth > MAX_CLEANUP_DEPTH) throw cleanupError('cleanup_tree_too_deep');
  const rootBefore = fs.fstatSync(directoryFd, { bigint: true });
  requireOwned(rootBefore, 'staging');
  if (descriptorMountId(directoryFd) !== expectedMountId) throw cleanupError('cleanup_cross_mount');
  const entries = fs.readdirSync(`/proc/self/fd/${directoryFd}`, { withFileTypes: true })
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    budget.entries += 1;
    if (budget.entries > MAX_CLEANUP_ENTRIES) throw cleanupError('cleanup_tree_too_large');
    const entryPath = procEntry(directoryFd, entry.name);
    const before = fs.lstatSync(entryPath, { bigint: true });
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    snapshot.push({
      path: relative,
      dev: String(before.dev),
      ino: String(before.ino),
      mode: String(before.mode),
      size: String(before.size),
      nlink: String(before.nlink),
      ctimeNs: String(before.ctimeNs),
      mtimeNs: String(before.mtimeNs),
    });
    if (before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup tree contains a symbolic link');
    if (before.isDirectory()) {
      const opened = openDirectoryAt(directoryFd, entry.name, expectedMountId);
      try { validatePrivateTree(opened.fd, expectedMountId, budget, depth + 1, snapshot, relative); }
      finally { fs.closeSync(opened.fd); }
    } else if (before.isFile()) {
      let fd;
      try {
        fd = fs.openSync(entryPath, FILE_FLAGS);
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!sameEntry(before, opened) || opened.nlink !== 1n) {
          throw cleanupError('cleanup_path_changed', 'cleanup file identity changed');
        }
        if (descriptorMountId(fd) !== expectedMountId) throw cleanupError('cleanup_cross_mount');
        requireOwned(opened, 'file');
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } else {
      throw cleanupError('cleanup_path_changed', 'cleanup tree contains a special file');
    }
  }
  if (!sameEntry(rootBefore, fs.fstatSync(directoryFd, { bigint: true }))) {
    throw cleanupError('cleanup_path_changed', 'cleanup directory changed during validation');
  }
  return snapshot;
}

function sameClassifiedFile(record, stat) {
  return Boolean(record)
    && record.dev === String(stat.dev)
    && record.ino === String(stat.ino)
    && record.size === String(stat.size)
    && record.ctimeNs === String(stat.ctimeNs)
    && record.mtimeNs === String(stat.mtimeNs);
}

// Deletes only files that the content classification proved redundant and that
// are still the exact same inode, size and timestamps that were hashed.
function requireRedundant(records, relative, stat) {
  if (!records) return;
  const record = records.get(relative);
  if (!record || !record.redundant || !sameClassifiedFile(record, stat)) {
    throw cleanupError('cleanup_path_changed', 'cleanup file was not proven redundant before deletion');
  }
}

function removePrivateTree(directoryFd, expectedMountId, processing, job, owner, now, records = null, budget = { entries: 0 }, depth = 0, prefix = '') {
  if (depth > MAX_CLEANUP_DEPTH) throw cleanupError('cleanup_tree_too_deep');
  const root = fs.fstatSync(directoryFd, { bigint: true });
  requireOwned(root, 'staging');
  if (descriptorMountId(directoryFd) !== expectedMountId) throw cleanupError('cleanup_cross_mount');
  for (const entry of fs.readdirSync(`/proc/self/fd/${directoryFd}`, { withFileTypes: true })) {
    budget.entries += 1;
    if (budget.entries > MAX_CLEANUP_ENTRIES) throw cleanupError('cleanup_tree_too_large');
    const entryPath = procEntry(directoryFd, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const before = fs.lstatSync(entryPath, { bigint: true });
    if (before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup tree contains a symbolic link');
    if (before.isDirectory()) {
      const opened = openDirectoryAt(directoryFd, entry.name, expectedMountId);
      try {
        removePrivateTree(opened.fd, expectedMountId, processing, job, owner, now, records, budget, depth + 1, relative);
        guardedFilesystemMutation(processing, job, owner, now, () => {
          const held = fs.fstatSync(opened.fd, { bigint: true });
          const named = fs.lstatSync(entryPath, { bigint: true });
          if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameNode(named, held)) {
            throw cleanupError('cleanup_path_changed', 'cleanup directory was replaced before deletion');
          }
          requireOwned(held, 'directory');
          fs.rmdirSync(entryPath);
          if (!sameNode(held, fs.fstatSync(opened.fd, { bigint: true }))) {
            throw cleanupError('cleanup_path_changed', 'deleted cleanup directory descriptor changed');
          }
        });
      } finally {
        fs.closeSync(opened.fd);
      }
    } else if (before.isFile()) {
      let fd;
      try {
        fd = fs.openSync(entryPath, FILE_FLAGS);
        const opened = fs.fstatSync(fd, { bigint: true });
        if (!sameEntry(before, opened) || opened.nlink !== 1n) {
          throw cleanupError('cleanup_path_changed', 'cleanup file identity changed before deletion');
        }
        if (descriptorMountId(fd) !== expectedMountId) throw cleanupError('cleanup_cross_mount');
        requireOwned(opened, 'file');
        requireRedundant(records, relative, opened);
        guardedFilesystemMutation(processing, job, owner, now, () => {
          const named = fs.lstatSync(entryPath, { bigint: true });
          if (!sameEntry(named, opened) || named.isSymbolicLink() || named.nlink !== 1n) {
            throw cleanupError('cleanup_path_changed', 'cleanup file was replaced before deletion');
          }
          requireOwned(named, 'file');
          requireRedundant(records, relative, named);
          fs.unlinkSync(entryPath);
        });
        if (!sameNode(opened, fs.fstatSync(fd, { bigint: true }))) {
          throw cleanupError('cleanup_path_changed', 'deleted cleanup file descriptor changed');
        }
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    } else {
      throw cleanupError('cleanup_path_changed', 'cleanup tree contains a special file');
    }
  }
}

function asLeaseOrChanged(error, message) {
  if (error?.code === 'lease_lost') return error;
  return cleanupError('cleanup_path_changed', message, error);
}

// A dataset registry row is not proof on its own: the dataset copy is opened
// without following symlinks and hashed before a staging file counts as
// redundant. Results are cached per run so each dataset file is read once.
async function verifyDatasetCopy(storage, candidate, byteSize, sha256, verified, signal) {
  const relative = `${candidate.datasetRelativePath}/${candidate.relativePath}`;
  if (verified.has(relative)) return verified.get(relative) === sha256;
  let fd;
  let result = null;
  try {
    const datasetsRoot = fs.realpathSync.native(storage.roots.datasets);
    const absolute = storage.resolve('datasets', relative, { mustExist: true });
    const real = fs.realpathSync.native(absolute);
    if (real === absolute && real.startsWith(`${datasetsRoot}${path.sep}`)) {
      fd = fs.openSync(real, FILE_FLAGS);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.isFile() && stat.size === BigInt(byteSize)) result = await hashDescriptor(fd, stat, { signal });
    }
  } catch (error) {
    if (error?.code === 'lease_lost' || signal?.aborted) throw cleanupError('lease_lost');
    result = null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  verified.set(relative, result);
  return result === sha256;
}

function retainedCopyMatcher(storage, copies, signal) {
  const index = new Map();
  for (const file of copies?.files || []) {
    const key = `${file.byteSize}:${file.sha256}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  }
  const verified = new Map();
  return async (byteSize, sha256) => {
    for (const candidate of index.get(`${byteSize}:${sha256}`) || []) {
      if (await verifyDatasetCopy(storage, candidate, byteSize, sha256, verified, signal)) {
        return `${candidate.datasetRelativePath}/${candidate.relativePath}`;
      }
    }
    return null;
  };
}

// Hashes every file in the quarantined staging tree and records whether an
// identical copy (same size and SHA-256) exists in a registered dataset.
async function classifyPrivateTree(directoryFd, expectedMountId, findCopy, {
  signal = null, records = new Map(), budget = { entries: 0 }, depth = 0, prefix = '',
} = {}) {
  if (depth > MAX_CLEANUP_DEPTH) throw cleanupError('cleanup_tree_too_deep');
  const entries = fs.readdirSync(`/proc/self/fd/${directoryFd}`, { withFileTypes: true })
    .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
  for (const entry of entries) {
    if (signal?.aborted) throw cleanupError('lease_lost');
    budget.entries += 1;
    if (budget.entries > MAX_CLEANUP_ENTRIES) throw cleanupError('cleanup_tree_too_large');
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const before = fs.lstatSync(procEntry(directoryFd, entry.name), { bigint: true });
    if (before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup tree contains a symbolic link');
    if (before.isDirectory()) {
      const opened = openDirectoryAt(directoryFd, entry.name, expectedMountId);
      try {
        await classifyPrivateTree(opened.fd, expectedMountId, findCopy, { signal, records, budget, depth: depth + 1, prefix: relative });
      } finally {
        fs.closeSync(opened.fd);
      }
    } else if (before.isFile()) {
      let opened;
      try { opened = openFileAt(directoryFd, entry.name, expectedMountId); }
      catch (error) { throw error?.code === 'source_changed' ? asLeaseOrChanged(error, 'cleanup file changed while opening') : error; }
      try {
        if (opened.stat.nlink !== 1n) throw cleanupError('cleanup_path_changed', 'cleanup file has multiple hard links');
        requireOwned(opened.stat, 'file');
        let sha256;
        try { sha256 = await hashDescriptor(opened.fd, opened.stat, { signal }); }
        catch (error) { throw asLeaseOrChanged(error, 'cleanup file changed while hashing'); }
        const byteSize = Number(opened.stat.size);
        const copy = await findCopy(byteSize, sha256);
        records.set(relative, {
          path: relative,
          dev: String(opened.stat.dev),
          ino: String(opened.stat.ino),
          size: String(opened.stat.size),
          ctimeNs: String(opened.stat.ctimeNs),
          mtimeNs: String(opened.stat.mtimeNs),
          byteSize,
          sha256,
          redundant: Boolean(copy),
          copy: copy || null,
        });
      } finally {
        fs.closeSync(opened.fd);
      }
    } else {
      throw cleanupError('cleanup_path_changed', 'cleanup tree contains a special file');
    }
  }
  return records;
}

function openOrCreateKeptDirectory(parentFd, name, mountId, fence) {
  if (!lstatOptional(parentFd, name)) {
    fence(() => {
      if (!lstatOptional(parentFd, name)) fs.mkdirSync(procEntry(parentFd, name), { mode: 0o700 });
    });
  }
  const opened = openDirectoryAt(parentFd, name, mountId);
  try {
    requireOwned(opened.stat, 'kept files');
  } catch (error) {
    fs.closeSync(opened.fd);
    throw error;
  }
  return opened;
}

// Moves every file that has no verified dataset copy out of the quarantine into
// cache/import-kept-files/<staging name>/, keeping its relative path, and writes
// a manifest beside it. The move is a rename on the same mount, so it costs no
// space and no copy. Nothing that exists only here is ever deleted.
function preserveUniqueFiles({ processing, storage }, job, owner, now, payloadFd, mountId, records, copies) {
  const unique = [...records.values()].filter((record) => !record.redundant);
  if (!unique.length) return null;
  const fence = (mutate) => guardedFilesystemMutation(processing, job, owner, now, mutate);
  const keptName = stagingOwnerName(job.retained_import_id);
  if (!keptName) throw cleanupError('invalid_cleanup_target', 'kept files location is invalid');
  const root = storage.openCleanupRoot('cache');
  const held = [root.fd];
  try {
    if (root.mountId !== mountId) throw cleanupError('cleanup_cross_mount', 'kept files root is on another mount');
    const base = openOrCreateKeptDirectory(root.fd, KEPT_FILES_ROOT, mountId, fence);
    held.push(base.fd);
    const kept = openOrCreateKeptDirectory(base.fd, keptName, mountId, fence);
    held.push(kept.fd);
    for (const record of unique) {
      const segments = record.path.split('/');
      const name = segments.pop();
      const opened = [];
      try {
        let sourceFd = payloadFd;
        let targetFd = kept.fd;
        for (const segment of segments) {
          const sourceDirectory = openDirectoryAt(sourceFd, segment, mountId);
          opened.push(sourceDirectory.fd);
          sourceFd = sourceDirectory.fd;
          const targetDirectory = openOrCreateKeptDirectory(targetFd, segment, mountId, fence);
          opened.push(targetDirectory.fd);
          targetFd = targetDirectory.fd;
        }
        fence(() => {
          const named = fs.lstatSync(procEntry(sourceFd, name), { bigint: true });
          if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || !sameClassifiedFile(record, named)) {
            throw cleanupError('cleanup_path_changed', 'file changed before it could be kept');
          }
          if (lstatOptional(targetFd, name)) {
            throw cleanupError('cleanup_quarantine_conflict', 'kept file destination already exists');
          }
          fs.renameSync(procEntry(sourceFd, name), procEntry(targetFd, name));
          const moved = fs.lstatSync(procEntry(targetFd, name), { bigint: true });
          if (!sameNode(moved, named)) throw cleanupError('cleanup_path_changed', 'kept file identity changed while moving');
        });
        fence(() => fs.fsyncSync(targetFd));
      } finally {
        for (let index = opened.length - 1; index >= 0; index -= 1) fs.closeSync(opened[index]);
      }
    }
    const manifestName = `kept-files.${Number(job.lease_generation) || 0}.json`;
    const byteSize = unique.reduce((sum, record) => sum + record.byteSize, 0);
    const manifest = {
      schemaVersion: 1,
      cleanupJobId: job.id,
      retainedImportId: job.retained_import_id,
      stagingRelativePath: job.relative_path,
      comparedDatasetIds: (copies?.datasets || []).map((dataset) => dataset.id),
      reason: 'not present by size and SHA-256 in a registered dataset',
      files: unique.map((record) => ({ path: record.path, byteSize: record.byteSize, sha256: record.sha256 })),
    };
    fence(() => {
      if (lstatOptional(kept.fd, manifestName)) return;
      const fd = fs.openSync(
        procEntry(kept.fd, manifestName),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC,
        0o600,
      );
      try {
        fs.writeSync(fd, `${JSON.stringify(manifest, null, 2)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    });
    fence(() => fs.fsyncSync(kept.fd));
    fence(() => fs.fsyncSync(base.fd));
    const summary = {
      keptRelativePath: `${KEPT_FILES_ROOT}/${keptName}`,
      fileCount: unique.length,
      byteSize,
    };
    processing.recordImportCleanupPreserved?.(job.id, { retainedImportId: job.retained_import_id, ...summary });
    return summary;
  } finally {
    for (let index = held.length - 1; index >= 0; index -= 1) fs.closeSync(held[index]);
  }
}

async function executeStagingCleanup({ processing, storage }, job, owner, { now, hooks = {}, signal = null, log = null }) {
  if (signal?.aborted) throw cleanupError('lease_lost');
  validateStagingJob(job);
  const copies = processing.importCleanupRetainedCopies(job.retained_import_id);
  const quarantineRelativePath = processing.persistImportCleanupQuarantineIntent(
    job.id,
    owner,
    job.lease_token,
    job.lease_generation,
    { at: now() },
  );
  if (!quarantineRelativePath) throw cleanupError('lease_lost');
  if (path.posix.dirname(quarantineRelativePath) !== path.posix.dirname(job.relative_path)) {
    throw cleanupError('invalid_cleanup_path', 'cleanup quarantine is not a sibling');
  }

  const source = openCleanupParent(storage, job.root_key, job.relative_path);
  try {
    let quarantineFd;
    let stagingFd;
    try {
    const quarantineName = path.posix.basename(quarantineRelativePath);
    let sourceStat = lstatOptional(source.directoryFd, source.name);
    let quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    if (!quarantineStat && !sourceStat && job.status === 'quarantined') {
      guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));
      if (!processing.completeImportCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
        throw cleanupError('lease_lost');
      }
      return;
    }
    if (sourceStat && !copies?.datasets?.length) {
      // Nothing is moved while there is no finalized dataset to compare with.
      throw cleanupError('cleanup_dataset_unavailable', 'no finalized dataset is registered for this staging');
    }
    if (!quarantineStat) {
      if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw cleanupError('cleanup_path_changed', 'staging cleanup source is unavailable');
      }
      requireOwned(sourceStat, 'staging');
      guardedFilesystemMutation(processing, job, owner, now, () => {
        createPrivateDirectory(source.directoryFd, quarantineName, hooks);
      });
      quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    }
    if (!quarantineStat?.isDirectory() || quarantineStat.isSymbolicLink()) throw cleanupError('cleanup_path_changed');
    requirePrivateDirectory(quarantineStat, source.rootStat);
    const opened = openDirectoryAt(source.directoryFd, quarantineName, source.mountId);
    quarantineFd = opened.fd;
    requirePrivateDirectory(opened.stat, source.rootStat);
    const existingPayload = lstatOptional(quarantineFd, QUARANTINE_PAYLOAD);

    if (sourceStat) {
      if (existingPayload) throw cleanupError('cleanup_path_changed', 'staging source and quarantine both contain data');
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) throw cleanupError('cleanup_path_changed');
      requireOwned(sourceStat, 'staging');
      const staging = openDirectoryAt(source.directoryFd, source.name, source.mountId);
      stagingFd = staging.fd;
      if (!sameEntry(sourceStat, staging.stat)) {
        throw cleanupError('cleanup_path_changed', 'staging source changed while opening');
      }
      guardedFilesystemMutation(processing, job, owner, now, () => {
        if (!quarantineIsEmpty(quarantineFd)) throw cleanupError('cleanup_quarantine_conflict');
        hooks.beforeQuarantineRename?.({ job });
        if (!quarantineIsEmpty(quarantineFd)) throw cleanupError('cleanup_quarantine_conflict');
        const held = fs.fstatSync(stagingFd, { bigint: true });
        const named = fs.lstatSync(procEntry(source.directoryFd, source.name), { bigint: true });
        if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameEntry(named, held)) {
          throw cleanupError('cleanup_path_changed', 'staging source was replaced before quarantine');
        }
        fs.renameSync(procEntry(source.directoryFd, source.name), procEntry(quarantineFd, QUARANTINE_PAYLOAD));
        const moved = fs.lstatSync(procEntry(quarantineFd, QUARANTINE_PAYLOAD), { bigint: true });
        if (!sameNode(moved, fs.fstatSync(stagingFd, { bigint: true }))) {
          throw cleanupError('cleanup_path_changed', 'quarantined staging source identity changed');
        }
        hooks.afterQuarantineRename?.({ job });
      });
      sourceStat = null;
    }
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(quarantineFd));
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));

    if (lstatOptional(source.directoryFd, source.name)) {
      throw cleanupError('cleanup_path_changed', 'staging source reappeared after quarantine');
    }
    const payloadStat = lstatOptional(quarantineFd, QUARANTINE_PAYLOAD);
    if (!payloadStat) {
      if (job.status !== 'quarantined') throw cleanupError('cleanup_path_changed', 'staging quarantine payload is missing');
    } else {
      const payload = openDirectoryAt(quarantineFd, QUARANTINE_PAYLOAD, source.mountId);
      try {
        const validatedTree = validatePrivateTree(payload.fd, source.mountId);
        hooks.afterStagingValidation?.({ job });
        const confirmedTree = validatePrivateTree(payload.fd, source.mountId);
        if (JSON.stringify(validatedTree) !== JSON.stringify(confirmedTree)) {
          throw cleanupError('cleanup_path_changed', 'cleanup tree changed after validation');
        }
        if (job.status === 'leased' && !processing.markImportCleanupQuarantined(
          job.id, owner, job.lease_token, job.lease_generation, { at: now() },
        )) throw cleanupError('lease_lost');
        const records = await classifyPrivateTree(
          payload.fd, source.mountId, retainedCopyMatcher(storage, copies, signal), { signal },
        );
        hooks.afterStagingClassification?.({ job, records });
        const kept = preserveUniqueFiles({ processing, storage }, job, owner, now, payload.fd, source.mountId, records, copies);
        if (kept) {
          log?.log?.(`Import cleanup ${job.id}: kept ${kept.fileCount} file(s), ${kept.byteSize} bytes, with no dataset copy under ${kept.keptRelativePath}`);
        }
        removePrivateTree(payload.fd, source.mountId, processing, job, owner, now, records);
        guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(payload.fd));
        guardedFilesystemMutation(processing, job, owner, now, () => {
          const held = fs.fstatSync(payload.fd, { bigint: true });
          const named = fs.lstatSync(procEntry(quarantineFd, QUARANTINE_PAYLOAD), { bigint: true });
          if (!held.isDirectory() || !named.isDirectory() || named.isSymbolicLink() || !sameNode(named, held)) {
            throw cleanupError('cleanup_path_changed', 'staging payload was replaced before deletion');
          }
          requireOwned(held, 'directory');
          fs.rmdirSync(procEntry(quarantineFd, QUARANTINE_PAYLOAD));
          if (!sameNode(held, fs.fstatSync(payload.fd, { bigint: true }))) {
            throw cleanupError('cleanup_path_changed', 'deleted staging payload descriptor changed');
          }
        });
        guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(quarantineFd));
      } finally {
        fs.closeSync(payload.fd);
      }
    }

    const quarantineNameAfter = path.posix.basename(quarantineRelativePath);
    if (lstatOptional(source.directoryFd, quarantineNameAfter)) {
      guardedFilesystemMutation(processing, job, owner, now, () => {
        removeEmptyQuarantine(source.directoryFd, quarantineNameAfter, quarantineFd, source.rootStat);
        hooks.afterQuarantineRemove?.({ job });
      });
    }
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));
    } finally {
      if (stagingFd !== undefined) fs.closeSync(stagingFd);
      if (quarantineFd !== undefined) fs.closeSync(quarantineFd);
    }

    if (!processing.completeImportCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
      throw cleanupError('lease_lost');
    }
  } finally {
    fs.closeSync(source.directoryFd);
  }
}

async function executeZipCleanup({ processing, storage }, job, owner, { now, hooks = {}, signal = null }) {
  if (signal?.aborted) throw cleanupError('lease_lost');
  validateZipJob(job);
  const source = openCleanupParent(storage, job.root_key, job.relative_path);
  let quarantineFd;
  let payloadFd;
  try {
    const sourceStat = lstatOptional(source.directoryFd, source.name);
    const existingIntent = job.quarantine_relative_path;
    if (!existingIntent) {
      if (!sourceStat) throw cleanupError('source_changed', 'source ZIP disappeared before cleanup');
      const opened = openFileAt(source.directoryFd, source.name, source.mountId);
      try {
        if (opened.stat.nlink !== 1n) throw cleanupError('cleanup_skipped_hardlink', 'source ZIP has multiple hard links');
        if (!zipSnapshotMatches(opened.stat, job)) throw cleanupError('source_changed', 'source ZIP identity changed');
      } finally {
        fs.closeSync(opened.fd);
      }
    }

    const quarantineRelativePath = processing.persistImportCleanupQuarantineIntent(
      job.id,
      owner,
      job.lease_token,
      job.lease_generation,
      { at: now() },
    );
    if (!quarantineRelativePath) throw cleanupError('lease_lost');
    if (path.posix.dirname(quarantineRelativePath) !== path.posix.dirname(job.relative_path)) {
      throw cleanupError('invalid_cleanup_path', 'ZIP quarantine is not a sibling');
    }
    const quarantineName = path.posix.basename(quarantineRelativePath);
    let quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    let currentSource = lstatOptional(source.directoryFd, source.name);
    if (!quarantineStat && !currentSource && job.status === 'quarantined') {
      guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));
      if (!processing.completeImportCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
        throw cleanupError('lease_lost');
      }
      return;
    }
    if (!quarantineStat) {
      if (!currentSource) throw cleanupError('source_changed', 'source ZIP disappeared before quarantine');
      guardedFilesystemMutation(processing, job, owner, now, () => {
        createPrivateDirectory(source.directoryFd, quarantineName, hooks);
      });
      quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    }
    if (!quarantineStat?.isDirectory() || quarantineStat.isSymbolicLink()) throw cleanupError('source_changed');
    try { requirePrivateDirectory(quarantineStat, source.rootStat); }
    catch { throw cleanupError('source_changed', 'ZIP quarantine is not private'); }
    const quarantine = openDirectoryAt(source.directoryFd, quarantineName, source.mountId);
    quarantineFd = quarantine.fd;
    try { requirePrivateDirectory(quarantine.stat, source.rootStat); }
    catch { throw cleanupError('source_changed', 'ZIP quarantine is not private'); }
    const existingPayload = lstatOptional(quarantineFd, QUARANTINE_PAYLOAD);

    if (currentSource) {
      if (existingPayload) throw cleanupError('source_changed', 'source and quarantined ZIP both exist');
      const opened = openFileAt(source.directoryFd, source.name, source.mountId);
      try {
        if (opened.stat.nlink !== 1n) throw cleanupError('cleanup_skipped_hardlink', 'source ZIP has multiple hard links');
        if (!zipSnapshotMatches(opened.stat, job)) {
          throw cleanupError('source_changed', 'source ZIP changed before quarantine');
        }
        guardedFilesystemMutation(processing, job, owner, now, () => {
          if (!quarantineIsEmpty(quarantineFd)) throw cleanupError('cleanup_quarantine_conflict');
          hooks.beforeQuarantineRename?.({ job });
          if (!quarantineIsEmpty(quarantineFd)) throw cleanupError('cleanup_quarantine_conflict');
          fs.renameSync(procEntry(source.directoryFd, source.name), procEntry(quarantineFd, QUARANTINE_PAYLOAD));
          hooks.afterQuarantineRename?.({ job });
        });
      } finally {
        fs.closeSync(opened.fd);
      }
      currentSource = null;
    }
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(quarantineFd));
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));

    if (lstatOptional(source.directoryFd, source.name)) throw cleanupError('source_changed', 'source ZIP reappeared after quarantine');
    const payloadStat = lstatOptional(quarantineFd, QUARANTINE_PAYLOAD);
    if (!payloadStat) {
      if (job.status !== 'quarantined') throw cleanupError('source_changed', 'ZIP quarantine payload is missing');
    } else {
      const payload = openFileAt(quarantineFd, QUARANTINE_PAYLOAD, source.mountId);
      payloadFd = payload.fd;
      if (!zipSnapshotMatches(payload.stat, job, { originalTimes: false }) || payload.stat.nlink !== 1n) {
        throw cleanupError('source_changed', 'quarantined ZIP identity changed');
      }
      hooks.beforeQuarantineHash?.({ job });
      const sha256 = await hashDescriptor(payload.fd, payload.stat, { signal });
      const afterHash = fs.fstatSync(payload.fd, { bigint: true });
      if (sha256 !== job.expected_sha256 || !sameEntry(payload.stat, afterHash) || afterHash.nlink !== 1n
        || lstatOptional(source.directoryFd, source.name)) {
        throw cleanupError('source_changed', 'quarantined ZIP content changed');
      }
      if (job.status === 'leased' && !processing.markImportCleanupQuarantined(
        job.id, owner, job.lease_token, job.lease_generation, { at: now() },
      )) throw cleanupError('lease_lost');
      guardedFilesystemMutation(processing, job, owner, now, () => {
        const named = fs.lstatSync(procEntry(quarantineFd, QUARANTINE_PAYLOAD), { bigint: true });
        const held = fs.fstatSync(payload.fd, { bigint: true });
        if (!sameEntry(named, held) || held.nlink !== 1n || lstatOptional(source.directoryFd, source.name)) {
          throw cleanupError('source_changed', 'ZIP changed immediately before deletion');
        }
        fs.unlinkSync(procEntry(quarantineFd, QUARANTINE_PAYLOAD));
        hooks.afterQuarantineDelete?.({ job });
      });
      guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(quarantineFd));
      fs.closeSync(payloadFd);
      payloadFd = undefined;
    }

    const quarantineNameAfter = path.posix.basename(quarantineRelativePath);
    if (lstatOptional(source.directoryFd, quarantineNameAfter)) {
      guardedFilesystemMutation(processing, job, owner, now, () => {
        removeEmptyQuarantine(source.directoryFd, quarantineNameAfter, quarantineFd, source.rootStat);
        hooks.afterQuarantineRemove?.({ job });
      });
    }
    guardedFilesystemMutation(processing, job, owner, now, () => fs.fsyncSync(source.directoryFd));
    if (!processing.completeImportCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
      throw cleanupError('lease_lost');
    }
  } finally {
    if (payloadFd !== undefined) fs.closeSync(payloadFd);
    if (quarantineFd !== undefined) fs.closeSync(quarantineFd);
    fs.closeSync(source.directoryFd);
  }
}

function terminalCleanupOutcome(error) {
  const code = String(error?.code || '');
  if (code === 'source_changed') return 'source_changed';
  if (code === 'cleanup_skipped_hardlink') return 'cleanup_skipped_hardlink';
  if (code === 'cleanup_quarantine_conflict') return 'cleanup_quarantine_conflict';
  if (code === 'cleanup_cross_mount' || code === 'EXDEV') return 'cleanup_skipped_cross_mount';
  if (code === 'cleanup_skipped_read_only' || code === 'EROFS') return 'cleanup_skipped_read_only';
  return null;
}

let cleanupActive = false;

// A job stops retrying once it has been claimed MAX_CLEANUP_ATTEMPTS times and
// the latest failure repeats the previous one (same error code), or after four
// times that many claims in any case. The check runs only after an attempt
// fails, so jobs that already looped for months still get one fresh attempt
// with the current code before they stop.
function retriesExhausted(job, code) {
  const attempts = Number(job?.attempt_count) || 0;
  const previous = String(job?.last_error || '').split(':')[0];
  return (attempts >= MAX_CLEANUP_ATTEMPTS && previous === code) || attempts >= MAX_CLEANUP_ATTEMPTS * 4;
}

async function processOneImportCleanup(deps, owner, { now = Date.now, leaseSeconds = 300, hooks = {}, log = console } = {}) {
  if (cleanupActive) return false;
  cleanupActive = true;
  let job = null;
  let heartbeatTimer = null;
  const controller = new AbortController();
  try {
    job = deps.processing.claimImportCleanup(owner, { leaseSeconds, at: now() });
    if (!job) return false;
    const heartbeat = () => {
      if (!deps.processing.heartbeatImportCleanup(
        job.id,
        owner,
        job.lease_token,
        job.lease_generation,
        { leaseSeconds, at: now() },
      )) controller.abort();
    };
    heartbeatTimer = setInterval(heartbeat, 2000);
    heartbeatTimer.unref?.();
    if (job.cleanup_type === 'staging_tree') await executeStagingCleanup(deps, job, owner, { now, hooks, signal: controller.signal, log });
    else if (job.cleanup_type === 'source_zip') await executeZipCleanup(deps, job, owner, { now, hooks, signal: controller.signal });
    else throw cleanupError('invalid_cleanup_target', 'cleanup type is not implemented');
    log?.log?.(`Import cleanup ${job.id}: complete after ${Number(job.attempt_count) || 0} attempt(s)`);
    return true;
  } catch (error) {
    if (job && error?.code !== 'lease_lost') {
      const code = String(error?.code || 'cleanup_failed');
      const message = `${code}: ${sanitizeLogMessage(error?.message || 'cleanup failed')}`;
      const outcome = terminalCleanupOutcome(error);
      const attempts = Number(job.attempt_count) || 0;
      if ((!outcome || outcome === 'cleanup_quarantine_conflict') && retriesExhausted(job, code)) {
        const failed = deps.processing.failImportCleanup(
          job.id,
          owner,
          job.lease_token,
          job.lease_generation,
          `cleanup_retry_exhausted: stopped after ${attempts} attempts; last error ${message}`,
          { at: now() },
        );
        if (failed) {
          log?.warn?.(`Import cleanup ${job.id}: marked failed after ${attempts} attempts; last error ${message.slice(0, 300)}`);
          return true;
        }
      }
      log?.warn?.(`Import cleanup ${job.id}: attempt ${attempts} failed${outcome ? ` (${outcome})` : ''}: ${message.slice(0, 300)}`);
      if ((!outcome || outcome === 'cleanup_quarantine_conflict') && deps.processing.deferQuarantinedImportCleanup(
        job.id,
        owner,
        job.lease_token,
        job.lease_generation,
        message,
        { at: now(), outcome: outcome || 'cleanup_deferred' },
      )) return true;
      if (outcome) {
        deps.processing.completeImportCleanupWithoutDelete(
          job.id,
          owner,
          job.lease_token,
          job.lease_generation,
          outcome,
          message,
          { at: now() },
        );
      } else {
        deps.processing.retryImportCleanup(
          job.id,
          owner,
          job.lease_token,
          job.lease_generation,
          message,
          { at: now() },
        );
      }
    }
    return Boolean(job);
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    cleanupActive = false;
  }
}

// WebODM imports that failed or were cancelled before their retained import
// became ready never got a cleanup job, so their cache staging stayed forever.
// After a grace period that leaves time for an operator retry, this journals a
// staging cleanup for them. It runs through the same quarantine, content
// classification and preserve-unique-files path as a ready import, compared
// against the finalized datasets of the operation's project.
function journalFailedImportStagingCleanups({ processing, storage }, {
  now = Date.now, graceMs = FAILED_IMPORT_GRACE_MS, scanLimit = 500, limit = 20,
} = {}) {
  const at = now();
  const candidates = processing.failedImportStagingCandidates({ at, graceMs, limit: scanLimit });
  let journaled = 0;
  for (const candidate of candidates) {
    if (journaled >= limit) break;
    if (!UUID.test(candidate.operationId)) continue;
    let stat = null;
    try { stat = fs.lstatSync(storage.resolve('cache', `webodm-task-imports/${candidate.operationId}`)); } catch { stat = null; }
    if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (processing.journalFailedImportStagingCleanup(candidate.operationId, { at, graceMs })) journaled += 1;
  }
  return { scanned: candidates.length, journaled };
}

module.exports = {
  FAILED_IMPORT_PREFIX,
  KEPT_FILES_ROOT,
  MAX_CLEANUP_ATTEMPTS,
  executeStagingCleanup,
  executeZipCleanup,
  journalFailedImportStagingCleanups,
  processOneImportCleanup,
  quarantinePrivacy,
};
