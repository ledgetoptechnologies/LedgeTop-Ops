'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {ReferenceTransferBroker}=require('../server/referenceTransferBroker');
const {issueFixture}=require('./helpers/atomic-grant-adapter-boundary.cjs');
test('legacy broker cannot be mistaken for an atomic owner or called as fallback',async()=>{
 const legacy=Object.create(ReferenceTransferBroker.prototype);let calls=0;legacy.mintGrant=()=>{calls++};
 await assert.rejects(issueFixture({scope:'synthetic-only',atomicOwner:legacy,operationId:'op',binding:{}}),{code:'fixture_atomic_unavailable'});assert.equal(calls,0);
});
test('fixture boundary holds unknown and malformed outcomes without retry',async()=>{
 let calls=0;const binding={attemptId:'synthetic'};
 const synthetic={fixtureScope:'synthetic-only',atomicMintAndSeal:async()=>{calls++;throw Error('unknown commit')}};
 await assert.rejects(issueFixture({scope:'synthetic-only',atomicOwner:synthetic,operationId:'op',binding}),{code:'fixture_atomic_hold'});assert.equal(calls,1);
 synthetic.atomicMintAndSeal=async()=>({operationId:'other',outcome:'committed',encrypted:true,grantSha256:'a'.repeat(64)});
 await assert.rejects(issueFixture({scope:'synthetic-only',atomicOwner:synthetic,operationId:'op',binding}),{code:'fixture_atomic_hold'});
 synthetic.atomicMintAndSeal=async()=>({operationId:'op',outcome:'exact-replay',encrypted:true,grantSha256:'a'.repeat(64)});
 assert.deepEqual(await issueFixture({scope:'synthetic-only',atomicOwner:synthetic,operationId:'op',binding}),{operationId:'op',outcome:'exact-replay',grantSha256:'a'.repeat(64),scope:'synthetic-only'});
 await assert.rejects(issueFixture({scope:'production',atomicOwner:synthetic,operationId:'op',binding}),{code:'fixture_atomic_unavailable'});
});
