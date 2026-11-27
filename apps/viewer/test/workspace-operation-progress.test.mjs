import test from 'node:test';
import assert from 'node:assert/strict';
import { operationPercent, operationPhaseLabel } from '../workspace-operation-progress.mjs';

test('operation stage and percent match Background work wording',()=>{
  assert.equal(operationPhaseLabel({status:'leased',phase:'copying_photos',progress:.42}),'copying photos');
  assert.equal(operationPhaseLabel({status:'leased',phase:'assembling_upload'}),'assembling upload');
  assert.equal(operationPhaseLabel({status:'leased',phase:'validating_source'}),'Validating recovery source');
  assert.equal(operationPhaseLabel({status:'queued'}),'queued');
  assert.equal(operationPhaseLabel({status:'leased',phase:'unknown_phase'}),'leased');
  assert.equal(operationPercent({progress:.426}),43);
  assert.equal(operationPercent({progress:2}),100);
  assert.equal(operationPercent({progress:'x'}),0);
});
