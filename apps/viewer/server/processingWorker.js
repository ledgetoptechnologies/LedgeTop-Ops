'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {NodeOdmProvider}=require('./nodeOdmProvider');
const {captureProcessingArchive,verifyProcessingArchive}=require('./processingArchiveEvidence');
const {prepareProcessingUnitEvidence}=require('./processingUnitEvidence');
const {MeasurementSourceUnitEvidence}=require('./measurementSourceUnitEvidence');
const {inspectRegisteredSourceUnits}=require('./importSourceUnitEvidence');
const {hashFile,hashFileChunks,hashTree}=require('./storageManager');
const {sanitizeLogMessage}=require('./processingSecurity');
const {readOdmTaskMetadata}=require('./odmTaskMetadata');
const {lodDerivativeSpecs}=require('./lodDerivativePolicy');
const {buildMeshRecoveryManifest}=require('./retainedManifest');
const {canonicalDerivativeInput}=require('./derivativeInputSnapshot');
const {verifyRecoveredIngestSources}=require('./processingIngestRecovery');

function adapterFor(provider,config,providerCredentials){return new NodeOdmProvider({endpoint:provider.endpoint,token:providerCredentials.resolve(provider.id),providerType:provider.type,transferTimeoutMs:config.processingProviderTransferTimeoutMs});}
function transition(processing,job,status,fields){const attempt=processing.transitionAttemptForJob(job.id,job.lease_owner,status,fields);if(!attempt)throw Object.assign(new Error('processing lease was lost or attempt was cancelled'),{code:'lease_lost'});return attempt;}
function discoverOutputs(root){const candidates={glb:['odm_texturing/odm_textured_model_geo.glb','odm_texturing/textured_model.glb','textured_model.glb'],obj:['odm_texturing/odm_textured_model_geo.obj','odm_texturing/odm_textured_model.obj'],ortho:['odm_orthophoto/odm_orthophoto.tif'],orthoCutline:require('./orthophotoCutline').CUTLINE_PATHS,dsm:['odm_dem/dsm.tif'],dtm:['odm_dem/dtm.tif'],report:['odm_report/report.pdf','odm_report/odm_report.pdf'],pointCloud:['odm_georeferencing/odm_georeferenced_model.laz','odm_georeferencing/odm_georeferenced_model.ply'],ept:['entwine_pointcloud/ept.json'],nativeTiles:['3d_tiles/model/tileset.json']};const assets=[];for(const[kind,choices]of Object.entries(candidates)){const rel=choices.find((p)=>fs.existsSync(path.join(root,...p.split('/')))&&(kind!=='orthoCutline'||require('./orthophotoCutline').validateCutlineFile({relativePath:p,absolutePath:path.join(root,...p.split('/'))})));if(!rel)continue;const absolute=path.join(root,...rel.split('/'));assets.push({kind,relativePath:rel,absolutePath:absolute,format:kind==='nativeTiles'?'3dtiles':kind==='ept'?'ept':path.extname(rel).slice(1).toLowerCase(),contentType:kind==='report'?'application/pdf':undefined,byteSize:fs.statSync(absolute).size});}return assets;}

async function verifyProviderMeshClosure(root,outputs=discoverOutputs(root),{signal=null}={}){
  const obj=outputs.find((asset)=>asset.kind==='obj'),glb=outputs.find((asset)=>asset.kind==='glb');
  const missing=()=>Object.assign(new Error('provider archive is missing a complete textured OBJ, MTL, texture, and companion GLB closure'),{code:'missing_required_output'});
  if(!obj||!glb||path.dirname(obj.absolutePath)!==path.dirname(glb.absolutePath))throw missing();
  let manifest;
  try{manifest=await buildMeshRecoveryManifest(path.dirname(obj.absolutePath),{signal});}
  catch(error){if(['lease_lost','source_changed'].includes(error?.code))throw error;const failure=missing();failure.cause=error;throw failure;}
  const roles=new Set(manifest.files.map((file)=>file.role));
  if(!roles.has('mesh_obj')||!roles.has('mesh_mtl')||!roles.has('mesh_texture')||!roles.has('mesh_glb'))throw missing();
  return manifest;
}

async function processSubmit(job,{processing,storage,config,providerCredentials,signal,adapterFactory=adapterFor}){
  let attempt={...processing.getAttempt(job.attempt_id),...processing.getAttemptSubmission(job.attempt_id)};const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId||task.datasetId,true),provider=processing.getProvider(attempt.providerId),adapter=adapterFactory(provider,config,providerCredentials);
  const photo=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i,auxiliary=/\.(?:txt|geojson|json|zip|las|laz)$/i,mapped=[];for(const file of dataset.files){const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true}),stat=fs.statSync(absolute);if(stat.size!==file.byteSize||await hashFile(absolute,{signal})!==file.sha256)throw Object.assign(new Error('dataset source changed after finalization'),{code:'dataset_source_changed'});const role=file.processingRole||'auto',isPhoto=photo.test(file.relativePath),isAux=auxiliary.test(file.relativePath);if(role==='gcp_source'||role==='administrative'||(role==='auto'&&!isPhoto))continue;if(role==='image'&&!isPhoto)throw Object.assign(new Error('a dataset image role references an unsupported image type'),{code:'unsupported_source_file'});if(role==='provider_input'&&!isAux)throw Object.assign(new Error('a provider input role references an unsupported source type'),{code:'unsupported_source_file'});mapped.push({relativePath:file.relativePath,absolutePath:absolute,processingRole:role});}
  storage.requireProcessingHeadroom(dataset.byteSize,processing.activeProcessingReservationBytes(attempt.id),processing.activeDerivativeReservationBytes());
  const gcpSnapshot=processing.getAttemptGcpSnapshot?.(attempt.id)||null;
  if(gcpSnapshot&&crypto.createHash('sha256').update(gcpSnapshot.content).digest('hex')!==gcpSnapshot.sha256)
    throw Object.assign(new Error('attempt GCP snapshot failed its integrity check'),{code:'gcp_snapshot_changed'});
  if(gcpSnapshot)for(let i=mapped.length-1;i>=0;i--)if(path.basename(mapped[i].relativePath).toLowerCase()==='gcp_list.txt')mapped.splice(i,1);
  if(gcpSnapshot)mapped.push({relativePath:'gcp_list.txt',buffer:Buffer.from(gcpSnapshot.content,'utf8')});
  const basenames=new Set();for(const file of mapped){const name=path.basename(file.relativePath).toLowerCase();if(basenames.has(name))throw Object.assign(new Error('dataset contains duplicate submitted basenames'),{code:'duplicate_source_basename'});basenames.add(name);}const photoFiles=mapped.filter((file)=>photo.test(file.relativePath)),auxiliaryFiles=mapped.filter((file)=>!photo.test(file.relativePath)),files=[...photoFiles,...auxiliaryFiles];if(!photoFiles.length)throw Object.assign(new Error('dataset has no processable images'),{code:'unsupported_source_file'});const maxImages=Number(provider.capabilities?.maxImages);if(Number.isSafeInteger(maxImages)&&maxImages>0&&photoFiles.length>maxImages)throw Object.assign(new Error('dataset exceeds the provider image limit'),{code:'provider_image_limit_exceeded'});
  const sourceFileByPath=new Map(dataset.files.map(file=>[file.relativePath,file]));
  const actualInputFiles=files.map(file=>{const source=sourceFileByPath.get(file.relativePath);return{relativePath:file.relativePath,byteSize:file.buffer?file.buffer.length:source.byteSize,sha256:file.buffer?crypto.createHash('sha256').update(file.buffer).digest('hex'):source.sha256};});
  if(processing.validateAttemptInputInventory&&!processing.validateAttemptInputInventory(job.id,job.lease_owner,dataset.files,actualInputFiles))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  let known=null;try{known=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(error.code!=='provider_task_not_found')throw error;}
  const freshTaskMissing=!known&&attempt.submissionPhase==='new';
  const save=(phase,count=attempt.uploadedFileCount)=>{if(!processing.setSubmissionStateForJob(job.id,job.lease_owner,phase,count))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});attempt={...attempt,submissionPhase:phase,uploadedFileCount:count};};
  const restart=async()=>{if(known){await adapter.remove(attempt.providerTaskId,{signal});known=null;}save('new',0);};
  if(known&&attempt.submissionPhase==='new')await restart();
  if(known&&attempt.submissionPhase==='initializing'){if(processing.markAttemptInitializationAmbiguous&&!processing.markAttemptInitializationAmbiguous(job.id,job.lease_owner))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});save('initialized',0);}
  if(known&&attempt.submissionPhase==='uploading'){
    const providerCount=Number(known.imagesCount);
    if(!Number.isSafeInteger(providerCount)||providerCount<attempt.uploadedFileCount||providerCount>photoFiles.length)await restart();else save('uploading',providerCount);
  }
  if(known&&attempt.submissionPhase==='uploading_auxiliary')await restart();
  if(known&&attempt.submissionPhase==='committing'){if(['running','completed'].includes(known.status))save('committed',files.length);else await restart();}
  if(!known&&attempt.submissionPhase!=='new')save('new',0);
  if(!known){
    const initialization=processing.beginAttemptInitialization?.(job.id,job.lease_owner,{freshTaskMissing});
    if(processing.beginAttemptInitialization&&!initialization)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    transition(processing,job,'initializing');save('initializing',0);
    const initialized=await adapter.initialize({uuid:attempt.providerTaskId,name:task.displayName,options:attempt.options},{signal});
    if(initialization&&!initialization.historical){const recorded=initialized?.uuid===attempt.providerTaskId?processing.acknowledgeAttemptInitialization(job.id,job.lease_owner,initialization.generation,initialized.uuid):processing.markAttemptInitializationAmbiguous(job.id,job.lease_owner);if(!recorded)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
    save('initialized',0);
  }
  if(attempt.uploadedFileCount<photoFiles.length){transition(processing,job,'uploading');for(let index=attempt.uploadedFileCount;index<photoFiles.length;index+=20){save('uploading',index);const batch=photoFiles.slice(index,index+20);await adapter.upload(attempt.providerTaskId,batch,{signal});save('uploading',index+batch.length);}}
  if(auxiliaryFiles.length&&attempt.uploadedFileCount<files.length){transition(processing,job,'uploading');for(let index=Math.max(0,attempt.uploadedFileCount-photoFiles.length);index<auxiliaryFiles.length;index+=20){save('uploading_auxiliary',photoFiles.length+index);const batch=auxiliaryFiles.slice(index,index+20);await adapter.upload(attempt.providerTaskId,batch,{signal});save('uploading_auxiliary',photoFiles.length+index+batch.length);}}
  if(attempt.submissionPhase!=='committed'){save('uploaded',files.length);transition(processing,job,'committed');save('committing',files.length);await adapter.commit(attempt.providerTaskId,{signal});save('committed',files.length);}
  known=known&&['running','completed'].includes(known.status)?known:null;
  transition(processing,job,known?.status==='running'?'running':'queued_upstream',{progress:known?.progress||0});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+5000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function processReconcile(job,{processing,config,providerCredentials,signal,adapterFactory=adapterFor}){
  const attempt=processing.getAttempt(job.attempt_id),provider=processing.getProvider(attempt.providerId),adapter=adapterFactory(provider,config,providerCredentials);
  const status=await adapter.status(attempt.providerTaskId,{signal});
  let output=null;
  try{output=await adapter.output(attempt.providerTaskId,attempt.providerOutputCursor,{signal});}
  catch(error){
    // Output is observational: an oversized/unavailable log must not turn a
    // healthy upstream job into a failed attempt or block completed ingestion.
    // Cancellation/lease loss remains authoritative and is never downgraded.
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;
  }
  signal?.throwIfAborted();
  // Keep storage errors outside the best-effort provider read catch. Advance
  // the provider cursor only after successfully persisting the received batch.
  if(output){for(const line of output.lines)processing.appendLog(attempt.id,'provider',line);processing.setOutputCursor(attempt.id,output.nextLine);}
  else processing.appendLog(attempt.id,'warn','Processing output could not be refreshed. Provider status is still being tracked; the output cursor has not advanced.');
  if(status.status==='completed'){if(processing.recordAttemptProviderResult&&!processing.recordAttemptProviderResult(job.id,job.lease_owner,status))throw Object.assign(new Error('processing result identity or lease was lost'),{code:'lease_lost'});transition(processing,job,'ingesting',{progress:1,upstreamCompletedAt:new Date().toISOString()});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'ingest'))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else if(status.status==='failed'||status.status==='cancelled'){const task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),code=`provider_${status.status}`,message=`ODM processing ${status.status}`,terminal=processing.failJobTerminal(job.id,job.lease_owner,code,message,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:project.id,projectDisplayName:project.displayName,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'});if(!terminal)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
  else{transition(processing,job,status.status,{progress:status.progress});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+15000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
}

async function processIngest(job,{processing,repository,storage,config,providerCredentials,signal}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId);
  const headroom=storage.space('models'),maximumExpansion=Math.max(0,headroom.available-headroom.reserve);
  if(maximumExpansion<1024*1024*1024)throw Object.assign(new Error('insufficient storage for result ingestion'),{code:'insufficient_storage'});
  const recoveredIngest=await verifyRecoveredIngestSources(processing,storage,job,signal);
  const relative=`${task.id}/${attempt.id}`,destination=storage.resolve('models',relative);
  let archiveReceipt=processing.getAttemptTransferProvenance(attempt.id)?.archive||null;
  // A recovery job must never inherit the historical unreceipted-directory
  // fallback after a crash between filesystem promotion and receipt commit.
  // Recheck in the actual existing-directory branch after source hashing.
  if(!fs.existsSync(destination)){
    const adapter=adapterFor(provider,config,providerCredentials);
    const response=await adapter.downloadAll(attempt.providerTaskId,{signal}),declared=Number(response.headers.get('content-length')||0);
    if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    const captured=await captureProcessingArchive(Readable.fromWeb(response.body),destination,{maxEntries:100000,maxBytes:maximumExpansion,maxArchiveBytes:maximumExpansion,maxDiskBytes:maximumExpansion,signal});
    archiveReceipt=processing.recordAttemptArchiveReceipt(job.id,job.lease_owner,captured);
    if(!archiveReceipt)throw Object.assign(new Error('processing archive receipt or lease was lost'),{code:'lease_lost'});
  }else if(archiveReceipt){
    await verifyProcessingArchive(destination,archiveReceipt,{signal});
  }else if(recoveredIngest){
    throw Object.assign(new Error('recovered archive receipt is unavailable'),{code:'ingest_recovery_state_changed'});
  }
  // Ordinary historical jobs retain their existing unreceipted-directory
  // behavior; an audited recovery can never enter that compatibility path.
  const found=discoverOutputs(destination);if(!found.some((asset)=>['glb','obj','pointCloud','ortho','ept'].includes(asset.kind)))throw Object.assign(new Error('provider archive has no supported outputs'),{code:'missing_required_output'});
  if(!found.some((asset)=>asset.kind==='ept'))throw Object.assign(new Error('provider did not generate required EPT output'),{code:'missing_required_output'});
  const meshManifest=await verifyProviderMeshClosure(destination,found,{signal});
  const nativeTiles=found.find((asset)=>asset.kind==='nativeTiles'),candidateAssets=found.filter((asset)=>asset.kind!=='nativeTiles');
  const assets=[];for(const asset of candidateAssets){let integrity;if(asset.kind==='ept'){const tree=await hashTree(path.dirname(asset.absolutePath),{signal}),header=tree.files.find(file=>file.relativePath===path.basename(asset.absolutePath));if(!header)throw Object.assign(new Error('EPT header missing from verified tree'),{code:'invalid_asset_tree'});integrity={sha256:header.sha256,manifestSha256:tree.manifestSha256,manifestFiles:tree.files};}else integrity=await hashFileChunks(asset.absolutePath,{signal});assets.push({...asset,rootKey:'models',relativePath:`${relative}/${asset.relativePath}`,storageMode:'managed',published:false,sourceAttemptId:attempt.id,...integrity});}
  const derivatives=[];
  derivatives.push(...lodDerivativeSpecs([
    ...assets,
    ...(nativeTiles?[{...nativeTiles,rootKey:'models',relativePath:`${relative}/${nativeTiles.relativePath}`}]:[]),
  ],{
    meshDerivativesEnabled:config.meshDerivativesEnabled,
    required:true,
  }));
  const obj=found.find((asset)=>asset.kind==='obj'),meshDirectory=path.posix.dirname(obj.relativePath),meshFiles=meshManifest.files.map((file)=>({
    role:file.role,
    rootKey:'models',
    relativePath:path.posix.join(relative,meshDirectory,file.relativePath),
    byteSize:file.byteSize,
    sha256:file.sha256,
  })),trustedInputFilesByType={};
  for(const spec of derivatives){
    if(spec.type==='ept'){
      const point=assets.find((asset)=>asset.kind==='pointCloud'&&/\.la[sz]$/i.test(asset.relativePath));
    if(!point)throw Object.assign(new Error('provider archive has no LAS or LAZ source for the EPT derivative'),{code:'missing_required_output'});
      trustedInputFilesByType.ept=canonicalDerivativeInput('ept',[{role:'point_cloud_source',rootKey:point.rootKey,relativePath:point.relativePath,byteSize:point.byteSize,sha256:point.sha256}]).files;
    }else if(['mesh_tiles','lod_audit'].includes(spec.type))trustedInputFilesByType[spec.type]=canonicalDerivativeInput(spec.type,meshFiles).files;
  }
  const odmMetadata=readOdmTaskMetadata(destination);
  const provenance=processing.getAttemptProvenance?.(attempt.id)||null;
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,sourceLocator:{taskId:task.id,attemptId:attempt.id},metadata:{projectId:project.id,projectName:project.displayName},versionMetadata:{sourceDatasetId:attempt.datasetId||task.datasetId,processingMetrics:odmMetadata.processingMetrics,processingProvenance:provenance?{schemaVersion:1,attemptId:attempt.id,submissionSnapshotSha256:provenance.submission?.snapshotSha256||null,providerTaskId:attempt.providerTaskId,hasTaskInfoEvidence:Boolean(provenance.providerResult),producingEngineVerified:false}:null},georef:odmMetadata.georef,pointCount:odmMetadata.pointCount,status:'importing',assets,makeActive:false});
  const version=repository.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,attempt.id);
  if(!processing.setAttemptResultForJob(job.id,job.lease_owner,model.id,version.id))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  const tree=storage.scanAbsolute(destination);processing.registerModelOutput({versionId:version.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:relative,status:'staged',byteSize:tree.byteSize,assetCount:assets.length});
  const producer=archiveReceipt?processing.getVerifiedAttemptProducerReceipt(attempt.id):null;
  const explicitUnits=await inspectRegisteredSourceUnits({repository,storage,modelId:model.id,modelVersionId:version.id,signal});
  const unitCandidates=await prepareProcessingUnitEvidence({producer,destination,sourcePrefix:relative,modelId:model.id,modelVersionId:version.id,assets:repository.getModelVersion(model.id,version.id).activeVersion.assets,signal});
  if(explicitUnits.length||unitCandidates.length)processing.transaction(()=>{
    signal?.throwIfAborted();
    if(!processing.provenanceJob(job.id,job.lease_owner,'ingest'))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    const evidence=new MeasurementSourceUnitEvidence(repository.database);
    for(const candidate of explicitUnits)evidence.recordExplicitMetadata(candidate.request,candidate.inspection);
    for(const candidate of unitCandidates)evidence.recordVerifiedOdm(candidate.request,candidate.input);
  });
  const readyEvent={eventId:`processing-ready-${attempt.id}`,schemaVersion:1,type:'processing.ready_for_review',projectId:project.id,projectDisplayName:project.displayName,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'ready_for_review',reviewUrl:`${config.opsBaseUrl}/operations/processing?attemptId=${encodeURIComponent(attempt.id)}`};
  if(derivatives.length&&derivatives.some((spec)=>!spec.request?.optional)){const activated=processing.completeIngestAndEnqueueDerivatives(job.id,job.lease_owner,attempt.id,derivatives,{ingestedAt:new Date().toISOString(),trustedInputFilesByType,requireTrustedInputs:true});if(!activated)throw Object.assign(new Error('processing lease was lost or ingest state changed'),{code:'lease_lost'});}
  else{const ready=processing.completeOutputForReview(attempt.id,{jobId:job.id,owner:job.lease_owner,ingestedAt:new Date().toISOString(),event:readyEvent});if(!ready)throw Object.assign(new Error('processing lease was lost or staged output changed'),{code:'lease_lost'});if(derivatives.length&&!processing.enqueueOptionalDerivatives(attempt.id,derivatives))throw Object.assign(new Error('optional derivatives could not be queued'),{code:'derivative_activation_conflict'});}
}

async function processOne(deps,owner=crypto.randomUUID()){
  const job=deps.processing.claimJob(owner);if(!job)return false;
  const controller=new AbortController();const heartbeat=setInterval(()=>{const attempt=deps.processing.getAttempt(job.attempt_id);if(!deps.processing.heartbeatJob(job.id,owner)||attempt?.status==='cancelled')controller.abort();},20000);heartbeat.unref?.();
  try{const work={...deps,signal:controller.signal};if(job.job_type==='submit')await processSubmit(job,work);else if(job.job_type==='reconcile')await processReconcile(job,work);else if(job.job_type==='ingest')await processIngest(job,work);else throw new Error('unsupported processing job');return true;}
  catch(error){const safe=sanitizeLogMessage(error.message).slice(0,1000);if(error.code==='insufficient_storage'&&job.job_type==='submit'){deps.processing.deferSubmitAdmission(job.id,job.lease_owner);return true;}deps.processing.appendLog(job.attempt_id,'error',safe);const permanent=new Set(['ingest_recovery_source_changed','ingest_recovery_state_changed','source_changed','duplicate_source_basename','missing_required_output','invalid_storage_location','unsupported_source_file','dataset_source_changed','gcp_snapshot_changed','invalid_asset_tree','provider_image_limit_exceeded','derivative_source_too_large','invalid_derivative_input']).has(error.code),retry=!permanent&&job.attempt_count<5?new Date(Date.now()+Math.min(300000,5000*2**job.attempt_count)).toISOString():null;if(retry)deps.processing.failJob(job.id,job.lease_owner,error.code||'processing_failed',safe,retry);else{const attempt=deps.processing.getAttempt(job.attempt_id),task=attempt&&deps.processing.getTask(attempt.taskId),project=task&&deps.processing.getProject(task.projectId);deps.processing.failJobTerminal(job.id,job.lease_owner,error.code||'processing_failed',safe,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:task.projectId,projectDisplayName:project?.displayName||undefined,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'});}return true;}
  finally{clearInterval(heartbeat);}
}
module.exports={adapterFor,discoverOutputs,verifyProviderMeshClosure,processIngest,processOne,processReconcile,processSubmit};
