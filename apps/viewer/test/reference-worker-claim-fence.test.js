'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database'),{ProcessingRepository}=require('../server/processingRepository');
test('legacy worker skips reference journal and protocol jobs without starving ordinary jobs',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
  db.exec(`INSERT INTO projects(id,display_name,status,created_at,updated_at) VALUES('p','P','active','t','t');
    INSERT INTO datasets(id,project_id,display_name,storage_mode,root_key,relative_path,status,created_at,updated_at) VALUES('d','p','D','managed','datasets','d','finalized','t','t');
    INSERT INTO processing_tasks(id,project_id,dataset_id,display_name,status,created_at,updated_at) VALUES('t','p','d','T','draft','t','t');
    INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,options_json,status,created_at,updated_at) VALUES('journal','t','d',1,'{}','pending','t','t'),('protocol','t','d',2,'{}','pending','t','t'),('normal','t','d',3,'{}','pending','t','t');
    UPDATE reference_catalog_projection_state SET scan_complete=1;
    DROP TRIGGER viewer_reference_attempt_admission_unavailable;
    INSERT INTO viewer_reference_attempt_journal(attempt_id,submission_id,environment,request_json,request_sha256,input_manifest_sha256) VALUES('journal','s','staging','{}','h','m');
    PRAGMA foreign_keys=OFF; DROP TRIGGER viewer_reference_provider_unavailable; DROP TRIGGER viewer_reference_protocol_unavailable; DROP TRIGGER viewer_reference_genesis_unavailable; DROP TRIGGER viewer_reference_genesis_no_existing;
    INSERT INTO viewer_reference_providers VALUES('r','Ref','https://example.invalid',0);
    INSERT INTO viewer_reference_attempt_genesis VALUES('protocol','r'); INSERT INTO viewer_reference_attempt_protocols VALUES('protocol','r','reference-v1'); PRAGMA foreign_keys=ON;
    INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('j1','journal','reconcile','pending','2000','2000','t'),('j2','protocol','ingest','leased','2000','2001','t'),('j3','normal','reconcile','pending','2000','2002','t');
    UPDATE processing_jobs SET lease_owner='old',lease_expires_at='2000',attempt_count=2 WHERE id='j2';`);
  const repo=new ProcessingRepository(db);assert.equal(repo.claimJob('legacy').id,'j3');
  assert.deepEqual(db.prepare("SELECT id,status,attempt_count,lease_owner FROM processing_jobs WHERE id IN ('j1','j2') ORDER BY id").all().map(x=>({...x})),[
    {id:'j1',status:'pending',attempt_count:0,lease_owner:null},{id:'j2',status:'leased',attempt_count:2,lease_owner:'old'}]);
  assert.equal(repo.claimJob('another'),null);
  db.exec(`UPDATE processing_jobs SET status='complete' WHERE id='j3';
    INSERT INTO processing_providers(id,provider_type,display_name,endpoint,enabled,admission_limit,created_at,updated_at) VALUES('node','nodeodm','ODM','http://127.0.0.1:3000',1,2,'t','t');
    INSERT INTO processing_attempts(id,task_id,dataset_id,attempt_number,provider_id,options_json,status,created_at,updated_at) VALUES('sub','t','d',4,'node','{}','pending','t','t'),('ing','t','d',5,'node','{}','pending','t','t');
    INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,created_at,updated_at) VALUES('j4','sub','submit','pending','2000','2003','t'),('j5','ing','ingest','pending','2000','2004','t');`);
  assert.equal(repo.claimJob('submit-worker').id,'j4');
  assert.equal(repo.claimJob('ingest-worker').id,'j5');
  assert.equal(repo.claimJob('last'),null);
});
