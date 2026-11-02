'use strict';
// Unmounted observational candidate. Not physical reservation or authority.
const fs=require('node:fs'),path=require('node:path'),{performance}=require('node:perf_hooks');
const {createCapacityObserver}=require('./capacityObservation');
const spoolObservers=new WeakSet();
const fail=()=>{throw Object.assign(new Error('spool capacity unavailable'),{code:'SPOOL_CAPACITY_UNAVAILABLE'});};
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(x);
const number=x=>{if(x<0n||x>BigInt(Number.MAX_SAFE_INTEGER))fail();return Number(x);};
function createSpoolCapacityObserver({storageRoot,spoolRelative,domainId,domainRevision,expectedDevice,expectedInode,reserveBytes,reserveInodes}={}){
 if(process.platform!=='linux'||typeof storageRoot!=='string'||!path.posix.isAbsolute(storageRoot)||path.posix.normalize(storageRoot)!==storageRoot||typeof spoolRelative!=='string'||!spoolRelative.split('/').every(x=>/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x))||!ident(domainId)||!ident(domainRevision)||typeof expectedDevice!=='string'||!/^\d+$/.test(expectedDevice)||typeof expectedInode!=='string'||!/^\d+$/.test(expectedInode)||!Number.isSafeInteger(reserveBytes)||reserveBytes<0||!Number.isSafeInteger(reserveInodes)||reserveInodes<0)fail();
 const attestor={observe(request){if(request.domainId!==domainId||request.domainRevision!==domainRevision)fail();let root,current;try{
  if(fs.realpathSync(storageRoot)!==storageRoot)fail();root=fs.openSync(storageRoot,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);current=fs.openSync(`/proc/self/fd/${root}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
  for(const part of spoolRelative.split('/')){const next=fs.openSync(`/proc/self/fd/${current}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW);fs.closeSync(current);current=next;}
  const info=fs.fstatSync(current,{bigint:true});if(String(info.dev)!==expectedDevice||String(info.ino)!==expectedInode)fail();
  const stats=fs.statfsSync(`/proc/self/fd/${current}`,{bigint:true});const availableBytes=number(stats.bavail*stats.bsize),availableInodes=number(stats.ffree);
  return {domainId,domainRevision,sampledAt:performance.now(),samples:[{domainId,domainRevision,availableBytes,availableInodes,reserveBytes,reserveInodes}]};
 }catch{fail();}finally{if(current!==undefined)fs.closeSync(current);if(root!==undefined)fs.closeSync(root);}}};
 // A branded observer is still not an independently trusted domain attestor.
 const observer=createCapacityObserver({attestor});spoolObservers.add(observer);return observer;
}
function isSpoolCapacityObserver(observer){return spoolObservers.has(observer);}
module.exports={createSpoolCapacityObserver,isSpoolCapacityObserver};
