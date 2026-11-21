import test from 'node:test';
import assert from 'node:assert/strict';
import {orchestratorPicker,withOrchestrator} from '../workspace-processing-node.mjs';
import {resolveOrchestrator} from '../server/providerSelection.mjs';

const now=Date.now();
const options=['pc-ept','gltf','3d-tiles'].map(name=>({name,type:'bool',value:true}));
const node=patch=>({id:'id',displayName:'Node',type:'nodeodm',enabled:true,capabilityFingerprint:'fp',capabilities:{options,taskQueueCount:0},lastHealth:'healthy',lastHealthAt:new Date(now-1000).toISOString(),...patch});

test('only the server-bound orchestrator is offered, by name, without status text',()=>{
  const providers=[node({id:'worker-1',displayName:'Worker 1'}),node({id:'cluster',displayName:'Orchestrator',type:'clusterodm',activeAttempts:2,capabilities:{options,taskQueueCount:5}}),node({id:'worker-2',displayName:'Orchestrator lookalike'})];
  const picker=orchestratorPicker(providers,'cluster',{now});
  assert.deepEqual(picker.options,[{id:'cluster',label:'Orchestrator',disabled:false}]);
  assert.equal(picker.selectedId,'cluster');assert.equal(picker.usable,true);assert.equal(picker.message,'');
  assert.doesNotMatch(JSON.stringify(picker),/queue|ready|available/i);
});

test('names and types are never used to guess the orchestrator on the client',()=>{
  const picker=orchestratorPicker([node({id:'a',displayName:'Orchestrator',type:'clusterodm'})],'',{now});
  assert.deepEqual(picker.options,[{id:'',label:'Orchestrator',disabled:true}]);assert.equal(picker.message,'No orchestrator is configured');
  assert.equal(orchestratorPicker([node({id:'a'})],'missing',{now}).usable,false);
  assert.equal(orchestratorPicker(undefined,'a').usable,false);
});

test('an orchestrator with a problem stays visible but disabled, with a message',()=>{
  for(const [patch,reason] of [[{lastHealth:'unhealthy'},/unavailable/],[{enabled:false},/disabled/],[{lastHealthAt:new Date(now-3_600_000).toISOString()},/health check needed/]]){
    const picker=orchestratorPicker([node({id:'cluster',displayName:'Orchestrator',...patch}),node({id:'worker',displayName:'Worker'})],'cluster',{now});
    assert.deepEqual(picker.options,[{id:'cluster',label:'Orchestrator',disabled:true}]);
    assert.equal(picker.usable,false);assert.match(picker.message,/^Orchestrator unavailable: /);assert.match(picker.message,reason);
  }
});

test('a changed orchestrator after refresh requires reselection; an unchanged one keeps the selection',()=>{
  const providers=[node({id:'old',displayName:'Old'}),node({id:'new',displayName:'New'})];
  assert.equal(orchestratorPicker(providers,'old',{now,previousId:'old'}).selectedId,'old');
  const changed=orchestratorPicker(providers,'new',{now,previousId:'old'});
  assert.equal(changed.selectedId,'');assert.equal(changed.usable,true);assert.match(changed.message,/Select it again/);
  assert.deepEqual(changed.options.map(item=>[item.id,item.disabled]),[['',true],['new',false]]);
});

test('server binding: configured id, else the only ClusterODM provider, else a single-node deployment',()=>{
  const worker=node({id:'w'}),worker2=node({id:'w2'}),cluster=node({id:'c',type:'clusterodm'}),cluster2=node({id:'c2',type:'clusterodm'});
  const lookup=(list,configuredId='')=>{const limits=[];const result=resolveOrchestrator({configuredId,getProvider:id=>list.find(item=>item.id===id),listByType:(type,limit)=>{limits.push(limit);return list.filter(item=>item.type===type).slice(0,limit);},listAny:limit=>{limits.push(limit);return list.slice(0,limit);}});return{result,limits};};
  assert.equal(lookup([worker,cluster],'w').result?.id,'w');
  assert.equal(lookup([worker,cluster],'gone').result,null);
  assert.equal(lookup([worker,cluster,worker2]).result?.id,'c');
  assert.equal(lookup([cluster,cluster2]).result,null,'two ClusterODM providers are ambiguous');
  assert.equal(lookup([worker]).result?.id,'w');
  assert.equal(lookup([worker,worker2]).result,null,'several plain nodes are ambiguous');
  assert.ok(lookup([worker,worker2]).limits.every(limit=>limit===2),'lookups are bounded');
});

test('an orchestrator outside the listed page is shown from the server summary',()=>{
  const page=Array.from({length:100},(_,index)=>node({id:`w${index}`,displayName:`Worker ${index}`})),summary=node({id:'cluster-101',displayName:'Orchestrator',type:'clusterodm'});
  assert.equal(orchestratorPicker(page,'cluster-101',{now}).usable,false,'the page alone does not contain it');
  const merged=withOrchestrator(page,summary);assert.equal(merged.length,101);
  const picker=orchestratorPicker(merged,'cluster-101',{now});assert.deepEqual(picker.options,[{id:'cluster-101',label:'Orchestrator',disabled:false}]);assert.equal(picker.selectedId,'cluster-101');
  assert.equal(withOrchestrator(merged,summary).length,101,'not duplicated when already listed');
  assert.equal(withOrchestrator(page,null),page);
});
