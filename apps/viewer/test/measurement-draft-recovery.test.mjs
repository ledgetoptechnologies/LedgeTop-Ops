import test from 'node:test';
import assert from 'node:assert/strict';
import {createMeasurementDraftRecovery} from '../measurement-draft-recovery.mjs';

const session=()=>({subject:'ops:one',audience:'ops',model:{id:'model',activeVersion:{id:'version'}},permissions:{measure:true}});
test('memory checkpoint restores only after same identity/model/version recovery and only once',async()=>{
  const recovery=createMeasurementDraftRecovery(),draft={vertices:[[1,2,0]],tool:'polygon'},calls=[];
  recovery.capture('session-expired',session(),{exportDraft:()=>draft});
  assert.equal(await recovery.restore(session(),{restoreDraft:async value=>{calls.push(value);return true;}}),true);
  assert.equal(calls[0],draft);assert.equal(await recovery.restore(session(),{restoreDraft(){throw new Error('double restore');}}),false);
});
test('revocation, changed user/audience/model/version and lost measure permission discard private draft',async()=>{
  for(const change of [s=>s.subject='ops:two',s=>s.audience='client',s=>s.model.id='other',s=>s.model.activeVersion.id='other',s=>s.permissions.measure=false]){
    const recovery=createMeasurementDraftRecovery();recovery.capture('session-expired',session(),{exportDraft:()=>({draft:true})});const next=session();change(next);
    assert.equal(await recovery.restore(next,{restoreDraft(){throw new Error('must not restore');}}),false);
  }
  for(const reason of ['authorization-required','scope-changed','redemption-failed']){
    const recovery=createMeasurementDraftRecovery();recovery.capture('session-expired',session(),{exportDraft:()=>({draft:true})});recovery.capture(reason,session(),{});
    assert.equal(await recovery.restore(session(),{restoreDraft(){throw new Error('must not restore');}}),false);
  }
});
test('duplicate expiry notices cannot overwrite a retained draft with cleared workspace',async()=>{
  const recovery=createMeasurementDraftRecovery(),draft={draft:true};recovery.capture('session-expired',session(),{exportDraft:()=>draft});recovery.capture('session-expired',session(),{exportDraft:()=>null});
  assert.equal(await recovery.restore(session(),{restoreDraft:value=>value===draft}),true);
});
test('transient restore failure retains checkpoint for later renewal, but explicit conflict clears it',async()=>{
  const recovery=createMeasurementDraftRecovery(),draft={draft:true};recovery.capture('session-expired',session(),{exportDraft:()=>draft});assert.equal(await recovery.restore(session(),{restoreDraft:async()=>{throw Object.assign(new Error('network unavailable'),{code:'measurement_draft_restore_retry'});}}),false);assert.equal(recovery.hasPending(),true);
  assert.equal(await recovery.restore(session(),{restoreDraft:async value=>value===draft}),true);assert.equal(recovery.hasPending(),false);
  recovery.capture('session-expired',session(),{exportDraft:()=>draft});assert.equal(await recovery.restore(session(),{restoreDraft:async()=>false}),false);assert.equal(recovery.hasPending(),false);
});
test('concurrent restore is not duplicated and late failure cannot revive a revoked checkpoint',async()=>{
  const recovery=createMeasurementDraftRecovery();let reject,calls=0;recovery.capture('session-expired',session(),{exportDraft:()=>({draft:true})});const workspace={restoreDraft:()=>{calls++;return new Promise((_resolve,no)=>{reject=no;});}};const first=recovery.restore(session(),workspace);assert.equal(await recovery.restore(session(),workspace),false);assert.equal(calls,1);recovery.capture('authorization-required',session(),{});reject(new Error('late'));assert.equal(await first,false);assert.equal(recovery.hasPending(),false);
});
