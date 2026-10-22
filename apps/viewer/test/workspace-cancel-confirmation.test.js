const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
const handler=source.split(/\r?\n/).find(line=>line.startsWith('async function confirmCancelAttempt('));

test('processing cancellation requires explicit confirmation and permission',async()=>{
  assert.match(source,/if\(action==='cancel-attempt'\)return confirmCancelAttempt\(id\)/);
  for(const scenario of ['accept','dismiss','denied','busy','revoked-during-confirm']){
    const calls=[];let allowed=scenario!=='denied';const state={busy:scenario==='busy'};
    const context=vm.createContext({state,can:()=>allowed,dialogs:{confirm:async(text,options)=>{calls.push(['confirm',text,options]);if(scenario==='revoked-during-confirm')allowed=false;return scenario!=='dismiss';}},mutate:async(...args)=>calls.push(['mutate',...args])});
    await vm.runInContext(`${handler};confirmCancelAttempt('attempt-id')`,context);
    assert.equal(calls.filter(call=>call[0]==='mutate').length,scenario==='accept'?1:0,scenario);
    if(scenario==='accept'){assert.equal(calls[0][2].destructive,true);assert.equal(calls[1][1],'/api/v1/attempts/attempt-id/cancel');}
    if(['denied','busy'].includes(scenario))assert.equal(calls.length,0);
  }
});
