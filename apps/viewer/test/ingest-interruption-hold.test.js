'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
// This test exits before archive handling; isolate it from the optional ZIP dependency.
const Module=require('node:module'),load=Module._load;
let processOne;
try{Module._load=function(name,...args){return name==='unzipper'?{}:load.call(this,name,...args);};({processOne}=require('../server/processingWorker'));}
finally{Module._load=load;}

for(const error of [Object.assign(new Error('interrupted'),{name:'AbortError'}),Object.assign(new Error('lease lost'),{code:'lease_lost'})]){
  test(`interrupted ingest leaves the lease for recovery after repeated attempts (${error.name}:${error.code||''})`,async()=>{
    const job={id:'job',attempt_id:'attempt',job_type:'ingest',lease_owner:'worker',attempt_count:9};
    const processing={claimJob:()=>job,getAttempt:()=>{throw error;}};
    assert.equal(await processOne({processing},'worker'),true);
  });
}
