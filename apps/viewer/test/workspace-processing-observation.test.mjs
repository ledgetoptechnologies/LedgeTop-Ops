import test from 'node:test';
import assert from 'node:assert/strict';
import {processingObservation} from '../workspace-processing-observation.mjs';

test('held and unknown observations explain the current nonterminal state',()=>{
 assert.deepEqual(processingObservation({status:'running',errorCode:'provider_execution_held'}),{badge:'held_for_inspection',message:'The provider has held this run for inspection. Viewer will keep checking the original job.'});
 assert.equal(processingObservation({status:'queued_upstream',errorCode:'provider_execution_held',errorMessage:'Processing options need inspection; Viewer will keep checking this job.'}).message,'Processing options need inspection; Viewer will keep checking this job.');
 assert.equal(processingObservation({status:'running',errorCode:'provider_execution_held',errorMessage:'untrusted provider text'}).message,'The provider has held this run for inspection. Viewer will keep checking the original job.');
 assert.equal(processingObservation({status:'uploading',errorCode:'provider_submission_observation_unavailable'}).badge,'status_unavailable');
 assert.match(processingObservation({status:'pending',errorCode:'provider_initialization_identity_unverified'}).message,/Inspect the provider and saved request/);
 assert.match(processingObservation({status:'uploading',errorCode:'provider_upload_acceptance_unknown'}).message,/may have accepted some files/);
 assert.match(processingObservation({status:'ingesting',errorCode:'staged_commitment_unavailable'}).message,/inspect provider credentials and configuration/);
 assert.match(processingObservation({status:'ingesting',errorCode:'provider_observation_unavailable'}).message,/result download is unavailable/);
 assert.equal(processingObservation({status:'failed',errorCode:'provider_execution_held'}),null);
 assert.equal(processingObservation({status:'running',errorCode:'some_other_error'}),null);
});
