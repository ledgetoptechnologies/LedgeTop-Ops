'use strict';
const {performance}=require('node:perf_hooks');
const {evaluateCapacityBudget}=require('./capacityBudget');
const observers=new WeakSet();
function unavailable(){return Object.assign(new Error('trusted capacity observation unavailable'),{code:'capacity_observation_unavailable'});}
// Trusted provider is deliberately not supplied by this prototype. It must
// independently attest the configured shared quota/domain and all roots.
// This wrapper only checks identity, sample shape and local monotonic age.
// Freshness does not reserve against unrelated writers or guarantee continued
// headroom. The caller-selectable factory is not a production trust anchor.
function createCapacityObserver({attestor,clock=()=>performance.now(),maxAgeMs=2000}={}){
  if(!attestor||typeof attestor.observe!=='function'||typeof clock!=='function'||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||maxAgeMs>5000)throw unavailable();
  const issued=new WeakMap();
  function readClock(){const n=clock();if(!Number.isFinite(n)||n<0)throw unavailable();return n;}
  const observer=Object.freeze({
    observe(domainId,domainRevision){
      const started=readClock();let observation;
      try{observation=attestor.observe({domainId,domainRevision});}catch{throw unavailable();}
      const ended=readClock();
      if(ended<started||ended-started>maxAgeMs||!observation||!Number.isFinite(observation.sampledAt)||observation.sampledAt<started||observation.sampledAt>ended||observation.domainId!==domainId||observation.domainRevision!==domainRevision||!Array.isArray(observation.samples)||!observation.samples.length||observation.samples.length>64)throw unavailable();
      // Copy scalar fields; later provider or caller mutations cannot change a receipt.
      const samples=observation.samples.map(x=>Object.freeze({...x}));
      try{evaluateCapacityBudget({domainId,domainRevision,samples,commitments:[],requestBytes:0,requestInodes:0});}catch{throw unavailable();}
      const token=Object.freeze({});issued.set(token,{domainId,domainRevision,samples:Object.freeze(samples),started});return token;
    },
    validate(token,domainId,domainRevision){
      const item=issued.get(token),now=readClock();
      if(!item||item.domainId!==domainId||item.domainRevision!==domainRevision||now<item.started||now-item.started>maxAgeMs)throw unavailable();
      return item.samples;
    },
  });
  observers.add(observer);
  return observer;
}
function isCapacityObserver(observer){return observers.has(observer);}
module.exports={createCapacityObserver,isCapacityObserver};
