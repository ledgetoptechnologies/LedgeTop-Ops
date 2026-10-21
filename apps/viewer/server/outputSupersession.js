'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {buildStorageSupersessionManifest,inventoryTree,verifyRetainedClosure,storageSupersessionInventoryIdentity}=require('./retainedManifest');
const {applyStorageMutation}=require('./storageLifecycle');
const {POLICY_REVISION,recoveryPreservation,recoveryRegistrationIdentity}=require('./outputPreservation');
const sha=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse=value=>{try{return JSON.parse(value||'{}');}catch{return{};}};
const within=(value,base)=>value===base||value.startsWith(`${base}/`);
const overlap=(left,right)=>within(left,right)||within(right,left);
const mutationProofs=new WeakMap();
function authorizeMutation(mutation){const proof={};mutationProofs.set(proof,mutation.id);return proof;}
function automaticSupersessionTrash(processing,trashId){return processing.database.prepare("SELECT * FROM storage_mutations WHERE trash_id=? AND mutation_type='trash' AND actor='viewer-output-maintenance' LIMIT 1").get(trashId);}
function requireSupersessionMutationProof(processing,mutation,proof){
  const guarded=mutation.entityType==='output'&&((mutation.type==='trash'&&mutation.actor==='viewer-output-maintenance')||(mutation.type==='purge'&&automaticSupersessionTrash(processing,mutation.trashId)));
  if(!guarded)return;
  if(!proof||mutationProofs.get(proof)!==mutation.id)throw Object.assign(new Error('superseded output requires fresh replacement verification'),{code:'supersession_reverification_required'});
  mutationProofs.delete(proof);
}

function contentSuperset(source,target) {
  if(!source.files.length)return false;
  const first=source.files[0],available=new Map(target.files.map(file=>[file.relativePath,file]));
  const candidates=target.files.filter(file=>file.byteSize===first.byteSize&&file.sha256===first.sha256
    &&(file.relativePath===first.relativePath||file.relativePath.endsWith(`/${first.relativePath}`)));
  // One prefix maps the entire original tree. Per-file basename matching can
  // preserve bytes but break OBJ/MTL, EPT and tile relative references.
  return candidates.some(file=>{
    const prefix=file.relativePath.slice(0,file.relativePath.length-first.relativePath.length);
    return source.files.every(original=>{const copy=available.get(`${prefix}${original.relativePath}`);return copy?.byteSize===original.byteSize&&copy?.sha256===original.sha256;});
  });
}

async function preservation(processing,operation,state,sourceProof,targetProof,sourceRoot,signal){
  if(contentSuperset(sourceProof,targetProof))return{preserved:true,method:'whole_tree_prefix',details:{}};
  return recoveryPreservation(processing.database,parse(operation.payload_json),state.source,state.target,sourceProof,targetProof,sourceRoot,{signal});
}

// Full-tree proofs are disk-intensive. Do not compete with active imports,
// conversions or cleanup. Recheck between bounded hash reads, not just startup.
function maintenanceSignal(processing,external){
  let lastCheck=-Infinity,busy=false;
  return{get aborted(){
    if(external?.aborted)return true;
    const now=Date.now();if(now-lastCheck>=250){lastCheck=now;busy=Object.values(processing.workerWorkCounts()).some(value=>Number(value)>0);}
    return busy;
  }};
}

function cleanupMessage(reason,details){
  if(reason==='retired')return 'Redundant output moved to recoverable trash for 7 days.';
  if(details.proofFailureReason==='unmapped_source_files')return `Old output retained: ${details.unmappedFileCount} files (${details.unmappedByteSize} bytes) have no verified replacement mapping.`;
  const labels={content_not_fully_preserved:'not every original file and its dependencies have a verified replacement',output_accounting_mismatch:'on-disk bytes differ from registered output accounting',registered_integrity_mismatch:'registered file hashes or sizes no longer match',source_in_use:'a session or active task still depends on the output',source_published:'the source still has published products',derivative_or_retry_dependency:'a derivative or retry still depends on these files',shared_asset_dependency:'another model still references these files',verification_deferred:'verification is deferred; no files were removed',explicit_restore_preserved:'the owner explicitly restored this output'};
  return `Old output retained: ${labels[reason]||reason.replaceAll('_',' ')}${details.proofFailureReason?` (${details.proofFailureReason.replaceAll('_',' ')})`:''}.`;
}

function sharedAssetDependency(processing,source,storage=null){
  const db=processing.database;let sourceAbsolute=storage?storage.resolve('models',source.relativePath):null;
  if(sourceAbsolute){try{sourceAbsolute=fs.realpathSync(sourceAbsolute);}catch{/* Retired source is now under trash; retain its original logical location. */}}
  const physicalWithin=(value,base)=>{const relative=path.relative(base,value);return relative===''||(!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative));};
  const touches=(row,relativePath)=>{
    const alias=parse(row.source_locator_json).legacyAssetRoots?.[row.root_key];
    if(typeof alias==='string'&&alias){
      if(!sourceAbsolute)return true; // unknown physical mapping never grants deletion
      let canonical;try{canonical=fs.realpathSync(alias);}catch{return true;}
      return physicalWithin(path.resolve(canonical,...relativePath.split('/')),sourceAbsolute);
    }
    if(row.root_key==='models')return within(path.posix.normalize(relativePath),source.relativePath);
    if(storage?.roots?.[row.root_key]&&sourceAbsolute)return physicalWithin(storage.resolve(row.root_key,relativePath),sourceAbsolute);
    return false;
  };
  const assets=db.prepare('SELECT a.*,v.source_locator_json FROM model_assets a JOIN model_versions v ON v.id=a.version_id WHERE a.version_id<>?').all(source.id);
  for(const asset of assets){
    if(touches(asset,asset.relative_path))return true;
    for(const file of db.prepare('SELECT relative_path FROM model_asset_files WHERE asset_id=?').all(asset.id)){
      if(touches(asset,path.posix.join(path.posix.dirname(asset.relative_path),file.relative_path)))return true;
    }
  }
  return db.prepare('SELECT p.*,v.source_locator_json FROM model_camera_photos p JOIN model_versions v ON v.id=p.version_id WHERE p.version_id<>?').all(source.id).some(photo=>touches(photo,photo.relative_path));
}

function registeredProofMatches(database,output,proof) {
  const actual=new Map(proof.files.map(file=>[`${output.relativePath}/${file.relativePath}`,file]));
  const matches=(root,relative,bytes,hash)=>root!=='models'||!within(relative,output.relativePath)
    ||(actual.get(relative)?.byteSize===bytes&&/^[a-f0-9]{64}$/.test(hash||'')&&actual.get(relative)?.sha256===hash);
  for(const asset of database.prepare('SELECT * FROM model_assets WHERE version_id=?').all(output.id)) {
    if(!matches(asset.root_key,asset.relative_path,asset.byte_size,asset.sha256))return false;
    for(const file of database.prepare('SELECT * FROM model_asset_files WHERE asset_id=?').all(asset.id)) {
      if(!matches(asset.root_key,path.posix.join(path.posix.dirname(asset.relative_path),file.relative_path),file.byte_size,file.sha256))return false;
    }
  }
  for(const photo of database.prepare('SELECT * FROM model_camera_photos WHERE version_id=?').all(output.id)) {
    if(!matches(photo.root_key,photo.relative_path,photo.byte_size,photo.sha256))return false;
  }
  return true;
}

function candidateState(processing,operation,sourceId,{storage=null,allowTrashed=false}={}) {
  const db=processing.database,payload=parse(operation?.payload_json),targetId=payload.ids?.versionId;
  const source=typeof sourceId==='string'?processing.getModelOutput(sourceId):null,target=typeof targetId==='string'?processing.getModelOutput(targetId):null;
  const result={source,target,operationId:operation?.id,eligible:false,reason:'lineage_unproven'};
  if(operation?.status!=='succeeded'||payload.lodRecovery!==true||!source||!target||source.id===target.id
    ||![payload.sourceOutputId,payload.companionSourceOutputId].includes(source.id)
    ||source.taskId!==target.taskId||source.modelId!==target.modelId||source.projectId!==target.projectId
    ||payload.ids?.attemptId!==target.attemptId||operation.processing_attempt_id!==target.attemptId)return result;
  result.fingerprint=sha({revision:POLICY_REVISION,operation:operation.id,payload,source:[source.id,source.updatedAt,source.byteSize,source.assetCount],target:[target.id,target.updatedAt,target.byteSize,target.assetCount]});
  if(source.storageMode!=='managed'||target.storageMode!=='managed'||source.rootKey!=='models'||target.rootKey!=='models')return{...result,reason:'storage_not_exclusively_managed'};
  if(!(allowTrashed?['trashed']:['ready','archived']).includes(source.status)||!['ready','published'].includes(target.status))return{...result,reason:'output_not_retirable'};
  if(db.prepare("SELECT 1 FROM storage_mutations WHERE entity_type='output' AND entity_id=? AND mutation_type='restore' AND status='complete' LIMIT 1").get(source.id))return{...result,reason:'explicit_restore_preserved'};
  if(!source.relativePath||!target.relativePath||overlap(source.relativePath,target.relativePath))return{...result,reason:'overlapping_output_roots'};
  const model=db.prepare('SELECT active_version_id FROM models WHERE id=?').get(target.modelId),task=processing.getTask(target.taskId);
  if(model?.active_version_id!==target.id||task?.activeAttemptId!==target.attemptId)return{...result,reason:'replacement_not_active'};
  if(processing.outputInUse(source))return{...result,reason:'source_in_use'};
  if(db.prepare('SELECT 1 FROM model_assets WHERE version_id=? AND published=1 LIMIT 1').get(source.id))return{...result,reason:'source_published'};
  if(db.prepare("SELECT 1 FROM derivative_jobs WHERE attempt_id IN (?,?) AND status IN ('pending','leased','failed') LIMIT 1").get(source.attemptId,target.attemptId))return{...result,reason:'derivative_or_retry_dependency'};
  const verified=db.prepare("SELECT result_json FROM derivative_jobs WHERE attempt_id=? AND derivative_type IN ('mesh_tiles','lod_audit') AND status='complete' AND COALESCE(json_extract(request_json,'$.optional'),0)<>1").all(target.attemptId);
  if(!verified.some(row=>parse(row.result_json).verified===true))return{...result,reason:'replacement_not_verified'};
  if(sharedAssetDependency(processing,source,storage))return{...result,reason:'shared_asset_dependency'};
  for(const table of ['model_outputs','datasets']) {
    const refs=db.prepare(`SELECT id,relative_path FROM ${table} WHERE root_key='models'`).all();
    if(refs.some(row=>(table!=='model_outputs'||row.id!==source.id)&&overlap(row.relative_path,source.relativePath)))return{...result,reason:'shared_storage_dependency'};
  }
  const inputs=db.prepare("SELECT f.relative_path FROM derivative_input_files f JOIN derivative_jobs j ON j.id=f.job_id WHERE f.root_key='models' AND j.status IN ('pending','leased','failed')").all();
  if(inputs.some(row=>within(row.relative_path,source.relativePath)))return{...result,reason:'derivative_input_dependency'};
  return{...result,eligible:true,reason:'awaiting_content_proof'};
}

function record(processing,state,reason,details={}) {
  processing.insertAudit({actorType:'system',actorId:'viewer-output-maintenance',action:'output.supersession_evaluated',entityType:'model_output',entityId:state.source.id,details:{replacementOutputId:state.target.id,operationId:state.operationId,fingerprint:state.fingerprint,reason,...details}});
  // Each actual evaluation is a new event; daily deferred retries legitimately
  // have different times/evidence. The scan's fingerprint/cooldown gates bound
  // frequency, rather than reusing an event ID with conflicting payloads.
  processing.recordProcessingEvent({attemptId:state.target.attemptId,operationId:state.operationId,eventType:'output.supersession_evaluated',phase:'storage_cleanup',severity:reason==='retired'?'info':'warning',message:cleanupMessage(reason,details),details:{sourceOutputId:state.source.id,replacementOutputId:state.target.id,reason,policyRevision:POLICY_REVISION,...details}});
}

// Bounded maintenance, not a processing retry and never an Operations write.
// A blocked immutable pair is recorded once; another successful replacement
// creates a new key. Transient session/provider dependencies are retried later.
async function retireSupersededOutputs(processing,storage,{limit=1,signal=null}={}) {
  signal=maintenanceSignal(processing,signal);
  if(signal?.aborted)return [];
  const cursor=parse(processing.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_scan_cursor' ORDER BY created_at DESC,rowid DESC LIMIT 1").get()?.details_json);
  const query="SELECT * FROM dataset_operations WHERE status='succeeded' AND json_extract(payload_json,'$.lodRecovery')=1";
  const comparison=cursor.resumeSourceId?'<=':'<';
  let rows=cursor.completedAt&&cursor.id?processing.database.prepare(`${query} AND (COALESCE(completed_at,created_at)<? OR (COALESCE(completed_at,created_at)=? AND id${comparison}?)) ORDER BY COALESCE(completed_at,created_at) DESC,id DESC LIMIT 100`).all(cursor.completedAt,cursor.completedAt,cursor.id):[];
  if(!rows.length)rows=processing.database.prepare(`${query} ORDER BY COALESCE(completed_at,created_at) DESC,id DESC LIMIT 100`).all();
  const results=[];let inspected=0;
  let scanned=null,resumeSourceId=null;
  const finish=()=>{if(scanned)processing.insertAudit({actorType:'system',actorId:'viewer-output-maintenance',action:'output.supersession_scan_cursor',entityType:'system',details:{id:scanned.id,completedAt:scanned.completed_at||scanned.created_at,resumeSourceId}});return results;};
  for(const operation of rows) {
    scanned=operation;
    const payload=parse(operation.payload_json);
    let sourceIds=[...new Set([payload.sourceOutputId,payload.companionSourceOutputId].filter(Boolean))];
    if(operation.id===cursor.id&&cursor.resumeSourceId&&sourceIds.includes(cursor.resumeSourceId))sourceIds=sourceIds.slice(sourceIds.indexOf(cursor.resumeSourceId));
    for(const sourceId of sourceIds) {
      if(signal?.aborted)return results;
      let state=candidateState(processing,operation,sourceId,{storage});
      const previous=processing.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_evaluated' AND entity_id=? ORDER BY created_at DESC LIMIT 20").all(sourceId);
      if(!state.eligible){
        if(state.fingerprint&&['ready','archived'].includes(state.source?.status)
          &&!previous.some(row=>{const detail=parse(row.details_json);return detail.fingerprint===state.fingerprint&&detail.reason===state.reason;})){
          record(processing,state,state.reason);results.push({sourceOutputId:sourceId,status:'blocked',reason:state.reason});
        }
        continue;
      }
      if(previous.some(row=>{const detail=parse(row.details_json);return detail.fingerprint===state.fingerprint&&['content_not_fully_preserved','output_accounting_mismatch','registered_integrity_mismatch','retired'].includes(detail.reason);}))continue;
      if(previous.some(row=>{const detail=parse(row.details_json);return detail.fingerprint===state.fingerprint&&detail.reason==='verification_deferred'&&Date.parse(detail.retryAfter)>Date.now();}))continue;
      if(inspected++>=Math.max(1,Math.min(Number(limit)||1,5))){resumeSourceId=sourceId;return finish();}
      try {
        const sourceRoot=storage.resolve('models',state.source.relativePath,{mustExist:true}),targetRoot=storage.resolve('models',state.target.relativePath,{mustExist:true});
        const sourceProof=await buildStorageSupersessionManifest(sourceRoot,{signal}),targetProof=await buildStorageSupersessionManifest(targetRoot,{signal});
        if(sourceProof.files.reduce((sum,file)=>sum+file.byteSize,0)!==state.source.byteSize
          ||targetProof.files.reduce((sum,file)=>sum+file.byteSize,0)!==state.target.byteSize){
          record(processing,state,'output_accounting_mismatch');results.push({sourceOutputId:sourceId,status:'blocked',reason:'output_accounting_mismatch'});continue;
        }
        if(!registeredProofMatches(processing.database,state.source,sourceProof)||!registeredProofMatches(processing.database,state.target,targetProof)){
          record(processing,state,'registered_integrity_mismatch');results.push({sourceOutputId:sourceId,status:'blocked',reason:'registered_integrity_mismatch'});continue;
        }
        const contentProof=await preservation(processing,operation,state,sourceProof,targetProof,sourceRoot,signal);
        if(!contentProof.preserved) {
          record(processing,state,'content_not_fully_preserved',{sourceManifestSha256:sourceProof.manifestSha256,targetManifestSha256:targetProof.manifestSha256,...contentProof.details});
          results.push({sourceOutputId:sourceId,status:'blocked',reason:'content_not_fully_preserved'});continue;
        }
        // Reopen every path securely against its hash, then re-inventory to
        // reject additions/removals during verification before durable intent.
        await verifyRetainedClosure(sourceRoot,sourceProof.files,{signal});
        await verifyRetainedClosure(targetRoot,targetProof.files,{signal});
        if(signal?.aborted)return results;
        const sameInventory=(root,proof)=>storageSupersessionInventoryIdentity(inventoryTree(root))===proof.inventoryIdentitySha256;
        if(!sameInventory(sourceRoot,sourceProof)||!sameInventory(targetRoot,targetProof))throw Object.assign(new Error('output changed during cleanup verification'),{code:'source_changed'});
        const mutation=processing.beginOutputTrashMutation(sourceId,'viewer-output-maintenance',state.source.status,{archiveInactiveReady:true,validate:()=>{
          const current=processing.database.prepare('SELECT * FROM dataset_operations WHERE id=?').get(operation.id),fresh=candidateState(processing,current,sourceId,{storage});
          if(!fresh.eligible||fresh.fingerprint!==state.fingerprint)return false;
          if(!registeredProofMatches(processing.database,state.source,sourceProof)||!registeredProofMatches(processing.database,state.target,targetProof)
            ||(contentProof.registrationSha256&&contentProof.registrationSha256!==recoveryRegistrationIdentity(processing.database,state.source.id,state.target.id)))return false;
          processing.insertAudit({actorType:'system',actorId:'viewer-output-maintenance',action:'output.supersession_proved',entityType:'model_output',entityId:sourceId,details:{replacementOutputId:state.target.id,operationId:state.operationId,fingerprint:state.fingerprint,sourceManifestSha256:sourceProof.manifestSha256,targetManifestSha256:targetProof.manifestSha256,sourceFileCount:sourceProof.files.length,targetFileCount:targetProof.files.length,preservationMethod:contentProof.method,preservationSha256:contentProof.preservationSha256||null,policyRevision:POLICY_REVISION}});
          return true;
        }});
        if(!mutation){results.push({sourceOutputId:sourceId,status:'deferred',reason:'dependency_changed'});continue;}
        const completed=applyStorageMutation(processing,storage,mutation,{supersessionProof:authorizeMutation(mutation)});
        if(completed?.status!=='complete')throw Object.assign(new Error('retirement journal incomplete'),{code:'lifecycle_conflict'});
        record(processing,state,'retired',{sourceManifestSha256:sourceProof.manifestSha256,targetManifestSha256:targetProof.manifestSha256,byteSize:state.source.byteSize,trashId:completed.trashId});
        results.push({sourceOutputId:sourceId,status:'retired',trashId:completed.trashId});
      }catch(error){if(signal?.aborted)return results;record(processing,state,'verification_deferred',{errorCode:error.code||'verification_failed',retryAfter:new Date(Date.now()+86400_000).toISOString()});results.push({sourceOutputId:sourceId,status:'deferred',reason:error.code||'verification_failed'});}
    }
  }
  return finish();
}

async function purgeSupersededOutputs(processing,storage,{limit=1,signal=null}={}){
  signal=maintenanceSignal(processing,signal);
  const results=[];
  if(signal?.aborted)return results;
  for(const item of processing.expiredTrash()){
    if(signal?.aborted)return results;
    const initial=automaticSupersessionTrash(processing,item.id);
    if(!initial)continue;
    if(results.length>=Math.max(1,Math.min(Number(limit)||1,5)))break;
    try{
      const row=processing.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_proved' AND entity_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1").get(item.entityId),proof=parse(row?.details_json);
      const operation=processing.database.prepare('SELECT * FROM dataset_operations WHERE id=?').get(proof.operationId||'');
      const state=candidateState(processing,operation,item.entityId,{storage,allowTrashed:true});
      if(!state.eligible||state.target.id!==proof.replacementOutputId)throw Object.assign(new Error('replacement is no longer available for final cleanup'),{code:state.reason||'replacement_unavailable'});
      const oldRoot=storage.resolve('trash',item.relativePath,{mustExist:true}),targetRoot=storage.resolve('models',state.target.relativePath,{mustExist:true});
      const sourceManifest=await buildStorageSupersessionManifest(oldRoot,{signal}),targetManifest=await buildStorageSupersessionManifest(targetRoot,{signal});
      const contentProof=await preservation(processing,operation,state,sourceManifest,targetManifest,oldRoot,signal);
      if(sourceManifest.manifestSha256!==proof.sourceManifestSha256||targetManifest.manifestSha256!==proof.targetManifestSha256||!contentProof.preserved
        ||(proof.preservationMethod&&proof.preservationMethod!==contentProof.method)
        ||(proof.preservationSha256&&proof.preservationSha256!==contentProof.preservationSha256)
        ||!registeredProofMatches(processing.database,state.source,sourceManifest)||!registeredProofMatches(processing.database,state.target,targetManifest))throw Object.assign(new Error('replacement preservation proof changed'),{code:'supersession_content_changed'});
      await verifyRetainedClosure(oldRoot,sourceManifest.files,{signal});await verifyRetainedClosure(targetRoot,targetManifest.files,{signal});
      if(signal?.aborted)return results;
      if(storageSupersessionInventoryIdentity(inventoryTree(oldRoot))!==sourceManifest.inventoryIdentitySha256||storageSupersessionInventoryIdentity(inventoryTree(targetRoot))!==targetManifest.inventoryIdentitySha256)throw Object.assign(new Error('output changed during final cleanup verification'),{code:'source_changed'});
      const fresh=candidateState(processing,processing.database.prepare('SELECT * FROM dataset_operations WHERE id=?').get(operation.id),item.entityId,{storage,allowTrashed:true});
      if(!fresh.eligible||fresh.fingerprint!==state.fingerprint)throw Object.assign(new Error('cleanup dependency changed'),{code:'dependency_changed'});
      if(!registeredProofMatches(processing.database,state.source,sourceManifest)||!registeredProofMatches(processing.database,state.target,targetManifest)
        ||(contentProof.registrationSha256&&contentProof.registrationSha256!==recoveryRegistrationIdentity(processing.database,state.source.id,state.target.id)))throw Object.assign(new Error('cleanup registry changed during verification'),{code:'dependency_changed'});
      const mutation=processing.beginPurgeMutation(item.id,'viewer-output-maintenance');
      if(!mutation)throw Object.assign(new Error('purge journal unavailable'),{code:'lifecycle_conflict'});
      const complete=applyStorageMutation(processing,storage,mutation,{supersessionProof:authorizeMutation(mutation)});
      results.push({trashId:item.id,status:complete?.status||'deferred'});
    }catch(error){
      if(signal?.aborted)return results;
      // Retry at most daily after a failed final proof. No bytes are removed.
      processing.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=? AND permanently_deleted_at IS NULL').run(new Date(Date.now()+86400_000).toISOString(),item.id);
      processing.insertAudit({actorType:'system',actorId:'viewer-output-maintenance',action:'output.supersession_purge_deferred',entityType:'model_output',entityId:item.entityId,details:{trashId:item.id,reason:error.code||'verification_failed'}});
      results.push({trashId:item.id,status:'deferred',reason:error.code||'verification_failed'});
    }
  }
  return results;
}

module.exports={candidateState,contentSuperset,registeredProofMatches,sharedAssetDependency,retireSupersededOutputs,purgeSupersededOutputs,automaticSupersessionTrash,requireSupersessionMutationProof};
