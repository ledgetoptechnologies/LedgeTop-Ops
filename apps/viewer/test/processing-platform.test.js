'use strict';
const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const test=require('node:test');
const {openDatabase}=require('../server/database');const {ProcessingRepository}=require('../server/processingRepository');const {ViewerRepository}=require('../server/repository');const {StorageManager,hashFile,hashFileChunks,hashTree}=require('../server/storageManager');const {publishedAssetAllows,publishedAssetIntegrityAllows,safeExistingFile}=require('../server/assets');const {discoverOutputs}=require('../server/processingWorker');const {adminOutputAssetKind,publicDerivativeKind,sanitizeLogMessage}=require('../server/processingSecurity');
const {processOneDatasetOperation}=require('../server/datasetOperationWorker');
const {applyStorageMutation,reconcileStorageMutations,purgeExpiredTrash}=require('../server/storageLifecycle');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-processing-'));for(const name of['datasets','models','cache','trash','imports'])fs.mkdirSync(path.join(root,name));const db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db),storage=new StorageManager({datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0});storage.initialize();t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});return{root,db,processing,storage};}
function storedDataset(context,label='Stored',storageMode='managed'){const{root,processing}=context,project=processing.createProject({displayName:`${label} project`}),relativePath=crypto.randomUUID(),dataset=processing.createDataset({projectId:project.id,displayName:label,storageMode,rootKey:storageMode==='external_reference'?'dataset_import':'datasets',relativePath});const directory=path.join(root,storageMode==='external_reference'?'imports':'datasets',relativePath),body=Buffer.from(`${label} bytes`),sha256=crypto.createHash('sha256').update(body).digest('hex');fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'photo.jpg'),body);processing.finalizeDataset(dataset.id,[{id:crypto.randomUUID(),relativePath:'photo.jpg',byteSize:body.length,sha256}],sha256);return{dataset:processing.getDataset(dataset.id),directory,project};}
test('processing migration, keyset pagination, relationship integrity and upload resume are durable',(t)=>{const{processing}=fixture(t);for(let i=0;i<105;i++)processing.createProject({displayName:`P ${i}`,createdBy:'ops:1'});const first=processing.listProjectsPage({limit:100});assert.equal(first.items.length,100);assert.ok(first.nextCursor);assert.equal(processing.listProjectsPage({limit:100,cursor:first.nextCursor}).items.length,5);const p=first.items[0],other=first.items[1],dataset=processing.createDataset({projectId:p.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID(),createdBy:'ops:1'}),file={id:'f1',relativePath:'photo.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex')};processing.finalizeDataset(dataset.id,[file],file.sha256);assert.throws(()=>processing.createTask({projectId:other.id,datasetId:dataset.id,displayName:'wrong'}),/must match/);const expiresAt=new Date(Date.now()+3600000).toISOString(),created=processing.createUpload({datasetId:processing.createDataset({projectId:p.id,displayName:'Resume',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()}).id,files:[file],subject:'ops:1',chunkSize:16,expiresAt}),resumed=processing.resumeUpload(created.upload.datasetId,'ops:1',[file],expiresAt);assert.equal(resumed.upload.id,created.upload.id);assert.notEqual(resumed.token,created.token);assert.equal(processing.verifyUploadToken(resumed.upload,resumed.token),true);assert.equal(processing.verifyUploadToken(resumed.upload,created.token),false);});
test('admin grant redemption deadline is separate from authorization/session expiry',(t)=>{const{processing}=fixture(t),base=Date.now(),grant=processing.createAdminGrant({subject:'ops:7',permissions:['viewer.projects.read'],displayUnits:'metric',expiresAt:new Date(base+60000).toISOString(),authorizationExpiresAt:new Date(base+1800000).toISOString()}),redeemed=processing.redeemAdminGrant(grant.token,base+30000);assert.equal(redeemed.authorizationExpiresAt,new Date(base+1800000).toISOString());assert.equal(processing.redeemAdminGrant(grant.token,base+31000),null);const sessionExpiry=new Date(Math.min(Date.parse(redeemed.authorizationExpiresAt),base+30000+1800000)).toISOString();assert.ok(Date.parse(sessionExpiry)>base+60000);});
test('import previews bind exact content even when same-size rewrites preserve public timestamps',async(t)=>{const{root,storage}=fixture(t),source=path.join(root,'imports','batch');fs.mkdirSync(source);const file=path.join(source,'a.jpg');fs.writeFileSync(file,'first');const originalScan=storage.scanTree('dataset_import','batch'),originalFingerprint=await storage.treeFingerprint(originalScan),preview=await storage.previewImport('dataset_import','batch');assert.deepEqual(Object.keys(preview.files[0]).sort(),['relativePath','byteSize','mtimeMs','ctimeMs'].sort());fs.writeFileSync(file,'other');const changedScan=storage.scanTree('dataset_import','batch');changedScan.files[0].mtimeMs=originalScan.files[0].mtimeMs;changedScan.files[0].ctimeMs=originalScan.files[0].ctimeMs;assert.notEqual(await storage.treeFingerprint(changedScan),originalFingerprint,'streaming content identity detects same-size rewrites when metadata collides');const changed=await storage.previewImport('dataset_import','batch');assert.notEqual(changed.treeFingerprint,preview.treeFingerprint);await assert.rejects(storage.adoptImport('dataset_import','batch','dataset-a',{expectedFingerprint:preview.treeFingerprint}),/changed/);assert.equal(fs.existsSync(source),true);});
test('preview token persistence and operation success commit atomically',async(t)=>{const{root,db,processing,storage}=fixture(t),source=path.join(root,'imports','atomic');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'a.jpg'),'atomic');const preview=await storage.previewImport('dataset_import','atomic'),publicPreview={...preview,destinationSpace:{availableBytes:preview.destinationSpace.available,totalBytes:preview.destinationSpace.total,reserveBytes:preview.destinationSpace.reserve,requiredBytes:preview.destinationSpace.required,sufficient:preview.destinationSpace.ok}},completion={request:{rootKey:'dataset_import',relativePath:'atomic'},preview,publicPreview};const cancelled=processing.createImportPreviewOperation({request:completion.request,subject:'ops:1',sessionId:'session-1'}),cancelClaim=processing.claimDatasetOperation('cancel-owner');assert.equal(cancelClaim.id,cancelled.id);assert.equal(processing.cancelImportPreviewOperation(cancelled.id,'ops:1').status,'cancelled');assert.equal(processing.completeImportPreviewOperation(cancelled.id,'cancel-owner',completion),null);assert.equal(processing.failDatasetOperation(cancelled.id,'cancel-owner','late_failure','late'),false);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_import_previews').get().n,0);const interrupted=processing.createImportPreviewOperation({request:completion.request,subject:'ops:1',sessionId:'session-1'}),claim=processing.claimDatasetOperation('atomic-owner');assert.equal(claim.id,interrupted.id);db.exec(`CREATE TEMP TRIGGER fail_preview_completion BEFORE UPDATE OF status ON dataset_operations WHEN NEW.id='${interrupted.id}' AND NEW.status='succeeded' BEGIN SELECT RAISE(ABORT,'injected completion failure'); END`);assert.throws(()=>processing.completeImportPreviewOperation(interrupted.id,'atomic-owner',completion),/injected completion failure/);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_import_previews').get().n,0);assert.equal(processing.getDatasetOperation(interrupted.id,'ops:1').status,'leased');db.exec('DROP TRIGGER fail_preview_completion');db.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(interrupted.id);await processOneDatasetOperation({processing,storage,config:{uploadMaxFiles:100000}},'atomic-recovery');const recovered=processing.getDatasetOperation(interrupted.id,'ops:1');assert.equal(recovered.status,'succeeded');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_import_previews').get().n,1);assert.equal(processing.getImportPreview(recovered.result.previewToken,'session-1').preview.treeFingerprint,preview.treeFingerprint);});
test('leased preview cancellation aborts worker hashing without minting a token',async(t)=>{const{db,processing}=fixture(t),operation=processing.createImportPreviewOperation({request:{rootKey:'dataset_import',relativePath:'slow'},subject:'ops:1',sessionId:'session-1'});let startedResolve;const started=new Promise((resolve)=>{startedResolve=resolve;});const storage={previewImport(_root,_relative,{signal}){startedResolve();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(Object.assign(new Error('cancelled'),{code:'lease_lost'})),{once:true}));}};const keepAlive=setTimeout(()=>{},3000);t.after(()=>clearTimeout(keepAlive));const running=processOneDatasetOperation({processing,storage,config:{uploadMaxFiles:100000}},'slow-worker');await started;const cancelledAt=Date.now();assert.equal(processing.cancelImportPreviewOperation(operation.id,'ops:1').status,'cancelled');await running;clearTimeout(keepAlive);assert.ok(Date.now()-cancelledAt<3000,'leased preview cancellation is observed within the two-second heartbeat bound');assert.equal(processing.getDatasetOperation(operation.id,'ops:1').status,'cancelled');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dataset_import_previews').get().n,0);});
test('published model authorization is file-scoped and hierarchical only for EPT or tiles',(t)=>{const{root}=fixture(t),models=path.join(root,'models');fs.mkdirSync(path.join(models,'task','attempt','ept','ept-data'),{recursive:true});fs.writeFileSync(path.join(models,'task','attempt','ept','ept.json'),'{}');fs.writeFileSync(path.join(models,'task','attempt','ept','ept-data','0.bin'),'x');fs.writeFileSync(path.join(models,'task','attempt','raw.zip'),'secret');const model={status:'ready',activeVersion:{assets:[{kind:'ept',rootKey:'models',relativePath:'task/attempt/ept/ept.json',published:true},{kind:'glb',rootKey:'models',relativePath:'task/attempt/model.glb',published:true}]}};assert.equal(publishedAssetAllows(model,'models','task/attempt/ept/ept-data/0.bin'),true);assert.equal(publishedAssetAllows(model,'models','task/attempt/raw.zip'),false);assert.equal(publishedAssetAllows(model,'models','other/model.glb'),false);assert.equal(safeExistingFile(models,'task/attempt/ept/ept-data/0.bin'),path.join(models,'task','attempt','ept','ept-data','0.bin'));assert.equal(safeExistingFile(models,'missing.bin'),null);});
test('symlink escapes from a published hierarchy fail closed',(t)=>{const{root}=fixture(t),models=path.join(root,'models'),outside=path.join(root,'outside.txt'),link=path.join(models,'linked.txt');fs.writeFileSync(outside,'secret');try{fs.symlinkSync(outside,link);}catch(error){t.skip(`symlinks unavailable: ${error.code}`);return;}assert.equal(safeExistingFile(models,'linked.txt'),null);});
test('native ODM derivatives and PDF report are discovered while raw inputs stay private',(t)=>{const{root}=fixture(t),output=path.join(root,'models','result');for(const file of['entwine_pointcloud/ept.json','3d_tiles/model/tileset.json','odm_texturing/odm_textured_model_geo.glb','odm_report/report.pdf']){const target=path.join(output,...file.split('/'));fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'{}');}const discovered=discoverOutputs(output),kinds=discovered.map((x)=>x.kind),report=discovered.find((asset)=>asset.kind==='report');assert.ok(kinds.includes('ept'));assert.ok(kinds.includes('nativeTiles'));assert.ok(kinds.includes('glb'));assert.equal(report.contentType,'application/pdf');assert.equal(publicDerivativeKind('report'),false);assert.equal(adminOutputAssetKind('report'),true);assert.equal(publicDerivativeKind('pointCloud'),false);assert.equal(adminOutputAssetKind('pointCloud'),false);assert.equal(publicDerivativeKind('obj'),false);assert.equal(publicDerivativeKind('ept'),true);});
test('processing errors redact credentials, paths and multiline output',()=>{const cleaned=sanitizeLogMessage('Bearer abc.def\nC:\\secret\\file token=bad /mnt/private/model');assert.doesNotMatch(cleaned,/abc\.def|C:\\secret|\/mnt\/private|\n/);});
test('large upload finalization and server adoption run as durable pollable operations',async(t)=>{const{root,processing,storage}=fixture(t),project=processing.createProject({displayName:'Async',createdBy:'ops:1'}),body=Buffer.from('image bytes'),sha=crypto.createHash('sha256').update(body).digest('hex'),file={id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256:sha},draft=processing.createDataset({projectId:project.id,displayName:'Upload',storageMode:'managed',rootKey:'datasets',relativePath:'uploaded'}),created=processing.createUpload({datasetId:draft.id,files:[file],subject:'ops:1',chunkSize:body.length,expiresAt:new Date(Date.now()+3600000).toISOString()}),written=storage.writeChunk(created.upload.id,file.id,0,body,sha);processing.recordChunk({uploadId:created.upload.id,fileId:file.id,chunkIndex:0,relativePath:file.relativePath,...written});const operation=processing.createUploadFinalizeOperation(created.upload.id,'ops:1');assert.equal(operation.status,'queued');assert.equal(processing.getDatasetOperation(operation.id,'ops:other'),null);await processOneDatasetOperation({processing,storage},'worker-a');const complete=processing.getDatasetOperation(operation.id,'ops:1');assert.equal(complete.status,'succeeded');assert.equal(complete.result.dataset.status,'finalized');assert.equal(processing.createUploadFinalizeOperation(created.upload.id,'ops:1').id,operation.id);
  const source=path.join(root,'imports','batch');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'a.jpg'),'source image');const previewOperation=processing.createImportPreviewOperation({request:{rootKey:'dataset_import',relativePath:'batch'},subject:'ops:1',sessionId:'session-1'});assert.equal(previewOperation.type,'import_preview');await processOneDatasetOperation({processing,storage,config:{uploadMaxFiles:100000}},'worker-preview');const previewComplete=processing.getDatasetOperation(previewOperation.id,'ops:1');assert.equal(previewComplete.status,'succeeded');assert.equal(typeof previewComplete.result.previewToken,'string');assert.equal(previewComplete.result.preview.treeFingerprint.length,64);const adopt=processing.createImportAdoptOperation({previewToken:previewComplete.result.previewToken,sessionId:'session-1',subject:'ops:1',projectId:project.id,displayName:'Imported',storageMode:'adopted'});assert.equal(adopt.status,'queued');await processOneDatasetOperation({processing,storage},'worker-b');const adopted=processing.getDatasetOperation(adopt.id,'ops:1');assert.equal(adopted.status,'succeeded');assert.equal(adopted.result.dataset.status,'finalized');assert.equal(fs.existsSync(source),false);
});
test('dataset operation lease is the sole recovery authority and import promotion resumes after crashes',async(t)=>{const{root,db,processing,storage}=fixture(t),project=processing.createProject({displayName:'Recovery',createdBy:'ops:1'}),source=path.join(root,'imports','recover');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'a.jpg'),'recoverable');const previewOperation=processing.createImportPreviewOperation({request:{rootKey:'dataset_import',relativePath:'recover'},subject:'ops:1',sessionId:'session-1'}),previewClaim=processing.claimDatasetOperation('crashed-preview-worker');assert.equal(previewClaim.id,previewOperation.id);db.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(previewOperation.id);await processOneDatasetOperation({processing,storage,config:{uploadMaxFiles:100000}},'preview-recovery-worker');const previewComplete=processing.getDatasetOperation(previewOperation.id,'ops:1'),preview=previewComplete.result.preview,operation=processing.createImportAdoptOperation({previewToken:previewComplete.result.previewToken,sessionId:'session-1',subject:'ops:1',projectId:project.id,displayName:'Recovery import',storageMode:'adopted'}),claimed=processing.claimDatasetOperation('crashed-worker');assert.equal(claimed.id,operation.id);await storage.adoptImport('dataset_import','recover',operation.datasetId,{expectedFingerprint:preview.treeFingerprint});assert.equal(fs.existsSync(path.join(root,'datasets',operation.datasetId,'a.jpg')),true);db.prepare("UPDATE dataset_operations SET lease_expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(operation.id);await processOneDatasetOperation({processing,storage},'recovery-worker');assert.equal(processing.getDatasetOperation(operation.id,'ops:1').status,'succeeded');assert.equal(fs.existsSync(source),false);
  const body=Buffer.from('later'),sha=crypto.createHash('sha256').update(body).digest('hex'),draft=processing.createDataset({projectId:project.id,displayName:'Long finalize',storageMode:'managed',rootKey:'datasets',relativePath:'long-finalize'}),upload=processing.createUpload({datasetId:draft.id,files:[{id:'f',relativePath:'f.jpg',byteSize:body.length,sha256:sha}],subject:'ops:1',chunkSize:body.length,expiresAt:new Date(Date.now()+3600000).toISOString()}),finalize=processing.createUploadFinalizeOperation(upload.upload.id,'ops:1');db.prepare("UPDATE upload_sessions SET updated_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(upload.upload.id);assert.equal(processing.recoverStaleUploadFinalizations(Date.now(),1),0);assert.equal(processing.getUpload(upload.upload.id).status,'finalizing');assert.equal(processing.getDatasetOperation(finalize.id,'ops:1').status,'queued');
});
test('processing assets bind every published tree child and fail closed after same-size mutation',async(t)=>{const{root,db}=fixture(t),repository=new ViewerRepository(db),directory=path.join(root,'models','task','attempt','ept');fs.mkdirSync(path.join(directory,'ept-data'),{recursive:true});const manifest=path.join(directory,'ept.json'),child=path.join(directory,'ept-data','0.bin');fs.writeFileSync(manifest,'{}');fs.writeFileSync(child,'safe');const integrity=await hashTree(directory),model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:'task',providerVersionId:'attempt',displayName:'Bound',status:'ready',sourceLocator:{taskId:'task',attemptId:'attempt'},assets:[{kind:'ept',rootKey:'models',relativePath:'task/attempt/ept/ept.json',format:'ept',byteSize:2,sha256:await hashFile(manifest),...integrity}],makeActive:true}),asset=model.activeVersion.assets[0];assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,'task/attempt/ept/ept-data/0.bin',child),true);const extra=path.join(directory,'ept-data','extra.bin');fs.writeFileSync(extra,'safe');assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,'task/attempt/ept/ept-data/extra.bin',extra),false);fs.writeFileSync(child,'evil');assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,'task/attempt/ept/ept-data/0.bin',child),false);});
test('large immutable assets verify only requested chunks while full responses verify every chunk',async(t)=>{const{root,db}=fixture(t),repository=new ViewerRepository(db),relativePath='task/attempt/model.glb',file=path.join(root,'models',...relativePath.split('/')),chunkSize=4*1024*1024;fs.mkdirSync(path.dirname(file),{recursive:true});const body=Buffer.alloc(chunkSize*2+17);body.fill(0x11,0,chunkSize);body.fill(0x22,chunkSize,chunkSize*2);body.fill(0x33,chunkSize*2);fs.writeFileSync(file,body);const integrity=await hashFileChunks(file),model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:'chunk-task',providerVersionId:'chunk-attempt',displayName:'Chunked',status:'ready',sourceLocator:{taskId:'chunk-task',attemptId:'chunk-attempt'},assets:[{kind:'glb',rootKey:'models',relativePath,format:'glb',byteSize:body.length,...integrity}],makeActive:true}),asset=model.activeVersion.assets[0];assert.equal(repository.getModelAssetChunks(asset.id).length,3);assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,relativePath,file,`bytes=0-${chunkSize-1}`),true);const handle=fs.openSync(file,'r+');try{fs.writeSync(handle,Buffer.from([0x44]),0,1,chunkSize*2);}finally{fs.closeSync(handle);}assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,relativePath,file,`bytes=0-${chunkSize-1}`),true,'a Range request is bounded to its intersecting immutable chunk');assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,relativePath,file,`bytes=${chunkSize*2}-${body.length-1}`),false,'tampering inside the requested chunk fails closed');assert.equal(await publishedAssetIntegrityAllows(repository,model,asset,relativePath,file),false,'a full response verifies every chunk');});
test('job ownership fences state changes and derivative retries are idempotent',(t)=>{const{processing}=fixture(t),project=processing.createProject({displayName:'Fence'}),dataset=processing.createDataset({projectId:project.id,displayName:'Data',storageMode:'managed',rootKey:'datasets',relativePath:'fenced'}),empty=crypto.createHash('sha256').digest('hex');processing.finalizeDataset(dataset.id,[{relativePath:'a.jpg',byteSize:0,sha256:empty}],empty);const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),job=processing.claimJob('owner-a');assert.equal(processing.transitionAttemptForJob(job.id,'owner-b','running'),null);assert.equal(processing.transitionAttemptForJob(job.id,'owner-a','running').status,'running');const derivative=processing.enqueueDerivative(attempt.id,'ept',{source:'a'});assert.equal(processing.enqueueDerivative(attempt.id,'ept',{source:'a'}),derivative);assert.throws(()=>processing.enqueueDerivative(attempt.id,'ept',{source:'b'}),/different request/);processing.cancelAttempt(attempt.id);assert.equal(processing.transitionAttemptForJob(job.id,'owner-a','ready_for_review'),null);});
test('active dataset operations block archive and trash transitions',(t)=>{const{processing}=fixture(t),project=processing.createProject({displayName:'Guard'}),draft=processing.createDataset({projectId:project.id,displayName:'Draft',storageMode:'managed',rootKey:'datasets',relativePath:'guard'}),upload=processing.createUpload({datasetId:draft.id,files:[{id:'f',relativePath:'a.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex')}],subject:'ops:1',chunkSize:8,expiresAt:new Date(Date.now()+60000).toISOString()});processing.createUploadFinalizeOperation(upload.upload.id,'ops:1');assert.equal(processing.activeDatasetOperations(draft.id),1);assert.equal(processing.archiveDataset(draft.id),null);assert.equal(processing.trashDataset(draft.id,{actor:'ops:1'}),null);});

test('trash lifecycle journal recovers crashes before and after the filesystem effect',(t)=>{
  const context=fixture(t),{processing,storage}=context;
  const first=storedDataset(context,'Trash intent'),intent=processing.beginTrashMutation(first.dataset.id,'ops:1');
  assert.equal(intent.status,'intent');
  assert.throws(()=>applyStorageMutation(processing,storage,intent,{faultAt:'after_intent'}),{code:'fault_injected'});
  assert.equal(fs.existsSync(first.directory),true);
  assert.equal(processing.getDataset(first.dataset.id).status,'finalized');
  assert.equal(reconcileStorageMutations(processing,storage).find((row)=>row.id===intent.id).status,'complete');
  assert.equal(fs.existsSync(first.directory),false);
  assert.equal(storage.pathExists('trash',intent.destinationRelativePath),true);
  assert.equal(processing.getDataset(first.dataset.id).status,'trashed');

  const second=storedDataset(context,'Trash applied'),applied=processing.beginTrashMutation(second.dataset.id,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,applied,{faultAt:'after_fs'}),{code:'fault_injected'});
  assert.equal(processing.getStorageMutation(applied.id).status,'fs_applied');
  assert.equal(fs.existsSync(second.directory),false);
  assert.equal(processing.getDataset(second.dataset.id).status,'finalized');
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(applied.id).status,'complete');
  assert.equal(processing.getDataset(second.dataset.id).status,'trashed');

  const third=storedDataset(context,'Trash destination recovery'),destinationOnly=processing.beginTrashMutation(third.dataset.id,'ops:1');
  storage.moveExact(destinationOnly.sourceRootKey,destinationOnly.sourceRelativePath,destinationOnly.destinationRootKey,destinationOnly.destinationRelativePath);
  assert.equal(processing.getStorageMutation(destinationOnly.id).status,'intent');
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(destinationOnly.id).status,'complete');
  assert.equal(processing.getDataset(third.dataset.id).status,'trashed');
});

test('storage lifecycle conflicts fail closed and can be retried after operator repair',(t)=>{
  const context=fixture(t),{processing,storage}=context,{dataset,directory}=storedDataset(context,'Conflict'),mutation=processing.beginTrashMutation(dataset.id,'ops:1');
  const conflicting=storage.resolve(mutation.destinationRootKey,mutation.destinationRelativePath);
  fs.mkdirSync(conflicting,{recursive:true});fs.writeFileSync(path.join(conflicting,'other.txt'),'conflict');
  assert.throws(()=>applyStorageMutation(processing,storage,mutation),{code:'lifecycle_conflict'});
  assert.equal(processing.getStorageMutation(mutation.id).status,'failed');
  assert.equal(processing.getDataset(dataset.id).status,'finalized');
  assert.equal(fs.existsSync(directory),true);
  assert.equal(processing.beginTrashMutation(dataset.id,'ops:1'),null);
  fs.rmSync(conflicting,{recursive:true,force:true});
  assert.equal(processing.retryStorageMutation(mutation.id).status,'intent');
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(mutation.id).status,'complete');
  assert.equal(processing.getDataset(dataset.id).status,'trashed');
});

test('trash restore and purge recover when a process dies before recording the filesystem effect',(t)=>{
  const context=fixture(t),{processing,storage}=context,{dataset,directory}=storedDataset(context,'Filesystem boundary');
  const trashMutation=processing.beginTrashMutation(dataset.id,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,trashMutation,{faultAt:'after_filesystem'}),{code:'fault_injected'});
  assert.equal(processing.getStorageMutation(trashMutation.id).status,'intent');
  assert.equal(fs.existsSync(directory),false);
  assert.equal(storage.pathExists('trash',trashMutation.destinationRelativePath),true);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getDataset(dataset.id).status,'trashed');

  const restore=processing.beginRestoreMutation(trashMutation.trashId,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,restore,{faultAt:'after_filesystem'}),{code:'fault_injected'});
  assert.equal(processing.getStorageMutation(restore.id).status,'intent');
  assert.equal(fs.existsSync(directory),true);
  assert.equal(storage.pathExists('trash',trashMutation.destinationRelativePath),false);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getDataset(dataset.id).status,'finalized');

  const retrash=processing.beginTrashMutation(dataset.id,'ops:1');applyStorageMutation(processing,storage,retrash);
  const purge=processing.beginPurgeMutation(retrash.trashId,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,purge,{faultAt:'after_filesystem'}),{code:'fault_injected'});
  assert.equal(processing.getStorageMutation(purge.id).status,'intent');
  assert.equal(storage.pathExists('trash',retrash.destinationRelativePath),false);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(purge.id).status,'complete');
  assert.ok(processing.getTrash(retrash.trashId).permanentlyDeletedAt);
});

test('overlapping lifecycle reconcilers converge to one metadata transition',(t)=>{
  const context=fixture(t),{db,processing,storage}=context,{dataset}=storedDataset(context,'Concurrent reconciliation'),mutation=processing.beginTrashMutation(dataset.id,'ops:1'),move=storage.moveExact.bind(storage);let nested=false;
  storage.moveExact=(...args)=>{const result=move(...args);if(!nested){nested=true;applyStorageMutation(processing,storage,mutation.id);}return result;};
  const completed=applyStorageMutation(processing,storage,mutation.id);
  assert.equal(completed.status,'complete');
  assert.equal(processing.getDataset(dataset.id).status,'trashed');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_trash WHERE entity_id=? AND permanently_deleted_at IS NULL').get(dataset.id).count,1);
  assert.equal(reconcileStorageMutations(processing,storage).length,0);
});

test('restore and manual purge use the same recoverable lifecycle journal',(t)=>{
  const context=fixture(t),{processing,storage}=context,{dataset,directory}=storedDataset(context,'Restore'),trashMutation=processing.beginTrashMutation(dataset.id,'ops:1');
  applyStorageMutation(processing,storage,trashMutation);
  const trash=processing.getTrash(trashMutation.trashId),restore=processing.beginRestoreMutation(trash.id,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,restore,{faultAt:'after_fs'}),{code:'fault_injected'});
  assert.equal(processing.getDataset(dataset.id).status,'trashed');
  assert.equal(fs.existsSync(directory),true);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(restore.id).status,'complete');
  assert.equal(processing.getDataset(dataset.id).status,'finalized');

  const retrash=processing.beginTrashMutation(dataset.id,'ops:1');applyStorageMutation(processing,storage,retrash);
  const secondTrash=processing.getTrash(retrash.trashId),purge=processing.beginPurgeMutation(secondTrash.id,'ops:1');
  assert.throws(()=>applyStorageMutation(processing,storage,purge,{faultAt:'after_intent'}),{code:'fault_injected'});
  assert.equal(storage.pathExists('trash',secondTrash.relativePath),true);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(purge.id).status,'complete');
  assert.ok(processing.getTrash(secondTrash.id).permanentlyDeletedAt);
  assert.equal(storage.pathExists('trash',secondTrash.relativePath),false);

  const absent=storedDataset(context,'Already absent purge'),absentTrashMutation=processing.beginTrashMutation(absent.dataset.id,'ops:1');
  applyStorageMutation(processing,storage,absentTrashMutation);
  const absentTrash=processing.getTrash(absentTrashMutation.trashId);storage.removeExact('trash',absentTrash.relativePath);
  const absentPurge=processing.beginPurgeMutation(absentTrash.id,'ops:1');
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(absentPurge.id).status,'complete');
});

test('empty draft trash is metadata-recoverable and retention purges use the journal',(t)=>{
  const context=fixture(t),{db,processing,storage}=context,project=processing.createProject({displayName:'Draft project'}),draft=processing.createDataset({projectId:project.id,displayName:'Empty draft',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()}),trashMutation=processing.beginTrashMutation(draft.id,'ops:1');
  assert.equal(trashMutation.allowAbsentSource,true);
  applyStorageMutation(processing,storage,trashMutation);
  const trash=processing.getTrash(trashMutation.trashId);assert.equal(trash.relativePath,'');
  const restore=processing.beginRestoreMutation(trash.id,'ops:1');assert.equal(restore.allowAbsentSource,true);applyStorageMutation(processing,storage,restore);
  assert.equal(processing.getDataset(draft.id).status,'draft');

  const managed=storedDataset(context,'Retention'),managedTrashMutation=processing.beginTrashMutation(managed.dataset.id,'system');applyStorageMutation(processing,storage,managedTrashMutation);
  db.prepare("UPDATE storage_trash SET purge_after='2000-01-01T00:00:00.000Z' WHERE id=?").run(managedTrashMutation.trashId);
  const interruptedPurge=processing.beginPurgeMutation(managedTrashMutation.trashId,'maintenance');
  assert.throws(()=>applyStorageMutation(processing,storage,interruptedPurge,{faultAt:'after_intent'}),{code:'fault_injected'});
  const results=purgeExpiredTrash(processing,storage,{actor:'maintenance'});
  assert.equal(results.find((row)=>row.trashId===managedTrashMutation.trashId).status,'complete');
  assert.ok(processing.getTrash(managedTrashMutation.trashId).permanentlyDeletedAt);
  assert.equal(processing.getStorageMutation(processing.database.prepare("SELECT id FROM storage_mutations WHERE trash_id=? AND mutation_type='purge'").get(managedTrashMutation.trashId).id).status,'complete');
});

test('external-reference lifecycle never moves or deletes referenced bytes',(t)=>{
  const context=fixture(t),{db,processing,storage}=context,{dataset,directory}=storedDataset(context,'External','external_reference');
  assert.equal(processing.beginTrashMutation(dataset.id,'ops:1'),null);
  const firstTrash=processing.trashDataset(dataset.id,{trashRelative:'',actor:'ops:1'});
  assert.ok(firstTrash);assert.equal(fs.existsSync(directory),true);assert.equal(processing.trashDataset(dataset.id,{trashRelative:'',actor:'ops:1'}),null);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_trash WHERE entity_id=? AND permanently_deleted_at IS NULL').get(dataset.id).count,1);
  assert.equal(processing.restoreTrash(firstTrash.id).status,'finalized');assert.equal(fs.existsSync(directory),true);
  const secondTrash=processing.trashDataset(dataset.id,{trashRelative:'',actor:'ops:1'});
  db.prepare("UPDATE storage_trash SET purge_after='2000-01-01T00:00:00.000Z' WHERE id=?").run(secondTrash.id);
  const result=purgeExpiredTrash(processing,storage,{actor:'maintenance'}).find((row)=>row.trashId===secondTrash.id);
  assert.equal(result.status,'complete');assert.equal(result.externalReference,true);
  assert.equal(fs.existsSync(directory),true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM storage_mutations WHERE entity_id=?').get(dataset.id).count,0);
  assert.ok(processing.getTrash(secondTrash.id).permanentlyDeletedAt);
});

test('malformed ownership metadata and unavailable mounts cannot delete external bytes',(t)=>{
  const context=fixture(t),{root,processing,storage}=context,project=processing.createProject({displayName:'Ownership'}),relativePath=`malformed-${crypto.randomUUID()}`,directory=path.join(root,'imports',relativePath),body=Buffer.from('external bytes'),sha256=crypto.createHash('sha256').update(body).digest('hex');
  fs.mkdirSync(directory,{recursive:true});fs.writeFileSync(path.join(directory,'photo.jpg'),body);
  const malformed=processing.createDataset({projectId:project.id,displayName:'Malformed',storageMode:'managed',rootKey:'dataset_import',relativePath});
  processing.finalizeDataset(malformed.id,[{id:crypto.randomUUID(),relativePath:'photo.jpg',byteSize:body.length,sha256}],sha256);
  assert.equal(processing.beginTrashMutation(malformed.id,'ops:1'),null);
  assert.throws(()=>storage.moveExact('dataset_import',relativePath,'trash','dataset/forbidden'),{code:'external_reference'});
  assert.equal(fs.existsSync(directory),true);

  const owned=storedDataset(context,'Unavailable mount'),mutation=processing.beginTrashMutation(owned.dataset.id,'ops:1'),original=storage.pathExistsStrict;
  storage.pathExistsStrict=()=>{throw Object.assign(new Error('simulated mount outage'),{code:'lifecycle_storage_unavailable'});};
  assert.throws(()=>applyStorageMutation(processing,storage,mutation),{code:'lifecycle_storage_unavailable'});
  storage.pathExistsStrict=original.bind(storage);
  assert.equal(processing.getStorageMutation(mutation.id).status,'intent');
  assert.equal(processing.getDataset(owned.dataset.id).status,'finalized');
  assert.equal(fs.existsSync(owned.directory),true);
  reconcileStorageMutations(processing,storage);
  assert.equal(processing.getStorageMutation(mutation.id).status,'complete');
});

test('invalid absent and divergent lifecycle states fail closed without metadata transitions',(t)=>{
  const missing=fixture(t),missingDataset=storedDataset(missing,'Missing source'),missingMutation=missing.processing.beginTrashMutation(missingDataset.dataset.id,'ops:1');
  fs.rmSync(missingDataset.directory,{recursive:true,force:true});
  assert.throws(()=>applyStorageMutation(missing.processing,missing.storage,missingMutation),{code:'lifecycle_conflict'});
  assert.equal(missing.processing.getDataset(missingDataset.dataset.id).status,'finalized');

  const restoreMissing=fixture(t),restoreDataset=storedDataset(restoreMissing,'Missing restore'),trashMutation=restoreMissing.processing.beginTrashMutation(restoreDataset.dataset.id,'ops:1');
  applyStorageMutation(restoreMissing.processing,restoreMissing.storage,trashMutation);const trash=restoreMissing.processing.getTrash(trashMutation.trashId);
  restoreMissing.storage.removeExact('trash',trash.relativePath);const restore=restoreMissing.processing.beginRestoreMutation(trash.id,'ops:1');
  assert.throws(()=>applyStorageMutation(restoreMissing.processing,restoreMissing.storage,restore),{code:'lifecycle_conflict'});
  assert.equal(restoreMissing.processing.getDataset(restoreDataset.dataset.id).status,'trashed');

  const both=fixture(t),bothDataset=storedDataset(both,'Restore conflict'),bothTrashMutation=both.processing.beginTrashMutation(bothDataset.dataset.id,'ops:1');
  applyStorageMutation(both.processing,both.storage,bothTrashMutation);fs.mkdirSync(bothDataset.directory,{recursive:true});fs.writeFileSync(path.join(bothDataset.directory,'conflict.txt'),'x');
  const conflictingRestore=both.processing.beginRestoreMutation(bothTrashMutation.trashId,'ops:1');
  assert.throws(()=>applyStorageMutation(both.processing,both.storage,conflictingRestore),{code:'lifecycle_conflict'});
  assert.equal(both.processing.getDataset(bothDataset.dataset.id).status,'trashed');
  assert.equal(both.storage.pathExistsStrict('trash',bothTrashMutation.destinationRelativePath),true);

  const divergent=fixture(t),divergentDataset=storedDataset(divergent,'Divergent applied'),divergentMutation=divergent.processing.beginTrashMutation(divergentDataset.dataset.id,'ops:1');
  divergent.processing.markStorageMutationFsApplied(divergentMutation.id);
  assert.throws(()=>applyStorageMutation(divergent.processing,divergent.storage,divergentMutation.id),{code:'lifecycle_conflict'});
  assert.equal(divergent.processing.getStorageMutation(divergentMutation.id).status,'failed');
  assert.equal(divergent.processing.getDataset(divergentDataset.dataset.id).status,'finalized');
});
