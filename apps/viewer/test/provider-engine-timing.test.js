'use strict';
const assert=require('node:assert/strict');
const {mkdtempSync,rmSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const test=require('node:test');
const express=require('express');
const auth=require('../server/auth');
const {applyMigrations,MIGRATIONS,openDatabase}=require('../server/database');
const {createProcessingApi}=require('../server/processingApi');
const {ProcessingRepository}=require('../server/processingRepository');
const {ViewerRepository}=require('../server/repository');
const {processReconcile}=require('../server/processingWorker');
const {NodeOdmProvider}=require('../server/nodeOdmProvider');

function fixture(t){
  const db=openDatabase(':memory:');
  t.after(()=>db.close());
  return {db,processing:new ProcessingRepository(db),repository:new ViewerRepository(db),storage:{roots:{}}};
}

function dataset(c,project){
  const data=c.processing.createDataset({projectId:project.id,displayName:'Synthetic photos',
    storageMode:'managed',rootKey:'datasets',relativePath:'fixture-photos'});
  c.processing.finalizeDataset(data.id,[{relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  return data;
}
test('node engine milliseconds survive leased reconciliation and reach the same task in both mounted APIs',async t=>{
  const c=fixture(t),project=c.processing.createProject({displayName:'Engine timing'}),data=dataset(c,project);
  const task=c.processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Timed task'});
  const provider=c.processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
  const owner='engine-timing-fixture';
  let attempt, info;
  const adapter=new NodeOdmProvider({endpoint:provider.endpoint,fetchImpl:async url=>Response.json(
    new URL(url).pathname.endsWith('/info')?info:[])});
  const start=()=>{
    attempt=c.processing.createAttempt({taskId:task.id,providerId:provider.id});
    c.db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
    c.db.prepare("UPDATE processing_attempts SET status='queued_upstream',started_at='2025-01-01T00:00:00Z' WHERE id=?").run(attempt.id);
    c.processing.enqueueJob(attempt.id,'reconcile');
    return attempt;
  };
  const sample=(code,processingTime,uuid=attempt.providerTaskId)=>({uuid,status:{code},processingTime,imagesCount:1,progress:40});
  const poll=async(code,ms)=>{
    info=sample(code,ms);
    c.db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").run(attempt.id);
    await processReconcile(c.processing.claimJob(owner),{processing:c.processing,config:{},adapterFactory:()=>adapter});
  };
  const read=()=>c.processing.engineProcessingDurations([attempt.id]).get(attempt.id);

  start();
  for(const unsupported of [sample(10,12),sample(20,-1),sample(20,'700'),sample(20,4.5),sample(20,null)]){
    info=unsupported;
    assert.equal(Object.hasOwn(await adapter.status(attempt.providerTaskId),'processingTime'),false);
  }
  info=sample(20,23,'different-provider-id');
  await assert.rejects(adapter.status(attempt.providerTaskId),/incompatible task response/);
  await poll(10,50);
  assert.equal(read(),undefined);
  await poll(20,12_345);
  assert.equal(read(),12_345);
  await poll(10,800);
  assert.equal(read(),undefined);
  await poll(20,0);
  assert.equal(read(),0);
  await poll(20,300);
  assert.equal(read(),300);
  await poll(40,1_640);
  assert.equal(c.processing.getAttempt(attempt.id).status,'ingesting');
  assert.equal(read(),1_640);
  c.processing.transitionAttempt(attempt.id,'derivatives');
  assert.equal(read(),1_640);

  const token='engine-runtime-test-token-00000000000000';
  c.processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:fixture',
    permissions:['viewer.processing.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60_000).toISOString()});
  const app=express();app.use(createProcessingApi({repository:c.repository,processing:c.processing,storage:c.storage}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=async path=>{
    const response=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{headers:{authorization:`Bearer ${token}`}});
    assert.equal(response.status,200);
    return response.json();
  };
  for(const item of [(await get('/api/v1/tasks')).tasks.find(item=>item.id===task.id),
    (await get(`/api/v1/tasks/${task.id}`)).task]){
    assert.equal(item.metrics.processingDurationMs,1_640);
    assert.equal(item.metrics.processingDurationAttemptId,attempt.id);
    assert.equal(Object.hasOwn(item.latestAttempt,'processingDurationMs'),false);
  }
  const history=`/api/v1/tasks/${task.id}/attempts`;
  assert.equal(Object.hasOwn((await get(history)).attempts[0],'processingDurationMs'),false);
  assert.equal((await get(history+'?timing=engine')).attempts[0].processingDurationMs,1_640);

  c.db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
  c.processing.transitionAttempt(attempt.id,'failed');
  const earlierId=attempt.id;
  for(const [code,ms,expected] of [[30,700,700],[50,0,0],[40,undefined,undefined]]){
    start();
    assert.equal(read(),undefined);
    await poll(20,100);
    await poll(code,ms);
    assert.equal(read(),expected);
    c.db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
    c.processing.transitionAttempt(attempt.id,'failed');
  }
  const detail=(await get(`/api/v1/tasks/${task.id}`)).task;
  assert.equal(detail.metrics.processingDurationMs,null);
  assert.equal(detail.metrics.processingDurationAttemptId,null);
  assert.equal(c.processing.engineProcessingDurations([earlierId]).get(earlierId),1_640);
  const historyWithTiming=(await get(history+'?timing=engine')).attempts;
  assert.equal(historyWithTiming.find(item=>item.id===attempt.id).processingDurationMs,null);
  assert.equal(historyWithTiming.find(item=>item.id===earlierId).processingDurationMs,1_640);

  start();
  const expired=c.processing.claimJob(owner);
  c.db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id=?").run(expired.id);
  assert.equal(c.processing.advanceReconcileJob(expired.id,owner,{
    uuid:attempt.providerTaskId,status:'running',processingTime:9_999,
  }),false);
  assert.equal(read(),undefined);
});

test('migration 83 preserves populated schema 42 and refuses incompatible ledger records',t=>{
  const root=mkdtempSync(join(tmpdir(),'viewer-timer-migration-'));
  const databasePath=join(root,'viewer.sqlite');
  let db=new DatabaseSync(databasePath);
  t.after(()=>{db?.close();rmSync(root,{recursive:true,force:true});});
  db.exec('PRAGMA foreign_keys=ON');
  const migration=MIGRATIONS.pop();
  assert.equal(migration.version,83);
  try{applyMigrations(db);}
  finally{MIGRATIONS.push(migration);}
  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version,42);
  const c={db,processing:new ProcessingRepository(db)};
  const project=c.processing.createProject({displayName:'Upgrade fixture'}),data=dataset(c,project);
  const task=c.processing.createTask({projectId:project.id,datasetId:data.id,displayName:'Existing task'});
  const provider=c.processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=c.processing.createAttempt({taskId:task.id,providerId:provider.id});

  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (83,?,?)')
    .run('other_migration','2026-11-20T00:00:00Z');
  assert.throws(()=>applyMigrations(db),{code:'viewer_migration_history_conflict'});
  assert.equal(db.prepare("SELECT count(*) n FROM sqlite_schema WHERE name='processing_attempt_engine_timing'").get().n,0);
  db.prepare('DELETE FROM schema_migrations WHERE version=83').run();
  db.close();
  db=null;
  db=openDatabase(databasePath);
  const upgraded=new ProcessingRepository(db);
  assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=83').get().name,migration.name);
  assert.deepEqual(upgraded.getAttempt(attempt.id),attempt);
  assert.equal(upgraded.engineProcessingDurations([attempt.id]).size,0);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  db.exec('DROP TABLE processing_attempt_engine_timing');
  assert.throws(()=>applyMigrations(db),{code:'viewer_migration_history_conflict'});
});

test('a historical reference-protocol 51 stamp cannot satisfy the timer migration',t=>{
  const db=new DatabaseSync(':memory:');
  t.after(()=>db.close());
  db.exec('PRAGMA foreign_keys=ON');
  const migration=MIGRATIONS.pop();
  try{applyMigrations(db);}
  finally{MIGRATIONS.push(migration);}
  const oldIdentity='viewer_reference_protocol_identity';
  db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (51,?,?)')
    .run(oldIdentity,'2026-11-02T00:00:00Z');
  assert.equal(migration.verify(db),false);
  applyMigrations(db);
  applyMigrations(db);
  assert.equal(migration.verify(db),true);
  assert.deepEqual(db.prepare('SELECT version,name FROM schema_migrations WHERE version IN (51,83) ORDER BY version').all().map(row=>({...row})),[
    {version:51,name:oldIdentity},
    {version:83,name:'provider_engine_processing_elapsed'},
  ]);
});
