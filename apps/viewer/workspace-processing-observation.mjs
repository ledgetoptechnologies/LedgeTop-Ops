// A nonterminal provider observation is attention, not a failed processing run.
export function processingObservation(item){
 if(!item||!['pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting'].includes(item.status))return null;
 if(item.errorCode==='provider_execution_held')return{badge:'held_for_inspection',message:item.errorMessage==='Processing options need inspection; Viewer will keep checking this job.'?item.errorMessage:'The provider has held this run for inspection. Viewer will keep checking the original job.'};
 if(item.errorCode==='staged_commitment_unavailable')return{badge:'status_unavailable',message:'Staged result verification is unavailable. Viewer will keep checking this job; inspect provider credentials and configuration if it persists.'};
 if(item.errorCode==='provider_submission_observation_unavailable')return{badge:'status_unavailable',message:'The provider status is unavailable. Viewer will keep checking the original submission.'};
 return null;
}
