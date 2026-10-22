"use strict";
// Local release proof: needs the immutable pre-change Git object. It never
// contacts production or changes a user database. This exercises the original
// HTTP routes with synthetic SQLite/storage fixtures, not an old container.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {execFileSync}=require('node:child_process'),Module=require('node:module'),test=require('node:test');
const express=require('express');
const {config}=require('../server/config'),{openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository');
const {signServiceRequest}=require('../server/serviceAuth');
const SOURCE='43f31609960af14b060964b1ca53d875f4d9eac2';
const EXPECTED_SHA='4fd14bddfdb1ddec4273eb5859eece34a3100f53342367565727bb2a7cd94e99';

test('previous Viewer HTTP routes accept new signed Ops fields on the retained old host',async t=>{
 const source=execFileSync('git',['show',SOURCE+':apps/viewer/server/processingApi.js'],{cwd:path.resolve(__dirname,'../../..')});
 assert.equal(crypto.createHash('sha256').update(source).digest('hex'),EXPECTED_SHA);
 const filename=path.resolve(__dirname,'../server/processingApi.js'),legacy=new Module(filename,module);
 legacy.filename=filename;legacy.paths=Module._nodeModulePaths(path.dirname(filename));legacy._compile(source.toString('utf8'),filename);
 const previous={opsBaseUrl:config.opsBaseUrl,opsControllerOrigins:config.opsControllerOrigins,serviceAuthSecret:config.serviceAuthSecret};
 const OLD='https://ops.ledgetopdroneservices.com';Object.assign(config,{opsBaseUrl:OLD,opsControllerOrigins:[OLD],serviceAuthSecret:'synthetic-rollout-signing-secret-at-least-thirty-two-characters'});
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-old-route-proof-')),db=openDatabase(path.join(root,'db.sqlite'));
 const processing=new ProcessingRepository(db),repository=new ViewerRepository(db),app=express();
 app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(legacy.exports.createProcessingApi({repository,processing,storage:{}}));
 const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
 t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();Object.assign(config,previous);fs.rmSync(root,{recursive:true,force:true});});
 const base=`http://127.0.0.1:${server.address().port}`,route='/api/v1/admin-grants';
 const issue=async targetSessionId=>{
  const body=JSON.stringify({controllerOrigin:OLD,...(targetSessionId?{targetSessionId}:{}),subject:'ops:controlled-user',permissions:['viewer.projects.read'],displayUnits:'imperial',authorizationExpiresAt:new Date(Date.now()+1800000).toISOString()});
  const response=await fetch(base+route,{method:'POST',headers:{...signServiceRequest({secret:config.serviceAuthSecret,keyId:config.serviceAuthKeyId,method:'POST',path:route,body}),'content-type':'application/json','Idempotency-Key':crypto.randomUUID()},body});
  assert.equal(response.status,201);return response.json();
 };
 const redeem=async(grant,token)=>{const response=await fetch(base+'/api/v1/admin-sessions/redeem',{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify({grant:grant.grant})});assert.equal(response.status,200);return response.json();};
 const first=await redeem(await issue());assert.equal(first.controllerOrigin,OLD);
 const renewed=await redeem(await issue(first.session.id),first.accessToken);
 assert.equal(renewed.controllerOrigin,OLD);assert.equal(renewed.session.id,first.session.id);assert.equal(renewed.accessToken,first.accessToken);
 t.diagnostic('Verified original API source '+SOURCE+' sha256='+EXPECTED_SHA+'; live image/browser acceptance remains separate.');
});
