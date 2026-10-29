'use strict';

// Linux-only descriptor-relative source opens for the experimental raw import.
// A pinned directory descriptor prevents a later pathname swap from redirecting
// traversal, but is not authority against hard links, bind mounts or writers
// that can modify an already-open file.
const fs = require('node:fs');
const { safeRelativePath } = require('./processingSecurity');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const dirFlags = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;
const fileFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC | fs.constants.O_NONBLOCK;

function openPinnedImportRoot(root) {
  if (process.platform !== 'linux' || !fs.existsSync('/proc/self/fd')) fail('anchored_import_unavailable');
  if (typeof root !== 'string' || !root) fail('import_mount_unavailable');
  let fd;
  try {
    // The configured mount root is resolved once; all user-selected components
    // are opened relative to this pinned descriptor and may not be symlinks.
    fd = fs.openSync(fs.realpathSync.native(root), dirFlags);
    if (!fs.fstatSync(fd).isDirectory()) fail('invalid_import_path');
    return fd;
  } catch (error) { if (fd !== undefined) fs.closeSync(fd); throw error; }
}
function openPinnedImportEntry(rootFd, relative, { directory = false, afterParentOpen = null } = {}) {
  if (typeof relative !== 'string' || !relative || safeRelativePath(relative) !== relative || relative.includes('\\')) fail('invalid_import_path');
  const parts = relative.split('/'); let parent = null, result = null;
  try {
    parent = fs.openSync(`/proc/self/fd/${rootFd}/.`, dirFlags);
    for (const component of parts.slice(0, -1)) {
      const next = fs.openSync(`/proc/self/fd/${parent}/${component}`, dirFlags);
      fs.closeSync(parent); parent = next;
    }
    if (afterParentOpen) afterParentOpen();
    result = fs.openSync(`/proc/self/fd/${parent}/${parts.at(-1)}`, directory ? dirFlags : fileFlags);
    const opened = fs.fstatSync(result);
    if (directory ? !opened.isDirectory() : !opened.isFile()) fail('invalid_import_path');
    const fd = result; result = null; return fd;
  } finally { if (result !== null) fs.closeSync(result); if (parent !== null) fs.closeSync(parent); }
}
module.exports = { openPinnedImportRoot, openPinnedImportEntry };

