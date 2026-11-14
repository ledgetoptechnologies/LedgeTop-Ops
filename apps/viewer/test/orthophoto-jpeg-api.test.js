'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const test=require('node:test');
const auth=require('../server/auth');
const {config}=require('../server/config');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {createProcessingApi}=require('../server/processingApi');

async function fixture(t,{enabled=true}={}){
  const old={enabled:config.orthophotoJpegRequestsEnabled,encoder:config.orthophotoJpegEncoderSha256};
  config.orthophotoJpegRequestsEnabled=enabled;config.orthophotoJpegEncoderSha256='b'.repeat(64);
  const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const writer=crypto.randomBytes(32).toString('base64url'),reader=crypto.randomBytes(32).toString('base64url');
  const writeSession=processing.createAdminSession({tokenHash:auth.hashToken(writer),subject:'synthetic:writer',
    permissions:['viewer.processing.read','viewer.processing.write'],expiresAt:new Date(Date.now()+60000).toISOString()});
  processing.createAdminSession({tokenHash:auth.hashToken(reader),subject:'synthetic:reader',
    permissions:['viewer.processing.read'],expiresAt:new Date(Date.now()+60000).toISOString()});
  const now=new Date().toISOString();
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,created_at,updated_at)
    VALUES ('model-1','webodm','synthetic','Synthetic','ready','version-1',?,?)`).run(now,now);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('version-1','model-1','v1','{}','ready',?,?)`).run(now,now);
  db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,sha256,storage_mode,created_at)
    VALUES ('asset-1','version-1','ortho','models','private/orthophoto.tif','geotiff',100,?,'adopted',?)`).run('a'.repeat(64),now);
  const read={calls:0,run:async()=>({width:20,height:10,metadataOnly:true,fullFileIntegrityVerified:false})};
  const app=express();app.use(express.json({verify(req,_res,b){req.rawBody=Buffer.from(b);}}));
  app.use(createProcessingApi({processing,repository,storage:{},orthophotoJpegReadDimensions:async(...args)=>{read.calls++;return read.run(...args);}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();
    config.orthophotoJpegRequestsEnabled=old.enabled;config.orthophotoJpegEncoderSha256=old.encoder;});
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=({token=writer,key='prepare-jpg-0001',body={versionId:'version-1'}}={})=>fetch(`${base}/api/v1/models/model-1/orthophoto-jpeg-jobs`,{
    method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body)});
  return {db,processing,repository,writer,reader,writeSession,read,base,post};
}

test('staff JPG request persists job and replay atomically without exposing internal rows',async t=>{
  const f=await fixture(t);assert.equal((await f.post({token:f.reader})).status,403);
  assert.equal((await fetch(`${f.base}/api/v1/models/model-1/orthophoto-jpeg-jobs`,{method:'POST'})).status,401);
  const first=await f.post();assert.equal(first.status,202);const payload=await first.json();
  assert.equal(payload.job.status,'queued');assert.equal(payload.job.width,20);
  const text=JSON.stringify(payload);assert.doesNotMatch(text,/private\/|lease_token|converter_sha|encoder_sha|rootKey|source_snapshot/);
  const replay=await f.post();assert.equal(replay.status,202);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.deepEqual(await replay.json(),payload);assert.equal(f.read.calls,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,1);
  const read=await fetch(`${f.base}/api/v1/models/model-1/orthophoto-jpeg-jobs/${payload.job.id}`,{headers:{authorization:`Bearer ${f.reader}`}});
  assert.equal(read.status,200);assert.equal(read.headers.get('cache-control'),'private, no-store');await read.arrayBuffer();
  assert.equal((await fetch(`${f.base}/api/v1/models/other-model/orthophoto-jpeg-jobs/${payload.job.id}`,{headers:{authorization:`Bearer ${f.reader}`}})).status,404);
});

test('disabled requests stop before metadata IO or reserving an idempotency key',async t=>{
  const f=await fixture(t,{enabled:false});assert.equal((await f.post()).status,503);
  assert.equal(f.read.calls,0);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_idempotency').get().n,0);
  config.orthophotoJpegRequestsEnabled=true;assert.equal((await f.post()).status,202);
});

test('source drift and authority revocation during metadata reads cannot enqueue',async t=>{
  const f=await fixture(t);f.read.run=async()=>{
    f.db.prepare("UPDATE model_assets SET sha256=? WHERE id='asset-1'").run('c'.repeat(64));return {width:20,height:10};};
  const changed=await f.post();assert.equal(changed.status,409);assert.equal((await changed.json()).code,'jpeg_job_source_changed');
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,0);
  f.read.run=async()=>{f.db.prepare("UPDATE models SET unregistered_at=? WHERE id='model-1'").run(new Date().toISOString());return {width:20,height:10};};
  assert.equal((await f.post({key:'withdrawal-0001'})).status,409);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,0);
  f.db.prepare("UPDATE models SET unregistered_at=NULL WHERE id='model-1'").run();
  f.read.run=async()=>{f.processing.revokeAdminSession(f.writeSession.id);return {width:20,height:10};};
  assert.equal((await f.post({key:'revocation-0001'})).status,401);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,0);
});

test('audit failure rolls back job and receipt so the same request can safely retry',async t=>{
  const f=await fixture(t),audit=f.repository.audit.bind(f.repository);
  f.repository.audit=()=>{throw new Error('private implementation path');};
  const failed=await f.post();assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/implementation|private/);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs_events').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM admin_idempotency').get().n,0);
  f.repository.audit=audit;assert.equal((await f.post()).status,202);
});

test('caller cannot choose dimensions, encoder, source path or another version',async t=>{
  const f=await fixture(t);
  for(const body of [{versionId:'version-1',width:1},{versionId:'version-1',encoderSha256:'d'.repeat(64)},
    {versionId:'version-1',sourcePath:'/private/a.tif'}])assert.equal((await f.post({body})).status,400);
  assert.equal((await f.post({body:{versionId:'other-version'}})).status,409);
  assert.equal(f.read.calls,0);
});

test('failed rollback preserves pending receipt even when the job already existed',async t=>{
  const f=await fixture(t);assert.equal((await f.post()).status,202);
  const exec=f.db.exec.bind(f.db),audit=f.repository.audit.bind(f.repository);
  f.db.exec=sql=>{if(sql==='ROLLBACK')throw new Error('injected rollback failure');return exec(sql);};
  f.repository.audit=()=>{throw new Error('first audit failure');};
  try{
    assert.equal((await f.post({key:'rollback-fault-0001'})).status,503);
    const row=f.db.prepare('SELECT response_status FROM admin_idempotency WHERE idempotency_key=?').get('rollback-fault-0001');
    assert.ok(row);assert.equal(row.response_status,null);
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs').get().n,1);
  }finally{f.db.exec=exec;f.repository.audit=audit;exec('ROLLBACK');}
});
