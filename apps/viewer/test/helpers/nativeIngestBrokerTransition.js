'use strict';
// Synthetic broker-owned transition only. No production authorization semantics.
const {DatabaseSync}=require('node:sqlite'),{ProcessingRepository}=require('../../server/processingRepository'),marker=require('../../server/nativeIngestCommitCandidate');
if(process.env.VIEWER_BROKER_FIXTURE_PAUSE==='1')Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);
const [file,attemptId,jobId]=process.argv.slice(2),db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=5000');
try{
  const job=db.prepare("SELECT attempt_id,status,job_type,lease_owner FROM processing_jobs WHERE id=?").get(jobId);
  if(!job||job.attempt_id!==attemptId||job.job_type!=='ingest')throw new Error('hold');
  let value;
  if(job.status==='complete'){const attempt=db.prepare('SELECT status FROM processing_attempts WHERE id=?').get(attemptId);if(attempt?.status!=='ready_for_review')throw new Error('hold');value=marker.read(db,attemptId,true);}
  else{if(job.status!=='leased'||job.lease_owner!=='broker-fixture-owner')throw new Error('hold');const processing=Object.create(ProcessingRepository.prototype);processing.database=db;processing.logMaxBytes=10485760;if(!processing.completeOutputForReview(attemptId,{jobId,owner:'broker-fixture-owner',event:{eventId:`broker-fixture-${attemptId}`}}))throw new Error('hold');value=marker.read(db,attemptId,true);}
  process.stdout.write(JSON.stringify({commitId:value.commit_id}));
}catch{process.exitCode=1;}finally{db.close();}
