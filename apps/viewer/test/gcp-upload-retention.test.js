'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const express=require('express');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {GcpSourceOriginals,MAX_GCP_SOURCE_BYTES}=require('../server/gcpSourceOriginals');
const {retainUploadedGcpOriginal,cleanupUploadPreservingGcp}=require('../server/gcpUploadRetention');
const {retainDatasetGcpOriginals}=require('../server/gcpDatasetRetention');
const {createProcessingApi}=require('../server/processingApi');
const auth=require('../server/auth');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function fixture(t,{csv=true,bytes=Buffer.from([0xef,0xbb,0xbf,0xff,0,13,10,42,65])}={}){
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-upload-')),identity=fs.statSync(root,{bigint:true});
  const project=processing.createProject({displayName:'Synthetic upload retention'}),dataset=processing.createDataset({
    projectId:project.id,displayName:'Incomplete flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const file={id:'file-0',relativePath:csv?'raw/control.CSV':'image.jpg',byteSize:bytes.length,sha256:sha(bytes)};
  const other={id:'file-1',relativePath:'missing-image.jpg',byteSize:3,sha256:sha(Buffer.from('jpg'))};
  const {upload,token}=processing.createUpload({datasetId:dataset.id,subject:'synthetic:writer',files:[file,other],
    chunkSize:4,expiresAt:new Date(Date.now()+60000).toISOString()});
  const storage={cleanups:0,resolve(key,relative){assert.ok(['cache','datasets','trash'].includes(key));
    const base=key==='cache'?root:path.join(root,key),target=path.resolve(base,relative);
    assert.ok(target.startsWith(base+path.sep));return target;},
    writeChunk(id,fileId,index,body,expected){assert.equal(sha(body),expected);
      const target=this.resolve('cache',`uploads/${id}/${fileId}/${index}.part`);fs.mkdirSync(path.dirname(target),{recursive:true});
      const replayed=fs.existsSync(target);if(replayed)assert.deepEqual(fs.readFileSync(target),body);else fs.writeFileSync(target,body,{flag:'wx'});
      return{sha256:expected,byteSize:body.length,replayed};},
    cleanupUpload(id){this.cleanups++;const target=this.resolve('cache',`uploads/${id}`);fs.rmSync(target,{recursive:true,force:true});}};
  const originals=new GcpSourceOriginals(database);
  const chunk=(index)=>{const body=bytes.subarray(index*4,Math.min(bytes.length,(index+1)*4));
    const written=storage.writeChunk(upload.id,file.id,index,body,sha(body));processing.recordChunk({uploadId:upload.id,
      fileId:file.id,chunkIndex:index,relativePath:file.relativePath,...written});return body;};
  t.after(()=>{database.close();const current=fs.statSync(root,{bigint:true});assert.equal(current.dev,identity.dev);assert.equal(current.ino,identity.ino);
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'ltds-gcp-upload-'));fs.rmSync(root,{recursive:true});});
  return{database,processing,repository,root,dataset,project,file,upload,token,storage,originals,bytes,chunk};
}

test('complete raw CSV is retained byte-for-byte before dataset indexing, independent of other photos',t=>{
  const c=fixture(t);c.chunk(0);assert.equal(retainUploadedGcpOriginal(c.processing,c.storage,c.upload,c.file),null);
  c.chunk(1);c.chunk(2);const saved=retainUploadedGcpOriginal(c.processing,c.storage,c.upload,c.file);
  assert.deepEqual(c.originals.get(saved.id).bytes,c.bytes);assert.equal(saved.originProjectId,c.project.id);
  assert.equal(saved.sourceFileId,null,'upload-scoped file ID is not a global dataset file ID');
  assert.equal(c.database.prepare('SELECT count(*) n FROM dataset_files').get().n,0);
  assert.equal(cleanupUploadPreservingGcp(c.processing,c.storage,c.upload.id).cleaned,true);
  assert.equal(c.storage.cleanups,1);c.database.prepare('DELETE FROM datasets WHERE id=?').run(c.dataset.id);
  assert.deepEqual(c.originals.get(saved.id).bytes,c.bytes,'original outlives incomplete dataset deletion');
});

test('partial or unindexed CSV chunks are preserved without pretending they are originals',t=>{
  const c=fixture(t);c.chunk(0);
  c.database.prepare('DELETE FROM upload_chunks WHERE upload_id=?').run(c.upload.id);
  const result=cleanupUploadPreservingGcp(c.processing,c.storage,c.upload.id);
  assert.equal(result.cleaned,false);assert.deepEqual(result.incomplete,[c.file.id]);assert.equal(c.storage.cleanups,0);
  assert.equal(c.originals.list(c.dataset.id).length,0);
  assert.equal(fs.existsSync(c.storage.resolve('cache',`uploads/${c.upload.id}/${c.file.id}/0.part`)),true);
});

test('oversized CSV is ignored by the bounded original store and its raw cache is kept',t=>{
  const c=fixture(t);c.upload.files[0]={...c.file,byteSize:MAX_GCP_SOURCE_BYTES+1};
  assert.equal(retainUploadedGcpOriginal(c.processing,c.storage,c.upload,c.upload.files[0]),null);
  c.database.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(c.upload.files),c.upload.id);
  assert.equal(cleanupUploadPreservingGcp(c.processing,c.storage,c.upload.id).cleaned,false);assert.equal(c.storage.cleanups,0);
});

test('tampered complete chunks stop cleanup; non-CSV uploads keep their normal cleanup',t=>{
  const c=fixture(t);for(let index=0;index<3;index++)c.chunk(index);
  fs.writeFileSync(c.storage.resolve('cache',`uploads/${c.upload.id}/${c.file.id}/0.part`),Buffer.from('oops'));
  assert.throws(()=>cleanupUploadPreservingGcp(c.processing,c.storage,c.upload.id),{code:'gcp_original_source_changed'});
  assert.equal(c.storage.cleanups,0);assert.equal(c.originals.list(c.dataset.id).length,0);
  const other=fixture(t,{csv:false});other.chunk(0);
  assert.equal(cleanupUploadPreservingGcp(other.processing,other.storage,other.upload.id).cleaned,true);
});

test('legacy missing chunk cache or chunk index recovers only exact assembled raw bytes',t=>{
  for(const indexed of [true,false]){
    const c=fixture(t);for(let index=0;index<3;index++)c.chunk(index);
    const raw=c.storage.resolve('datasets',`${c.dataset.relativePath}/${c.file.relativePath}`);
    fs.mkdirSync(path.dirname(raw),{recursive:true});fs.writeFileSync(raw,c.bytes);
    c.storage.cleanupUpload(c.upload.id);
    if(!indexed)c.database.prepare('DELETE FROM upload_chunks WHERE upload_id=?').run(c.upload.id);
    const saved=retainUploadedGcpOriginal(c.processing,c.storage,c.upload,c.file);
    assert.deepEqual(c.originals.get(saved.id).bytes,c.bytes);
  }
});

test('unindexed legacy original follows the lifecycle journal after an already-completed raw tree move',t=>{
  const c=fixture(t),tree='moved-flight',raw=c.storage.resolve('trash',`${tree}/${c.file.relativePath}`);
  fs.mkdirSync(path.dirname(raw),{recursive:true});fs.writeFileSync(raw,c.bytes);
  retainDatasetGcpOriginals(c.processing,c.storage,{entityType:'dataset',type:'trash',entityId:c.dataset.id,
    sourceRootKey:'trash',sourceRelativePath:tree,actor:'synthetic:writer'});
  const saved=c.originals.list(c.dataset.id);assert.equal(saved.length,1);
  assert.deepEqual(c.originals.get(saved[0].id).bytes,c.bytes);
});

test('oversized unindexed source blocks destructive raw-tree lifecycle instead of losing bytes',t=>{
  const c=fixture(t);c.upload.files[0]={...c.file,byteSize:MAX_GCP_SOURCE_BYTES+1};
  c.database.prepare('UPDATE upload_sessions SET expected_manifest_json=? WHERE id=?').run(JSON.stringify(c.upload.files),c.upload.id);
  assert.throws(()=>retainDatasetGcpOriginals(c.processing,c.storage,{entityType:'dataset',type:'purge',entityId:c.dataset.id,
    sourceRootKey:'datasets',sourceRelativePath:c.dataset.relativePath}),{code:'gcp_original_size_invalid'});
  assert.equal(c.storage.cleanups,0);
});

test('chunk HTTP ACK follows retention barrier and replay preserves invalid CSV bytes unchanged',async t=>{
  const c=fixture(t),writer=crypto.randomBytes(32).toString('base64url');
  c.processing.createAdminSession({tokenHash:auth.hashToken(writer),subject:'synthetic:writer',
    permissions:['viewer.datasets.write'],expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(createProcessingApi(c));
  app.use((error,req,res,next)=>res.status(500).json({code:error.code}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const send=index=>{const body=c.bytes.subarray(index*4,Math.min(c.bytes.length,(index+1)*4));return fetch(
    `http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${c.upload.id}/files/${c.file.id}/chunks/${index}`,
    {method:'PUT',headers:{authorization:`Bearer ${writer}`,'Content-Type':'application/octet-stream',
      'X-Upload-Token':c.token,'X-Chunk-SHA256':sha(body)},body});};
  assert.equal((await send(0)).status,201);assert.equal((await send(1)).status,201);
  let busy=true;
  c.processing.database={exec:c.database.exec.bind(c.database),prepare(sql){
    if(sql==='PRAGMA wal_checkpoint(FULL)'&&busy)return{get:()=>({busy:1})};return c.database.prepare(sql);}};
  assert.equal((await send(2)).status,500,'uncertain durability cannot acknowledge the final CSV chunk');
  busy=false;assert.equal((await send(2)).status,200,'same chunk resumes with durable retained bytes');
  const saved=c.originals.list(c.dataset.id);assert.equal(saved.length,1);assert.deepEqual(c.originals.get(saved[0].id).bytes,c.bytes);
  assert.equal(c.database.prepare('SELECT count(*) n FROM dataset_files').get().n,0);
});
