'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {Readable}=require('node:stream');
const {pipeline:streamPipeline}=require('node:stream/promises');
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
const ReferenceProtocol=require('./referenceProtocol');
const {fileFacts}=require('./viewerPagedSourceExport');
const {createHeldSourceSnapshot}=require('./heldSourceSnapshot');
const {createPreclaimSourceAttestation}=require('./preclaimSourceAttestation');
const {fsyncDirectory}=require('./durableFs');
const {canonicalizeJcs,PROTOCOL:PREPARED_ENVELOPE_PROTOCOL}=require('./preparedSubmissionOutbox');
const observationPersistenceError=Symbol('observationPersistenceError');
const REFERENCE_UPSTREAM_PHASES=new Set(['queued','waiting_capacity','awaiting_transfer','fetching','source_receiving','init_pending','initialized','upload_pending','uploaded','commit_pending','processing','waiting_for_delivery','awaiting_acceptance','awaiting_failure_acceptance','completed','held','cancelled']);
const REFERENCE_ENGINE_STARTED_PHASES=new Set(['processing','waiting_for_delivery','awaiting_acceptance','completed']);
const REFERENCE_NODE_ASSIGNED_PHASES=new Set(['awaiting_transfer','fetching','init_pending','initialized','upload_pending','uploaded','commit_pending','processing','waiting_for_delivery','awaiting_acceptance']);
const REFERENCE_LOGS_UNAVAILABLE='Processing output could not be refreshed. Provider status is still being tracked; the output cursor has not advanced.';

function adapterFor(provider,config,providerCredentials){return new NodeOdmProvider({endpoint:provider.endpoint,token:providerCredentials.resolve(provider.id),providerType:provider.type,transferTimeoutMs:config.processingProviderTransferTimeoutMs});}
function isReferenceCoordinatorProvider(provider,sourceIntake){return Boolean((typeof sourceIntake?.providerId==='string'&&sourceIntake.providerId&&provider?.id===sourceIntake.providerId)||provider?.capabilities?.detectionMethod==='pinned-reference-coordinator');}
function validReferenceCoordinatorIdentity(provider,sourceIntake){return Boolean(sourceIntake?.enabled&&sourceIntake?.providerId===provider?.id&&sourceIntake?.origin===provider?.endpoint&&provider?.type==='nodeodm');}
function isReferenceResultReady(status){return Boolean(status&&['running','succeeded','completed'].includes(status.status)
  &&['awaiting_acceptance','completed'].includes(status.phase));}
function isReferenceEngineProcessing(status){return Boolean(status?.status==='running'&&status.phase==='processing'
  &&typeof status.nodeId==='string'&&status.nodeId.length>0);}
function transition(processing,job,status,fields){const attempt=processing.transitionAttemptForJob(job.id,job.lease_owner,status,fields);if(!attempt)throw Object.assign(new Error('processing lease was lost or attempt was cancelled'),{code:'lease_lost'});return attempt;}
function retainedGcpBytes(snapshot){if(!snapshot)return null;if(Buffer.isBuffer(snapshot.contentBytes))return snapshot.contentBytes;if(Buffer.isBuffer(snapshot.content))return snapshot.content;if(typeof snapshot.content==='string')return Buffer.from(snapshot.content,'utf8');throw Object.assign(new Error('attempt GCP snapshot content is invalid'),{code:'gcp_snapshot_changed'});}
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

function coordinatorPipelineManifest(dataset,attempt,options,capabilities,gcpSnapshot){
  const photo=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i,auxiliary=/\.(?:txt|geojson|json|zip|las|laz)$/i,mapped=[];
  for(const file of dataset.files){
    const role=file.processingRole||'auto',isPhoto=photo.test(file.relativePath),isAux=auxiliary.test(file.relativePath);
    if(role==='gcp_source'||role==='administrative'||(role==='auto'&&!isPhoto))continue;
    if(role==='image'&&!isPhoto)throw Object.assign(new Error('a dataset image role references an unsupported image type'),{code:'unsupported_source_file'});
    if(role==='provider_input'&&!isAux)throw Object.assign(new Error('a provider input role references an unsupported source type'),{code:'unsupported_source_file'});
    mapped.push({file,processingRole:role});
  }
  if(gcpSnapshot)for(let i=mapped.length-1;i>=0;i--)if(path.basename(mapped[i].file.relativePath).toLowerCase()==='gcp_list.txt')mapped.splice(i,1);
  const photos=mapped.filter(item=>photo.test(item.file.relativePath)),inputs=mapped.filter(item=>!photo.test(item.file.relativePath));
  if(!photos.length)throw Object.assign(new Error('dataset has no processable images'),{code:'unsupported_source_file'});
  const objects=[...photos,...inputs].map(({file})=>{const facts=fileFacts(file);return{id:file.id,name:path.basename(file.relativePath),byteSize:file.byteSize,sha256:file.sha256,kind:facts.kind,mediaType:facts.mediaType};});
  if(gcpSnapshot)objects.push({id:`gcp_${attempt.id}`,name:'gcp_list.txt',byteSize:retainedGcpBytes(gcpSnapshot).length,
    sha256:gcpSnapshot.sha256,kind:'auxiliary',mediaType:'text/plain'});
  const names=new Set();for(const object of objects){const name=object.name.toLowerCase();if(names.has(name))throw Object.assign(new Error('dataset contains duplicate submitted basenames'),{code:'duplicate_source_basename'});names.add(name);}
  const totalBytes=objects.reduce((sum,object)=>sum+object.byteSize,0);
  const manifest={id:dataset.id,revision:Math.max(1,Number(attempt.attemptNumber)||1),totalBytes,objectCount:objects.length,
    inputCounts:{images:objects.filter(object=>object.kind==='image').length,lidarObjects:objects.filter(object=>object.kind==='lidar').length,points:0},objects};
  manifest.sha256=ReferenceProtocol.manifestSha256(manifest);
  const pipeline={odm:{requested:true,options,optionsFingerprint:capabilities.engines.odm.optionsFingerprint},
    treedar:{requested:false,inputObjectIds:[],provenanceReceiptId:null},gaussian_splat:{requested:false}};
  return{manifest,pipeline};
}

function persistedSourceIntakeContext(request, attemptId, gcpSnapshot) {
  if (!request?.manifest || !request?.sourceManifest || !request?.derivedManifest
      || !Array.isArray(request.derivedManifest.objects))
    throw Object.assign(new Error('persisted source-intake closure is incomplete'),{code:'source_intake_request_invalid'});
  const manifests={sourceManifest:request.sourceManifest,sourceManifestSha256:request.sourceManifest.sha256,
    derivedManifest:request.derivedManifest,derivedManifestSha256:request.derivedManifest.sha256,
    pipelineManifest:request.manifest,pipelineManifestSha256:request.manifest.sha256};
  const derivedBytes=new Map(),gcpId=`gcp_${attemptId}`;
  if (request.derivedManifest.objects.length !== (gcpSnapshot ? 1 : 0))
    throw Object.assign(new Error('persisted derived source differs from its retained attempt snapshot'),{code:'gcp_snapshot_changed'});
  for(const object of request.derivedManifest.objects){
    const bytes=retainedGcpBytes(gcpSnapshot);
    if(!object||typeof object!=='object'||object.id!==gcpId||!gcpSnapshot
        ||object.byteSize!==bytes.length||object.sha256!==gcpSnapshot.sha256
        ||crypto.createHash('sha256').update(bytes).digest('hex')!==object.sha256)
      throw Object.assign(new Error('persisted derived source differs from its retained attempt snapshot'),{code:'gcp_snapshot_changed'});
    derivedBytes.set(object.id,bytes);
  }
  return {request,manifests,derivedBytes};
}

async function processSubmitReferenceV2(job,{processing,storage,config,signal,sourceIntake}={}){
  if(!sourceIntake?.client||!sourceIntake?.outbox||!sourceIntake.snapshotSigner||!sourceIntake.snapshotPublicKey
      ||!sourceIntake.attestationSigner)throw Object.assign(new Error('Processing coordinator runtime is not fully configured'),{code:'source_intake_runtime_unavailable'});
  let attempt={...processing.getAttempt(job.attempt_id),...processing.getAttemptSubmission(job.attempt_id)};
  const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId||task.datasetId,true),source=config.referenceSourceIntake;
  if(!task||!dataset)throw Object.assign(new Error('processing task or dataset is unavailable'),{code:'source_intake_source_unavailable'});
  const gcpSnapshot=processing.getAttemptGcpSnapshot?.(attempt.id)||null,gcpBytes=retainedGcpBytes(gcpSnapshot);
  if(gcpSnapshot&&crypto.createHash('sha256').update(gcpBytes).digest('hex')!==gcpSnapshot.sha256)
    throw Object.assign(new Error('attempt GCP snapshot failed its integrity check'),{code:'gcp_snapshot_changed'});
  const existing=sourceIntake.outbox.getIntent(attempt.id);
  let capabilities=null,envelope;
  if(existing){
    sourceIntake.outbox.assertCurrentLease({attemptId:attempt.id,localJobId:job.id,owner:job.lease_owner});
    if(existing.localJobId!==job.id||existing.coordinatorOrigin!==source.origin
        ||existing.coordinatorAuthorityId!==source.authorityId||existing.authenticatedPrincipal!==source.principalId
        ||existing.environment!==source.environment)
      throw Object.assign(new Error('saved source-intake identity differs from the configured coordinator'),{code:'source_intake_authority_changed'});
    envelope=JSON.parse(existing.envelopeCanonical);
    if(existing.state==='prepared'&&!existing.sourceIntakeCanonical){
      const capabilitiesResponse=await sourceIntake.client.getCapabilities({signal});capabilities=capabilitiesResponse.capabilities;
      if(capabilities.environment!==source.environment||capabilitiesResponse.sourceIntake.maxObjects>ReferenceProtocol.LIMITS.objects)
        throw Object.assign(new Error('Processing source-intake capability bounds do not match Viewer policy'),{code:'source_intake_capabilities_invalid'});
      if(envelope.submission.capabilityFingerprint!==capabilities.capabilityFingerprint)
        throw Object.assign(new Error('Saved source-intake intent is held because its capability snapshot is stale'),{code:'source_intake_capabilities_changed'});
    }else if(existing.state!=='prepared'&&existing.state!=='accepted')
      throw Object.assign(new Error('saved source-intake intent is held'),{code:'source_intake_outbox_state_invalid'});
  }else{
    const capabilitiesResponse=await sourceIntake.client.getCapabilities({signal});capabilities=capabilitiesResponse.capabilities;
    if(capabilities.environment!==source.environment||capabilitiesResponse.sourceIntake.maxObjects>ReferenceProtocol.LIMITS.objects)
      throw Object.assign(new Error('Processing source-intake capability bounds do not match Viewer policy'),{code:'source_intake_capabilities_invalid'});
    const {manifest,pipeline}=coordinatorPipelineManifest(dataset,attempt,attempt.options,capabilities,gcpSnapshot);
    const submission={schemaVersion:1,submissionId:attempt.id,manifest,pipeline,capabilityFingerprint:capabilities.capabilityFingerprint};
    envelope={protocol:PREPARED_ENVELOPE_PROTOCOL,schemaVersion:3,activationId:crypto.randomUUID(),viewerTaskId:task.id,viewerAttemptId:attempt.id,submission};
  }
  let prepared=sourceIntake.outbox.persistIntent({localJobId:job.id,owner:job.lease_owner,origin:source.origin,
    authorityId:source.authorityId,principalId:source.principalId,environment:source.environment,envelope});
  let snapshotRow=processing.database.prepare('SELECT snapshot_id FROM viewer_source_snapshots WHERE attempt_id=?').get(attempt.id);
  if(!snapshotRow)createHeldSourceSnapshot(processing,{datasetId:dataset.id,taskId:task.id,attemptId:attempt.id,signer:sourceIntake.snapshotSigner});
  prepared=sourceIntake.outbox.getIntent(attempt.id);
  let request,manifests,derivedBytes;
  if(prepared.sourceIntakeCanonical){
    ({request,manifests,derivedBytes}=persistedSourceIntakeContext(JSON.parse(prepared.sourceIntakeCanonical),attempt.id,gcpSnapshot));
  }else if(prepared.state==='prepared'&&capabilities){
    const attestation=createPreclaimSourceAttestation({processing,outbox:sourceIntake.outbox,attemptId:attempt.id,
      snapshotPublicKey:sourceIntake.snapshotPublicKey,expectedSnapshotIssuerId:source.snapshotIssuerId,
      expectedSnapshotKeyId:source.snapshotKeyId,signer:sourceIntake.attestationSigner,authorityId:source.authorityId,
      principalId:source.principalId,environment:source.environment,capabilities});
    prepared=sourceIntake.outbox.persistSourceIntakeRequest(attempt.id,attestation.sourceIntakeCanonical,{localJobId:job.id,owner:job.lease_owner});
    request=attestation.sourceIntakeRequest;
    manifests={sourceManifest:attestation.sourceManifest,sourceManifestSha256:attestation.sourceManifestSha256,
      derivedManifest:attestation.derivedManifest,derivedManifestSha256:attestation.derivedManifestSha256,
      pipelineManifest:attestation.pipelineManifest,pipelineManifestSha256:attestation.pipelineManifestSha256};
    derivedBytes=attestation.derivedBytes;
  }else throw Object.assign(new Error('Processing source-intake outbox is held or inconsistent'),{code:'source_intake_outbox_state_invalid'});

  const intent={...prepared,viewerAttemptId:attempt.id,sourceIntakeCanonical:prepared.sourceIntakeCanonical};
  const binding=await sourceIntake.client.createOrReplay(intent,{localJobId:job.id,owner:job.lease_owner,
    capabilityFingerprint:capabilities?.capabilityFingerprint,signal});
  const sourceFiles=new Map(dataset.files.map(file=>[file.id,file]));
  for(const file of dataset.files){
    const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true}),stat=fs.statSync(absolute);
    if(stat.size!==file.byteSize||await hashFile(absolute,{signal})!==file.sha256)
      throw Object.assign(new Error('dataset source changed after finalization'),{code:'dataset_source_changed'});
  }
  await sourceIntake.client.uploadClosure({binding,manifests,derivedBytes,localJobId:job.id,owner:job.lease_owner,signal,
    openSourceStream:async(object)=>{const file=sourceFiles.get(object.id);if(!file)throw Object.assign(new Error('source manifest references an unknown dataset object'),{code:'source_intake_manifest_source_mismatch'});const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true});return fs.createReadStream(absolute);}});
  transition(processing,job,'queued_upstream',{progress:0});
  if(!processing.completeAndEnqueueJob(job.id,job.lease_owner,attempt.id,'reconcile',new Date(Date.now()+5000).toISOString()))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
}

async function persistReferenceResultClosure({client,binding,manifest,taskId,attemptId,storage,signal}){
  const total=manifest.objects.reduce((sum,object)=>sum+BigInt(object.byteSize),0n);
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw Object.assign(new Error('Processing result closure exceeds Viewer storage limits'),{code:'source_intake_result_too_large'});
  storage.requireSpace('models',Number(total));
  const relative=`${taskId}/${attemptId}/reference-v2-results/accepted_objects`;
  const directory=storage.resolve('models',relative);fs.mkdirSync(directory,{recursive:true});
  const root=fs.realpathSync.native(storage.roots.models),realDirectory=fs.realpathSync.native(directory);
  if(realDirectory===root||!realDirectory.startsWith(root+path.sep))throw Object.assign(new Error('Processing result directory escaped managed Viewer storage'),{code:'invalid_storage_location'});
  // Persist each directory entry in the new task/attempt path before treating
  // any copied result as durable. This bounded chain stops at the managed root
  // and does not walk or sync unrelated model directories.
  for(let current=realDirectory;current===root||current.startsWith(root+path.sep);current=path.dirname(current)){
    fsyncDirectory(current);
    if(current===root)break;
    if(path.dirname(current)===current)throw Object.assign(new Error('Processing result directory has no managed root'),{code:'invalid_storage_location'});
  }
  const files=new Map();
  for(const object of manifest.objects){
    signal?.throwIfAborted();
    const destination=storage.resolve('models',`${relative}/${object.id}.bin`);
    if(fs.existsSync(destination)){
      const stat=fs.statSync(destination);
      if(!stat.isFile()||stat.size!==object.byteSize||await hashFile(destination,{signal})!==object.sha256)
        throw Object.assign(new Error('stored accepted result object changed'),{code:'source_intake_result_object_conflict'});
      files.set(object.id,destination);continue;
    }
    const partial=storage.resolve('models',`${relative}/${object.id}.bin.partial`);
    const input=await client.openResultObject(binding,manifest,object,{signal});
    try{await streamPipeline(input,fs.createWriteStream(partial,{flags:'w',mode:0o600}),{signal});}
    catch(error){throw Object.assign(new Error('Processing result transfer did not complete'),{code:error?.code==='lease_lost'?'lease_lost':'source_intake_result_transfer_uncertain'});}
    const handle=await fs.promises.open(partial,'r');try{await handle.sync();}finally{await handle.close();}
    const stat=fs.statSync(partial);
    if(stat.size!==object.byteSize||await hashFile(partial,{signal})!==object.sha256)
      throw Object.assign(new Error('Processing result object failed its declared digest'),{code:'source_intake_result_object_integrity_error'});
    fs.renameSync(partial,destination);fsyncDirectory(realDirectory);files.set(object.id,destination);
  }
  return files;
}

async function acceptReferenceResultClosure({job,attempt,task,processing,config,sourceIntake,binding,intent,status,storage,signal}){
  if(!sourceIntake?.copySigner||!sourceIntake?.copyPublicKeyPem||!storage)
    throw Object.assign(new Error('Viewer accepted-copy signer or managed storage is unavailable'),{code:'source_intake_copy_unavailable'});
  const manifest=await sourceIntake.client.getResultManifest(binding,{signal});
  if(manifest.resultManifestSha256!==status.resultManifestSha256)
    throw Object.assign(new Error('Processing result manifest differs from completed status'),{code:'source_intake_result_manifest_binding_mismatch'});
  await persistReferenceResultClosure({client:sourceIntake.client,binding,manifest,taskId:task.id,attemptId:attempt.id,storage,signal});
  let current=sourceIntake.outbox.getIntent(attempt.id);
  if(current.copyRequestCanonical===null){
    const request=JSON.parse(current.sourceIntakeCanonical),completion=JSON.parse(current.sourceIntakeCompletionCanonical);
    const objectIds=manifest.objects.map(object=>object.id),acceptance={schemaVersion:1,receiptId:crypto.randomUUID(),
      storageReceiptId:crypto.randomUUID(),jobId:binding.jobId,generation:binding.generation,environment:binding.environment,
      inputManifestSha256:request.manifest.sha256,pipelineDigest:binding.pipelineDigest,
      resultManifestSha256:manifest.resultManifestSha256,acceptedObjectIds:objectIds,
      acceptedAt:new Date().toISOString(),validationVersion:ReferenceProtocol.PROTOCOL};
    const expected={coordinatorAuthorityId:binding.coordinatorAuthorityId,viewerPrincipalId:current.authenticatedPrincipal,
      submissionId:current.submissionId,activationId:JSON.parse(current.envelopeCanonical).activationId,
      viewerTaskId:task.id,viewerAttemptId:attempt.id,providerTaskId:binding.providerTaskId,
      preparedEnvelopeSha256:current.envelopeSha256,jobId:binding.jobId,generation:binding.generation,environment:binding.environment,
      inputManifestSha256:request.manifest.sha256,pipelineDigest:binding.pipelineDigest,resultManifestSha256:manifest.resultManifestSha256,
      sourceManifestSha256:request.sourceManifest.sha256,derivedManifestSha256:request.derivedManifest.sha256,
      sourceReceiptSha256:completion.sourceReceiptSha256,derivedReceiptSha256:completion.derivedReceiptSha256};
    const viewerReceipt=sourceIntake.copySigner({expected,acceptance,resultManifest:manifest});
    current=sourceIntake.outbox.persistAcceptedResultRequest(attempt.id,manifest,{acceptance,viewerReceipt},
      {environment:binding.environment,localJobId:job.id,owner:job.lease_owner,issuerId:sourceIntake.copySigner.issuerId,
        keyId:sourceIntake.copySigner.keyId,publicKeyPem:sourceIntake.copyPublicKeyPem});
  }else if(current.resultManifestSha256!==crypto.createHash('sha256').update(require('./preparedSubmissionOutbox').canonicalizeJcs(manifest)).digest('hex'))
    throw Object.assign(new Error('Processing result manifest changed after Viewer acceptance was prepared'),{code:'source_intake_result_manifest_conflict'});
  if(current.copyAckCanonical===null){
    const response=await sourceIntake.client.postAcceptedResultCopy(binding,current.copyRequestCanonical,{signal});
    current=sourceIntake.outbox.persistAcceptedResultAck(attempt.id,response,{environment:binding.environment,localJobId:job.id,owner:job.lease_owner});
  }
  if(!current.copyAckCanonical)throw Object.assign(new Error('Processing accepted-copy acknowledgement is not durable'),{code:'source_intake_copy_ack_unavailable'});
  return current;
}

async function processReconcileReferenceV2(job,{processing,config,signal,sourceIntake,storage}={}){
  const attempt=processing.getAttempt(job.attempt_id),task=attempt&&processing.getTask(attempt.taskId),provider=attempt&&processing.getProvider(attempt.providerId);
  if(!attempt||!task||!isReferenceCoordinatorProvider(provider,config.referenceSourceIntake)||!validReferenceCoordinatorIdentity(provider,config.referenceSourceIntake)||!sourceIntake?.client||!sourceIntake?.outbox)
    throw Object.assign(new Error('Processing coordinator reconciliation is not configured'),{code:'source_intake_runtime_unavailable'});
  const intent=sourceIntake.outbox.getIntent(attempt.id),binding=intent?.remoteBinding;
  if(!intent?.sourceIntakeCanonical||!binding||binding.protocol!=='ltds-viewer-source-intake-binding-v2')
    throw Object.assign(new Error('durable Processing coordinator binding is unavailable'),{code:'source_intake_binding_missing'});
  let request,manifests;
  const currentGcpSnapshot=processing.getAttemptGcpSnapshot?.(attempt.id)||null;
  try {
    request=JSON.parse(intent.sourceIntakeCanonical);
    const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
    if(!record(request)||!record(request.manifest)||!record(request.sourceManifest)||!record(request.derivedManifest)
      ||!record(request.sourceAttestation)||!record(request.sourceAttestation.proof)
      ||![request.manifest.sha256,request.sourceManifest.sha256,request.derivedManifest.sha256,request.sourceAttestation.proof.pipelineDigest]
        .every(value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)))
      throw Object.assign(new Error('persisted source-intake closure is invalid'),{code:'source_intake_request_invalid'});
    ({manifests}=persistedSourceIntakeContext(request,attempt.id,currentGcpSnapshot));
  }
  catch (error) {
    if (error instanceof SyntaxError||error?.code==='gcp_snapshot_changed'||error?.code==='source_intake_request_invalid')
      throw Object.assign(new Error('Processing input closure requires reconciliation'),{code:'source_intake_gcp_closure_mismatch'});
    throw error;
  }
  const status=await sourceIntake.client.getJob(binding.jobId,{signal});
  if(status.jobId!==binding.jobId||status.attemptId!==attempt.id||status.providerTaskId!==attempt.providerTaskId
      ||status.generation!==binding.generation||status.environment!==config.referenceSourceIntake.environment
      ||status.manifestSha256!==manifests.pipelineManifestSha256||status.sourceManifestSha256!==manifests.sourceManifestSha256
      ||status.derivedManifestSha256!==manifests.derivedManifestSha256||status.pipelineDigest!==request.sourceAttestation.proof.pipelineDigest)
    throw Object.assign(new Error('Processing coordinator status does not match the durable attempt binding'),{code:'source_intake_status_binding_mismatch'});
  require('./sourceIntakeClientV2').acknowledgedObjects(status,binding,manifests);
  if(!['queued','running','succeeded','completed','failed','cancelled','held'].includes(status.status)
      ||!REFERENCE_UPSTREAM_PHASES.has(status.phase))
    throw Object.assign(new Error('Processing coordinator returned an unknown job state'),{code:'source_intake_status_unknown'});
  const validNodeId=typeof status.nodeId==='string'&&/^[A-Za-z0-9_.:-]{1,128}$/.test(status.nodeId);
  if(REFERENCE_NODE_ASSIGNED_PHASES.has(status.phase)&&!validNodeId)
    throw Object.assign(new Error('Processing coordinator omitted the assigned node for its current phase'),{code:'source_intake_status_node_missing'});
  if(status.phase==='processing'&&status.status!=='running')
    throw Object.assign(new Error('Processing coordinator phase and state are inconsistent'),{code:'source_intake_status_unknown'});
  const engineStarted=REFERENCE_ENGINE_STARTED_PHASES.has(status.phase)
    &&['running','succeeded','completed'].includes(status.status);
  const localStatus=engineStarted?'running':'queued_upstream';
  const resultHandoff=['waiting_for_delivery','awaiting_acceptance','awaiting_failure_acceptance','completed'].includes(status.phase);
  const progress=localStatus==='running'
    ?Number.isFinite(status.progress)?Math.max(0,Math.min(0.9,status.progress)):resultHandoff?0.9:Math.max(0,Math.min(0.9,Number.isFinite(attempt.progress)?attempt.progress:0))
    :0;
  let output;
  try{
    const logs=await sourceIntake.client.getLogs(binding,{after:attempt.providerOutputCursor||0,limit:200,signal});
    if(logs.lines.length||logs.nextCursor!==(attempt.providerOutputCursor||0)){
      output={lines:logs.lines.map(line=>`${String(line.level||'info').slice(0,32)}: ${String(line.message||'').slice(0,4000)}`),nextLine:logs.nextCursor};
    }
  }catch(error){
    if(signal?.aborted||error?.code==='lease_lost'||error?.name==='AbortError')throw error;
    output=null;
    const latest=processing.listLogs(attempt.id,1).at(-1);
    if(latest?.level==='warn'&&latest.message===REFERENCE_LOGS_UNAVAILABLE)output=undefined;
  }
  if(!processing.persistReconcileObservation(job.id,job.lease_owner,attempt.id,output,status))
    throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  if(status.status==='failed'||status.status==='cancelled'){
    const code=`provider_${status.status}`,message=`Processing coordinator ${status.status}`;
    const terminal=processing.failJobTerminal(job.id,job.lease_owner,code,message,{eventId:`processing-failed-${attempt.id}`,
      schemaVersion:1,type:'processing.failed',projectId:task.projectId,projectDisplayName:processing.getProject(task.projectId)?.displayName||undefined,
      taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'},{reconcile:true});
    if(!terminal)throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    return;
  }
  if(status.status==='held'){
    const message='Processing coordinator is holding this attempt for operator review';
    if(!processing.failReconcileJob(job.id,job.lease_owner,'source_intake_upstream_held',message,
      new Date(Date.now()+5*60_000).toISOString(),{logMessage:message}))
      throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    return;
  }
  // Processing reports status=succeeded with phase=awaiting_acceptance after
  // durable result delivery; the Viewer ACK advances only the phase to
  // completed. A completed upstream phase is not Viewer-ready until its exact
  // result closure is copied and the fully accepted ACK is journaled locally.
  if(isReferenceResultReady(status)){
    transition(processing,job,localStatus,{progress});
    const accepted=await acceptReferenceResultClosure({job,attempt,task,processing,config,sourceIntake,binding,intent,status,storage,signal});
    let ack;try{ack=JSON.parse(accepted.copyAckCanonical);}catch{ack=null;}
    if(!ack||ack.fullyAccepted!==true||ack.job?.phase!=='completed'||ack.job?.jobId!==binding.jobId
        ||ack.job?.generation!==binding.generation||ack.job?.environment!==binding.environment)
      throw Object.assign(new Error('Processing has not durably accepted the complete Viewer result copy'),{code:'source_intake_copy_ack_unavailable'});
    const completedStatus={...status,status:'completed',uuid:attempt.providerTaskId};
    if(!processing.advanceReconcileJob(job.id,job.lease_owner,completedStatus,new Date().toISOString()))
      throw Object.assign(new Error('Processing result identity or lease was lost'),{code:'lease_lost'});
  }else{
    const normalizedStatus={...status,status:localStatus,progress,
      queueState:status.queueState==='waiting_for_dispatch'||(localStatus==='queued_upstream'&&['queued','waiting_capacity'].includes(status.phase))?'waiting_for_dispatch':undefined};
    if(!processing.advanceReconcileJob(job.id,job.lease_owner,normalizedStatus,new Date(Date.now()+5000).toISOString()))
      throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  }
}

async function processSubmit(job,{processing,storage,config,providerCredentials,signal,sourceIntake,adapterFactory=adapterFor}){
  let attempt={...processing.getAttempt(job.attempt_id),...processing.getAttemptSubmission(job.attempt_id)};
  const uploadAcceptanceUnknown=attempt.errorCode==='provider_upload_acceptance_unknown'||['uploading','uploading_auxiliary'].includes(attempt.submissionPhase);
  const submissionObservationUnknown=attempt.errorCode==='provider_submission_observation_unavailable'||['uploaded','committing'].includes(attempt.submissionPhase);
  if(uploadAcceptanceUnknown||submissionObservationUnknown){
    const reason=uploadAcceptanceUnknown?'upload_ambiguous':'task_replacement_unverified';
    if(!processing.deferHeldSubmit(job.id,job.lease_owner,30_000,reason))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
    return;
  }
  const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId||task.datasetId,true),provider=processing.getProvider(attempt.providerId);
  if(isReferenceCoordinatorProvider(provider,config.referenceSourceIntake)){
    transition(processing,job,'queued_upstream',{progress:0});
    if(!validReferenceCoordinatorIdentity(provider,config.referenceSourceIntake))throw Object.assign(new Error('dedicated Processing coordinator identity does not match this deployment'),{code:'source_intake_runtime_unavailable'});
    return processSubmitReferenceV2(job,{processing,storage,config,signal,sourceIntake});
  }
  const adapter=adapterFactory(provider,config,providerCredentials);
  const photo=/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i,auxiliary=/\.(?:txt|geojson|json|zip|las|laz)$/i,mapped=[];for(const file of dataset.files){const absolute=storage.resolve(dataset.rootKey,`${dataset.relativePath}/${file.relativePath}`,{mustExist:true}),stat=fs.statSync(absolute);if(stat.size!==file.byteSize||await hashFile(absolute,{signal})!==file.sha256)throw Object.assign(new Error('dataset source changed after finalization'),{code:'dataset_source_changed'});const role=file.processingRole||'auto',isPhoto=photo.test(file.relativePath),isAux=auxiliary.test(file.relativePath);if(role==='gcp_source'||role==='administrative'||(role==='auto'&&!isPhoto))continue;if(role==='image'&&!isPhoto)throw Object.assign(new Error('a dataset image role references an unsupported image type'),{code:'unsupported_source_file'});if(role==='provider_input'&&!isAux)throw Object.assign(new Error('a provider input role references an unsupported source type'),{code:'unsupported_source_file'});mapped.push({relativePath:file.relativePath,absolutePath:absolute,processingRole:role});}
  storage.requireProcessingHeadroom(dataset.byteSize,processing.activeProcessingReservationBytes(attempt.id),processing.activeDerivativeReservationBytes());
  const gcpSnapshot=processing.getAttemptGcpSnapshot?.(attempt.id)||null,gcpBytes=retainedGcpBytes(gcpSnapshot);
  if(gcpSnapshot&&crypto.createHash('sha256').update(gcpBytes).digest('hex')!==gcpSnapshot.sha256)
    throw Object.assign(new Error('attempt GCP snapshot failed its integrity check'),{code:'gcp_snapshot_changed'});
  if(gcpSnapshot)for(let i=mapped.length-1;i>=0;i--)if(path.basename(mapped[i].relativePath).toLowerCase()==='gcp_list.txt')mapped.splice(i,1);
  if(gcpSnapshot)mapped.push({relativePath:'gcp_list.txt',buffer:gcpBytes});
  const basenames=new Set();for(const file of mapped){const name=path.basename(file.relativePath).toLowerCase();if(basenames.has(name))throw Object.assign(new Error('dataset contains duplicate submitted basenames'),{code:'duplicate_source_basename'});basenames.add(name);}const photoFiles=mapped.filter((file)=>photo.test(file.relativePath)),auxiliaryFiles=mapped.filter((file)=>!photo.test(file.relativePath)),files=[...photoFiles,...auxiliaryFiles];if(!photoFiles.length)throw Object.assign(new Error('dataset has no processable images'),{code:'unsupported_source_file'});const maxImages=Number(provider.capabilities?.maxImages);if(Number.isSafeInteger(maxImages)&&maxImages>0&&photoFiles.length>maxImages)throw Object.assign(new Error('dataset exceeds the provider image limit'),{code:'provider_image_limit_exceeded'});
  const sourceFileByPath=new Map(dataset.files.map(file=>[file.relativePath,file]));
  const actualInputFiles=files.map(file=>{const source=sourceFileByPath.get(file.relativePath);return{relativePath:file.relativePath,byteSize:file.buffer?file.buffer.length:source.byteSize,sha256:file.buffer?crypto.createHash('sha256').update(file.buffer).digest('hex'):source.sha256};});
  if(processing.validateAttemptInputInventory&&!processing.validateAttemptInputInventory(job.id,job.lease_owner,dataset.files,actualInputFiles))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  let known=null;try{known=await adapter.status(attempt.providerTaskId,{signal});}catch(error){if(error.code!=='provider_task_not_found')throw error;}
  const freshTaskMissing=!known&&attempt.submissionPhase==='new';
  const save=(phase,count=attempt.uploadedFileCount)=>{if(!processing.setSubmissionStateForJob(job.id,job.lease_owner,phase,count))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});attempt={...attempt,submissionPhase:phase,uploadedFileCount:count};};
  const restart=async()=>{if(known){if(!processing.deferHeldSubmit(job.id,job.lease_owner,30_000,'task_replacement_unverified'))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});throw Object.assign(new Error('submission observation deferred'),{code:'submission_observation_deferred'});}save('new',0);};
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

async function processReconcile(job,{processing,storage,config,providerCredentials,signal,sourceIntake,adapterFactory=adapterFor}){
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
  if(isReferenceCoordinatorProvider(provider,config.referenceSourceIntake))return processReconcileReferenceV2(job,{processing,config,signal,sourceIntake,storage});
  let adapter;
  try{adapter=adapterFactory(provider,config,providerCredentials)}catch(error){
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

async function processIngest(job,{processing,repository,storage,config,providerCredentials,signal,sourceIntake}){
  const attempt=processing.getAttempt(job.attempt_id),task=processing.getTask(attempt.taskId),project=processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId);
  const referenceV2=isReferenceCoordinatorProvider(provider,config.referenceSourceIntake);
  if(referenceV2&&!validReferenceCoordinatorIdentity(provider,config.referenceSourceIntake))throw Object.assign(new Error('dedicated Processing coordinator identity does not match this deployment'),{code:'source_intake_runtime_unavailable'});
  const sourceIntent=referenceV2?sourceIntake?.outbox?.getIntent(attempt.id):null;
  if(referenceV2&&(!sourceIntent?.copyAckCanonical||!sourceIntent.resultManifestCanonical||!sourceIntent.remoteBinding))
    throw Object.assign(new Error('Processing accepted-copy acknowledgement is not durable'),{code:'source_intake_copy_ack_unavailable'});
  const headroom=storage.space('models'),maximumExpansion=Math.max(0,headroom.available-headroom.reserve);
  if(maximumExpansion<1024*1024*1024)throw Object.assign(new Error('insufficient storage for result ingestion'),{code:'insufficient_storage'});
  const recoveredIngest=referenceV2?null:await verifyRecoveredIngestSources(processing,storage,job,signal);
  let archiveReceipt=processing.getAttemptTransferProvenance(attempt.id)?.archive||null;
  const legacyRelative=`${task.id}/${attempt.id}`, managedRelative=`${task.id}/${attempt.id}.v2`;
  const legacyExists=!referenceV2&&fs.existsSync(storage.resolve('models',legacyRelative)), modernExists=!referenceV2&&fs.existsSync(storage.resolve('models',managedRelative));
  if(legacyExists&&modernExists)throw Object.assign(new Error('conflicting processing output layouts'),{code:'invalid_storage_location'});
  if(archiveReceipt?.layoutVersion!==undefined&&archiveReceipt.layoutVersion!==2)throw Object.assign(new Error('unknown processing output layout'),{code:'invalid_storage_location'});
  if(!archiveReceipt&&legacyExists)throw Object.assign(new Error('unreceipted legacy output requires review'),{code:'invalid_storage_location'});
  const modern=!referenceV2&&(archiveReceipt ? archiveReceipt.layoutVersion===2 : true);
  if((modern&&legacyExists)||(!modern&&modernExists))throw Object.assign(new Error('processing output layout differs from receipt'),{code:'invalid_storage_location'});
  const relative=referenceV2?`${legacyRelative}/reference-v2-results`:modern?`${managedRelative}/source`:legacyRelative;
  const outputRelative=referenceV2?`${relative}/output`:modern?managedRelative:legacyRelative;
  const destination=storage.resolve('models',relative),outputDestination=referenceV2?storage.resolve('models',outputRelative):destination;
  const captureAndRecordArchive=async(readable,target,{allowExistingVerifiedTarget=false,acceptedObject=null}={})=>{
    let saved=null;
    // Historical receipts have no directory inventory; retain their original
    // shape on retry, while requiring the full inventory on new receipts.
    const matchesReceipt=(stored,current)=>Boolean(stored&&(stored.layoutVersion===2)===modern&&stored.archiveSha256===current.archiveSha256&&stored.archiveByteSize===current.archiveByteSize&&stored.archiveManifestSha256===current.archiveManifestSha256&&JSON.stringify(stored.archiveFiles)===JSON.stringify(current.archiveFiles)&&
      (stored.archiveDirectories===undefined&&stored.archiveDirectoriesSha256===undefined||stored.archiveDirectoriesSha256===current.archiveDirectoriesSha256&&JSON.stringify(stored.archiveDirectories)===JSON.stringify(current.archiveDirectories)));
    const captured=await captureProcessingArchive(readable,target,{maxEntries:100000,maxBytes:maximumExpansion,maxArchiveBytes:maximumExpansion,maxDiskBytes:maximumExpansion,signal,allowExistingVerifiedTarget,
      fencedPromote:(receipt,promote)=>{
        if(acceptedObject&&(receipt.archiveSha256!==acceptedObject.sha256||receipt.archiveByteSize!==acceptedObject.byteSize))
          throw Object.assign(new Error('durably accepted ODM archive changed'),{code:'source_intake_result_object_conflict'});
        saved=processing.recordAttemptArchiveReceipt(job.id,job.lease_owner,modern?{...receipt,layoutVersion:2}:receipt,{promote,claimAttemptCount:job.attempt_count});
        if(!matchesReceipt(saved,receipt))
          throw Object.assign(new Error('processing archive receipt or lease was lost'),{code:'lease_lost'});
      }});
    if(!matchesReceipt(saved,captured))
      throw Object.assign(new Error('processing archive receipt or lease was lost'),{code:'lease_lost'});
    return saved;
  };
  // A recovery job must never inherit the historical unreceipted-directory
  // fallback after a crash between filesystem promotion and receipt commit.
  // Recheck in the actual existing-directory branch after source hashing.
  if(referenceV2){
    const manifest=JSON.parse(sourceIntent.resultManifestCanonical),archiveObject=manifest.objects.find(object=>object.role==='odm_archive');
    if(!archiveObject)throw Object.assign(new Error('Processing result closure has no Viewer-ingestible ODM archive'),{code:'source_intake_result_archive_missing'});
    const archiveRelative=`${relative}/accepted_objects/${archiveObject.id}.bin`,archivePath=storage.resolve('models',archiveRelative,{mustExist:true});
    const archiveStat=fs.statSync(archivePath);
    if(archiveStat.size!==archiveObject.byteSize||await hashFile(archivePath,{signal})!==archiveObject.sha256)
      throw Object.assign(new Error('durably accepted ODM archive changed'),{code:'source_intake_result_object_conflict'});
    if(!fs.existsSync(outputDestination)){
      archiveReceipt=await captureAndRecordArchive(fs.createReadStream(archivePath),outputDestination,{acceptedObject:archiveObject});
    }else if(archiveReceipt)await verifyProcessingArchive(outputDestination,archiveReceipt,{signal,ensureDurable:true});
    else archiveReceipt=await captureAndRecordArchive(fs.createReadStream(archivePath),outputDestination,{allowExistingVerifiedTarget:true,acceptedObject:archiveObject});
  }else if(!fs.existsSync(destination)){
    const adapter=adapterFor(provider,config,providerCredentials);
    const response=await adapter.downloadAll(attempt.providerTaskId,{signal}),declared=Number(response.headers.get('content-length')||0);
    if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    archiveReceipt=await captureAndRecordArchive(Readable.fromWeb(response.body),destination);
  }else if(archiveReceipt){
    await verifyProcessingArchive(destination,archiveReceipt,{signal,ensureDurable:true});
  }else if(recoveredIngest||modern){
    const adapter=adapterFor(provider,config,providerCredentials);
    const response=await adapter.downloadAll(attempt.providerTaskId,{signal}),declared=Number(response.headers.get('content-length')||0);
    if(declared>maximumExpansion)throw Object.assign(new Error('provider result exceeds available storage'),{code:'insufficient_storage'});
    archiveReceipt=await captureAndRecordArchive(Readable.fromWeb(response.body),destination,{allowExistingVerifiedTarget:true});
  }
  // Ordinary historical jobs retain their existing unreceipted-directory
  // behavior; an audited recovery can never enter that compatibility path.
  const outputPrefix=referenceV2?'output/':'';
  const found=discoverOutputs(outputDestination).map(asset=>({...asset,relativePath:`${outputPrefix}${asset.relativePath}`}));if(!found.some((asset)=>['glb','obj','pointCloud','ortho','ept'].includes(asset.kind)))throw Object.assign(new Error('provider archive has no supported outputs'),{code:'missing_required_output'});
  if(!found.some((asset)=>asset.kind==='ept'))throw Object.assign(new Error('provider did not generate required EPT output'),{code:'missing_required_output'});
  const meshManifest=await verifyProviderMeshClosure(outputDestination,found,{signal});
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
  const odmMetadata=readOdmTaskMetadata(outputDestination);
  const provenance=processing.getAttemptProvenance?.(attempt.id)||null;
  const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,sourceLocator:{taskId:task.id,attemptId:attempt.id},metadata:{projectId:project.id,projectName:project.displayName},versionMetadata:{sourceDatasetId:attempt.datasetId||task.datasetId,processingMetrics:odmMetadata.processingMetrics,processingProvenance:provenance?{schemaVersion:1,attemptId:attempt.id,submissionSnapshotSha256:provenance.submission?.snapshotSha256||null,providerTaskId:attempt.providerTaskId,hasTaskInfoEvidence:Boolean(provenance.providerResult),producingEngineVerified:false}:null},georef:odmMetadata.georef,pointCount:odmMetadata.pointCount,status:'importing',assets,makeActive:false});
  const version=repository.database.prepare('SELECT id FROM model_versions WHERE model_id=? AND provider_version_id=?').get(model.id,attempt.id);
  if(!processing.setAttemptResultForJob(job.id,job.lease_owner,model.id,version.id))throw Object.assign(new Error('processing lease was lost'),{code:'lease_lost'});
  const tree=storage.scanAbsolute(destination);processing.registerModelOutput({versionId:version.id,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:referenceV2?relative:outputRelative,status:'staged',byteSize:tree.byteSize,assetCount:assets.length});
  const producer=archiveReceipt?processing.getVerifiedAttemptProducerReceipt(attempt.id):null;
  const explicitUnits=await inspectRegisteredSourceUnits({repository,storage,modelId:model.id,modelVersionId:version.id,signal});
  const unitCandidates=await prepareProcessingUnitEvidence({producer,destination:outputDestination,sourcePrefix:outputRelative,modelId:model.id,modelVersionId:version.id,assets:repository.getModelVersion(model.id,version.id).activeVersion.assets,signal});
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
  // Distinguish each claim even if a worker identity recurs across processes.
  owner=`${owner}:${crypto.randomUUID()}`;
  const source=deps.config?.referenceSourceIntake;
  const referenceCoordinatorProviderId=source?.enabled===true&&typeof source.providerId==='string'&&source.providerId?source.providerId:null;
  const job=deps.processing.claimJob(owner,60,{referenceCoordinatorProviderId});if(!job)return false;
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
  catch(error){if(reconcileHeartbeatFailed||error?.code==='submission_observation_deferred')return true;if(job.job_type==='submit'&&error?.code==='source_intake_capabilities_changed'){deps.processing.appendLog(job.attempt_id,'warn',sanitizeLogMessage(error.message).slice(0,1000));deps.processing.deferHeldSubmit(job.id,job.lease_owner,30_000,'capability_snapshot_stale');return true;}if(job.job_type==='submit'&&String(error?.code||'').startsWith('source_intake_')){deps.processing.appendLog(job.attempt_id,'warn',sanitizeLogMessage(error.message).slice(0,1000));deps.processing.deferHeldSubmit(job.id,job.lease_owner,30_000,error?.code==='source_intake_admission_unknown'?'admission_unknown':'coordinator_unavailable');return true;}if(job.job_type==='submit'&&!controller.signal.aborted&&!['lease_lost','ABORT_ERR'].includes(error?.code)&&['uploading','uploading_auxiliary'].includes(deps.processing.getAttemptSubmission(job.attempt_id)?.submissionPhase)){deps.processing.deferHeldSubmit(job.id,job.lease_owner,30_000,'upload_ambiguous');return true;}const persistence=Boolean(error?.[observationPersistenceError]||error?.code==='provider_observation_persistence_unavailable'),safe=persistence?'Provider observation could not be saved; reconciliation will continue':sanitizeLogMessage(error.message).slice(0,1000);if(job.job_type==='reconcile'&&(controller.signal.aborted||error?.name==='AbortError'||['ABORT_ERR','lease_lost'].includes(error.code))){deps.processing.failReconcileJob(job.id,job.lease_owner,'processing_interrupted','Processing interrupted; reconciliation will resume',new Date(Date.now()+5000).toISOString());return true;}if(error.code==='insufficient_storage'&&job.job_type==='submit'){deps.processing.deferSubmitAdmission(job.id,job.lease_owner);return true;}if(job.job_type!=='reconcile')deps.processing.appendLog(job.attempt_id,'error',safe);const permanent=new Set(['ingest_recovery_source_changed','ingest_recovery_state_changed','source_changed','duplicate_source_basename','missing_required_output','invalid_storage_location','unsupported_source_file','dataset_source_changed','gcp_snapshot_changed','invalid_asset_tree','provider_image_limit_exceeded','derivative_source_too_large','invalid_derivative_input','archive_receipt_mismatch']).has(error.code),observation=job.job_type==='reconcile'&&(persistence||['provider_observation_unavailable','provider_status_unknown','provider_status_not_found','provider_status_auth_failed','provider_adapter_unavailable','provider_result_identity_mismatch','provider_attempt_unavailable'].includes(error.code)||String(error?.code||'').startsWith('source_intake_')),retry=!permanent&&(observation||job.attempt_count<5)?new Date(Date.now()+Math.min(300000,5000*2**Math.min(job.attempt_count,6))).toISOString():null;if(retry){if(job.job_type==='reconcile')deps.processing.failReconcileJob(job.id,job.lease_owner,persistence?'provider_observation_persistence_unavailable':error.code||'processing_failed',safe,retry,{logMessage:safe,presentationUnavailable:String(error?.code||'').startsWith('source_intake_')});else deps.processing.failJob(job.id,job.lease_owner,persistence?'provider_observation_persistence_unavailable':error.code||'processing_failed',safe,retry);}else{const attempt=deps.processing.getAttempt(job.attempt_id),task=attempt&&deps.processing.getTask(attempt.taskId),project=task&&deps.processing.getProject(task.projectId);deps.processing.failJobTerminal(job.id,job.lease_owner,error.code||'processing_failed',safe,{eventId:`processing-failed-${attempt.id}`,schemaVersion:1,type:'processing.failed',projectId:task.projectId,projectDisplayName:project?.displayName||undefined,taskId:task.id,taskDisplayName:task.displayName,attemptId:attempt.id,requestedBySubject:attempt.createdBy,status:'failed'},job.job_type==='reconcile'?{reconcile:true,logMessage:safe}:undefined);}return true;}
  finally{clearInterval(heartbeat);}
}
module.exports={adapterFor,coordinatorPipelineManifest,discoverOutputs,isReferenceCoordinatorProvider,isReferenceEngineProcessing,isReferenceResultReady,persistedSourceIntakeContext,processIngest,processOne,processReconcile,processSubmit,processSubmitReferenceV2,verifyProviderMeshClosure};
