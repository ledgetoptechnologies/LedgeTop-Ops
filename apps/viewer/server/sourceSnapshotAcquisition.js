'use strict';
// Offline, unexposed acquisition only. This is neither a retention receipt nor
// proof that a writer, alias, administrator or external NAS client is fenced.
// No route or worker uses this module. Never wire it to issuance without an
// independently enforced source barrier and production-bound identity registry.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {safeRelativePath}=require('./processingSecurity');
const LIMIT=20001,MAX_DIRS=20001,MAX_DEPTH=128,CHUNK=1024*1024;
const fail=(code='source_snapshot_unavailable')=>Object.assign(new Error(code),{code});
const slug=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function relative(value){if(typeof value!=='string'||value.length>4096||value.split('/').length>MAX_DEPTH||safeRelativePath(value)!==value||value.startsWith('/')||value.split('/').some(p=>!p||p==='.'||p==='..'))throw fail();return value;}
function identity(stat){return [stat.dev,stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.nlink].map(String).join(':');}
function openDir(fd,name){return fs.openSync(`/proc/self/fd/${fd}/${name}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}
function openFile(fd,name){const f=fs.openSync(`/proc/self/fd/${fd}/${name}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK|fs.constants.O_CLOEXEC);try{if(!fs.fstatSync(f,{bigint:true}).isFile())throw fail();return f;}catch(e){fs.closeSync(f);throw e;}}
function openPath(rootFd,rel,isDir=false){let parent=fs.dupSync?fs.dupSync(rootFd):fs.openSync(`/proc/self/fd/${rootFd}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_CLOEXEC);try{const parts=relative(rel).split('/');for(const p of parts.slice(0,-1)){const next=openDir(parent,p);fs.closeSync(parent);parent=next;}return isDir?openDir(parent,parts.at(-1)):openFile(parent,parts.at(-1));}finally{fs.closeSync(parent);}}
function openAbsoluteDir(root){if(!path.posix.isAbsolute(root)||path.posix.normalize(root)!==root)throw fail();const base=fs.openSync('/',fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);if(root==='/')return base;try{return openPath(base,root.slice(1),true)}finally{fs.closeSync(base)}}
function readMetadata(db,datasetId,projectId){
 const d=db.prepare('SELECT id,project_id,storage_mode,root_key,relative_path,status,manifest_sha256,file_count,byte_size,finalized_at FROM datasets WHERE id=?').get(datasetId);
 if(!d||d.project_id!==projectId||!['managed','adopted'].includes(d.storage_mode)||d.root_key!=='datasets'||d.status!=='finalized'||!hash(d.manifest_sha256)||!d.finalized_at||!Number.isSafeInteger(d.file_count)||d.file_count<1||d.file_count>LIMIT||!Number.isSafeInteger(d.byte_size)||d.byte_size<0)throw fail();
 relative(d.relative_path);
 const files=db.prepare('SELECT id,relative_path,byte_size,sha256 FROM dataset_files WHERE dataset_id=? ORDER BY rowid LIMIT ?').all(datasetId,LIMIT+1);
 if(files.length!==d.file_count||files.length>LIMIT)throw fail();const ids=new Set(),paths=new Set();let total=0;
 for(const f of files){if(!slug(f.id)||!hash(f.sha256)||!Number.isSafeInteger(f.byte_size)||f.byte_size<0||ids.has(f.id))throw fail();relative(f.relative_path);if(paths.has(f.relative_path))throw fail();ids.add(f.id);paths.add(f.relative_path);total+=f.byte_size;if(!Number.isSafeInteger(total))throw fail();}
 const computed=crypto.createHash('sha256').update(JSON.stringify(files.map(f=>({relativePath:f.relative_path,byteSize:f.byte_size,sha256:f.sha256})))).digest('hex');
 if(total!==d.byte_size||computed!==d.manifest_sha256)throw fail();return {dataset:d,files};
}
function createSourceSnapshotAcquirer({database,environment,projectId,holderRegistry,managedRoot,managedRootFd}={}){
 // Caller-controlled registries are not authentication; production binding is a separate gate.
 if(!database||!['staging','production'].includes(environment)||!slug(projectId)||!Array.isArray(holderRegistry)||holderRegistry.length!==1||!holderRegistry[0]||holderRegistry[0].holderId!=='viewer-odm'||holderRegistry[0].environment!==environment||holderRegistry[0].projectId!==projectId||!slug(holderRegistry[0].registryVersion)||typeof managedRoot!=='string'||!path.isAbsolute(managedRoot)||(managedRootFd!==undefined&&(!Number.isInteger(managedRootFd)||managedRootFd<0)))throw fail();
 const holder=Object.freeze({...holderRegistry[0]});
 function acquire({datasetId,holderId}={}){
  if(process.platform!=='linux'||!fs.existsSync('/proc/self/fd')||!slug(datasetId)||holderId!==holder.holderId)throw fail();
  const meta=readMetadata(database,datasetId,projectId),rootPath=path.resolve(managedRoot),openRoot=()=>managedRootFd===undefined?openAbsoluteDir(rootPath):fs.openSync(`/proc/self/fd/${managedRootFd}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_CLOEXEC);
  let rootFd,datasetFd;
  try{
   rootFd=openRoot();
   const rootBefore=fs.fstatSync(rootFd,{bigint:true});datasetFd=openPath(rootFd,meta.dataset.relative_path,true);const datasetBefore=fs.fstatSync(datasetFd,{bigint:true});
   // One bounded buffer per acquisition, not one megabyte per photo. Files
   // are read sequentially and their bytes are never placed in SQLite.
   const indexed=new Map(meta.files.map(f=>[f.relative_path,f])),observed=new Map(),directories=new Map(),buffer=Buffer.allocUnsafe(CHUNK);let dirs=0;
   function walk(fd,prefix=''){
    if(++dirs>MAX_DIRS)throw fail();const directoryBefore=identity(fs.fstatSync(fd,{bigint:true}));directories.set(prefix,directoryBefore);const dir=fs.opendirSync(`/proc/self/fd/${fd}`);
    try{let ent;while((ent=dir.readSync())!==null){const rel=prefix?`${prefix}/${ent.name}`:ent.name;relative(rel);if(ent.isDirectory()){const child=openDir(fd,ent.name);try{walk(child,rel);}finally{fs.closeSync(child);}}else if(ent.isFile()){
      if(observed.size>=LIMIT||!indexed.has(rel))throw fail();const fileFd=openFile(fd,ent.name);try{
       const before=fs.fstatSync(fileFd,{bigint:true}),expected=indexed.get(rel);if(before.nlink!==1n||before.size!==BigInt(expected.byte_size))throw fail();
       const digest=crypto.createHash('sha256');let offset=0;while(offset<expected.byte_size){const size=Math.min(buffer.length,expected.byte_size-offset),read=fs.readSync(fileFd,buffer,0,size,offset);if(read!==size)throw fail();digest.update(buffer.subarray(0,read));offset+=read;}
       const after=fs.fstatSync(fileFd,{bigint:true}),actual=digest.digest('hex');if(identity(before)!==identity(after)||actual!==expected.sha256)throw fail();observed.set(rel,{id:expected.id,relativePath:rel,byteSize:expected.byte_size,sha256:actual,isRawCsv:/\.csv$/i.test(rel),fileIdentity:identity(after)});
      }finally{fs.closeSync(fileFd);}
    }else throw fail();}}finally{dir.closeSync()}
   }
   walk(datasetFd);if(observed.size!==indexed.size)throw fail();
   // Reopen each traversed directory and file to detect changes/replacements.
   for(const [rel,expected] of directories){const fd=rel?openPath(datasetFd,rel,true):fs.openSync(`/proc/self/fd/${datasetFd}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_CLOEXEC);try{if(identity(fs.fstatSync(fd,{bigint:true}))!==expected)throw fail();}finally{fs.closeSync(fd);}}
   // Reopen every name from the pinned root to detect replacement while walking.
   for(const item of observed.values()){const fd=openPath(datasetFd,item.relativePath);try{if(identity(fs.fstatSync(fd,{bigint:true}))!==item.fileIdentity)throw fail();}finally{fs.closeSync(fd);}}
   const freshDatasetFd=openPath(rootFd,meta.dataset.relative_path,true);try{if(identity(fs.fstatSync(freshDatasetFd,{bigint:true}))!==identity(datasetBefore))throw fail();}finally{fs.closeSync(freshDatasetFd);}
   const freshRootFd=openRoot();try{if(identity(fs.fstatSync(freshRootFd,{bigint:true}))!==identity(rootBefore))throw fail();}finally{fs.closeSync(freshRootFd);}
   const finalMeta=readMetadata(database,datasetId,projectId);if(JSON.stringify(finalMeta)!==JSON.stringify(meta))throw fail();
   const files=[...observed.values()].sort((a,b)=>a.relativePath<b.relativePath?-1:a.relativePath>b.relativePath?1:0).map(({fileIdentity,...v})=>v);
   // A later cheap identity check detects ordinary changes after hashing. It
   // is not a lock: bytes can still change immediately after this check.
   function verifyIdentity(){let root,dir;try{root=openRoot();if(identity(fs.fstatSync(root,{bigint:true}))!==identity(rootBefore))throw fail();dir=openPath(root,meta.dataset.relative_path,true);if(identity(fs.fstatSync(dir,{bigint:true}))!==identity(datasetBefore))throw fail();for(const [rel,expected] of directories){const fd=rel?openPath(dir,rel,true):fs.openSync(`/proc/self/fd/${dir}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_CLOEXEC);try{if(identity(fs.fstatSync(fd,{bigint:true}))!==expected)throw fail()}finally{fs.closeSync(fd)}}for(const item of observed.values()){const fd=openPath(dir,item.relativePath);try{if(identity(fs.fstatSync(fd,{bigint:true}))!==item.fileIdentity)throw fail()}finally{fs.closeSync(fd)}}return true}catch{throw fail()}finally{if(dir!==undefined)fs.closeSync(dir);if(root!==undefined)fs.closeSync(root)}}
   return {type:'unfenced_source_snapshot',environment,projectId,holderId:holder.holderId,registryVersion:holder.registryVersion,datasetId,rootKey:'datasets',datasetRelativePath:meta.dataset.relative_path,datasetManifestSha256:meta.dataset.manifest_sha256,files,verifyIdentity};
  }catch(error){if(error?.code==='source_snapshot_unavailable')throw error;throw fail();}finally{if(datasetFd!==undefined)fs.closeSync(datasetFd);if(rootFd!==undefined)fs.closeSync(rootFd);}
 }
 return Object.freeze({acquire});
}
module.exports={createSourceSnapshotAcquirer,LIMIT};
