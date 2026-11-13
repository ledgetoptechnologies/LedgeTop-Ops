'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const {MAX_SHOTS_BYTES,MAX_CAMERA_FEATURES}=require('./cameraPhotos');
// Reduces observed races; SQLite cannot prevent an independent writer changing
// files after the final check or after the database transaction commits.
function captureProviderShots(root){
  let rootFd=null,dirFd=null,fileFd=null,transferred=false;
  const flags=fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC;
  const changed=()=>Object.assign(new Error('provider shots changed during registration'),{code:'provider_shots_changed'});
  const same=(a,b)=>a.dev===b.dev&&a.ino===b.ino&&a.mode===b.mode&&a.size===b.size&&a.mtimeNs===b.mtimeNs&&a.ctimeNs===b.ctimeNs;
  const close=()=>{for(const fd of [fileFd,dirFd,rootFd])if(fd!==null)try{fs.closeSync(fd);}catch{}fileFd=dirFd=rootFd=null;};
  try{
    rootFd=fs.openSync(root,flags|fs.constants.O_DIRECTORY);const rootStat=fs.fstatSync(rootFd,{bigint:true});
    try{dirFd=fs.openSync(`/proc/self/fd/${rootFd}/odm_report`,flags|fs.constants.O_DIRECTORY);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const dirStat=fs.fstatSync(dirFd,{bigint:true});
    try{fileFd=fs.openSync(`/proc/self/fd/${dirFd}/shots.geojson`,flags);}catch(error){if(error.code==='ENOENT')return null;throw error;}
    const fileStat=fs.fstatSync(fileFd,{bigint:true});if(!fileStat.isFile()||fileStat.size>BigInt(MAX_SHOTS_BYTES))return null;
    const checkNames=()=>{try{if(!same(rootStat,fs.lstatSync(root,{bigint:true}))||!same(dirStat,fs.lstatSync(`/proc/self/fd/${rootFd}/odm_report`,{bigint:true}))||!same(fileStat,fs.lstatSync(`/proc/self/fd/${dirFd}/shots.geojson`,{bigint:true}))||!same(fileStat,fs.fstatSync(fileFd,{bigint:true})))throw changed();}catch(error){if(error.code==='provider_shots_changed')throw error;throw changed();}};
    const read=()=>{const bytes=Buffer.alloc(Number(fileStat.size));let at=0;while(at<bytes.length){const count=fs.readSync(fileFd,bytes,at,bytes.length-at,at);if(count<=0)throw changed();at+=count;}return bytes;};
    checkNames();const bytes=read();checkNames();let document;try{document=JSON.parse(bytes.toString('utf8'));}catch{return null;}
    if(document?.type!=='FeatureCollection'||!Array.isArray(document.features)||document.features.length>MAX_CAMERA_FEATURES)return null;
    const sha256=crypto.createHash('sha256').update(bytes).digest('hex'),chunkSize=4*1024*1024,chunks=[];
    if(bytes.length>chunkSize)for(let offset=0,index=0;offset<bytes.length;offset+=chunkSize,index++){const piece=bytes.subarray(offset,offset+chunkSize);chunks.push({chunkIndex:index,byteOffset:offset,byteSize:piece.length,sha256:crypto.createHash('sha256').update(piece).digest('hex')});}
    const result={byteSize:bytes.length,sha256,chunks,verify(){checkNames();if(crypto.createHash('sha256').update(read()).digest('hex')!==sha256)throw changed();checkNames();},close};
    transferred=true;return result;
  }finally{if(!transferred)close();}
}
module.exports={captureProviderShots};
