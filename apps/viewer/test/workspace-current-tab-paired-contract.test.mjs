import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {beginCurrentTabWorkspaceRecovery,resumeCurrentTabWorkspaceRecovery} from '../workspace-current-tab-recovery.mjs';

const moduleUrl=process.env.VIEWER_OPS_REAUTH_MODULE
  ? pathToFileURL(resolve(process.env.VIEWER_OPS_REAUTH_MODULE))
  : new URL('../../operations/src/client/viewer-reauthorization.ts',import.meta.url);
const ops=existsSync(moduleUrl)?await import(moduleUrl.href):null;
const skip=ops?false:'Actual Operations reauthorization module absent; set VIEWER_OPS_REAUTH_MODULE to qualify a reviewed counterpart.';
const OPS='https://ops.example',VIEWER='https://viewer.example';
const KEY='ltds-viewer-reauthorization-state',ORIGIN_KEY='ltds-viewer-ops-origin';
const TOKEN='t'.repeat(40),GRANT='g'.repeat(40);
const view={section:'dashboard',selectedProjectId:'project-1',expandedTaskId:'task-1',taskPage:'files'};

// Protocol integration only: the issuer and redeem endpoint below are mocks.
// This does not validate server authorization, real grant storage or HTTPS navigation.
function fixture(){
  const storage=new Map([[ORIGIN_KEY,OPS]]),installed=[],restored=[],requests=[];
  let destination,minted=0,redeemed=0;
  const previous={controllerOrigin:OPS,accessToken:TOKEN,session:{id:'session-1',subject:'ops:owner',expiresAt:new Date(Date.now()-1000).toISOString()}};
  const envelope={...previous,session:{...previous.session,expiresAt:new Date(Date.now()+3600_000).toISOString()}};
  const win={location:{origin:VIEWER,href:VIEWER+'/workspace',assign:url=>{destination=url;}},
    crypto:{randomUUID:()=> '12345678-1234-4234-8234-123456789012'},
    sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
    history:{replaceState:(_state,_title,path)=>{win.location.href=new URL(path,VIEWER).href;}}};
  const options={windowRef:win,accessToken:TOKEN,install:body=>installed.push(body),restoreView:value=>restored.push(value),
    fetchImpl:async(path,init)=>{
      requests.push({path,init});
      assert.equal(storage.has(KEY),false,'consume correlation before contacting redeem endpoint');
      assert.equal(win.location.href,VIEWER+'/workspace','strip capability before contacting redeem endpoint');
      assert.equal(path,'/api/v1/admin-sessions/redeem');
      assert.equal(init.headers.Authorization,'Bearer '+TOKEN);
      assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');
      assert.deepEqual(JSON.parse(init.body),{grant:GRANT});
      const ok=minted===1&&redeemed++===0;
      return {ok,status:ok?200:403,url:VIEWER+path,json:async()=>envelope};
    }};
  function begin(){beginCurrentTabWorkspaceRecovery({windowRef:win,previous,view});return new URL(destination);}
  function issue(search){
    const parsed=ops.parseViewerReauthorization(search);
    if(parsed.kind!=='valid')return parsed;
    minted++;
    win.location.href=VIEWER+'/workspace/'+GRANT+'#'+ops.viewerReauthorizationFragment(parsed);
    return parsed;
  }
  return {win,storage,installed,restored,requests,envelope,options,begin,issue,get minted(){return minted;}};
}

test('paired real modules carry explicit mode end to end and consume the mocked one-use grant once',{skip},async()=>{
  const f=fixture(),destination=f.begin();
  assert.equal(destination.origin,OPS);assert.equal(destination.pathname,'/viewer/reauthorize');
  assert.equal(f.issue(destination.search).sameTab,true);
  const returnUrl=f.win.location.href,correlation=f.storage.get(KEY);
  assert.equal(await resumeCurrentTabWorkspaceRecovery(f.options),true);
  assert.equal(f.minted,1);assert.equal(f.requests.length,1);
  assert.deepEqual(f.installed,[f.envelope]);assert.deepEqual(f.restored,[view]);
  f.win.location.href=returnUrl;
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
  assert.equal(f.requests.length,1,'replayed return must not contact redemption again');
  // Even copied correlation cannot revive a grant consumed by the mock endpoint.
  f.storage.set(KEY,correlation);f.win.location.href=returnUrl;
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.status===403);
  assert.equal(f.requests.length,2);assert.equal(f.installed.length,1);
});

test('paired older nonce-only return remains valid for Ops popup flow but cannot resume same-tab state',{skip},async()=>{
  const f=fixture(),destination=f.begin();destination.searchParams.delete('recoveryMode');
  assert.equal(f.issue(destination.search).sameTab,false);
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true);
  assert.equal(f.requests.length,0);assert.equal(f.installed.length,0);
});

test('actual Ops parser rejects ambiguous modes and nonces before mock issuance',{skip},()=>{
  const nonce='n'.repeat(32);
  for(const search of [
    '?state=short&recoveryMode=same-tab',
    `?state=${nonce}&state=${nonce}&recoveryMode=same-tab`,
    `?state=${nonce}&recoveryMode=same-tab&recoveryMode=same-tab`,
    `?state=${nonce}&recoveryMode=other`,'?recoveryMode=same-tab',
  ]){
    const f=fixture();f.begin();assert.equal(f.issue(search).kind,'invalid',search);
    assert.equal(f.minted,0);assert.equal(f.requests.length,0);assert.equal(f.installed.length,0);
  }
});

test('paired return nonce mismatch and changed redeemed identity cannot install authority',{skip},async()=>{
  const mismatched=fixture(),destination=mismatched.begin();destination.searchParams.set('state','x'.repeat(32));
  mismatched.issue(destination.search);
  await assert.rejects(resumeCurrentTabWorkspaceRecovery(mismatched.options),error=>error.fatal===true);
  assert.equal(mismatched.requests.length,0);assert.equal(mismatched.installed.length,0);
  for(const changed of ['subject','session','bearer','controller']){
    const f=fixture();f.issue(f.begin().search);
    if(changed==='subject')f.envelope.session.subject='ops:another';
    if(changed==='session')f.envelope.session.id='session-another';
    if(changed==='bearer')f.envelope.accessToken='x'.repeat(40);
    if(changed==='controller')f.envelope.controllerOrigin='https://another.example';
    await assert.rejects(resumeCurrentTabWorkspaceRecovery(f.options),error=>error.fatal===true,changed);
    assert.equal(f.requests.length,1);assert.equal(f.installed.length,0);assert.equal(f.restored.length,0);
  }
});
