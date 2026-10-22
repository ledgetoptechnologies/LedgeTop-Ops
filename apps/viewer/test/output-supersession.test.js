'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {purgeExpiredTrash,applyStorageMutation}=require('../server/storageLifecycle');
const {candidateState,contentSuperset,retireSupersededOutputs,purgeSupersededOutputs}=require('../server/outputSupersession');
const {collectRecoveryCompanions,ownedRecoveryCompanions}=require('../server/lodRecoveryCompanions');
const {recoveryPreservation}=require('../server/outputPreservation');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const linux={skip:process.platform==='win32'};

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-supersession-'));
  const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0};
  const storage=new StorageManager(config);
  if(process.platform==='win32'){for(const location of Object.values(config).filter(value=>typeof value==='string'))fs.mkdirSync(location,{recursive:true});}
  else storage.initialize();
  const database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Supersession'}),dataset=processing.createDataset({projectId:project.id,displayName:'Retained originals',storageMode:'managed',rootKey:'datasets',relativePath:'retained-originals'});
  processing.finalizeDataset(dataset.id,[],digest('empty'));
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'One task'});
  const create=(name,active)=>{
    const attempt=processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:name,createdBy:'test',staged:false});
    const relativePath=`${task.id}/${attempt.id}`,versionId=crypto.randomUUID();
    fs.mkdirSync(storage.resolve('models',relativePath),{recursive:true});fs.writeFileSync(storage.resolve('models',`${relativePath}/model.glb`),'same original');
    const model=repository.upsertModelVersion({versionId,provider:'webodm',providerModelId:task.id,providerVersionId:name,displayName:name,status:'ready',makeActive:active,assets:[{kind:'glb',rootKey:'models',relativePath:`${relativePath}/model.glb`,byteSize:13,sha256:digest('same original'),published:false}]});
    processing.setAttemptResult(attempt.id,model.id,versionId);
    processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath,byteSize:13,assetCount:1});
    return processing.getModelOutput(versionId);
  };
  const source=create('old',false),target=create('replacement',true),id=crypto.randomUUID(),time=new Date().toISOString();
  const jobId=processing.enqueueDerivative(target.attemptId,'lod_audit',{});
  database.prepare("UPDATE derivative_jobs SET status='complete',result_json=? WHERE id=?").run(JSON.stringify({verified:true}),jobId);
  const payload={lodRecovery:true,sourceOutputId:source.id,sourceVersionId:source.id,ids:{versionId:target.id,attemptId:target.attemptId,taskId:task.id,modelId:target.modelId}};
  database.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,processing_attempt_id,available_at,created_at,updated_at,completed_at) VALUES (?,'catalog_map','test',?,?,'succeeded',?,?,?,?,?)").run(id,dataset.id,JSON.stringify(payload),target.attemptId,time,time,time,time);
  return{root,storage,database,processing,repository,source,target,task,dataset,jobId,create,operation:()=>database.prepare('SELECT * FROM dataset_operations WHERE id=?').get(id)};
}

test('exact content proof rejects an original missing from replacement',()=>{
  const file={relativePath:'model.glb',byteSize:7,sha256:'a'.repeat(64)};
  assert.equal(contentSuperset({files:[file]},{files:[file]}),true);
  assert.equal(contentSuperset({files:[file]},{files:[{...file,sha256:'b'.repeat(64)}]}),false);
  assert.equal(contentSuperset({files:[]},{files:[file]}),false);
  const obj={relativePath:'a/model.obj',byteSize:7,sha256:'a'.repeat(64)},mtl={relativePath:'a/mat.mtl',byteSize:8,sha256:'b'.repeat(64)};
  assert.equal(contentSuperset({files:[obj,mtl]},{files:[{...obj,relativePath:'b/model.obj'},{...mtl,relativePath:'c/mat.mtl'}]}),false,'separate relocation breaks relative references');
  assert.equal(contentSuperset({files:[obj,mtl]},{files:[{...obj,relativePath:'copy/a/model.obj'},{...mtl,relativePath:'copy/a/mat.mtl'}]}),true,'one coherent prefix preserves the entire dependency tree');
});

test('candidate requires same-task explicit success, active replacement and completed verification',t=>{
  const c=fixture(t),state=()=>candidateState(c.processing,c.operation(),c.source.id);
  assert.equal(state().eligible,true);
  c.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(c.source.id,c.source.modelId);
  assert.equal(state().reason,'replacement_not_active');
  c.database.prepare('UPDATE models SET active_version_id=? WHERE id=?').run(c.target.id,c.source.modelId);
  c.database.prepare("UPDATE derivative_jobs SET result_json='{}' WHERE id=?").run(c.jobId);
  assert.equal(state().reason,'replacement_not_verified');
  assert.equal(candidateState(c.processing,{...c.operation(),status:'failed'},c.source.id).eligible,false);
  assert.equal(candidateState(c.processing,{...c.operation(),payload_json:'{}'},c.source.id).eligible,false);
});

test('candidate protects sessions, published assets, shared paths, pending derivatives and adopted storage',t=>{
  const c=fixture(t),state=()=>candidateState(c.processing,c.operation(),c.source.id);
  c.repository.createViewerSession({tokenHash:digest('session'),modelId:c.source.modelId,modelVersionId:c.source.id,subject:'viewer',audience:'ops',permissions:{view:true},expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal(state().reason,'source_in_use');
  c.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());
  c.database.prepare('UPDATE model_assets SET published=1 WHERE version_id=?').run(c.source.id);
  assert.equal(state().reason,'source_published');
  c.database.prepare('UPDATE model_assets SET published=0 WHERE version_id=?').run(c.source.id);
  c.database.prepare('UPDATE model_assets SET relative_path=? WHERE version_id=?').run(`${c.source.relativePath}/model.glb`,c.target.id);
  assert.equal(state().reason,'shared_asset_dependency');
  c.database.prepare('UPDATE model_assets SET relative_path=? WHERE version_id=?').run(`${c.target.relativePath}/model.glb`,c.target.id);
  c.processing.enqueueDerivative(c.source.attemptId,'ept',{optional:true});
  assert.equal(state().reason,'derivative_or_retry_dependency');
  c.database.prepare("UPDATE derivative_jobs SET status='complete' WHERE attempt_id=?").run(c.source.attemptId);
  c.database.prepare("UPDATE model_outputs SET storage_mode='adopted' WHERE id=?").run(c.source.id);
  assert.equal(state().reason,'storage_not_exclusively_managed');
});

test('atomic archive+trash intent rejects dependency changes without modifying output',t=>{
  const c=fixture(t);
  const blocked=c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{archiveInactiveReady:true,validate:()=>false});
  assert.equal(blocked,null);assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  const mutation=c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{archiveInactiveReady:true,validate:()=>candidateState(c.processing,c.operation(),c.source.id).eligible});
  assert.equal(mutation.status,'intent');assert.equal(c.processing.getModelOutput(c.source.id).status,'archived');
  assert.equal(c.processing.beginOutputTrashMutation(c.source.id,'test','ready',{validate:()=>false}),null,'existing durable intents still rerun caller validation');
  const complete=applyStorageMutation(c.processing,c.storage,mutation);
  assert.equal(complete.status,'complete');assert.equal(c.processing.getModelOutput(c.source.id).status,'trashed');
  assert.equal(c.database.prepare('SELECT active_version_id FROM models WHERE id=?').get(c.target.modelId).active_version_id,c.target.id);
});

test('verified supersession is recoverable for 7 days then purges only redundant old output',linux,async t=>{
  const c=fixture(t),result=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(result[0]?.status,'retired');
  const trash=c.processing.getTrash(result[0].trashId);
  assert.ok(new Date(trash.purgeAfter)-Date.now()>6.9*86400_000);
  assert.ok(new Date(trash.purgeAfter)-Date.now()<=7*86400_000);
  assert.equal(c.processing.getModelOutput(c.source.id).status,'trashed');
  assert.equal(fs.readFileSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`),'utf8'),'same original');
  assert.equal((await retireSupersededOutputs(c.processing,c.storage)).length,0);
  assert.equal(purgeExpiredTrash(c.processing,c.storage).length,0);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  c.database.prepare("INSERT INTO model_camera_photos(version_id,filename,root_key,relative_path,content_type,byte_size,sha256,created_at) VALUES (?,'original.jpg','models',?,'image/jpeg',13,?,?)").run(c.source.id,`${c.source.relativePath}/model.glb`,digest('same original'),new Date().toISOString());
  assert.equal(purgeExpiredTrash(c.processing,c.storage)[0].status,'deferred','generic purge cannot bypass revalidation');
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0].status,'complete');
  assert.equal(c.processing.getModelOutput(c.source.id).byteSize,0);
  assert.ok(c.processing.getAttempt(c.source.attemptId),'attempt history survives');
  assert.ok(c.processing.getDataset(c.dataset.id),'original input dataset survives');
  assert.equal(c.database.prepare('SELECT count(*) n FROM model_camera_photos WHERE version_id=?').get(c.source.id).n,0);
  assert.ok(fs.existsSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`)));
});

test('legacy manifest descendants and physical root aliases prevent automatic retirement',t=>{
  const c=fixture(t),legacyId=crypto.randomUUID();
  c.repository.upsertModelVersion({versionId:legacyId,provider:'legacy',providerModelId:'separate-model',providerVersionId:'legacy',displayName:'Legacy',status:'ready',makeActive:false,assets:[{kind:'tiles',rootKey:'models',relativePath:'legacy-tileset.json',byteSize:2,sha256:digest('{}'),published:false,manifestFiles:[{relativePath:`${c.source.relativePath}/model.glb`,byteSize:13,sha256:digest('same original')}]}]});
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
  c.database.prepare('DELETE FROM model_asset_files WHERE asset_id IN (SELECT id FROM model_assets WHERE version_id=?)').run(legacyId);
  c.database.prepare("UPDATE model_assets SET root_key='derivatives',relative_path='model.glb' WHERE version_id=?").run(legacyId);
  c.database.prepare('UPDATE model_versions SET source_locator_json=? WHERE id=?').run(JSON.stringify({legacyAssetRoots:{derivatives:c.storage.resolve('models',c.source.relativePath)}}),legacyId);
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
});

test('replacement loss blocks expired-trash purge and durable intent replay',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0],trash=c.processing.getTrash(retired.trashId);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  const pending=c.processing.beginPurgeMutation(trash.id,'storage-maintenance');
  c.database.prepare("UPDATE model_outputs SET status='trashed' WHERE id=?").run(c.target.id);
  assert.throws(()=>applyStorageMutation(c.processing,c.storage,pending),{code:'supersession_reverification_required'});
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0].status,'deferred');
  assert.ok(fs.existsSync(c.storage.resolve('trash',trash.relativePath)),'last preserved copy survives');
  assert.equal(c.processing.getStorageMutation(pending.id).status,'intent');
});

test('legacy root symlink is canonicalized before dependency exclusion',linux,t=>{
  const c=fixture(t),legacyId=crypto.randomUUID(),alias=path.join(c.root,'legacy-alias');
  fs.symlinkSync(c.storage.resolve('models',c.source.relativePath),alias,'dir');
  c.repository.upsertModelVersion({versionId:legacyId,provider:'legacy',providerModelId:'alias-model',providerVersionId:'legacy',displayName:'Alias',status:'ready',makeActive:false,sourceLocator:{legacyAssetRoots:{derivatives:alias}},assets:[{kind:'glb',rootKey:'derivatives',relativePath:'model.glb',byteSize:13,sha256:digest('same original'),published:false}]});
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'shared_asset_dependency');
});

test('explicit restore is a durable opt-out from later automatic retirement',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0];
  const restore=c.processing.beginRestoreMutation(retired.trashId,'operator');
  assert.ok(restore);applyStorageMutation(c.processing,c.storage,restore);
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'explicit_restore_preserved');
  await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  assert.ok(fs.existsSync(c.storage.resolve('models',c.source.relativePath)));
});

test('unknown original file blocks cleanup and immutable pair is not rehashed on every maintenance pass',linux,async t=>{
  const c=fixture(t);fs.writeFileSync(c.storage.resolve('models',`${c.source.relativePath}/original-photo.jpg`),'irreplaceable');
  c.database.prepare('UPDATE model_outputs SET byte_size=26 WHERE id=?').run(c.source.id);
  const first=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(first[0].reason,'content_not_fully_preserved');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  const events=c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n;
  assert.equal(events,1);
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,1);
});

test('session dependency is diagnosed once and retirement resumes after the session ends',linux,async t=>{
  const c=fixture(t);
  c.repository.createViewerSession({tokenHash:digest('wait-session'),modelId:c.source.modelId,modelVersionId:c.target.id,subject:'viewer',audience:'ops',permissions:{view:true},expiresAt:new Date(Date.now()+60000).toISOString()});
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].reason,'source_in_use');
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  c.database.prepare('UPDATE viewer_sessions SET revoked_at=?').run(new Date().toISOString());
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].status,'retired');
});

test('registered integrity mismatch blocks even when both output copies have the same altered bytes',linux,async t=>{
  const c=fixture(t);
  for(const output of [c.source,c.target])fs.writeFileSync(c.storage.resolve('models',`${output.relativePath}/model.glb`),'bad! original');
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0].reason,'registered_integrity_mismatch');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
});

test('replacement corruption during grace retains the last good copy',linux,async t=>{
  const c=fixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0],trash=c.processing.getTrash(retired.trashId);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',trash.id);
  fs.writeFileSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`),'bad! original');
  const result=await purgeSupersededOutputs(c.processing,c.storage);
  assert.equal(result[0].reason,'supersession_content_changed');
  assert.equal(fs.readFileSync(c.storage.resolve('trash',`${trash.relativePath}/model.glb`),'utf8'),'same original');
  assert.ok(Date.parse(c.processing.getTrash(trash.id).purgeAfter)>Date.now(),'failed proof receives a bounded daily retry');
});

test('bounded scan reaches eligible history beyond the newest 100 recovery operations',linux,async t=>{
  const c=fixture(t),operation=c.operation();
  c.database.prepare("UPDATE dataset_operations SET completed_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(operation.id);
  const insert=c.database.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,processing_attempt_id,available_at,created_at,updated_at,completed_at) VALUES (?,'catalog_map','test',?,?,'succeeded',?,?,?,?,?)");
  for(let index=0;index<100;index++)insert.run(crypto.randomUUID(),c.dataset.id,JSON.stringify({lodRecovery:true}),c.target.attemptId,operation.created_at,operation.created_at,operation.created_at,operation.created_at);
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.status,'retired');
});

test('pair budget resumes at companion source instead of repeatedly checking its predecessor',linux,async t=>{
  const c=fixture(t),companion=c.create('companion',false),operation=c.operation(),payload=JSON.parse(operation.payload_json);
  c.database.prepare('UPDATE processing_tasks SET active_attempt_id=? WHERE id=?').run(c.target.attemptId,c.task.id);
  payload.companionSourceOutputId=companion.id;
  c.database.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),operation.id);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.sourceOutputId,c.source.id);
  const cursor=JSON.parse(c.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_scan_cursor' ORDER BY created_at DESC,rowid DESC LIMIT 1").get().details_json);
  assert.equal(cursor.resumeSourceId,companion.id);
  const second=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(second[0]?.sourceOutputId,companion.id);assert.equal(second[0]?.status,'retired');
});

test('shutdown cancellation stops content hashing before any retirement intent',linux,async t=>{
  const c=fixture(t),controller=new AbortController(),read=fs.read;let reads=0;
  t.mock.method(fs,'read',function(...args){const callback=args.pop();return read.call(this,...args,(...result)=>{reads++;controller.abort();callback(...result);});});
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage,{signal:controller.signal}),[]);
  assert.equal(reads,1,'abort stops after the current bounded read rather than hashing the whole replacement');
  assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  assert.equal(c.database.prepare('SELECT count(*) n FROM storage_mutations').get().n,0);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,0,'normal shutdown does not impose a one-day failure cooldown');
});

test('worker shutdown aborts both supersession passes and joins maintenance before closing database',()=>{
  const worker=fs.readFileSync(path.join(__dirname,'../server/worker.js'),'utf8');
  assert.match(worker,/process\.once\(signal,\(\)=>maintenanceAbort\.abort\(\)\)/);
  for(const method of ['retireSupersededOutputs','purgeSupersededOutputs'])assert.ok(worker.includes(`${method}(processing,storage,{limit:1,signal:maintenanceAbort.signal})`));
  assert.ok(worker.includes('await maintenancePending;db.close()'));
  assert.match(worker,/async function maintenanceStep\(name,run\)\{if\(stopped\)return null/);
});

function remappedFixture(t,{mesh=true}={}){
  const c=fixture(t),sourceFiles=[],targetFiles=[];
  const write=(output,relativePath,bytes,list)=>{
    const absolute=c.storage.resolve('models',`${output.relativePath}/${relativePath}`);fs.mkdirSync(path.dirname(absolute),{recursive:true});fs.writeFileSync(absolute,bytes);
    const file={relativePath,sourceRelativePath:relativePath,byteSize:Buffer.byteLength(bytes),sha256:digest(bytes)};list.push(file);return file;
  };
  const original={relativePath:'model.glb',byteSize:13,sha256:digest('same original')};
  let meshAssets=[];
  if(mesh){
    sourceFiles.push(original);targetFiles.push(original);
    for(const [relative,bytes] of [['model.obj','mtllib material.mtl\nv 0 0 0\n'],['material.mtl','newmtl wall\nmap_Kd textures/wall.jpg\n'],['textures/wall.jpg','mesh texture']]){
      write(c.source,relative,bytes,sourceFiles);write(c.target,relative,bytes,targetFiles);
    }
    meshAssets=sourceFiles.filter(file=>/\.(obj|glb)$/.test(file.relativePath)).map(file=>({kind:path.extname(file.relativePath).slice(1),rootKey:'models',relativePath:`${c.source.relativePath}/${file.relativePath}`,byteSize:file.byteSize,sha256:file.sha256,published:false}));
  }else{
    fs.unlinkSync(c.storage.resolve('models',`${c.source.relativePath}/model.glb`));fs.unlinkSync(c.storage.resolve('models',`${c.target.relativePath}/model.glb`));
  }
  const shots=write(c.source,'camera/shots.geojson','{}',sourceFiles),photo=write(c.source,'images/DJI_0001.jpg','original photo bytes',sourceFiles);
  const ept=write(c.source,'cloud/ept.json','{"dataType":"laszip"}',sourceFiles);write(c.source,'cloud/ept-data/0-0-0-0.laz','point bytes',sourceFiles);
  const members=sourceFiles.filter(file=>file.relativePath.startsWith('cloud/')).map(file=>({relativePath:file.relativePath.slice(6),byteSize:file.byteSize,sha256:file.sha256})).sort((a,b)=>a.relativePath.localeCompare(b.relativePath));
  const assets=[...meshAssets,{kind:'shots',rootKey:'models',relativePath:`${c.source.relativePath}/${shots.relativePath}`,byteSize:shots.byteSize,sha256:shots.sha256,published:false},{kind:'ept',rootKey:'models',relativePath:`${c.source.relativePath}/${ept.relativePath}`,byteSize:ept.byteSize,sha256:ept.sha256,manifestSha256:digest(JSON.stringify(members)),manifestFiles:members,published:false}];
  const cameraPhotos=[{filename:'DJI_0001.jpg',rootKey:'models',relativePath:`${c.source.relativePath}/${photo.relativePath}`,contentType:'image/jpeg',byteSize:photo.byteSize,sha256:photo.sha256}];
  c.repository.upsertModelVersion({modelId:c.source.modelId,versionId:c.source.id,provider:'webodm',providerModelId:c.task.id,providerVersionId:'old',displayName:'old',status:'ready',makeActive:false,assets,cameraPhotos});
  const plan=collectRecoveryCompanions(c.database,c.source.id),owned=ownedRecoveryCompanions(plan,c.target.relativePath,c.target.attemptId);
  for(const file of plan.files){const bytes=fs.readFileSync(c.storage.resolve(file.rootKey,file.sourceRelativePath));write(c.target,file.relativePath,bytes,targetFiles);}
  const targetMesh=meshAssets.map(asset=>({...asset,relativePath:asset.relativePath.replace(`${c.source.relativePath}/`,`${c.target.relativePath}/`)}));
  c.repository.upsertModelVersion({modelId:c.target.modelId,versionId:c.target.id,provider:'webodm',providerModelId:c.task.id,providerVersionId:'replacement',displayName:'replacement',status:'ready',makeActive:true,assets:[...targetMesh,...owned.assets],cameraPhotos:owned.cameraPhotos});
  for(const [output,files] of [[c.source,sourceFiles],[c.target,targetFiles]])c.database.prepare('UPDATE model_outputs SET byte_size=? WHERE id=?').run(files.reduce((sum,file)=>sum+file.byteSize,0),output.id);
  const payload={...JSON.parse(c.operation().payload_json),targetRelativePath:c.target.relativePath,companions:plan};
  c.database.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),c.operation().id);
  return{...c,payload,sourceFiles,targetFiles,sourceProof:{files:sourceFiles},targetProof:{files:targetFiles}};
}

test('trusted per-product recovery maps photos and a complete EPT tree without basename guessing',async t=>{
  const c=remappedFixture(t,{mesh:false});
  assert.equal(contentSuperset(c.sourceProof,c.targetProof),false);
  const proof=await recoveryPreservation(c.database,c.payload,c.source,c.target,c.sourceProof,c.targetProof,'unused');
  assert.equal(proof.preserved,true);assert.equal(proof.method,'registered_recovery_groups');assert.match(proof.preservationSha256,/^[a-f0-9]{64}$/);
  assert.equal(proof.details.preservedFileCount,4);
});

test('recovery proof refuses an unbound plan, unknown originals, changed bytes and relocated dependencies',async t=>{
  const c=remappedFixture(t,{mesh:false}),check=(payload=c.payload,source=c.sourceProof,target=c.targetProof)=>recoveryPreservation(c.database,payload,c.source,c.target,source,target,'unused');
  assert.equal((await check({...c.payload,targetRelativePath:'wrong'})).details.proofFailureReason,'recovery_destination_unbound');
  assert.equal((await check({...c.payload,companions:{...c.payload.companions,manifestSha256:'a'.repeat(64)}})).details.proofFailureReason,'recovery_companion_manifest_changed');
  const unknown={relativePath:'private-original.bin',byteSize:123,sha256:'a'.repeat(64)};
  const missing=await check(c.payload,{files:[...c.sourceFiles,unknown]});assert.equal(missing.details.proofFailureReason,'unmapped_source_files');assert.equal(missing.details.unmappedByteSize,123);
  const changed={files:c.targetFiles.map(file=>file.relativePath.endsWith('.laz')?{...file,sha256:'b'.repeat(64)}:file)};
  assert.equal((await check(c.payload,c.sourceProof,changed)).details.proofFailureReason,'recovery_mapped_file_changed');
  const moved={files:c.targetFiles.map(file=>file.relativePath.endsWith('.laz')?{...file,relativePath:'elsewhere/0-0-0-0.laz'}:file)};
  assert.equal((await check(c.payload,c.sourceProof,moved)).details.proofFailureReason,'recovery_mapped_file_changed');
  c.database.prepare("DELETE FROM model_camera_photos WHERE version_id=?").run(c.target.id);
  assert.equal((await check()).details.proofFailureReason,'recovery_photo_registration_changed');
});

test('remapped recovery plus secure mesh closure retires and purges with a bound group proof',linux,async t=>{
  const c=remappedFixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0];assert.equal(retired?.status,'retired');
  const proof=JSON.parse(c.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_proved'").get().details_json);
  assert.equal(proof.preservationMethod,'registered_recovery_groups');assert.equal(proof.policyRevision,2);
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',retired.trashId);
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0]?.status,'complete');
  assert.ok(fs.existsSync(c.storage.resolve('models',`${c.target.relativePath}/recovery-companions/camera-photos/DJI_0001.jpg`)));
});

test('missing raw mesh dependency blocks even when registered assets still match',linux,async t=>{
  const c=remappedFixture(t);
  fs.unlinkSync(c.storage.resolve('models',`${c.target.relativePath}/textures/wall.jpg`));
  c.database.prepare('UPDATE model_outputs SET byte_size=byte_size-? WHERE id=?').run(Buffer.byteLength('mesh texture'),c.target.id);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.reason,'content_not_fully_preserved');
  const detail=JSON.parse(c.database.prepare("SELECT details_json FROM audit_events WHERE action='output.supersession_evaluated'").get().details_json);
  assert.equal(detail.proofFailureReason,'mesh_dependency_not_preserved');assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
});

test('remapped proof is rechecked at purge and owner restore remains a permanent opt-out',linux,async t=>{
  const c=remappedFixture(t),retired=(await retireSupersededOutputs(c.processing,c.storage))[0];
  c.database.prepare('UPDATE storage_trash SET purge_after=? WHERE id=?').run('2000-01-01T00:00:00.000Z',retired.trashId);
  const payload=JSON.parse(c.operation().payload_json);payload.companions.manifestSha256='a'.repeat(64);
  c.database.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(JSON.stringify(payload),c.operation().id);
  assert.equal((await purgeSupersededOutputs(c.processing,c.storage))[0]?.reason,'supersession_content_changed');
  const restore=c.processing.beginRestoreMutation(retired.trashId,'operator');assert.ok(restore);applyStorageMutation(c.processing,c.storage,restore);
  assert.equal(candidateState(c.processing,c.operation(),c.source.id,{storage:c.storage}).reason,'explicit_restore_preserved');
});

test('new proof policy reevaluates previously blocked immutable pairs',linux,async t=>{
  const c=remappedFixture(t),payload=JSON.parse(c.operation().payload_json),source=c.processing.getModelOutput(c.source.id),target=c.processing.getModelOutput(c.target.id);
  const oldFingerprint=digest(JSON.stringify({revision:1,operation:c.operation().id,payload,source:[source.id,source.updatedAt,source.byteSize,source.assetCount],target:[target.id,target.updatedAt,target.byteSize,target.assetCount]}));
  c.processing.insertAudit({actorType:'system',action:'output.supersession_evaluated',entityType:'model_output',entityId:source.id,details:{fingerprint:oldFingerprint,reason:'content_not_fully_preserved'}});
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.status,'retired');
});

test('active imports defer expensive retirement and purge without cooldown or mutations',async t=>{
  const c=fixture(t);t.mock.method(c.processing,'workerWorkCounts',()=>({datasetOperations:1,processing:0,derivatives:0,events:0,importCleanups:0}));
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);assert.deepEqual(await purgeSupersededOutputs(c.processing,c.storage),[]);
  assert.equal(c.database.prepare('SELECT count(*) n FROM storage_mutations').get().n,0);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,0);
});

test('unregistered metadata still blocks remapped retirement even with a same-name copy',linux,async t=>{
  const c=remappedFixture(t);
  for(const output of [c.source,c.target]){
    fs.writeFileSync(c.storage.resolve('models',`${output.relativePath}/custom-metadata.json`),'{}');
    c.database.prepare('UPDATE model_outputs SET byte_size=byte_size+2 WHERE id=?').run(output.id);
  }
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.reason,'content_not_fully_preserved');
  const event=c.database.prepare("SELECT message,details_json FROM processing_events WHERE event_type='output.supersession_evaluated'").get();
  const detail=JSON.parse(event.details_json);assert.equal(detail.proofFailureReason,'unmapped_source_files');assert.equal(detail.unmappedFileCount,1);assert.equal(detail.unmappedByteSize,2);
  assert.match(event.message,/1 files \(2 bytes\)/);
});

test('EPT referenced descendant cannot be omitted from the authorized group',async t=>{
  const c=remappedFixture(t,{mesh:false}),plan=structuredClone(c.payload.companions);
  plan.files=plan.files.filter(file=>!file.relativePath.endsWith('.laz'));
  const proof=await recoveryPreservation(c.database,{...c.payload,companions:plan},c.source,c.target,c.sourceProof,c.targetProof,'unused');
  assert.equal(proof.preserved,false);assert.equal(proof.details.proofFailureReason,'recovery_companion_manifest_changed');
});

test('bytes on disk are insufficient when a target EPT descendant is no longer registered',async t=>{
  const c=remappedFixture(t,{mesh:false});
  c.database.prepare("DELETE FROM model_asset_files WHERE asset_id IN (SELECT id FROM model_assets WHERE version_id=? AND kind='ept') AND relative_path LIKE '%.laz'").run(c.target.id);
  const proof=await recoveryPreservation(c.database,c.payload,c.source,c.target,c.sourceProof,c.targetProof,'unused');
  assert.equal(proof.preserved,false);assert.equal(proof.details.proofFailureReason,'recovery_product_registration_changed');
});

test('maintenance cooperatively stops when another import starts during hashing',linux,async t=>{
  const c=fixture(t),read=fs.read;let reads=0,busy=false,clock=Date.now();
  t.mock.method(Date,'now',()=>clock);
  t.mock.method(c.processing,'workerWorkCounts',()=>({datasetOperations:busy?1:0}));
  t.mock.method(fs,'read',function(...args){const callback=args.pop();return read.call(this,...args,(...result)=>{reads++;busy=true;clock+=300;callback(...result);});});
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[]);assert.equal(reads,1);
  assert.equal(c.database.prepare('SELECT count(*) n FROM storage_mutations').get().n,0);
  assert.equal(c.database.prepare("SELECT count(*) n FROM audit_events WHERE action='output.supersession_evaluated'").get().n,0);
});

test('daily deferred verification retries create separate bounded diagnostic events',linux,async t=>{
  const c=fixture(t);t.mock.method(fs,'read',(...args)=>args.at(-1)(Object.assign(new Error('temporary test failure'),{code:'EIO'})));
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.status,'deferred');
  assert.deepEqual(await retireSupersededOutputs(c.processing,c.storage),[],'same-day retry is suppressed');
  const previous=c.database.prepare("SELECT id,details_json FROM audit_events WHERE action='output.supersession_evaluated'").get(),details=JSON.parse(previous.details_json);
  details.retryAfter='2000-01-01T00:00:00.000Z';c.database.prepare('UPDATE audit_events SET details_json=? WHERE id=?').run(JSON.stringify(details),previous.id);
  assert.equal((await retireSupersededOutputs(c.processing,c.storage))[0]?.status,'deferred','a later evaluation does not conflict with an earlier event identity');
  assert.equal(c.database.prepare("SELECT count(*) n FROM processing_events WHERE event_type='output.supersession_evaluated'").get().n,2);
});

test('changed replacement registry between hash proof and durable intent blocks retirement',linux,async t=>{
  const c=remappedFixture(t),begin=c.processing.beginOutputTrashMutation.bind(c.processing);
  t.mock.method(c.processing,'beginOutputTrashMutation',(...args)=>{
    c.database.prepare('DELETE FROM model_camera_photos WHERE version_id=?').run(c.target.id);
    return begin(...args);
  });
  const result=await retireSupersededOutputs(c.processing,c.storage);
  assert.equal(result[0]?.reason,'dependency_changed');assert.equal(c.processing.getModelOutput(c.source.id).status,'ready');
  assert.equal(c.database.prepare('SELECT count(*) n FROM storage_mutations').get().n,0);
});
