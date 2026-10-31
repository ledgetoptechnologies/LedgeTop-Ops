'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {primePilotArchive}=require('./helpers/pilot-prime-archive.cjs');
const {requirePrimeBinding}=require('./helpers/pilot-prime-binding.cjs');
test('archive prime streams a completed task to a bounded digest without saving it',async()=>{
 let downloads=0;const body=Buffer.from('synthetic archive'),adapter={attemptCapability:'A'.repeat(43),async status(id){return{uuid:id,status:'completed'}},async downloadAll(){downloads++;return new Response(body)}};
 const result=await primePilotArchive({adapter,providerTaskId:'task',maxBytes:64,timeoutMs:1000});assert.deepEqual(result,{sha256:crypto.createHash('sha256').update(body).digest('hex'),byteSize:body.length});assert.equal(downloads,1);
 await assert.rejects(primePilotArchive({adapter,providerTaskId:'task',maxBytes:1,timeoutMs:1000}),/byte limit/);
 const incomplete={...adapter,status:async()=>({uuid:'task',status:'running'})};await assert.rejects(primePilotArchive({adapter:incomplete,providerTaskId:'task'}),/not completed/);assert.equal(downloads,2);
 const wrong={...adapter,status:async()=>({uuid:'other',status:'completed'})};await assert.rejects(primePilotArchive({adapter:wrong,providerTaskId:'task'}),/not completed/);
 const empty={...adapter,downloadAll:async()=>new Response(new Uint8Array())};await assert.rejects(primePilotArchive({adapter:empty,providerTaskId:'task'}),/empty/);
 for(const capability of [null,'','bad'])await assert.rejects(primePilotArchive({adapter:{...adapter,attemptCapability:capability},providerTaskId:'task'}),/invalid archive prime configuration/);
});
test('archive prime refuses an unreserved or mismatched provider before resolving credentials',()=>{
 const identity={attemptId:'a',providerId:'p',providerTaskId:'t'},attempt={id:'a',providerId:'p',providerTaskId:'t'},endpoint='https://127.0.0.1:28443',provider={id:'p',type:'nodeodm',endpoint,enabled:true};let resolutions=0;
 const args={identity,attempt,provider,endpoint,processing:{attemptRequiresReservation:()=>true},resolveCapability:()=>{resolutions++;return'A'.repeat(43)}};
 assert.equal(requirePrimeBinding(args),'A'.repeat(43));
 for(const change of [{provider:{...provider,endpoint:'https://other.invalid'}},{provider:{...provider,id:'other'}},{provider:{...provider,enabled:false}},{attempt:{...attempt,providerTaskId:'other'}},{processing:{attemptRequiresReservation:()=>false}}])assert.throws(()=>requirePrimeBinding({...args,...change}),/binding unavailable/);
 assert.equal(resolutions,1);assert.throws(()=>requirePrimeBinding({...args,resolveCapability:()=>null}),/capability unavailable/);
});
