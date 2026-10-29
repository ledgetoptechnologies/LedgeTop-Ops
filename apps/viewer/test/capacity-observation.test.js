'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCapacityObserver}=require('../server/capacityObservation');
const sample={domainId:'d',domainRevision:'v',availableBytes:1000,reserveBytes:1,availableInodes:100,reserveInodes:1};
test('observation requires an attestor, exact identity, live acquisition and bounded monotonic age',()=>{
 assert.throws(()=>createCapacityObserver(),{code:'capacity_observation_unavailable'});
 let now=100;let value={domainId:'d',domainRevision:'v',sampledAt:100,samples:[sample]};
 const observer=createCapacityObserver({attestor:{observe:()=>value},clock:()=>now,maxAgeMs:10});
 const token=observer.observe('d','v');value.samples[0].availableBytes=5;assert.equal(observer.validate(token,'d','v')[0].availableBytes,1000);
 assert.throws(()=>observer.validate({},'d','v'),{code:'capacity_observation_unavailable'});assert.throws(()=>observer.validate(token,'d','other'),{code:'capacity_observation_unavailable'});
 now=111;assert.throws(()=>observer.validate(token,'d','v'),{code:'capacity_observation_unavailable'});
 now=99;assert.throws(()=>observer.validate(token,'d','v'),{code:'capacity_observation_unavailable'});
 now=120;value={...value,sampledAt:100};assert.throws(()=>observer.observe('d','v'),{code:'capacity_observation_unavailable'});
 value={...value,sampledAt:121};assert.throws(()=>observer.observe('d','v'),{code:'capacity_observation_unavailable'});
 value={...value,sampledAt:120,domainRevision:'different'};assert.throws(()=>observer.observe('d','v'),{code:'capacity_observation_unavailable'});
});
test('provider failures, missing data, too many roots and slow collection fail closed',()=>{
 let now=1;const bad=[()=>{throw Error('offline')},()=>({domainId:'d',domainRevision:'v',sampledAt:now,samples:[]}),()=>({domainId:'d',domainRevision:'v',sampledAt:now,samples:Array(65).fill(sample)}),()=>{now=100;return {domainId:'d',domainRevision:'v',sampledAt:now,samples:[sample]}}];
 for(const observe of bad){now=1;const observer=createCapacityObserver({attestor:{observe},clock:()=>now,maxAgeMs:10});assert.throws(()=>observer.observe('d','v'),{code:'capacity_observation_unavailable'});}
});
