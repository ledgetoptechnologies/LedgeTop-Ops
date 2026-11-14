'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {openDatabase}=require('../server/database');
const {OrthophotoJpegJobs}=require('../server/orthophotoJpegJobs');
const {createOrthophotoJpegProducts}=require('../server/orthophotoJpegProducts');

function fixture(t){
  const db=openDatabase(':memory:');t.after(()=>db.close());
  const at='2026-11-14T00:00:00Z';
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,created_at,updated_at)
    VALUES ('model-1','webodm','synthetic','Synthetic','ready','version-1',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('version-1','model-1','synthetic-v1','{}','ready',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,sha256,storage_mode,created_at)
    VALUES ('asset-1','version-1','ortho','models','version-1/ortho.tif','geotiff',100,?,'adopted',?)`)
    .run('a'.repeat(64),at);
  const jobs=new OrthophotoJpegJobs(db,{clock:()=>1000});
  jobs.request({versionId:'version-1',sourceAssetId:'asset-1',converterSha256:'b'.repeat(64),
    encoderSha256:'c'.repeat(64),width:20,height:10});
  const row=jobs.claim({owner:'test-worker',deadlineUnixMs:10000});
  const result={sha256:'d'.repeat(64),byteSize:50,width:20,height:10,sourceAssetId:'asset-1',
    sourceVersionId:'version-1',sourceSha256:'a'.repeat(64),sourceByteSize:100,
    converterSha256:row.converter_sha256,encoderSha256:row.encoder_sha256,policyRevision:row.policy_revision,
    workerValidationEvidenceSha256:'e'.repeat(64),closureEvidenceSha256:'f'.repeat(64)};
  const registry=createOrthophotoJpegProducts({database:db,enabled:true});
  const selection={modelId:'model-1',versionId:'version-1',asset:{id:'asset-1',kind:'ortho',rootKey:'models',
    relativePath:'version-1/ortho.tif',format:'geotiff',sha256:'a'.repeat(64),byteSize:100,published:true}};
  const succeed=()=>jobs.complete({jobId:row.id,owner:row.lease_owner,token:row.lease_token,result});
  return {db,jobs,row,result,registry,selection,succeed,select:()=>registry.select(selection)};
}

test('disabled registry never queries storage or database',()=>{
  const registry=createOrthophotoJpegProducts({database:{prepare:()=>{throw new Error('unexpected query');}}});
  assert.equal(registry.select({}),null);
});

test('only a succeeded matching job produces a narrow JPG descriptor',t=>{
  const f=fixture(t);assert.equal(f.select(),null);assert.equal(f.succeed(),true);
  const product=f.select();assert.equal(product.jobId,f.row.id);
  assert.equal(product.product.kind,'orthoJpg');assert.equal(product.product.fileName,'orthophoto.jpg');
  assert.equal(product.product.format,'JPG');assert.equal(product.byteSize,50);
  assert.match(product.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(product.relativePath,`orthophoto-jpeg/ortho-jpeg-${f.row.lease_token}/image.jpg`);
  assert.doesNotMatch(JSON.stringify(product.product),/cache|lease|relativePath|sourceSha|jobId/);
  assert.equal(f.registry.select({...f.selection,modelId:'other-model'}),null);
  assert.equal(f.registry.select({...f.selection,versionId:'other-version'}),null);
});

test('changed source or withdrawn model cannot keep a JPG available',t=>{
  const f=fixture(t);f.succeed();assert.ok(f.select());
  f.db.prepare("UPDATE model_assets SET relative_path='changed/ortho.tif' WHERE id='asset-1'").run();
  assert.equal(f.select(),null);
  f.db.prepare("UPDATE model_assets SET relative_path='version-1/ortho.tif' WHERE id='asset-1'").run();
  f.db.prepare("UPDATE models SET unregistered_at=? WHERE id='model-1'").run('2026-11-14T01:00:00Z');
  assert.equal(f.select(),null);
});

test('invalid stored result or path identity cannot become a downloadable product',t=>{
  const f=fixture(t);f.succeed();
  for(const change of [r=>{r.sourceSha256='0'.repeat(64);},r=>{r.converterSha256='0'.repeat(64);},
    r=>{r.width=1;},r=>{delete r.closureEvidenceSha256;},r=>{r.byteSize=Number.MAX_SAFE_INTEGER;},
    r=>{r.path='/private';},r=>{r.policyRevision='unqualified';}]){
    const result={...f.result};change(result);
    f.db.prepare('UPDATE viewer_orthophoto_jpeg_jobs SET result_json=? WHERE id=?').run(JSON.stringify(result),f.row.id);
    assert.equal(f.select(),null);
  }
  f.db.prepare('UPDATE viewer_orthophoto_jpeg_jobs SET result_json=?,lease_token=? WHERE id=?')
    .run(JSON.stringify(f.result),'../../private',f.row.id);
  assert.equal(f.select(),null);
});

test('ticket fingerprint changes if the stored product changes',t=>{
  const f=fixture(t);f.succeed();const original=f.select();
  f.db.prepare('UPDATE viewer_orthophoto_jpeg_jobs SET result_json=? WHERE id=?')
    .run(JSON.stringify({...f.result,sha256:'1'.repeat(64)}),f.row.id);
  assert.notEqual(f.select().fingerprint,original.fingerprint);
});

test('generation descriptor is separately gated and reports only current-source job status',t=>{
  const f=fixture(t);assert.equal(f.registry.preparation(f.selection),null);
  const registry=createOrthophotoJpegProducts({database:f.db,requestsEnabled:true,encoderSha256:'c'.repeat(64),converterSha256:'b'.repeat(64)});
  const before=registry.preparation(f.selection);assert.equal(before.job.status,'leased');
  assert.equal(before.requestUrl,'/api/v1/models/model-1/orthophoto-jpeg-jobs');
  assert.doesNotMatch(JSON.stringify(before),/lease_token|sourceSha|rootKey|relativePath|errorCode/);
  f.succeed();assert.equal(registry.preparation(f.selection).job.status,'succeeded');
  for(const change of [{encoderSha256:'1'.repeat(64)},{converterSha256:'2'.repeat(64)}]){
    const changed=createOrthophotoJpegProducts({database:f.db,requestsEnabled:true,
      encoderSha256:'c'.repeat(64),converterSha256:'b'.repeat(64),...change});
    assert.equal(changed.preparation(f.selection).job,null,'old software job cannot suppress a current preparation request');
  }
  assert.equal(registry.preparation({...f.selection,modelId:'other'}),null);
  f.db.prepare("UPDATE model_assets SET relative_path='changed.tif' WHERE id='asset-1'").run();
  assert.equal(registry.preparation(f.selection).job,null,'old source job is not reported for a changed source');
});
