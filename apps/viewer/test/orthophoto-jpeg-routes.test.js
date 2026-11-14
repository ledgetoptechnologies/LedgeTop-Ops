'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const auth=require('../server/auth');
const {config}=require('../server/config');
const {openDatabase}=require('../server/database');
const {OrthophotoJpegJobs}=require('../server/orthophotoJpegJobs');
const {orthophotoJpegConverterSha256}=require('../server/orthophotoJpegConverter');
const assets=require('../server/assets');
const {sourceAuthorizationValidator}=require('../server/sourceAuthorization');
const {createProcessingApi}=require('../server/processingApi');

// Actual SQLite product registry and HTTP authorization; the entire Linux FD
// sender is substituted. These checks do not qualify filesystem or image bytes.
async function fixture(t){
  const previous=config.orthophotoJpegDownloadsEnabled;
  config.orthophotoJpegDownloadsEnabled=true;
  const db=openDatabase(':memory:'),at='2026-11-14T00:00:00Z';
  db.prepare(`INSERT INTO models(id,provider,provider_model_id,display_name,status,active_version_id,created_at,updated_at)
    VALUES ('model','webodm','synthetic','Synthetic','ready','version',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at)
    VALUES ('version','model','synthetic-v1','{}','ready',?,?)`).run(at,at);
  db.prepare(`INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,byte_size,sha256,storage_mode,created_at)
    VALUES ('ortho','version','ortho','models','version/ortho.tif','geotiff',100,?,'adopted',?)`).run('a'.repeat(64),at);
  const jobs=new OrthophotoJpegJobs(db,{clock:()=>1000});
  jobs.request({versionId:'version',sourceAssetId:'ortho',converterSha256:orthophotoJpegConverterSha256(),encoderSha256:'c'.repeat(64),width:20,height:10});
  const row=jobs.claim({owner:'test-worker',deadlineUnixMs:10000});
  const result={sha256:'d'.repeat(64),byteSize:50,width:20,height:10,sourceAssetId:'ortho',
    sourceVersionId:'version',sourceSha256:'a'.repeat(64),sourceByteSize:100,
    converterSha256:row.converter_sha256,encoderSha256:row.encoder_sha256,policyRevision:row.policy_revision,
    workerValidationEvidenceSha256:'e'.repeat(64),closureEvidenceSha256:'f'.repeat(64)};
  assert.equal(jobs.complete({jobId:row.id,owner:row.lease_owner,token:row.lease_token,result}),true);
  const ortho={id:'ortho',kind:'ortho',rootKey:'models',relativePath:'version/ortho.tif',
    format:'geotiff',sha256:'a'.repeat(64),byteSize:100,published:true};
  const version={id:'version',status:'ready',assets:[ortho]};
  const model={id:'model',status:'ready',provider:'webodm',activeVersionId:'version',activeVersion:version};
  const viewerToken='viewer-session-token-0000000000000000',adminToken='admin-session-token-00000000000000000';
  const session={id:'viewer',modelId:'model',modelVersionId:'version',permissions:{view:true,download:true},expiresAt:new Date(Date.now()+60000).toISOString()};
  const staff={id:'admin',subject:'ops:admin',permissions:['viewer.processing.read'],expiresAt:session.expiresAt};
  const output={id:'version',modelId:'model',status:'ready'};
  const repository={resolveModelId:id=>id==='model'?id:null,getModel:id=>id==='model'?model:null,
    getModelVersion:(id,v)=>id==='model'&&v==='version'?model:null,
    getViewerSessionByHash:hash=>hash===auth.hashToken(viewerToken)?session:null,
    viewerSessionLive:value=>!!value&&!value.revokedAt&&Date.parse(value.expiresAt)>Date.now(),
    rateLimited:()=>false,getPublicShare:()=>null,publicShareLive:()=>false};
  const processing={database:db,getModelOutput:id=>id==='version'?output:null,
    getAdminSessionByHash:hash=>hash===auth.hashToken(adminToken)?staff:null,
    adminSessionLive:value=>!!value&&!value.revokedAt&&Date.parse(value.expiresAt)>Date.now(),
    listModelOutputsPage:()=>({items:[output],nextCursor:null,totalCount:1,totalBytes:100}),
    lodDerivativeState:()=>({status:'unavailable',canGenerate:false}),companionRepairAction:()=>null};
  const c={db,row,result,model,version,ortho,output,session,staff,repository,processing,viewerToken,adminToken,sends:0};
  const sender=async(req,res,selection,revalidate)=>{
    c.sends++;assert.match(selection.relativePath,/^orthophoto-jpeg\/ortho-jpeg-/);
    if(c.duringHash)c.duringHash();
    if(!await revalidate())return res.sendStatus(403);
    res.setHeader('Content-Type','image/jpeg');res.end('synthetic sender');
  };
  assets.setRepository(repository);assets.setProcessingRepository(processing);assets.setJpegDownloadSender(sender);
  const app=express();app.use(express.json());app.use(assets);
  app.use(createProcessingApi({repository,processing,storage:{},orthophotoJpegSendDownload:sender}));
  app.use((error,req,res,next)=>res.status(error.status||500).json({code:error.code||'unexpected'}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));assets.setRepository(null);
    assets.setProcessingRepository(null);assets.setJpegDownloadSender(null);
    assets.setSourceAuthorizationValidator(sourceAuthorizationValidator);
    config.orthophotoJpegDownloadsEnabled=previous;db.close();});
  c.base=`http://127.0.0.1:${server.address().port}`;
  c.viewer=`/session-products/${viewerToken}/model`;
  c.staffBase='/api/v1/processing/outputs/version/products';
  c.headers={authorization:`Bearer ${adminToken}`,'content-type':'application/json'};
  c.issue=async(staff=false)=>{
    const response=await fetch(c.base+(staff?c.staffBase:c.viewer)+'/orthoJpg/download-grants',
      {method:'POST',...(staff?{headers:c.headers,body:'{}'}:{})});
    assert.equal(response.status,201);return response.json();
  };
  return c;
}

test('full-resolution JPG appears beside original TIFF in Viewer and staff menus without private paths',async t=>{
  const c=await fixture(t);
  for(const [url,options] of [[c.viewer,{}],['/api/v1/processing/outputs',{headers:c.headers}]]){
    const response=await fetch(c.base+url,options);assert.equal(response.status,200);
    const body=await response.json(),products=body.products||body.outputs[0].downloadProducts;
    assert.deepEqual(products.map(p=>p.kind),['ortho','orthoJpg']);
    assert.doesNotMatch(JSON.stringify(products),/lease|rootKey|relativePath|sourceSha|jobId/);
  }
  for(const staff of [false,true]){
    const ticket=await c.issue(staff);assert.equal(ticket.fileName,'orthophoto.jpg');
    assert.ok(!ticket.url.includes(c.viewerToken)&&!ticket.url.includes(c.adminToken));
    const response=await fetch(c.base+ticket.url);assert.equal(response.status,200);
    assert.equal(await response.text(),'synthetic sender');
  }
});

test('downloads flag is independent and invalidates issued JPG tickets in both routes',async t=>{
  const c=await fixture(t),tickets=[await c.issue(),await c.issue(true)];
  config.orthophotoJpegDownloadsEnabled=false;
  for(const ticket of tickets)assert.equal((await fetch(c.base+ticket.url)).status,403);
  assert.equal(c.sends,0);
  assert.equal((await fetch(c.base+c.viewer+'/orthoJpg/download-grants',{method:'POST'})).status,404);
  const products=await(await fetch(c.base+c.viewer)).json();assert.deepEqual(products.products.map(p=>p.kind),['ortho']);
});

test('changed source or succeeded result invalidates exact JPG capability',async t=>{
  const c=await fixture(t),tickets=[await c.issue(),await c.issue(true)];
  c.db.prepare('UPDATE viewer_orthophoto_jpeg_jobs SET result_json=? WHERE id=?')
    .run(JSON.stringify({...c.result,sha256:'1'.repeat(64)}),c.row.id);
  for(const ticket of tickets)assert.equal((await fetch(c.base+ticket.url)).status,403);
  const next=await c.issue();
  c.db.prepare("UPDATE model_assets SET relative_path='changed.tif' WHERE id='ortho'").run();
  assert.equal((await fetch(c.base+next.url)).status,403);assert.equal(c.sends,0);
});

test('staff scope, output withdrawal and revocation stop grants and admitted sends',async t=>{
  const c=await fixture(t),endpoint=c.base+c.staffBase+'/orthoJpg/download-grants';
  assert.equal((await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  c.staff.permissions=[];assert.equal((await fetch(endpoint,{method:'POST',headers:c.headers,body:'{}'})).status,403);
  c.staff.permissions=['viewer.processing.read'];let ticket=await c.issue(true);
  c.output.status='trashed';assert.equal((await fetch(c.base+ticket.url)).status,403);
  c.output.status='ready';ticket=await c.issue(true);
  c.duringHash=()=>{c.staff.revokedAt=new Date().toISOString();};
  assert.equal((await fetch(c.base+ticket.url)).status,403);
});

test('Viewer model/version/download revocation is checked again after integrity work',async t=>{
  const c=await fixture(t),ticket=await c.issue();
  c.duringHash=()=>{c.session.permissions.download=false;};
  assert.equal((await fetch(c.base+ticket.url)).status,403);
  c.session.permissions.download=true;c.duringHash=null;
  const next=await c.issue();c.model.activeVersionId='different';
  assert.equal((await fetch(c.base+next.url)).status,403);
});

test('public share JPG inherits ortho restrictions and current share revocation',async t=>{
  const c=await fixture(t),share={id:'share',modelId:'model',permissions:{view:true,download:true},allowedViews:['dsm'],versionPolicy:'active'};
  c.repository.getPublicShare=id=>id==='share'?share:null;
  c.repository.publicShareLive=value=>!!value&&!value.revokedAt;
  const token=auth.sign({kind:'share-asset',shareId:'share',modelId:'model'},60000);
  const base=`${c.base}/session-products/${token}/model`;
  assert.equal((await fetch(base+'/orthoJpg/download-grants',{method:'POST'})).status,404);
  share.allowedViews=['ortho'];
  const issued=await fetch(base+'/orthoJpg/download-grants',{method:'POST'});assert.equal(issued.status,201);
  const ticket=await issued.json();share.revokedAt=new Date().toISOString();
  assert.equal((await fetch(c.base+ticket.url)).status,403);assert.equal(c.sends,0);
});

test('share snapshots revoked during upstream check cannot issue or send JPG capabilities',async t=>{
  const c=await fixture(t),share={id:'share',modelId:'model',permissions:{view:true,download:true},
    allowedViews:['ortho'],versionPolicy:'active',shareClass:'client',
    sourceAuthorization:{type:'client_grant',id:'synthetic-grant',version:1,subject:'synthetic',expiresAt:null}};
  c.repository.getPublicShare=id=>id==='share'?structuredClone(share):null;
  c.repository.publicShareLive=value=>!!value&&!value.revokedAt;
  let duringCheck;
  assets.setSourceAuthorizationValidator({allows:async()=>{if(duringCheck)duringCheck();return true;}});
  const token=auth.sign({kind:'share-asset',shareId:'share',modelId:'model'},60000);
  const endpoint=`${c.base}/session-products/${token}/model/orthoJpg/download-grants`;
  duringCheck=()=>{share.revokedAt=new Date().toISOString();};
  assert.equal((await fetch(endpoint,{method:'POST'})).status,403);
  delete share.revokedAt;duringCheck=null;
  const issued=await fetch(endpoint,{method:'POST'});assert.equal(issued.status,201);const ticket=await issued.json();
  duringCheck=()=>{share.permissions.download=false;};
  assert.equal((await fetch(c.base+ticket.url)).status,403);assert.equal(c.sends,0);
  share.permissions.download=true;duringCheck=()=>{share.sourceAuthorization.version++;};
  assert.equal((await fetch(endpoint,{method:'POST'})).status,403);
  duringCheck=null;
  const next=await(await fetch(endpoint,{method:'POST'})).json();
  c.duringHash=()=>{duringCheck=()=>{share.revokedAt=new Date().toISOString();};};
  assert.equal((await fetch(c.base+next.url)).status,403);
  assert.equal(c.sends,1,'final post-integrity authorization also refreshes cloned snapshots');
});

test('staff output describes JPG preparation only when requests are configured',async t=>{
  const c=await fixture(t),old={enabled:config.orthophotoJpegRequestsEnabled,encoder:config.orthophotoJpegEncoderSha256};
  t.after(()=>{config.orthophotoJpegRequestsEnabled=old.enabled;config.orthophotoJpegEncoderSha256=old.encoder;});
  const read=async()=>(await(await fetch(c.base+'/api/v1/processing/outputs',{headers:c.headers})).json()).outputs[0];
  config.orthophotoJpegRequestsEnabled=false;assert.equal((await read()).jpegPreparation,null);
  config.orthophotoJpegRequestsEnabled=true;config.orthophotoJpegEncoderSha256='';assert.equal((await read()).jpegPreparation,null);
  config.orthophotoJpegEncoderSha256='c'.repeat(64);
  const preparation=(await read()).jpegPreparation;
  assert.equal(preparation.versionId,'version');assert.equal(preparation.job.status,'succeeded');
  assert.equal(preparation.requestUrl,'/api/v1/models/model/orthophoto-jpeg-jobs');
  c.output.status='trashed';assert.equal((await read()).jpegPreparation,null);
});
