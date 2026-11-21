import test from 'node:test';
import assert from 'node:assert/strict';
import {isOrchestrator,orchestratorPicker} from '../workspace-processing-node.mjs';

const now=Date.now();
const options=['pc-ept','gltf','3d-tiles'].map(name=>({name,type:'bool',value:true}));
const node=patch=>({id:'id',displayName:'Node',type:'nodeodm',enabled:true,capabilityFingerprint:'fp',capabilities:{options,taskQueueCount:0},lastHealth:'healthy',lastHealthAt:new Date(now-1000).toISOString(),...patch});

test('only the orchestrator is offered, by name, without status text',()=>{
  const picker=orchestratorPicker([node({id:'worker-1',displayName:'Worker 1'}),node({id:'cluster',displayName:'Orchestrator',type:'clusterodm',activeAttempts:2,capabilities:{options,taskQueueCount:5}}),node({id:'worker-2',displayName:'Worker 2'})],{now});
  assert.deepEqual(picker.options,[{id:'cluster',label:'Orchestrator',disabled:false}]);
  assert.equal(picker.selectedId,'cluster');assert.equal(picker.usable,true);assert.equal(picker.message,'');
  assert.doesNotMatch(JSON.stringify(picker),/queue|ready|available/i);
});

test('an orchestrator is recognised by ClusterODM type or by its name',()=>{
  assert.equal(isOrchestrator(node({type:'clusterodm',displayName:'Main'})),true);
  assert.equal(isOrchestrator(node({displayName:'ODM orchestrator'})),true);
  assert.equal(isOrchestrator(node({displayName:'Worker'})),false);
  assert.equal(isOrchestrator(null),false);
});

test('an orchestrator with a problem stays visible but disabled, with a message',()=>{
  for(const [patch,reason] of [[{lastHealth:'unhealthy'},/unavailable/],[{enabled:false},/disabled/],[{lastHealthAt:new Date(now-3_600_000).toISOString()},/health check needed/]]){
    const picker=orchestratorPicker([node({id:'cluster',displayName:'Orchestrator',type:'clusterodm',...patch}),node({id:'worker',displayName:'Worker'})],{now});
    assert.deepEqual(picker.options,[{id:'cluster',label:'Orchestrator',disabled:true}]);
    assert.equal(picker.usable,false);assert.match(picker.message,/^Orchestrator unavailable: /);assert.match(picker.message,reason);
  }
});

test('no configured orchestrator yields a disabled placeholder and a message, never a worker',()=>{
  const picker=orchestratorPicker([node({id:'worker',displayName:'Worker'})],{now});
  assert.deepEqual(picker.options,[{id:'',label:'Orchestrator',disabled:true}]);
  assert.equal(picker.selectedId,'');assert.equal(picker.usable,false);assert.equal(picker.message,'No orchestrator is configured');
  assert.equal(orchestratorPicker(undefined).usable,false);
});
