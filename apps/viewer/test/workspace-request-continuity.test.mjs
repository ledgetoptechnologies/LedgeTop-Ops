import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const start=source.indexOf('async function workspaceFetch('),end=source.indexOf('\nasync function api(',start);
assert.ok(start>=0&&end>start);

test('private downloads, GCP images and legacy chunks all use the continuity wrapper, not raw authenticated fetch',()=>{
  for(const name of ['authenticatedDownload','privateGcpImage','uploadFiles']){
    const line=source.split(/\r?\n/).find(value=>value.startsWith(`async function ${name}(`));
    assert.ok(line,`${name} exists`);
    assert.match(line,/await workspaceFetch\(/,`${name} uses the renewal-aware request path`);
    assert.doesNotMatch(line,/await fetch\(/,`${name} must not bypass expiry handling`);
  }
  for(const name of ['redeemGrant','restoreWorkspaceSession']){
    const line=source.split(/\r?\n/).find(value=>value.startsWith(`async function ${name}(`));
    assert.match(line,/await fetch\(/,`${name} must not depend on authenticated recovery before initial authentication`);
  }
});
function fixture(handler,{pauseOnClear=false}={}){
  const state={token:'same-bearer',adminSession:{id:'session',subject:'operator',expiresAt:'old'}};
  const requests=[],clears=[];let paused=false;
  const recovery={isPaused:()=>paused,async wait(signal){if(signal?.aborted)throw new DOMException('Cancelled','AbortError');if(paused){state.adminSession={...state.adminSession,expiresAt:'renewed'};paused=false;}}};
  // These cases exercise interactive fallback when silent renewal is unavailable.
  const send=new Function('state','workspaceRecovery','fetch','clearWorkspaceAuthorization','responseError','workspaceRenewal',`return (${source.slice(start,end)});`)(state,recovery,async(path,init)=>{requests.push({path,...init});return handler(state,requests.length);},reason=>{clears.push(reason);paused=pauseOnClear&&reason!=='revoked';},(message,status)=>Object.assign(new Error(message),{status}),null);
  return{state,requests,clears,send};
}

test('in-flight401 before same-bearer renewal retries identical photo bytes without clearing the new session',async()=>{
  const f=fixture((state,count)=>{if(count===1){state.adminSession={...state.adminSession,expiresAt:'renewed'};return{status:401};}return{status:200};});
  const body=new Uint8Array([1,2,3]).buffer,signal=new AbortController().signal;
  const init={method:'PUT',body,signal,headers:{'X-Upload-Token':'upload-scope','X-Chunk-SHA256':'digest','Idempotency-Key':'same-operation'}};
  assert.equal((await f.send('/chunk',init)).status,200);
  assert.equal(f.requests.length,2);assert.deepEqual(f.clears,[]);
  for(const request of f.requests){assert.equal(request.body,body);assert.equal(request.signal,signal);assert.deepEqual(request.headers,{...init.headers,Authorization:'Bearer same-bearer'});}
});

test('expiry pause resumes the same upload request once after fresh authentication',async()=>{
  const f=fixture((_state,count)=>({status:count===1?401:200}),{pauseOnClear:true});
  const body=new Uint8Array([4]).buffer;
  assert.equal((await f.send('/chunk',{method:'PUT',body})).status,200);
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].body,body);assert.deepEqual(f.clears,[undefined]);
});

test('another renewal during the replay cannot cause unbounded retries or revoke the newest session',async()=>{
  const f=fixture((state,count)=>{state.adminSession={...state.adminSession,expiresAt:`renewed-${count}`};return{status:401};});
  await assert.rejects(f.send('/chunk',{method:'PUT',body:new ArrayBuffer(2)}),error=>error.status===409);
  assert.equal(f.requests.length,2);assert.deepEqual(f.clears,[]);
  assert.equal(f.state.adminSession.expiresAt,'renewed-2');
});

test('a current authoritative denial still clears access rather than being retried indefinitely',async()=>{
  const f=fixture(()=>({status:401}));
  assert.equal((await f.send('/chunk')).status,401);assert.equal(f.requests.length,1);assert.deepEqual(f.clears,[undefined]);
  const replay=fixture((state,count)=>{if(count===1)state.adminSession={...state.adminSession,expiresAt:'renewed'};return{status:401};});
  assert.equal((await replay.send('/chunk')).status,401);assert.equal(replay.requests.length,2);assert.deepEqual(replay.clears,['revoked']);
});

test('an aborted upload cannot be resumed by a later authentication response',async()=>{
  const f=fixture(()=>({status:200})),controller=new AbortController();controller.abort();
  await assert.rejects(f.send('/chunk',{signal:controller.signal}),{name:'AbortError'});assert.equal(f.requests.length,0);
});
