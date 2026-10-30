'use strict';
const {performance}=require('node:perf_hooks');
const issuedVerifiers=new WeakSet();
function unavailable(){return Object.assign(new Error('quiescence verification unavailable'),{code:'capacity_quiescence_unavailable'});}
// Interface only: no real handle/process verifier is supplied. Issuance does not
// make a caller-selected verifier trustworthy, and cannot fence future writes.
function createQuiescenceVerifier({verifier,clock=()=>performance.now(),maxAgeMs=2000}={}){
 if(!verifier||typeof verifier.verify!=='function'||typeof clock!=='function'||!Number.isFinite(maxAgeMs)||maxAgeMs<=0||maxAgeMs>5000)throw unavailable();
 const receipts=new WeakMap();
 const now=()=>{const value=clock();if(!Number.isFinite(value)||value<0)throw unavailable();return value;};
 const wrapper=Object.freeze({
  check(binding){
   const start=now();let result;
   try{result=verifier.verify(Object.freeze({...binding}));}catch{throw unavailable();}
   const end=now();
   if(end<start||end-start>maxAgeMs||!result||result.quiescent!==true||result.id!==binding.id||result.ownerId!==binding.ownerId||result.fenceToken!==binding.fenceToken||result.generation!==binding.generation||!Number.isFinite(result.verifiedAt)||result.verifiedAt<start||result.verifiedAt>end)throw unavailable();
   const receipt=Object.freeze({});receipts.set(receipt,{...binding,start});return receipt;
  },
  validate(receipt,binding){
   const item=receipts.get(receipt),time=now();
   if(!item||item.id!==binding.id||item.ownerId!==binding.ownerId||item.fenceToken!==binding.fenceToken||item.generation!==binding.generation||time<item.start||time-item.start>maxAgeMs)throw unavailable();
  },
 });issuedVerifiers.add(wrapper);return wrapper;
}
function isQuiescenceVerifier(verifier){return issuedVerifiers.has(verifier);}
module.exports={createQuiescenceVerifier,isQuiescenceVerifier};
