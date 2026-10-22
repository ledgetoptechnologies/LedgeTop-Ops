'use strict';

const fs = require('node:fs');

function identityMatches(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.size === right.size
    && left.ctimeNs === right.ctimeNs
    && left.mtimeNs === right.mtimeNs;
}

function durabilityError(code, message, cause = null) {
  return Object.assign(new Error(message), { code, ...(cause ? { cause } : {}) });
}

function fsyncDirectory(directory, { code = 'durable_sync_failed' } = {}) {
  let fd;
  try {
    fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
    const stat = fs.fstatSync(fd);
    if (!stat.isDirectory()) throw durabilityError(code, 'durability target is not a directory');
    fs.fsyncSync(fd);
  } catch (error) {
    if (error?.code === code) throw error;
    throw durabilityError(code, 'directory durability synchronization failed', error);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fsyncDirectoryTree(root, { code = 'durable_sync_failed' } = {}) {
  let rootFd;
  try {
    rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
  } catch (error) {
    throw durabilityError(code, 'durability tree cannot be opened safely', error);
  }
  const walk = (directoryFd) => {
    const before = fs.fstatSync(directoryFd, { bigint: true });
    const directoryPath = `/proc/self/fd/${directoryFd}`;
    for (const entry of fs.readdirSync(directoryPath, { withFileTypes: true })) {
      const childPath = `${directoryPath}/${entry.name}`;
      const childStat = fs.lstatSync(childPath, { bigint: true });
      if (childStat.isSymbolicLink() || (!childStat.isDirectory() && !childStat.isFile())) {
        throw durabilityError(code, 'durability tree contains an unsafe entry');
      }
      let childFd;
      try {
        const flags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC
          | (childStat.isDirectory() ? fs.constants.O_DIRECTORY : 0);
        childFd = fs.openSync(childPath, flags);
        const opened = fs.fstatSync(childFd, { bigint: true });
        if (!identityMatches(childStat, opened)) throw durabilityError(code, 'durability entry changed before synchronization');
        if (childStat.isDirectory()) walk(childFd);
        else fs.fsyncSync(childFd);
        if (!identityMatches(opened, fs.fstatSync(childFd, { bigint: true }))) {
          throw durabilityError(code, 'durability entry changed during synchronization');
        }
      } finally {
        if (childFd !== undefined) fs.closeSync(childFd);
      }
    }
    if (!identityMatches(before, fs.fstatSync(directoryFd, { bigint: true }))) {
      throw durabilityError(code, 'durability directory changed during synchronization');
    }
    fs.fsyncSync(directoryFd);
  };
  try {
    walk(rootFd);
  } catch (error) {
    if (error?.code === code) throw error;
    throw durabilityError(code, 'tree durability synchronization failed', error);
  } finally {
    fs.closeSync(rootFd);
  }
}

module.exports = { fsyncDirectory, fsyncDirectoryTree };
