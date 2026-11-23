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

// O_NONBLOCK: never wait for the writer of a FIFO, a device or a file lease.
// O_NOFOLLOW: no final link. A leased file (EAGAIN) is tried again for a moment
// while the kernel asks its holder to let go, and refused if it does not.
const LEASE_RETRY_MS = [50, 100, 200, 400];
async function openNonblocking(filePath) {
  const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
  for (let attempt = 0; ; attempt += 1) {
    try { return await fs.promises.open(filePath, O_RDONLY | O_NOFOLLOW | O_NONBLOCK); }
    catch (error) {
      if (!['EAGAIN', 'EWOULDBLOCK'].includes(error?.code) || attempt >= LEASE_RETRY_MS.length) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, LEASE_RETRY_MS[attempt]));
  }
}

// Linux: opens the file once, then asks the kernel where the opened file is.
// It must be exactly <real root>/<relative path>: any symbolic link below the
// root (or an escape through one, even one swapped in during the open) gives a
// different path. When the kernel's answer does not confirm that (no /proc, a
// case-insensitive mount that reports another spelling), safeExistingFile must
// accept the path and it must name this very file. Nothing is opened twice.
async function openOnLinux(root, relPath, lexical, relative) {
  const handle = await openNonblocking(lexical);
  if (!handle) return null;
  let opened = null;
  try {
    const stat = await handle.stat({ bigint: true });
    if (stat.isFile()) {
      const filePath = await confirmedPath(root, relative, handle) || pathNaming(root, relPath, stat);
      if (filePath) opened = { handle, stat, filePath };
    }
  } catch { /* refused below */ } finally {
    if (!opened) await handle.close().catch(() => {});
  }
  return opened;
}

async function confirmedPath(root, relative, handle) {
  try {
    // The root itself may be reached through links; it is resolved for every
    // request, so a retargeted root can never be checked against an old one.
    const [realRoot, actual] = await Promise.all([fs.promises.realpath(root), fs.promises.readlink(`/proc/self/fd/${handle.fd}`)]);
    return realRoot !== path.parse(realRoot).root && actual === path.join(realRoot, relative) ? actual : null;
  } catch { return null; }
}

// The path the full check accepts, if it names the opened file before and after
// that file is compared; otherwise null.
function pathNaming(root, relPath, stat) {
  const filePath = safeExistingFile(root, relPath);
  if (!filePath) return null;
  try {
    const current = fs.lstatSync(filePath, { bigint: true });
    return current.dev === stat.dev && current.ino === stat.ino && safeExistingFile(root, relPath) === filePath ? filePath : null;
  } catch { return null; }
}

// Opens an asset for delivery. Resolves to { handle, stat, filePath } (the
// caller owns the handle), or null when the file must not be served. On Linux
// no synchronous filesystem call runs unless the kernel cannot confirm the
// opened file's path. Other platforms check, then open, as before.
async function openAssetFile(root, relPath, { platform = process.platform } = {}) {
  const lexical = safeResolve(root, relPath);
  const relative = lexical && relativeBelow(root, lexical);
  if (!relative) return null;
  if (platform === 'linux') return openOnLinux(root, relPath, lexical, relative);
  const filePath = safeExistingFile(root, relPath);
  if (!filePath) return null;
  try { return { ...await openForDelivery(filePath), filePath }; } catch { return null; }
}

// Runs synchronous work between opening a file and handing its handle to
// deliverVerified; closes the handle if that work throws.
function closeOnThrow(opened, work) {
  try { return work(); } catch (error) {
    opened.handle.close().catch(() => {});
    throw error;
  }
}

module.exports = { safeResolve, safeExistingFile, openAssetFile, closeOnThrow };
