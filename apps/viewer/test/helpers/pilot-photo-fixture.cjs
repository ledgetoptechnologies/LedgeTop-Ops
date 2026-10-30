'use strict';
// Review-only. The input directory must already be mounted read-only by the
// supervisor; this function does not establish mount or namespace isolation.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function stable(a,b){return ['dev','ino','mode','size','mtimeNs','ctimeNs'].every(k=>a[k]===b[k]);}
function digestFd(fd){const h=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let offset=0,count;while((count=fs.readSync(fd,buffer,0,buffer.length,offset))>0){h.update(buffer.subarray(0,count));offset+=count;}return h.digest('hex');}
function copyPilotPhotos({input,destination,expectedCount=40,maxFileBytes=64*1024*1024,maxTotalBytes=2*1024*1024*1024,reserveBytes=1024*1024*1024,reserveInodes=1024}){
 if(process.platform!=='linux'||expectedCount!==40||!Number.isSafeInteger(maxFileBytes)||maxFileBytes<1||maxFileBytes>64*1024*1024||!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<1||maxTotalBytes>2*1024*1024*1024)throw Error('invalid fixture limits');
 if(!Number.isSafeInteger(reserveBytes)||reserveBytes<1024*1024*1024||!Number.isSafeInteger(reserveInodes)||reserveInodes<1024)throw Error('invalid fixture reserve');
 const flags=fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW,opened=[];let inputFd,destinationFd;
 try{
  inputFd=fs.openSync(input,flags);destinationFd=fs.openSync(destination,flags);const sourceDir=`/proc/self/fd/${inputFd}`,targetDir=`/proc/self/fd/${destinationFd}`;
  const sourceStat=fs.fstatSync(inputFd,{bigint:true}),destStat=fs.fstatSync(destinationFd,{bigint:true});if(sourceStat.dev===destStat.dev&&sourceStat.ino===destStat.ino)throw Error('fixture source and destination match');
  const names=fs.readdirSync(sourceDir).filter(n=>/\.jpe?g$/i.test(n)).sort();if(names.length!==expectedCount||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw Error('invalid fixture photo count or names');
  let total=0;for(const name of names){if(path.basename(name)!==name)throw Error('invalid photo name');const fd=fs.openSync(`${sourceDir}/${name}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);opened.push({fd,name});const before=fs.fstatSync(fd,{bigint:true});if(!before.isFile()||before.size<1n||before.size>BigInt(maxFileBytes))throw Error('invalid photo size');total+=Number(before.size);if(!Number.isSafeInteger(total)||total>maxTotalBytes)throw Error('fixture exceeds byte limit');opened[opened.length-1].before=before;}
  const space=fs.statfsSync(targetDir,{bigint:true});if(space.bavail*space.bsize<BigInt(total)+BigInt(reserveBytes)||space.ffree<BigInt(expectedCount+reserveInodes))throw Error('insufficient fixture storage');
  const photos=[];for(const [i,entry] of opened.entries()){
   const {fd,name,before}=entry,hash=digestFd(fd);if(!stable(before,fs.fstatSync(fd,{bigint:true})))throw Error('source changed during hashing');
   const target=`${targetDir}/${name}`;fs.copyFileSync(`/proc/self/fd/${fd}`,target,fs.constants.COPYFILE_EXCL);const targetFd=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);try{const copied=fs.fstatSync(targetFd,{bigint:true});if(!copied.isFile()||copied.size!==before.size||digestFd(targetFd)!==hash||!stable(before,fs.fstatSync(fd,{bigint:true})))throw Error('photo copy or source changed');fs.fsyncSync(targetFd);}finally{fs.closeSync(targetFd);}
   photos.push({id:`photo-${i}`,relativePath:name,byteSize:Number(before.size),sha256:hash,contentType:'image/jpeg'});
  }
  fs.fsyncSync(destinationFd);return{files:photos,totalBytes:total};
 }finally{for(const {fd} of opened)fs.closeSync(fd);if(destinationFd!==undefined)fs.closeSync(destinationFd);if(inputFd!==undefined)fs.closeSync(inputFd);}
}
module.exports={copyPilotPhotos};
