"use strict";
const assert=require('node:assert/strict');
const test=require('node:test');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const crypto=require('node:crypto');
const express=require('express');
const {config}=require('../server/config');const {signServiceRequest}=require('../server/serviceAuth');
const {openDatabase}=require('../server/database');const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');const {createProcessingApi}=require('../server/processingApi');
const {workspaceConnectSources}=require('../server/workspaceConnectPolicy');
const {controllerOrigins}=require('../server/controllerOrigins');
const OLD='https://ops.ledgetopdroneservices.com',NEW='https://ops.ledgetop.app',PORTAL='https://portal.ledgetop.app';

async function fixture(t){
 const previous={production:config.production,opsBaseUrl:config.opsBaseUrl,opsControllerOrigins:config.opsControllerOrigins,serviceAuthSecret:config.serviceAuthSecret};
 Object.assign(config,{opsBaseUrl:OLD,opsControllerOrigins:[OLD,NEW],serviceAuthSecret:'synthetic-service-secret-at-least-thirty-two-characters'});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-controller-overlap-')),db=openDatabase(path.join(root,'viewer.sqlite'));
 const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),app=express();
 app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(createProcessingApi({repository,processing,storage:{}}));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();Object.assign(config,previous);fs.rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`;
 const issue=(controllerOrigin,targetSessionId,subject='ops:controlled-user')=>processing.createAdminGrant({controllerOrigin,targetSessionId,subject,
  permissions:['viewer.projects.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString(),authorizationExpiresAt:new Date(Date.now()+1800000).toISOString()});
 const redeem=(grant,token)=>fetch(base+'/api/v1/admin-sessions/redeem',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({grant:grant.token})});
 return{root,db,processing,base,issue,redeem};
}

test('old and new exact controllers retain stable sessions through global default changes',async t=>{
 const f=await fixture(t);
 for(const origin of [OLD,NEW]){
  const first=await (await f.redeem(f.issue(origin))).json();assert.equal(first.controllerOrigin,origin);
  config.opsBaseUrl=NEW;
  const response=await f.redeem(f.issue(origin,first.session.id),first.accessToken);assert.equal(response.status,200);
  const renewed=await response.json();assert.equal(renewed.controllerOrigin,origin);assert.equal(renewed.accessToken,first.accessToken);assert.equal(renewed.session.id,first.session.id);
  const current=await fetch(f.base+'/api/v1/admin-sessions/current',{headers:{authorization:`Bearer ${first.accessToken}`}});
  assert.equal(current.status,200);assert.equal((await current.json()).controllerOrigin,origin);
 }
});

test('renewal cannot change controller, subject, target session or consume another sessions grant',async t=>{
 const f=await fixture(t),old=await(await f.redeem(f.issue(OLD))).json(),other=await(await f.redeem(f.issue(OLD))).json();
 assert.equal((await f.redeem(f.issue(undefined))).status,410,'new unpinned grants do not use a legacy fallback');
 const nullToken='new-unpinned-bearer-token-0000000001';
 f.processing.createAdminSession({tokenHash:crypto.createHash('sha256').update(nullToken).digest('hex'),subject:'ops:controlled-user',permissions:[],expiresAt:new Date(Date.now()+60000).toISOString()});
 assert.equal((await fetch(f.base+'/api/v1/admin-sessions/current',{headers:{authorization:`Bearer ${nullToken}`}})).status,401);

 for(const grant of [f.issue(NEW,old.session.id),f.issue(OLD,old.session.id,'ops:another-user'),f.issue(OLD,other.session.id)]){
  assert.equal((await f.redeem(grant,old.accessToken)).status,410);
  assert.equal(f.db.prepare('SELECT redeemed_at FROM admin_grants WHERE token_hash=?').get(crypto.createHash('sha256').update(grant.token).digest('hex')).redeemed_at,null);
 }
 const target=f.issue(OLD,old.session.id);assert.equal((await f.redeem(target)).status,410);
 assert.equal((await f.redeem(target,other.accessToken)).status,410);
 assert.equal((await f.redeem(target,old.accessToken)).status,200);
 assert.equal((await f.redeem(target,old.accessToken)).status,410);
 assert.throws(()=>f.db.prepare('UPDATE admin_sessions SET controller_origin=? WHERE id=?').run(NEW,old.session.id),/immutable/);
});

test('signed grant endpoint requires an exact approved controller and binds the signed body',async t=>{
 const f=await fixture(t),route='/api/v1/admin-grants';
 const send=async(origin,signedOrigin=origin,targetSessionId)=>{
  const data=value=>JSON.stringify({controllerOrigin:value,targetSessionId,subject:'ops:controlled-user',permissions:['viewer.projects.read'],displayUnits:'imperial',authorizationExpiresAt:new Date(Date.now()+1800000).toISOString()});
  const body=data(origin),headers=signServiceRequest({secret:config.serviceAuthSecret,keyId:config.serviceAuthKeyId,method:'POST',path:route,body:origin===signedOrigin?body:data(signedOrigin)});
  return fetch(f.base+route,{method:'POST',headers:{...headers,'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body});
 };
 for(const origin of [undefined,PORTAL,'https://evil.example',NEW+'/',NEW+'/path','https://*.ledgetop.app'])assert.equal((await send(origin)).status,400,String(origin));
 assert.equal((await send(NEW,OLD)).status,401);
 for(const origin of [OLD,NEW]){
  const response=await send(origin);assert.equal(response.status,201);const grant=await response.json();
  const redeemed=await f.redeem({token:grant.grant});assert.equal(redeemed.status,200);assert.equal((await redeemed.json()).controllerOrigin,origin);
 }
 assert.equal((await send(NEW,NEW,'invalid')).status,400);
});

test('processing CORS and workspace CSP admit only exact controllers, never portal or broad aliases',async t=>{
 const f=await fixture(t);
 for(const origin of [OLD,NEW,PORTAL,'https://evil.example',NEW+'.evil.example']){
  const response=await fetch(f.base+'/api/v1/admin-sessions/redeem',{method:'OPTIONS',headers:{Origin:origin,'Access-Control-Request-Method':'POST'}});
  assert.equal(response.status,[OLD,NEW].includes(origin)?204:403);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'),[OLD,NEW].includes(origin)?origin:null);
 }
 const base="'self' blob: https://server.arcgisonline.com";
 assert.equal(workspaceConnectSources('/workspace',OLD,[OLD,NEW]),base+' '+OLD+' '+NEW);
 for(const route of ['/view/public-token','/embed/public-token','/'])assert.equal(workspaceConnectSources(route,OLD,[OLD,NEW]),base);
 for(const value of [OLD+',',OLD+','+OLD,OLD+',https://*.ledgetop.app',PORTAL,OLD+','+PORTAL])assert.deepEqual(controllerOrigins(OLD,value),[]);
 assert.equal(workspaceConnectSources('/workspace',OLD,[OLD,NEW+'/path']),base);
});

test('migration pins authentic historical null rows once using pre-upgrade authority, not request fallback',async t=>{
 const previous={opsBaseUrl:config.opsBaseUrl,opsControllerOrigins:config.opsControllerOrigins};
 const staging='https://ops-staging.example.test';Object.assign(config,{opsBaseUrl:staging,opsControllerOrigins:[staging,NEW]});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-controller-migration-')),file=path.join(root,'db.sqlite');
 let db=openDatabase(file);t.after(()=>{db?.close();Object.assign(config,previous);fs.rmSync(root,{recursive:true,force:true});});
 // Reconstruct the deployed v38 shape locally, with authentic pre-column rows.
 db.exec(`DROP TRIGGER admin_session_controller_immutable; ALTER TABLE admin_sessions DROP COLUMN controller_origin;
 ALTER TABLE admin_grants DROP COLUMN controller_origin; ALTER TABLE admin_grants DROP COLUMN target_session_id;
 DELETE FROM schema_migrations WHERE version=39; DELETE FROM app_state WHERE key='workspace_legacy_controller_origin';`);
 const expires=new Date(Date.now()+1800000).toISOString();
 const historicalToken='historical-pending-grant-token-000000001';
 db.prepare('INSERT INTO admin_grants(id,token_hash,subject,permissions_json,display_units,expires_at,authorization_expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)').run('historical-grant',crypto.createHash('sha256').update(historicalToken).digest('hex'),'ops:historical','[]','imperial',expires,expires,expires);
 db.prepare('INSERT INTO admin_sessions(id,token_hash,subject,permissions_json,display_units,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run('historical-session','historical-hash','ops:historical','[]','imperial',expires,expires,expires);
 db.close();db=openDatabase(file);
 assert.equal(db.prepare('SELECT controller_origin FROM admin_sessions').get().controller_origin,staging);
 assert.equal(db.prepare("SELECT value FROM app_state WHERE key='workspace_legacy_controller_origin'").get().value,staging);
 const processing=new ProcessingRepository(db);
 assert.equal(processing.redeemAdminGrant(historicalToken,Date.now(),{allowedControllerOrigins:[staging]}).controllerOrigin,staging);
 const newUnpinned=processing.createAdminSession({tokenHash:'new-null-hash',subject:'ops:new-null',permissions:[],expiresAt:expires});
 assert.equal(newUnpinned.controllerOrigin,null,'new null rows never receive historical fallback');
 config.opsBaseUrl=NEW;db.close();db=openDatabase(file);
 assert.equal(db.prepare('SELECT controller_origin FROM admin_sessions WHERE id=?').get('historical-session').controller_origin,staging);
 assert.equal(db.prepare("SELECT value FROM app_state WHERE key='workspace_legacy_controller_origin'").get().value,staging);
 assert.equal(db.prepare('SELECT controller_origin FROM admin_sessions WHERE id=?').get(newUnpinned.id).controller_origin,null);
});


test('invalid pre-upgrade authority rolls back the entire controller migration',t=>{
 const {DatabaseSync}=require('node:sqlite'),{applyMigrations}=require('../server/database');
 const previous={opsBaseUrl:config.opsBaseUrl,opsControllerOrigins:config.opsControllerOrigins};
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-controller-rollback-')),db=new DatabaseSync(path.join(root,'db.sqlite'));
 t.after(()=>{db.close();Object.assign(config,previous);fs.rmSync(root,{recursive:true,force:true});});
 Object.assign(config,{opsBaseUrl:OLD,opsControllerOrigins:[]});
 assert.throws(()=>applyMigrations(db),/Legacy workspace controller/);
 assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,38);
 assert.equal(db.prepare('PRAGMA table_info(admin_sessions)').all().some(row=>row.name==='controller_origin'),false);
 assert.equal(db.prepare("SELECT value FROM app_state WHERE key='workspace_legacy_controller_origin'").get(),undefined);
 Object.assign(config,{opsBaseUrl:OLD,opsControllerOrigins:[OLD,NEW]});applyMigrations(db);
 assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,40);
 assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
});


test('an explicitly retained previous Technologies staff alias supports its own pinned session',async t=>{
 const f=await fixture(t),retained='https://ops.ledgetoptechnologies.com';config.opsControllerOrigins.push(retained);
 const response=await f.redeem(f.issue(retained));assert.equal(response.status,200);
 const session=await response.json();assert.equal(session.controllerOrigin,retained);
 const renewed=await f.redeem(f.issue(retained,session.session.id),session.accessToken);assert.equal(renewed.status,200);
 assert.equal((await renewed.json()).controllerOrigin,retained);
 const preflight=await fetch(f.base+'/api/v1/admin-sessions/redeem',{method:'OPTIONS',headers:{Origin:retained}});
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),retained);
});


test('explicit loopback controllers with ports remain usable only outside production',async t=>{
 const f=await fixture(t),loopbacks=['http://127.0.0.1:3030','http://localhost:3031','https://localhost:3443'];
 config.production=false;config.opsBaseUrl=loopbacks[0];config.opsControllerOrigins=controllerOrigins(loopbacks[0],loopbacks.join(','),true);
 assert.deepEqual(config.opsControllerOrigins,loopbacks);
 for(const origin of loopbacks){
  const response=await f.redeem(f.issue(origin));assert.equal(response.status,200);
  const session=await response.json();assert.equal(session.controllerOrigin,origin);
  const current=await fetch(f.base+'/api/v1/admin-sessions/current',{headers:{authorization:`Bearer ${session.accessToken}`}});assert.equal(current.status,200);
  const preflight=await fetch(f.base+'/api/v1/admin-sessions/redeem',{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,204);
 }
 assert.equal(workspaceConnectSources('/workspace',loopbacks[0],loopbacks,true),"'self' blob: https://server.arcgisonline.com "+loopbacks.join(' '));
 assert.deepEqual(controllerOrigins(loopbacks[0],loopbacks.join(',')),[],'production does not admit HTTP or loopback port exceptions');
 for(const rejected of ['http://192.168.50.90:3030','http://localhost.evil.example:3030','https://ops.example.test:3443'])
  assert.deepEqual(controllerOrigins(loopbacks[0],loopbacks[0]+','+rejected,true),[]);
 config.production=true;
 for(const origin of loopbacks){
  const preflight=await fetch(f.base+'/api/v1/admin-sessions/redeem',{method:'OPTIONS',headers:{Origin:origin}});assert.equal(preflight.status,403);
 }
});
