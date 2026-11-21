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

// Items whose purge failed are not retried by this process until this much
// time has passed, so a handful of persistently failing entries cannot take
// every slot of every hourly pass. The map lives in memory only: a restart
// simply retries everything once.
const TRASH_FAILURE_BACKOFF_MS=6*3600_000;
const trashRetryAfter=new Map();

// limit counts entries this pass actually attempts. Automatic-supersession
// items are purged by their own verified step, and items in failure backoff
// are reported but skipped, so neither consumes a slot.
function purgeExpiredTrash(processing,storage,{actor='storage-maintenance',limit=20,onPurged=null,now=Date.now,failureBackoffMs=TRASH_FAILURE_BACKOFF_MS}={}){
  const results=[],max=Math.max(1,Math.min(Number(limit)||20,100)),current=Number(now())||Date.now();
  let attempted=0;
  for(const [trashId,retryAt] of trashRetryAfter)if(retryAt<=current)trashRetryAfter.delete(trashId);
  for(const item of processing.expiredTrash(current)){
    if(attempted>=max)break;
    const before=results.length;
    try{
      if(item.entityType==='output'&&require('./outputSupersession').automaticSupersessionTrash(processing,item.id)){results.push({trashId:item.id,status:'deferred',errorCode:'supersession_reverification_required'});continue;}
      if(trashRetryAfter.has(item.id)){results.push({trashId:item.id,status:'skipped',errorCode:'recent_failure_backoff'});continue;}
      attempted+=1;
      purgeOneTrashItem(processing,storage,item,actor,onPurged,results);
    }catch(error){results.push({trashId:item.id,status:'failed',errorCode:error.code||'lifecycle_failed'});}
    const outcome=results[results.length-1];
    if(results.length>before&&outcome?.status==='failed')trashRetryAfter.set(item.id,current+Math.max(0,Number(failureBackoffMs)||0));
    else if(outcome?.status==='complete')trashRetryAfter.delete(item.id);
  }
  return results;
}

function purgeOneTrashItem(processing,storage,item,actor,onPurged,results){
  const fail=(errorCode)=>results.push({trashId:item.id,status:'failed',errorCode});
  if(item.entityType==='project'||item.entityType==='task'){
    const {purgeContainerTrash}=require('./containerLifecycle');
    const purged=purgeContainerTrash(processing,storage,item.id,actor);
    if(!purged)return fail('lifecycle_conflict');
    results.push({trashId:item.id,status:'complete',container:true});
    if(processing.getTrash(item.id)?.permanentlyDeletedAt)onPurged?.(item);
    return;
  }
  const dataset=item.entityType==='dataset'?processing.getDataset(item.entityId):null;
  const output=item.entityType==='output'?processing.getModelOutput(item.entityId):null;
  if(!dataset&&!output)return fail('entity_not_found');
  if(dataset?.storageMode==='external_reference'){
    const purged=processing.markTrashPurged(item.id);
    if(!purged)return fail('lifecycle_conflict');
    results.push({trashId:item.id,status:'complete',externalReference:true});
  }else if(output&&output.storageMode!=='managed'){
    const purged=processing.purgeMetadataOutput(item.id);
    if(!purged)return fail('lifecycle_conflict');
    results.push({trashId:item.id,status:'complete',externalReference:true});
  }else{
    const mutation=processing.beginPurgeMutation(item.id,actor);
    if(!mutation)return fail('lifecycle_conflict');
    const completed=applyStorageMutation(processing,storage,mutation);
    results.push({trashId:item.id,status:completed.status,mutationId:completed.id,externalReference:false});
  }
  if(processing.getTrash(item.id)?.permanentlyDeletedAt)onPurged?.(item);
}

// One summary line per pass plus one line per failed entry, using only ids
// and stable error codes.
function summarizeTrashPurge(results){
  const counts={};
  for(const result of results||[]){const key=result.errorCode?`${result.status}:${result.errorCode}`:String(result.status);counts[key]=(counts[key]||0)+1;}
  const parts=Object.keys(counts).sort().map((key)=>`${key}=${counts[key]}`);
  return{line:`Trash retention purge: ${parts.length?parts.join(' '):'nothing due'}`,failures:(results||[]).filter((result)=>result.status==='failed').map((result)=>`Trash retention purge failed: trash=${result.trashId} code=${result.errorCode||'lifecycle_failed'}`)};
}

module.exports={applyStorageMutation,reconcileStorageMutations,purgeExpiredTrash,summarizeTrashPurge};
