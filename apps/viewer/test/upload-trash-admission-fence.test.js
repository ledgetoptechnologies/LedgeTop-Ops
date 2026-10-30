'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {openDatabase}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');

test('dataset trash and upload admission serialize and preserve unfinished CSV sessions',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-admit-trash-'));
 const db1=openDatabase(path.join(root,'fixture.sqlite')),db2=openDatabase(path.join(root,'fixture.sqlite'));
 t.after(()=>{db2.close();db1.close();fs.rmSync(root,{recursive:true,force:true});});
 const a=new ProcessingRepository(db1),b=new ProcessingRepository(db2),project=a.createProject({displayName:'Synthetic'});
 const makeDataset=()=>{const id=require('node:crypto').randomUUID();return a.createDataset({projectId:project.id,displayName:id,rootKey:'datasets',relativePath:id,storageMode:'managed'});};
 const file=name=>({id:'file',relativePath:name,byteSize:1,sha256:'a'.repeat(64)});
 const input=(dataset,files)=>({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'});
 const csv=makeDataset(),csvUpload=b.admitUpload(input(csv,[file('control.csv')]));assert.ok(csvUpload);
 assert.equal(a.beginTrashMutation(csv.id,'fixture'),null);assert.equal(b.getUpload(csvUpload.upload.id).status,'open');
 db1.prepare("UPDATE upload_sessions SET status='expired',expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(csvUpload.upload.id);
 assert.equal(a.beginTrashMutation(csv.id,'fixture'),null,'expired raw CSV remains retained');
 const claimed=makeDataset(),mutation=a.beginTrashMutation(claimed.id,'fixture');assert.ok(mutation);
 assert.equal(b.admitUpload(input(claimed,[file('control.csv')])),null,'a durable trash intent fences new uploads');
 const photo=makeDataset(),photoUpload=b.admitUpload(input(photo,[file('photo.jpg')]));assert.ok(photoUpload);
 const photoTrash=a.beginTrashMutation(photo.id,'fixture');assert.ok(photoTrash);
 assert.equal(b.getUpload(photoUpload.upload.id).status,'cancelled');assert.ok(b.expiredUploads().includes(photoUpload.upload.id),'cancelled cache is eligible for crash-recoverable cleanup');
 assert.equal(b.admitUpload(input(photo,[file('photo.jpg')])),null);
});
