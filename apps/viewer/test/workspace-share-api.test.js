'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {createProcessingApi}=require('../server/processingApi');

async function readyShareFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-ready-share-'));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const repository=new ViewerRepository(db),processing=new ProcessingRepository(db);
  const project=processing.createProject({displayName:'Private project'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  db.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?")
    .run('a'.repeat(64),new Date().toISOString(),dataset.id);
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Ready task'});
  const c={db,repository,processing,project,dataset,task,failAfterCommit:false};
  c.output=()=>{
    const attempt=processing.createImportedAttempt({id:crypto.randomUUID(),taskId:task.id,datasetId:dataset.id,providerTaskId:`import:${crypto.randomUUID()}`,createdBy:'ops:share'});
    const versionId=crypto.randomUUID();
    const model=repository.upsertModelVersion({provider:'ltds-processing',providerModelId:task.id,providerVersionId:attempt.id,
      versionId,displayName:'Ready model',status:'ready',makeActive:false,assets:[
        {kind:'glb',rootKey:'models',relativePath:`${attempt.id}/model.glb`,sha256:'b'.repeat(64),published:false},
        {kind:'report',rootKey:'models',relativePath:`${attempt.id}/private.pdf`,sha256:'c'.repeat(64),published:false},
      ]});
    processing.setAttemptResult(attempt.id,model.id,versionId);
    processing.transitionAttempt(attempt.id,'ready_for_review',{progress:1});
    processing.registerModelOutput({versionId,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:attempt.id,byteSize:1,assetCount:2});
    return {attempt,model,versionId};
  };
  c.item=c.output();
  c.token=(permissions)=>{
    const token=crypto.randomBytes(32).toString('base64url');
    processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:share',permissions,displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
    return token;
  };
  c.admin=c.token(['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish']);
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer)}}));
  app.use((_req,res,next)=>{const json=res.json.bind(res);res.json=(body)=>{
    if(c.failAfterCommit&&res.statusCode===201){c.failAfterCommit=false;throw new Error('response lost after commit');}
    return json(body);
  };next();});
  app.use(createProcessingApi({repository,processing,storage:{}}));
  app.use((_err,_req,res,_next)=>res.status(500).json({error:'injected failure'}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});
  const base=`http://127.0.0.1:${server.address().port}`;
  c.manage=(id,{method='GET',body,token=c.admin,suffix='/link',key=crypto.randomUUID()}={})=>fetch(`${base}/api/v1/processing/shares/${id}${suffix}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},...(body?{body:JSON.stringify(body)}:{})});
  c.base=base;
  c.request=({item=c.item,method='POST',body={publishIfReady:true},token=c.admin,key=crypto.randomUUID()}={})=>fetch(
    `${base}/api/v1/processing/outputs/${item.versionId}/shares`,{
      method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},
      ...(method==='GET'?{}:{body:JSON.stringify(body)}),
    });
  c.assertPrivate=(item=c.item)=>{
    assert.equal(processing.getAttempt(item.attempt.id).status,'ready_for_review');
    assert.equal(processing.getModelOutput(item.versionId).status,'ready');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM model_assets WHERE version_id=? AND published=1').get(item.versionId).n,0);
  };
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true})});
  return c;
}

test('durable recopy is authenticated, encrypted, stable through edits and fails closed for unrecoverable legacy links',async t=>{
  const c=await readyShareFixture(t),created=await (await c.request()).json(),id=created.share.id;
  assert.deepEqual(created.share.allowedViews,['model']);
  let response=await c.manage(id);assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');assert.equal((await response.json()).viewUrl,created.viewUrl);
  const token=created.viewUrl.split('/').pop(),stored=c.repository.getPublicShare(id);
  assert.ok(stored.tokenCiphertext);assert.ok(!stored.tokenCiphertext.includes(token));
  assert.equal((await c.manage(id,{token:c.token([])})).status,403);
  assert.equal((await c.manage(id,{method:'PATCH',suffix:'',token:c.token(['viewer.shares.read']),body:{label:'Changed'}})).status,403);
  response=await c.manage(id,{method:'PATCH',suffix:'',body:{label:'Updated',password:'password 123',permissions:{view:true,measure:false,cameras:false,download:false},allowedViews:['model']}});
  assert.equal(response.status,200);assert.equal((await response.json()).share.hasPassword,true);
  assert.equal(c.repository.getPublicShare(id).authorizationRevision,1);
  assert.equal((await (await c.manage(id)).json()).viewUrl,created.viewUrl);
  response=await c.manage(id,{method:'PATCH',suffix:'',body:{password:null,expiresAt:null}});assert.equal(response.status,200);assert.equal((await response.json()).share.hasPassword,false);
  assert.equal((await c.manage(id,{method:'PATCH',suffix:'',body:{allowedViews:['dsm']}})).status,400);
  assert.equal((await c.manage(id,{method:'PATCH',suffix:'',body:{expiresAt:'2000-01-01'}})).status,400);
  c.db.prepare('UPDATE public_shares SET token_ciphertext=NULL WHERE id=?').run(id);
  assert.equal((await (await c.manage(id)).json()).viewUrl,created.viewUrl,'verified receipt recovery preserves exact URL');
  assert.ok(c.repository.getPublicShare(id).tokenCiphertext,'recovery is durable beyond receipt retention');
  const unknown=c.repository.createPublicShare({modelId:stored.modelId,publicIdHash:auth.hashToken('legacy unknown'),permissions:{view:true}});
  assert.equal((await c.manage(unknown.id)).status,409);
  const vault=require('../server/shareTokenVault');assert.equal(vault.open(stored.tokenCiphertext,auth.hashToken('other')),null);
  c.repository.revokePublicShare(id);assert.equal((await c.manage(id)).status,410);
  response=await fetch(`${c.base}/api/v1/projects/${c.project.id}/public-shares`,{method:'POST',headers:{authorization:`Bearer ${c.admin}`,'content-type':'application/json'},body:'{}'});assert.equal(response.status,410);
});

test('ready Share is read-only until explicit link creation, publishes only eligible assets, and defaults passwordless/downloads off',async t=>{
  const c=await readyShareFixture(t);
  const read=await c.request({method:'GET'});assert.equal(read.status,200);
  assert.deepEqual(await read.json(),{publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb'],shares:[]});
  c.assertPrivate();assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);
  let response=await c.request({body:{}});assert.equal(response.status,409);
  assert.equal((await response.json()).code,'publication_confirmation_required');c.assertPrivate();
  response=await c.request();assert.equal(response.status,201);
  const created=await response.json();assert.equal(created.share.hasPassword,false);assert.equal(created.share.permissions.download,false);
  assert.match(created.viewUrl,/\/view\/[A-Za-z0-9_-]+$/);
  assert.equal(c.processing.getModelOutput(c.item.versionId).status,'published');
  assert.deepEqual(c.db.prepare('SELECT kind,published FROM model_assets WHERE version_id=? ORDER BY kind').all(c.item.versionId).map(x=>({...x})),[{kind:'glb',published:1},{kind:'report',published:0}]);
});

test('ready sharing requires both permissions; published sharing does not require publish permission',async t=>{
  const c=await readyShareFixture(t),shareOnly=c.token(['viewer.shares.create']),publishOnly=c.token(['viewer.processing.publish']);
  assert.equal((await c.request({token:shareOnly})).status,403);c.assertPrivate();
  assert.equal((await c.request({token:publishOnly})).status,403);c.assertPrivate();
  assert.equal((await c.request()).status,201);
  assert.equal((await c.request({token:shareOnly,body:{}})).status,201);
});

test('ready sharing rejects private selection, unverified geometry, missing integrity, and nonboolean consent',async t=>{
  const c=await readyShareFixture(t);
  for(const body of [{publishIfReady:'true'},{publishIfReady:true,allowExistingAccessUpdate:'true'},
    {publishIfReady:true,selectedAssetKinds:['report']},{publishIfReady:true,selectedAssetKinds:['tiles']},
    {publishIfReady:true,selectedAssetKinds:[]}]){
    assert.equal((await c.request({body})).status,400);c.assertPrivate();
  }
  c.db.prepare("UPDATE model_assets SET sha256=NULL WHERE version_id=? AND kind='glb'").run(c.item.versionId);
  assert.equal((await c.request()).status,409);c.assertPrivate();
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);
});

for(const [label,sql] of [
  ['publication audit',"CREATE TRIGGER reject_atomic_share BEFORE INSERT ON audit_events WHEN NEW.action='processing_attempt.published' BEGIN SELECT RAISE(ABORT,'failure'); END"],
  ['link insert',"CREATE TRIGGER reject_atomic_share BEFORE INSERT ON public_shares BEGIN SELECT RAISE(ABORT,'failure'); END"],
  ['share audit',"CREATE TRIGGER reject_atomic_share BEFORE INSERT ON audit_events WHEN NEW.action='share.created' BEGIN SELECT RAISE(ABORT,'failure'); END"],
  ['success receipt',"CREATE TRIGGER reject_atomic_share BEFORE UPDATE ON admin_idempotency WHEN NEW.response_status=201 BEGIN SELECT RAISE(ABORT,'failure'); END"],
])test(`ready sharing rolls publication and link back on ${label} failure`,async t=>{
  const c=await readyShareFixture(t);c.db.exec(sql);
  assert.equal((await c.request()).status,500);c.assertPrivate();
  assert.equal(c.repository.getModel(c.item.model.id).activeVersionId,null);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action IN ('share.created','processing_attempt.published')").get().n,0);
  c.db.exec('DROP TRIGGER reject_atomic_share');assert.equal((await c.request()).status,201);
});

test('lost success response replays the committed link and publication without storing the capability',async t=>{
  const c=await readyShareFixture(t),key=crypto.randomUUID();c.failAfterCommit=true;
  assert.equal((await c.request({key})).status,500);
  const response=await c.request({key});assert.equal(response.status,201);assert.equal(response.headers.get('idempotency-replayed'),'true');
  const result=await response.json(),token=result.viewUrl.split('/').at(-1);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,1);
  assert.equal(c.db.prepare("SELECT COUNT(*) n FROM audit_events WHERE action='processing_attempt.published'").get().n,1);
  const receipt=c.db.prepare('SELECT response_json FROM admin_idempotency WHERE idempotency_key=?').get(key).response_json;
  assert.equal(receipt.includes(token),false);assert.equal(receipt.includes('viewUrl'),false);
  assert.equal((await c.request({key,body:{publishIfReady:true,label:'different'}})).status,409);
});

test('replacement requires explicit existing-access consent and keeps old activation on rejection',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const original=c.item,next=c.output();
  const read=await c.request({item:next,method:'GET'});assert.equal((await read.json()).existingAccessUpdateRequired,true);
  let response=await c.request({item:next});assert.equal(response.status,409);
  assert.equal((await response.json()).code,'existing_access_update_confirmation_required');
  c.assertPrivate(next);assert.equal(c.repository.getModel(original.model.id).activeVersionId,original.versionId);
  response=await c.request({item:next,body:{publishIfReady:true,allowExistingAccessUpdate:true}});assert.equal(response.status,201);
  assert.equal(c.repository.getModel(original.model.id).activeVersionId,next.versionId);
  assert.equal(c.repository.listPublicShares(original.model.id).every(share=>share.versionPolicy==='latest'),true);
});

test('first publication under a live project link needs consent; expired and revoked links do not',async t=>{
  const c=await readyShareFixture(t);
  const share=c.repository.createProjectShare({projectId:c.project.id,publicIdHash:auth.hashToken('project-link'),permissions:{view:true}});
  const response=await c.request();assert.equal(response.status,409);c.assertPrivate();
  assert.equal((await response.json()).code,'existing_access_update_confirmation_required');
  c.repository.revokeProjectShare(share.id);
  c.repository.createProjectShare({projectId:c.project.id,publicIdHash:auth.hashToken('expired-project-link'),permissions:{view:true},expiresAt:new Date(Date.now()-1000).toISOString()});
  assert.equal((await c.request()).status,201);
});

test('archived projects and historical ready attempts cannot be activated through sharing',async t=>{
  const c=await readyShareFixture(t);
  c.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);
  assert.equal((await c.request()).status,404);c.assertPrivate();
  c.db.prepare("UPDATE projects SET status='active' WHERE id=?").run(c.project.id);
  c.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(c.task.id);
  assert.equal((await c.request()).status,404);c.assertPrivate();
  assert.throws(()=>c.processing.publishAttemptInTransaction(c.item.attempt.id,['glb']),/active transaction/);
});

test('hierarchical output cannot be shared without its registered entry file',async t=>{
  const c=await readyShareFixture(t);
  c.processing.addModelAsset({versionId:c.item.versionId,kind:'ept',rootKey:'models',relativePath:'cloud/ept.json',
    attemptId:c.item.attempt.id,byteSize:2,sha256:'d'.repeat(64),manifestSha256:'e'.repeat(64),
    manifestFiles:[{relativePath:'ept-data/0-0-0-0.laz',byteSize:2,sha256:'f'.repeat(64)}]});
  const response=await c.request();assert.equal(response.status,409);
  assert.equal((await response.json()).code,'asset_integrity_not_ready');c.assertPrivate();
});

test('unverified tiles are never published implicitly or selected explicitly',async t=>{
  const c=await readyShareFixture(t);
  c.processing.addModelAsset({versionId:c.item.versionId,kind:'tiles',rootKey:'models',relativePath:'tiles/tileset.json',
    attemptId:c.item.attempt.id,byteSize:2,sha256:'d'.repeat(64),manifestSha256:'e'.repeat(64),
    manifestFiles:[{relativePath:'tileset.json',byteSize:2,sha256:'d'.repeat(64)}]});
  assert.equal((await c.request({body:{publishIfReady:true,selectedAssetKinds:['glb','tiles']}})).status,400);c.assertPrivate();
  assert.equal((await c.request()).status,201);
  assert.equal(c.db.prepare("SELECT published FROM model_assets WHERE version_id=? AND kind='tiles'").get(c.item.versionId).published,0);
});

test('new project exposure during password hashing is rechecked before any publication',async t=>{
  const c=await readyShareFixture(t),original=auth.hashPassword;
  auth.hashPassword=async()=>{
    c.repository.createProjectShare({projectId:c.project.id,publicIdHash:auth.hashToken('raced-project-link'),permissions:{view:true}});
    return 'test-only-password-hash';
  };
  try {
    const response=await c.request({body:{publishIfReady:true,password:'long-password'}});
    assert.equal(response.status,409);assert.equal((await response.json()).code,'existing_access_update_confirmation_required');c.assertPrivate();
    assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);
  } finally {auth.hashPassword=original;}
});

test('revoked staff authorization during password hashing cannot publish or mint a link',async t=>{
  const c=await readyShareFixture(t),original=auth.hashPassword;
  auth.hashPassword=async()=>{
    c.db.prepare('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(),auth.hashToken(c.admin));
    return 'test-only-password-hash';
  };
  try {
    const response=await c.request({body:{publishIfReady:true,password:'long-password'}});
    assert.equal(response.status,401);c.assertPrivate();
    assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);
  } finally {auth.hashPassword=original;}
});

test('admin bearer can create list and revoke a one-time staff link for a published output',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-workspace-share-')),db=openDatabase(path.join(root,'viewer.sqlite')),repository=new ViewerRepository(db),processing=new ProcessingRepository(db),token='workspace-share-token-000000000000000';
  const project=processing.createProject({displayName:'Share'}),dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});db.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?").run('a'.repeat(64),new Date().toISOString(),dataset.id);
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Published'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Node',endpoint:'http://127.0.0.1:3000',enabled:true}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),model=repository.upsertModelVersion({provider:'test',providerModelId:task.id,providerVersionId:attempt.id,displayName:'Published',status:'ready',assets:[{kind:'glb',rootKey:'models',relativePath:'model.glb',sha256:'b'.repeat(64),published:true}]}),version=db.prepare('SELECT id FROM model_versions WHERE model_id=?').get(model.id).id;
  processing.registerModelOutput({versionId:version,modelId:model.id,taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:'output',byteSize:1,assetCount:1});db.prepare("UPDATE model_outputs SET status='published' WHERE id=?").run(version);
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:share',permissions:['viewer.processing.publish','viewer.shares.read','viewer.shares.create','viewer.shares.revoke'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer)}}));app.use(createProcessingApi({repository,processing,storage:{}}));const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true})});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'},body=JSON.stringify({label:'Review link',password:'password123',permissions:{view:true,measure:true,cameras:false,download:false}});db.exec("CREATE TRIGGER reject_workspace_share_audit BEFORE INSERT ON audit_events WHEN NEW.action='share.created' BEGIN SELECT RAISE(ABORT,'injected share audit failure'); END");let response=await fetch(`${base}/api/v1/processing/outputs/${version}/shares`,{method:'POST',headers:{...headers,'idempotency-key':'workspace-share-audit-failure'},body});assert.equal(response.status,500);assert.equal(db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,0);db.exec('DROP TRIGGER reject_workspace_share_audit');const clientToken=auth.newShareToken();const clientShare=repository.createPublicShare({modelId:model.id,publicIdHash:clientToken.tokenHash,permissions:{view:true},shareClass:'client',sourceAuthorization:{type:'client_grant',id:'client-auth',version:1,subject:'client:one',expiresAt:null}});response=await fetch(`${base}/api/v1/processing/outputs/${version}/shares`,{method:'POST',headers:{...headers,'idempotency-key':'workspace-share-create'},body});assert.equal(response.status,201);const created=await response.json(),rawToken=created.viewUrl.split('/').at(-1);assert.match(created.viewUrl,/\/view\/[A-Za-z0-9_-]+$/);assert.equal(created.share.hasPassword,true);response=await fetch(`${base}/api/v1/processing/outputs/${version}/shares`,{method:'POST',headers:{...headers,'idempotency-key':'workspace-share-create'},body});assert.equal(response.status,201);assert.equal(response.headers.get('idempotency-replayed'),'true');assert.deepEqual(await response.json(),created);const receipt=db.prepare("SELECT response_json FROM admin_idempotency WHERE idempotency_key='workspace-share-create'").get();assert.equal(receipt.response_json.includes(rawToken),false);assert.equal(receipt.response_json.includes('viewUrl'),false);response=await fetch(`${base}/api/v1/processing/outputs/${version}/shares`,{headers});assert.equal(response.status,200);const listed=(await response.json()).shares;assert.equal(listed.length,1);assert.equal(listed[0].id,created.share.id);response=await fetch(`${base}/api/v1/processing/shares/${clientShare.id}`,{method:'DELETE',headers:{...headers,'idempotency-key':'workspace-client-share-revoke'},body:'{}'});assert.equal(response.status,404);assert.equal(repository.getPublicShare(clientShare.id).revokedAt,null);response=await fetch(`${base}/api/v1/processing/shares/${created.share.id}`,{method:'DELETE',headers:{...headers,'idempotency-key':'workspace-share-revoke'},body:'{}'});assert.equal(response.status,200);assert.ok((await response.json()).share.revokedAt);
});
