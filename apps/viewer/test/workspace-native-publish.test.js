const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
const line=name=>source.split(/\r?\n/).find(value=>value.startsWith(`function ${name}(`));
const publish=source.slice(source.indexOf('async function publishAttempt('),source.indexOf('\nasync function viewPublishedOutput'));
function fixture({allowed=true,busy=false,confirm=async()=>true,review,request}={}){
  const calls=[],state={busy,adminSession:{id:'session',subject:'staff'},projects:[{id:'project',status:'active'}],tasks:[{id:'task',projectId:'project',displayName:'Survey',status:'ready_for_review',latestAttempt:{id:'attempt',status:'ready_for_review',resultModelId:'model',resultModelVersionId:'version'}}],outputs:[{id:'version',modelId:'model',taskId:'task',attemptId:'attempt',status:'ready',assetKinds:['glb','ortho']}]};
  const ctx=vm.createContext({state,can:()=>allowed,shell:{setAttribute(){},removeAttribute(){}},dialogs:{confirm:async(...args)=>{calls.push(['confirm',...args]);return confirm(state);}},api:async(url,options)=>{calls.push([url,options]);if(request)return request(url,options,state);return url.endsWith('/review-sessions')?(review||{sessionMode:'review',attemptId:'attempt',modelId:'model',modelVersionId:'version',assetKinds:['glb','ortho']}):{};},toast:(...args)=>calls.push(['toast',...args]),load:async()=>calls.push(['load']),button:(action,id)=>`${action}:${id}`,dangerButton:()=>'',lodAction:()=>null});
  vm.runInContext(`${line('publishCandidate')};${line('artifactActions')};${publish}`,ctx);
  return{state,calls,ctx,run:()=>vm.runInContext("publishAttempt('attempt')",ctx),allow:value=>{allowed=value;}};
}
test('ready current output exposes Publish only to permitted active mutating views',()=>{
  const f=fixture(),actions=()=>vm.runInContext('artifactActions(state.outputs[0])',f.ctx);
  assert.match(actions(),/publish-attempt:attempt/);
  assert.doesNotMatch(vm.runInContext('artifactActions(state.outputs[0],false)',f.ctx),/publish-attempt/);
  f.allow(false);assert.doesNotMatch(actions(),/publish-attempt/);f.allow(true);
  for(const change of [()=>f.state.projects[0].status='archived',()=>f.state.tasks[0].status='archived',()=>f.state.tasks[0].latestAttempt.id='new-attempt',()=>f.state.outputs[0].status='published']){
    const prior=JSON.stringify(f.state);change();assert.doesNotMatch(actions(),/publish-attempt/);Object.assign(f.state,JSON.parse(prior));
  }
  assert.match(source,/if\(action==='publish-attempt'\)return publishAttempt\(id\)/);
  assert.match(line('taskQuickActions'),/publishCandidate\(task.latestAttempt\?\.id\).*button\('publish-attempt'/);
});
test('publish confirms exact reviewed version and uses existing same-origin publish only',async()=>{
  const f=fixture();await f.run();
  const calls=f.calls.filter(x=>x[0].startsWith('/api/'));
  assert.deepEqual(calls.map(x=>x[0]),['/api/v1/attempts/attempt/review-sessions','/api/v1/attempts/attempt/publish']);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[1][1])),{method:'POST',body:{selectedAssetKinds:['glb','ortho']}});
  assert.equal(f.calls.filter(x=>x[0]==='confirm').length,1);assert.equal(f.state.busy,false);
});
test('denial, busy, dismissal, changed review and revoked or stale confirmation never publish',async()=>{
  for(const scenario of ['denied','busy','dismiss','wrong-version','invalid-kinds','revoked','stale']){
    let f;f=fixture({allowed:scenario!=='denied',busy:scenario==='busy',confirm:async state=>{if(scenario==='revoked')f.allow(false);if(scenario==='stale')state.tasks[0].latestAttempt.id='replacement';return scenario!=='dismiss';},review:scenario==='wrong-version'?{sessionMode:'review',attemptId:'attempt',modelId:'model',modelVersionId:'other',assetKinds:['glb']}:scenario==='invalid-kinds'?{sessionMode:'review',attemptId:'attempt',modelId:'model',modelVersionId:'version',assetKinds:['private-source']}:undefined});
    await f.run();assert.equal(f.calls.filter(x=>x[0].endsWith('/publish')).length,0,scenario);
    if(['denied','busy'].includes(scenario))assert.equal(f.calls.length,0,scenario);
  }
});
test('busy lock covers review and confirmation; duplicate click cannot send another request',async()=>{
  let release;const pending=new Promise(resolve=>{release=resolve;});const f=fixture({confirm:()=>pending});
  const first=f.run();await Promise.resolve();await f.run();release(true);await first;
  assert.equal(f.calls.filter(x=>x[0].endsWith('/review-sessions')).length,1);
  assert.equal(f.calls.filter(x=>x[0].endsWith('/publish')).length,1);assert.equal(f.state.busy,false);
});

test('failed publication unlocks without automatic retry or sharing side effects',async()=>{
  const f=fixture({request:async url=>{if(url.endsWith('/review-sessions'))return{sessionMode:'review',attemptId:'attempt',modelId:'model',modelVersionId:'version',assetKinds:['glb']};throw Error('request outcome unavailable');}});
  await f.run();assert.equal(f.state.busy,false);
  assert.equal(f.calls.filter(x=>x[0].endsWith('/publish')).length,1);
  assert.equal(f.calls.filter(x=>x[0]==='load').length,0);
  assert.equal(f.calls.filter(x=>x[0].includes('share')||x[0].includes('grant')).length,0);
});
