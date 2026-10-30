'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');

test('a lost resume race returns a conflict without creating another upload',async t=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const token='synthetic-resume-conflict-token-000000000',subject='ops:synthetic';
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 processing.resumeUpload=()=>({conflict:true});let created=false;processing.createUpload=()=>{created=true;throw Error('must not create');};
 const app=express();app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(createProcessingApi({repository,processing,storage:{sameFilesystem:()=>true,requireSpace:()=>{}}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/datasets/${dataset.id}/uploads`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({files})});
 const body=await response.json();assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.code,'upload_resume_conflict');assert.equal(created,false);
});

// This deliberately fails until chunk writes and all cleanup paths share a
// cross-process fence. It is not a release test while the protocol is disabled.
test('an already authorized chunk cannot be acknowledged after cleanup claims its upload',{skip:process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{StorageManager}=require('../server/storageManager');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-chunk-fence-'));
 const db=openDatabase(path.join(root,'viewer.sqlite')),otherDb=openDatabase(path.join(root,'viewer.sqlite'));
 const processing=new ProcessingRepository(db),cleaner=new ProcessingRepository(otherDb),repository=new ViewerRepository(db);
 const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0};
 const storage=new StorageManager(config);storage.initialize();
 const token='synthetic-chunk-fence-token-000000000000',subject='ops:synthetic',body=Buffer.from('synthetic');
 const sha=crypto.createHash('sha256').update(body).digest('hex');
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256:sha}],created=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'});
 const write=storage.writeChunk.bind(storage);storage.writeChunk=(...args)=>{otherDb.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.upload.id);assert.equal(cleaner.expireUpload(created.upload.id),true);storage.cleanupUpload(created.upload.id);return write(...args);};
 const app=express();app.use(createProcessingApi({repository,processing,storage}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));otherDb.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${created.upload.id}/files/photo/chunks/0`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-upload-token':created.token,'x-chunk-sha256':sha},body});
 assert.equal(response.ok,false,`cleanup has claimed the upload; the stale writer must not be acknowledged (HTTP ${response.status})`);
 assert.equal(processing.listChunks(created.upload.id,'photo').length,0);
});

test('a rotated upload token cannot enqueue finalization',{skip:process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},async t=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const token='synthetic-finalize-fence-token-00000000',subject='ops:synthetic';
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],created=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'});
 processing.recordChunk({uploadId:created.upload.id,fileId:'photo',chunkIndex:0,relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)});
 const enqueue=processing.createUploadFinalizeOperation.bind(processing);processing.createUploadFinalizeOperation=(...args)=>{const resumed=processing.resumeUpload(dataset.id,subject,files,'2999-12-31T00:00:00.000Z');assert.ok(resumed.token);return enqueue(...args);};
 const app=express();app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(createProcessingApi({repository,processing,storage:{}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${created.upload.id}/finalize`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({uploadToken:created.token})});
 assert.equal(response.ok,false,`a stale token must not enqueue finalization (HTTP ${response.status})`);
});
