'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {inputInventory,submissionProvenance}=require('./processingProvenance');
const {hashDescriptor}=require('./importSourceSnapshot');
const {physicalStorageRootKey}=require('./storageManager');

const MAX_INGEST_RECOVERIES=3;
const ACTION='processing_attempt.ingest_recovery_requested';
function reject(code='ingest_recovery_not_eligible'){throw Object.assign(new Error(code),{code});}
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function providerSecurityFingerprint(processing,provider){
  const {lastHealth,lastProbeCredentialRevision,...credential}=processing.getProviderCredential(provider.id)||{};
  return digest({endpoint:provider.endpoint,type:provider.type,enabled:provider.enabled,credential});
}

// This is admission to an existing-result ingest, never permission to submit ODM work.
function inspectIngestRecovery(processing,id){
  const db=processing.database,attempt=processing.getAttempt(id);
  if(!attempt)reject('attempt_not_found');
  const task=processing.getTask(attempt.taskId),dataset=processing.getDataset(attempt.datasetId,true);
  const project=task&&processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId);
  if(attempt.status!=='failed'||!task||task.status!=='failed'||task.activeAttemptId!==id||
    !project||project.status!=='active'||!dataset||dataset.status!=='finalized'||dataset.projectId!==task.projectId||
    !provider?.enabled||!attempt.providerTaskId||attempt.resultModelId||attempt.resultModelVersionId)reject();
  const jobs=db.prepare('SELECT * FROM processing_jobs WHERE attempt_id=? ORDER BY updated_at DESC,created_at DESC,id DESC').all(id);
  const failed=jobs.find(job=>job.status==='failed'&&job.job_type==='ingest');
  if(!failed||jobs.some(job=>job.updated_at>failed.updated_at||!['complete','failed','cancelled'].includes(job.status))||
    db.prepare('SELECT 1 FROM derivative_jobs WHERE attempt_id=? LIMIT 1').get(id)||
    db.prepare('SELECT 1 FROM model_outputs WHERE attempt_id=? LIMIT 1').get(id))reject();
  const count=Number(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action=? AND entity_type='processing_attempt' AND entity_id=?").get(ACTION,id).n);
  if(count>=MAX_INGEST_RECOVERIES)reject('ingest_recovery_limit_reached');
  const provenance=processing.getAttemptProvenance(id),submission=provenance?.submission,result=provenance?.providerResult;
  if(!submission?.inputFiles||!submission.sourceFilesSha256||!submission.inputManifestSha256||
    submission.attemptId!==id||submission.datasetId!==dataset.id||submission.providerId!==provider.id||
    submission.providerTaskId!==attempt.providerTaskId||result?.providerTaskId!==attempt.providerTaskId||result.status!=='completed')reject('ingest_recovery_provenance_unavailable');
  if(dataset.files.length>100000)reject('ingest_recovery_source_limit');
  if(processing.activeDatasetOperations(dataset.id))reject();
  const current=inputInventory(dataset.files,processing.getAttemptGcpSnapshot(id));
  const currentSubmission=submissionProvenance(attempt,provider,submission.capturedAt,{dataset,gcpSnapshot:processing.getAttemptGcpSnapshot(id)});
  if(submission.datasetManifestSha256!==dataset.manifestSha256||submission.sourceFilesSha256!==current.sourceFilesSha256||
    submission.inputManifestSha256!==current.inputManifestSha256||JSON.stringify(submission.inputFiles)!==JSON.stringify(current.inputFiles)||
    submission.submittedOptionsSha256!==currentSubmission.submittedOptionsSha256)reject('ingest_recovery_source_changed');
  const photoCount=current.inputFiles.filter(file=>/\.(?:jpe?g|png|tiff?|dng|raw|heic)$/i.test(file.relativePath)).length;
  if(!photoCount||result.imagesCount!==photoCount)reject('ingest_recovery_provenance_unavailable');
  const transfer=processing.getAttemptTransferProvenance(id);
  const security=providerSecurityFingerprint(processing,provider);
  const fingerprint=digest({attempt,task,dataset,submission,result,transfer,security,failedJob:failed,count});
  return{attempt,task,dataset,provider,failedJob:failed,provenance,transfer,photoCount,fingerprint,count,providerSecurityFingerprint:security};
}

function validateIngestRecoveryStorage(context,storage){
  try{
    const root=storage.resolve(context.dataset.rootKey,context.dataset.relativePath,{mustExist:true});
    if(!fs.statSync(root).isDirectory())reject();
    for(const file of context.dataset.files){
      const absolute=storage.resolve(context.dataset.rootKey,path.posix.join(context.dataset.relativePath,file.relativePath),{mustExist:true});
      const stat=fs.statSync(absolute);
      if(!stat.isFile()||stat.size!==file.byteSize)reject();
    }
    const destination=storage.resolve('models',`${context.task.id}/${context.attempt.id}`);
    // Do not turn a historical or unreceipted directory into trusted output.
    if(fs.existsSync(destination)&&!context.transfer?.archive)reject();
  }catch{reject('ingest_recovery_source_unavailable');}
}

function ingestRecoveryCandidate(processing,id,storage){
  const used=Number(processing.database.prepare("SELECT COUNT(*) n FROM audit_events WHERE action=? AND entity_type='processing_attempt' AND entity_id=?").get(ACTION,id).n);
  const candidate={kind:'ingest',available:false,remainingRequests:Math.max(0,MAX_INGEST_RECOVERIES-used)};
  try{const context=inspectIngestRecovery(processing,id);validateIngestRecoveryStorage(context,storage);candidate.available=true;}catch{}
  return candidate;
}
async function verifyRecoveredIngestSources(processing,storage,job,signal){
  const recovery=processing.database.prepare("SELECT details_json FROM audit_events WHERE action=? AND entity_type='processing_attempt' AND entity_id=? AND json_extract(details_json,'$.jobId')=?").get(ACTION,job.attempt_id,job.id);
  if(!recovery)return;
  const attempt=processing.getAttempt(job.attempt_id),dataset=processing.getDataset(attempt.datasetId,true),snapshot=processing.getAttemptProvenance(attempt.id)?.submission;
  const task=processing.getTask(attempt.taskId),project=task&&processing.getProject(task.projectId),provider=processing.getProvider(attempt.providerId);
  if(!provider?.enabled||!task||task.activeAttemptId!==attempt.id||!project||project.status!=='active'||attempt.status!=='ingesting'||JSON.parse(recovery.details_json).providerSecurityFingerprint!==providerSecurityFingerprint(processing,provider))reject('ingest_recovery_state_changed');
  if(!dataset||dataset.status!=='finalized'||!snapshot?.inputFiles||snapshot.datasetManifestSha256!==dataset.manifestSha256||snapshot.sourceFilesSha256!==inputInventory(dataset.files,processing.getAttemptGcpSnapshot(attempt.id)).sourceFilesSha256)reject('ingest_recovery_source_changed');
  for(const file of dataset.files){
    if(signal?.aborted||!processing.provenanceJob(job.id,job.lease_owner,'ingest'))reject('lease_lost');
    const relative=path.posix.join(dataset.relativePath,file.relativePath);
    let directory=null,fd=null;
    try{
      storage.resolve(dataset.rootKey,relative,{mustExist:true});
      directory=fs.openSync(fs.realpathSync.native(storage.roots[physicalStorageRootKey(dataset.rootKey)]),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
      const components=relative.split('/'),name=components.pop();
      for(const part of components){const next=fs.openSync(`/proc/self/fd/${directory}/${part}`,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);fs.closeSync(directory);directory=next;}
      fd=fs.openSync(`/proc/self/fd/${directory}/${name}`,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_CLOEXEC);
      const stat=fs.fstatSync(fd,{bigint:true});
      if(!stat.isFile()||stat.size!==BigInt(file.byteSize)||await hashDescriptor(fd,stat,{signal})!==file.sha256)reject('ingest_recovery_source_changed');
    }catch(error){if(error.code==='lease_lost')throw error;reject('ingest_recovery_source_changed');}
    finally{if(fd!==null)fs.closeSync(fd);if(directory!==null)fs.closeSync(directory);}
  }
  if(signal?.aborted||!processing.provenanceJob(job.id,job.lease_owner,'ingest'))reject('lease_lost');
  const freshTask=processing.getTask(task.id),freshDataset=processing.getDataset(dataset.id),freshProvider=processing.getProvider(provider.id);
  if(!freshTask||freshTask.activeAttemptId!==attempt.id||processing.getProject(project.id)?.status!=='active'||freshDataset?.status!=='finalized'||freshDataset.manifestSha256!==dataset.manifestSha256||!freshProvider||providerSecurityFingerprint(processing,freshProvider)!==JSON.parse(recovery.details_json).providerSecurityFingerprint)reject('ingest_recovery_state_changed');
  return true;
}
module.exports={MAX_INGEST_RECOVERIES,ACTION,inspectIngestRecovery,validateIngestRecoveryStorage,ingestRecoveryCandidate,verifyRecoveredIngestSources};
