'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const test=require('node:test');
const {createClientGrantProxy,LOCAL_PATH,REMOTE_PATH}=require('../server/clientGrantProxy');
const {canonicalViewerEvent}=require('../server/viewerEvents');

test('client grant proxy signs an exact POST envelope and never forwards browser credentials',async t=>{
  const secret='s'.repeat(32),calls=[],diagnostics=[];
  const fetchImpl=async(url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({grants:[],projects:[],associations:[]}),{status:200,headers:{'content-type':'application/json'}})};
  const app=express();app.use(express.json());
  const authorize=permission=>(req,res,next)=>{assert.equal(permission,'viewer.client_grants.manage');if(req.get('authorization')!=='Bearer valid')return res.sendStatus(401);req.adminPrincipal={subject:'ops:staff-one'};next()};
  createClientGrantProxy({config:{clientViewerSharesEnabled:true,opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:secret,viewerEventKeyId:'viewer-v1'},authorize,fetchImpl,diagnostic:record=>diagnostics.push(record)}).mount(app);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`,{headers:{authorization:'Bearer valid',cookie:'admin=secret',origin:'https://evil.example'}});
  assert.equal(response.status,200);assert.deepEqual(diagnostics,[]);assert.equal(calls.length,1);assert.equal(calls[0].url,`https://incoming.ledgetopdroneservices.com${REMOTE_PATH}`);assert.equal(calls[0].init.method,'POST');assert.equal(calls[0].init.credentials,undefined);assert.equal(calls[0].init.headers.Cookie,undefined);
  const body=calls[0].init.body,envelope=JSON.parse(body);assert.deepEqual(envelope,{subject:'ops:staff-one',action:'list'});
  const h=calls[0].init.headers,hash=crypto.createHash('sha256').update(body).digest('hex'),canonical=canonicalViewerEvent({method:'POST',path:REMOTE_PATH,timestamp:h['X-LTDS-Viewer-Timestamp'],nonce:h['X-LTDS-Viewer-Nonce'],bodySha256:hash}),expected=crypto.createHmac('sha256',secret).update(canonical).digest('base64url');assert.equal(h['X-LTDS-Viewer-Signature'],expected);
});

test('client grant proxy rejects absent permission before making an Ops request',async t=>{let called=false;const app=express();app.use(express.json());const authorize=()=> (_req,res)=>res.sendStatus(403);createClientGrantProxy({config:{},authorize,fetchImpl:async()=>{called=true}}).mount(app);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`);assert.equal(response.status,403);assert.equal(called,false)});

for(const [name,response] of [['redirect',new Response('',{status:302,headers:{location:'https://evil.example'}})],['oversize',new Response('{}',{status:200,headers:{'content-length':String(1024*1024+1)}})],['malformed',new Response('{',{status:200})]])test(`client grant proxy fails closed on ${name} Ops responses`,async t=>{const app=express();const authorize=()=> (req,_res,next)=>{req.adminPrincipal={subject:'ops:staff-one'};next()};createClientGrantProxy({config:{opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:'s'.repeat(32),viewerEventKeyId:'viewer-v1'},authorize,fetchImpl:async(_url,init)=>{if(name==='redirect'&&init.redirect==='error')throw new TypeError('redirect');return response.clone()}}).mount(app);const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s))});t.after(()=>new Promise(resolve=>server.close(resolve)));const result=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`);assert.equal(result.status,502);assert.equal((await result.json()).code,'operations_unavailable')});

const diagnosticCases = [
  ['upstream denial', () => new Response(JSON.stringify({error:'private-upstream-value'}), {status:403}), 403, 403, 'upstream_rejection', 'operations_request_failed'],
  ['upstream service failure', () => new Response('{}', {status:503}), 502, 503, 'upstream_rejection', 'operations_request_failed'],
  ['non-JSON denial', () => new Response('private-upstream-value', {status:403}), 502, 403, 'response_json', 'operations_unavailable'],
  ['invalid snapshot', () => new Response('{}', {status:200}), 502, 200, 'response_schema', 'operations_unavailable'],
  ['transport failure', () => { throw new Error('private-upstream-value'); }, 502, null, 'request', 'operations_unavailable'],
  ['oversized body declaration', () => new Response('{}', {status:200,headers:{'content-length':String(1024*1024+1)}}), 502, 200, 'response_headers', 'operations_unavailable'],
];
for (const [name, fetchImpl, status, upstreamStatus, stage, code] of diagnosticCases) test(`client grant diagnostic records bounded metadata for ${name} without credentials`, async t => {
  const records=[],app=express();
  const authorize=()=> (req,_res,next)=>{req.adminPrincipal={subject:'ops:private-staff-value'};next();};
  createClientGrantProxy({config:{opsAutomationBaseUrl:'https://private-origin.example',viewerEventSecret:'private-signing-secret'.repeat(4),viewerEventKeyId:'private-key-id'},authorize,fetchImpl,diagnostic:record=>records.push(record)}).mount(app);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`,{headers:{authorization:'Bearer private-browser-token',cookie:'private-cookie=value'}});
  assert.equal(response.status,status);assert.equal((await response.json()).code,code);assert.equal(records.length,1);
  const record=records[0];assert.deepEqual(Object.keys(record).sort(),['action','code','event','requestId','stage','status','timestamp','upstreamStatus'].sort());
  assert.equal(record.event,'client_grant_proxy_failed');assert.equal(record.action,'list');assert.equal(record.stage,stage);assert.equal(record.status,status);assert.equal(record.upstreamStatus,upstreamStatus);assert.equal(record.code,code);
  assert.match(record.requestId,/^[0-9a-f-]{36}$/);assert.equal(response.headers.get('x-ltds-client-access-request'),record.requestId);assert.equal(new Date(record.timestamp).toISOString(),record.timestamp);
  assert.doesNotMatch(JSON.stringify(record),/private-|Bearer|cookie|https:/);
});

test('a failing diagnostic sink cannot change proxy rejection',async t=>{
  const app=express(),authorize=()=> (req,_res,next)=>{req.adminPrincipal={subject:'ops:staff-one'};next();};
  createClientGrantProxy({config:{opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:'s'.repeat(32),viewerEventKeyId:'viewer-v1'},authorize,fetchImpl:async()=>new Response('{}',{status:403}),diagnostic:()=>{throw new Error('sink unavailable');}}).mount(app);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`);assert.equal(response.status,403);assert.equal((await response.json()).code,'operations_request_failed');
});

for (const [method,action,body] of [['POST','create',{grant:{note:'private-client-value'}}],['DELETE','revoke',{grantId:'grant-one',reason:'private-client-value'}]]) test(`client grant ${action} diagnostics omit submitted data and receipt headers`,async t=>{
  const records=[],app=express();app.use(express.json());
  const authorize=()=> (req,_res,next)=>{req.adminPrincipal={subject:'ops:private-staff-value'};next();};
  createClientGrantProxy({config:{opsAutomationBaseUrl:'https://incoming.ledgetopdroneservices.com',viewerEventSecret:'private-secret'.repeat(4),viewerEventKeyId:'viewer-v1'},authorize,fetchImpl:async()=>new Response('{}',{status:403}),diagnostic:record=>records.push(record)}).mount(app);
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  const response=await fetch(`http://127.0.0.1:${server.address().port}${LOCAL_PATH}`,{method,headers:{'Content-Type':'application/json','Idempotency-Key':'private-receipt-key-12345','X-LTDS-Client-Access-Request':'private-forged-id'},body:JSON.stringify(body)});
  assert.equal(response.status,403);assert.equal(records.length,1);assert.equal(records[0].action,action);assert.equal(records[0].stage,'upstream_rejection');assert.doesNotMatch(JSON.stringify(records),/private-|grant-one/);
  assert.notEqual(response.headers.get('x-ltds-client-access-request'),'private-forged-id');assert.equal(response.headers.get('x-ltds-client-access-request'),records[0].requestId);
});
