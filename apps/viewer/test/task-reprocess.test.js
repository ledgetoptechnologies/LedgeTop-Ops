'use strict';
// Reprocess: a new run of a finished task on the same photos; a running task still refuses one.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'task-reprocess-')),db=openDatabase(path.join(root,'test.sqlite')),processing=new ProcessingRepository(db);
  t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Synthetic project'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic photos',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
  processing.finalizeDataset(dataset.id,[{relativePath:'a.jpg',byteSize:5,sha256:crypto.createHash('sha256').update('photo').digest('hex')}],'c'.repeat(64));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic node',endpoint:'http://127.0.0.1:3000',enabled:true});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic task'});
  const first=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{dsm:true}});
  return{processing,dataset,provider,task,first};
}

for(const status of ['published','failed','cancelled']){
  test(`a ${status} run can be reprocessed with new options on the same photos`,t=>{
    const f=fixture(t);f.processing.transitionAttempt(f.first.id,status);
    const next=f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{dsm:false}});
    assert.equal(next.attemptNumber,2);assert.equal(next.datasetId,f.dataset.id);assert.deepEqual(next.options,{dsm:false});
    assert.equal(f.processing.getTask(f.task.id).activeAttemptId,next.id);
    assert.equal(f.processing.getAttempt(f.first.id).status,status,'the earlier run is kept as it was');
  });
}

for(const status of ['running','ready_for_review']){
  test(`a ${status} run refuses a second run (a run awaiting review must stay publishable)`,t=>{
    const f=fixture(t);f.processing.transitionAttempt(f.first.id,status);
    assert.throws(()=>f.processing.createAttempt({taskId:f.task.id,providerId:f.provider.id,options:{}}),{code:'attempt_in_progress'});
  });
}
