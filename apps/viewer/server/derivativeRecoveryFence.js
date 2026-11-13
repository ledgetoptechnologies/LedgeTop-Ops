'use strict';

const fs = require('node:fs');
const path = require('node:path');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const flags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;

function procText(file, maximum) {
  const fd = fs.openSync(file, 'r'), pieces = [], buffer = Buffer.allocUnsafe(8192);
  let size = 0;
  try {
    for (;;) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - size), null);
      if (!count) break;
      size += count;
      if (size > maximum) fail('supplement_fence_probe_limit');
      pieces.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(pieces).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function mountId(fd) {
  const value = procText(`/proc/self/fdinfo/${fd}`, 65536).match(/^mnt_id:\s+(\d+)$/m)?.[1];
  if (!value) fail('supplement_fence_mount_unbound');
  return value;
}
function readOnlyMount(mountInfo, id) {
  const rows = mountInfo.split('\n').filter(line => line.split(' ', 1)[0] === id);
  if (rows.length !== 1) return false;
  const [mount, superblock] = rows[0].split(' - '), fields = mount.split(' ');
  return Boolean(superblock && fields.length >= 6 && fields[5].split(',').includes('ro')
    && !fields[5].split(',').includes('rw'));
}
function unprivileged(status, uid) {
  const value = status.match(/^CapEff:\s+([0-9a-f]+)$/mi)?.[1];
  return uid > 0 && Number.isInteger(uid) && value !== undefined && !(BigInt(`0x${value}`) & (1n << 21n));
}

// A RO bind mount prevents this controller/verifier from modifying source bytes.
// It does NOT exclude a writer in another mount namespace. The host owner must
// separately hold an exclusive Viewer maintenance window for the entire run.
function createReadOnlyRecoveryFence({ modelsRoot, assertExclusiveMaintenance } = {}) {
  return async ({ operation, signal, assertCurrent }) => {
    if (process.platform !== 'linux') fail('supplement_platform_unsupported');
    if (typeof assertCurrent !== 'function' || typeof assertExclusiveMaintenance !== 'function'
      || typeof modelsRoot !== 'string' || !path.isAbsolute(modelsRoot) || modelsRoot.includes('\0')) fail('supplement_fence_unavailable');
    let models = null, root = null, released = false;
    const release = () => {
      if (released) return; released = true;
      const ownedModels = models, ownedRoot = root; models = root = null;
      try { if (ownedModels !== null) fs.closeSync(ownedModels); }
      finally { if (ownedRoot !== null) fs.closeSync(ownedRoot); }
    };
    try {
      signal?.throwIfAborted(); assertCurrent();
      if (fs.realpathSync.native(modelsRoot) !== path.resolve(modelsRoot)) fail('supplement_fence_root_changed');
      models = fs.openSync(modelsRoot, flags); root = fs.openSync('/', flags);
      const stat = fs.fstatSync(models, { bigint: true }), id = mountId(models), rootId = mountId(root);
      const assertActive = () => {
        if (released) fail('supplement_fence_lost');
        // Custody supplies the phase-appropriate source/lease guard. Do not
        // capture the failed-state eligibility guard past atomic restoration.
        signal?.throwIfAborted();
        if (assertExclusiveMaintenance({ operation }) !== true) fail('supplement_external_fence_lost');
        if (!unprivileged(procText('/proc/self/status', 65536), process.getuid())) fail('supplement_fence_privileged');
        const mounts = procText('/proc/self/mountinfo', 1024 * 1024);
        if (!readOnlyMount(mounts, id) || !readOnlyMount(mounts, rootId)) fail('supplement_fence_not_readonly');
        let current;
        try {
          current = fs.openSync(modelsRoot, flags);
          const named = fs.fstatSync(current, { bigint: true });
          if (named.dev !== stat.dev || named.ino !== stat.ino || mountId(current) !== id || mountId(models) !== id) fail('supplement_fence_root_changed');
        } finally { if (current !== undefined) fs.closeSync(current); }
        return true;
      };
      assertActive(); assertCurrent();
      return { assertActive, release };
    } catch (error) { release(); throw error; }
  };
}

module.exports = { readOnlyMount, unprivileged, createReadOnlyRecoveryFence };
