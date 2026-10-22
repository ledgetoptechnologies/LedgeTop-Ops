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

function removeEmptyQuarantine(parentFd, name, heldFd) {
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
    requirePrivateDirectory(held);
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

function requirePrivateDirectory(stat) {
  requireOwned(stat, 'directory');
  if ((Number(stat.mode) & 0o077) !== 0) {
    throw cleanupError('cleanup_path_untrusted', 'cleanup quarantine is not private to the worker');
  }
}

function openDirectoryAt(parentFd, name, expectedMountId, { privateDirectory = false } = {}) {
  const candidate = procEntry(parentFd, name);
  const before = fs.lstatSync(candidate, { bigint: true });
  if (!before.isDirectory() || before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup directory changed');
  let fd;
  try {
    fd = fs.openSync(candidate, DIRECTORY_FLAGS);
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!sameEntry(before, opened)) throw cleanupError('cleanup_path_changed', 'cleanup directory identity changed');
    if (descriptorMountId(fd) !== expectedMountId) throw cleanupError('cleanup_cross_mount', 'cleanup directory crossed a mount boundary');
    if (privateDirectory) requirePrivateDirectory(opened);
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
    return { directoryFd, mountId: root.mountId, name, relativePath: relative };
  } catch (error) {
    fs.closeSync(directoryFd);
    throw error;
  }
}

function validateStagingJob(job) {
  const expected = `webodm-task-imports/${job.retained_import_id}`;
  if (job.cleanup_type !== 'staging_tree' || job.root_key !== 'cache' || job.relative_path !== expected) {
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

function removePrivateTree(directoryFd, expectedMountId, processing, job, owner, now, budget = { entries: 0 }, depth = 0) {
  if (depth > MAX_CLEANUP_DEPTH) throw cleanupError('cleanup_tree_too_deep');
  const root = fs.fstatSync(directoryFd, { bigint: true });
  requireOwned(root, 'staging');
  if (descriptorMountId(directoryFd) !== expectedMountId) throw cleanupError('cleanup_cross_mount');
  for (const entry of fs.readdirSync(`/proc/self/fd/${directoryFd}`, { withFileTypes: true })) {
    budget.entries += 1;
    if (budget.entries > MAX_CLEANUP_ENTRIES) throw cleanupError('cleanup_tree_too_large');
    const entryPath = procEntry(directoryFd, entry.name);
    const before = fs.lstatSync(entryPath, { bigint: true });
    if (before.isSymbolicLink()) throw cleanupError('cleanup_path_changed', 'cleanup tree contains a symbolic link');
    if (before.isDirectory()) {
      const opened = openDirectoryAt(directoryFd, entry.name, expectedMountId);
      try {
        removePrivateTree(opened.fd, expectedMountId, processing, job, owner, now, budget, depth + 1);
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
        guardedFilesystemMutation(processing, job, owner, now, () => {
          const named = fs.lstatSync(entryPath, { bigint: true });
          if (!sameEntry(named, opened) || named.isSymbolicLink() || named.nlink !== 1n) {
            throw cleanupError('cleanup_path_changed', 'cleanup file was replaced before deletion');
          }
          requireOwned(named, 'file');
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

async function executeStagingCleanup({ processing, storage }, job, owner, { now, hooks = {}, signal = null }) {
  if (signal?.aborted) throw cleanupError('lease_lost');
  validateStagingJob(job);
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
    if (!quarantineStat) {
      if (!sourceStat || !sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw cleanupError('cleanup_path_changed', 'staging cleanup source is unavailable');
      }
      requireOwned(sourceStat, 'staging');
      guardedFilesystemMutation(processing, job, owner, now, () => {
        fs.mkdirSync(procEntry(source.directoryFd, quarantineName), { mode: 0o700 });
      });
      quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    }
    if (!quarantineStat?.isDirectory() || quarantineStat.isSymbolicLink()) throw cleanupError('cleanup_path_changed');
    requirePrivateDirectory(quarantineStat);
    const opened = openDirectoryAt(source.directoryFd, quarantineName, source.mountId, { privateDirectory: true });
    quarantineFd = opened.fd;
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
        removePrivateTree(payload.fd, source.mountId, processing, job, owner, now);
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
        removeEmptyQuarantine(source.directoryFd, quarantineNameAfter, quarantineFd);
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
        fs.mkdirSync(procEntry(source.directoryFd, quarantineName), { mode: 0o700 });
      });
      quarantineStat = lstatOptional(source.directoryFd, quarantineName);
    }
    if (!quarantineStat?.isDirectory() || quarantineStat.isSymbolicLink()) throw cleanupError('source_changed');
    try { requirePrivateDirectory(quarantineStat); }
    catch { throw cleanupError('source_changed', 'ZIP quarantine is not private'); }
    const quarantine = openDirectoryAt(source.directoryFd, quarantineName, source.mountId, { privateDirectory: true });
    quarantineFd = quarantine.fd;
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
        removeEmptyQuarantine(source.directoryFd, quarantineNameAfter, quarantineFd);
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

async function processOneImportCleanup(deps, owner, { now = Date.now, leaseSeconds = 300, hooks = {} } = {}) {
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
    if (job.cleanup_type === 'staging_tree') await executeStagingCleanup(deps, job, owner, { now, hooks, signal: controller.signal });
    else if (job.cleanup_type === 'source_zip') await executeZipCleanup(deps, job, owner, { now, hooks, signal: controller.signal });
    else throw cleanupError('invalid_cleanup_target', 'cleanup type is not implemented');
    return true;
  } catch (error) {
    if (job && error?.code !== 'lease_lost') {
      const message = `${error?.code || 'cleanup_failed'}: ${sanitizeLogMessage(error?.message || 'cleanup failed')}`;
      const outcome = terminalCleanupOutcome(error);
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

module.exports = {
  executeStagingCleanup,
  executeZipCleanup,
  processOneImportCleanup,
};
