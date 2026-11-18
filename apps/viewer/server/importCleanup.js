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
    requirePrivateDirectory(held, rootStat, workerIdentity(), fs.fstatSync(parentFd, { bigint: true }));
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

// The quarantine holds a staging tree or source ZIP while it is validated and
// deleted. Its privacy check exists so that no other account can add, swap or
// read entries between validation and deletion. Deleted entries are also
// identity-checked (no symlinks, nlink 1, same mount, owned by the worker) and,
// for staging trees, verified by content against a dataset copy, so privacy is
// one guard among several.
//
// Rule, using mode bits only:
//   1. After the explicit chmod to 0700, the quarantine must be owned by the
//      worker and have no group or other permission bits. POSIX filesystems
//      honour the chmod, so this is the normal path.
//   2. ZFS datasets with inherited NFSv4 ACLs (aclmode=restricted) refuse or
//      ignore that chmod and leave the inherited group bits. There the
//      quarantine is accepted only if it has no "other" bits, its group is the
//      worker's, and BOTH the pinned cleanup root and the quarantine's parent
//      folder (for example webodm-task-imports/) are strictly private by rule 1:
//      owned by the worker, no group or other bits. Then nobody but the worker
//      can reach the quarantine through the mode bits.
// A shared apps group does not count as private: on a NAS every app may run in
// it. Named-user and named-group ACL entries are NOT visible in mode bits, so
// this check cannot see them; a dataset that grants other accounts access
// through named ACL entries must be fixed at the ACL level.
// Anything else (foreign owner, group or world bits on the root or parent,
// another device, a symlink, a non-directory) is refused.
function privateToWorker(stat, ids) {
  const mode = Number(stat.mode) & 0o777;
  return Boolean(stat) && stat.isDirectory() && !stat.isSymbolicLink()
    && (ids.uid === null || stat.uid === ids.uid) && (mode & 0o077) === 0;
}

function quarantinePrivacy(stat, rootStat, ids = workerIdentity(), parentStat = rootStat) {
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, reason: 'not_a_directory' };
  if (ids.uid !== null && stat.uid !== ids.uid) return { ok: false, reason: 'not_owned_by_worker' };
  if (!rootStat || stat.dev !== rootStat.dev) return { ok: false, reason: 'outside_cleanup_root' };
  if (privateToWorker(stat, ids)) return { ok: true, method: 'mode' };
  if ((Number(stat.mode) & 0o007) !== 0) return { ok: false, reason: 'other_users_have_access' };
  if (ids.gid !== null && stat.gid !== ids.gid) return { ok: false, reason: 'foreign_group_has_access' };
  if (!privateToWorker(rootStat, ids)) return { ok: false, reason: 'cleanup_root_not_private' };
  if (!parentStat || parentStat.dev !== rootStat.dev || !privateToWorker(parentStat, ids)) {
    return { ok: false, reason: 'cleanup_parent_not_private' };
  }
  return { ok: true, method: 'private_root' };
}

function requirePrivateDirectory(stat, rootStat, ids = workerIdentity(), parentStat = rootStat) {
  requireOwned(stat, 'directory');
  const verdict = quarantinePrivacy(stat, rootStat, ids, parentStat);
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
    return { directoryFd, mountId: root.mountId, rootStat: root.stat, parentStat: fs.fstatSync(directoryFd, { bigint: true }), name, relativePath: relative };
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
// At delete time (inside the unlink fence) the dataset copy relied on is
// re-checked too: its dataset must still be finalized and untrashed and its
// file must still be the inode, size and mtime that was hashed. If not, the
// staging file is not deleted; the next attempt reclassifies and keeps it.
function requireRedundant(records, relative, stat, { atDelete = false } = {}) {
  if (!records) return;
  const record = records.get(relative);
  if (!record || !record.redundant || !sameClassifiedFile(record, stat)) {
    throw cleanupError('cleanup_path_changed', 'cleanup file was not proven redundant before deletion');
  }
  if (atDelete) {
    if (typeof records.confirmCopy !== 'function' || !records.confirmCopy(record)) {
      throw cleanupError('cleanup_copy_changed', 'the dataset copy changed after it was verified; the staging file is kept');
    }
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
          requireRedundant(records, relative, named, { atDelete: true });
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

// Hashing is bounded per claim and resumable. Verified hashes are stored in
// the database (trusted, unlike files in the shared cache), keyed by the
// file's identity (path, device, inode, size, mtime, ctime), so a changed file
// is always re-hashed. When the per-claim byte budget is spent the job saves
// its progress and is re-claimed shortly after with the same lease rules.
const DEFAULT_MAX_HASH_BYTES = 16 * 1024 ** 3;

function identityKey(name, stat) {
  return `${name}|${stat.dev}|${stat.ino}|${stat.size}|${stat.mtimeNs}|${stat.ctimeNs}`;
}

function createHasher({ processing, job, owner, now, signal, hooks = {}, maxBytes = DEFAULT_MAX_HASH_BYTES }) {
  const loaded = processing.loadImportCleanupHashes?.(job.id);
  const state = { staging: { ...(loaded?.staging || {}) }, dataset: { ...(loaded?.dataset || {}) } };
  let spent = 0;
  let dirty = 0;
  const save = () => {
    if (!dirty || typeof processing.saveImportCleanupHashes !== 'function') return;
    if (!processing.saveImportCleanupHashes(job.id, owner, job.lease_token, job.lease_generation, state, { at: now() })) {
      throw cleanupError('lease_lost', 'cleanup lease was lost while saving hash progress');
    }
    dirty = 0;
  };
  const hash = async (kind, key, fd, stat) => {
    const cached = state[kind][key];
    if (typeof cached === 'string' && /^[a-f0-9]{64}$/.test(cached)) return cached;
    const size = Number(stat.size);
    if (spent > 0 && spent + size > maxBytes) {
      save();
      throw cleanupError('cleanup_in_progress', `hashed ${spent} bytes this run; continuing in the next run`);
    }
    const sha256 = await hashDescriptor(fd, stat, { signal });
    spent += size;
    state[kind][key] = sha256;
    dirty += 1;
    hooks.afterFileHashed?.({ kind, key });
    if (dirty >= 200) save();
    return sha256;
  };
  return { hash, save };
}

const passThrough = (error) => error?.code === 'lease_lost' || error?.code === 'cleanup_in_progress';

// A dataset registry row is not proof on its own: the dataset copy is opened
// without following symlinks and hashed before a staging file counts as
// redundant. The copy's identity is kept so it can be re-checked at delete time.
async function verifyDatasetCopy(storage, candidate, byteSize, sha256, verified, hasher, signal) {
  const relative = `${candidate.datasetRelativePath}/${candidate.relativePath}`;
  if (verified.has(relative)) {
    const known = verified.get(relative);
    return known && known.sha256 === sha256 ? known : null;
  }
  let fd;
  let result = null;
  try {
    const datasetsRoot = fs.realpathSync.native(storage.roots.datasets);
    const absolute = storage.resolve('datasets', relative, { mustExist: true });
    const real = fs.realpathSync.native(absolute);
    if (real === absolute && real.startsWith(`${datasetsRoot}${path.sep}`)) {
      fd = fs.openSync(real, FILE_FLAGS);
      const stat = fs.fstatSync(fd, { bigint: true });
      if (stat.isFile() && stat.size === BigInt(byteSize)) {
        const digest = await hasher.hash('dataset', identityKey(relative, stat), fd, stat);
        result = {
          sha256: digest,
          datasetId: candidate.datasetId,
          datasetRelativePath: candidate.datasetRelativePath,
          relativePath: candidate.relativePath,
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String(stat.mtimeNs),
        };
      }
    }
  } catch (error) {
    if (passThrough(error)) throw error;
    if (signal?.aborted) throw cleanupError('lease_lost');
    result = null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  verified.set(relative, result);
  return result && result.sha256 === sha256 ? result : null;
}

// Candidates are tried in the order the repository returns them: the import's
// own dataset first, then (failed imports only) other datasets of the project.
function retainedCopyMatcher(storage, copies, hasher, signal) {
  const index = new Map();
  for (const file of copies?.files || []) {
    const key = `${file.byteSize}:${file.sha256}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(file);
  }
  const verified = new Map();
  return async (byteSize, sha256) => {
    for (const candidate of index.get(`${byteSize}:${sha256}`) || []) {
      const copy = await verifyDatasetCopy(storage, candidate, byteSize, sha256, verified, hasher, signal);
      if (copy) return copy;
    }
    return null;
  };
}

// Synchronous re-check used inside the unlink fence: the dataset relied on is
// still usable and its file is still the inode, size and mtime that was hashed.
function datasetCopyConfirmer(processing, storage) {
  return (record) => {
    const copy = record?.copy;
    if (!copy || !processing.importCleanupDatasetUsable?.(copy.datasetId)) return false;
    try {
      const stat = fs.lstatSync(storage.resolve('datasets', `${copy.datasetRelativePath}/${copy.relativePath}`), { bigint: true });
      return stat.isFile() && !stat.isSymbolicLink()
        && String(stat.dev) === copy.dev && String(stat.ino) === copy.ino
        && String(stat.size) === copy.size && String(stat.mtimeNs) === copy.mtimeNs;
    } catch {
      return false;
    }
  };
}

// Hashes every file in the quarantined staging tree and records whether an
// identical copy (same size and SHA-256) exists in a registered dataset.
async function classifyPrivateTree(directoryFd, expectedMountId, findCopy, hasher, {
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
        await classifyPrivateTree(opened.fd, expectedMountId, findCopy, hasher, { signal, records, budget, depth: depth + 1, prefix: relative });
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
        try { sha256 = await hasher.hash('staging', identityKey(relative, opened.stat), opened.fd, opened.stat); }
        catch (error) { throw passThrough(error) ? error : asLeaseOrChanged(error, 'cleanup file changed while hashing'); }
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

const KEPT_MANIFEST = 'kept-files.jsonl';

// The manifest is append-only JSON lines, one entry per file, shared by every
// attempt of the job. An entry is written and fsynced BEFORE its file is
// moved, so an interrupted run can leave an entry for a file that is still in
// the quarantine (it is moved later and gets a second entry), but never a kept
// file without an entry. reconcileKeptFolder also lists anything found in the
// kept folder that has no entry yet.
function appendKeptManifest(keptFd, entries) {
  if (!entries.length) return;
  const existed = Boolean(lstatOptional(keptFd, KEPT_MANIFEST));
  const fd = fs.openSync(
    procEntry(keptFd, KEPT_MANIFEST),
    fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC,
    0o600,
  );
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n) throw cleanupError('cleanup_path_untrusted', 'kept-files manifest is not a regular file');
    requireOwned(stat, 'manifest');
    fs.writeSync(fd, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (!existed) fs.fsyncSync(keptFd);
}

function readKeptManifestPaths(keptFd) {
  const listed = new Set();
  if (!lstatOptional(keptFd, KEPT_MANIFEST)) return listed;
  const fd = fs.openSync(procEntry(keptFd, KEPT_MANIFEST), FILE_FLAGS);
  try {
    if (!fs.fstatSync(fd).isFile()) throw cleanupError('cleanup_path_untrusted', 'kept-files manifest is not a regular file');
    for (const line of fs.readFileSync(fd, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (typeof entry?.path === 'string') listed.add(entry.path);
      } catch { /* a torn final line is ignored; the file is listed again */ }
    }
  } finally {
    fs.closeSync(fd);
  }
  return listed;
}

async function reconcileKeptFolder(keptFd, mountId, job, now, fence, signal) {
  const listed = readKeptManifestPaths(keptFd);
  const missing = [];
  const walk = async (directoryFd, prefix, depth) => {
    if (depth > MAX_CLEANUP_DEPTH) throw cleanupError('cleanup_tree_too_deep');
    const entries = fs.readdirSync(`/proc/self/fd/${directoryFd}`, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name), Buffer.from(right.name)));
    for (const entry of entries) {
      if (!prefix && entry.name === KEPT_MANIFEST) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const stat = fs.lstatSync(procEntry(directoryFd, entry.name), { bigint: true });
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        const opened = openDirectoryAt(directoryFd, entry.name, mountId);
        try { await walk(opened.fd, relative, depth + 1); } finally { fs.closeSync(opened.fd); }
      } else if (!listed.has(relative)) {
        let sha256 = null;
        if (stat.isFile()) {
          const opened = openFileAt(directoryFd, entry.name, mountId);
          try { sha256 = await hashDescriptor(opened.fd, opened.stat, { signal }); } finally { fs.closeSync(opened.fd); }
        }
        missing.push({
          event: 'reconciled', path: relative, byteSize: Number(stat.size), sha256,
          origin: null, cleanupJobId: job.id, at: new Date(now()).toISOString(),
          reason: 'found in the kept folder without a manifest entry',
        });
      }
    }
  };
  await walk(keptFd, '', 0);
  if (missing.length) fence(() => appendKeptManifest(keptFd, missing));
  return missing.length;
}

// Moves every file that has no verified dataset copy out of the quarantine into
// cache/import-kept-files/<staging name>/, keeping its relative path. The move
// is a rename on the same mount, so it costs no space and no copy. Nothing that
// exists only here is ever deleted.
async function preserveUniqueFiles({ processing, storage }, job, owner, now, payloadFd, mountId, records, copies, { hooks = {}, signal = null } = {}) {
  const unique = [...records.values()].filter((record) => !record.redundant);
  const fence = (mutate) => guardedFilesystemMutation(processing, job, owner, now, mutate);
  const keptName = stagingOwnerName(job.retained_import_id);
  if (!keptName) throw cleanupError('invalid_cleanup_target', 'kept files location is invalid');
  const root = storage.openCleanupRoot('cache');
  const held = [root.fd];
  try {
    if (root.mountId !== mountId) {
      // Not terminal: the job stays claimable and nothing is moved or deleted.
      throw cleanupError('cleanup_kept_root_unavailable', 'the kept-files folder is on another mount');
    }
    if (!unique.length && !lstatOptional(root.fd, KEPT_FILES_ROOT)) return null;
    const base = openOrCreateKeptDirectory(root.fd, KEPT_FILES_ROOT, mountId, fence);
    held.push(base.fd);
    if (!unique.length && !lstatOptional(base.fd, keptName)) return null;
    const kept = openOrCreateKeptDirectory(base.fd, keptName, mountId, fence);
    held.push(kept.fd);
    const reconciled = await reconcileKeptFolder(kept.fd, mountId, job, now, fence, signal);
    const comparedDatasetIds = (copies?.datasets || []).map((dataset) => dataset.id);
    for (const [index, record] of unique.entries()) {
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
        fence(() => appendKeptManifest(kept.fd, [{
          event: 'kept', path: record.path, byteSize: record.byteSize, sha256: record.sha256,
          origin: `${job.relative_path}/${record.path}`, cleanupJobId: job.id, comparedDatasetIds,
          at: new Date(now()).toISOString(), reason: 'not present by size and SHA-256 in a registered dataset',
        }]));
        fence(() => {
          const named = fs.lstatSync(procEntry(sourceFd, name), { bigint: true });
          if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || !sameClassifiedFile(record, named)) {
            throw cleanupError('cleanup_path_changed', 'file changed before it could be kept');
          }
          if (lstatOptional(targetFd, name)) {
            throw cleanupError('cleanup_quarantine_conflict', 'kept file destination already exists');
          }
          hooks.beforeKeepRename?.({ job, record, index });
          fs.renameSync(procEntry(sourceFd, name), procEntry(targetFd, name));
          const moved = fs.lstatSync(procEntry(targetFd, name), { bigint: true });
          if (!sameNode(moved, named)) throw cleanupError('cleanup_path_changed', 'kept file identity changed while moving');
        });
        fence(() => fs.fsyncSync(targetFd));
      } finally {
        for (let position = opened.length - 1; position >= 0; position -= 1) fs.closeSync(opened[position]);
      }
    }
    fence(() => fs.fsyncSync(kept.fd));
    fence(() => fs.fsyncSync(base.fd));
    const summary = {
      keptRelativePath: `${KEPT_FILES_ROOT}/${keptName}`,
      fileCount: unique.length,
      byteSize: unique.reduce((sum, record) => sum + record.byteSize, 0),
      reconciled,
    };
    if (unique.length || reconciled) processing.recordImportCleanupPreserved?.(job.id, { retainedImportId: job.retained_import_id, ...summary });
    return unique.length ? summary : null;
  } finally {
    for (let position = held.length - 1; position >= 0; position -= 1) fs.closeSync(held[position]);
  }
}

async function executeStagingCleanup({ processing, storage }, job, owner, { now, hooks = {}, signal = null, log = null, maxHashBytes = DEFAULT_MAX_HASH_BYTES }) {
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
      if (!processing.completeStagingCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
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
    requirePrivateDirectory(quarantineStat, source.rootStat, workerIdentity(), source.parentStat);
    const opened = openDirectoryAt(source.directoryFd, quarantineName, source.mountId);
    quarantineFd = opened.fd;
    requirePrivateDirectory(opened.stat, source.rootStat, workerIdentity(), source.parentStat);
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
        const hasher = createHasher({ processing, job, owner, now, signal, hooks, maxBytes: maxHashBytes });
        const records = await classifyPrivateTree(
          payload.fd, source.mountId, retainedCopyMatcher(storage, copies, hasher, signal), hasher, { signal },
        );
        hasher.save();
        hooks.afterStagingClassification?.({ job, records });
        const kept = await preserveUniqueFiles(
          { processing, storage }, job, owner, now, payload.fd, source.mountId, records, copies, { hooks, signal },
        );
        if (kept) {
          log?.log?.(`Import cleanup ${job.id}: kept ${kept.fileCount} file(s), ${kept.byteSize} bytes, with no dataset copy under ${kept.keptRelativePath}`);
        }
        const reliedOnDatasets = {};
        for (const record of records.values()) {
          if (record.redundant) reliedOnDatasets[record.copy.datasetId] = (reliedOnDatasets[record.copy.datasetId] || 0) + 1;
        }
        const evidence = {
          files: records.size,
          duplicates: [...records.values()].filter((record) => record.redundant).length,
          kept: kept?.fileCount || 0,
          reliedOnDatasets,
        };
        if (!processing.recordImportCleanupClassified(job.id, owner, job.lease_token, job.lease_generation, evidence, { at: now() })) {
          throw cleanupError('lease_lost');
        }
        if (Object.keys(reliedOnDatasets).some((datasetId) => !copies.ownDatasetIds?.includes(datasetId))) {
          log?.log?.(`Import cleanup ${job.id}: relied on dataset copies ${JSON.stringify(reliedOnDatasets)}`);
        }
        records.confirmCopy = datasetCopyConfirmer(processing, storage);
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

    if (!processing.completeStagingCleanup(job.id, owner, job.lease_token, job.lease_generation, { at: now() })) {
      throw cleanupError('lease_lost');
    }
  } finally {
    fs.closeSync(source.directoryFd);
  }
}

function requireStagingProof(processing, job) {
  const proof = processing.importCleanupStagingProof?.(job.retained_import_id) || { ok: false, reason: 'staging_proof_unavailable' };
  if (!proof.ok) throw cleanupError('zip_staging_unverified', `source ZIP kept because ${proof.reason}`);
}

async function executeZipCleanup({ processing, storage }, job, owner, { now, hooks = {}, signal = null }) {
  if (signal?.aborted) throw cleanupError('lease_lost');
  validateZipJob(job);
  // The ZIP is the operator's original. It may go only after the staging job of
  // the same import completed under the keep-unique-files rule, so every file
  // extracted from it is either a verified dataset duplicate or in kept-files.
  requireStagingProof(processing, job);
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
    try { requirePrivateDirectory(quarantineStat, source.rootStat, workerIdentity(), source.parentStat); }
    catch { throw cleanupError('source_changed', 'ZIP quarantine is not private'); }
    const quarantine = openDirectoryAt(source.directoryFd, quarantineName, source.mountId);
    quarantineFd = quarantine.fd;
    try { requirePrivateDirectory(quarantine.stat, source.rootStat, workerIdentity(), source.parentStat); }
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
        requireStagingProof(processing, job);
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

// A job's payload may already sit in its quarantine (the staging tree or ZIP
// was moved there). Such a job is never moved to a terminal status by the retry
// limit: that would strand the payload where no job can reach it. It is kept
// claimable and retried once a day instead, and the reason is logged.
function payloadMayBeQuarantined(deps, job) {
  const row = deps.processing.importCleanupRow?.(job.id) || job;
  if (!row.quarantine_relative_path) return false;
  try {
    deps.storage.resolve(job.root_key, job.relative_path, { mustExist: true });
    return false; // the source is still in place, so nothing is in the quarantine
  } catch {
    return true;
  }
}

const DAY_MS = 24 * 3600_000;

async function processOneImportCleanup(deps, owner, { now = Date.now, leaseSeconds = 300, hooks = {}, log = console, maxHashBytes = DEFAULT_MAX_HASH_BYTES } = {}) {
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
    if (job.cleanup_type === 'staging_tree') await executeStagingCleanup(deps, job, owner, { now, hooks, signal: controller.signal, log, maxHashBytes });
    else if (job.cleanup_type === 'source_zip') await executeZipCleanup(deps, job, owner, { now, hooks, signal: controller.signal });
    else throw cleanupError('invalid_cleanup_target', 'cleanup type is not implemented');
    log?.log?.(`Import cleanup ${job.id}: complete after ${Number(job.attempt_count) || 0} attempt(s)`);
    return true;
  } catch (error) {
    if (job && error?.code !== 'lease_lost') {
      const code = String(error?.code || 'cleanup_failed');
      const message = `${code}: ${sanitizeLogMessage(error?.message || 'cleanup failed')}`;
      const attempts = Number(job.attempt_count) || 0;
      const lease = [job.id, owner, job.lease_token, job.lease_generation];
      if (code === 'cleanup_in_progress') {
        // Budgeted progress, not a failure: continue shortly with saved hashes.
        if (deps.processing.continueImportCleanup(...lease, message, { at: now() })) {
          log?.log?.(`Import cleanup ${job.id}: ${message.slice(0, 200)}`);
          return true;
        }
      }
      const outcome = terminalCleanupOutcome(error);
      const stopNow = code === 'zip_staging_unverified';
      if ((!outcome || outcome === 'cleanup_quarantine_conflict') && (stopNow || retriesExhausted(job, code))) {
        const reason = stopNow ? message : `cleanup_retry_exhausted: stopped after ${attempts} attempts; last error ${message}`;
        if (payloadMayBeQuarantined(deps, job)) {
          const parked = deps.processing.deferQuarantinedImportCleanup(
            ...lease, reason, { at: now(), baseDelayMs: 60_000, maxDelayMs: DAY_MS, outcome: 'cleanup_retry_exhausted' },
          ) || deps.processing.retryImportCleanup(...lease, reason, { at: now(), baseDelayMs: 60_000, maxDelayMs: DAY_MS });
          if (parked) {
            log?.warn?.(`Import cleanup ${job.id}: kept claimable once a day because its payload is in quarantine; ${reason.slice(0, 300)}`);
            return true;
          }
        } else if (deps.processing.failImportCleanup(...lease, reason, { at: now() })) {
          log?.warn?.(`Import cleanup ${job.id}: marked failed after ${attempts} attempts; ${reason.slice(0, 300)}`);
          return true;
        }
      }
      log?.warn?.(`Import cleanup ${job.id}: attempt ${attempts} failed${outcome ? ` (${outcome})` : ''}: ${message.slice(0, 300)}`);
      if ((!outcome || outcome === 'cleanup_quarantine_conflict') && deps.processing.deferQuarantinedImportCleanup(
        ...lease, message, { at: now(), outcome: outcome || 'cleanup_deferred' },
      )) return true;
      if (outcome) {
        deps.processing.completeImportCleanupWithoutDelete(...lease, outcome, message, { at: now() });
      } else {
        deps.processing.retryImportCleanup(...lease, message, { at: now() });
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
