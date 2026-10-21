import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function harness({renew=async()=>false,statuses=[401,200]}={}){
  const state={token:'original',adminSession:{id:'session'}},calls=[],clears=[];
  const context={state,DOMException,workspaceRecovery:{wait:async()=>{},isPaused:()=>false},
    workspaceRenewal:{waitForRenewal:args=>renew(context,args)},
    fetch:async(path,init)=>{calls.push({path,init});return {status:statuses[calls.length-1]||200};},
    clearWorkspaceAuthorization:reason=>clears.push(reason),responseError:(message,status)=>Object.assign(new Error(message),{status})};
  vm.createContext(context);vm.runInContext(source.slice(source.indexOf('async function workspaceFetch('),source.indexOf('async function api('))+'\nthis.run=workspaceFetch;',context);
  return {...context,calls,clears};
}

test('racing expiry waits for verified renewal and replays identical upload body without interactive recovery',async()=>{
  const ctx=harness({renew:async context=>{context.state.adminSession={id:'session',renewed:true};return true;}});
  const body=new Uint8Array([1,2,3]),headers={'Idempotency-Key':'unchanged','X-Upload-Token':'upload'};
  assert.equal((await ctx.run('/chunk',{method:'PUT',body,headers})).status,200);
  assert.equal(ctx.calls.length,2);assert.equal(ctx.calls[1].init.body,body);assert.equal(ctx.calls[1].init.headers['Idempotency-Key'],'unchanged');assert.equal(ctx.calls[1].init.headers.Authorization,'Bearer original');assert.equal(ctx.clears.length,0);
});

test('unavailable renewal retains existing interactive recovery instead of replaying unauthorized work',async()=>{
  const ctx=harness();assert.equal((await ctx.run('/work')).status,401);assert.equal(ctx.calls.length,1);assert.equal(ctx.clears.length,1);
});

test('aborted request stops waiting without clearing session or replaying',async()=>{
  const controller=new AbortController(),ctx=harness({renew:async()=>{controller.abort();return false;}});
  await assert.rejects(ctx.run('/work',{signal:controller.signal}),{name:'AbortError'});assert.equal(ctx.calls.length,1);assert.equal(ctx.clears.length,0);
});

test('an expired workspace holds protected uploads until authority-backed renewal completes',async()=>{
  let release;const gate=new Promise(resolve=>{release=resolve;});let options;
  const ctx=harness({statuses:[200],renew:async(context,args)=>{options=args;await gate;context.state.adminSession={id:'session',renewed:true};return true;}});
  ctx.workspaceRenewal.expiresAtMs=Date.now()-1;
  const body=new Uint8Array([1,2,3]),work=ctx.run('/chunk',{method:'PUT',body,headers:{'Idempotency-Key':'same-key'}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(ctx.calls.length,0);assert.equal(options.whileExpired,true);
  release();assert.equal((await work).status,200);assert.equal(ctx.calls.length,1);assert.equal(ctx.calls[0].init.body,body);assert.equal(ctx.clears.length,0);
});

test('expired workspace terminal denial sends no protected request',async()=>{
  const ctx=harness();ctx.workspaceRenewal.expiresAtMs=Date.now()-1;
  await assert.rejects(ctx.run('/private'),{status:401});assert.equal(ctx.calls.length,0);
});
