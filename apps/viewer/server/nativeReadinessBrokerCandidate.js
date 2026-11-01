'use strict';
// Inactive local candidate only. Not an authenticated broker or production migration.
const {digest}=require('./nativeReadinessRequestDigestCandidate');
const {ProcessingRepository}=require('./processingRepository');
const marker=require('./nativeIngestCommitCandidate');
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const keys=(o,names)=>o&&Object.getPrototypeOf(o)===Object.prototype&&Object.keys(o).sort().join('|')===[...names].sort().join('|');
const text=(s,max)=>typeof s==='string'&&s.length>0&&Buffer.byteLength(s)<=max;
const table='native_readiness_receipt_candidate';
const ddl='CREATE TABLE native_readiness_receipt_candidate(request_id TEXT PRIMARY KEY, request_digest TEXT NOT NULL, attempt_id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL, commit_id TEXT NOT NULL)';
const triggers=[['native_readiness_receipt_candidate_no_update',"CREATE TRIGGER native_readiness_receipt_candidate_no_update BEFORE UPDATE ON native_readiness_receipt_candidate BEGIN SELECT RAISE(ABORT,'immutable receipt'); END"],['native_readiness_receipt_candidate_no_delete',"CREATE TRIGGER native_readiness_receipt_candidate_no_delete BEFORE DELETE ON native_readiness_receipt_candidate BEGIN SELECT RAISE(ABORT,'immutable receipt'); END"]];
function attest(db){
  const objects=db.prepare("SELECT type,name,sql FROM sqlite_master WHERE tbl_name=? AND type IN ('table','index','trigger') ORDER BY type,name").all(table);
  const expected=[['table',table,ddl],['index',`sqlite_autoindex_${table}_1`,null],['index',`sqlite_autoindex_${table}_2`,null],...triggers.map(([name,sql])=>['trigger',name,sql])].sort((a,b)=>a[0].localeCompare(b[0])||a[1].localeCompare(b[1]));
  if(JSON.stringify(objects.map(x=>[x.type,x.name,x.sql]))!==JSON.stringify(expected))throw new Error('readiness hold');
}
function install(db,optIn){
  if(optIn!==true||db.isTransaction)throw new Error('readiness hold');
  db.exec('BEGIN IMMEDIATE');try{const any=db.prepare("SELECT 1 FROM sqlite_master WHERE name IN (?,?,?) OR tbl_name=? LIMIT 1").get(table,...triggers.map(x=>x[0]),table);if(any)attest(db);else{db.exec(ddl);for(const [,sql] of triggers)db.exec(sql);attest(db);}db.exec('COMMIT');}catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
function complete(db,request,{authorize,reviewBaseUrl}={}){
  const eventKeys=['eventId','schemaVersion','type','projectId','projectDisplayName','taskId','taskDisplayName','attemptId','requestedBySubject','status','reviewUrl'];
  if(!keys(request,['requestId','attemptId','jobId','owner','ingestedAt','event'])||!uuid.test(request.requestId)||!uuid.test(request.attemptId)||!uuid.test(request.jobId)||!text(request.owner,256)||!text(request.ingestedAt,64)||!Number.isFinite(Date.parse(request.ingestedAt))||!keys(request.event,eventKeys))throw new Error('readiness hold');
  const e=request.event;
  if(e.eventId!==`processing-ready-${request.attemptId}`||e.schemaVersion!==1||e.type!=='processing.ready_for_review'||e.attemptId!==request.attemptId||e.status!=='ready_for_review'||!uuid.test(e.projectId)||!uuid.test(e.taskId)||!text(e.projectDisplayName,512)||!text(e.taskDisplayName,512)||!(e.requestedBySubject===null||text(e.requestedBySubject,512))||!text(reviewBaseUrl,1024)||e.reviewUrl!==`${reviewBaseUrl}/operations/processing?attemptId=${encodeURIComponent(request.attemptId)}`||Buffer.byteLength(JSON.stringify(request))>8192)throw new Error('readiness hold');
  // The caller must supply a real, current authorization decision. This test
  // seam does not authenticate peer credentials or establish tenant access.
  if(typeof authorize!=='function'||authorize(request)!==true)throw new Error('readiness hold');
  const requestDigest=digest(request);
  db.exec('BEGIN IMMEDIATE');
  try{
    attest(db);
    const old=db.prepare('SELECT * FROM native_readiness_receipt_candidate WHERE request_id=? OR attempt_id=?').all(request.requestId,request.attemptId);
    if(old.length){if(old.length!==1||old[0].request_id!==request.requestId||old[0].request_digest!==requestDigest||old[0].job_id!==request.jobId||marker.read(db,request.attemptId,true).commit_id!==old[0].commit_id)throw new Error('readiness hold');db.exec('COMMIT');return{attemptId:request.attemptId,commitId:old[0].commit_id};}
    const attempt=db.prepare('SELECT a.task_id,t.project_id,a.created_by,t.display_name task_name,p.display_name project_name FROM processing_attempts a JOIN processing_tasks t ON t.id=a.task_id JOIN projects p ON p.id=t.project_id WHERE a.id=?').get(request.attemptId);
    const job=db.prepare('SELECT attempt_id,job_type FROM processing_jobs WHERE id=?').get(request.jobId);
    if(!attempt||attempt.task_id!==e.taskId||attempt.project_id!==e.projectId||attempt.created_by!==e.requestedBySubject||attempt.task_name!==e.taskDisplayName||attempt.project_name!==e.projectDisplayName||!job||job.attempt_id!==request.attemptId||job.job_type!=='ingest')throw new Error('readiness hold');
    // Invoke the existing method in this transaction, without altering its
    // production implementation or opening a nested SQLite transaction.
    const p=Object.create(ProcessingRepository.prototype);p.database=db;p.logMaxBytes=10485760;p.transaction=fn=>fn();
    if(!p.completeOutputForReview(request.attemptId,{jobId:request.jobId,owner:request.owner,ingestedAt:request.ingestedAt,event:e}))throw new Error('readiness hold');
    const commit=marker.read(db,request.attemptId,true);
    db.prepare('INSERT INTO native_readiness_receipt_candidate VALUES(?,?,?,?,?)').run(request.requestId,requestDigest,request.attemptId,request.jobId,commit.commit_id);
    db.exec('COMMIT');return{attemptId:request.attemptId,commitId:commit.commit_id};
  }catch(error){if(db.isTransaction)db.exec('ROLLBACK');throw error;}
}
module.exports={install,complete};
