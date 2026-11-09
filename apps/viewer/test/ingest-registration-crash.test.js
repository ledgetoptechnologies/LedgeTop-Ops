'use strict';
const {DatabaseSync}=require('node:sqlite');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {registerIngest}=require('../server/ingestRegistration');

if(process.argv[2]==='child'){
  const [file,attemptId,taskId,projectId,jobId,generation,boundary]=process.argv.slice(3),db=new DatabaseSync(file),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
  const target=boundary==='model'?repository:processing,method={model:'upsertModelVersionInTransaction',link:'setAttemptResultForJobInTransaction',output:'registerModelOutputInTransaction'}[boundary],original=target[method];
  target[method]=function(...args){const result=original.apply(this,args);process.send({boundary});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10000);return result;};
  registerIngest({processing,repository,fence:{jobId,owner:'crash-worker',generation:Number(generation),attemptId},modelInput:{provider:'crash-test',providerModelId:'model',providerVersionId:attemptId,displayName:'Synthetic',assets:[],status:'importing',makeActive:false},outputInput:{taskId,attemptId,projectId,relativePath:'synthetic',byteSize:1,assetCount:0,status:'staged'}});
  db.close();process.exit(2);
}else{
  const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process'),{applyMigrations}=require('../server/database');
  test('a killed registration worker leaves no partial model, link or output',{timeout:15000},async t=>{
    const prefix=path.join(os.tmpdir(),'viewer-registration-crash-'),root=fs.mkdtempSync(prefix),identity=fs.lstatSync(root,{bigint:true}),file=path.join(root,'fixture.sqlite');
    let db=null,ownedChild=null,childClosed=null;
    const bounded=async promise=>{let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('owned child did not close; fixture retained')),3000);})]);}finally{clearTimeout(timer);}};
    t.after(async()=>{if(ownedChild){if(ownedChild.exitCode===null&&ownedChild.signalCode===null&&!ownedChild.kill('SIGKILL'))throw Error('owned child could not be stopped; fixture retained');await bounded(childClosed);ownedChild=null;}if(db)db.close();const current=fs.lstatSync(root,{bigint:true});if(identity.ino!==0n&&current.isDirectory()&&!current.isSymbolicLink()&&current.dev===identity.dev&&current.ino===identity.ino)fs.rmSync(root,{recursive:true,force:true});else throw Error('owned fixture identity changed or unavailable; retained');});
    assert.ok(path.isAbsolute(root)&&root.startsWith(prefix)&&identity.ino!==0n&&identity.isDirectory()&&!identity.isSymbolicLink());
    db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
    const r=new ProcessingRepository(db),project=r.createProject({displayName:'Synthetic'}),dataset=r.createDataset({projectId:project.id,displayName:'Source',storageMode:'managed',rootKey:'datasets',relativePath:'source'});r.finalizeDataset(dataset.id,[{id:'p',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=r.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER}),task=r.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Task'}),attempt=r.createAttempt({taskId:task.id,providerId:provider.id,options:{}});db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);r.transitionAttempt(attempt.id,'ingesting');r.enqueueJob(attempt.id,'ingest');const job=r.claimJob('crash-worker');assert.ok(job);
    for(const boundary of ['model','link','output']){
      ownedChild=fork(__filename,['child',file,attempt.id,task.id,project.id,job.id,String(job.attempt_count),boundary],{stdio:['ignore','ignore','ignore','ipc']});const child=ownedChild;
      childClosed=new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
      childClosed.catch(()=>{});
      let timer;const reached=new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(new Error('registration boundary timed out')),3000);child.once('message',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('child exited before boundary')));});
      try{assert.deepEqual(await reached,{boundary});}finally{clearTimeout(timer);}
      assert.equal(child.kill('SIGKILL'),true);const result=await bounded(childClosed);assert.ok(result.signal||result.code!==0);ownedChild=null;childClosed=null;
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM models WHERE provider='crash-test'").get().n,0);assert.equal(r.getAttempt(attempt.id).resultModelId,null);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_outputs WHERE attempt_id=?').get(attempt.id).n,0);
    }
    const viewer=new ViewerRepository(db),fence={jobId:job.id,owner:'crash-worker',generation:job.attempt_count,attemptId:attempt.id};
    const registered=registerIngest({processing:r,repository:viewer,fence,modelInput:{provider:'crash-test',providerModelId:'model',providerVersionId:attempt.id,displayName:'Synthetic',assets:[],status:'importing',makeActive:false},outputInput:{taskId:task.id,attemptId:attempt.id,projectId:project.id,relativePath:'synthetic',byteSize:1,assetCount:0,status:'staged'}});assert.ok(r.getModelOutput(registered.version.id));
  });
}
