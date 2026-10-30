'use strict';

// Experimental building block only. The caller must execute and reconcile the
// complete journal while the child owns this lock; it is not wired to live
// container actions. The lock directory must be private, shared by all
// executors, and durable on a filesystem with verified flock semantics.
// The executor must not delegate filesystem effects to descendants: on timeout
// this wrapper kills only the lock-owning process. Recovery still has to
// reconcile any interrupted filesystem effect before issuing another one.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawn}=require('node:child_process');

function runLockedExecutor({lockDirectory,containerId,executorPath,input,timeoutMs=60000}){
  if(process.platform!=='linux')throw new Error('container executor requires verified Linux flock');
  if(!/^[a-f0-9-]{36}$/i.test(containerId||''))throw new Error('invalid container lock identity');
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||timeoutMs>3600000)throw new Error('invalid executor timeout');
  const directory=fs.realpathSync.native(lockDirectory),directoryStat=fs.statSync(directory);
  if(!directoryStat.isDirectory()||(directoryStat.mode&0o022)!==0||directoryStat.uid!==process.getuid())throw new Error('container lock directory is not private');
  const payload=JSON.stringify(input);if(Buffer.byteLength(payload)>65536)throw new Error('executor input too large');
  const lockPath=path.join(directory,`${containerId.toLowerCase()}.lock`);let fd;
  try{fd=fs.openSync(lockPath,fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_RDWR|fs.constants.O_NOFOLLOW,0o600);try{fs.writeFileSync(fd,crypto.randomBytes(32));fs.fsyncSync(fd);}catch(error){fs.closeSync(fd);throw error;}}
  catch(error){if(error.code!=='EEXIST')throw error;fd=fs.openSync(lockPath,fs.constants.O_RDWR|fs.constants.O_NOFOLLOW);}
  let identity;
  try{const stat=fs.fstatSync(fd,{bigint:true}),nonce=Buffer.alloc(32);if(!stat.isFile()||stat.nlink!==1n||stat.size!==32n||stat.uid!==BigInt(process.getuid())||(stat.mode&0o077n)!==0n||fs.readSync(fd,nonce,0,32,0)!==32)throw new Error('container lock file is not private');identity={device:String(stat.dev),inode:String(stat.ino),nonceSha256:crypto.createHash('sha256').update(nonce).digest('hex')};}catch(error){fs.closeSync(fd);throw error;}
  return new Promise((resolve,reject)=>{
    let child;
    try{child=spawn('/usr/bin/flock',['-n','-F','-E','73','/proc/self/fd/3',process.execPath,executorPath],{stdio:['pipe','pipe','pipe',fd],env:{...process.env,VIEWER_CONTAINER_LOCK_DEVICE:identity.device,VIEWER_CONTAINER_LOCK_INODE:identity.inode,VIEWER_CONTAINER_LOCK_NONCE_SHA256:identity.nonceSha256},windowsHide:true});}catch(error){fs.closeSync(fd);reject(error);return;}
    fs.closeSync(fd);
    let stdout='',stderr='',timedOut=false,spawnError=null;
    const append=(prior,chunk)=>(prior+chunk.toString('utf8')).slice(0,65536);
    child.stdout.on('data',chunk=>{stdout=append(stdout,chunk);});child.stderr.on('data',chunk=>{stderr=append(stderr,chunk);});
    child.on('error',error=>{spawnError=error;});child.stdin.on('error',()=>{});
    const timer=setTimeout(()=>{timedOut=true;child.kill('SIGKILL');},timeoutMs);
    child.on('close',(code,signal)=>{clearTimeout(timer);if(spawnError)return reject(spawnError);resolve({code,signal,timedOut,lockConflictOrReservedExit:code===73,stdout,stderr});});
    child.stdin.end(payload);
  });
}

function inheritedLockIdentity(){
  const stat=fs.fstatSync(3,{bigint:true}),device=process.env.VIEWER_CONTAINER_LOCK_DEVICE,inode=process.env.VIEWER_CONTAINER_LOCK_INODE,nonceSha256=process.env.VIEWER_CONTAINER_LOCK_NONCE_SHA256,nonce=Buffer.alloc(32);
  if(!stat.isFile()||stat.nlink!==1n||stat.uid!==BigInt(process.getuid())||(stat.mode&0o077n)!==0n||stat.size!==32n||!/^\d+$/.test(device||'')||!/^\d+$/.test(inode||'')||!/^[a-f0-9]{64}$/.test(nonceSha256||'')||String(stat.dev)!==device||String(stat.ino)!==inode||fs.readSync(3,nonce,0,32,0)!==32||crypto.createHash('sha256').update(nonce).digest('hex')!==nonceSha256)throw new Error('inherited container lock identity mismatch');
  const major=((stat.dev>>8n)&0xfffn)|((stat.dev>>32n)&0xfffff000n),minor=(stat.dev&0xffn)|((stat.dev>>12n)&0xffffff00n);
  const held=fs.readFileSync('/proc/locks','utf8').split('\n').some(line=>{const match=line.match(/^\s*\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+(\d+)\s+([a-f0-9]+):([a-f0-9]+):(\d+)\s+0\s+EOF\s*$/i);return Boolean(match&&Number(match[1])===process.pid&&BigInt(`0x${match[2]}`)===major&&BigInt(`0x${match[3]}`)===minor&&BigInt(match[4])===stat.ino);});
  if(!held)throw new Error('executor does not hold the expected flock');
  return{device,inode,nonceSha256};
}

module.exports={runLockedExecutor,inheritedLockIdentity};
