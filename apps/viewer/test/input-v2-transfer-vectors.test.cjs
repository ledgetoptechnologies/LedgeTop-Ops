'use strict';
// Review-only cross-language contract check. This does not enable a broker.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const fixture=process.env.VIEWER_TRANSFER_VECTORS;
const fields=['protocolVersion','jobId','generation','environment','sourceId','manifestSha256','capabilityFingerprint','transferEpoch','grantId','issuedAt','expiresAt','rangeBytes','totalRequestBudget','totalByteBudget'];
function validate(raw){
 const obj=JSON.parse(raw);if(!obj||Array.isArray(obj)||typeof obj!=='object'||Object.keys(obj).length!==fields.length||fields.some(k=>!Object.hasOwn(obj,k)))throw Error('fields');
 const ordered=Object.fromEntries(Object.keys(obj).sort().map(k=>[k,obj[k]]));if(JSON.stringify(ordered)!==raw)throw Error('noncanonical');
 if(obj.protocolVersion!==2||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(obj.jobId)||!['staging','production'].includes(obj.environment))throw Error('identity');
 for(const key of ['sourceId','transferEpoch','grantId'])if(typeof obj[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(obj[key]))throw Error('identifier');
 for(const key of ['manifestSha256','capabilityFingerprint'])if(typeof obj[key]!=='string'||!/^[a-f0-9]{64}$/.test(obj[key]))throw Error('digest');
 for(const key of ['generation','rangeBytes','totalRequestBudget','totalByteBudget'])if(!Number.isSafeInteger(obj[key])||obj[key]<(key==='generation'||key==='rangeBytes'?1:0))throw Error('integer');
 for(const key of ['issuedAt','expiresAt'])if(typeof obj[key]!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(obj[key])||obj[key].startsWith('0000-')||!Number.isFinite(Date.parse(obj[key]))||new Date(obj[key]).toISOString()!==obj[key])throw Error('date');
 if(Date.parse(obj.expiresAt)<=Date.parse(obj.issuedAt))throw Error('expiry');return obj;
}
test('proposed v2 grant bytes and invalid representations agree with shared vectors',{skip:!fixture},()=>{
 const data=JSON.parse(fs.readFileSync(fixture,'utf8')),v=data.canonicalGrant,raw=v.canonicalUtf8,obj=validate(raw);
 assert.deepEqual(obj,v.payload);assert.equal(crypto.createHash('sha256').update(Buffer.from(v.domainUtf8,'utf8')).update(Buffer.from(v.domainSuffixHex,'hex')).update(Buffer.from(raw,'utf8')).digest('hex'),v.sha256);
 const mutations=[raw.replace('"jobId":','"jobId":"11111111-2222-4333-8444-555555555555","jobId":'),raw.replace('{','{"unknown":1,'),raw.replace('"protocolVersion":2','"protocolVersion":2.0'),raw.replace('"generation":1','"generation":1e0'),raw.replace('"totalByteBudget":16777218','"totalByteBudget":9007199254740992'),raw.replace('12:00:00.000Z','12:00:00Z'),raw.replace('12:10:00.000Z','12:10:00.000+00:00'),raw.replace('11111111-2222-4333-8444-555555555555','invalid-job'),raw.replace('2026-10-30T12:00:00.000Z','0000-01-01T00:00:00.000Z')];
 assert.equal(mutations.length,v.invalidMutations.length);for(const mutated of mutations)assert.throws(()=>validate(mutated));
 for(const invalid of data.invalidRawVectors){assert.equal(invalid.expected,'reject');assert.throws(()=>validate(invalid.utf8));}
});
test('proposed replay, renewal, expiry and unknown-commit vectors preserve accounting',{skip:!fixture},()=>{
 const data=JSON.parse(fs.readFileSync(fixture,'utf8')),get=name=>data.vectors.find(v=>v.name===name);
 const replay=get('same-request-id-replay');assert.equal(replay.first.requestId,replay.replay.requestId);assert.equal(replay.replay.emitBody,false);assert.equal(replay.replay.additionalChargeRequests,0);assert.equal(replay.replay.additionalChargeBytes,0);
 const renewal=get('renewal-retains-spend');assert.equal(renewal.budgetRequests-renewal.spentBeforeRenewalRequests,renewal.remainingAfterRenewalRequests);assert.equal(renewal.budgetBytes-renewal.spentBeforeRenewalBytes,renewal.remainingAfterRenewalBytes);
 const expiry=get('expiry-observed-before-clock-rollback');let observed=Math.max(expiry.observedClockSeconds,expiry.laterClockSeconds);assert.ok(observed>=expiry.expiresAtSeconds);assert.equal(expiry.newAdmission,'deny');assert.equal(expiry.expiryObservationCommittedBeforeDenial,true);
 const unknown=get('unknown-commit');assert.equal(unknown.commitOutcome,'unknown');assert.equal(unknown.emitBody,false);assert.equal(unknown.action,'reconcile_then_fresh_request_and_charge');
 const mismatch=get('status-identity-mismatch');assert.equal(mismatch.changedField,'sourceId');assert.equal(mismatch.result,'deny');
 for(const name of ['empty-object','one-byte-beyond-range']){const v=get(name);assert.equal(v.baseRequests+v.retryRequests,v.requestBudget);assert.equal(v.baseBytes+v.retryBytes,v.byteBudget);}
});
test('proposed range, budget and loss examples agree with shared vectors',{skip:!fixture},()=>{
 const data=JSON.parse(fs.readFileSync(fixture,'utf8')),get=name=>data.vectors.find(v=>v.name===name),v=get('half-open-http-inclusive');
 assert.equal(v.requestRange,`bytes=${v.start}-${v.endExclusive-1}`);assert.equal(v.contentRange,`bytes ${v.start}-${v.endExclusive-1}/${v.objectBytes}`);assert.equal(v.contentLength,v.endExclusive-v.start);assert.equal(v.status,206);
 const empty=get('zero-byte-http');assert.equal(empty.objectBytes,0);assert.equal(empty.rangeHeader,null);assert.equal(empty.status,200);assert.equal(empty.contentLength,0);
 const loss=get('lost-last-byte-then-retry');assert.equal(loss.requests.reduce((s,r)=>s+r.end-r.start,0),loss.chargedBytes);assert.equal(loss.requests.length,loss.chargedRequests);
 const insufficient=get('first-full-range-lost-insufficient-retry-bytes');assert.equal(insufficient.byteBudget-insufficient.firstRequest.chargedBytes,insufficient.retry.remainingBytes);assert.ok(insufficient.retry.end-insufficient.retry.start>insufficient.retry.remainingBytes);assert.equal(insufficient.retry.admission,'deny_insufficient_bytes');
 const concurrent=get('concurrent-budget-precharge');let bytes=0,requests=0,accepted=0;for(const item of concurrent.simultaneousRequests){if(requests+1<=concurrent.requestBudget&&bytes+item.bytes<=concurrent.byteBudget){requests++;bytes+=item.bytes;accepted++;}}assert.equal(accepted,concurrent.acceptedCount);assert.equal(bytes,concurrent.chargedBytes);assert.equal(requests,concurrent.chargedRequests);
});
