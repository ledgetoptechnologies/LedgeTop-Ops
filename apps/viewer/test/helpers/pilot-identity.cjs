'use strict';
const fs=require('node:fs');
function readPilotIdentity({file,ownerId,processing}){
 const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);let identity;
 try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size<1||stat.size>4096)throw Error('fixture identity invalid');identity=JSON.parse(fs.readFileSync(fd,'utf8'));}finally{fs.closeSync(fd);}
 if(identity.schemaVersion!==1||identity.ownerId!==ownerId||identity.photoCount!==40||typeof identity.manifestSha256!=='string'||!/^[a-f0-9]{64}$/.test(identity.manifestSha256)||['projectId','datasetId','taskId','attemptId','providerId','providerTaskId'].some(k=>typeof identity[k]!=='string'||!identity[k]))throw Error('fixture identity invalid');
 const attempt=processing.getAttempt(identity.attemptId),task=processing.getTask(identity.taskId),dataset=processing.getDataset(identity.datasetId);
 if(!attempt||attempt.taskId!==identity.taskId||attempt.datasetId!==identity.datasetId||attempt.providerId!==identity.providerId||attempt.providerTaskId!==identity.providerTaskId||!task||task.projectId!==identity.projectId||task.activeAttemptId!==identity.attemptId||!dataset||dataset.projectId!==identity.projectId||dataset.manifestSha256!==identity.manifestSha256||dataset.fileCount!==identity.photoCount)throw Error('fixture database identity changed');
 return identity;
}
module.exports={readPilotIdentity};
