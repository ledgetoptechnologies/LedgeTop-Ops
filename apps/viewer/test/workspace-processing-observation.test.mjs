import test from 'node:test';
import assert from 'node:assert/strict';
import {processingObservation} from '../workspace-processing-observation.mjs';

test('held and unknown observations explain the current nonterminal state',()=>{
 assert.deepEqual(processingObservation({status:'running',errorCode:'provider_execution_held'}),{badge:'held_for_inspection',message:'The provider has held this run for inspection. Viewer will keep checking the original job.'});
 assert.equal(processingObservation({status:'uploading',errorCode:'provider_submission_observation_unavailable'}).badge,'status_unavailable');
 assert.equal(processingObservation({status:'failed',errorCode:'provider_execution_held'}),null);
 assert.equal(processingObservation({status:'running',errorCode:'some_other_error'}),null);
});
