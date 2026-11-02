'use strict';

// Dormant building block: the caller must supply an already-authorized,
// exclusively fenced Linux directory descriptor. This module neither creates
// authority nor accepts/publishes a result. Existing destinations fail closed;
// resumable writes require the caller's durable progress journal and live fence.
const fs = require('node:fs');
const crypto = require('node:crypto');
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const hash = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const CHECKPOINT_BYTES = 8 * 1024 * 1024;

function checkAuthority(authority) {
  if (process.platform !== 'linux') fail('REFERENCE_SPOOL_UNAVAILABLE');
  if (!authority || !Number.isSafeInteger(authority.rootFd) || authority.rootFd < 0 || typeof authority.assertCurrent !== 'function' || typeof authority.device !== 'bigint' || typeof authority.inode !== 'bigint') fail('REFERENCE_SPOOL_INVALID');
  if (authority.assertCurrent() !== true) fail('REFERENCE_SPOOL_AUTHORITY_LOST');
  const info = fs.fstatSync(authority.rootFd,{bigint:true});
  if (!info.isDirectory() || info.dev !== authority.device || info.ino !== authority.inode) fail('REFERENCE_SPOOL_AUTHORITY_LOST');
}

async function retainReferenceResult({source,authority,storageKey,expectedSha256,expectedBytes,maxBytes,signal} = {}) {
  if (process.platform !== 'linux') fail('REFERENCE_SPOOL_UNAVAILABLE');
  if (!source || typeof source[Symbol.asyncIterator] !== 'function' || !hash(storageKey) || !hash(expectedSha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < expectedBytes) fail('REFERENCE_SPOOL_INVALID');
  checkAuthority(authority);
  const rootFd = authority.rootFd, root = `/proc/self/fd/${rootFd}`;
  function checkRoot() { checkAuthority(authority); }
  checkRoot();
  const tempName = `.reference-result-${crypto.randomUUID()}.tmp`, finalName = `${storageKey}.zip`;
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

async function retainReferenceResultResumable({source,progress,authority,storageKey,expectedSha256,expectedBytes,maxBytes,signal} = {}) {
  if (process.platform !== 'linux') fail('REFERENCE_SPOOL_UNAVAILABLE');
  if (typeof source !== 'function' || !progress || typeof progress.load !== 'function' || typeof progress.commit !== 'function' || !hash(storageKey) || !hash(expectedSha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < expectedBytes) fail('REFERENCE_SPOOL_INVALID');
  checkAuthority(authority);
  const rootFd=authority.rootFd,root=`/proc/self/fd/${rootFd}`,partName=`.reference-result-${storageKey}.part`,finalName=`${storageKey}.zip`,part=`${root}/${partName}`,final=`${root}/${finalName}`;
  let fd,created=false;
  try {
    signal?.throwIfAborted();
    try { fd=fs.openSync(part,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);created=true; }
    catch(e) { if(e.code!=='EEXIST')throw e; fd=fs.openSync(part,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC); }
    if(created){fs.fsyncSync(rootFd);checkAuthority(authority);}
    const named=fs.lstatSync(part,{bigint:true}),opened=fs.fstatSync(fd,{bigint:true});
    if(!named.isFile()||named.isSymbolicLink()||named.nlink!==1n||!opened.isFile()||opened.nlink!==1n||named.dev!==opened.dev||named.ino!==opened.ino||(opened.mode&0o777n)!==0o600n)fail('REFERENCE_SPOOL_CHANGED');
    checkAuthority(authority);
    const saved=await progress.load();
    if(!saved||!Number.isSafeInteger(saved.offset)||saved.offset<0||saved.offset>expectedBytes||!hash(saved.prefixSha256))fail('REFERENCE_SPOOL_PROGRESS_MISMATCH');
    if(opened.size<BigInt(saved.offset)||opened.size>BigInt(expectedBytes))fail('REFERENCE_SPOOL_PROGRESS_MISMATCH');
    if(opened.size!==BigInt(saved.offset)){fs.ftruncateSync(fd,saved.offset);fs.fsyncSync(fd);fs.fsyncSync(rootFd);}
    const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let read=0,n;
    while((n=fs.readSync(fd,buffer,0,Math.min(buffer.length,saved.offset-read),read))>0){read+=n;digest.update(buffer.subarray(0,n));}
    if(read!==saved.offset||digest.copy().digest('hex')!==saved.prefixSha256)fail('REFERENCE_SPOOL_PROGRESS_MISMATCH');
    let checkpoint=saved.offset,position=saved.offset,sinceCheckpoint=0;
    const persist=()=>{
      checkAuthority(authority);fs.fsyncSync(fd);checkAuthority(authority);
      const prefix=digest.copy().digest('hex');progress.commit(checkpoint,position,prefix);
      checkpoint=position;sinceCheckpoint=0;
    };
    const body=position<expectedBytes?await source(position):null;
    if(body&&typeof body[Symbol.asyncIterator]!=='function')fail('REFERENCE_SPOOL_INVALID');
    try {
      if(body) for await(const partBytes of body){
        signal?.throwIfAborted();checkAuthority(authority);
        if(!(partBytes instanceof Uint8Array))fail('REFERENCE_SPOOL_INVALID');
        const bytes=Buffer.from(partBytes);if(!bytes.length)continue;
        if(!Number.isSafeInteger(position+bytes.length)||position+bytes.length>expectedBytes||position+bytes.length>maxBytes)fail('REFERENCE_SPOOL_SIZE');
        digest.update(bytes);
        for(let offset=0;offset<bytes.length;){const wrote=fs.writeSync(fd,bytes,offset,bytes.length-offset,position+offset);if(wrote<=0)fail('REFERENCE_SPOOL_WRITE');offset+=wrote;}
        position+=bytes.length;sinceCheckpoint+=bytes.length;
        if(sinceCheckpoint>=CHECKPOINT_BYTES)persist();
      }
    } catch(error) {
      if(position>checkpoint){try{persist();}catch{}}
      throw error;
    }
    signal?.throwIfAborted();
    if(position!==expectedBytes||digest.copy().digest('hex')!==expectedSha256)fail('REFERENCE_SPOOL_DIGEST');
    if(position>checkpoint)persist();
    checkAuthority(authority);
    fs.linkSync(part,final);
    fs.fsyncSync(rootFd);checkAuthority(authority);
    fs.unlinkSync(part);
    fs.fsyncSync(rootFd);checkAuthority(authority);
    const actual=fs.fstatSync(fd,{bigint:true}),finalStat=fs.lstatSync(final,{bigint:true});
    if(!actual.isFile()||actual.nlink!==1n||actual.size!==BigInt(expectedBytes)||actual.dev!==finalStat.dev||actual.ino!==finalStat.ino||!finalStat.isFile()||finalStat.isSymbolicLink())fail('REFERENCE_SPOOL_CHANGED');
    return Object.freeze({relativePath:finalName,byteSize:expectedBytes,sha256:expectedSha256});
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}

function recoverLinkedReferenceResult({authority,storageKey,expectedSha256,expectedBytes,maxBytes}={}) {
  checkAuthority(authority);
  if(!hash(storageKey)||!hash(expectedSha256)||!Number.isSafeInteger(expectedBytes)||expectedBytes<1||!Number.isSafeInteger(maxBytes)||maxBytes<expectedBytes)fail('REFERENCE_SPOOL_INVALID');
  const root=`/proc/self/fd/${authority.rootFd}`,part=`${root}/.reference-result-${storageKey}.part`,final=`${root}/${storageKey}.zip`;
  let partStat,finalStat;
  try{partStat=fs.lstatSync(part,{bigint:true});}catch(e){if(e.code==='ENOENT')return false;throw e;}
  try{finalStat=fs.lstatSync(final,{bigint:true});}catch(e){if(e.code==='ENOENT')return false;throw e;}
  if(!partStat.isFile()||partStat.isSymbolicLink()||!finalStat.isFile()||finalStat.isSymbolicLink()||partStat.dev!==finalStat.dev||partStat.ino!==finalStat.ino||partStat.nlink!==2n||finalStat.nlink!==2n||partStat.size!==BigInt(expectedBytes)||finalStat.size!==BigInt(expectedBytes))fail('REFERENCE_SPOOL_CHANGED');
  const fd=fs.openSync(final,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
  try{
    const opened=fs.fstatSync(fd,{bigint:true});if(!opened.isFile()||opened.dev!==finalStat.dev||opened.ino!==finalStat.ino||opened.nlink!==2n||(opened.mode&0o777n)!==0o600n)fail('REFERENCE_SPOOL_CHANGED');
    const digest=crypto.createHash('sha256'),buffer=Buffer.alloc(1024*1024);let count=0,n;
    while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0){count+=n;if(count>expectedBytes||count>maxBytes)fail('REFERENCE_SPOOL_SIZE');digest.update(buffer.subarray(0,n));}
    if(count!==expectedBytes||digest.digest('hex')!==expectedSha256)fail('REFERENCE_SPOOL_DIGEST');
    const after=fs.fstatSync(fd,{bigint:true}),partAfter=fs.lstatSync(part,{bigint:true}),finalAfter=fs.lstatSync(final,{bigint:true});
    if(after.dev!==opened.dev||after.ino!==opened.ino||after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs||partAfter.dev!==after.dev||partAfter.ino!==after.ino||finalAfter.dev!==after.dev||finalAfter.ino!==after.ino||after.nlink!==2n)fail('REFERENCE_SPOOL_CHANGED');
    checkAuthority(authority);fs.unlinkSync(part);fs.fsyncSync(authority.rootFd);checkAuthority(authority);
  }finally{fs.closeSync(fd);}
  return true;
}

function verifyRetainedReferenceResult({authority,storageKey,expectedSha256,expectedBytes,maxBytes} = {}) {
  checkAuthority(authority);
  if (!hash(storageKey) || !hash(expectedSha256) || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < expectedBytes) fail('REFERENCE_SPOOL_INVALID');
  const rootFd=authority.rootFd, relativePath=`${storageKey}.zip`, target=`/proc/self/fd/${rootFd}/${relativePath}`;
  let fd;
  try {
    fd=fs.openSync(target,fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile() || before.nlink!==1n || before.size!==BigInt(expectedBytes)) fail('REFERENCE_SPOOL_CHANGED');
    const digest=crypto.createHash('sha256'),buf=Buffer.alloc(1024*1024);let bytes=0,n;
    while((n=fs.readSync(fd,buf,0,buf.length,null))>0){bytes+=n;if(bytes>expectedBytes || bytes>maxBytes)fail('REFERENCE_SPOOL_SIZE');digest.update(buf.subarray(0,n));}
    if(bytes!==expectedBytes || digest.digest('hex')!==expectedSha256)fail('REFERENCE_SPOOL_DIGEST');
    fs.fsyncSync(fd);fs.fsyncSync(rootFd);checkAuthority(authority);
    const after=fs.fstatSync(fd,{bigint:true}),named=fs.lstatSync(target,{bigint:true});
    if(!named.isFile() || named.isSymbolicLink() || after.nlink!==1n || before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs || named.dev!==after.dev || named.ino!==after.ino || named.size!==after.size || named.mtimeNs!==after.mtimeNs || named.ctimeNs!==after.ctimeNs)fail('REFERENCE_SPOOL_CHANGED');
    return Object.freeze({relativePath,byteSize:bytes,sha256:expectedSha256});
  } finally { if(fd!==undefined)fs.closeSync(fd); }
}
module.exports = {retainReferenceResult,retainReferenceResultResumable,recoverLinkedReferenceResult,verifyRetainedReferenceResult,checkAuthority,CHECKPOINT_BYTES};
