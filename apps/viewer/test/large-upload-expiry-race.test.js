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
