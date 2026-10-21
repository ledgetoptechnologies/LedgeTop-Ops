import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createWorkspaceRecovery,relayWorkspaceRecoveryGrant} from '../workspace-recovery.mjs';

function fixture({status=200,subject='ops:one',fetchImpl,now=()=>Date.now()}={}){
  const token='t'.repeat(40),grant='g'.repeat(40),origin='https://viewer.example',ops='https://ops.example',listeners=new Map(),storage=new Map(),posts=[],installed=[],calls=[];
  const previous={accessToken:token,controllerOrigin:ops,session:{id:'session-one',subject:'ops:one',expiresAt:new Date(Date.now()-1000).toISOString()}};
  const envelope={...previous,session:{...previous.session,subject,expiresAt:new Date(Date.now()+3600000).toISOString()}};
  const button={},statusNode={},dialog={querySelector:selector=>selector==='button'?button:statusNode,addEventListener(){},showModal(){this.open=true;},close(){this.open=false;},remove(){this.removed=true;}};
  const popup={closed:false,postMessage:(...args)=>posts.push(args),focus(){}};
  const win={location:{origin},crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789012'},sessionStorage:{setItem:(key,value)=>storage.set(key,value),getItem:key=>storage.get(key),removeItem:key=>storage.delete(key)},open:(url)=>{calls.push(['open',url]);return popup;},addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)};
  let paused=0,resumed=0,fatal=0;
  const recovery=createWorkspaceRecovery({windowRef:win,documentRef:{body:{append(){}},createElement:()=>dialog},getSession:()=>previous,install:value=>installed.push(value),onPaused:()=>paused++,onResumed:()=>resumed++,onFatal:()=>fatal++,now,fetchImpl:fetchImpl|| (async(url,init)=>{calls.push(['fetch',url,init]);return{ok:status===200,status,json:async()=>envelope};})});
  const send=overrides=>listeners.get('message')({origin,source:popup,data:{version:1,type:'ltds-viewer:workspace-recovery-grant',nonce:'12345678123442348234123456789012',grant},...overrides});
  return{recovery,button,dialog,statusNode,win,popup,previous,envelope,send,storage,posts,installed,calls,stats:()=>({paused,resumed,fatal})};
}
test('expiry recovery retains working tab and restores only identical authenticated identity',async()=>{
  const f=fixture(),pending=f.recovery.pause();assert.equal(f.recovery.pause(),pending);assert.equal(f.recovery.isPaused(),true);assert.equal(f.stats().paused,1);
  f.button.onclick();assert.match(f.calls[0][1],/^https:\/\/ops.example\/viewer\/reauthorize\?state=/);
  await f.send({origin:'https://attacker.example'});await f.send({source:{}});await f.send({data:{version:1,type:'ltds-viewer:workspace-recovery-grant',nonce:'wrong',grant:'g'.repeat(40)}});
  assert.equal(f.installed.length,0);await f.send();await pending;
  assert.equal(f.installed.length,1);assert.equal(f.calls[1][2].headers.Authorization,`Bearer ${f.previous.accessToken}`);
  assert.equal(f.recovery.isPaused(),false);assert.equal(f.dialog.removed,true);assert.deepEqual(f.stats(),{paused:1,resumed:1,fatal:0});assert.equal(f.storage.size,0);f.recovery.dispose();
});
test('unknown/revoked identity is not revived and cannot release queued work',async()=>{
  for(const options of [{status:401},{status:403},{subject:'ops:someone-else'}]){
    const f=fixture(options),pending=f.recovery.pause();const rejected=assert.rejects(pending);f.button.onclick();await f.send();await rejected;
    assert.equal(f.installed.length,0);assert.equal(f.stats().fatal,1);assert.equal(f.stats().resumed,0);f.recovery.dispose();
  }
});
test('transient failure keeps upload waiter and supports retry; abort removes individual waiter',async()=>{
  let count=0;const f=fixture({fetchImpl:async()=>({ok:++count>1,status:count>1?200:503,json:async()=>f.envelope})});
  const pending=f.recovery.pause(),abort=new AbortController(),cancelled=assert.rejects(f.recovery.wait(abort.signal),/Cancelled/);abort.abort();await cancelled;
  f.button.onclick();await f.send();assert.equal(f.recovery.isPaused(),true);assert.equal(f.dialog.removed,undefined);
  f.button.onclick();await f.send();await pending;assert.equal(f.stats().resumed,1);f.recovery.dispose();
});
test('concurrent grant deliveries redeem exactly once',async()=>{
  let release,count=0;const f=fixture({fetchImpl:async()=>{count++;return new Promise(resolve=>release=()=>resolve({ok:true,status:200,json:async()=>f.envelope}));}});
  const pending=f.recovery.pause();f.button.onclick();const first=f.send();await f.send();assert.equal(count,1);release();await first;await pending;f.recovery.dispose();
});

test('expired popup can be retried without closing it and cannot redeem its stale nonce',async()=>{
  let clock=Date.now();const f=fixture({now:()=>clock}),pending=f.recovery.pause();f.button.onclick();
  clock+=6*60_000;f.win.crypto.randomUUID=()=> '22345678-1234-4234-8234-123456789012';
  f.button.onclick();assert.equal(f.calls.filter(call=>call[0]==='open').length,2);
  await f.send();assert.equal(f.installed.length,0);
  const nonce=JSON.parse([...f.storage.values()][0]).nonce;
  await f.send({data:{version:1,type:'ltds-viewer:workspace-recovery-grant',nonce,grant:'g'.repeat(40)}});await pending;
  assert.equal(f.stats().resumed,1);f.recovery.dispose();
});

test('late expected grant explains expiry and leaves work paused for a fresh launch',async()=>{
  let clock=Date.now();const f=fixture({now:()=>clock}),pending=f.recovery.pause();f.button.onclick();clock+=6*60_000;
  await f.send();assert.equal(f.calls.filter(call=>call[0]==='fetch').length,0);assert.match(f.statusNode.textContent,/attempt expired/);
  assert.equal(f.recovery.isPaused(),true);assert.equal(f.dialog.open,true);assert.equal(f.storage.size,0);
  f.button.onclick();await f.send();await pending;assert.equal(f.stats().resumed,1);f.recovery.dispose();
});

test('blocked popup and launch exceptions keep work and permit retry without uncaught errors',async()=>{
  for(const failure of ['blocked','open throws','storage throws']){
    const f=fixture(),pending=f.recovery.pause(),open=f.win.open,setItem=f.win.sessionStorage.setItem;
    if(failure==='blocked')f.win.open=()=>null;
    if(failure==='open throws')f.win.open=()=>{throw new Error('Popup blocked');};
    if(failure==='storage throws')f.win.sessionStorage.setItem=()=>{throw new Error('Storage denied');};
    assert.doesNotThrow(()=>f.button.onclick());assert.equal(f.recovery.isPaused(),true);assert.equal(f.dialog.open,true);assert.equal(f.storage.size,0);assert.match(f.statusNode.textContent,/try again/);
    f.win.open=open;f.win.sessionStorage.setItem=setItem;f.button.onclick();await f.send();await pending;
    assert.equal(f.stats().resumed,1);assert.equal(f.stats().fatal,0);f.recovery.dispose();
  }
});

test('unavailable BroadcastChannel falls back to strict same-origin opener messaging',async()=>{
  const f=fixture(),pending=f.recovery.pause();f.win.BroadcastChannel=class{constructor(){throw new Error('Disabled');}};
  assert.doesNotThrow(()=>f.button.onclick());await f.send({origin:'https://wrong.example'});assert.equal(f.installed.length,0);
  await f.send();await pending;assert.equal(f.installed.length,1);f.recovery.dispose();
});

test('successful redemption releases waiters even when optional cleanup and acknowledgements throw',async()=>{
  const f=fixture();f.win.BroadcastChannel=class{postMessage(){throw new Error('Ack failed');}close(){throw new Error('Channel unavailable');}};
  const pending=f.recovery.pause();f.button.onclick();
  f.win.sessionStorage.removeItem=()=>{throw new Error('Storage denied');};f.popup.postMessage=()=>{throw new Error('Popup gone');};
  f.dialog.close=()=>{throw new Error('Dialog detached');};f.dialog.remove=()=>{throw new Error('Already removed');};
  await f.send();await pending;assert.equal(f.recovery.isPaused(),false);assert.equal(f.installed.length,1);assert.equal(f.stats().resumed,1);f.recovery.dispose();
});

test('failed identity rejects waiters despite cleanup errors and never resumes upload',async()=>{
  const f=fixture({status:403}),pending=f.recovery.pause(),rejected=assert.rejects(pending);f.button.onclick();
  f.win.sessionStorage.removeItem=()=>{throw new Error('Storage denied');};f.dialog.close=()=>{throw new Error('Dialog detached');};
  await f.send();await rejected;assert.equal(f.stats().fatal,1);assert.equal(f.stats().resumed,0);assert.equal(f.installed.length,0);f.recovery.dispose();
});
test('return relay requires matching recent nonce and sends capability only to same-origin opener',()=>{
  const f=fixture();f.recovery.pause();f.button.onclick();const events=new Map();let replacement,closed=false;
  const win={...f.win,BroadcastChannel:class{constructor(){throw new Error('Unavailable');}},location:{href:`https://viewer.example/workspace/${'g'.repeat(40)}#reauthorize=12345678123442348234123456789012`},opener:f.popup,history:{replaceState:(_a,_b,url)=>replacement=url},addEventListener:(type,handler)=>events.set(type,handler),removeEventListener:type=>events.delete(type),close:()=>closed=true};
  assert.equal(relayWorkspaceRecoveryGrant({windowRef:win,documentRef:{body:{}}}),true);assert.equal(f.posts[0][1],'https://viewer.example');assert.equal(replacement,'/workspace');
  events.get('message')({source:{},origin:'https://viewer.example',data:{version:1,type:'ltds-viewer:workspace-recovery-complete',nonce:'12345678123442348234123456789012'}});assert.equal(closed,false);
  events.get('message')({source:f.popup,origin:'https://viewer.example',data:{version:1,type:'ltds-viewer:workspace-recovery-complete',nonce:'12345678123442348234123456789012'}});assert.equal(closed,true);f.recovery.dispose();
});

test('same-origin isolated return channel restores without an opener and ignores wrong origin',async()=>{
  const f=fixture(),channels=[];
  f.win.BroadcastChannel=class{constructor(name){this.name=name;channels.push(this);}postMessage(data){this.sent=data;}close(){this.closed=true;}};
  const pending=f.recovery.pause();f.button.onclick();const receiver=channels[0];
  const win={...f.win,location:{href:`https://viewer.example/workspace/${'g'.repeat(40)}#reauthorize=12345678123442348234123456789012`},opener:null,history:{replaceState(){}},close(){}};
  assert.equal(relayWorkspaceRecoveryGrant({windowRef:win,documentRef:{body:{}}}),true);
  const relay=channels[1];assert.equal(relay.name,receiver.name);
  await receiver.onmessage({origin:'https://attacker.example',data:relay.sent});assert.equal(f.installed.length,0);
  await receiver.onmessage({origin:'https://viewer.example',data:relay.sent});await pending;
  assert.equal(f.installed.length,1);assert.equal(receiver.closed,true);f.recovery.dispose();
});

test('authenticated request waits for recovery and retries only rejected request with identical bytes/key',async()=>{
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  const start=source.indexOf('async function workspaceFetch('),end=source.indexOf('\nasync function api(',start),fn=source.slice(start,end);assert.ok(start>=0&&end>start);
  let paused=false,release;const calls=[],state={token:'original',adminSession:{id:'retained-session',subject:'ops:one'}};
  const context=vm.createContext({state,workspaceRenewal:null,responseError:(message,status)=>Object.assign(new Error(message),{status}),workspaceRecovery:{wait:async()=>{if(paused)await new Promise(resolve=>release=resolve);},isPaused:()=>paused},clearWorkspaceAuthorization:()=>{paused=true;},fetch:async(path,init)=>{calls.push({path,init});return{status:calls.length===1?401:200};}});
  vm.runInContext(fn,context);
  const body=new Uint8Array([1,2,3]),pending=context.workspaceFetch('/upload',{method:'PUT',body,headers:{'Idempotency-Key':'one','X-Chunk-SHA256':'hash'}});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,1);
  state.token='renewed';paused=false;release();assert.equal((await pending).status,200);
  assert.equal(calls.length,2);assert.equal(calls[0].init.body,calls[1].init.body);
  assert.equal(calls[1].init.headers['Idempotency-Key'],'one');assert.equal(calls[1].init.headers.Authorization,'Bearer renewed');
});
