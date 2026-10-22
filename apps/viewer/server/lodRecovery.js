'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {buildMeshRecoveryManifest,MAX_FILES}=require('./retainedManifest');
const {copyRetainedClosure}=require('./webodmTaskImport');
const {fsyncDirectory,fsyncDirectoryTree}=require('./durableFs');
const {LOD_DERIVATIVE_RECOVERY_REVISION}=require('./lodRecoveryPolicy');
const {collectRecoveryCompanions,companionCopyManifests,ownedRecoveryCompanions,verifyRecoveryCompanionDestination,verifyRecoveryCompanionPlan}=require('./lodRecoveryCompanions');

function publicManifest(manifest){return{manifestSha256:manifest.manifestSha256,files:manifest.files.map(({relativePath,sourceRelativePath,role,byteSize,sha256})=>({relativePath,sourceRelativePath,role,byteSize,sha256}))};}
function sameManifest(left,right){return left?.manifestSha256===right?.manifestSha256&&JSON.stringify(left?.files||[])===JSON.stringify(right?.files||[]);}

async function inspectLodRecoverySource(outputId,{processing,storage,config},signal=null){
  const candidate=processing.lodRecoveryCandidate(outputId,{meshDerivativesEnabled:Boolean(config.meshDerivativesEnabled)});
  if(!candidate)throw Object.assign(new Error('the output does not have an eligible immutable OBJ and GLB source'),{code:'lod_recovery_not_eligible'});
  try{
  const root=storage.resolve(candidate.sourceRootKey,candidate.sourceRelativePath,{mustExist:true}),manifest=await buildMeshRecoveryManifest(root,{signal}),publicValue=publicManifest(manifest);
  const obj=publicValue.files.find(file=>file.role==='mesh_obj'),glb=publicValue.files.find(file=>file.role==='mesh_glb');
  if(!obj||!glb||obj.relativePath!==candidate.objRelativePath||glb.relativePath!==candidate.glbRelativePath||obj.sha256!==candidate.obj.sha256||glb.sha256!==candidate.glb.sha256||obj.byteSize!==Number(candidate.obj.byte_size)||glb.byteSize!==Number(candidate.glb.byte_size))throw Object.assign(new Error('the retained mesh closure no longer matches the registered source hashes'),{code:'lod_recovery_source_changed'});
  return{candidate,manifest,publicManifest:publicValue};
  }catch(error){
    if(['ENOENT','ENOTDIR','EACCES','ELOOP'].includes(error.code))throw Object.assign(new Error('the registered recovery source is unavailable; restore its Viewer storage before retrying'),{code:'lod_recovery_source_unavailable',cause:error});
    throw error;
  }
}

async function processLodRecovery(operation,{processing,repository,storage,config},progress=async()=>{},signal=null){
  const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{};
  if(!payload.lodRecovery||payload.recoveryRevision!==LOD_DERIVATIVE_RECOVERY_REVISION)throw Object.assign(new Error('LOD recovery operation revision is unsupported'),{code:'lod_recovery_revision_mismatch'});
  const inspected=await inspectLodRecoverySource(payload.sourceOutputId,{processing,storage,config},signal),persisted={manifestSha256:payload.sourceManifestSha256,files:payload.sourceFiles};
  if(inspected.candidate.versionId!==payload.sourceVersionId||inspected.candidate.modelId!==payload.sourceModelId||inspected.candidate.task.id!==ids.taskId||inspected.candidate.dataset.id!==ids.datasetId||inspected.candidate.sourceRootKey!==payload.sourceRootKey||inspected.candidate.sourceRelativePath!==payload.sourceRelativePath||!sameManifest(inspected.publicManifest,persisted))throw Object.assign(new Error('the immutable LOD recovery source changed after authorization'),{code:'lod_recovery_source_changed'});
  if(![payload.sourceAttemptId,ids.attemptId].includes(inspected.candidate.task.activeAttemptId))throw Object.assign(new Error('the recovery task has a newer active attempt'),{code:'lod_recovery_source_superseded'});
  // Old queued operations can bind the same immutable source registry at
  // execution. Newly queued operations additionally bind it at authorization.
  const companionVersionId=payload.companionRepair?payload.companionSourceOutputId:payload.sourceVersionId;
  const repair=payload.companionRepair?processing.companionRepairCandidate(payload.sourceOutputId,{replacementAttemptId:ids.attemptId}):null;
  if(payload.companionRepair&&repair?.sourceVersionId!==companionVersionId)throw Object.assign(new Error('companion repair lineage is no longer eligible'),{code:'lod_recovery_source_changed'});
  const companions=verifyRecoveryCompanionPlan(processing.database,companionVersionId,payload.companions||collectRecoveryCompanions(processing.database,companionVersionId));
  if(!payload.companions&&!processing.bindLodRecoveryCompanions(operation.id,operation.lease_owner,companions))throw Object.assign(new Error('recovery lease was lost before companion reservation'),{code:'operation_lease_lost'});
  const reusedTiles=payload.companionRepair?verifyRecoveryCompanionPlan(processing.database,payload.sourceVersionId,payload.reusedTiles,{meshTilesOnly:true}):null;
  const copyPlans=[companions,...(reusedTiles?[reusedTiles]:[])];
  if(inspected.publicManifest.files.length+copyPlans.reduce((sum,plan)=>sum+plan.files.length,0)>MAX_FILES)throw Object.assign(new Error('recovery materialization exceeds the file-count bound'),{code:'lod_recovery_companion_changed'});
  const meshBytes=inspected.publicManifest.files.reduce((sum,file)=>sum+file.byteSize,0),totalBytes=meshBytes+companions.byteSize+(reusedTiles?.byteSize||0);
  const storageRequired=totalBytes+processing.activeDerivativeReservationBytes(null,operation.id);
  if(!Number.isSafeInteger(storageRequired))throw Object.assign(new Error('recovery storage estimate overflowed'),{code:'insufficient_storage'});
  const meshPaths=new Set(inspected.publicManifest.files.map(file=>file.relativePath));
  if(copyPlans.some(plan=>plan.files.some(file=>meshPaths.has(file.relativePath))))throw Object.assign(new Error('recovery companion destination conflicts with the mesh closure'),{code:'lod_recovery_companion_changed'});
  await progress(0.35);
  const destination=storage.resolve('models',payload.targetRelativePath),incomplete=storage.resolve('models',`${payload.targetRelativePath}.recovery-${operation.id}.incomplete`);
  if(fs.existsSync(destination)){
    const existing=publicManifest(await buildMeshRecoveryManifest(destination,{signal}));
    if(!sameManifest(existing,persisted))throw Object.assign(new Error('the recovery destination conflicts with its authorized source manifest'),{code:'lod_recovery_destination_conflict'});
    for(const plan of copyPlans)await verifyRecoveryCompanionDestination(plan,destination,{signal});
  }else{
    // Companion copies may be much larger than the mesh-input closure. They
    // consume real storage, but never inflate the 16-GiB derivative admission.
    storage.requireSpace?.('models',storageRequired);
    if(fs.existsSync(incomplete))fs.rmSync(incomplete,{recursive:true,force:true});
    try{
      await copyRetainedClosure(inspected.manifest.sourceRootPath,incomplete,inspected.manifest,{signal,syncDirectoryTree:false,progress:value=>progress(0.35+value*0.35)});
      for(const plan of copyPlans)for(const manifest of companionCopyManifests(plan,storage))await copyRetainedClosure(manifest.sourceRootPath,incomplete,manifest,{signal,syncDirectoryTree:false});
      verifyRecoveryCompanionPlan(processing.database,companionVersionId,companions);
      if(reusedTiles)verifyRecoveryCompanionPlan(processing.database,payload.sourceVersionId,reusedTiles,{meshTilesOnly:true});
      fsyncDirectoryTree(incomplete,{code:'retained_materialization_failed'});
      fs.mkdirSync(path.dirname(destination),{recursive:true});
      if(fs.statSync(incomplete).dev!==fs.statSync(path.dirname(destination)).dev)throw Object.assign(new Error('LOD recovery materialization crossed filesystems'),{code:'invalid_storage_location'});
      fs.renameSync(incomplete,destination);fsyncDirectory(path.dirname(destination),{code:'lod_recovery_materialization_failed'});
    }catch(error){if(fs.existsSync(incomplete))fs.rmSync(incomplete,{recursive:true,force:true});throw error;}
  }
  await progress(0.75);
  const sourceModel=repository.getModelVersion(ids.modelId,payload.sourceVersionId),source=sourceModel?.activeVersion;
  if(!source||source.id!==payload.sourceVersionId||sourceModel.id!==payload.sourceModelId)throw Object.assign(new Error('the source model version is unavailable'),{code:'lod_recovery_source_changed'});
  const task=processing.getTask(ids.taskId),project=task&&processing.getProject(task.projectId),dataset=processing.getDataset(ids.datasetId,true);
  if(!task||!project||!dataset||dataset.status!=='finalized')throw Object.assign(new Error('the recovery task source is unavailable'),{code:'lod_recovery_source_changed'});
  const attempt=processing.createImportedAttempt({id:ids.attemptId,taskId:task.id,datasetId:dataset.id,providerTaskId:`lod-recovery:${operation.id}`,createdBy:operation.subject,displayName:task.displayName,metadata:{lodRecoveryOperationId:operation.id,lodRecoverySourceVersionId:payload.sourceVersionId},staged:true,expectedActiveAttemptId:payload.sourceAttemptId});
  const manifestByRole=new Map(inspected.publicManifest.files.map(file=>[file.role,file])),glb=manifestByRole.get('mesh_glb'),obj=manifestByRole.get('mesh_obj'),assets=[{kind:'glb',rootKey:'models',relativePath:`${payload.targetRelativePath}/${glb.relativePath}`,format:'glb',contentType:'model/gltf-binary',byteSize:glb.byteSize,sha256:glb.sha256,storageMode:'managed',published:false,sourceAttemptId:attempt.id},{kind:'obj',rootKey:'models',relativePath:`${payload.targetRelativePath}/${obj.relativePath}`,format:'obj',contentType:'text/plain',byteSize:obj.byteSize,sha256:obj.sha256,storageMode:'managed',published:false,sourceAttemptId:attempt.id}];
  const owned=ownedRecoveryCompanions(companions,payload.targetRelativePath,attempt.id);assets.push(...owned.assets);
  const versionMetadata={...(source.metadata||{}),lodRecovery:{schemaVersion:1,recoveryRevision:payload.recoveryRevision,operationId:operation.id,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,sourceManifestSha256:payload.sourceManifestSha256,companionManifestSha256:companions.manifestSha256,companionBytes:companions.byteSize}};
  const model=repository.upsertModelVersion({modelId:ids.modelId,versionId:ids.versionId,provider:sourceModel.provider,providerModelId:sourceModel.providerModelId,providerVersionId:`lod-recovery:${operation.id}`,displayName:task.displayName,status:'importing',metadata:sourceModel.metadata||{},versionMetadata,georef:source.georef||{},pointCount:source.pointCount??null,sourceLocator:{lodRecovery:true,operationId:operation.id,sourceVersionId:payload.sourceVersionId},assets,cameraPhotos:owned.cameraPhotos,makeActive:false});
  processing.setAttemptResult(attempt.id,model.id,ids.versionId);
  processing.registerModelOutput({versionId:ids.versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,rootKey:'models',relativePath:payload.targetRelativePath,storageMode:'managed',status:'staged',byteSize:totalBytes,assetCount:assets.length});
  processing.recordProcessingEvent({attemptId:attempt.id,operationId:operation.id,eventType:'lod_recovery.materialized',phase:'registering',details:{recoveryRevision:payload.recoveryRevision,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,targetVersionId:ids.versionId,manifestSha256:payload.sourceManifestSha256}});
  await progress(0.98);
  const requiredDerivatives=reusedTiles?[{type:'lod_audit',request:{optional:false,reuseVerifiedProvenance:true,tilesRootKey:'models',tilesRelativePath:`${payload.targetRelativePath}/recovery-companions/tiles`}}]:[{type:'mesh_tiles',request:{optional:false}}];
  return{project,task:processing.getTask(task.id),attempt:processing.getAttempt(attempt.id),model:repository.getModelVersion(model.id,ids.versionId),recovery:{operationId:operation.id,recoveryRevision:payload.recoveryRevision,sourceOutputId:payload.sourceOutputId,sourceVersionId:payload.sourceVersionId,targetVersionId:ids.versionId,manifestSha256:payload.sourceManifestSha256},requiredDerivatives};
}

function cleanupLodRecoveryMaterialization(operation,{processing,storage}){const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{};if(!payload.lodRecovery||processing.getModelOutput(ids.versionId))return false;for(const relative of[`${payload.targetRelativePath}.recovery-${operation.id}.incomplete`,payload.targetRelativePath]){const absolute=storage.resolve('models',relative);if(fs.existsSync(absolute))fs.rmSync(absolute,{recursive:true,force:true});}return true;}

module.exports={cleanupLodRecoveryMaterialization,inspectLodRecoverySource,processLodRecovery,publicManifest,sameManifest};
