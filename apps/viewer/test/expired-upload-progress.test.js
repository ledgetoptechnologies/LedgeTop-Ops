'use strict';
// Expired-upload cleanup visits twenty sessions each pass. Sessions are never
// deleted, and one with an incomplete CSV keeps its cache on purpose, so
// already-visited sessions must not hide a later one. All fixtures are invented.
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpSourceOriginals}=require('../server/gcpSourceOriginals');
const {cleanupUploadPreservingGcp,retainUploadedGcpOriginal}=require('../server/gcpUploadRetention');

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const PER_PASS=20;

function fixture(t){
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database);
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-expired-uploads-'));
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const storage={resolve:(key,relative)=>path.resolve(root,key,relative),
    cleanupUpload(id){fs.rmSync(this.resolve('cache',`uploads/${id}`),{recursive:true,force:true});}};
  const project=processing.createProject({displayName:'Invented uploads'});
  let next=0;
  // `bytes` is what was uploaded; `byteSize` is what the manifest promised.
  function upload({name,bytes,byteSize=bytes.length,status='open',at=1_700_000_000_000+next*1000}){
    const dataset=processing.createDataset({projectId:project.id,displayName:`Upload ${next}`,storageMode:'managed',
      rootKey:'datasets',relativePath:crypto.randomUUID()});
    const file={id:`file-${next}`,relativePath:name,byteSize,sha256:sha(bytes)};
    const {upload:session}=processing.createUpload({datasetId:dataset.id,subject:'invented:writer',files:[file],
      chunkSize:1024,expiresAt:new Date(at).toISOString()});
    const part=storage.resolve('cache',`uploads/${session.id}/${file.id}/0.part`);
    fs.mkdirSync(path.dirname(part),{recursive:true});fs.writeFileSync(part,bytes);
    processing.recordChunk({uploadId:session.id,fileId:file.id,chunkIndex:0,relativePath:name,sha256:sha(bytes),byteSize:bytes.length});
    database.prepare('UPDATE upload_sessions SET status=?,created_at=?,updated_at=? WHERE id=?')
      .run(status,new Date(at).toISOString(),new Date(at).toISOString(),session.id);
    next+=1;
    return {id:session.id,datasetId:dataset.id,file,part,bytes,session};
  }
  // The worker's maintenance step, including its per-session error isolation.
  function pass(){
    const visited=[];
    for(const id of processing.expiredUploads().slice(0,PER_PASS)){
      visited.push(id);
      try{processing.expireUpload(id);cleanupUploadPreservingGcp(processing,storage,id);}catch{/* reported by the worker */}
    }
    return visited;
  }
  return {database,processing,storage,upload,pass,originals:new GcpSourceOriginals(database)};
}

// A partial CSV: not an original, so its cache is kept after expiry.
const keptUpload=(c,status)=>c.upload({name:'partial.csv',bytes:Buffer.from('point_id,label\n'),byteSize:4096,status});

test('a kept, expired or cancelled cohort never starves a later expired upload',t=>{
  const c=fixture(t),cohort=[];
  for(let index=0;index<PER_PASS+5;index+=1)cohort.push(keptUpload(c,index%2?'cancelled':'expired'));
  c.pass();c.pass();// the cohort has been visited
  const later=c.upload({name:'photo.jpg',bytes:Buffer.from('invented photo')});
  assert.ok(c.pass().includes(later.id),'a later upload, last used before that visit, is cleaned in the next pass');
  assert.equal(fs.existsSync(later.part),false);
  assert.equal(c.processing.getUpload(later.id).status,'expired');
  for(const kept of cohort){
    assert.deepEqual(fs.readFileSync(kept.part),kept.bytes,'a kept partial CSV is untouched');
    assert.ok(['expired','cancelled'].includes(c.processing.getUpload(kept.id).status));
  }
});

test('every already-visited session is visited again within a bounded number of passes',t=>{
  const c=fixture(t),ids=new Set();
  for(let index=0;index<PER_PASS*2+5;index+=1)ids.add(keptUpload(c,index%2?'cancelled':'expired').id);
  const visited=new Set();
  for(let count=0;count<3;count+=1)for(const id of c.pass())visited.add(id);
  assert.deepEqual([...visited].sort(),[...ids].sort());
});

test('an interrupted cancelled cleanup still completes behind a kept cohort',t=>{
  const c=fixture(t);
  for(let index=0;index<PER_PASS;index+=1)keptUpload(c,'cancelled');
  const cancelled=c.upload({name:'photo.jpg',bytes:Buffer.from('invented photo'),status:'cancelled'});
  c.pass();c.pass();
  assert.equal(fs.existsSync(cancelled.part),false);
  assert.equal(c.processing.getUpload(cancelled.id).status,'cancelled','a visit never rewrites a cancelled session');
});

test('a session whose retention keeps failing does not hold its place',t=>{
  const c=fixture(t);
  for(let index=0;index<PER_PASS;index+=1){
    const broken=c.upload({name:'broken.csv',bytes:Buffer.from('invented'),status:'expired'});
    fs.writeFileSync(broken.part,'changed!');
  }
  const later=c.upload({name:'photo.jpg',bytes:Buffer.from('invented photo'),status:'expired'});
  c.pass();c.pass();
  assert.equal(fs.existsSync(later.part),false);
});

test('rotation keeps a retained original byte-identical and single',t=>{
  const c=fixture(t),bytes=Buffer.from('point_id,label,latitude,longitude,elevation_m\r\nA,A,10.5,20.5,30\r\n');
  for(let index=0;index<PER_PASS+1;index+=1)keptUpload(c,'expired');
  const complete=c.upload({name:'control.csv',bytes});
  const saved=retainUploadedGcpOriginal(c.processing,c.storage,c.processing.getUpload(complete.id),complete.file);
  for(let count=0;count<4;count+=1)c.pass();
  assert.equal(fs.existsSync(complete.part),false,'the cache may go once the original is kept');
  assert.deepEqual(c.originals.get(saved.id).bytes,bytes);
  assert.equal(c.originals.list(complete.datasetId).length,1);
});

test('sustained arrivals never starve a session waiting for its next visit',t=>{
  const c=fixture(t);
  const waiting=c.upload({name:'photo.jpg',bytes:Buffer.from('invented photo'),status:'cancelled'});
  let visited=false;
  for(let count=0;count<6&&!visited;count+=1){
    for(let index=0;index<PER_PASS;index+=1)c.upload({name:`photo-${index}.jpg`,bytes:Buffer.from('invented photo')});
    visited=c.pass().includes(waiting.id);
  }
  assert.ok(visited,'a full pass of new arrivals every time does not hide it');
  assert.equal(fs.existsSync(waiting.part),false);
});
