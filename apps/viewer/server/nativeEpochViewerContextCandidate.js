'use strict';
// Test-only context capture. It does not authorize a remote operation.
const crypto=require('node:crypto'),{validate}=require('./nativeManifestCandidate');
const hold=()=>Object.assign(new Error('native epoch context requires review'),{code:'native_epoch_hold'});
function capture({db,processing,transport,expectedEnvironment,attemptId,enabled=false}){
  try{
    if(enabled!==true||!db||!processing||processing.database!==db||!transport||typeof transport.identity!=='string'||!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(transport.identity)||!['staging','production'].includes(expectedEnvironment)||['getAttempt','getTask','getProvider','getProject'].some(name=>typeof processing[name]!=='function'))throw hold();
    const row=db.prepare('SELECT * FROM native_binding_candidate WHERE attempt_id=?').get(attemptId),attempt=processing.getAttempt(attemptId),task=attempt&&processing.getTask(attempt.taskId),provider=attempt&&processing.getProvider(attempt.providerId),project=task&&processing.getProject(task.projectId);
    if(!row||row.phase!=='intent'||row.receipt!==null||row.environment!==expectedEnvironment||row.authority!==transport.identity||!attempt||attempt.id!==attemptId||attempt.providerId!==row.provider_id||attempt.providerTaskId!==row.task_uuid||!['pending','admitted','initializing','uploading'].includes(attempt.status)||!task||task.activeAttemptId!==attemptId||task.status==='archived'||!project||project.status!=='active'||!provider||!provider.enabled)throw hold();
    const endpoint=new URL(provider.endpoint);if(endpoint.protocol!=='http:'||endpoint.origin!==row.authority||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw hold();
    const manifest=validate(Buffer.from(row.manifest),attemptId),identity={attemptId,taskId:task.id,projectId:project.id,providerId:row.provider_id,taskUuid:row.task_uuid,environment:row.environment,authority:row.authority,manifest:Buffer.from(row.manifest).toString('base64'),keyId:row.key_id,credentialCiphertext:row.capability_ciphertext};
    const identitySha256=crypto.createHash('sha256').update('native-epoch-context-v2\0').update(JSON.stringify(identity)).digest('hex');
    return{row,manifest,identitySha256};
  }catch{throw hold();}
}
module.exports={capture};
