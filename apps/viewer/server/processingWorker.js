'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {NodeOdmProvider}=require('./nodeOdmProvider');
const {captureProcessingArchive,verifyProcessingArchive,providerArchiveExpectation}=require('./processingArchiveEvidence');
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
const observationPersistenceError=Symbol('observationPersistenceError');
const transientDownloadError=error=>error?.name==='TimeoutError'||['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENOTFOUND','EAI_AGAIN','ENETUNREACH','EHOSTUNREACH','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_BODY_TIMEOUT'].includes(error?.code||error?.cause?.code)||error?.status===408||error?.status===429||(Number.isInteger(error?.status)&&error.status>=500&&error.status<=599);

function requireNodeOdmProvider(provider){if(!provider||!['nodeodm','clusterodm'].includes(provider.type))throw Object.assign(new Error('processing provider type is unavailable'),{code:'unsupported_provider_type'});}
function requireNodeOdmAttempt(processing,id){if(processing.hasReferenceAttemptProtocol(id)||processing.hasReferenceAttemptJournal(id))throw Object.assign(new Error('reference processing is unavailable'),{code:'unsupported_provider_type'});}
function adapterFor(provider,config,providerCredentials,attemptCapability=null){requireNodeOdmProvider(provider);return new NodeOdmProvider({endpoint:provider.endpoint,token:providerCredentials.resolve(provider.id),providerType:provider.type,transferTimeoutMs:config.processingProviderTransferTimeoutMs,attemptCapability});}
function attemptCapability(processing,credentials,attempt){
  if(!processing.attemptRequiresReservation?.(attempt.id))return null;
  const record=processing.getAttemptReservation(attempt.id);
  if(!record||record.providerId!==attempt.providerId||record.providerTaskId!==attempt.providerTaskId)throw Object.assign(new Error('Attempt reservation is unavailable'),{code:'attempt_reservation_unavailable'});
  return credentials.openAttemptCapability(attempt.providerId,attempt.id,attempt.providerTaskId,record);
}
async function requireReservationSupport(adapter, capability){
  if(!capability)return;
  const probe=await adapter.capabilities();
  if(probe.capabilities?.reservations?.version!==1)throw Object.assign(new Error('Coordinator reservation support unavailable'),{code:'provider_observation_unavailable'});
}
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
  requireNodeOdmAttempt(processing,job.attempt_id);
  if(processing.validateInitializationSnapshotForJob){const validation=processing.validateInitializationSnapshotForJob(job.id,job.lease_owner);if(!validation)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});if(validation==='unproven'){const attempt=processing.getAttempt(job.attempt_id),reason=attempt?.errorCode==='provider_upload_acceptance_unknown'||['uploading','uploading_auxiliary'].includes(attempt?.submissionPhase)?'upload_ambiguous':'initialization_unverified';if(!processing.deferHeldSubmit(job.id,job.lease_owner,30_000,reason))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});return;}}
  let attempt={...processing.getAttempt(job.attempt_id),...processing.getAttemptSubmission(job.attempt_id)};const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId||task.datasetId,true),provider=processing.getProvider(attempt.providerId);let adapter=adapterFactory(provider,config,providerCredentials);
  const deferObservation=reason=>{signal?.throwIfAborted();if(!processing.deferHeldSubmit(job.id,job.lease_owner,30_000,reason))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});};
  // A rejected upload may have committed a subset of the batch. Image counts
  // cannot establish which bytes were accepted, even after a worker restart.
  if(attempt.errorCode==='provider_upload_acceptance_unknown'||['uploading','uploading_auxiliary'].includes(attempt.submissionPhase)){
    deferObservation('upload_ambiguous');return;
  }
  if(processing.attemptRequiresReservation?.(attempt.id)){
    try{
      const record=processing.ensureAttemptReservation(job.id,job.lease_owner,providerCredentials.sealAttemptCapability.bind(providerCredentials));
      if(!record)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
      const capability=attemptCapability(processing,providerCredentials,attempt);
      adapter=adapterFactory(provider,config,providerCredentials,capability);
      const probe=await adapter.capabilities();
      if(probe.capabilities?.reservations?.version!==1)throw new Error('reservation extension unavailable');
      const reserved=await require('./processingReservationProtocol').action(adapter,'reserve',attempt.providerTaskId,capability,{signal});
      if(reserved.state!=='reserved'){deferObservation('unavailable');return;}
    }catch(error){if(signal?.aborted||error?.code==='lease_lost')throw error;deferObservation('unavailable');return;}
  }
  let known=null;try{known=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;if(error.code!=='provider_task_not_found'||attempt.submissionPhase!=='new'){deferObservation('unavailable');return;}}
  if(known?.held===true){deferObservation(known.heldReason==='option_evidence_invalid'?'option_evidence_invalid':'held');return;}
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
  if(require('./providerInputLimit').exceedsProviderInputLimit(actualInputFiles,provider.capabilities?.ledgetopMaxInputBytes))
    throw Object.assign(new Error('Processing inputs exceed the provider’s advertised total input limit'),{code:'provider_input_limit_exceeded'});
  const {uploadBatchEnd}=require('./providerInputLimit'),uploadLimit=provider.capabilities?.ledgetopMaxUploadRequestBytes;
  // Validate every file before initialization, then reuse these same boundaries
  // for resumed uploads. Images and auxiliary files use separate batches.
  const photoInventory=actualInputFiles.slice(0,photoFiles.length),auxiliaryInventory=actualInputFiles.slice(photoFiles.length);
  for(const inventory of [photoInventory,auxiliaryInventory])for(let i=0;i<inventory.length;)i=uploadBatchEnd(inventory,i,uploadLimit);
  const freshTaskMissing=!known&&attempt.submissionPhase==='new';
  const save=(phase,count=attempt.uploadedFileCount)=>{if(!processing.setSubmissionStateForJob(job.id,job.lease_owner,phase,count))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});attempt={...attempt,submissionPhase:phase,uploadedFileCount:count};};
  const restart=async()=>{if(known){let latest;try{latest=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;deferObservation('unavailable');throw Object.assign(new Error('submission observation deferred'),{code:'submission_observation_deferred'});}deferObservation(latest?.held===true?(latest.heldReason==='option_evidence_invalid'?'option_evidence_invalid':'held'):'unavailable');throw Object.assign(new Error('submission observation deferred'),{code:'submission_observation_deferred'});}save('new',0);};
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
    const initialization=processing.beginAttemptInitialization?.(job.id,job.lease_owner,{freshTaskMissing,captureRequest:true});
    if(processing.beginAttemptInitialization&&!initialization)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    // Never reconstruct a request for a historical or ambiguous attempt from
    // mutable task metadata. Replay remains disabled until a coordinator
    // contract and binding are independently qualified.
    if(!initialization?.requestSnapshot){deferObservation('unavailable');return;}
    transition(processing,job,'initializing');save('initializing',0);
    const initialized=await adapter.initialize(initialization.requestSnapshot.request,{signal});
    if(initialization&&!initialization.historical){const recorded=initialized?.uuid===attempt.providerTaskId?processing.acknowledgeAttemptInitialization(job.id,job.lease_owner,initialization.generation,initialized.uuid):processing.markAttemptInitializationAmbiguous(job.id,job.lease_owner);if(!recorded)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});}
    save('initialized',0);
  }
  if(attempt.uploadedFileCount<photoFiles.length){transition(processing,job,'uploading');for(let index=attempt.uploadedFileCount;index<photoFiles.length;){const end=uploadBatchEnd(photoInventory,index,uploadLimit);save('uploading',index);await adapter.upload(attempt.providerTaskId,photoFiles.slice(index,end),{signal});save('uploading',end);index=end;}}
  if(auxiliaryFiles.length&&attempt.uploadedFileCount<files.length){transition(processing,job,'uploading');for(let index=Math.max(0,attempt.uploadedFileCount-photoFiles.length);index<auxiliaryFiles.length;){const end=uploadBatchEnd(auxiliaryInventory,index,uploadLimit);save('uploading_auxiliary',photoFiles.length+index);await adapter.upload(attempt.providerTaskId,auxiliaryFiles.slice(index,end),{signal});save('uploading_auxiliary',photoFiles.length+end);index=end;}}
  if(attempt.submissionPhase!=='committed'){save('uploaded',files.length);transition(processing,job,'committed');save('committing',files.length);await adapter.commit(attempt.providerTaskId,{signal});save('committed',files.length);}
  known=known&&['running','completed'].includes(known.status)?known:null;
  transition(processing,job,known?.status==='running'?'running':'queued_upstream',{progress:known?.progress||0});if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+5000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function processReconcile(job,{processing,config,providerCredentials,signal,adapterFactory=adapterFor}){
  requireNodeOdmAttempt(processing,job.attempt_id);
  let attempt,provider;
  try{
    if(processing.settleStaleReconcileJob(job.id,job.lease_owner))return;
    attempt=processing.getAttempt(job.attempt_id);
    if(!attempt)throw Object.assign(new Error('Processing attempt is unavailable; reconciliation will continue'),{code:'provider_attempt_unavailable'});
    if(['cancelled','published','failed','derivatives','ready_for_review'].includes(attempt.status))throw Object.assign(new Error('processing lease was lost or attempt changed'),{code:'lease_lost'});
    provider=processing.getProvider(attempt.providerId);
    if(!provider)throw Object.assign(new Error('Provider is unavailable; reconciliation will continue'),{code:'provider_adapter_unavailable'});
  }catch(error){
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost','provider_adapter_unavailable','provider_attempt_unavailable'].includes(error?.code))throw error;
    throw Object.assign(new Error('Provider observation could not be saved; reconciliation will continue'),{code:'provider_observation_persistence_unavailable'});
  }
  let adapter;
  try{const capability=attemptCapability(processing,providerCredentials,attempt);adapter=adapterFactory(provider,config,providerCredentials,capability);await requireReservationSupport(adapter,capability)}catch(error){
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;
    throw Object.assign(new Error('Provider adapter or credentials are unavailable; reconciliation will continue'),{code:'provider_adapter_unavailable'});
  }
  let status;
  try { status=await adapter.status(attempt.providerTaskId,{signal}); }
  catch(error) {
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;
    const code=error?.code==='provider_task_not_found'?'provider_status_not_found':[401,403].includes(error?.status)?'provider_status_auth_failed':'provider_observation_unavailable';
    throw Object.assign(new Error('Provider status is unavailable; reconciliation will continue'),{code});
  }
  signal?.throwIfAborted();
  if(!status||!['queued_upstream','running','completed','failed','cancelled'].includes(status.status))
    throw Object.assign(new Error('Provider status is not recognized; reconciliation will continue'),{code:'provider_status_unknown'});
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
  try{
    if(!processing.persistReconcileObservation(job.id,job.lease_owner,attempt.id,output))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  }catch(error){
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error?.code))throw error;
    if(error&&typeof error==='object'&&Object.isExtensible(error)){Object.defineProperty(error,observationPersistenceError,{value:true});throw error;}
    throw Object.assign(new Error('Provider observation could not be saved; reconciliation will continue'),{code:'provider_observation_persistence_unavailable'});
  }
  try {
    if(status.status==='failed'||status.status==='cancelled'){
      const task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),code=`provider_${status.status}`,message=`ODM processing ${status.status}`,terminal=processing.failJobTerminal(job.id,job.lease_owner,code,message,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:project.id,projectDisplayName:project.displayName,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'},{reconcile:true});
      if(!terminal)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    }else if(!processing.advanceReconcileJob(job.id,job.lease_owner,status,status.status==='completed'?new Date().toISOString():new Date(Date.now()+15000).toISOString()))throw Object.assign(new Error('processing result identity or lease was lost'),{code:'lease_lost'});
  } catch(error) {
    if(signal?.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost','provider_result_identity_mismatch','provider_observation_unavailable'].includes(error?.code))throw error;
    throw Object.assign(new Error('Provider observation could not be saved; reconciliation will continue'),{code:'provider_observation_persistence_unavailable'});
  }
}

async function processIngest(job,{processing,repository,storage,config,providerCredentials,signal}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId);
  requireNodeOdmAttempt(processing,job.attempt_id);
  if(provider)requireNodeOdmProvider(provider);
  // Capture one validated provider binding before any asynchronous work so the
  // checked coordinator and the later durable claim always have the same identity.
  const bindings=config.stagedCommitmentProviders;
  const hasBinding=Boolean(bindings&&provider&&Object.hasOwn(bindings,provider.id));
  let binding=null;
  if(hasBinding){try{binding=require('./stagedAckDelivery').snapshotBinding(bindings[provider.id]);}catch{throw Object.assign(new Error('Staged commitment configuration is invalid'),{code:'staged_commitment_unavailable'});}}
  let frozenCapability=null,receiptBinding=null;
  if(binding){try{frozenCapability=attemptCapability(processing,providerCredentials,attempt);receiptBinding=require('./stagedAckDelivery').expectedBinding(binding,frozenCapability);}catch{throw Object.assign(new Error('Staged commitment credentials are unavailable'),{code:'staged_commitment_unavailable'});}}
  const headroom=storage.space('models'),maximumExpansion=Math.max(0,headroom.available-headroom.reserve);
  if(maximumExpansion<1024*1024*1024)throw Object.assign(new Error('insufficient storage for result ingestion'),{code:'insufficient_storage'});
  const recoveredIngest=await verifyRecoveredIngestSources(processing,storage,job,signal);
  const relative=`${task.id}/${attempt.id}`,destination=storage.resolve('models',relative);
  let archiveReceipt=processing.getAttemptTransferProvenance(attempt.id)?.archive||null;
  // No configuration is wired in production: only an explicit per-provider
  // binding enables this experimental, read-only point-in-time check.
  if(!binding&&archiveReceipt&&processing.getStagedCommitment(attempt.id))throw Object.assign(new Error('Staged receipt binding is unavailable'),{code:'staged_commitment_conflict'});
  let stagedCommitment=null,initialCommitment=null;
  const readCommitment=async(kind='commitment')=>{
    if(!binding||!processing.attemptRequiresReservation?.(attempt.id)||typeof providerCredentials.resolveStagedCommitmentCredential!=='function')throw Object.assign(new Error('Staged commitment is unavailable'),{code:'staged_commitment_unavailable'});
    let capability,bearer;
    try{capability=frozenCapability;bearer=await providerCredentials.resolveStagedCommitmentCredential(binding.credentialRef);}
    catch(error){if(signal?.aborted||error?.name==='AbortError')throw error;throw Object.assign(new Error('Staged commitment credentials are unavailable'),{code:'staged_commitment_unavailable'});}
    return require('./stagedCommitmentClient')[kind==='preflight'?'getStagedPreflight':'getStagedCommitment']({enabled:true,origin:binding.origin,principalId:binding.principalId,authorityId:binding.authorityId,environment:binding.environment,bearer,capability,taskId:attempt.providerTaskId,signal});
  };

  // A recovery job must never inherit the historical unreceipted-directory
  // fallback after a crash between filesystem promotion and receipt commit.
  // Recheck in the actual existing-directory branch after source hashing.
  if(!fs.existsSync(destination)){
    if(!processing.beginArchiveCapture(job.id,job.lease_owner))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    if(binding)await readCommitment('preflight');
    let adapter;
    try{const capability=binding?frozenCapability:attemptCapability(processing,providerCredentials,attempt);adapter=adapterFor(provider,config,providerCredentials,capability);await requireReservationSupport(adapter,capability);}
    catch(error){if(binding)throw Object.assign(new Error('Staged commitment credentials or provider are unavailable'),{code:'staged_commitment_unavailable'});if(processing.attemptRequiresReservation?.(attempt.id))throw Object.assign(new Error('Provider observation unavailable; ingestion will resume'),{code:'provider_observation_unavailable'});throw error;}
    let response;
    try{response=await adapter.downloadAll(attempt.providerTaskId,{signal});}
    catch(error){if(!signal?.aborted&&(processing.attemptRequiresReservation?.(attempt.id)||transientDownloadError(error)))throw Object.assign(new Error('Provider download unavailable; ingestion will resume'),{code:'provider_observation_unavailable'});throw error;}
    let providerExpectation;
    try{providerExpectation=providerArchiveExpectation(response);}catch(error){try{await response.body?.cancel();}catch{}throw error;}
    if(binding&&!providerExpectation){try{await response.body?.cancel();}catch{}throw Object.assign(new Error('Provider archive identity is unavailable'),{code:'staged_commitment_conflict'});}
    const declared=Number(response.headers.get('content-length')||0);
    if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    const streamErrors=new WeakSet(),reader=response.body.getReader();
    const readable=Readable.from((async function*(){
      try{for(;;){let part;try{part=await reader.read();}catch(error){if(error&&typeof error==='object')streamErrors.add(error);throw error;}if(part.done)return;yield part.value;}}
      finally{try{await reader.cancel();}catch{}reader.releaseLock();}
    })());
    const destroy=readable._destroy;
    readable._destroy=function(error,callback){try{Promise.resolve(reader.cancel()).catch(()=>{});}catch{}destroy.call(this,error,callback);};
    let captured;
    try{captured=await captureProcessingArchive(readable,destination,{maxEntries:100000,maxBytes:maximumExpansion,maxArchiveBytes:maximumExpansion,maxDiskBytes:maximumExpansion,providerExpectation,signal,beforePromotion:binding?async captured=>{
      initialCommitment=await readCommitment();
      if(captured.archiveSha256!==initialCommitment.archiveSha256||captured.archiveByteSize!==initialCommitment.archiveBytes)throw Object.assign(new Error('Staged commitment does not match archive'),{code:'staged_commitment_conflict'});
    }:undefined});}
    catch(error){if(streamErrors.has(error)&&!signal?.aborted)throw Object.assign(new Error('Provider download interrupted; ingestion will resume'),{code:'provider_observation_unavailable'});throw error;}
    if(binding&&(!providerExpectation||captured.archiveSha256!==initialCommitment.archiveSha256||captured.archiveByteSize!==initialCommitment.archiveBytes))throw Object.assign(new Error('Staged commitment does not match archive'),{code:'staged_commitment_conflict'});
    archiveReceipt=processing.recordAttemptArchiveReceipt(job.id,job.lease_owner,{...captured,stagedCommitment:binding?initialCommitment:null,stagedReceiptBinding:binding?receiptBinding:null});
    if(!archiveReceipt)throw Object.assign(new Error('processing archive receipt or lease was lost'),{code:'lease_lost'});
    if(binding){
      const fresh=await readCommitment();
      if(JSON.stringify(fresh)!==JSON.stringify(initialCommitment))throw Object.assign(new Error('Staged commitment changed'),{code:'staged_commitment_conflict'});
      stagedCommitment=fresh;
    }

  }else if(archiveReceipt){
    await verifyProcessingArchive(destination,archiveReceipt,{signal});
    if(binding){
      const savedBinding=processing.getStagedReceiptBinding(attempt.id);
      if(!savedBinding||JSON.stringify(savedBinding)!==JSON.stringify(receiptBinding))throw Object.assign(new Error('Staged receipt binding changed'),{code:'staged_commitment_conflict'});
      const stored=processing.getStagedCommitment(attempt.id);
      if(!stored||stored.taskId!==attempt.providerTaskId||stored.archiveSha256!==archiveReceipt.archiveSha256||stored.archiveBytes!==archiveReceipt.archiveByteSize)throw Object.assign(new Error('Existing archive has no verified commitment binding'),{code:'staged_commitment_unavailable'});
      const fresh=await readCommitment();
      if(JSON.stringify(fresh)!==JSON.stringify(stored))throw Object.assign(new Error('Staged commitment changed'),{code:'staged_commitment_conflict'});
      stagedCommitment=fresh;
    }

  }else if(binding||recoveredIngest||processing.hasArchiveCaptureIntent(attempt.id)){
    throw Object.assign(new Error('recovered archive receipt is unavailable'),{code:'ingest_recovery_state_changed'});
  }
  // Only pre-existing unmarked historical directories retain the legacy path.
  // A newly started capture or audited recovery must have a receipt.
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
  let stagedDeliveryBinding=null;
  if(stagedCommitment){stagedDeliveryBinding=processing.getStagedReceiptBinding(attempt.id);if(!stagedDeliveryBinding||JSON.stringify(stagedDeliveryBinding)!==JSON.stringify(receiptBinding))throw Object.assign(new Error('Staged receipt binding changed'),{code:'staged_commitment_conflict'});}
  if(derivatives.length&&derivatives.some((spec)=>!spec.request?.optional)){const activated=processing.completeIngestAndEnqueueDerivatives(job.id,job.lease_owner,attempt.id,derivatives,{ingestedAt:new Date().toISOString(),trustedInputFilesByType,requireTrustedInputs:true,stagedCommitment,stagedDeliveryBinding});if(!activated)throw Object.assign(new Error('processing lease was lost or ingest state changed'),{code:'lease_lost'});}
  else{const ready=processing.completeOutputForReview(attempt.id,{jobId:job.id,owner:job.lease_owner,ingestedAt:new Date().toISOString(),event:readyEvent,stagedCommitment,stagedDeliveryBinding});if(!ready)throw Object.assign(new Error('processing lease was lost or staged output changed'),{code:'lease_lost'});if(derivatives.length&&!processing.enqueueOptionalDerivatives(attempt.id,derivatives))throw Object.assign(new Error('optional derivatives could not be queued'),{code:'derivative_activation_conflict'});}
}

async function processOne(deps,owner=crypto.randomUUID()){
  const job=deps.processing.claimJob(owner);if(!job)return false;
  const controller=new AbortController();let reconcileHeartbeatFailed=false;
  const heartbeat=setInterval(()=>{
    if(reconcileHeartbeatFailed)return;
    try{const attempt=deps.processing.getAttempt(job.attempt_id);if(!(job.job_type==='reconcile'?deps.processing.heartbeatReconcileJob(job.id,owner):deps.processing.heartbeatJob(job.id,owner))||attempt?.status==='cancelled')controller.abort();}
    catch(error){
      if(job.job_type!=='reconcile')throw error;
      // Reconciliation is read-only upstream. Stop renewing and leave its lease
      // for expiry; a failed heartbeat cannot safely settle the job in SQLite.
      reconcileHeartbeatFailed=true;controller.abort();
    }
  },20000);heartbeat.unref?.();
  try{const work={...deps,signal:controller.signal};if(job.job_type==='submit')await processSubmit(job,work);else if(job.job_type==='reconcile')await processReconcile(job,work);else if(job.job_type==='ingest')await processIngest(job,work);else throw new Error('unsupported processing job');return true;}
  catch(error){if(reconcileHeartbeatFailed||error?.code==='submission_observation_deferred')return true;if(job.job_type==='submit'&&error?.code==='initialization_snapshot_invalid'){deps.processing.deferHeldSubmit(job.id,job.lease_owner,30000,'initialization_unverified');return true;}if(job.job_type==='submit'&&error?.status===413&&['uploading','uploading_auxiliary'].includes(deps.processing.getAttemptSubmission(job.attempt_id)?.submissionPhase)){deps.processing.deferHeldSubmit(job.id,job.lease_owner,30000,'upload_ambiguous');return true;}if(job.job_type==='submit'&&deps.processing.attemptRequiresReservation?.(job.attempt_id)){const submission=deps.processing.getAttemptSubmission(job.attempt_id);const localBeforeInit=submission?.submissionPhase==='new'&&new Set(['insufficient_storage','source_changed','duplicate_source_basename','invalid_storage_location','unsupported_source_file','dataset_source_changed','gcp_snapshot_changed','provider_image_limit_exceeded','provider_input_limit_exceeded','provider_upload_file_too_large']).has(error.code);if(!localBeforeInit){deps.processing.deferHeldSubmit(job.id,job.lease_owner,30000,'unavailable');return true;}}const runtimeDependency=job.job_type==='ingest'&&error?.code==='ERR_MODULE_NOT_FOUND';if(runtimeDependency)error=Object.assign(new Error('Viewer runtime is missing a required processing dependency; inspect the deployment before retrying.'),{code:'viewer_runtime_dependency_unavailable'});const persistence=Boolean(error?.[observationPersistenceError]||error?.code==='provider_observation_persistence_unavailable'),safe=persistence?'Provider observation could not be saved; reconciliation will continue':sanitizeLogMessage(error.message).slice(0,1000);if(job.job_type==='reconcile'&&(controller.signal.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error.code))){deps.processing.failReconcileJob(job.id,job.lease_owner,'processing_interrupted','Processing interrupted; reconciliation will resume',new Date(Date.now()+5000).toISOString());return true;}if(error.code==='insufficient_storage'&&job.job_type==='submit'){deps.processing.deferSubmitAdmission(job.id,job.lease_owner);return true;}if(job.job_type!=='reconcile')deps.processing.appendLog(job.attempt_id,'error',safe);const permanent=new Set(['ingest_recovery_source_changed','ingest_recovery_state_changed','source_changed','duplicate_source_basename','missing_required_output','invalid_storage_location','unsupported_source_file','dataset_source_changed','gcp_snapshot_changed','invalid_asset_tree','provider_image_limit_exceeded','provider_input_limit_exceeded','provider_upload_file_too_large','derivative_source_too_large','invalid_derivative_input','staged_commitment_invalid','staged_commitment_conflict','viewer_runtime_dependency_unavailable','invalid_archive','provider_archive_evidence_invalid','provider_archive_evidence_mismatch','processing_archive_changed']).has(error.code),observation=(job.job_type==='ingest'&&(error.code==='provider_observation_unavailable'||error.code==='staged_commitment_unavailable'&&deps.processing.attemptRequiresReservation?.(job.attempt_id)))||(job.job_type==='reconcile'&&(persistence||['provider_observation_unavailable','provider_status_unknown','provider_status_not_found','provider_status_auth_failed','provider_adapter_unavailable','provider_result_identity_mismatch','provider_attempt_unavailable'].includes(error.code))),retry=!permanent&&(observation||job.attempt_count<5)?new Date(Date.now()+Math.min(300000,5000*2**Math.min(job.attempt_count,6))).toISOString():null;if(retry){if(job.job_type==='reconcile')deps.processing.failReconcileJob(job.id,job.lease_owner,persistence?'provider_observation_persistence_unavailable':error.code||'processing_failed',safe,retry,{logMessage:safe});else if(job.job_type==='ingest'&&error.code==='staged_commitment_unavailable')deps.processing.failStagedCommitmentJob(job.id,job.lease_owner,retry);else if(job.job_type==='ingest'&&error.code==='provider_observation_unavailable')deps.processing.failIngestDownloadJob(job.id,job.lease_owner,retry);else deps.processing.failJob(job.id,job.lease_owner,persistence?'provider_observation_persistence_unavailable':error.code||'processing_failed',safe,retry);}else{const attempt=deps.processing.getAttempt(job.attempt_id),task=attempt&&deps.processing.getTask(attempt.taskId),project=task&&deps.processing.getProject(task.projectId);deps.processing.failJobTerminal(job.id,job.lease_owner,error.code||'processing_failed',safe,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:task.projectId,projectDisplayName:project?.displayName||undefined,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'},job.job_type==='reconcile'?{reconcile:true,logMessage:safe}:undefined);}return true;}
  finally{clearInterval(heartbeat);}
}
module.exports={adapterFor,attemptCapability,discoverOutputs,verifyProviderMeshClosure,processIngest,processOne,processReconcile,processSubmit};
