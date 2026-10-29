'use strict';

// Dormant building block: the caller must supply an already-authorized,
// exclusively fenced Linux directory descriptor. This module neither creates
// authority nor accepts/publishes a result. Existing destinations fail closed;
// recovery of an interrupted link/temporary file requires a separate journal.
const fs = require('node:fs');
const crypto = require('node:crypto');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

async function retainReferenceResult({source,authority,expectedSha256,expectedBytes,maxBytes,signal} = {}) {
  if (process.platform !== 'linux') fail('REFERENCE_SPOOL_UNAVAILABLE');
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' || !authority || !Number.isSafeInteger(authority.rootFd) || authority.rootFd < 0 || typeof authority.assertCurrent !== 'function' || typeof authority.device !== 'bigint' || typeof authority.inode !== 'bigint' || !hash(expectedSha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < expectedBytes) fail('REFERENCE_SPOOL_INVALID');
  const rootFd = authority.rootFd, root = `/proc/self/fd/${rootFd}`;
  function checkRoot() {
    if (authority.assertCurrent() !== true) fail('REFERENCE_SPOOL_AUTHORITY_LOST');
    const info = fs.fstatSync(rootFd,{bigint:true});
    if (!info.isDirectory() || info.dev !== authority.device || info.ino !== authority.inode) fail('REFERENCE_SPOOL_AUTHORITY_LOST');
  }
  checkRoot();
  const tempName = `.reference-result-${crypto.randomUUID()}.tmp`, finalName = `${expectedSha256}.zip`;
  const temp = `${root}/${tempName}`, final = `${root}/${finalName}`;
  let fd, created = false, linked = false;
  try {
    signal?.throwIfAborted();
    fd = fs.openSync(temp,fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC,0o600); created = true;
    const digest = crypto.createHash('sha256'); let count = 0;
    for await (const part of source) {
      signal?.throwIfAborted();
      if (!(part instanceof Uint8Array)) fail('REFERENCE_SPOOL_INVALID');
      const bytes = Buffer.from(part); count += bytes.length;
      if (!Number.isSafeInteger(count) || count > expectedBytes || count > maxBytes) fail('REFERENCE_SPOOL_SIZE');
      digest.update(bytes);
      for (let offset=0; offset<bytes.length;) { const wrote=fs.writeSync(fd,bytes,offset,bytes.length-offset); if (wrote<=0) fail('REFERENCE_SPOOL_WRITE'); offset+=wrote; }
    }
    signal?.throwIfAborted();
    if (count !== expectedBytes || digest.digest('hex') !== expectedSha256) fail('REFERENCE_SPOOL_DIGEST');
    fs.fsyncSync(fd); checkRoot();
    // link is no-overwrite; a retry never replaces an earlier retained copy.
    fs.linkSync(temp,final); linked = true;
    fs.unlinkSync(temp); created = false;
    fs.fsyncSync(rootFd); checkRoot();
    const actual = fs.fstatSync(fd,{bigint:true}), named = fs.lstatSync(final,{bigint:true});
    if (!actual.isFile() || actual.nlink !== 1n || actual.dev !== named.dev || actual.ino !== named.ino || actual.size !== BigInt(expectedBytes) || !named.isFile() || named.isSymbolicLink()) fail('REFERENCE_SPOOL_CHANGED');
    return Object.freeze({relativePath:finalName,byteSize:count,sha256:expectedSha256});
  } finally {
    // Only the unique file created by this invocation may be removed. A linked
    // final object is retained even if a later barrier or authority check fails.
    if (created && !linked && fd !== undefined) { try { checkRoot(); const held=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(temp,{bigint:true}); if(held.dev===named.dev && held.ino===named.ino && named.isFile() && !named.isSymbolicLink()) fs.unlinkSync(temp); } catch {} }
    if (fd !== undefined) fs.closeSync(fd);
  }
}
module.exports = {retainReferenceResult};
