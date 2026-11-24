'use strict';
// Upload ingestion and original retention share one file-id contract. All
// fixtures are invented.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {GcpSourceOriginals}=require('../server/gcpSourceOriginals');
const {cleanupUploadPreservingGcp,retainUploadedGcpOriginal}=require('../server/gcpUploadRetention');
const {applyStorageMutation}=require('../server/storageLifecycle');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth');

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const CSV=Buffer.from('﻿point_id,label,latitude,longitude,elevation_m\r\nA,A,10.5,20.5,30\r\n');

function fixture(t){
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-upload-ids-'));
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const storage={removed:0,
    resolve(key,relative){const base=path.join(root,key),target=path.resolve(base,relative);assert.ok(target.startsWith(base+path.sep));return target;},
    sameFilesystem:()=>true,requireSpace(){},
    pathExistsStrict(key,relative){return fs.existsSync(this.resolve(key,relative));},
    moveExact(a,source,b,destination){const target=this.resolve(b,destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(this.resolve(a,source),target);},
    removeExact(key,relative){assert.equal(key,'trash');fs.rmSync(this.resolve(key,relative),{recursive:true});this.removed+=1;},
    writeChunk(id,fileId,index,body,expected){assert.equal(sha(body),expected);
      const target=this.resolve('cache',`uploads/${id}/${fileId}/${index}.part`);fs.mkdirSync(path.dirname(target),{recursive:true});
      const replayed=fs.existsSync(target);if(!replayed)fs.writeFileSync(target,body,{flag:'wx'});
      return{sha256:expected,byteSize:body.length,replayed};},
    cleanupUpload(id){fs.rmSync(this.resolve('cache',`uploads/${id}`),{recursive:true,force:true});}};
  const project=processing.createProject({displayName:'Invented upload ids'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const raw=storage.resolve('datasets',`${dataset.relativePath}/control/points.csv`);
  // A session main already accepted, with every chunk recorded.
  function legacy(id){
    const file={id,relativePath:'control/points.csv',byteSize:CSV.length,sha256:sha(CSV)};
    const {upload}=processing.createUpload({datasetId:dataset.id,subject:'invented:writer',files:[file],chunkSize:1024,
      expiresAt:new Date(Date.now()+60000).toISOString()});
    const written=storage.writeChunk(upload.id,id,0,CSV,sha(CSV));
    processing.recordChunk({uploadId:upload.id,fileId:id,chunkIndex:0,relativePath:file.relativePath,...written});
    return {upload,file,part:storage.resolve('cache',`uploads/${upload.id}/${id}/0.part`)};
  }
  function assemble(){fs.mkdirSync(path.dirname(raw),{recursive:true});fs.writeFileSync(raw,CSV);}
  const trash=()=>applyStorageMutation(processing,storage,processing.beginTrashMutation(dataset.id,'invented:writer'));
  return {database,processing,repository,storage,dataset,raw,legacy,assemble,trash,originals:new GcpSourceOriginals(database)};
}

async function api(t,c){
  const token=crypto.randomBytes(32).toString('base64url');
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'invented:writer',
    permissions:['viewer.datasets.write'],expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();
  app.use(express.json());app.use(createProcessingApi(c));
  app.use((error,req,res,next)=>res.status(500).json({code:error.code}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`};
  return {
    create:files=>fetch(`${base}/api/v1/datasets/${c.dataset.id}/uploads`,{method:'POST',
      headers:{...headers,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({files})}),
    chunk:(upload,uploadToken,id,body)=>fetch(`${base}/api/v1/admin/uploads/${upload}/files/${encodeURIComponent(id)}/chunks/0`,{method:'PUT',
      headers:{...headers,'content-type':'application/octet-stream','x-upload-token':uploadToken,'x-chunk-sha256':sha(body)},body}),
  };
}

test('a dotted file id is accepted at upload and its CSV is kept',async t=>{
  const c=fixture(t),client=await api(t,c);
  const created=await client.create([{id:'points.v1.csv',relativePath:'control/points.csv',byteSize:CSV.length,sha256:sha(CSV)}]);
  assert.equal(created.status,201);
  const {upload,uploadToken}=await created.json();
  assert.equal((await client.chunk(upload.id,uploadToken,'points.v1.csv',CSV)).status,201);
  const kept=c.originals.list(c.dataset.id);
  assert.equal(kept.length,1);assert.deepEqual(c.originals.get(kept[0].id).bytes,CSV);
  assert.equal(cleanupUploadPreservingGcp(c.processing,c.storage,upload.id).cleaned,true);
});

test('an id made only of dots is refused at upload',async t=>{
  const c=fixture(t),client=await api(t,c);
  for(const id of ['.','..','...','','a/b','a b','x'.repeat(81)]){
    const response=await client.create([{id,relativePath:'control/points.csv',byteSize:CSV.length,sha256:sha(CSV)}]);
    assert.equal(response.status,400,JSON.stringify(id));
    assert.equal((await response.json()).code,'invalid_manifest');
  }
  for(const id of ['file-0','A_9','.hidden','a.','x'.repeat(80)])
    assert.equal((await client.create([{id,relativePath:'control/points.csv',byteSize:CSV.length,sha256:sha(CSV)}])).status,201,id);
});

test('a previously accepted dotted id recovers its original and its dataset can be deleted',t=>{
  const c=fixture(t),{upload,file}=c.legacy('points.v1.csv');c.assemble();
  assert.equal(c.trash().status,'complete');
  const kept=c.originals.list(c.dataset.id);
  assert.equal(kept.length,1);assert.deepEqual(c.originals.get(kept[0].id).bytes,CSV);
  assert.equal(retainUploadedGcpOriginal(c.processing,c.storage,upload,file).id,kept[0].id,'a replay keeps the same original');
});

test('a previously accepted dots-only id is recovered from the assembled file, not its chunk path',t=>{
  const c=fixture(t),{upload,file}=c.legacy('.');c.assemble();
  const saved=retainUploadedGcpOriginal(c.processing,c.storage,upload,file);
  assert.deepEqual(c.originals.get(saved.id).bytes,CSV);
  assert.equal(c.trash().status,'complete');
  assert.equal(c.originals.list(c.dataset.id).length,1);
});

test('a dots-only id with no assembled file is quarantined: its cache stays and the dataset is not blocked',t=>{
  for(const id of ['.','..']){
    const c=fixture(t),{upload,file,part}=c.legacy(id);
    assert.equal(retainUploadedGcpOriginal(c.processing,c.storage,upload,file),null);
    const result=cleanupUploadPreservingGcp(c.processing,c.storage,upload.id);
    assert.deepEqual(result,{cleaned:false,retained:[],incomplete:[id]});
    assert.equal(c.trash().status,'complete');
    cleanupUploadPreservingGcp(c.processing,c.storage,upload.id);
    assert.deepEqual(fs.readFileSync(part),CSV,'the only copy is still on disk');
    assert.equal(c.processing.listChunks(upload.id,id).length,1,'and its record is still there');
    assert.equal(c.originals.list(c.dataset.id).length,0,'nothing unverified is called an original');
  }
});

test('a changed assembled file still blocks deletion for an unsupported id',t=>{
  const c=fixture(t);c.legacy('.');c.assemble();
  const bytes=Buffer.from(CSV);bytes[bytes.length-4]^=1;fs.writeFileSync(c.raw,bytes);
  assert.throws(()=>c.trash(),{code:'gcp_original_source_changed'});
  assert.deepEqual(fs.readFileSync(c.raw),bytes);
});
