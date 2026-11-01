'use strict';
// Inactive local candidate only. Not an authenticated broker or production migration.
const crypto=require('node:crypto');
const {ProcessingRepository}=require('./processingRepository');
const marker=require('./nativeIngestCommitCandidate');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keys=(o,names)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...names].sort().join('|');
const text=(s,max)=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=max;
const canonical=o=>JSON.stringify(Object.fromEntries(Object.keys(o).sort().map(k=>[k,o[k]&&typeof o[k]==='object'?JSON.parse(canonical(o[k])):o[k]])));
function install(db,optIn){
  if(optIn!==true)throw new Error('explicit candidate opt-in required');
  db.exec(`CREATE TABLE IF NOT EXISTS native_readiness_receipt_candidate(request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, commit_id TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS native_readiness_receipt_candidate_no_update BEFORE UPDATE ON native_readiness_receipt_candidate BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;
    CREATE TRIGGER IF NOT EXISTS native_readiness_receipt_candidate_no_delete BEFORE DELETE ON native_readiness_receipt_candidate BEGIN SELECT RAISE(ABORT,'immutable receipt'); END;`);
}
function complete(db,request,{authorize}={}){
  const eventKeys=['eventId','schemaVersion','type','projectId','projectDisplayName','taskId','taskDisplayName','attemptId','requestedBySubject','status','reviewUrl'];
  if(!keys(request,['requestId','attemptId','jobId','owner','ingestedAt','event'])||!uuid.test(request.requestId)||!uuid.test(request.attemptId)||!uuid.test(request.jobId)||!text(request.owner,256)||!text(request.ingestedAt,64)||!Number.isFinite(Date.parse(request.ingestedAt))||!keys(request.event,eventKeys))throw new Error('readiness hold');
  const e=request.event;
  if(e.eventId!==`processing-ready-${request.attemptId}`||e.schemaVersion!==1||e.type!=='processing.ready_for_review'||e.attemptId!==request.attemptId||e.status!=='ready_for_review'||!uuid.test(e.projectId)||!uuid.test(e.taskId)||!text(e.projectDisplayName,512)||!text(e.taskDisplayName,512)||!(e.requestedBySubject===null||text(e.requestedBySubject,512))||!text(e.reviewUrl,2048)||Buffer.byteLength(JSON.stringify(request))>8192)throw new Error('readiness hold');
  // The caller must supply a real, current authorization decision. This test
  // seam does not authenticate peer credentials or establish tenant access.
  if(typeof authorize!=='function'||authorize(request)!==true)throw new Error('readiness hold');
  const digest=crypto.createHash('sha256').update(canonical(request)).digest('hex');
  db.exec('BEGIN IMMEDIATE');
  try{
    const old=db.prepare('SELECT * FROM native_readiness_receipt_candidate WHERE request_id=? OR attempt_id=?').all(request.requestId,request.attemptId);
    if(old.length){if(old.length!==1||old[0].request_id!==request.requestId||old[0].request_digest!==digest||old[0].job_id!==request.jobId||marker.read(db,request.attemptId,true).commit_id!==old[0].commit_id)throw new Error('readiness hold');db.exec('COMMIT');return{attemptId:request.attemptId,commitId:old[0].commit_id};}
    const attempt=db.prepare('SELECT a.task_id,t.project_id,a.created_by FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id WHERE a.id=?').get(request.attemptId);
    const job=db.prepare('SELECT attempt_id,job_type FROM processing_jobs WHERE id=?').get(request.jobId);
    if(!attempt||attempt.task_id!==e.taskId||attempt.project_id!==e.projectId||attempt.created_by!==e.requestedBySubject||!job||job.attempt_id!==request.attemptId||job.job_type!=='ingest')throw new Error('readiness hold');
    // Invoke the existing method in this transaction, without altering its
    // production implementation or opening a nested SQLite transaction.
    const p=Object.create(ProcessingRepository.prototype);p.database=db;p.logMaxBytes=10485760;p.transaction=fn=>fn();
    if(!p.completeOutputForReview(request.attemptId,{jobId:request.jobId,owner:request.owner,ingestedAt:request.ingestedAt,event:e}))throw new Error('readiness hold');
    const commit=marker.read(db,request.attemptId,true);
    db.prepare('INSERT INTO native_readiness_receipt_candidate VALUES(?,?,?,?,?)').run(request.requestId,digest,request.attemptId,request.jobId,commit.commit_id);
    db.exec('COMMIT');return{attemptId:request.attemptId,commitId:commit.commit_id};
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
module.exports={install,complete};
