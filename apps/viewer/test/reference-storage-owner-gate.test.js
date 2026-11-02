'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {issueAtomicGrant}=require('../server/referenceStorageOwnerGate');
test('unavailable storage authority cannot invoke injected broker or accept claimed custody',()=>{
 let calls=0;
 assert.throws(()=>issueAtomicGrant({broker:{mintGrant(){calls++;}},sourcePin:true,verify:()=>true,enabled:true}),{code:'REFERENCE_STORAGE_OWNER_UNAVAILABLE'});
 assert.equal(calls,0);
});
