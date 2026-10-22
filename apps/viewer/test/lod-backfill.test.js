'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {lodReconciliationFailure,reconcileMissingLodDerivatives,reconcileMissingPointCloudAssets}=require('../server/lodBackfill');
const {LOD_DERIVATIVE_RECOVERY_REVISION}=require('../server/lodRecoveryPolicy');
const {createProcessingApi}=require('../server/processingApi');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');
const {toViewerConfig}=require('../server/apiV1');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-lod-backfill-'));
  for(const name of['datasets','models','cache','trash','imports'])fs.mkdirSync(path.join(root,name));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(db);
  const repository=new ViewerRepository(db);
  const storage=new StorageManager({datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0});
  storage.initialize();
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  return{root,db,processing,repository,storage};
}

function readyModel(c,{assets=['glb','obj']}={}){
  const project=c.processing.createProject({displayName:`LOD ${crypto.randomUUID()}`});
  const dataset=c.processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  c.processing.finalizeDataset(dataset.id,[],'a'.repeat(64));
  const task=c.processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Legacy model'});
  const attempt=c.processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:'legacy',createdBy:'ops:test',staged:false});
  const model=c.repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,displayName:task.displayName,status:'ready',assets:assets.map(kind=>({kind,rootKey:'datasets',relativePath:`legacy/model.${kind==='obj'?'obj':'glb'}`,sha256:'b'.repeat(64),published:false})),makeActive:false});
  const versionId=c.db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  c.processing.setAttemptResult(attempt.id,model.id,versionId);
  c.processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:`${task.id}/${attempt.id}`,status:'ready',byteSize:1,assetCount:assets.length});
  return{project,task,attempt:c.processing.getAttempt(attempt.id),model,versionId};
}

function publishModel(c,item){
  c.db.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(item.versionId);
  c.db.prepare("UPDATE processing_attempts SET status='published' WHERE id=?").run(item.attempt.id);
  c.db.prepare("UPDATE processing_tasks SET status='published',published_model_id=? WHERE id=?").run(item.model.id,item.task.id);
  c.db.prepare("UPDATE models SET active_version_id=?,status='ready' WHERE id=?").run(item.versionId,item.model.id);
  c.db.prepare("UPDATE model_assets SET published=1 WHERE version_id=?").run(item.versionId);
  item.attempt=c.processing.getAttempt(item.attempt.id);
  return item;
}

test('legacy ready models are not backfilled in place',t=>{
  const c=fixture(t),item=readyModel(c);
  assert.deepEqual(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true,limit:20}),{scanned:0,queued:0,conflict:false});
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,0);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
  assert.equal(c.processing.getModelOutput(item.versionId).status,'ready');
  assert.equal(c.db.prepare('SELECT status FROM model_versions WHERE id=?').get(item.versionId).status,'ready');
});

test('LOD maintenance diagnostics are bounded and never echo filesystem errors',()=>{
  const message=lodReconciliationFailure(Object.assign(new Error('C:\\customers\\secret\\model.obj'),{code:'ENOENT:C:\\customers\\secret'}));
  assert.equal(message,`LOD reconciliation failed: revision=${LOD_DERIVATIVE_RECOVERY_REVISION} code=maintenance_error retry=next-maintenance`);
  assert.equal(lodReconciliationFailure({code:'SQLITE_BUSY'}),`LOD reconciliation failed: revision=${LOD_DERIVATIVE_RECOVERY_REVISION} code=SQLITE_BUSY retry=next-maintenance`);
  assert.equal(message.includes('model.obj'),false);
  assert.ok(message.length<180);
});

test('derivative progress exposes only bounded lifecycle summaries while the lease is live',t=>{
  const c=fixture(t),item=readyModel(c);
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  const claimed=c.processing.claimDerivative('lod-worker');
  assert.equal(c.processing.updateDerivativeProgress(claimed.id,'lod-worker','generating'),true);
  const visible=c.processing.listDerivativeJobs(10).find(job=>job.id===claimed.id);
  assert.deepEqual({phase:visible.result.phase,summary:visible.result.summary},{phase:'generating',summary:'Generating streaming 3D tiles.'});
  assert.match(visible.result.startedAt,/^\d{4}-\d{2}-\d{2}T/);
  assert.equal(c.processing.updateDerivativeProgress(claimed.id,'lod-worker','C:\\secret\\customer.obj'),false);
  assert.equal(c.processing.updateDerivativeProgress(claimed.id,'wrong-owner','verifying'),false);
});

test('legacy WebODM EPT metadata is integrity-registered without reimporting',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','entwine_pointcloud');
  fs.mkdirSync(path.join(eptDir,'ept-data'),{recursive:true});
  fs.mkdirSync(path.join(eptDir,'ept-hierarchy'),{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));
  fs.writeFileSync(path.join(eptDir,'ept-data','0-0-0-0.laz'),'points');
  fs.writeFileSync(path.join(eptDir,'ept-hierarchy','0-0-0-0.json'),'{}');

  assert.deepEqual(await reconcileMissingPointCloudAssets(c.processing,c.storage,{limit:5}),{scanned:1,registered:1});
  const asset=c.db.prepare("SELECT id,root_key,relative_path,sha256,manifest_sha256 FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId);
  assert.equal(asset.root_key,'datasets');
  assert.equal(asset.relative_path,`${outputRelativePath}/assets/entwine_pointcloud/ept.json`);
  assert.match(asset.sha256,/^[0-9a-f]{64}$/);
  assert.match(asset.manifest_sha256,/^[0-9a-f]{64}$/);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM model_asset_files WHERE asset_id=?').get(asset.id).n,3);
  assert.ok(toViewerConfig(c.repository.getModelVersion(item.model.id,item.versionId)).assets.ept);
  assert.deepEqual(await reconcileMissingPointCloudAssets(c.processing,c.storage,{limit:5}),{scanned:0,registered:0});
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId).n,1);
});

test('legacy direct LAZ is reconciled only when EPT is absent',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  const laz=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','odm_georeferencing','odm_georeferenced_model.laz');
  fs.mkdirSync(path.dirname(laz),{recursive:true});fs.writeFileSync(laz,'direct points');
  assert.equal((await reconcileMissingPointCloudAssets(c.processing,c.storage)).registered,1);
  const asset=c.db.prepare("SELECT kind,format,sha256 FROM model_assets WHERE version_id=? AND kind='pointCloud'").get(item.versionId);
  assert.deepEqual({kind:asset.kind,format:asset.format},{kind:'pointCloud',format:'laz'});
  assert.match(asset.sha256,/^[0-9a-f]{64}$/);
  assert.deepEqual(await reconcileMissingPointCloudAssets(c.processing,c.storage),{scanned:1,registered:0},'a valid LAZ fallback is not rehashed while EPT remains absent');
});

test('legacy LAZ registration does not block discovery of the scalable WebODM EPT tree',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  c.processing.addModelAsset({versionId:item.versionId,kind:'pointCloud',rootKey:'datasets',relativePath:`${outputRelativePath}/assets/odm_georeferencing/odm_georeferenced_model.laz`,format:'laz',contentType:'application/vnd.laszip',byteSize:6,attemptId:item.attempt.id,sha256:'a'.repeat(64)});
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','entwine_pointcloud');
  fs.mkdirSync(path.join(eptDir,'ept-data'),{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));
  fs.writeFileSync(path.join(eptDir,'ept-data','0-0-0-0.laz'),'points');

  assert.deepEqual(await reconcileMissingPointCloudAssets(c.processing,c.storage),{scanned:1,registered:1});
  assert.deepEqual(c.db.prepare("SELECT kind FROM model_assets WHERE version_id=? AND kind IN ('ept','pointCloud') ORDER BY kind").all(item.versionId).map(row=>row.kind),['ept','pointCloud']);
  assert.ok(toViewerConfig(c.repository.getModelVersion(item.model.id,item.versionId)).assets.ept);
});

test('active published output repairs and publishes incomplete legacy EPT metadata',async t=>{
  const c=fixture(t),item=publishModel(c,readyModel(c)),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  c.processing.addModelAsset({versionId:item.versionId,kind:'ept',rootKey:'datasets',relativePath:`${outputRelativePath}/assets/entwine_pointcloud/ept.json`,format:'ept',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:null,published:false});
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','entwine_pointcloud');
  fs.mkdirSync(path.join(eptDir,'ept-data'),{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));
  fs.writeFileSync(path.join(eptDir,'ept-data','0-0-0-0.laz'),'points');

  assert.equal((await reconcileMissingPointCloudAssets(c.processing,c.storage)).registered,1);
  const asset=c.db.prepare("SELECT id,published,sha256,manifest_sha256 FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId);
  assert.equal(asset.published,1);
  assert.match(asset.sha256,/^[0-9a-f]{64}$/);
  assert.match(asset.manifest_sha256,/^[0-9a-f]{64}$/);
  assert.ok(c.db.prepare("SELECT 1 FROM model_asset_files WHERE asset_id=? AND relative_path='ept.json'").get(asset.id));
  assert.ok(toViewerConfig(c.repository.getModel(item.model.id)).assets.ept);
});

test('stale legacy EPT registration is replaced by the valid standard tree',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  c.processing.addModelAsset({versionId:item.versionId,kind:'ept',rootKey:'datasets',relativePath:`${outputRelativePath}/old/ept.json`,format:'ept',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64),manifestFiles:[{relativePath:'ept.json',byteSize:2,sha256:'a'.repeat(64)}]});
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'entwine_pointcloud');
  fs.mkdirSync(path.join(eptDir,'ept-hierarchy'),{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));
  fs.writeFileSync(path.join(eptDir,'ept-hierarchy','0-0-0-0.json'),'{}');

  assert.equal((await reconcileMissingPointCloudAssets(c.processing,c.storage)).registered,1);
  const asset=c.db.prepare("SELECT relative_path,manifest_sha256 FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId);
  assert.equal(asset.relative_path,`${outputRelativePath}/entwine_pointcloud/ept.json`);
  assert.notEqual(asset.manifest_sha256,'b'.repeat(64));
});

test('stale point-cloud cursor wraps and repairs a newly eligible legacy EPT in the same pass',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=? WHERE id=?").run(outputRelativePath,item.versionId);
  c.processing.advancePointCloudBackfillCursor('ffffffff-ffff-ffff-ffff-ffffffffffff',true);
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','entwine_pointcloud');
  fs.mkdirSync(eptDir,{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));

  assert.deepEqual(await reconcileMissingPointCloudAssets(c.processing,c.storage),{scanned:1,registered:1});
  assert.ok(c.db.prepare("SELECT 1 FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId));
});

test('active published legacy outputs expose integrity-registered EPT without reimporting',async t=>{
  const c=fixture(t),item=readyModel(c),outputRelativePath=`legacy/${crypto.randomUUID()}`;
  c.db.prepare("UPDATE model_outputs SET root_key='datasets',relative_path=?,status='published' WHERE id=?").run(outputRelativePath,item.versionId);
  c.db.prepare("UPDATE processing_attempts SET status='published' WHERE id=?").run(item.attempt.id);
  c.db.prepare("UPDATE models SET active_version_id=?,status='ready' WHERE id=?").run(item.versionId,item.model.id);
  c.db.prepare("UPDATE model_assets SET published=1 WHERE version_id=?").run(item.versionId);
  const eptDir=path.join(c.root,'datasets',...outputRelativePath.split('/'),'assets','entwine_pointcloud');
  fs.mkdirSync(path.join(eptDir,'ept-data'),{recursive:true});
  fs.writeFileSync(path.join(eptDir,'ept.json'),JSON.stringify({dataType:'laszip',schema:[]}));
  fs.writeFileSync(path.join(eptDir,'ept-data','0-0-0-0.laz'),'points');

  assert.equal((await reconcileMissingPointCloudAssets(c.processing,c.storage)).registered,1);
  const asset=c.db.prepare("SELECT published,manifest_sha256 FROM model_assets WHERE version_id=? AND kind='ept'").get(item.versionId);
  assert.equal(asset.published,1);
  assert.match(asset.manifest_sha256,/^[0-9a-f]{64}$/);
  assert.ok(toViewerConfig(c.repository.getModel(item.model.id)).assets.ept);
});

test('GLB-only legacy models stay on explicit full-mesh fallback',t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']});
  assert.equal(reconcileMissingLodDerivatives(c.processing,c.storage,{meshDerivativesEnabled:true}).queued,0);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,0);
  assert.equal(c.processing.getAttempt(item.attempt.id).status,'ready_for_review');
});

test('review and publish authority omit tiles whose v2 provenance is missing or not bound to the exact GLB',async t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']}),token='lod-publish-token-000000000000000000';
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:'legacy/tiles/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),manifestFiles:[{relativePath:'tileset.json',byteSize:2,sha256:'c'.repeat(64)}]});
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:{schemaVersion:2,sourceAsset:'model.glb',sourceSha256:'e'.repeat(64),tilesManifestSha256:'d'.repeat(64),geometry:'bounded-triangle-equivalence',textures:'byte-identical-material-equivalence',leafGeometricError:0,audit:{algorithm:'ltds-glb-leaf-equivalence-v2',artifactCount:2}}}),item.versionId);
  const rejectedViewer=toViewerConfig(c.repository.getModelVersion(item.model.id,item.versionId));
  assert.equal(rejectedViewer.assets.tiles,null);
  assert.equal(rejectedViewer.lodProvenanceVerified,false);
  assert.equal(c.processing.publishAttemptAtomic(item.attempt.id,['tiles'],{actorId:'ops:test'}),null);
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:publish',permissions:['viewer.processing.read','viewer.processing.publish'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const headers={authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},base=`http://127.0.0.1:${server.address().port}`;
  const review=await fetch(`${base}/api/v1/attempts/${item.attempt.id}/review-sessions`,{method:'POST',headers,body:'{}'});
  assert.equal(review.status,201);
  assert.deepEqual((await review.json()).assetKinds,['glb']);
  const publish=await fetch(`${base}/api/v1/attempts/${item.attempt.id}/publish`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:JSON.stringify({selectedAssetKinds:['tiles']})});
  assert.equal(publish.status,400);
  assert.equal((await publish.json()).code,'published_asset_unavailable');
});

test('hand-written v2 provenance remains publishable but has no server verification authority',t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']});
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:'legacy/tiles/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),manifestFiles:[{relativePath:'tileset.json',byteSize:2,sha256:'c'.repeat(64)}]});
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:{schemaVersion:2,sourceAsset:'model.glb',sourceSha256:'b'.repeat(64),tilesManifestSha256:'d'.repeat(64),geometry:'bounded-triangle-equivalence',textures:'byte-identical-material-equivalence',leafGeometricError:0,audit:{algorithm:'ltds-glb-leaf-equivalence-v2',artifactCount:2}}}),item.versionId);
  const verifiedViewer=toViewerConfig(c.repository.getModelVersion(item.model.id,item.versionId));
  assert.ok(verifiedViewer.assets.tiles);
  assert.equal(verifiedViewer.lodProvenanceVerified,false);
  assert.equal(c.processing.publishAttemptAtomic(item.attempt.id,['tiles'],{actorId:'ops:test'}),null);
  assert.ok(c.processing.publishAttemptAtomic(item.attempt.id,['glb','tiles'],{actorId:'ops:test'}));
});

test('hand-written controlled Obj2Tiles v3 provenance is publishable but has no server verification authority',t=>{
  const c=fixture(t),item=readyModel(c);
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:'legacy/tiles/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),manifestFiles:[{relativePath:'tileset.json',byteSize:2,sha256:'c'.repeat(64)}]});
  const provenance={schemaVersion:3,sourceAsset:'model.glb',sourceSha256:'b'.repeat(64),tilesManifestSha256:'d'.repeat(64),geometry:'controlled-bidirectional-surface-equivalence',textures:'controlled-atlas-material-equivalence',leafGeometricError:0,converter:{name:'OpenDroneMap/Obj2Tiles',version:'1.6.2',commandSha256:'7d82c354b3d65985e602454c0bcc204fe8e75d8efc1826b76a5681d85c34f681',inputAsset:'model.obj',inputSha256:'b'.repeat(64),binarySha256:'40adc90db9f019d1d976badc1733a5acc69d43cd1db34bf0ebc823f554188274'},audit:{algorithm:'ltds-obj2tiles-surface-equivalence-v3',sourceTriangleCount:100,leafTriangleCount:110,surfaceTolerance:0.001,maximumSurfaceDistance:0.0005,minimumNormalDot:-0.9,maximumReversedNormalFraction:0.001,equivalenceSha256:'a'.repeat(64),artifactCount:2}};
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:provenance}),item.versionId);
  const controlledViewer=toViewerConfig(c.repository.getModelVersion(item.model.id,item.versionId));
  assert.ok(controlledViewer.assets.tiles);
  assert.equal(controlledViewer.lodProvenanceVerified,false);
  assert.ok(c.processing.publishAttemptAtomic(item.attempt.id,['glb','tiles'],{actorId:'ops:test'}));

  const next=readyModel(c);
  c.processing.addModelAsset({versionId:next.versionId,kind:'tiles',rootKey:'models',relativePath:'forged/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:next.attempt.id,sha256:'c'.repeat(64),manifestSha256:'d'.repeat(64),manifestFiles:[{relativePath:'tileset.json',byteSize:2,sha256:'c'.repeat(64)}]});
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:{...provenance,converter:{...provenance.converter,version:'latest'}}}),next.versionId);
  assert.equal(toViewerConfig(c.repository.getModelVersion(next.model.id,next.versionId)).assets.tiles,null);
  assert.equal(c.processing.publishAttemptAtomic(next.attempt.id,['glb','tiles'],{actorId:'ops:test'}),null);
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:{...provenance,converter:{...provenance.converter,binarySha256:'b46d5156399774c9ba728b3d3f93c8ebf8da20dcebd5f67b5cd813aba2ec81cc'}}}),next.versionId);
  assert.equal(toViewerConfig(c.repository.getModelVersion(next.model.id,next.versionId)).assets.tiles,null);
  c.db.prepare('UPDATE model_versions SET metadata_json=? WHERE id=?').run(JSON.stringify({lodProvenance:{...provenance,converter:{...provenance.converter,inputSha256:'e'.repeat(64)}}}),next.versionId);
  assert.equal(toViewerConfig(c.repository.getModelVersion(next.model.id,next.versionId)).assets.tiles,null);
  assert.equal(c.processing.publishAttemptAtomic(next.attempt.id,['glb','tiles'],{actorId:'ops:test'}),null);
});

test('derivative list and retry API enforce read/write permissions',async t=>{
  const c=fixture(t),item=readyModel(c),readToken='lod-read-token-000000000000000000000',writeToken='lod-write-token-00000000000000000000';
  c.processing.enqueueOptionalDerivatives(item.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  const claimed=c.processing.claimDerivative('lod-worker');
  c.processing.failOptionalDerivative(claimed.id,'lod-worker','failed');
  c.processing.createAdminSession({tokenHash:auth.hashToken(readToken),subject:'ops:read',permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  c.processing.createAdminSession({tokenHash:auth.hashToken(writeToken),subject:'ops:write',permissions:['viewer.processing.read','viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers=token=>({authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()});
  assert.equal((await fetch(`${base}/api/v1/processing/derivatives`,{headers:headers(readToken)})).status,200);
  assert.equal((await fetch(`${base}/api/v1/processing/derivatives/${claimed.id}/retry`,{method:'POST',headers:headers(readToken),body:'{}'})).status,403);
  const response=await fetch(`${base}/api/v1/processing/derivatives/${claimed.id}/retry`,{method:'POST',headers:headers(writeToken),body:'{}'});
  assert.equal(response.status,409);
});

test('derivative activity paginates every historical job without duplicate cursors',async t=>{
  const c=fixture(t),first=readyModel(c),second=readyModel(c),token='lod-page-token-000000000000000000000';
  c.processing.enqueueOptionalDerivatives(first.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  c.processing.enqueueOptionalDerivatives(second.attempt.id,[{type:'mesh_tiles',request:{optional:true}}]);
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:page',permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`};
  const firstResponse=await fetch(`${base}/api/v1/processing/derivatives?limit=1`,{headers}),firstPage=await firstResponse.json();
  assert.equal(firstResponse.status,200);assert.equal(firstPage.derivatives.length,1);assert.ok(firstPage.nextCursor);
  const secondResponse=await fetch(`${base}/api/v1/processing/derivatives?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`,{headers}),secondPage=await secondResponse.json();
  assert.equal(secondResponse.status,200);assert.equal(secondPage.derivatives.length,1);assert.notEqual(secondPage.derivatives[0].id,firstPage.derivatives[0].id);
  assert.equal(secondPage.nextCursor,null);
});

test('ready output refuses manual in-place tile generation',async t=>{
  const c=fixture(t),item=readyModel(c,{assets:['glb']}),token='lod-generate-token-000000000000000000';
  c.processing.addModelAsset({versionId:item.versionId,kind:'tiles',rootKey:'models',relativePath:'legacy/native/tileset.json',format:'3dtiles',contentType:'application/json',byteSize:2,attemptId:item.attempt.id,sha256:'c'.repeat(64)});
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:generate',permissions:['viewer.processing.read','viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()};
  const listed=await fetch(`${base}/api/v1/processing/outputs`,{headers});
  assert.equal(listed.status,200);
  const recoveryReason='This model has only a GLB source; verified tile generation requires its textured OBJ companion.';
  assert.deepEqual((await listed.json()).outputs[0].lod,{status:'unavailable',canGenerate:false,reason:recoveryReason,recoveryAction:{kind:'new_version',eligible:false,sourceVersionId:item.versionId,endpoint:`/api/v1/processing/outputs/${item.versionId}/lod-recovery-attempts`,reason:recoveryReason}});
  const queued=await fetch(`${base}/api/v1/processing/outputs/${item.versionId}/derivatives/tiles`,{method:'POST',headers:{...headers,'idempotency-key':crypto.randomUUID()},body:'{}'});
  assert.equal(queued.status,409);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM derivative_jobs WHERE attempt_id=?').get(item.attempt.id).n,0);
});
