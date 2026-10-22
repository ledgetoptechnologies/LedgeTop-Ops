'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {validateImportSelection}=require('./importBrowser');

const fail=(code,message=code)=>{throw Object.assign(new Error(message),{code});};
const decimal=(value)=>String(value);
function identity(stat){return{device:decimal(stat.dev),inode:decimal(stat.ino),ctimeNs:decimal(stat.ctimeNs),mtimeNs:decimal(stat.mtimeNs)};}
function sameOpenedObject(a,b){return a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size;}
function sameIdentity(a,b){return sameOpenedObject(a,b)&&a.ctimeNs===b.ctimeNs&&a.mtimeNs===b.mtimeNs;}
function matchesSourceSnapshot(left,right){return Boolean(left&&right&&left.relativePath===right.relativePath&&left.byteSize===right.byteSize&&left.sha256===right.sha256&&left.device===right.device&&left.inode===right.inode&&left.ctimeNs===right.ctimeNs&&left.mtimeNs===right.mtimeNs);}
async function hashDescriptor(fd,openedStat,{signal=null,strictIdentity=true}={}){if(signal?.aborted)fail('lease_lost','source hash cancelled');const hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024),size=Number(openedStat.size);let position=0;while(position<size){if(signal?.aborted)fail('lease_lost','source hash cancelled');const read=await new Promise((resolve,reject)=>fs.read(fd,buffer,0,Math.min(buffer.length,size-position),position,(error,count)=>error?reject(error):resolve(count)));if(read<=0)fail('source_changed','source changed while hashing');hash.update(buffer.subarray(0,read));position+=read;}const after=fs.fstatSync(fd,{bigint:true});if(!(strictIdentity?sameIdentity(openedStat,after):sameOpenedObject(openedStat,after)))fail('source_changed','source changed while hashing');return hash.digest('hex');}
function openImportFolderSource(storage,relativePath){
  let selected;
  try{selected=validateImportSelection(storage,relativePath,{expectedKind:'folder'});}catch{fail('invalid_import_source');}
  try{storage.resolve('dataset_import',selected.relativePath,{mustExist:true});}catch{fail('invalid_import_source');}
  const root=fs.realpathSync.native(storage.roots.dataset_import),components=selected.relativePath.split('/');
  let fd=null;
  try{fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);for(const component of components){const next=fs.openSync(`/proc/self/fd/${fd}/${component}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);fs.closeSync(fd);fd=next;}}catch{if(fd!==null)try{fs.closeSync(fd);}catch{}fail('invalid_import_source');}
  const stat=fs.fstatSync(fd,{bigint:true});if(!stat.isDirectory()){fs.closeSync(fd);fail('source_changed');}
  let closed=false;return{fd,absolutePath:path.join(root,...components),descriptorPath:`/proc/self/fd/${fd}`,relativePath:selected.relativePath,close(){if(closed)return;closed=true;fs.closeSync(fd);}};
}

function openImportZipSource(storage,relativePath){
  let selected;
  try{selected=validateImportSelection(storage,relativePath);}catch{fail('invalid_import_source');}
  if(selected.kind!=='zip')fail('invalid_import_source');
  // Resolve once for the configured-root containment check, but open every
  // component descriptor-relatively so a parent swap cannot redirect us.
  try{storage.resolve('dataset_import',selected.relativePath,{mustExist:true});}catch{fail('invalid_import_source');}
  const root=fs.realpathSync.native(storage.roots.dataset_import),components=selected.relativePath.split('/'),fileName=components.pop();
  if(path.extname(fileName).toLowerCase()!=='.zip')fail('invalid_import_source');
  let directoryFd=null,fd=null,before,descriptorPath;
  try{
    directoryFd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
    for(const component of components){const next=fs.openSync(`/proc/self/fd/${directoryFd}/${component}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);fs.closeSync(directoryFd);directoryFd=next;}
    descriptorPath=`/proc/self/fd/${directoryFd}/${fileName}`;
    before=fs.lstatSync(descriptorPath,{bigint:true});
    if(!before.isFile()||before.isSymbolicLink())fail('invalid_import_source');
    fd=fs.openSync(descriptorPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
  }catch(error){if(fd!==null)try{fs.closeSync(fd);}catch{}if(directoryFd!==null)try{fs.closeSync(directoryFd);}catch{}if(error.code==='invalid_import_source')throw error;fail('invalid_import_source');}
  const opened=fs.fstatSync(fd,{bigint:true});
  if(!opened.isFile()||!sameIdentity(before,opened)||opened.size>BigInt(Number.MAX_SAFE_INTEGER)){fs.closeSync(fd);fs.closeSync(directoryFd);fail('source_changed');}
  const absolutePath=path.join(root,...selected.relativePath.split('/'));
  let closed=false,cached=null;
  const ensureOpen=()=>{if(closed)fail('source_closed');};
  const verifyNamedSource=()=>{let named;try{named=fs.lstatSync(descriptorPath,{bigint:true});}catch{fail('source_changed','source path changed after opening');}if(!named.isFile()||named.isSymbolicLink()||!sameOpenedObject(opened,named))fail('source_changed','source path changed after opening');};
  const hash=async(options={})=>{ensureOpen();verifyNamedSource();const sha256=await hashDescriptor(fd,opened,options);verifyNamedSource();return sha256;};
  return{fd,absolutePath,relativePath:selected.relativePath,hash,async snapshot(options={}){const sha256=await hash(options);cached={relativePath:selected.relativePath,byteSize:Number(opened.size),sha256,...identity(opened)};return{...cached};},stream(){ensureOpen();verifyNamedSource();const options={fd,autoClose:false,start:0};if(opened.size>0n)options.end=Number(opened.size)-1;return fs.createReadStream(null,options);},currentSnapshot(){return cached?{...cached}:null;},close(){if(closed)return;closed=true;fs.closeSync(fd);fs.closeSync(directoryFd);}};
}
module.exports={hashDescriptor,matchesSourceSnapshot,openImportFolderSource,openImportZipSource};
