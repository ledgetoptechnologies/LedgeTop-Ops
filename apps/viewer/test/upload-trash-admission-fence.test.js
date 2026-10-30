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

test('completed cleanup receipts prevent older sessions starving the queue',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-cleanup-receipts-')),databasePath=path.join(root,'fixture.sqlite');
 let db=openDatabase(databasePath);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 let p=new ProcessingRepository(db);const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 for(let i=0;i<25;i++)p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2000-01-01T00:00:00.000Z'});
 const first=p.expiredUploads().slice(0,20);assert.equal(first.length,20);
 const {cleanupExpiredUpload}=require('../server/uploadCleanup'),removed=[];
 for(const id of first)assert.equal(cleanupExpiredUpload(p,{cleanupUpload:id=>removed.push(id)},id),true);
 assert.equal(removed.length,20);
 const remaining=p.expiredUploads();assert.equal(remaining.length,5);assert.ok(remaining.every(id=>!first.includes(id)));
 assert.throws(()=>cleanupExpiredUpload(p,{cleanupUpload:()=>{throw Error('injected interruption');}},remaining[0]),/injected interruption/);
 assert.equal(p.expiredUploads().length,4,'failed cleanup temporarily yields to later work');
 assert.ok(p.expiredUploads(Date.now()+61000).includes(remaining[0]),'failed cleanup becomes retryable');
 assert.equal(p.expireUpload(remaining[1]),true);assert.ok(p.expiredUploads().includes(remaining[1]),'a claim without a cleanup receipt is retried');
 db.close();db=openDatabase(databasePath);p=new ProcessingRepository(db);
 assert.equal(p.expiredUploads().length,4,'receipts and retry state survive reopening');
});

test('twenty persistent cleanup failures do not hide later sessions',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 for(let i=0;i<25;i++)p.createUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2000-01-01T00:00:00.000Z'});
 const {cleanupExpiredUpload}=require('../server/uploadCleanup'),first=p.expiredUploads().slice(0,20);
 for(const id of first)assert.throws(()=>cleanupExpiredUpload(p,{cleanupUpload:()=>{throw Error('offline');}},id),/offline/);
 const next=p.expiredUploads().slice(0,20);assert.equal(next.length,5);assert.ok(next.every(id=>!first.includes(id)));
});

test('project and task trash fail before changing metadata when an owned CSV upload is retained',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});
 const files=[{id:'control',relativePath:'control.csv',byteSize:1,sha256:'a'.repeat(64)}];
 const upload=p.admitUpload({datasetId:dataset.id,subject:'fixture',files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'});assert.ok(upload);
 assert.equal(p.trashProject(project.id,'fixture'),null);assert.equal(p.getProject(project.id).status,'active');
 // Model a legacy inconsistent dataset with an unfinished raw upload and task.
 p.finalizeDataset(dataset.id,[{id:'image',relativePath:'photo.jpg',byteSize:1,sha256:'b'.repeat(64)}],'c'.repeat(64));
 const task=p.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'});
 assert.equal(p.trashTask(task.id,'fixture'),null);assert.equal(p.getTask(task.id).status,'draft');
});

test('an existing trash intent does not override a retained CSV upload',t=>{
 const db=openDatabase(':memory:');t.after(()=>db.close());const p=new ProcessingRepository(db);
 const project=p.createProject({displayName:'Synthetic'}),dataset=p.createDataset({projectId:project.id,displayName:'Synthetic',rootKey:'datasets',relativePath:'synthetic',storageMode:'managed'});
 const mutation=p.beginTrashMutation(dataset.id,'fixture');assert.ok(mutation);
 p.createUpload({datasetId:dataset.id,subject:'legacy',files:[{id:'csv',relativePath:'control.csv',byteSize:1,sha256:'a'.repeat(64)}],chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'});
 assert.equal(p.beginTrashMutation(dataset.id,'fixture'),null);
 const {applyStorageMutation}=require('../server/storageLifecycle');
 assert.throws(()=>applyStorageMutation(p,{pathExistsStrict:()=>{throw Error('filesystem must not be touched');}},mutation),error=>error.code==='retained_csv_upload');
});
