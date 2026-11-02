'use strict';
// Proposal oracle only. No production broker or worker state is touched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fixture = require('./fixtures/reference-range-budget-policy-vectors.json');
const policy = fixture.policy;
function plan(groups) {
  let count=0n, bytes=0n, requests=0n;
  const chunk=BigInt(policy.chunkBytes);
  for (const group of groups) {
    if (!Number.isSafeInteger(group.bytes) || group.bytes < 0 || !Number.isSafeInteger(group.count) || group.count < 1 || group.bytes > policy.maxObjectBytes) return null;
    const n=BigInt(group.count), b=BigInt(group.bytes);
    count+=n; bytes+=b*n; requests+=(b===0n ? 1n : (b+chunk-1n)/chunk)*n;
  }
  if (count>BigInt(policy.maxObjects) || bytes>BigInt(policy.maxManifestBytes) || requests>BigInt(policy.maxBaseRequests)) return null;
  const ceilHalf=x=>(x*3n+1n)/2n;
  const requestBudget=ceilHalf(requests), byteBudget=ceilHalf(bytes);
  if (requestBudget>BigInt(policy.maxRequests)) return null;
  return {baseRequests:Number(requests),requestBudget:Number(requestBudget),byteBudget:Number(byteBudget)};
}
test('cross-language proposal vectors use exact integer ceiling and manifest bounds', async t => {
  for (const vector of fixture.plans) await t.test(vector.name, () => {
    const result=plan(vector.objects);
    assert.equal(result!==null,vector.accepted);
    if (result) assert.deepEqual(result,{baseRequests:vector.baseRequests,requestBudget:vector.requestBudget,byteBudget:vector.byteBudget});
  });
});
test('synthetic serialized range ledger holds an aborted range across generation and grant changes', () => {
  let state={identity:null, ranges:{}, chargedRequests:0, offset:0};
  for (const vector of fixture.recovery) {
    if (vector.action==='restart') { state=JSON.parse(JSON.stringify(state)); assert.equal(state.ranges[vector.range] === 'verified' ? 'verified' : 'hold',vector.expected); assert.equal(state.offset,vector.offset); continue; }
    if (vector.action==='verify') { assert.equal(state.ranges[vector.range],'uncertain'); state.ranges[vector.range]='verified'; state.offset=vector.offset; assert.equal(vector.expected,'verified'); continue; }
    const same=state.identity===null || state.identity===vector.identity;
    const outcome=same && !state.ranges[vector.range] ? 'charged' : 'hold';
    assert.equal(outcome,vector.expected);
    if (outcome==='charged') { state.identity=vector.identity; state.ranges[vector.range]='uncertain'; state.chargedRequests++; }
    assert.equal(state.offset,vector.offset);
  }
  assert.equal(state.chargedRequests,2);
});
