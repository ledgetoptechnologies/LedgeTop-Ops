// A nonterminal provider observation is attention, not a failed processing run.
export function processingObservation(item){
 if(!item||!['pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting'].includes(item.status))return null;
 if(item.errorCode==='provider_execution_held')return{badge:'held_for_inspection',message:item.errorMessage==='Processing options need inspection; Viewer will keep checking this job.'?item.errorMessage:'The provider has held this run for inspection. Viewer will keep checking the original job.'};
 if(item.errorCode==='provider_initialization_identity_unverified')return{badge:'held_for_inspection',message:'The original submission identity cannot be verified. Inspect the provider and saved request before continuing.'};
 if(item.errorCode==='provider_upload_acceptance_unknown')return{badge:'held_for_inspection',message:'The upload outcome is unknown and the provider may have accepted some files. This run needs inspection before it can continue.'};
 if(item.errorCode==='staged_commitment_unavailable')return{badge:'status_unavailable',message:'Staged result verification is unavailable. Viewer will keep checking this job; inspect provider credentials and configuration if it persists.'};
 if(item.errorCode==='provider_observation_unavailable'&&item.status==='ingesting'){const safe=['Provider denied access to the result. Inspect the provider credentials and permissions.','The provider result was not found. Inspect the original job and its retained result.','The provider rejected the result request. Inspect the provider and original job.'];return{badge:'status_unavailable',message:safe.includes(item.errorMessage)?item.errorMessage:'The provider result download is unavailable. Viewer will keep checking the original job.'};}
 if(item.errorCode==='provider_submission_observation_unavailable')return{badge:'status_unavailable',message:'The provider status is unavailable. Viewer will keep checking the original submission.'};
 return null;
}
