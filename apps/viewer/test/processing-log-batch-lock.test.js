'use strict';
const assert=require('node:assert/strict');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

// The Viewer API and the processing worker share one SQLite file with a 5 s busy timeout. A reconcile
// that summed the attempt's whole log once per new output line held the write lock for seconds on large
// runs, so API writes (opening a model, the Ops overview) failed with 500 until the next try.
test('a reconcile output batch sums the attempt log once, not once per line, and keeps the byte cap',()=>{
  const db=openDatabase(':memory:');
  try{
    const processing=new ProcessingRepository(db,{logMaxBytes:1000});
    const project=processing.createProject({displayName:'Log batch'});
    const data=processing.createDataset({projectId:project.id,displayName:'Photos',storageMode:'managed',rootKey:'datasets',relativePath:'log-batch'});
    processing.finalizeDataset(data.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const task=processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Large run'});
    const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
    const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
    db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
    db.prepare("UPDATE processing_attempts SET status='running' WHERE id=?").run(attempt.id);
    processing.enqueueJob(attempt.id,'reconcile');
    db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile'").run(attempt.id);
    const job=processing.claimJob('log-batch-owner');
    const prepare=db.prepare.bind(db);let sums=0;
    db.prepare=sql=>{if(/SUM\(byte_size\)/.test(sql))sums++;return prepare(sql);};
    const lines=Array.from({length:200},(_,index)=>`line ${String(index).padStart(3,'0')} ${'x'.repeat(10)}`);
    assert.equal(processing.persistReconcileObservation(job.id,job.lease_owner,attempt.id,{lines,nextLine:200}),true);
    assert.equal(sums,1,'one log size read per batch');
    db.prepare=prepare;
    const stored=processing.listLogs(attempt.id,2000);
    const total=stored.reduce((sum,row)=>sum+Buffer.byteLength(row.message),0);
    assert.equal(total,1000,'the cap is filled exactly, the last line clipped');
    assert.equal(stored[0].message,lines[0]);
    assert.equal(stored.length,Math.ceil(1000/Buffer.byteLength(lines[0])));
    assert.equal(processing.getAttempt(attempt.id).providerOutputCursor,200);
  }finally{db.close();}
});
