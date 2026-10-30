'use strict';
// Opt-in regression for the existing unsafe ordering. Keep this disabled until
// a versioned upload protocol and old-worker fencing are implemented.
const test=require('node:test'),assert=require('node:assert/strict');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('stale cleanup cannot expire a concurrently renewed upload', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2000-01-01T00:00:00.000Z'}).upload;
 assert.ok(p.expiredUploads().includes(upload.id));
 // Model an already-authorized resume completing after cleanup selected its
 // candidate but before cleanup changes state. No real token or bytes are used.
 db.prepare("UPDATE upload_sessions SET expires_at='2999-01-01T00:00:00.000Z' WHERE id=?").run(upload.id);
 p.expireUpload(upload.id);
 assert.equal(p.getUpload(upload.id).status,'open','a stale cleanup selection must not override a renewed upload');
});

test('a delayed resume cannot rotate a token after cleanup has claimed its session', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'}).upload;
 let intercepted=false;
 p.database=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const stmt=target.prepare(sql);if(!intercepted&&sql.startsWith('SELECT * FROM upload_sessions WHERE dataset_id='))return {get(...args){const row=stmt.get(...args);intercepted=true;target.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(upload.id);assert.equal(p.expireUpload(upload.id),true);return row;}};return stmt};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const result=p.resumeUpload(dataset.id,'fixture',files,'2999-12-31T00:00:00.000Z');p.database=db;
 assert.equal(intercepted,true);assert.deepEqual(result,{conflict:true});assert.equal(p.getUpload(upload.id).status,'expired');assert.equal(p.getUpload(upload.id).tokenHash,upload.tokenHash);
});

test('cleanup claim only accepts an expired open or terminal upload', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'}).upload;
 assert.equal(p.expireUpload(upload.id),false);assert.equal(p.getUpload(upload.id).status,'open');
 db.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(upload.id);
 assert.equal(p.expireUpload(upload.id),true);assert.equal(p.getUpload(upload.id).status,'expired');
});

test('photo-only resume fails if its session expires after selection', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:new Date(Date.now()+500).toISOString()}).upload;
 let intercepted=false;
 p.database=new Proxy(db,{get(target,key){if(key==='prepare')return sql=>{const stmt=target.prepare(sql);if(!intercepted&&sql.startsWith('SELECT * FROM upload_sessions WHERE dataset_id='))return {get(...args){const row=stmt.get(...args);assert.ok(row);intercepted=true;Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,650);return row;}};return stmt};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 const result=p.resumeUpload(dataset.id,'fixture',files,'2999-12-31T00:00:00.000Z');p.database=db;
 assert.equal(intercepted,true);assert.deepEqual(result,{conflict:true});assert.equal(p.getUpload(upload.id).tokenHash,upload.tokenHash);
});

test('expired CSV-containing sessions retain their existing resume policy', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'control',relativePath:'control.CSV',byteSize:1,sha256:'b'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2000-01-01T00:00:00.000Z'}).upload;
 const result=p.resumeUpload(dataset.id,'fixture',files,'2999-12-31T00:00:00.000Z');
 assert.equal(result.upload.id,upload.id);assert.equal(result.upload.expiresAt,'2999-12-31T00:00:00.000Z');assert.equal(p.verifyUploadToken(result.upload,result.token),true);
});

test('cleanup refuses CSV or uncertain manifests at the atomic claim', {skip:process.env.LTDS_UPLOAD_FENCING_REGRESSION!=='1'}, t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2000-01-01T00:00:00.000Z'}).upload;
 for(const manifest of ['{','{}','[]','[null]','[{}]','[{"relativePath":""}]','[{"relativePath":"../photo.jpg"}]','[{"relativePath":"/photo.jpg"}]','[{"relativePath":"CONTROL.CSV"}]']){
  db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(manifest,upload.id);
  assert.equal(p.uploadContainsCsv(upload.id),true,manifest);assert.equal(p.hasUnfinishedCsvUploads(dataset.id),true,manifest);assert.equal(p.expireUpload(upload.id),false,manifest);assert.equal(p.getUpload(upload.id).status,'open');
 }
 db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(files),upload.id);
 assert.equal(p.uploadContainsCsv(upload.id),false);assert.equal(p.hasUnfinishedCsvUploads(dataset.id),false);
});

test('finalize transaction requires a live matching token, complete manifest and valid replay state',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 const created=p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'}),id=created.upload.id,hash=created.upload.tokenHash;
 assert.equal(p.createUploadFinalizeOperation(id,'fixture'),null);
 assert.equal(p.createUploadFinalizeOperation(id,'other',null,null,hash),null);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,'b'.repeat(64)),null);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash),null,'missing chunk');
 p.recordChunk({uploadId:id,fileId:'photo',chunkIndex:0,relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)});
 db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run('[null]',id);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash),null,'invalid manifest');
 for(const invalid of [[files[0],files[0]],[{...files[0],id:''}],[{...files[0],relativePath:'../photo.jpg'}],[{...files[0],sha256:'invalid'}]]){
  db.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(invalid),id);
  assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash),null,'invalid persisted manifest');
 }
 db.prepare('UPDATE upload_sessions SET expected_manifest_json=?,expires_at=? WHERE id=?').run(JSON.stringify(files),'2000-01-01T00:00:00.000Z',id);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash),null,'expired');
 db.prepare('UPDATE upload_sessions SET expires_at=? WHERE id=?').run('2999-01-01T00:00:00.000Z',id);
 const operation=p.createUploadFinalizeOperation(id,'fixture',null,null,hash);assert.ok(operation);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash).id,operation.id);
 assert.equal(p.createUploadFinalizeOperation(id,'other',null,null,hash),null);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,'b'.repeat(64)),null);
 db.prepare("UPDATE upload_sessions SET status='cancelled' WHERE id=?").run(id);
 assert.equal(p.createUploadFinalizeOperation(id,'fixture',null,null,hash),null,'cancelled replay');
});
