'use strict';

const permanentDeletion = require('./permanentDeletion');
const { sanitizeLogMessage } = require('./processingSecurity');

function exists(storage,rootKey,relativePath){return Boolean(rootKey&&relativePath&&storage.pathExistsStrict(rootKey,relativePath));}

function conflict(message){return Object.assign(new Error(message),{code:'lifecycle_conflict'});}

const finished=mutation=>!mutation||mutation.status==='complete'||mutation.status==='failed';
const injected=()=>Object.assign(new Error('injected failure after lifecycle filesystem effect'),{code:'fault_injected'});
function markApplied(processing,mutation,options){const applied=processing.markStorageMutationFsApplied(mutation.id,options);if(!applied)throw conflict('lifecycle journal changed while applying filesystem effect');return applied;}

// Runs one step of a journal under the database's write lock, on the journal as it is now. Only one journal of an entity
// can be open, and the API or the worker needs this lock to finish it or to open the next one, so while a step moves
// files nothing can move them back, and whoever comes late with an older copy of the journal finds it finished. A crash
// between the move and the commit leaves the journal open, and the next pass sees the files already moved.
function lockedStep(processing,id,step){
  const {mutation,error}=processing.transaction(()=>{
    const current=processing.getStorageMutation(id);if(finished(current))return{mutation:current};
    try{return{mutation:step(current)};}catch(failure){
      // Deterministic state/configuration conflicts require operator repair. Database,
      // process, and transient filesystem errors intentionally leave the durable
      // intent/applied state recoverable on the next reconciliation pass.
      if(!['lifecycle_conflict','lifecycle_cross_device'].includes(failure.code))throw failure;
      processing.failStorageMutation(id,failure.code,sanitizeLogMessage(failure.message));return{error:failure};
    }
  });
  if(error)throw error;
  return mutation;
}

function moveStep(processing,storage,mutation,{faultAt,supersessionProof}){
  if(mutation.status!=='intent')return mutation;
  const sourceExists=exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath),destinationExists=exists(storage,mutation.destinationRootKey,mutation.destinationRelativePath);
  if(sourceExists&&destinationExists)throw conflict('lifecycle source and destination both exist');
  if(sourceExists){require('./outputSupersession').requireSupersessionMutationProof(processing,mutation,supersessionProof);storage.moveExact(mutation.sourceRootKey,mutation.sourceRelativePath,mutation.destinationRootKey,mutation.destinationRelativePath);}
  else if(!destinationExists&&!mutation.allowAbsentSource)throw conflict('lifecycle source and destination are both absent');
  if(faultAt==='after_filesystem')throw injected();
  return markApplied(processing,mutation,{destinationRelativePath:!sourceExists&&!destinationExists?'':mutation.destinationRelativePath});
}

// Deleting can take long, so only the decision is made under the lock: the files are renamed out of the way, where no
// restore looks, and that is final. They are then removed without the lock, in as many passes as it takes.
const purging=mutation=>mutation.sourceRelativePath?`${mutation.sourceRelativePath}.purging`:'';
function setAsideStep(processing,storage,mutation,{supersessionProof}){
  permanentDeletion.refusePermanentDeletion();if(mutation.status!=='intent')return mutation;
  const sourceExists=exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath),setAside=exists(storage,mutation.sourceRootKey,purging(mutation));
  if(sourceExists&&setAside)throw conflict('purged lifecycle source still exists');
  if(!setAside&&!processing.purgeStillAdmissible(mutation))throw conflict('permanent deletion is no longer allowed');
  if(sourceExists){require('./outputSupersession').requireSupersessionMutationProof(processing,mutation,supersessionProof);storage.setAsideForPurge(mutation.sourceRootKey,mutation.sourceRelativePath,purging(mutation));}
  return mutation;
}
function removeSetAside(storage,mutation){
  const gone=()=>!exists(storage,mutation.sourceRootKey,purging(mutation));
  if(gone())return;
  // The other process may be removing the same files.
  try{storage.removeExact(mutation.sourceRootKey,purging(mutation));}catch(error){if(!gone())throw error;}
}

function completeStep(processing,storage,mutation){
  if(mutation.status!=='fs_applied')throw conflict('lifecycle journal changed while applying filesystem effect');
  if(mutation.type==='trash'||mutation.type==='restore'){
    const sourceExists=exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath),destinationExists=exists(storage,mutation.destinationRootKey,mutation.destinationRelativePath);
    if(sourceExists||(!destinationExists&&!mutation.allowAbsentSource))throw conflict('lifecycle filesystem state does not match the applied journal');
  }else if(exists(storage,mutation.sourceRootKey,mutation.sourceRelativePath)||exists(storage,mutation.sourceRootKey,purging(mutation)))throw conflict('purged lifecycle source still exists');
  return processing.completeStorageMutationInTransaction(mutation.id);
}

function applyStorageMutation(processing,storage,input,{faultAt=null,supersessionProof=null}={}){
  const id=typeof input==='string'?input:input?.id;
  let mutation=id?processing.getStorageMutation(id):null;
  if(finished(mutation))return mutation;
  if(mutation.type==='purge')permanentDeletion.refusePermanentDeletion();// the journal stays as it is
  if(faultAt==='after_intent')throw Object.assign(new Error('injected failure after lifecycle intent'),{code:'fault_injected'});
  const options={faultAt,supersessionProof};
  if(mutation.type==='purge'){
    mutation=lockedStep(processing,id,current=>setAsideStep(processing,storage,current,options));
    if(mutation?.status==='intent'){
      removeSetAside(storage,mutation);
      if(faultAt==='after_filesystem')throw injected();
      mutation=lockedStep(processing,id,current=>current.status==='intent'?markApplied(processing,current):current);
    }
  }else mutation=lockedStep(processing,id,current=>moveStep(processing,storage,current,options));
  if(finished(mutation))return mutation;
  if(faultAt==='after_fs')throw injected();
  return lockedStep(processing,id,current=>completeStep(processing,storage,current));
}

function reconcileStorageMutations(processing,storage,limit=20){const results=[],paused=permanentDeletion.permanentDeletionPaused();for(const mutation of processing.pendingStorageMutations(limit,{purges:!paused})){try{results.push(applyStorageMutation(processing,storage,mutation));}catch(error){results.push({id:mutation.id,status:'failed',errorCode:error.code||'lifecycle_failed'});}}return results;}

function purgeExpiredTrash(processing,storage,{actor='storage-maintenance',limit=20,onPurged=null}={}){
  // Before anything is moved or dated anew: every item stays exactly as it is.
  if(permanentDeletion.permanentDeletionPaused())return processing.expiredTrash().map(item=>({trashId:item.id,status:'skipped',errorCode:permanentDeletion.PAUSED_CODE}));
  const results=[];
  for(const item of processing.expiredTrash().slice(0,Math.max(1,Math.min(Number(limit)||20,100)))){
    try{
      if(item.entityType==='output'&&require('./outputSupersession').automaticSupersessionTrash(processing,item.id)){results.push({trashId:item.id,status:'deferred',errorCode:'supersession_reverification_required'});continue;}
      if(item.entityType==='project'||item.entityType==='task'){
        const owner=item.entityType==='task'&&!item.purgeStartedAt?processing.deletedTaskContainer(item):null;
        if(owner){
          if(!processing.moveContainerTrashMember(null,owner.id,item.id,null)){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
          results.push({trashId:item.id,status:'transferred',containerTrashId:owner.id});continue;
        }
        const {purgeContainerTrash}=require('./containerLifecycle');
        const purged=purgeContainerTrash(processing,storage,item.id,actor,{expired:true});
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',container:true});
        if(processing.getTrash(item.id)?.permanentlyDeletedAt)onPurged?.(item);
        continue;
      }
      const dataset=item.entityType==='dataset'?processing.getDataset(item.entityId):null;
      const output=item.entityType==='output'?processing.getModelOutput(item.entityId):null;
      if(!dataset&&!output){results.push({trashId:item.id,status:'failed',errorCode:'entity_not_found'});continue;}
      // An expired source set that a deleted, still-restorable task uses goes with that task's Recycle Bin item instead
      // of being purged now; one an active task uses is refused by the purge guard below.
      if(dataset&&processing.datasetReferences(dataset.id)===0){
        const heir=processing.datasetTrashHeir(dataset.id,null);
        if(heir){
          if(!processing.moveContainerTrashMember(null,heir.id,item.id,null)){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
          results.push({trashId:item.id,status:'transferred',containerTrashId:heir.id});continue;
        }
      }
      // So does anything that belongs to a deleted, restorable task or project but is not in its item.
      const container=processing.deletedTaskContainer(item);
      if(container){
        if(!processing.moveContainerTrashMember(null,container.id,item.id,null)){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'transferred',containerTrashId:container.id});continue;
      }
      if(dataset?.storageMode==='external_reference'){
        const purged=processing.markTrashPurged(item.id,null,{expired:true});
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',externalReference:true});
      }else if(output&&output.storageMode!=='managed'){
        const purged=processing.purgeMetadataOutput(item.id,null,{expired:true});
        if(!purged){results.push({trashId:item.id,status:'failed',errorCode:'lifecycle_conflict'});continue;}
        results.push({trashId:item.id,status:'complete',externalReference:true});
      }else{
        const mutation=processing.beginPurgeMutation(item.id,actor,{expired:true});
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
