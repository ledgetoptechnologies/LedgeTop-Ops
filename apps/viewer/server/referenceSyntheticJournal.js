'use strict';
// Test-only schema design, not an application migration or custody record.
// Callers must explicitly create this in an isolated synthetic database. No
// runtime caller, physical-retention guarantee, or production issuer exists.
const crypto=require('node:crypto');
const {decodeOptionsWire}=require('./referenceOptions');
const TEST_SCHEMA=`
CREATE TABLE synthetic_reference_intents (
 attempt_id TEXT PRIMARY KEY NOT NULL, submission_id TEXT NOT NULL UNIQUE, environment TEXT NOT NULL CHECK(environment='staging'),
 body TEXT NOT NULL, body_sha256 TEXT NOT NULL, manifest_sha256 TEXT NOT NULL,
 lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_generation)='integer' AND lease_generation>=0 AND lease_generation<=9007199254740991), lease_owner TEXT, lease_expires_ms INTEGER CHECK(lease_expires_ms IS NULL OR (typeof(lease_expires_ms)='integer' AND lease_expires_ms>=0 AND lease_expires_ms<=9007199254740991)),
 job_id TEXT UNIQUE, job_json TEXT, job_sha256 TEXT, CHECK((lease_owner IS NULL)=(lease_expires_ms IS NULL)), CHECK((job_json IS NULL)=(job_sha256 IS NULL)), CHECK((job_id IS NULL)=(job_json IS NULL))
);
CREATE TRIGGER synthetic_reference_identity_immutable BEFORE UPDATE ON synthetic_reference_intents
 WHEN NEW.lease_generation<OLD.lease_generation OR NEW.attempt_id<>OLD.attempt_id OR NEW.submission_id<>OLD.submission_id OR NEW.environment<>OLD.environment OR NEW.body<>OLD.body OR NEW.body_sha256<>OLD.body_sha256 OR NEW.manifest_sha256<>OLD.manifest_sha256 OR (OLD.job_json IS NOT NULL AND (NEW.job_id IS NOT OLD.job_id OR NEW.job_json IS NOT OLD.job_json OR NEW.job_sha256 IS NOT OLD.job_sha256))
 BEGIN SELECT RAISE(ABORT,'synthetic reference intent immutable'); END;
CREATE TRIGGER synthetic_reference_job_no_replace BEFORE UPDATE OF job_id ON synthetic_reference_intents WHEN NEW.job_id IS NOT NULL AND EXISTS(SELECT 1 FROM synthetic_reference_intents WHERE job_id=NEW.job_id AND attempt_id<>OLD.attempt_id) BEGIN SELECT RAISE(ABORT,'synthetic reference job replacement'); END;
CREATE TRIGGER synthetic_reference_no_replace BEFORE INSERT ON synthetic_reference_intents WHEN EXISTS(SELECT 1 FROM synthetic_reference_intents WHERE attempt_id=NEW.attempt_id OR submission_id=NEW.submission_id OR (NEW.job_id IS NOT NULL AND job_id=NEW.job_id)) BEGIN SELECT RAISE(ABORT,'synthetic reference intent replacement'); END;
CREATE TRIGGER synthetic_reference_no_delete BEFORE DELETE ON synthetic_reference_intents BEGIN SELECT RAISE(ABORT,'synthetic reference intent retention'); END;`;
const digest=s=>crypto.createHash('sha256').update(s).digest('hex');
const bad=code=>Object.assign(new Error(code),{code});
const ident=x=>typeof x==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(x);
const hash=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
class SyntheticReferenceJournal {
 constructor(db,{now=Date.now}={}){this.db=db;this.now=now}
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v}catch(e){try{this.db.exec('ROLLBACK')}catch{}throw e}}
 get(id){const row=this.db.prepare('SELECT * FROM synthetic_reference_intents WHERE attempt_id=?').get(id);return row?{...row}:null}
 freeze({attemptId,environment,body,bodySha256}){
  if(!ident(attemptId)||environment!=='staging'||typeof body!=='string'||Buffer.from(body,'utf8').toString('utf8')!==body||Buffer.byteLength(body)>4*1024*1024||!hash(bodySha256)||digest(body)!==bodySha256)throw bad('synthetic_journal_invalid');
  let request;try{request=decodeOptionsWire(Buffer.from(body,'utf8'))}catch{throw bad('synthetic_journal_invalid')}
  if(!request||typeof request.submissionId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.submissionId)||!request.manifest||!hash(request.manifest.sha256))throw bad('synthetic_journal_invalid');
  return this.tx(()=>{const old=this.get(attemptId);if(old){if(old.submission_id!==request.submissionId||old.environment!==environment||old.body!==body||old.body_sha256!==bodySha256||old.manifest_sha256!==request.manifest.sha256)throw bad('synthetic_journal_conflict');return old}this.db.prepare('INSERT INTO synthetic_reference_intents(attempt_id,submission_id,environment,body,body_sha256,manifest_sha256) VALUES(?,?,?,?,?,?)').run(attemptId,request.submissionId,environment,body,bodySha256,request.manifest.sha256);return this.get(attemptId)})
 }
 claim(attemptId,owner,leaseMs){const now=this.now();if(!ident(attemptId)||!ident(owner)||!Number.isSafeInteger(now)||now<0||!Number.isSafeInteger(leaseMs)||leaseMs<1||!Number.isSafeInteger(now+leaseMs))throw bad('synthetic_journal_invalid');return this.tx(()=>{const row=this.get(attemptId);if(!row||row.job_json!==null||(row.lease_owner&&row.lease_expires_ms>now))return null;if(row.lease_generation>=Number.MAX_SAFE_INTEGER)throw bad('synthetic_journal_invalid');const result=this.db.prepare('UPDATE synthetic_reference_intents SET lease_owner=?,lease_expires_ms=?,lease_generation=lease_generation+1 WHERE attempt_id=? AND lease_generation=?').run(owner,now+leaseMs,attemptId,row.lease_generation);if(result.changes!==1)return null;return{attemptId,owner,generation:row.lease_generation+1,expiresAtMs:now+leaseMs}})}
 bindJob(claim,job){const now=this.now();if(!claim||!ident(claim.attemptId)||!ident(claim.owner)||!Number.isSafeInteger(claim.generation)||!Number.isSafeInteger(now)||now<0)throw bad('synthetic_journal_invalid');return this.tx(()=>{const row=this.get(claim.attemptId);if(!row)throw bad('synthetic_journal_conflict');const bytes=JSON.stringify(job),sha=digest(bytes);if(row.job_json!==null){if(row.job_id===job.jobId&&row.job_json===bytes&&row.job_sha256===sha)return row;throw bad('synthetic_journal_conflict')}if(row.lease_owner!==claim.owner||row.lease_generation!==claim.generation||row.lease_expires_ms<=now)throw bad('synthetic_journal_lease_lost');if(!job||!ident(job.jobId)||job.environment!==row.environment||job.manifestSha256!==row.manifest_sha256||!Number.isSafeInteger(job.generation)||job.generation<1||!hash(job.pipelineDigest))throw bad('synthetic_journal_invalid');const r=this.db.prepare('UPDATE synthetic_reference_intents SET job_id=?,job_json=?,job_sha256=?,lease_owner=NULL,lease_expires_ms=NULL WHERE attempt_id=? AND lease_owner=? AND lease_generation=? AND lease_expires_ms>? AND job_json IS NULL').run(job.jobId,bytes,sha,claim.attemptId,claim.owner,claim.generation,now);if(r.changes!==1)throw bad('synthetic_journal_lease_lost');return this.get(claim.attemptId)})}
}
module.exports={TEST_SCHEMA,SyntheticReferenceJournal};
