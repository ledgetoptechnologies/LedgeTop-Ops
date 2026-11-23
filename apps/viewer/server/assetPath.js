'use strict';

// Resolves and opens one asset file below a configured storage root, refusing
// anything that escapes the root or passes through a symbolic link below it.

const fs = require('node:fs');
const path = require('node:path');
const { openForDelivery } = require('./verifiedDelivery');

// Resolve `relPath` under `root`, refusing anything that escapes it.
function safeResolve(root, relPath) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, `.${path.sep}${relPath}`);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

// Path of `lexical` relative to `root`; null for the root itself or an escape.
function relativeBelow(root, lexical) {
  const relative = path.relative(path.resolve(root), lexical);
  return !relative || relative.startsWith('..') || path.isAbsolute(relative) ? null : relative;
}

function safeExistingFile(root, relPath) {
  const lexical = safeResolve(root, relPath);
  if (!lexical) return null;
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch { return null; }
  const relative = relativeBelow(root, lexical);
  if (!relative) return null;
  let cursor = realRoot;
  try {
    for (const segment of relative.split(path.sep)) {
      cursor = path.join(cursor, segment);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    const real = fs.realpathSync(cursor);
    if (!real.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

// Linux: opens the file once, then asks the kernel where the opened file is.
// It must be exactly <real root>/<relative path>: any symbolic link below the
// root (or an escape through one, even one swapped in during the open) gives a
// different path. Returns null for a file that must not be served and
// undefined when this check cannot decide (the caller then runs the full one).
async function openOnLinux(root, lexical, relative) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  let handle;
  // O_NONBLOCK: never wait for the writer of a FIFO. O_NOFOLLOW: no final link.
  try { handle = await fs.promises.open(lexical, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
  catch (error) { return ['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error?.code) ? null : undefined; }
  let result;
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) result = null;
    else {
      // The root itself may be reached through links; it is resolved for every
      // request, so a retargeted root can never be checked against an old one.
      const [realRoot, actual] = await Promise.all([fs.promises.realpath(root), fs.promises.readlink(`/proc/self/fd/${handle.fd}`)]);
      if (realRoot !== path.parse(realRoot).root && actual === path.join(realRoot, relative)) result = { handle, stat, filePath: actual };
    }
  } catch { result = undefined; }
  if (!result) await handle.close().catch(() => {});
  return result;
}

// Opens an asset for delivery. Resolves to { handle, stat, filePath } (the
// caller owns the handle), or null when the file must not be served.
// On Linux no synchronous filesystem call runs unless the opened file's path
// cannot be confirmed (no /proc, a case-insensitive mount that reports another
// spelling, a file lease); then, and on other platforms, safeExistingFile
// decides as before. On Linux it must also still name the opened file after the
// open, so a path changed in between is refused.
async function openAssetFile(root, relPath, { platform = process.platform } = {}) {
  const lexical = safeResolve(root, relPath);
  const relative = lexical && relativeBelow(root, lexical);
  if (!relative) return null;
  if (platform === 'linux') {
    const opened = await openOnLinux(root, lexical, relative);
    if (opened !== undefined) return opened;
  }
  const filePath = safeExistingFile(root, relPath);
  if (!filePath) return null;
  let opened;
  try { opened = await openForDelivery(filePath); } catch { return null; }
  if (platform !== 'linux' || stillNames(root, relPath, filePath, opened.stat)) return { ...opened, filePath };
  await opened.handle.close().catch(() => {});
  return null;
}

function stillNames(root, relPath, filePath, stat) {
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    return current.dev === stat.dev && current.ino === stat.ino && safeExistingFile(root, relPath) === filePath;
  } catch { return false; }
}

module.exports = { safeResolve, safeExistingFile, openAssetFile };
