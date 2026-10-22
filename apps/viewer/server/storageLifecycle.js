'use strict';

const { sanitizeLogMessage } = require('./processingSecurity');

function exists(storage,rootKey,relativePath){return Boolean(rootKey&&relativePath&&storage.pathExistsStrict(rootKey,relativePath));}

function conflict(message){return Object.assign(new Error(message),{code:'lifecycle_conflict'});}

function markApplied(processing,mutation,options){
  const applied=processing.markStorageMutationFsApplied(mutation.id,options);
  if(applied)return applied;
  const current=processing.getStorageMutation(mutation.id);
  if(current?.status==='complete'||current?.status==='fs_applied')return current;
  throw conflict('lifecycle journal changed while applying filesystem effect');
}

function applyStorageMutation(processing,storage,input,{faultAt=null,supersessionProof=null}={}){
  const mutation=typeof input==='string'?processing.getStorageMutation(input):input;
  if(!mutation)return null;
  if(mutation.status==='complete'||mutation.status==='failed')return mutation;
  if(faultAt==='after_intent')throw Object.assign(new Error('injected failure after lifecycle intent'),{code:'fault_injected'});
  try{
    if(mutation.status==='intent'){
      if(mutation.type==='trash'||mutation.type==='restore'){
        const sourceExists=exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath),destinationExists=exists(storage,mutation.destinationRootKey,mutation.destinationRelativePath);
        if(sourceExists&&destinationExists)throw conflict('lifecycle source and destination both exist');
        if(sourceExists&&!destinationExists){require('./outputSupersession').requireSupersessionMutationProof(processing,mutation,supersessionProof);storage.moveExact(mutation.sourceRootKey,mutation.sourceRelativePath,mutation.destinationRootKey,mutation.destinationRelativePath);}
        else if(!sourceExists&&!destinationExists&&!mutation.allowAbsentSource)throw conflict('lifecycle source and destination are both absent');
        if(faultAt==='after_filesystem')throw Object.assign(new Error('injected failure after lifecycle filesystem effect'),{code:'fault_injected'});
        markApplied(processing,mutation,{destinationRelativePath:!sourceExists&&!destinationExists?'':mutation.destinationRelativePath});
      }else if(mutation.type==='purge'){
        if(exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath)){require('./outputSupersession').requireSupersessionMutationProof(processing,mutation,supersessionProof);storage.removeExact(mutation.sourceRootKey,mutation.sourceRelativePath);}
        if(faultAt==='after_filesystem')throw Object.assign(new Error('injected failure after lifecycle filesystem effect'),{code:'fault_injected'});
        markApplied(processing,mutation);
      }
    }
    const current=processing.getStorageMutation(mutation.id);
    if(current?.status==='fs_applied'){
      if(current.type==='trash'||current.type==='restore'){
        const sourceExists=exists(storage,current.sourceRootKey,current.sourceRelativePath),destinationExists=exists(storage,current.destinationRootKey,current.destinationRelativePath);
        if(sourceExists||(!destinationExists&&!current.allowAbsentSource))throw conflict('lifecycle filesystem state does not match the applied journal');
      }else if(current.type==='purge'&&exists(storage,current.sourceRootKey,current.sourceRelativePath))throw conflict('purged lifecycle source still exists');
    }
    if(faultAt==='after_fs')throw Object.assign(new Error('injected failure after lifecycle filesystem effect'),{code:'fault_injected'});
    return processing.completeStorageMutation(mutation.id);
  }catch(error){
    if(error.code==='fault_injected')throw error;
    // Deterministic state/configuration conflicts require operator repair. Database,
    // process, and transient filesystem errors intentionally leave the durable
    // intent/applied state recoverable on the next reconciliation pass.
    if(['lifecycle_conflict','lifecycle_cross_device'].includes(error.code))processing.failStorageMutation(mutation.id,error.code,sanitizeLogMessage(error.message));
    throw error;
  }
}

function reconcileStorageMutations(processing,storage,limit=20){const results=[];for(const mutation of processing.pendingStorageMutations(limit)){try{results.push(applyStorageMutation(processing,storage,mutation));}catch(error){results.push({id:mutation.id,status:'failed',errorCode:error.code||'lifecycle_failed'});}}return results;}

function purgeExpiredTrash(processing,storage,{actor='storage-maintenance',limit=20,onPurged=null}={}){
  const results=[];
  for(const item of processing.expiredTrash().slice(0,Math.max(1,Math.min(Number(limit)||20,100)))){
    try{
      if(item.entityType==='output'&&require('./outputSupersession').automaticSupersessionTrash(processing,item.id)){results.push({trashId:item.id,status:'deferred',errorCode:'supersession_reverification_required'});continue;}
      if(item.entityType==='project'||item.entityType==='task'){
        const {purgeContainerTrash}=require('./containerLifecycle');
        const purged=purgeContainerTrash(processing,storage,item.id,actor);
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',container:true});
        if(processing.getTrash(item.id)?.permanentlyDeletedAt)onPurged?.(item);
        continue;
      }
      const dataset=item.entityType==='dataset'?processing.getDataset(item.entityId):null;
      const output=item.entityType==='output'?processing.getModelOutput(item.entityId):null;
      if(!dataset&&!output){results.push({trashId:item.id,status:'failed',errorCode:'entity_not_found'});continue;}
      if(dataset?.storageMode==='external_reference'){
        const purged=processing.markTrashPurged(item.id);
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',externalReference:true});
      }else if(output&&output.storageMode!=='managed'){
        const purged=processing.purgeMetadataOutput(item.id);
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',externalReference:true});
      }else{
        const mutation=processing.beginPurgeMutation(item.id,actor);
        if(!mutation){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        const completed=applyStorageMutation(processing,storage,mutation);
        results.push({trashId:item.id,status:completed.status,mutationId:completed.id,externalReference:false});
      }
      if(processing.getTrash(item.id)?.permanentlyDeletedAt)onPurged?.(item);
    }catch(error){results.push({trashId:item.id,status:'failed',errorCode:error.code||'lifecycle_failed'});}
  }
  return results;
}

module.exports={applyStorageMutation,reconcileStorageMutations,purgeExpiredTrash};
