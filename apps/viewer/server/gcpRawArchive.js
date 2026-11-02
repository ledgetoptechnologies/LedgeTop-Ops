'use strict';

// Dormant materializer: not connected to routes or background recovery. A
// verified root authority and writer fence are still required before use.
const crypto = require('node:crypto');
const fs = require('node:fs');
const { descriptorMountId } = require('./storageManager');
const { MAX_SOURCE_BYTES } = require('./gcpImport');

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const shaPattern = /^[0-9a-f]{64}$/;
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC;

function archiveError(message) { return Object.assign(new Error(message), { code: 'gcp_archive_unavailable' }); }
function sameStat(a,b) { return a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeNs===b.mtimeNs && a.ctimeNs===b.ctimeNs; }

function openChildDirectory(parentFd, name, expectedMount) {
  const child = `/proc/self/fd/${parentFd}/${name}`;
  try { fs.mkdirSync(child, { mode: 0o700 }); fs.fsyncSync(parentFd); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const fd = fs.openSync(child, DIR_FLAGS);
  try {
    if (!fs.fstatSync(fd).isDirectory() || descriptorMountId(fd) !== expectedMount) throw archiveError('archive directory mount changed');
    return fd;
  } catch (error) { fs.closeSync(fd); throw error; }
}

function validateFile(directoryFd, name, expectedBytes, expectedHash, expectedMount) {
  const fd=fs.openSync(`/proc/self/fd/${directoryFd}/${name}`, fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC|fs.constants.O_NONBLOCK);
  try {
    const before=fs.fstatSync(fd,{bigint:true});
    if(!before.isFile() || before.size!==BigInt(expectedBytes.length) || descriptorMountId(fd)!==expectedMount) throw archiveError('archive entry is not the expected file');
    const bytes=fs.readFileSync(fd), after=fs.fstatSync(fd,{bigint:true});
    if(!sameStat(before,after) || !bytes.equals(expectedBytes) || crypto.createHash('sha256').update(bytes).digest('hex')!==expectedHash) throw archiveError('archive bytes changed');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}

function materializeGcpRawSourceCore(rootPath, { datasetId, bytes, sha256 }) {
  if(process.platform!=='linux' || typeof datasetId!=='string' || !uuid.test(datasetId) || datasetId!==datasetId.toLowerCase() || typeof sha256!=='string' || !shaPattern.test(sha256) || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length>MAX_SOURCE_BYTES || crypto.createHash('sha256').update(bytes).digest('hex')!==sha256) throw archiveError('invalid raw GCP archive input');
  const rootFd=fs.openSync(rootPath,DIR_FLAGS), opened=[];
  try {
    const mount=descriptorMountId(rootFd), archiveFd=openChildDirectory(rootFd,'.gcp-retained',mount); opened.push(archiveFd);
    const datasetFd=openChildDirectory(archiveFd,datasetId.toLowerCase(),mount); opened.push(datasetFd);
    const finalName=`${sha256}.csv`, tmpName=`.${crypto.randomUUID()}.partial`;
    let tempFd;
    try {
      tempFd=fs.openSync(`/proc/self/fd/${datasetFd}/${tmpName}`,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);
      fs.writeFileSync(tempFd,bytes); fs.fsyncSync(tempFd); fs.closeSync(tempFd); tempFd=undefined;
      try { fs.linkSync(`/proc/self/fd/${datasetFd}/${tmpName}`,`/proc/self/fd/${datasetFd}/${finalName}`); }
      catch(error) { if(error.code!=='EEXIST') throw error; }
      validateFile(datasetFd,finalName,bytes,sha256,mount);
      fs.fsyncSync(datasetFd);
      // Only the redundant temporary copy is removed after the final link is
      // verified and synced. Pending journals remain the recovery authority.
      fs.unlinkSync(`/proc/self/fd/${datasetFd}/${tmpName}`); fs.fsyncSync(datasetFd);
      if(descriptorMountId(rootFd)!==mount || descriptorMountId(datasetFd)!==mount) throw archiveError('archive mount changed');
      return `.gcp-retained/${datasetId.toLowerCase()}/${finalName}`;
    } finally { if(tempFd!==undefined) fs.closeSync(tempFd); }
  } finally { for(const fd of opened.reverse())fs.closeSync(fd); fs.closeSync(rootFd); }
}
// Optional isolated fixture injection only. This primitive has no database in
// its ordinary interface, so an old or direct caller can still bypass it.
function materializeGcpRawSource(rootPath,input,{processing,managedWriterFixture}={}){
 if(processing||managedWriterFixture){const {isManagedWriterFixture}=require('./referenceSourceScanFixture');if(!isManagedWriterFixture(managedWriterFixture,processing))throw archiveError('fixture writer unavailable');return managedWriterFixture.run('gcp_raw',()=>materializeGcpRawSourceCore(rootPath,input));}
 return materializeGcpRawSourceCore(rootPath,input);
}

module.exports={materializeGcpRawSource};
