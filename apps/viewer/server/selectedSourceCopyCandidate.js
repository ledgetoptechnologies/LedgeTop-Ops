'use strict';
// Unmounted, one-shot synthetic candidate. No writer fence, custody or admission.
// Descriptor traversal and checked-copy approach adapted from sourceSpoolCopyCandidate.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {canonicalBytes}=require('./referenceProtocol');
const {prepareSelectedGeneration}=require('./selectedSourceGenerationCandidate');
const fail=()=>{throw Object.assign(new Error('source copy held'),{code:'SELECTED_COPY_HELD'});};
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs&&a.nlink===b.nlink;
function rootOpen(root,pin){
 if(typeof root!=='string'||!path.posix.isAbsolute(root)||path.posix.normalize(root)!==root||fs.realpathSync(root)!==root||!pin||typeof pin.device!=='string'||typeof pin.inode!=='string')fail();
 const fd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
 const s=fs.fstatSync(fd,{bigint:true});if(String(s.dev)!==pin.device||String(s.ino)!==pin.inode){fs.closeSync(fd);fail();}return fd;
}
function fileOpen(root,relative){
 if(typeof relative!=='string'||!relative||relative.includes('\\')||relative.split('/').some(x=>!x||x==='.'||x==='..'||/[\x00-\x1f\x7f]/.test(x)))fail();
 const parts=relative.split('/');let dir=fs.openSync(`/proc/self/fd/${root}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
 try { for(const part of parts.slice(0,-1)){const next=fs.openSync(`/proc/self/fd/${dir}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fs.closeSync(dir);dir=next;}
  const fd=fs.openSync(`/proc/self/fd/${dir}/${parts.at(-1)}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);if(!fs.fstatSync(fd).isFile()){fs.closeSync(fd);fail();}return fd;
 }finally{fs.closeSync(dir);}
}
function copySelectedSource(processing,{binding,sourceRoot,sourcePin,spoolRoot,spoolPin,minFreeBytes=1,maxBytes=68719476736}={}){
 if(process.platform!=='linux'||!Number.isSafeInteger(minFreeBytes)||minFreeBytes<1||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>68719476736)fail();
 let source,out,dir;
 try{
  const checked=prepareSelectedGeneration(processing,binding);if(!checked.replay||checked.admissionAvailable!==false)fail();
  const row=processing.database.prepare('SELECT * FROM candidate_selected_source_generations WHERE attempt_id=? AND generation=?').get(binding.attemptId,binding.generation);
  if(!row||row.state!=='held'||row.root_ref!==binding.rootRef||row.snapshot_sha256!==binding.snapshotSha256)fail();
  const files=JSON.parse(row.selected_json),dataset=processing.getDataset(processing.getAttempt(binding.attemptId).datasetId);
  const total=files.reduce((sum,f)=>sum+f.byteSize,0);if(!Number.isSafeInteger(total)||total>maxBytes)fail();
  source=rootOpen(sourceRoot,sourcePin);out=rootOpen(spoolRoot,spoolPin);
  const sourceIdentity=fs.fstatSync(source,{bigint:true}),spoolIdentity=fs.fstatSync(out,{bigint:true});if(sourceIdentity.dev===spoolIdentity.dev&&sourceIdentity.ino===spoolIdentity.ino)fail();
  // statfs is an observation, not a reservation or a freshness guarantee.
  let remaining=total;
  const free=()=>{const current=fs.lstatSync(spoolRoot,{bigint:true}),opened=fs.fstatSync(out,{bigint:true});
   if(!current.isDirectory()||current.dev!==opened.dev||current.ino!==opened.ino||!Number.isSafeInteger(remaining)||remaining<0||remaining>total)fail();
   const s=fs.statfsSync(`/proc/self/fd/${out}`,{bigint:true});
   if(typeof s.bavail!=='bigint'||typeof s.bsize!=='bigint'||s.bavail<0n||s.bsize<=0n||s.bavail*s.bsize<BigInt(minFreeBytes)+BigInt(remaining))fail();};
  const name=`${binding.attemptId}-g${binding.generation}`;if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,160}$/.test(name))fail();free();
  fs.mkdirSync(`/proc/self/fd/${out}/${name}`,{mode:0o700});fs.fsyncSync(out);
  dir=fs.openSync(`/proc/self/fd/${out}/${name}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);
  const seal={version:2,attemptId:binding.attemptId,generation:binding.generation,snapshotSha256:binding.snapshotSha256,rootRef:binding.rootRef,selectedSha256:row.selected_sha256,objects:files};
  const intent=canonicalBytes(seal);let intentFd=fs.openSync(`/proc/self/fd/${dir}/intent.json`,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_WRONLY|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(intentFd,intent);fs.fsyncSync(intentFd);}finally{fs.closeSync(intentFd);}fs.fsyncSync(dir);
  const buffer=Buffer.allocUnsafe(1024*1024);
  for(const f of files){let input,output;try{
   input=fileOpen(source,`${dataset.relativePath}/${f.relativePath}`);const before=fs.fstatSync(input,{bigint:true});if(before.size!==BigInt(f.byteSize)||before.nlink!==1n)fail();
   output=fs.openSync(`/proc/self/fd/${dir}/${f.id}`,fs.constants.O_RDWR|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   const d=crypto.createHash('sha256');let pos=0;while(pos<f.byteSize){free();const n=fs.readSync(input,buffer,0,Math.min(buffer.length,f.byteSize-pos),pos);if(n<=0)fail();d.update(buffer.subarray(0,n));let written=0;while(written<n){free();const v=fs.writeSync(output,buffer,written,n-written,pos+written);if(v<=0)fail();written+=v;remaining-=v;}pos+=n;}
   if(!same(before,fs.fstatSync(input,{bigint:true}))||d.digest('hex')!==f.sha256)fail();fs.fsyncSync(output);
   const dest=fs.fstatSync(output,{bigint:true}),verify=crypto.createHash('sha256');let n=0;while(n<f.byteSize){const v=fs.readSync(output,buffer,0,Math.min(buffer.length,f.byteSize-n),n);if(v<=0)fail();verify.update(buffer.subarray(0,v));n+=v;}
   if(!same(dest,fs.fstatSync(output,{bigint:true}))||dest.size!==BigInt(f.byteSize)||verify.digest('hex')!==f.sha256)fail();
  }finally{if(output!==undefined)fs.closeSync(output);if(input!==undefined)fs.closeSync(input);}}
  free();let sealFd=fs.openSync(`/proc/self/fd/${dir}/.seal-pending`,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
  try{fs.writeFileSync(sealFd,intent);fs.fsyncSync(sealFd);}finally{fs.closeSync(sealFd);}
  fs.linkSync(`/proc/self/fd/${dir}/.seal-pending`,`/proc/self/fd/${dir}/sealed.json`);fs.fsyncSync(dir);fs.fsyncSync(out);
  return {state:'held',sealSha256:hash(intent),admissionAvailable:false};
 }catch{fail();}finally{if(dir!==undefined)fs.closeSync(dir);if(out!==undefined)fs.closeSync(out);if(source!==undefined)fs.closeSync(source);}
}
module.exports={copySelectedSource};
