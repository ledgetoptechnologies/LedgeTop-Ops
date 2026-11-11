'use strict';
// Only launched against the parent test's private temporary fixture on Linux.
const fs=require('node:fs'),path=require('node:path');
const {openDatabase}=require('../../server/database');
const {ProcessingRepository}=require('../../server/processingRepository');
const {ViewerRepository}=require('../../server/repository');
const {StorageManager}=require('../../server/storageManager');
const {processIngest}=require('../../server/processingWorker');
const {root,config,job,destination,intent}=JSON.parse(process.argv[2]);
const database=openDatabase(path.join(root,'viewer.sqlite'));
const processing=new ProcessingRepository(database),repository=new ViewerRepository(database),storage=new StorageManager(config);
const rename=fs.renameSync;
fs.renameSync=function(source,target){
  if(path.resolve(target)===path.resolve(destination)){
    if(!database.isTransaction)throw Error('promotion was outside receipt transaction');
    rename.call(this,source,target);process.kill(process.pid,'SIGKILL');
  }
  return rename.call(this,source,target);
};
const sourceIntake={outbox:{getIntent:()=>intent}};
processIngest(job,{processing,repository,storage,config,sourceIntake,providerCredentials:{resolve:()=>{throw Error('unexpected legacy provider');}},signal:new AbortController().signal})
  .then(()=>{console.error('expected SIGKILL point was not reached');process.exitCode=1;})
  .catch(error=>{console.error(error);process.exitCode=1;});
