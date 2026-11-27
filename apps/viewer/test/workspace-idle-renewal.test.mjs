import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {requestWorkspaceRenewalGrant} from '../workspace-renewal-transport.mjs';
import {WorkspaceSessionRenewal} from '../workspace-renewal.mjs';
import {rememberModelSession,resumeExpiredModelSession} from '../model-session-resume.mjs';

// Synthetic values only. Reserved .test hosts; no real host is contacted.
const OPS='https://ops.example.test',VIEWER='https://viewer.example.test',TOKEN='t'.repeat(40),GRANT='g'.repeat(40);
const SESSION='workspace_session_0000000000000001',ID='a7e240dc-985d-4bda-a7b8-17ad766a4438',CSRF='c'.repeat(43);
const endpoint=OPS+'/api/viewer/workspace/session-renewal';
const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function response(url,body,status=200,overrides={}){const result=new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});Object.defineProperty(result,'url',{value:url});for(const[key,value]of Object.entries(overrides))Object.defineProperty(result,key,{value});return result;}
const challenge=()=>({protocolVersion:1,challenge:CSRF,expiresAt:Math.floor(Date.now()/1000)+120});
const grant=()=>({protocolVersion:1,requestId:ID,sessionId:SESSION,grant:GRANT,grantExpiresAt:new Date(Date.now()+60000).toISOString(),sessionTtlSeconds:1800,redeemUrl:VIEWER+'/api/v1/admin-sessions/redeem'});

function apiHarness({renew}){
  const state={token:TOKEN,adminSession:{id:SESSION}},clears=[],calls=[];
  const context={state,crypto,JSON,Error,Object,DOMException,
    workspaceRenewal:{waitForRenewal:async args=>renew(context,args)},
    workspaceFetch:async()=>assert.fail('guarded reads use fetch directly'),
    fetch:async(path,init)=>{calls.push({path,init});return {status:401,ok:false,json:async()=>({error:'authentication_required'}),headers:new Headers()};},
    clearWorkspaceAuthorization:reason=>clears.push(reason??'unauthorized'),
    responseError:(message,status)=>Object.assign(new Error(message),{status}),clientAccessDiagnostic:()=>({})};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('async function api('),source.indexOf('async function authenticatedDownload('))+'\nthis.run=api;',context);
  return {...context,clears,calls};
}

test('a background read that gets 401 waits for silent renewal and never signs the tab out',async()=>{
  const ctx=apiHarness({renew:async(context,args)=>{assert.equal(args.whileExpired,true);context.state.adminSession={id:SESSION,renewed:true};return true;}});
  const session=ctx.state.adminSession,guard=()=>ctx.state.adminSession===session;
  await assert.rejects(ctx.run('/api/v1/projects/p/folders',{recoveryGuard:guard}),error=>error.code==='recovery_session_changed');
  assert.deepEqual(ctx.clears,[]);assert.equal(ctx.calls.length,1);
});

test('a background read still ends the session when renewal cannot succeed',async()=>{
  const ctx=apiHarness({renew:async()=>false}),session=ctx.state.adminSession;
  await assert.rejects(ctx.run('/api/v1/tasks/x',{recoveryGuard:()=>ctx.state.adminSession===session}),error=>error.status===401);
  assert.deepEqual(ctx.clears,['unauthorized']);
});

function renewalHarness(fetchImpl,{expiresInMs=120000,allowExpired=false,now=()=>Date.now()}={}){
  const timers=[],listeners=new Map(),documentListeners=new Map(),sessions=[],expired=[];
  const envelope={accessToken:TOKEN,controllerOrigin:OPS,session:{id:SESSION,subject:'ops:staff',expiresAt:new Date(Date.now()+expiresInMs).toISOString()}};
  const renewal=new WorkspaceSessionRenewal({controllerWindow:null,envelope,accessToken:TOKEN,allowExpired,fetchImpl,now,
    windowRef:{location:{origin:VIEWER},addEventListener:(key,value)=>listeners.set(key,value),removeEventListener:key=>listeners.delete(key)},
    documentRef:{visibilityState:'visible',addEventListener:(key,value)=>documentListeners.set(key,value),removeEventListener:key=>documentListeners.delete(key)},
    randomUUID:()=>ID,setTimer:(handler,delay)=>{const timer={handler,delay};timers.push(timer);return timer;},clearTimer:timer=>{timer.cleared=true;},
    onSession:value=>sessions.push(value),onExpired:reason=>expired.push(reason)});
  return {renewal,envelope,timers,listeners,documentListeners,sessions,expired};
}
const okFetch=context=>async url=>response(url.startsWith('/')?VIEWER+url:url,url.endsWith('/challenge')?challenge():url===endpoint?grant():{...context.envelope,session:{...context.envelope.session,expiresAt:new Date(Date.now()+1800000).toISOString()}});

test('a reloaded tab whose session lapsed renews silently with its own bearer',async()=>{
  let context;const fetchImpl=(...args)=>okFetch(context)(...args);
  assert.throws(()=>renewalHarness(fetchImpl,{expiresInMs:-60000}),/expired/);
  context=renewalHarness(fetchImpl,{expiresInMs:-60000,allowExpired:true});
  const waiting=context.renewal.waitForRenewal({whileExpired:true});context.renewal.start();
  assert.equal(await waiting,true);assert.equal(context.sessions.length,1);assert.deepEqual(context.expired,[]);
  assert.ok(context.renewal.expiresAtMs>Date.now());context.renewal.dispose();
});

test('a page resumed from a frozen or sleeping state renews when due',async()=>{
  let context;const calls=[];
  context=renewalHarness(async(...args)=>{calls.push(args[0]);return okFetch(context)(...args);},{expiresInMs:60000});
  context.renewal.start();assert.equal(typeof context.documentListeners.get('resume'),'function');
  context.documentListeners.get('resume')();await tick();await tick();await tick();
  assert.equal(calls[0],endpoint+'/challenge');context.renewal.dispose();
  assert.equal(context.documentListeners.has('resume'),false);
});

test('an Access sign-in redirect is told apart from an outage',async()=>{
  const calls=[];
  await assert.rejects(requestWorkspaceRenewalGrant({controllerOrigin:OPS,viewerOrigin:VIEWER,subject:'ops:staff',sessionId:SESSION,requestId:ID,
    fetchImpl:async(url,init)=>{calls.push(init);return response(url,{},200,{type:'opaqueredirect',status:0,ok:false,headers:new Headers()});}}),error=>error.renewalAuthenticationRequired===true);
  assert.equal(calls[0].redirect,'manual');
  await assert.rejects(requestWorkspaceRenewalGrant({controllerOrigin:OPS,viewerOrigin:VIEWER,subject:'ops:staff',sessionId:SESSION,requestId:ID,
    fetchImpl:async()=>{throw new TypeError('Failed to fetch');}}),error=>error.renewalAuthenticationRequired!==true);
});

test('a sign-in answer before expiry keeps the session; only after expiry does it end',async()=>{
  let clock=Date.now();const context=renewalHarness(async url=>response(url,{error:'Cloudflare Access authentication required'},401),{expiresInMs:120000,now:()=>clock});
  context.renewal.start();context.renewal.requestRenewal('timer');await tick();await tick();
  assert.deepEqual(context.expired,[]);assert.equal(context.renewal.accessToken,TOKEN);
  clock+=180000;context.renewal.retryAttempt=0;context.renewal.pendingRequestId=null;context.renewal.requestRenewal('expiry');await tick();await tick();
  assert.deepEqual(context.expired,['revoked']);
});

test('the expiry timer gets a fresh retry run after earlier retries were spent',async()=>{
  let clock=Date.now();const calls=[];const context=renewalHarness(async url=>{calls.push(url);throw new TypeError('Failed to fetch');},{expiresInMs:120000,now:()=>clock});
  context.renewal.start();context.renewal.retryAttempt=5;
  const expiry=context.timers.find(timer=>timer.delay>=119000&&timer.delay<=120000);clock+=121000;expiry.handler();await tick();
  assert.equal(calls.length,1);context.renewal.dispose();
});

test('the workspace keeps its tab state when renewal ends and on reload with a lapsed session',()=>{
  assert.match(source,/onExpired:\(\)=>clearWorkspaceAuthorization\('expired'\)/);
  assert.match(source,/if\(response\.status===401\)\{if\(await resumeLapsedWorkspaceSession\(\)\)return true;/);
  assert.match(source,/function rememberWorkspaceSession\(/);
});

function channelPair(){const sent=[],listeners=new Set();return {sent,channel:{postMessage:message=>sent.push(message),addEventListener:(type,listener)=>listeners.add(listener),removeEventListener:(type,listener)=>listeners.delete(listener)},deliver:data=>{for(const listener of [...listeners])listener({data});},listeners};}
function memoryStorage(){const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,String(value)),removeItem:key=>map.delete(key)};}
const CONTROLLER='0f0e2c63-0a6c-4c43-9a51-2b6a0ad0e4a1',MODEL_GRANT='5c7a1f0e-3b7d-4c55-8a51-0d9c0a8e6b11';

test('a reloaded model tab asks its workspace for a fresh session instead of showing unavailable',async()=>{
  const storage=memoryStorage(),{channel,sent,deliver,listeners}=channelPair(),expiresAt=new Date(Date.now()-60000).toISOString();
  rememberModelSession(storage,CONTROLLER,{model:{id:'model-1'},expiresAt});
  const renewed={model:{id:'model-1'},expiresAt:new Date(Date.now()+1800000).toISOString()};
  const resumed=resumeExpiredModelSession({channel,storage,controllerId:CONTROLLER,randomUUID:()=>ID,redeem:async value=>{assert.equal(value,MODEL_GRANT);return renewed;}});
  assert.deepEqual(sent[0],{version:1,type:'ltds-viewer:session-expiring',requestId:ID,modelId:'model-1',expiresAt});
  deliver({version:1,type:'ltds-viewer:renew-session',requestId:'other',grant:MODEL_GRANT});
  deliver({version:1,type:'ltds-viewer:renew-session',requestId:ID,grant:MODEL_GRANT});
  assert.equal(await resumed,renewed);
  assert.deepEqual(sent[1],{version:1,type:'ltds-viewer:session-renewed',requestId:ID,modelId:'model-1',expiresAt:renewed.expiresAt});
  assert.equal(listeners.size,0);
});

test('a model tab with no workspace answer falls back to the unavailable page',async()=>{
  const storage=memoryStorage(),{channel,deliver}=channelPair();let fire;
  assert.equal(await resumeExpiredModelSession({channel,storage,controllerId:CONTROLLER,randomUUID:()=>ID,redeem:async()=>assert.fail()}),null);
  rememberModelSession(storage,CONTROLLER,{model:{id:'model-1'},expiresAt:new Date().toISOString()});
  const timedOut=resumeExpiredModelSession({channel,storage,controllerId:CONTROLLER,randomUUID:()=>ID,redeem:async()=>assert.fail(),setTimer:handler=>{fire=handler;return 1;},clearTimer:()=>{}});
  fire();assert.equal(await timedOut,null);
  const refused=resumeExpiredModelSession({channel,storage,controllerId:CONTROLLER,randomUUID:()=>ID,redeem:async()=>assert.fail()});
  deliver({version:1,type:'ltds-viewer:session-unavailable',requestId:ID,modelId:'model-1',reason:'authorization-required'});
  assert.equal(await refused,null);
});
