'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {OrthophotoJpegJobs,POLICY_REVISION}=require('../server/orthophotoJpegJobs');

function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=47').get().name,
    'viewer_orthophoto_jpeg_jobs');
  const at='2026-11-14T00:00:00.000Z';
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,created_at,updated_at)
    VALUES ('model-1','webodm','synthetic','Synthetic imported','ready','version-1',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('version-1','model-1','synthetic-v1','{}','ready',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,sha256,storage_mode,created_at)
    VALUES ('asset-1','version-1','ortho','models','version-1/orthophoto.tif','geotiff',100,?,'adopted',?)`)
    .run('a'.repeat(64),at);
  let clock=1000;
  const jobs=new OrthophotoJpegJobs(db,{clock:()=>clock});
  const request={versionId:'version-1',sourceAssetId:'asset-1',converterSha256:'b'.repeat(64),
    encoderSha256:'c'.repeat(64),width:20,height:10};
  return {db,jobs,request,time:value=>{clock=value;},
    claim:(owner='worker-1')=>jobs.claim({owner,leaseMs:1000,deadlineUnixMs:10000})};
}

function result(row){
  const source=JSON.parse(row.source_snapshot_json);
  return {sha256:'d'.repeat(64),byteSize:400,width:row.width,height:row.height,
    sourceAssetId:row.source_asset_id,sourceVersionId:row.model_version_id,
    sourceSha256:source.sha256,sourceByteSize:source.byteSize,
    converterSha256:row.converter_sha256,encoderSha256:row.encoder_sha256,policyRevision:row.policy_revision,
    workerValidationEvidenceSha256:'e'.repeat(64),closureEvidenceSha256:'f'.repeat(64)};
}
const identity=row=>({jobId:row.id,owner:row.lease_owner,token:row.lease_token});

test('registered47 supports imported current model without attempt and dedupes exact success',{timeout:3000},t=>{
  const {db,jobs,request,claim}=fixture(t);
  assert.equal(db.prepare('SELECT source_attempt_id FROM model_assets').get().source_attempt_id,null);
  const created=jobs.request(request);assert.equal(created.replayed,false);
  assert.equal(jobs.request(request).job.id,created.job.id);
  const leased=claim();assert.equal(jobs.complete({...identity(leased),result:result(leased)}),true);
  assert.equal(jobs.request(request).job.status,'succeeded');
  assert.equal(jobs.request(request).job.id,created.job.id);
  db.prepare('UPDATE model_assets SET sha256=? WHERE id=?').run('1'.repeat(64),'asset-1');
  assert.notEqual(jobs.request(request).job.id,created.job.id);
});

test('one leased or cleanup-required slot blocks all other claims after expiry',{timeout:3000},t=>{
  const {db,jobs,request,claim,time}=fixture(t);
  jobs.request(request);jobs.request({...request,encoderSha256:'2'.repeat(64)});
  const first=claim();assert.ok(first);
  assert.equal(claim('worker-2'),null);
  time(2001);assert.equal(claim('worker-2'),null);
  const blocked=jobs.get(first.id);assert.equal(blocked.status,'cleanup_required');
  assert.equal(blocked.lease_token,first.lease_token);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM viewer_orthophoto_jpeg_jobs WHERE status='queued'").get().n,1);
});

test('heartbeat and completion require exact unexpired owner/token and original deadline',{timeout:3000},t=>{
  const {jobs,request,claim,time}=fixture(t);jobs.request(request);const row=claim();
  assert.equal(jobs.heartbeat({...identity(row),token:'wrong'}),false);
  assert.equal(jobs.complete({...identity(row),owner:'wrong',result:result(row)}),false);
  time(1500);assert.equal(jobs.heartbeat({...identity(row),leaseMs:60000}),true);
  assert.equal(jobs.get(row.id).lease_expires_unix_ms,10000);
  time(10000);assert.equal(jobs.complete({...identity(row),result:result(row)}),false);
  assert.equal(jobs.get(row.id).status,'cleanup_required');
  assert.equal(jobs.get(row.id).result_json,null);
});

test('source relocation or removal prevents stale success without blocking source purge',{timeout:3000},t=>{
  const {db,jobs,request,claim}=fixture(t);jobs.request(request);const row=claim();
  db.prepare('UPDATE model_assets SET relative_path=? WHERE id=?').run('relocated/ortho.tif','asset-1');
  assert.equal(jobs.complete({...identity(row),result:result(row)}),false);
  assert.equal(jobs.get(row.id).status,'cleanup_required');
  assert.equal(jobs.closeLease({...identity(row),closureEvidenceSha256:'f'.repeat(64),action:'retry'}),true);
  assert.equal(jobs.get(row.id).status,'failed');
  assert.doesNotThrow(()=>db.prepare('DELETE FROM model_assets WHERE id=?').run('asset-1'));
  assert.equal(JSON.parse(jobs.get(row.id).source_snapshot_json).relativePath,'version-1/orthophoto.tif');
  assert.throws(()=>jobs.request(request),{code:'jpeg_job_source_unavailable'});
});

test('converter encoder policy dimensions and independent evidence are mandatory immutable bindings',{timeout:3000},t=>{
  const {db,jobs,request,claim}=fixture(t);
  assert.throws(()=>jobs.request({...request,encoderSha256:undefined}),{code:'invalid_jpeg_job_identity'});
  const first=jobs.request(request).job;
  assert.notEqual(jobs.request({...request,converterSha256:'2'.repeat(64)}).job.id,first.id);
  assert.notEqual(jobs.request({...request,encoderSha256:'3'.repeat(64)}).job.id,first.id);
  assert.equal(first.policy_revision,'cjpeg-white-baseline-noopt-q90-v1');
  assert.equal(first.policy_revision,POLICY_REVISION);
  assert.throws(()=>db.prepare('UPDATE viewer_orthophoto_jpeg_jobs SET encoder_sha256=? WHERE id=?').run('4'.repeat(64),first.id),/immutable/);
  const row=claim();
  for(const [key,value] of [['converterSha256','0'.repeat(64)],['encoderSha256','0'.repeat(64)],
    ['sourceSha256','0'.repeat(64)],['width',1],['policyRevision','old-gdal-policy']]){
    assert.throws(()=>jobs.complete({...identity(row),result:{...result(row),[key]:value}}),{code:'jpeg_job_result_binding'});
  }
  const malformed=result(row);delete malformed.workerValidationEvidenceSha256;
  assert.throws(()=>jobs.complete({...identity(row),result:malformed}),{code:'invalid_jpeg_job_result_fields'});
  assert.equal(jobs.get(row.id).status,'leased');
});

test('only original lease identity plus explicit closure evidence can close and retry',{timeout:3000},t=>{
  const {db,jobs,request,claim,time}=fixture(t);jobs.request(request);const first=claim();time(2001);
  assert.equal(claim(),null);
  assert.equal(jobs.closeLease({...identity(first),owner:'intruder',closureEvidenceSha256:'f'.repeat(64),action:'retry'}),false);
  assert.throws(()=>jobs.closeLease({...identity(first),closureEvidenceSha256:null,action:'retry'}),{code:'invalid_jpeg_job_closure'});
  assert.equal(jobs.closeLease({...identity(first),closureEvidenceSha256:'f'.repeat(64),action:'retry'}),true);
  const second=claim('worker-2');assert.notEqual(second.lease_token,first.lease_token);
  assert.equal(jobs.complete({...identity(first),result:result(first)}),false);
  assert.equal(jobs.closeLease({...identity(first),closureEvidenceSha256:'f'.repeat(64),action:'fail'}),false);
  const events=jobs.events(first.id);assert.ok(events.some(event=>event.phase==='closed_retry'));
  assert.ok(events.some(event=>event.phase==='leased'&&event.token===first.lease_token));
  assert.throws(()=>db.prepare('DELETE FROM viewer_orthophoto_jpeg_jobs_events WHERE job_id=?').run(first.id),/retained/);
  assert.throws(()=>db.prepare('UPDATE viewer_orthophoto_jpeg_jobs_events SET evidence_json=? WHERE job_id=?').run('{}',first.id),/immutable/);
});
