'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {validate}=require('../server/nativeEpochReceiptCandidate');
const identity={operationId:'00000000-0000-4000-8000-000000000001',taskUuid:'00000000-0000-4000-8000-000000000002',environment:'staging',manifestId:'attempt-1',manifestSha256:'a'.repeat(64),planSha256:'b'.repeat(64),requestId:'00000000-0000-4000-8000-000000000003'};
const common={operationId:identity.operationId,operationKind:'plan_bind',taskUuid:identity.taskUuid,environment:identity.environment,generation:1,epoch:1,manifestId:identity.manifestId,manifestSha256:identity.manifestSha256};
const wrap=result=>({protocol:'native-plan-epoch-v2-experiment',version:2,taskUuid:identity.taskUuid,operationId:identity.operationId,environment:identity.environment,generation:1,epoch:1,result});
const manifest={bindingId:'c'.repeat(64)},plan={planSha256:identity.planSha256};
const checks={checkManifest:m=>m===manifest,checkPlan:(p,m,h)=>p===plan&&m===manifest&&h===identity.planSha256};
test('closed and open outcomes preserve plan and manifest history',()=>{
  for(const result of [
    {...common,state:'open'},
    {...common,state:'intent',planSha256:identity.planSha256},
    {...common,state:'open_unbound',manifestReceipt:null,planIntentPresent:false,planIntentSha256:null,planReceipt:null},
    {...common,state:'open_unbound',manifestReceipt:manifest,planIntentPresent:true,planIntentSha256:identity.planSha256,planReceipt:null},
    {...common,state:'open_bound',manifestReceipt:manifest,planIntentPresent:true,planIntentSha256:identity.planSha256,planReceipt:plan},
    {...common,state:'closed_without_bind',requestId:identity.requestId,manifestReceipt:manifest,planIntentPresent:true,planIntentSha256:identity.planSha256,planReceipt:null},
    {...common,state:'bound_then_closed',requestId:identity.requestId,manifestReceipt:manifest,planIntentPresent:true,planIntentSha256:identity.planSha256,planReceipt:plan},
  ])assert.equal(validate(wrap(result),identity,checks),result);
});
test('ambiguous or mismatched outcomes are held',()=>{
  const base={...common,state:'closed_without_bind',requestId:identity.requestId,manifestReceipt:manifest,planIntentPresent:true,planIntentSha256:identity.planSha256,planReceipt:null};
  for(const result of [{...base,extra:true},{...base,requestId:identity.operationId},{...base,epoch:true},{...base,planIntentPresent:1},{...base,planIntentSha256:null},{...base,manifestReceipt:null},{...base,state:'bound_then_closed'},{...base,planReceipt:plan},{...base,manifestSha256:'d'.repeat(64)}])assert.throws(()=>validate(wrap(result),identity,checks),{code:'native_epoch_hold'});
  assert.throws(()=>validate(wrap(base),identity),{code:'native_epoch_hold'});
  assert.throws(()=>validate({...wrap(base),operationId:identity.requestId},identity,checks),{code:'native_epoch_hold'});
  assert.throws(()=>validate(wrap(base),{...identity,requestId:undefined},checks),{code:'native_epoch_hold'});
  assert.throws(()=>validate(wrap({...common,state:'open'}),identity,{...checks,action:'revoke'}),{code:'native_epoch_hold'});
});
test('manifest and plan actions require their own exact receipt validators',()=>{
  assert.equal(validate(wrap(manifest),identity,{...checks,action:'manifest'}),manifest);
  assert.equal(validate(wrap(plan),{...identity,manifestReceipt:manifest},{...checks,action:'accept'}),plan);
  assert.throws(()=>validate(wrap(plan),identity,{action:'accept'}),{code:'native_epoch_hold'});
});
