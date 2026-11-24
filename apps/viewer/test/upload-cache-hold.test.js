'use strict';
// The upload cache of a session with a CSV or control-point source can hold the
// only copy of that source, so no path removes it. Every fixture is invented.
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
const {createProcessingApi}=require('../server/processingApi');
const {processOneDatasetOperation}=require('../server/datasetOperationWorker');
const auth=require('../server/auth');

const root=path.resolve(__dirname,'..');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
const PAST='2020-01-01T00:00:00.000Z';

function fixture(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-upload-hold-')),database=openDatabase(':memory:');
  const processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  t.after(()=>{database.close();fs.rmSync(directory,{recursive:true,force:true});});
  const storage={roots:{},resolve:(key,relative)=>path.resolve(directory,key,relative),
    requireSpace(){},sameFilesystem:()=>true,
    pathExistsStrict(key,relative){return fs.existsSync(this.resolve(key,relative));},
    moveExact(a,source,b,destination){const target=this.resolve(b,destination);fs.mkdirSync(path.dirname(target),{recursive:true});fs.renameSync(this.resolve(a,source),target);},
    async assembleFile(upload,file,chunks,relative){const target=this.resolve('datasets',`${relative}/${file.relativePath}`);fs.mkdirSync(path.dirname(target),{recursive:true});
      fs.writeFileSync(target,Buffer.concat(chunks.map(chunk=>fs.readFileSync(this.resolve('cache',`uploads/${upload.id}/${file.id}/${chunk.chunk_index}.part`)))));
      return{id:file.id,relativePath:file.relativePath,byteSize:file.byteSize,sha256:file.sha256};},
    cleanupUpload(id){fs.rmSync(this.resolve('cache',`uploads/${id}`),{recursive:true,force:true});}};
  const project=processing.createProject({displayName:'Invented uploads'});
  let next=0;
  function upload(files,{status='open',expiresAt=PAST}={}){
    const dataset=processing.createDataset({projectId:project.id,displayName:`Upload ${next}`,storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
    const specs=files.map(([relativePath,bytes,options={}],index)=>({id:options.id||`file-${index}`,relativePath,byteSize:options.byteSize??bytes.length,sha256:sha(bytes),
      processingRole:options.role||'auto'}));
    const {upload:session}=processing.createUpload({datasetId:dataset.id,subject:'invented:writer',files:specs,chunkSize:1024,expiresAt});
    const parts=specs.map((file,index)=>{const part=storage.resolve('cache',`uploads/${session.id}/${file.id}/0.part`);
      fs.mkdirSync(path.dirname(part),{recursive:true});fs.writeFileSync(part,files[index][1]);
      processing.recordChunk({uploadId:session.id,fileId:file.id,chunkIndex:0,relativePath:file.relativePath,sha256:sha(files[index][1]),byteSize:files[index][1].length});
      return{part,bytes:Buffer.from(files[index][1])};});
    const at=new Date(1_700_000_000_000+(next++)*1000).toISOString();
    database.prepare('UPDATE upload_sessions SET status=?,created_at=?,updated_at=? WHERE id=?').run(status,at,at,session.id);
    return{id:session.id,dataset,parts,specs};
  }
  const intact=value=>value.parts.every(({part,bytes})=>fs.existsSync(part)&&fs.readFileSync(part).equals(bytes));
  const gone=value=>!fs.existsSync(storage.resolve('cache',`uploads/${value.id}`));
  const pass=()=>require('../server/uploadCaches').cleanUpExpiredUploads(processing,storage);
  return{database,processing,repository,storage,upload,intact,gone,pass};
}
const SOURCES=[['points.csv','a,b\n'],['control/POINTS.CSV','a,b\n'],['marks.txt','a b\n',{role:'gcp_source'}]];
const PHOTO=['photo.jpg','invented photo'];

test('expired cleanup keeps every cache with a source and still removes the others',async t=>{
  const c=fixture(t),kept=[],removed=[];
  for(const status of ['open','expired','cancelled']){
    for(const source of SOURCES)kept.push(c.upload([source,PHOTO],{status}));
    removed.push(c.upload([PHOTO],{status}));
  }
  await c.pass();await c.pass();
  for(const value of kept)assert.ok(c.intact(value),'the whole cache stays, photos included');
  for(const value of removed)assert.ok(c.gone(value));
  for(const value of [...kept,...removed])assert.notEqual(c.processing.getUpload(value.id).status,'open','expiry is still recorded');
});

test('a partial, oversized or oddly named source is kept the same way',async t=>{
  const c=fixture(t),values=[
    c.upload([['partial.csv','a,',{byteSize:4096}],PHOTO]),
    c.upload([['large.csv','a,',{byteSize:3*1024*1024}]]),
    c.upload([['dotted.csv','a,b\n',{id:'points.v1.csv'}]]),
  ];
  await c.pass();
  for(const value of values)assert.ok(c.intact(value));
});

test('a session whose record cannot be read keeps its cache',t=>{
  const c=fixture(t),value=c.upload([PHOTO]);
  const processing=Object.create(c.processing);processing.getUpload=()=>null;
  assert.deepEqual(require('../server/uploadCaches').cleanupUploadCache(processing,c.storage,value.id),{cleaned:false});
  c.database.prepare("UPDATE upload_sessions SET expected_manifest_json='not json' WHERE id=?").run(value.id);
  assert.deepEqual(require('../server/uploadCaches').cleanupUploadCache(c.processing,c.storage,value.id),{cleaned:false});
  assert.ok(c.intact(value));
});

test('a retained cohort and sustained arrivals lose no source cache',async t=>{
  const c=fixture(t),kept=[];
  for(let index=0;index<25;index+=1)kept.push(c.upload([SOURCES[index%3],PHOTO],{status:index%2?'expired':'cancelled'}));
  for(let pass=0;pass<6;pass+=1){
    for(let index=0;index<20;index+=1)kept.push(c.upload([SOURCES[index%3]]));
    await c.pass();
    assert.ok(kept.every(c.intact));
  }
});

async function api(t,c){
  const token=crypto.randomBytes(32).toString('base64url');
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'invented:writer',permissions:['viewer.storage.purge'],expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json());app.use(createProcessingApi(c));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  return id=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/datasets/${id}`,{method:'DELETE',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}'});
}

test('deleting a dataset keeps its open upload cache when it has a source',async t=>{
  const c=fixture(t),remove=await api(t,c),future=new Date(Date.now()+3600000).toISOString();
  const kept=c.upload([SOURCES[0],PHOTO],{expiresAt:future}),removed=c.upload([PHOTO],{expiresAt:future});
  for(const value of [kept,removed])assert.equal((await remove(value.dataset.id)).status,200);
  assert.ok(c.intact(kept));assert.ok(c.gone(removed));
  assert.equal(c.processing.getUpload(kept.id).status,'cancelled');
});

for(const repeated of [false,true]){
  test(`finishing an upload keeps its cache when it has a source${repeated?', also when it is repeated':''}`,async t=>{
    const c=fixture(t),future=new Date(Date.now()+3600000).toISOString();
    const kept=c.upload([SOURCES[0],PHOTO],{expiresAt:future}),removed=c.upload([PHOTO],{expiresAt:future});
    for(const value of [kept,removed]){
      if(repeated)c.processing.finalizeDataset(value.dataset.id,value.specs.map(({relativePath,byteSize,sha256})=>({relativePath,byteSize,sha256})),sha(value.id));
      assert.ok(c.processing.createUploadFinalizeOperation(value.id,'invented:writer',null,'invented:writer'));
    }
    for(let count=0;count<2;count+=1)assert.ok(await processOneDatasetOperation({processing:c.processing,storage:c.storage,repository:c.repository},'invented-worker'));
    assert.ok(c.intact(kept));assert.ok(c.gone(removed));
    for(const value of [kept,removed]){
      assert.equal(c.processing.getDataset(value.dataset.id,true).status,'finalized');
      assert.equal(c.processing.getUpload(value.id).status,'complete');
    }
  });
}

test('no other server code removes an upload cache',()=>{
  const callers=fs.readdirSync(path.join(root,'server')).filter(name=>name.endsWith('.js')&&fs.readFileSync(path.join(root,'server',name),'utf8').includes('storage.cleanupUpload('));
  assert.deepEqual(callers,['uploadCaches.js']);
  assert.match(fs.readFileSync(path.join(root,'server/worker.js'),'utf8'),/cleanUpExpiredUploads\(processing,storage,/);
});
