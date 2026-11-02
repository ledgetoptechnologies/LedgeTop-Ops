'use strict';
// Test-only boundary: never delegates to the legacy broker's non-atomic mintGrant.
// The injected function is a synthetic stand-in, not an issuer or trust proof.
function unavailable(){throw Object.assign(new Error('atomic issuance unavailable'),{code:'fixture_atomic_unavailable'});}
function hold(){throw Object.assign(new Error('atomic issuance outcome unknown'),{code:'fixture_atomic_hold'});}
async function issueFixture({scope,atomicOwner,operationId,binding}){
  if(scope!=='synthetic-only'||!atomicOwner||atomicOwner.fixtureScope!=='synthetic-only'||typeof atomicOwner.atomicMintAndSeal!=='function'||typeof operationId!=='string'||!operationId||!binding||typeof binding!=='object')unavailable();
  let result;
  try{result=await atomicOwner.atomicMintAndSeal({operationId,binding:structuredClone(binding)});}catch{hold();}
  if(!result||result.operationId!==operationId||!['committed','exact-replay'].includes(result.outcome)||typeof result.grantSha256!=='string'||!/^[a-f0-9]{64}$/.test(result.grantSha256)||result.encrypted!==true)hold();
  return {operationId,outcome:result.outcome,grantSha256:result.grantSha256,scope:'synthetic-only'};
}
module.exports={issueFixture};
