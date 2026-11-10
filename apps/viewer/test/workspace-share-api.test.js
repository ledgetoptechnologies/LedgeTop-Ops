'use strict';
process.env.SERVICE_AUTH_KEY_ID='workspace-share-test';
process.env.SERVICE_AUTH_SECRET='workspace-share-test-secret-at-least-32-bytes';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {DatabaseSync}=require('node:sqlite');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {createProcessingApi}=require('../server/processingApi');
const {createApiV1}=require('../server/apiV1');
const {signServiceRequest}=require('../server/serviceAuth');

async function readyShareFixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-ready-share-'));
  const db=openDatabase(path.join(root,'viewer.sqlite'));
  const repository=new ViewerRepository(db),processing=new ProcessingRepository(db);
  const project=processing.createProject({displayName:'Private project'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  db.prepare("UPDATE datasets SET status='finalized',manifest_sha256=?,finalized_at=? WHERE id=?")
    .run('a'.repeat(64),new Date().toISOString(),dataset.id);
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Ready task'});
  const c={db,dbPath:path.join(root,'viewer.sqlite'),repository,processing,project,dataset,task,failAfterCommit:false};
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
  c.admin=c.token(['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.processing.read']);
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer)}}));
  app.use((_req,res,next)=>{const json=res.json.bind(res);res.json=(body)=>{
    if(c.failAfterCommit&&res.statusCode===201){c.failAfterCommit=false;throw new Error('response lost after commit');}
    return json(body);
  };next();});
  app.use(createApiV1(repository));
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

for(const state of ['ready','published']) for(const parent of ['task','project']) for(const disposition of ['archived','purged'])
  test(`${state} output cannot be shared after its ${parent} is ${disposition}`,async t=>{
    const c=await readyShareFixture(t);
    if(state==='published') assert.equal((await c.request()).status,201);
    const table=parent==='task'?'processing_tasks':'projects',id=parent==='task'?c.task.id:c.project.id;
    if(disposition==='archived') c.db.prepare(`UPDATE ${table} SET status='archived' WHERE id=?`).run(id);
    else c.db.prepare(`UPDATE ${table} SET purged_at=? WHERE id=?`).run(new Date().toISOString(),id);
    const before=c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n;
    assert.equal((await c.request({method:'GET'})).status,404);
    assert.equal((await c.request({body:{publishIfReady:true}})).status,404);
    assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,before);
  });

test('published share rechecks parent state after password hashing',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const original=auth.hashPassword;
  auth.hashPassword=async()=>{c.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);return 'test-only-password-hash';};
  t.after(()=>{auth.hashPassword=original});
  const before=c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n;
  const response=await c.request({body:{password:'password 123'}});
  assert.equal(response.status,409);assert.equal((await response.json()).code,'output_changed');
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM public_shares').get().n,before);
});

for(const parent of ['task','project']) for(const disposition of ['archived','purged'])
  test(`staff published session refuses ${disposition} ${parent}`,async t=>{
    const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
    const session=()=>fetch(`${c.base}/api/v1/processing/outputs/${c.item.versionId}/view-sessions`,{
      method:'POST',headers:{authorization:`Bearer ${c.admin}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}',
    });
    assert.equal((await session()).status,201,'active parents allow staff sessions');
    const table=parent==='task'?'processing_tasks':'projects',id=parent==='task'?c.task.id:c.project.id;
    if(disposition==='archived')c.db.prepare(`UPDATE ${table} SET status='archived' WHERE id=?`).run(id);
    else c.db.prepare(`UPDATE ${table} SET purged_at=? WHERE id=?`).run(new Date().toISOString(),id);
    const before=c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n;
    assert.equal((await session()).status,404);
    assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,before);
  });

test('staff session grant serializes against concurrent project recycle and audit is atomic',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const other=new DatabaseSync(c.dbPath);other.exec('PRAGMA busy_timeout=0');t.after(()=>other.close());
  const original=c.repository.createSessionGrant.bind(c.repository);let blocked=false;
  c.repository.createSessionGrant=(input)=>{
    try{other.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);}
    catch(error){if(!/locked|busy/i.test(error.message))throw error;blocked=true;}
    return original(input);
  };
  const session=()=>fetch(`${c.base}/api/v1/processing/outputs/${c.item.versionId}/view-sessions`,{
    method:'POST',headers:{authorization:`Bearer ${c.admin}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}',
  });
  assert.equal((await session()).status,201);assert.equal(blocked,true,'concurrent writer cannot recycle between check and grant');
  c.repository.createSessionGrant=original;
  const before=c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n;
  c.db.exec("CREATE TRIGGER reject_session_audit BEFORE INSERT ON audit_events WHEN NEW.action='processing_published_session.created' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.equal((await session()).status,500);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,before,'failed audit rolls grant back');
  c.db.exec('DROP TRIGGER reject_session_audit');
  other.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);
  assert.equal((await session()).status,404);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,before);
});

for(const renewal of [false,true])test(`grant ${renewal?'renewal':'redemption'} serializes with project trash`,async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const expiresAt=new Date(Date.now()+60000).toISOString();
  const grant=()=>c.repository.createSessionGrant({modelId:c.item.model.id,modelVersionId:c.item.versionId,subject:'ops:test',audience:'ops',permissions:{view:true},expiresAt});
  const redeem=(g,token)=>fetch(`${c.base}/api/v1/sessions/redeem`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({grant:g.id})});
  let token=null;if(renewal){const first=await redeem(grant());assert.equal(first.status,200);token=(await first.json()).accessToken;}
  const other=new DatabaseSync(c.dbPath);other.exec('PRAGMA busy_timeout=0');t.after(()=>other.close());
  const method=renewal?'renewViewerSession':'createViewerSession',original=c.repository[method].bind(c.repository);let blocked=false;
  c.repository[method]=(...args)=>{try{other.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);}catch(error){if(!/locked|busy/i.test(error.message))throw error;blocked=true;}return original(...args);};
  const response=await redeem(grant(),token);assert.equal(response.status,200);assert.equal(blocked,true);
  const result=await response.json();if(renewal)assert.equal(result.accessToken,token);
  c.repository[method]=original;
  assert.ok(c.processing.trashProject(c.project.id,'ops:test'));
  assert.equal(c.repository.viewerSessionLive(c.repository.getViewerSessionByHash(auth.hashToken(result.accessToken))),false);
});

test('redemption rolls back grant and session when audit fails',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const g=c.repository.createSessionGrant({modelId:c.item.model.id,modelVersionId:c.item.versionId,subject:'ops:test',audience:'ops',permissions:{view:true},expiresAt:new Date(Date.now()+60000).toISOString()});
  c.db.exec("CREATE TRIGGER reject_redeem_audit BEFORE INSERT ON audit_events WHEN NEW.action='session.redeemed' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  const response=await fetch(`${c.base}/api/v1/sessions/redeem`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({grant:g.id})});
  assert.equal(response.status,500);
  assert.equal(c.db.prepare('SELECT redeemed_at FROM session_grants WHERE id=?').get(g.id).redeemed_at,null);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM viewer_sessions').get().n,0);
});

test('failed renewal audit leaves existing session and grant unchanged',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const grant=(permissions)=>c.repository.createSessionGrant({modelId:c.item.model.id,modelVersionId:c.item.versionId,subject:'ops:test',audience:'ops',permissions,expiresAt:new Date(Date.now()+60000).toISOString()});
  const redeem=(g,token)=>fetch(`${c.base}/api/v1/sessions/redeem`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({grant:g.id})});
  const first=await redeem(grant({view:true,measure:false}));assert.equal(first.status,200);const token=(await first.json()).accessToken;
  const before=c.repository.getViewerSessionByHash(auth.hashToken(token)),next=grant({view:true,measure:true});
  c.db.exec("CREATE TRIGGER reject_renew_audit BEFORE INSERT ON audit_events WHEN NEW.action='session.redeemed' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.equal((await redeem(next,token)).status,500);
  assert.deepEqual(c.repository.getViewerSessionByHash(auth.hashToken(token)),before);
  assert.equal(c.db.prepare('SELECT redeemed_at FROM session_grants WHERE id=?').get(next.id).redeemed_at,null);
});

for(const condition of ['archived task','purged task','archived project','purged project','historical attempt'])
  test(`review session rejects ${condition}`,async t=>{
    const c=await readyShareFixture(t);
    if(condition==='archived task')c.db.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(c.task.id);
    if(condition==='purged task')c.db.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(),c.task.id);
    if(condition==='archived project')c.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);
    if(condition==='purged project')c.db.prepare('UPDATE projects SET purged_at=? WHERE id=?').run(new Date().toISOString(),c.project.id);
    if(condition==='historical attempt')c.db.prepare('UPDATE processing_tasks SET active_attempt_id=NULL WHERE id=?').run(c.task.id);
    const response=await fetch(`${c.base}/api/v1/attempts/${c.item.attempt.id}/review-sessions`,{method:'POST',headers:{authorization:`Bearer ${c.admin}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}'});
    assert.equal(response.status,409);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,0);
  });

test('review grant serializes with trash and rolls back when auditing fails',async t=>{
  const c=await readyShareFixture(t),other=new DatabaseSync(c.dbPath);other.exec('PRAGMA busy_timeout=0');t.after(()=>other.close());
  const original=c.repository.createSessionGrant.bind(c.repository);let blocked=false;
  c.repository.createSessionGrant=(input)=>{try{other.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);}catch(error){if(!/locked|busy/i.test(error.message))throw error;blocked=true;}return original(input);};
  const request=()=>fetch(`${c.base}/api/v1/attempts/${c.item.attempt.id}/review-sessions`,{method:'POST',headers:{authorization:`Bearer ${c.admin}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:'{}'});
  const issued=await request();assert.equal(issued.status,201);assert.equal(blocked,true);const id=(await issued.json()).grant;
  c.repository.createSessionGrant=original;
  c.db.exec("CREATE TRIGGER reject_review_audit BEFORE INSERT ON audit_events WHEN NEW.action='processing_review_session.created' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.equal((await request()).status,500);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,1);
  c.db.exec('DROP TRIGGER reject_review_audit');assert.ok(c.processing.trashProject(c.project.id,'ops:test'));
  assert.equal(c.repository.redeemSessionGrant(id),null);assert.equal((await request()).status,409);
});

test('service-issued sessions respect processing parents and preserve external legacy models',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const secret=process.env.SERVICE_AUTH_SECRET,keyId=process.env.SERVICE_AUTH_KEY_ID;
  assert.ok(secret&&keyId,'test requires an isolated service key');
  const request=(model,{key=crypto.randomUUID()}={})=>{
    const url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()});
    return fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret,keyId,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':key},body});
  };
  const current=c.repository.getModel(c.item.model.id),other=new DatabaseSync(c.dbPath);other.exec('PRAGMA busy_timeout=0');t.after(()=>other.close());
  const original=c.repository.createSessionGrant.bind(c.repository);let blocked=false;
  c.repository.createSessionGrant=(input)=>{try{other.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);}catch(error){if(!/locked|busy/i.test(error.message))throw error;blocked=true;}return original(input);};
  const issued=await request(current);assert.equal(issued.status,201);assert.equal(blocked,true);const id=(await issued.json()).grant;c.repository.createSessionGrant=original;
  assert.ok(c.processing.trashProject(c.project.id,'ops:test'));assert.equal(c.repository.redeemSessionGrant(id),null);
  assert.equal((await request(current)).status,404);
  const legacy=c.repository.upsertModelVersion({provider:'terra',providerModelId:'legacy',providerVersionId:'legacy',displayName:'Legacy external',status:'ready',assets:[]});
  assert.equal((await request(legacy)).status,201,'unlinked external legacy models remain supported');
});

test('published controller renews a service-issued client session and revocation blocks access',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const {ReviewSessionController}=await import('../review-session-controller.mjs');
  const model=c.repository.getModel(c.item.model.id),sourceAuthorization={type:'direct_client_grant',id:'synthetic-controller-grant',version:1};
  let issuanceCount=0;
  const issue=async()=>{
    issuanceCount++;
    const url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:synthetic',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString(),sourceAuthorization});
    const response=await fetch(c.base+url,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':crypto.randomUUID()},body});
    if(!response.ok)throw Object.assign(new Error('service issuance failed'),{status:response.status});return response.json();
  };
  const redeem=(grant,token)=>fetch(`${c.base}/api/v1/sessions/redeem`,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({grant})});
  const initial=await issue();assert.equal(new URL(initial.embedUrl).pathname,`/session/${initial.grant}`);
  const first=await redeem(initial.grant);assert.equal(first.status,200);const session=await first.json();
  const channel={posts:[],postMessage(value){this.posts.push(value)},close(){},emit(data){return this.onmessage({data})}};
  const controller=new ReviewSessionController({origin:c.base,createChannel:()=>channel,issueGrant:async()=>({...await issue(),sessionMode:'published',modelId:model.id})});
  t.after(()=>controller.dispose());
  const channelId=crypto.randomUUID(),requestId=crypto.randomUUID(),expiresAt=session.expiresAt;
  assert.equal(controller.track(channelId,{sessionMode:'published',outputId:model.activeVersionId,modelId:model.id,modelVersionId:model.activeVersionId,sessionTtlSeconds:initial.sessionTtlSeconds}),true);
  await channel.emit({version:1,type:'ltds-viewer:ready',modelId:model.id,expiresAt});
  assert.equal(await channel.emit({version:1,type:'ltds-viewer:session-expiring',requestId,modelId:model.id,expiresAt}),true);
  const message=channel.posts.find(item=>item.type==='ltds-viewer:renew-session');assert.equal(message.requestId,requestId);
  const renewed=await redeem(message.grant,session.accessToken);assert.equal(renewed.status,200);const result=await renewed.json();
  assert.equal(result.sessionId,session.sessionId);assert.equal(result.accessToken,session.accessToken);
  assert.equal(await channel.emit({version:1,type:'ltds-viewer:session-renewed',requestId,modelId:model.id,expiresAt:result.expiresAt}),true);
  assert.equal(controller.records.get(channelId).awaitingRenewed,false);
  const pending=await issue(),url='/api/v1/published-sessions/source-authorization',body=JSON.stringify({sourceAuthorization});
  const revoked=await fetch(c.base+url,{method:'DELETE',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'DELETE',path:url,body}),'content-type':'application/json','idempotency-key':crypto.randomUUID()},body});
  assert.equal(revoked.status,200);
  assert.equal((await fetch(`${c.base}/api/v1/sessions/current`,{headers:{authorization:`Bearer ${session.accessToken}`}})).status,401);
  assert.equal((await redeem(pending.grant,session.accessToken)).status,410);
  await assert.rejects(issue(),{status:409});
  const before=channel.posts.filter(item=>item.type==='ltds-viewer:renew-session').length;
  const callsBefore=issuanceCount;
  assert.equal(await channel.emit({version:1,type:'ltds-viewer:session-expiring',requestId:crypto.randomUUID(),modelId:model.id,expiresAt:controller.records.get(channelId).expiresAt}),false);
  assert.equal(issuanceCount,callsBefore+1,'controller contacted the service after revocation');
  assert.equal(channel.posts.filter(item=>item.type==='ltds-viewer:renew-session').length,before);
});

test('service issuance rolls back grant and idempotency receipt when audit fails',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const model=c.repository.getModel(c.item.model.id),url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()}),key=crypto.randomUUID();
  const request=()=>fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':key},body});
  c.db.exec("CREATE TRIGGER reject_service_session_audit BEFORE INSERT ON audit_events WHEN NEW.action='session.created' BEGIN SELECT RAISE(ABORT,'audit failure'); END");
  assert.equal((await request()).status,500);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,0);
  c.db.exec('DROP TRIGGER reject_service_session_audit');
  const first=await request();assert.equal(first.status,201);const created=await first.json();
  const replay=await request();assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');assert.equal((await replay.json()).grant,created.grant);
  assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,1);
});

for(const state of ['archived task','purged task','archived project','purged project','archived output'])
  test(`service issuance rejects ${state}`,async t=>{
    const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
    if(state==='archived task')c.db.prepare("UPDATE processing_tasks SET status='archived' WHERE id=?").run(c.task.id);
    if(state==='purged task')c.db.prepare('UPDATE processing_tasks SET purged_at=? WHERE id=?').run(new Date().toISOString(),c.task.id);
    if(state==='archived project')c.db.prepare("UPDATE projects SET status='archived' WHERE id=?").run(c.project.id);
    if(state==='purged project')c.db.prepare('UPDATE projects SET purged_at=? WHERE id=?').run(new Date().toISOString(),c.project.id);
    if(state==='archived output')c.db.prepare("UPDATE model_outputs SET status='archived' WHERE id=?").run(c.item.versionId);
    const model=c.repository.getModel(c.item.model.id),url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()});
    const response=await fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':crypto.randomUUID()},body});
    assert.equal(response.status,404);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,0);
  });

test('service session receipt survives a lost success response',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const model=c.repository.getModel(c.item.model.id),url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()}),key=crypto.randomUUID();
  const request=()=>fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':key},body});
  c.failAfterCommit=true;assert.equal((await request()).status,500);
  const replay=await request();assert.equal(replay.status,201);assert.equal(replay.headers.get('idempotency-replayed'),'true');
  assert.ok((await replay.json()).grant);assert.equal(c.db.prepare('SELECT COUNT(*) n FROM session_grants').get().n,1);
});

test('mixed external legacy active version respects every linked parent',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  c.db.prepare("UPDATE models SET provider='terra' WHERE id=?").run(c.item.model.id);
  const original=c.repository.getModel(c.item.model.id);
  const legacy=c.repository.upsertModelVersion({provider:'terra',providerModelId:original.providerModelId,providerVersionId:'external-legacy',displayName:'Legacy active',status:'ready',assets:[]});
  assert.notEqual(legacy.activeVersionId,c.item.versionId);
  const url=`/api/v1/models/${legacy.id}/sessions`,body=JSON.stringify({modelVersionId:legacy.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()});
  const request=()=>fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':crypto.randomUUID()},body});
  assert.equal((await request()).status,201,'active parents preserve mixed legacy access');
  assert.ok(c.processing.trashTask(c.task.id,'ops:test'));
  assert.equal((await request()).status,404,'archived linked task blocks model-wide access');
});

test('service success receipt is written only once with its grant',async t=>{
  const c=await readyShareFixture(t);assert.equal((await c.request()).status,201);
  const model=c.repository.getModel(c.item.model.id),url=`/api/v1/models/${model.id}/sessions`,body=JSON.stringify({modelVersionId:model.activeVersionId,subject:'client:test',audience:'client',permissions:{view:true},authorizationExpiresAt:new Date(Date.now()+60000).toISOString()}),key=crypto.randomUUID();
  const original=c.repository.completeIdempotency.bind(c.repository);let writes=0;
  c.repository.completeIdempotency=(...args)=>{writes++;if(writes>1)throw new Error('unexpected second receipt write');return original(...args)};
  const request=()=>fetch(`${c.base}${url}`,{method:'POST',headers:{...signServiceRequest({secret:process.env.SERVICE_AUTH_SECRET,keyId:process.env.SERVICE_AUTH_KEY_ID,method:'POST',path:url,body}),'content-type':'application/json','idempotency-key':key},body});
  const first=await request();assert.equal(first.status,201);const created=await first.json();assert.equal(writes,1);
  const replay=await request();assert.equal(replay.status,201);assert.equal((await replay.json()).grant,created.grant);assert.equal(writes,1);
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
