// Create a draft only when a recognized control set exists.
export async function submitOrPrepareGcpTask({api,signal,submissionId,projectId,datasetId,taskDisplayName,providerId,presetId,options,canReadGcp=true,canWriteGcp=false,hasCsv=false}) {
  if(!canReadGcp && hasCsv)throw new Error('Ground control access is required to check this CSV before processing.');
  const url=`/api/v1/datasets/${encodeURIComponent(datasetId)}/gcp-sets`;
  const control=canReadGcp ? await api(canWriteGcp ? `${url}/discover` : url,canWriteGcp ? {method:'POST',body:{},signal} : {signal}) : {sets:[]};
  if(!Array.isArray(control?.sets))throw new Error('Control point discovery is unavailable. Try again before processing.');
  if(control.sets.length){
    if(!canWriteGcp)throw new Error('Ground control write access is required to mark this source before processing.');
    const processingSettings={providerId,...(presetId?{presetId}:{}),options};
    const result=await api('/api/v1/tasks',{method:'POST',headers:{'Idempotency-Key':submissionId},body:{submissionId,projectId,datasetId,displayName:taskDisplayName,processingSettings},signal});
    if(!result?.task?.id)throw new Error('The ground control task could not be prepared.');
    return {...result,pendingGcp:true,processingSettings};
  }
  return api('/api/v1/task-submissions',{method:'POST',headers:{'Idempotency-Key':submissionId},body:{submissionId,projectId,datasetId,taskDisplayName,providerId,...(presetId?{presetId}:{}),options},signal});
}
