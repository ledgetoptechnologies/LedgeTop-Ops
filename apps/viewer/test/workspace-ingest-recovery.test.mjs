import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { canRecoverExistingResult, recoverExistingResult } from '../workspace-ingest-recovery.mjs';

const session = {id:'session-a',subject:'staff-a',expiresAt:'2099-01-01T00:00:00Z',permissions:['viewer.processing.write']};
const getSession = () => session;
const eligible = () => ({ recovery: { kind: 'ingest', available: true, remainingRequests: 1 } });
function memoryStorage() { const map = new Map(); return { getItem: k => map.get(k) ?? null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k) }; }

test('existing result recovery requires fresh server eligibility and current write permission', () => {
  assert.equal(canRecoverExistingResult(eligible(), true), true);
  for (const diagnostic of [null, {}, { recovery: { kind: 'ingest', available: false } },
    { recovery: { kind: 'other', available: true } }, { ...eligible(), loading: true },
    { ...eligible(), error: 'unavailable' }]) assert.equal(canRecoverExistingResult(diagnostic, true), false);
  assert.equal(canRecoverExistingResult(eligible(), false), false);
});

test('concurrent activation issues one same-attempt request and invalidates stale eligibility', async () => {
  const calls = [], storage = memoryStorage(), diagnostic = eligible(); let resolve, refreshed=0;
  const mutate = (...args) => { calls.push(args); return new Promise(r => { resolve=r; }); };
  const options={storage,makeId:()=> 'intent-1',getSession};
  const first = recoverExistingResult(diagnostic,true,'attempt/one',mutate,()=>{refreshed++;},options);
  assert.equal(canRecoverExistingResult(diagnostic,true),false);
  await recoverExistingResult(eligible(),true,'attempt/one',mutate,()=>{},options);
  assert.equal(calls.length,1);
  assert.equal(calls[0][0],'/api/v1/attempts/attempt%2Fone/recover-ingest');assert.equal(calls[0][1].headers['Idempotency-Key'],'intent-1');assert.equal(calls[0][1].recoveryGuard(),true);
  resolve({accepted:true}); assert.deepEqual(await first,{accepted:true}); assert.equal(refreshed,1);
  assert.equal(storage.getItem('ltds-viewer-ingest-recovery:attempt/one'),null);
});

test('uncertain response refreshes diagnostics and reuses identity after page-like reload', async () => {
  const storage=memoryStorage(),keys=[],first=eligible();let refreshed=0;
  const options={storage,makeId:()=> 'intent-original',getSession};
  await recoverExistingResult(first,true,'attempt',async (_path,options)=>{keys.push(options.headers['Idempotency-Key']);return undefined;},()=>{refreshed++;},options);
  assert.equal(canRecoverExistingResult(first,true),false);assert.equal(refreshed,1);
  const fresh=eligible();await recoverExistingResult(fresh,true,'attempt',async (_path,options)=>{keys.push(options.headers['Idempotency-Key']);return {accepted:true};},()=>{refreshed++;},{storage,makeId:()=> 'wrong-new-key',getSession});
  assert.deepEqual(keys,['intent-original','intent-original']);assert.equal(refreshed,2);
});

test('definitive rejection closes the intent while in-progress retains it', async () => {
  const storage=memoryStorage(), options={storage,makeId:()=> 'intent-1',getSession};
  await recoverExistingResult(eligible(),true,'a',async (_p,_o,_m,failed)=>{failed({status:409,code:'ingest_recovery_state_changed'});},()=>{},options);
  assert.equal(storage.getItem('ltds-viewer-ingest-recovery:a'),null);
  await recoverExistingResult(eligible(),true,'b',async (_p,_o,_m,failed)=>{failed({status:409,code:'idempotency_in_progress'});},()=>{},options);
  assert.equal(JSON.parse(storage.getItem('ltds-viewer-ingest-recovery:b')).key,'intent-1');
  await recoverExistingResult(eligible(),true,'c',async (_p,_o,_m,failed)=>{failed({status:403},{submitted:true});},()=>{},options);
  assert.equal(JSON.parse(storage.getItem('ltds-viewer-ingest-recovery:c')).key,'intent-1','post-acceptance refresh failures remain uncertain');
});

test('thrown transport failure retains identity and refreshes without reusing stale eligibility', async () => {
  const storage=memoryStorage(), diagnostic=eligible(); let refreshed=0;
  await assert.rejects(recoverExistingResult(diagnostic,true,'attempt-throw',async()=>{throw Error('transport');},()=>{refreshed++;},{storage,makeId:()=> 'saved-intent',getSession}),/transport/);
  assert.equal(refreshed,1);assert.equal(canRecoverExistingResult(diagnostic,true),false);
  assert.equal(JSON.parse(storage.getItem('ltds-viewer-ingest-recovery:attempt-throw')).key,'saved-intent');
});

test('uncertain intent is held on session change or receipt-age horizon', async () => {
  const storage=memoryStorage();let current={...session},clock=1000000000,calls=0,holds=0;const opts={storage,makeId:()=> 'same-key',getSession:()=>current,now:()=>clock,onHold:()=>holds++};
  await recoverExistingResult(eligible(),true,'age',async()=>{calls++;},()=>{},opts);
  current={...session,id:'session-b'};await recoverExistingResult(eligible(),true,'age',async()=>{calls++;},()=>{},opts);
  current={...session};clock+=14*60*1000;await recoverExistingResult(eligible(),true,'age',async()=>{calls++;},()=>{},opts);
  assert.equal(calls,1);assert.equal(holds,2);assert.equal(JSON.parse(storage.getItem('ltds-viewer-ingest-recovery:age')).key,'same-key');
});

test('expired session cannot dispatch a recovery request', async () => {
  let calls=0,held=0;const storage=memoryStorage(),expired={...session,expiresAt:'2000-01-01T00:00:00Z'};
  await recoverExistingResult(eligible(),true,'expired',async()=>{calls++;},()=>{},{storage,makeId:()=> 'key',getSession:()=>expired,onHold:()=>held++});
  assert.equal(calls,0);assert.equal(held,1);
});

test('dispatch guard observes changed session and revoked permission', async () => {
  const storage=memoryStorage();let current={...session};const opts={storage,makeId:()=> 'same-key',getSession:()=>current};
  await recoverExistingResult(eligible(),true,'guard',async (_p,request)=>{assert.equal(request.recoveryGuard(),true);current={...session,id:'session-b'};assert.equal(request.recoveryGuard(),false);current={...session,permissions:[]};assert.equal(request.recoveryGuard(),false);},()=>{},opts);
});

test('lost permission, unavailable storage and stale diagnostics do not send a request', async () => {
  let calls=0; const mutate=()=>{calls++;}, refresh=()=>{};
  const broken={getItem(){throw Error('denied');}};
  await recoverExistingResult(eligible(),false,'attempt',mutate,refresh,{storage:memoryStorage(),makeId:()=> 'x',getSession});
  await recoverExistingResult(eligible(),true,'attempt',mutate,refresh,{storage:broken,makeId:()=> 'x',getSession});
  await recoverExistingResult({loading:true,...{recovery:eligible().recovery}},true,'attempt',mutate,refresh,{storage:memoryStorage(),makeId:()=> 'x',getSession});
  assert.equal(calls,0);
});

test('workspace uses server diagnostics and the ordinary authenticated API helper', () => {
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  assert.match(source,/canRecoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\)\)/);
  assert.match(source,/recoverExistingResult\(diagnostic,can\('viewer\.processing\.write'\),id,mutate,/);
  assert.match(source,/delete detail\.attemptDiagnostics\[id\]/);assert.match(source,/loadTaskAttemptDiagnostics\(taskId,id\)/);
  assert.match(source,/delete state\.diagnosticDetails\[id\]/);assert.match(source,/loadGlobalAttemptDiagnostics\(id\)/);
  assert.match(source,/detail\.attemptDiagnostics\?\.\[attemptId\]!==pending/);assert.match(source,/state\.diagnosticDetails\[attemptId\]!==pending/);
  const start=source.indexOf('async function api('),end=source.indexOf('async function authenticatedDownload(',start);
  assert.ok(start>=0&&end>start);
  const api=source.slice(start,end);
  assert.match(api,/Authorization:`Bearer \$\{state\.token\}`/);assert.match(api,/!init\.headers\['Idempotency-Key'\]/);assert.match(api,/if\(recoveryGuard\)[\s\S]*response=await fetch\(path,init\)[\s\S]*else response=await workspaceFetch\(path,init\)/);
});

function workspaceApiHarness(response) {
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const start=source.indexOf('async function api('),end=source.indexOf('async function authenticatedDownload(',start);
  assert.ok(start>=0&&end>start);
  const calls={direct:0,renewable:0};
  const api=new Function('state','workspaceFetch','fetch','responseError','DIRECT_CLIENT_GRANTS_PATH','clientAccessDiagnostic','clearWorkspaceAuthorization',
    `return (${source.slice(start,end)});`)({token:'synthetic-token'},async()=>{calls.renewable++;return response();},
      async()=>{calls.direct++;return response();},(message,status)=>Object.assign(new Error(message),{status}),
      '/api/v1/workspace/direct-client-grants',value=>value,()=>{});
  return {api,calls};
}

test('workspace recovery dispatch refuses changed authority and never auto-renews its mutation',async()=>{
  const {api,calls}=workspaceApiHarness(()=>Response.json({accepted:true}));
  await assert.rejects(api('/recover',{method:'POST',body:{},recoveryGuard:()=>false}),{code:'recovery_session_changed'});
  assert.deepEqual(calls,{direct:0,renewable:0});
  assert.deepEqual(await api('/recover',{method:'POST',body:{},recoveryGuard:()=>true}),{accepted:true});
  assert.deepEqual(calls,{direct:1,renewable:0});
});

test('ordinary direct client sharing retains its safe failure diagnostic',async()=>{
  const {api,calls}=workspaceApiHarness(()=>Response.json({code:'operations_request_failed'},{status:404,
    headers:{'X-LTDS-Client-Access-Request':'synthetic-request-id'}}));
  await assert.rejects(api('/api/v1/workspace/direct-client-grants?viewerProjectId=synthetic'),
    error=>error.status===404&&error.code==='operations_request_failed'&&error.requestId==='synthetic-request-id');
  assert.deepEqual(calls,{direct:0,renewable:1});
});
