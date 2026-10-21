'use strict';

const crypto = require('node:crypto');
const { recordImportedSourceUnits } = require('./importSourceUnitEvidence');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { extractZipDescriptor } = require('./safeZip');
const { matchesSourceSnapshot, openImportFolderSource, openImportZipSource } = require('./importSourceSnapshot');
const { buildRetainedManifest } = require('./retainedManifest');
const { retainedChunkVerifier } = require('./retainedChunkVerifier');
const { discoverAssets } = require('./catalogImport');
const { validateImportSelection } = require('./importBrowser');
const { hashTree } = require('./storageManager');
const { readOdmTaskMetadata } = require('./odmTaskMetadata');
const { lodDerivativeSpecs } = require('./lodDerivativePolicy');
const { compareUtf8 } = require('./processingSecurity');
const { fsyncDirectory, fsyncDirectoryTree } = require('./durableFs');

const CAPABILITIES = Object.freeze({
  glb: '3d_model', obj: '3d_model', tiles: '3d_model',
  ept: 'point_cloud', pointCloud: 'point_cloud', ortho: 'orthophoto',
  dsm: 'dsm', dtm: 'dtm', shots: 'camera_positions',
});

function capabilitySummary(assets) {
  const assetKinds = [...new Set(assets.map((asset) => asset.kind))].sort();
  return { assetKinds, capabilities: [...new Set(assetKinds.map((kind) => CAPABILITIES[kind]).filter(Boolean))].sort() };
}

async function copyTree(sourceFd, destination, { maxFiles, maxBytes, signal, progress = async () => {} }) {
  const same=(left,right)=>left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.ctimeNs===right.ctimeNs&&left.mtimeNs===right.mtimeNs;
  let files=0,bytes=0;
  fs.mkdirSync(destination,{recursive:true});
  const walk=async(directoryFd,relative='')=>{
    if(signal?.aborted)throw Object.assign(new Error('task import cancelled'),{code:'lease_lost'});
    const beforeDirectory=fs.fstatSync(directoryFd,{bigint:true}),directoryPath=`/proc/self/fd/${directoryFd}`;
    for(const entry of fs.readdirSync(directoryPath,{withFileTypes:true})){
      if(signal?.aborted)throw Object.assign(new Error('task import cancelled'),{code:'lease_lost'});
      const rel=relative?`${relative}/${entry.name}`:entry.name,childPath=`${directoryPath}/${entry.name}`,before=fs.lstatSync(childPath,{bigint:true});
      if(before.isSymbolicLink()||(!before.isDirectory()&&!before.isFile()))throw Object.assign(new Error('task import contains an unsupported file'),{code:'invalid_asset_tree'});
      if(before.isDirectory()){
        let childFd;try{childFd=fs.openSync(childPath,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch{throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});}
        try{const opened=fs.fstatSync(childFd,{bigint:true});if(!opened.isDirectory()||!same(before,opened))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});fs.mkdirSync(path.join(destination,...rel.split('/')),{recursive:true});await walk(childFd,rel);}finally{fs.closeSync(childFd);}
        continue;
      }
      let fileFd;try{fileFd=fs.openSync(childPath,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch{throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});}
      try{
        const opened=fs.fstatSync(fileFd,{bigint:true});if(!opened.isFile()||!same(before,opened)||opened.size>BigInt(Number.MAX_SAFE_INTEGER))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});
        files+=1;bytes+=Number(opened.size);if(files>maxFiles)throw Object.assign(new Error('task import contains too many files'),{code:'too_many_files'});if(!Number.isSafeInteger(bytes)||bytes>maxBytes)throw Object.assign(new Error('task import exceeds the configured size limit'),{code:'import_too_large'});
        const target=path.join(destination,...rel.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});const duplicate=fs.openSync(`/proc/self/fd/${fileFd}`,fs.constants.O_RDONLY|fs.constants.O_CLOEXEC),streams=[fs.createReadStream(null,{fd:duplicate,autoClose:true,start:0}),fs.createWriteStream(target,{flags:'wx',mode:0o600})];if(signal)await pipeline(...streams,{signal});else await pipeline(...streams);
        if(!same(opened,fs.fstatSync(fileFd,{bigint:true})))throw Object.assign(new Error('task import source changed while copying'),{code:'source_changed'});
      }finally{fs.closeSync(fileFd);}
      await progress(files/(files+1));
    }
    if(!same(beforeDirectory,fs.fstatSync(directoryFd,{bigint:true})))throw Object.assign(new Error('task import source changed during traversal'),{code:'source_changed'});
  };
  await walk(sourceFd);await progress(1);
}

async function stageSource(operation, { processing, storage, config }, signal, progress) {
  const payload = JSON.parse(operation.payload_json || '{}'), request = payload.request || {};
  const expectedKind=payload.importSource?.kind==='server_zip'?'zip':payload.importSource?.kind==='server_folder'?'folder':null,selected=validateImportSelection(storage, request.sourceRelativePath,{expectedKind});
  const source = storage.resolve('dataset_import', request.sourceRelativePath, { mustExist: true });
  const stat = fs.lstatSync(source);
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw Object.assign(new Error('WebODM task source must be a folder or ZIP archive'), { code: 'invalid_import_source' });
  const stagingCleanupRelative = `webodm-task-imports/${operation.id}`, stagingRelative = `${stagingCleanupRelative}/extracted`, staging = storage.resolve('cache', stagingRelative);
  const maxFiles = config.uploadMaxFiles || 100000;
  const available = storage.space('datasets', 0), cacheSpace = storage.space('cache', stat.isFile() ? stat.size : 0);
  if (!cacheSpace.ok) throw Object.assign(new Error('insufficient cache headroom for WebODM task staging'), { code: 'insufficient_storage' });
  const maxBytes = Math.max(0, Math.min(available.available - available.reserve, cacheSpace.available - cacheSpace.reserve));
  if(selected.kind==='folder'){
    const opened=openImportFolderSource(storage,request.sourceRelativePath);
    try{if(fs.existsSync(staging))fs.rmSync(staging,{recursive:true,force:true});await copyTree(opened.fd,staging,{maxFiles,maxBytes,signal,progress:(value)=>progress(value*0.25)});}finally{opened.close();}
  }
  else {
    const opened=openImportZipSource(storage,request.sourceRelativePath);
    try{
      const snapshot=await opened.snapshot({signal}),persisted=payload.sourceSnapshot;
      if(persisted&&!matchesSourceSnapshot(persisted,snapshot))throw Object.assign(new Error('WebODM task source changed before extraction'),{code:'source_changed'});
      if(!persisted&&!processing.setWebodmImportSourceSnapshot(operation.id,operation.lease_owner,snapshot))throw Object.assign(new Error('task import lease was lost before source snapshot was persisted'),{code:'operation_lease_lost'});
      payload.sourceSnapshot=persisted||snapshot;
      if(!fs.existsSync(staging))await extractZipDescriptor(opened.fd,snapshot.byteSize,staging,{maxEntries:maxFiles,maxBytes,workId:operation.id,signal,onProgress:(value)=>progress(value*0.25)});
      else{const stagedStat=fs.lstatSync(staging);if(stagedStat.isSymbolicLink()||!stagedStat.isDirectory())throw Object.assign(new Error('WebODM extraction staging changed'),{code:'invalid_asset_tree'});await progress(0.25);}
      if(await opened.hash({signal})!==snapshot.sha256)throw Object.assign(new Error('WebODM task source changed during extraction'),{code:'source_changed'});
    }finally{opened.close();}
  }
  return { payload, request, source, staging, stagingRelative, stagingCleanupRelative };
}

async function copyRetainedClosure(sourceRoot,destination,manifest,{signal=null,progress=async()=>{},syncDirectoryTree=true}={}){
  const root=fs.realpathSync.native(sourceRoot),same=(left,right)=>left&&right&&left.dev===right.dev&&left.ino===right.ino&&left.mode===right.mode&&left.size===right.size&&left.ctimeNs===right.ctimeNs&&left.mtimeNs===right.mtimeNs;
  if(manifest.sourceRootPath!==root||!same(manifest.sourceRootIdentity,fs.lstatSync(root,{bigint:true})))throw Object.assign(new Error('retained source root changed before materialization'),{code:'source_changed'});
  const sourceSegments=(value)=>{const raw=String(value||'');if(!raw||raw.includes('\\')||raw.startsWith('/')||raw.split('/').some(segment=>!segment||segment==='.'||segment==='..'))throw Object.assign(new Error('retained source path is unsafe'),{code:'retained_dependency_unsafe'});return raw.split('/');};
  const openDirectory=(parentFd,name)=>{const candidate=`/proc/self/fd/${parentFd}/${name}`,before=fs.lstatSync(candidate,{bigint:true});if(before.isSymbolicLink()||!before.isDirectory())throw Object.assign(new Error('retained source directory changed before materialization'),{code:'source_changed'});let fd;try{fd=fs.openSync(candidate,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch(error){throw Object.assign(new Error('retained source directory changed before materialization'),{code:'source_changed',cause:error});}const opened=fs.fstatSync(fd,{bigint:true});if(!same(before,opened)){fs.closeSync(fd);throw Object.assign(new Error('retained source directory changed before materialization'),{code:'source_changed'});}return{fd,identity:opened};};
  let rootFd;try{rootFd=fs.openSync(root,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch(error){throw Object.assign(new Error('retained source root cannot be opened safely'),{code:'source_changed',cause:error});}
  const rootIdentity=fs.fstatSync(rootFd,{bigint:true});fs.mkdirSync(destination,{recursive:true});
  try{
    if(!same(manifest.sourceRootIdentity,rootIdentity))throw Object.assign(new Error('retained source root changed while opening'),{code:'source_changed'});
    for(let index=0;index<manifest.files.length;index+=1){
      if(signal?.aborted)throw Object.assign(new Error('retained materialization cancelled'),{code:'lease_lost'});
      const item=manifest.files[index],segments=sourceSegments(item.sourceRelativePath),fileName=segments.pop(),held=[];let directoryFd=rootFd,input=null,output=null,target;
      try{
        for(const segment of segments){const opened=openDirectory(directoryFd,segment);held.push(opened);directoryFd=opened.fd;}
        const source=`/proc/self/fd/${directoryFd}/${fileName}`,before=fs.lstatSync(source,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size!==BigInt(item.byteSize))throw Object.assign(new Error('retained source changed before materialization'),{code:'source_changed'});
        try{input=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);}catch(error){throw Object.assign(new Error('retained source changed before materialization'),{code:'source_changed',cause:error});}
        const opened=fs.fstatSync(input,{bigint:true});if(!same(before,opened))throw Object.assign(new Error('retained source changed before materialization'),{code:'source_changed'});
        const targetSegments=sourceSegments(item.relativePath);target=path.join(destination,...targetSegments);const destinationRoot=path.resolve(destination);if(target!==destinationRoot&&!target.startsWith(`${destinationRoot}${path.sep}`))throw Object.assign(new Error('retained destination path is unsafe'),{code:'retained_dependency_unsafe'});fs.mkdirSync(path.dirname(target),{recursive:true});output=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC,0o600);
        const chunkProof=retainedChunkVerifier(item.chunks,item.byteSize),hash=crypto.createHash('sha256'),buffer=Buffer.allocUnsafe(1024*1024);let position=0;while(position<item.byteSize){if(signal?.aborted)throw Object.assign(new Error('retained materialization cancelled'),{code:'lease_lost'});const count=await new Promise((resolve,reject)=>fs.read(input,buffer,0,Math.min(buffer.length,item.byteSize-position),position,(error,bytes)=>error?reject(error):resolve(bytes)));if(count<=0)throw Object.assign(new Error('retained source was truncated'),{code:'source_changed'});hash.update(buffer.subarray(0,count));chunkProof.update(buffer.subarray(0,count));let written=0;while(written<count){const countWritten=await new Promise((resolve,reject)=>fs.write(output,buffer,written,count-written,position+written,(error,bytes)=>error?reject(error):resolve(bytes)));if(countWritten<=0)throw Object.assign(new Error('retained destination write made no progress'),{code:'retained_materialization_failed'});written+=countWritten;}position+=count;}
        chunkProof.finish();
        if(hash.digest('hex')!==item.sha256||!same(opened,fs.fstatSync(input,{bigint:true})))throw Object.assign(new Error('retained source changed during materialization'),{code:'source_changed'});for(const directory of held)if(!same(directory.identity,fs.fstatSync(directory.fd,{bigint:true})))throw Object.assign(new Error('retained source directory changed during materialization'),{code:'source_changed'});if(!same(rootIdentity,fs.fstatSync(rootFd,{bigint:true})))throw Object.assign(new Error('retained source root changed during materialization'),{code:'source_changed'});fs.fchmodSync(output,0o440);fs.fsyncSync(output);
      }finally{if(output!==null)fs.closeSync(output);if(input!==null)fs.closeSync(input);for(let heldIndex=held.length-1;heldIndex>=0;heldIndex-=1)fs.closeSync(held[heldIndex].fd);}
      await progress((index+1)/manifest.files.length);
    }
    if(syncDirectoryTree)fsyncDirectoryTree(destination,{code:'retained_materialization_failed'});
  }finally{fs.closeSync(rootFd);}
}

function manifestHash(files) { return crypto.createHash('sha256').update(JSON.stringify(files.map(({ relativePath, byteSize, sha256 }) => ({ relativePath, byteSize, sha256 })))).digest('hex'); }

function pruneUnreferencedRetainedMaterializations(storage,retainedBase,keepRelativePaths=[]){const base=storage.resolve('cache',retainedBase),keep=new Set(keepRelativePaths.map(value=>path.posix.basename(String(value||''))));if(!fs.existsSync(base))return;const root=fs.lstatSync(base);if(root.isSymbolicLink()||!root.isDirectory())throw Object.assign(new Error('retained materialization root is unsafe'),{code:'retained_materialization_conflict'});for(const entry of fs.readdirSync(base,{withFileTypes:true})){if(keep.has(entry.name)||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:complete|incomplete)$/i.test(entry.name))continue;const target=path.join(base,entry.name),stat=fs.lstatSync(target);if(stat.isSymbolicLink()||!stat.isDirectory())throw Object.assign(new Error('retained materialization orphan is unsafe'),{code:'retained_materialization_conflict'});fs.rmSync(target,{recursive:true,force:false});}}

async function importWebodmTask(operation, { processing, repository, storage, config }, progress = async () => {}, signal = null) {
  const replay=processing.getWebodmTaskImport(operation.id);
  if(replay){
    const payload=JSON.parse(operation.payload_json||'{}'),ids=payload.ids||{},retainedImport=processing.getRetainedImport(operation.id),project=processing.getProject(replay.projectId),task=processing.getTask(replay.taskId),attempt=processing.getAttempt(replay.attemptId),dataset=processing.getDataset(replay.datasetId,true),model=repository.getModelVersion(replay.modelId,replay.modelVersionId);
    if(!project||!task||!attempt||!dataset||dataset.status!=='finalized'||!model||replay.sourceRelativePath!==payload.request?.sourceRelativePath||replay.projectId!==payload.request?.projectId||replay.taskId!==ids.taskId||replay.datasetId!==ids.datasetId||replay.attemptId!==ids.attemptId||replay.modelId!==ids.modelId||replay.modelVersionId!==ids.versionId||attempt.status!=='ingesting'||!retainedImport||!['materialized','registering'].includes(retainedImport.state)||retainedImport.leaseOwner!==operation.lease_owner||!retainedImport.leaseToken)throw Object.assign(new Error('WebODM import replay state changed'),{code:'webodm_import_replay_conflict'});
    const datasetRoot=storage.resolve('datasets',dataset.relativePath,{mustExist:true}),rediscovered=await discoverAssets(datasetRoot);
    if(rediscovered.sourceFingerprint!==replay.sourceFingerprint)throw Object.assign(new Error('WebODM import replay source changed'),{code:'webodm_import_replay_conflict'});
    const assets=rediscovered.assets.map((asset)=>({...asset,rootKey:'datasets',relativePath:`${dataset.relativePath}/${asset.relativePath}`,storageMode:'adopted',published:false,sourceAttemptId:attempt.id})),summary=capabilitySummary(assets);
    if(JSON.stringify(summary.assetKinds)!==JSON.stringify(replay.assetKinds))throw Object.assign(new Error('WebODM import replay assets changed'),{code:'webodm_import_replay_conflict'});
    await recordImportedSourceUnits(operation, { processing, repository, storage }, model.id, replay.modelVersionId, { signal });
    const requiredDerivatives=lodDerivativeSpecs(assets,{meshDerivativesEnabled:config.meshDerivativesEnabled,required:true});
    return{project,task,attempt,model,import:replay,requiredDerivatives,retainedLeaseToken:retainedImport.leaseToken,...summary};
  }
  const { payload, request, staging, stagingRelative, stagingCleanupRelative } = await stageSource(operation, { processing, storage, config }, signal, progress);
  const ids = payload.ids || {}, sourceDiscovered = await discoverAssets(staging), sourceSummary = capabilitySummary(sourceDiscovered.assets);
  if (!sourceSummary.assetKinds.length) {
    const selectedSource = payload.importSource?.kind === 'server_zip' ? 'The selected ZIP archive' : 'The selected server folder';
    throw Object.assign(new Error(`${selectedSource} contains no supported processed WebODM outputs. Select the WebODM backup ZIP itself or a folder containing its extracted outputs. To process raw photos, use New task.`), { code: 'no_supported_assets' });
  }
  const retainedManifest=await buildRetainedManifest(staging,{signal});
  const retained=processing.recordRetainedImportManifest(operation.id,operation.lease_owner,{attemptId:ids.attemptId,datasetId:ids.datasetId,sourceKind:payload.importSource?.kind==='server_zip'?'backup_zip':'server_folder',sourceRelativePath:request.sourceRelativePath,sourceSnapshot:payload.sourceSnapshot,extractedTreeSha256:sourceDiscovered.sourceFingerprint,stagingRelativePath:stagingCleanupRelative,manifestSha256:retainedManifest.manifestSha256,files:retainedManifest.files});
  if(!retained)throw Object.assign(new Error('task import lease was lost before retained manifest persistence'),{code:'operation_lease_lost'});
  const retainedBytes=retainedManifest.files.reduce((sum,file)=>sum+file.byteSize,0);if(!Number.isSafeInteger(retainedBytes))throw Object.assign(new Error('retained materialization exceeds the safe accounting range'),{code:'invalid_retained_manifest'});storage.requireSpace('cache',retainedBytes);storage.requireSpace('datasets',retainedBytes);
  const retainedBase=`${stagingCleanupRelative}/retained`,incompleteRelative=`${retainedBase}/${retained.leaseToken}.incomplete`,completeRelative=`${retainedBase}/${retained.leaseToken}.complete`,incomplete=storage.resolve('cache',incompleteRelative),complete=storage.resolve('cache',completeRelative),referenced=payload.adoptionIntent?.rootKey==='cache'&&String(payload.adoptionIntent.relativePath||'').startsWith(`${retainedBase}/`)?[payload.adoptionIntent.relativePath]:[];pruneUnreferencedRetainedMaterializations(storage,retainedBase,[incompleteRelative,completeRelative,...referenced]);fs.rmSync(incomplete,{recursive:true,force:true});fs.rmSync(complete,{recursive:true,force:true});
  try{await copyRetainedClosure(staging,incomplete,retainedManifest,{signal,progress:(value)=>progress(0.35+value*0.3)});if(!processing.promoteRetainedMaterialization(operation.id,operation.lease_owner,retained.leaseToken,()=>{if(fs.existsSync(complete))throw Object.assign(new Error('retained materialization destination already exists'),{code:'retained_materialization_conflict'});if(fs.statSync(incomplete).dev!==fs.statSync(path.dirname(complete)).dev)throw Object.assign(new Error('retained activation crossed filesystems'),{code:'invalid_storage_location'});fs.renameSync(incomplete,complete);fsyncDirectory(path.dirname(complete),{code:'retained_materialization_failed'});}))throw Object.assign(new Error('task import lease was lost before retained materialization'),{code:'operation_lease_lost'});}catch(error){fs.rmSync(incomplete,{recursive:true,force:true});throw error;}
  const retainedDiscovered=await discoverAssets(complete),summary=capabilitySummary(retainedDiscovered.assets);if(!summary.assetKinds.length)throw Object.assign(new Error('Retained WebODM products contain no supported artifacts'),{code:'no_supported_assets'});await progress(0.7);
  if(!processing.setCatalogAdoptionIntent(operation.id,operation.lease_owner,{rootKey:'cache',relativePath:completeRelative,datasetRelative:ids.datasetId}))throw Object.assign(new Error('task import lease was lost before adoption was journaled'),{code:'operation_lease_lost'});

  let dataset = processing.getDataset(ids.datasetId, true);
  if (!dataset) dataset = processing.createDataset({ id: ids.datasetId, projectId: request.projectId, displayName: `${request.taskDisplayName} source`, sourceType: 'webodm', storageMode: 'adopted', rootKey: 'datasets', relativePath: ids.datasetId, status: 'finalizing', createdBy: operation.subject, metadata: { catalogImportOperationId: operation.id, webodmTaskImportOperationId: operation.id, sourceRelativePath: request.sourceRelativePath, assetKinds: summary.assetKinds,retainedManifestSha256:retainedManifest.manifestSha256 } });
  if (dataset.status !== 'finalized') {
    const adopted = await storage.adoptImport('cache', completeRelative, ids.datasetId, { expectedFingerprint: retainedDiscovered.sourceFingerprint, maxFiles: config.uploadMaxFiles || 100000, onProgress: (value) => progress(0.7 + value * 0.15) });
    const adoptedFiles=adopted.scan.files.map((file)=>({relativePath:file.relativePath,byteSize:file.byteSize,sha256:file.sha256,metadata:file.metadata||{}})).sort((left,right)=>compareUtf8(left.relativePath,right.relativePath));if(JSON.stringify(adoptedFiles.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})))!==JSON.stringify(retainedManifest.files.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256}))))throw Object.assign(new Error('materialized retained manifest changed during adoption'),{code:'retained_manifest_conflict'});dataset = processing.finalizeDataset(dataset.id,adoptedFiles,manifestHash(adoptedFiles));
  }
  let task = processing.getTask(ids.taskId);
  if (!task) task = processing.createTask({ id: ids.taskId, projectId: request.projectId, datasetId: dataset.id, displayName: request.taskDisplayName, createdBy: operation.subject, metadata: { catalogImportOperationId: operation.id, webodmTaskImportOperationId: operation.id, assetKinds: summary.assetKinds } });
  const attempt = processing.createImportedAttempt({ id: ids.attemptId, taskId: task.id, datasetId: dataset.id, providerTaskId: request.externalTaskId ? `webodm:${request.externalTaskId}` : `webodm-import:${retainedDiscovered.sourceFingerprint}`, createdBy: operation.subject, displayName: request.taskDisplayName, metadata: { webodmTaskImport: true }, staged: true });
  const datasetRoot = storage.resolve('datasets', dataset.relativePath, { mustExist: true }), assets = [];
  for (const asset of retainedDiscovered.assets) {
    const entry = { ...asset, rootKey: 'datasets', relativePath: `${dataset.relativePath}/${asset.relativePath}`, storageMode: 'adopted', published: false, sourceAttemptId: attempt.id };
    if (['ept', 'tiles'].includes(asset.kind)) { const tree = await hashTree(path.dirname(path.join(datasetRoot, ...asset.relativePath.split('/')))); entry.manifestSha256 = tree.manifestSha256; entry.manifestFiles = tree.files; }
    assets.push(entry);
  }
  const odmMetadata = readOdmTaskMetadata(datasetRoot);
  const cameraPhotos = retainedManifest.cameraPhotos.map((photo) => ({ ...photo, rootKey: 'datasets', relativePath: `${dataset.relativePath}/${photo.relativePath}` }));
  const registeredAssets = assets.filter((asset) => asset.kind !== 'tiles');
  const model = repository.upsertModelVersion({ modelId: ids.modelId, versionId: ids.versionId, provider: 'webodm', providerModelId: `task-import:${operation.id}`, providerVersionId: retainedDiscovered.sourceFingerprint, displayName: request.taskDisplayName, status: 'importing', metadata: { projectName: processing.getProject(request.projectId).displayName, taskName: request.taskDisplayName, webodmTaskImportOperationId: operation.id }, versionMetadata: { webodmTaskImport: true, assetKinds: summary.assetKinds, processingMetrics: odmMetadata.processingMetrics }, georef: odmMetadata.georef, pointCount: odmMetadata.pointCount, sourceLocator: { webodmTaskImport: true, sourceRelativePath: request.sourceRelativePath }, assets: registeredAssets, cameraPhotos, makeActive: false });
  await recordImportedSourceUnits(operation, { processing, repository, storage }, model.id, ids.versionId, { signal });
  processing.setAttemptResult(attempt.id, model.id, ids.versionId);
  // Existing accounting assigns adopted/reference trees to the output and
  // excludes their source dataset from the project dataset subtotal.
  processing.registerModelOutput({ versionId: ids.versionId, modelId: model.id, taskId: task.id, attemptId: attempt.id, projectId: request.projectId, rootKey: 'datasets', relativePath: dataset.relativePath, storageMode: 'adopted', status: 'staged', byteSize: dataset.byteSize, assetCount: registeredAssets.length });
  const lodDerivatives = lodDerivativeSpecs(assets, {
    meshDerivativesEnabled: config.meshDerivativesEnabled,
    required: true,
  });
  const imported = processing.recordWebodmTaskImport({ id: operation.id, sourceFingerprint: retainedDiscovered.sourceFingerprint, sourceRelativePath: request.sourceRelativePath, projectId: request.projectId, taskId: task.id, datasetId: dataset.id, attemptId: attempt.id, modelId: model.id, modelVersionId: ids.versionId, assetKinds: summary.assetKinds, createdBy: operation.subject });
  await progress(0.98);
  return { project: processing.getProject(request.projectId), task: processing.getTask(task.id), attempt: processing.getAttempt(attempt.id), model: repository.getModelVersion(model.id, ids.versionId), import: imported, requiredDerivatives: lodDerivatives, retainedLeaseToken: retained.leaseToken, ...summary };
}

module.exports = { CAPABILITIES, capabilitySummary, copyRetainedClosure, copyTree, importWebodmTask, stageSource };
