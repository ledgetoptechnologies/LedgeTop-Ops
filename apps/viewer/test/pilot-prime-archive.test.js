'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {primePilotArchive}=require('./helpers/pilot-prime-archive.cjs');
test('archive prime streams a completed task to a bounded digest without saving it',async()=>{
 let downloads=0;const body=Buffer.from('synthetic archive'),adapter={async status(id){return{uuid:id,status:'completed'}},async downloadAll(){downloads++;return new Response(body)}};
 const result=await primePilotArchive({adapter,providerTaskId:'task',maxBytes:64,timeoutMs:1000});assert.deepEqual(result,{sha256:crypto.createHash('sha256').update(body).digest('hex'),byteSize:body.length});assert.equal(downloads,1);
 await assert.rejects(primePilotArchive({adapter,providerTaskId:'task',maxBytes:1,timeoutMs:1000}),/byte limit/);
 const incomplete={...adapter,status:async()=>({uuid:'task',status:'running'})};await assert.rejects(primePilotArchive({adapter:incomplete,providerTaskId:'task'}),/not completed/);assert.equal(downloads,2);
 const wrong={...adapter,status:async()=>({uuid:'other',status:'completed'})};await assert.rejects(primePilotArchive({adapter:wrong,providerTaskId:'task'}),/not completed/);
 const empty={...adapter,downloadAll:async()=>new Response(new Uint8Array())};await assert.rejects(primePilotArchive({adapter:empty,providerTaskId:'task'}),/empty/);
});
