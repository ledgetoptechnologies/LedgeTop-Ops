import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {beginCurrentTabWorkspaceRecovery,resumeCurrentTabWorkspaceRecovery} from '../workspace-current-tab-recovery.mjs';
import {createWorkspaceRecovery,relayWorkspaceRecoveryGrant} from '../workspace-recovery.mjs';

const KEY='ltds-viewer-reauthorization-state',OPS_KEY='ltds-viewer-ops-origin';
const OPS='https://ops.example',VIEWER='https://viewer.example',GRANT='g'.repeat(40),TOKEN='t'.repeat(40);
const NONCE='12345678123442348234123456789012';
const view={section:'dashboard',selectedProjectId:'project-one',expandedTaskId:'task-one',taskPage:'files'};
function fixture(){
  const storage=new Map([[OPS_KEY,OPS]]),navigations=[],history=[],installed=[],restored=[],requests=[];
  let removedListeners=0;
  const previous={controllerOrigin:OPS,accessToken:TOKEN,session:{id:'session-one',subject:'ops:one',expiresAt:new Date(Date.now()-1000).toISOString()}};
  const envelope={...previous,session:{...previous.session,expiresAt:new Date(Date.now()+3600_000).toISOString()}};
  const win={location:{origin:VIEWER,href:VIEWER+'/workspace',assign:url=>navigations.push(url)},crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789012'},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    history:{replaceState:(_state,_title,url)=>history.push(url)},removeEventListener:()=>removedListeners++};
  const start=()=>beginCurrentTabWorkspaceRecovery({windowRef:win,previous,view});
  const returnUrl=()=>{win.location.href=VIEWER+'/workspace/'+GRANT+'#reauthorize='+NONCE+'&recoveryMode=same-tab';};
  const options={windowRef:win,accessToken:TOKEN,install:value=>installed.push(value),restoreView:value=>restored.push(value),
    fetchImpl:async(url,init)=>{assert.equal(storage.has(KEY),false,'nonce must be consumed before network');requests.push({url,init});return{ok:true,status:200,url:VIEWER+url,json:async()=>envelope};}};
  return{win,storage,previous,envelope,start,returnUrl,options,navigations,history,installed,restored,requests,removedListeners:()=>removedListeners};
}

test('explicit current-tab recovery stores only correlation/view hints and preserves unload guards',()=>{
  const f=fixture(),result=f.start(),record=JSON.parse(f.storage.get(KEY));
  assert.deepEqual(result,{mode:'same-tab',nonce:NONCE,navigationAttempted:true});
  assert.equal(f.navigations[0],OPS+'/viewer/reauthorize?state='+NONCE+'&recoveryMode=same-tab');
  assert.equal(record.sessionId,f.previous.session.id);assert.equal(record.subject,f.previous.session.subject);
  assert.deepEqual(record.view,view);assert.ok(!JSON.stringify(record).includes(TOKEN));
  assert.equal(record.permissions,undefined);assert.equal(f.removedListeners(),0);
});

test('same-tab return redeems once locally and validates exact stable session before restoring view',async()=>{
  const f=fixture();f.start();f.returnUrl();
  assert.equal(await resumeCurrentTabWorkspaceRecovery(f.options),true);
  assert.equal(f.requests.length,1);assert.equal(f.requests[0].url,'/api/v1/admin-sessions/redeem');
  assert.equal(f.requests[0].init.headers.Authorization,'Bearer '+TOKEN);
  assert.deepEqual(JSON.parse(f.requests[0].init.body),{grant:GRANT});
  assert.deepEqual(f.installed,[f.envelope]);assert.deepEqual(f.restored,[view]);assert.deepEqual(f.history,['/workspace']);
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
  assert.equal(f.requests.length,1,'replay cannot redeem a second grant');
});

test('wrong nonce, origin, expiry, mode, shape and source state mint nothing',async()=>{
  const mutations=[
    f=>{f.win.location.href=f.win.location.href.replace(NONCE,'x'.repeat(32));},
    f=>{f.win.location.href=f.win.location.href.replace(VIEWER,'https://attacker.example');},
    f=>{f.win.location.origin='https://attacker.example';},
    f=>{f.storage.set(OPS_KEY,'https://attacker.example');},
    f=>{const record=JSON.parse(f.storage.get(KEY));record.createdAt-=6*60_000;f.storage.set(KEY,JSON.stringify(record));},
    f=>{const record=JSON.parse(f.storage.get(KEY));record.createdAt+=60_000;f.storage.set(KEY,JSON.stringify(record));},
    f=>{f.win.location.href+='&recoveryMode=same-tab';},
    f=>{f.win.location.href=f.win.location.href.replace('recoveryMode=same-tab','recoveryMode=other');},
    f=>{f.win.location.href+='&returnUrl=https://attacker.example';},
    f=>{const record=JSON.parse(f.storage.get(KEY));record.extra='untrusted';f.storage.set(KEY,JSON.stringify(record));},
    f=>{const record=JSON.parse(f.storage.get(KEY));record.view={section:'dashboard',secret:TOKEN};f.storage.set(KEY,JSON.stringify(record));},
  ];
  for(const mutate of mutations){const f=fixture();f.start();f.returnUrl();mutate(f);
    await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
    assert.equal(f.requests.length,0);assert.equal(f.installed.length,0);assert.equal(f.storage.has(KEY),false);}
});

test('redemption refuses revocation, switched subject/session/bearer/controller and redirected responses',async()=>{
  for(const change of ['401','403','subject','session','token','origin','redirect','url']){
    const f=fixture();f.start();f.returnUrl();
    const body=structuredClone(f.envelope);
    if(change==='subject')body.session.subject='ops:other';
    if(change==='session')body.session.id='other-session';
    if(change==='token')body.accessToken='x'.repeat(40);
    if(change==='origin')body.controllerOrigin='https://attacker.example';
    f.options.fetchImpl=async()=>({ok:!['401','403'].includes(change),status:Number(change)||200,
      redirected:change==='redirect',url:change==='url'?'https://attacker.example/redeem':VIEWER+'/api/v1/admin-sessions/redeem',json:async()=>body});
    await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
    assert.equal(f.installed.length,0);assert.equal(f.restored.length,0);assert.equal(f.storage.has(KEY),false);
  }
});

test('an absent explicit mode preserves initial/popup flow and same-tab returns never broadcast grants',async()=>{
  const f=fixture();f.start();f.returnUrl();let channels=0;
  f.win.BroadcastChannel=class{constructor(){channels++;}};
  assert.equal(relayWorkspaceRecoveryGrant({windowRef:f.win,documentRef:{}}),false);assert.equal(channels,0);
  f.win.location.href=f.win.location.href.replace('&recoveryMode=same-tab','');
  f.storage.set(KEY,JSON.stringify({nonce:NONCE,createdAt:Date.now()}));
  assert.equal(await resumeCurrentTabWorkspaceRecovery(f.options),false);
  assert.equal(f.requests.length,0);assert.equal(f.storage.has(KEY),true);
});

test('an older Ops return cannot trap an explicit same-tab recovery in a dead popup relay',async()=>{
  const f=fixture();f.start();f.returnUrl();f.win.location.href=f.win.location.href.replace('&recoveryMode=same-tab','');
  assert.equal(relayWorkspaceRecoveryGrant({windowRef:f.win,documentRef:{}}),false);
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
  assert.equal(f.requests.length,0);assert.equal(f.installed.length,0);
});

test('blocked recovery exposes an explicit current-tab action and pending-work state without automatic navigation',()=>{
  const f=fixture(),button={},status={},dialog={querySelector:key=>key==='button'?button:status,
    addEventListener(){},showModal(){},close(){},remove(){}};let offered;
  f.win.open=()=>null;f.win.addEventListener=()=>{};
  const recovery=createWorkspaceRecovery({windowRef:f.win,documentRef:{createElement:()=>dialog,body:{append(){}}},
    getSession:()=>f.previous,install:()=>assert.fail('must not install before redirect'),onFatal:()=>{},getView:()=>view,
    getNavigationState:()=>({pendingUpload:true,selectedFileCount:12,unsavedTaskDraft:true}),onPopupBlocked:value=>offered=value});
  recovery.pause();button.onclick();assert.equal(f.navigations.length,0);
  assert.deepEqual(offered.navigationState,{pendingUpload:true,selectedFileCount:12,unsavedTaskDraft:true});
  assert.equal(recovery.navigationState().paused,true);offered.continueInCurrentTab();
  assert.equal(f.navigations.length,1);assert.equal(f.removedListeners(),0);
  recovery.dispose();
});

test('storage failure prevents navigation and consumed state prevents concurrent redemption',async()=>{
  const bad=fixture();bad.win.sessionStorage.setItem=()=>{throw Error('Storage unavailable');};
  assert.throws(bad.start);assert.equal(bad.navigations.length,0);
  const lost=fixture();lost.win.sessionStorage.setItem=()=>{};
  assert.throws(lost.start);assert.equal(lost.navigations.length,0,'do not leave without persisted correlation');
  const f=fixture();f.start();f.returnUrl();let release,calls=0;
  f.options.fetchImpl=()=>{calls++;return new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>f.envelope});});};
  const first=resumeCurrentTabWorkspaceRecovery(f.options);
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options));assert.equal(calls,1);
  release();assert.equal(await first,true);assert.equal(f.installed.length,1);
});

test('URL and nonce cleanup are independent and either failure prevents redemption',async()=>{
  for(const kind of ['storage-property','remove','verify-read','no-op-remove','history']){
    const f=fixture();f.start();f.returnUrl();
    if(kind==='storage-property')Object.defineProperty(f.win,'sessionStorage',{get(){throw Error('Denied');}});
    if(kind==='remove')f.win.sessionStorage.removeItem=()=>{throw Error('Denied');};
    if(kind==='verify-read'){
      const get=f.win.sessionStorage.getItem;let reads=0;
      f.win.sessionStorage.getItem=key=>{if(++reads>1)throw Error('Denied');return get(key);};
    }
    if(kind==='no-op-remove')f.win.sessionStorage.removeItem=()=>{};
    if(kind==='history')f.win.history.replaceState=()=>{throw Error('Denied');};
    await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
    assert.equal(f.requests.length,0,kind);assert.equal(f.installed.length,0,kind);
    if(kind!=='history')assert.deepEqual(f.history,['/workspace'],kind);
    else assert.equal(f.storage.has(KEY),false,'nonce is consumed even when history cleanup fails');
  }
});

test('bounded timeout never installs a late redemption',async()=>{
  const f=fixture();f.start();f.returnUrl();let release;
  f.options.timeoutMs=1;f.options.fetchImpl=()=>new Promise(resolve=>{release=()=>resolve({ok:true,json:async()=>f.envelope});});
  const pending=resumeCurrentTabWorkspaceRecovery(f.options);await new Promise(resolve=>setTimeout(resolve,10));release();
  await assert.rejects(pending,error=>error.fatal===true);assert.equal(f.installed.length,0);
});

test('startup uses local return recovery first; upload busy guard remains registered until normal dispose',()=>{
  const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
  assert.ok(source.indexOf('await resumeCurrentTabWorkspaceRecovery(')<source.indexOf('relayWorkspaceRecoveryGrant()'));
  assert.match(source,/error\.fatal\|\|error\.status===401/);
  const upload=readFileSync(new URL('../workspace-new-task.mjs',import.meta.url),'utf8');
  assert.match(upload,/if\(value&&!presetSaving\)view\.addEventListener\('beforeunload',leaveWarning\)/);
  assert.match(upload,/get navigationState\(\)/);
});
