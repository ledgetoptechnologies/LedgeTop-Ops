'use strict';
// Offline evidence only: no production paths, services, Docker or network.
// Synthetic root is retained. Old source must be an explicit exact checkout.
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const oldRoot=process.env.LT_OLD_VIEWER_CHECKOUT;
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('nonempty offline migration exposes old-writer and rollback barriers', {timeout:15000,skip:!oldRoot?'exact old checkout not supplied':false}, ()=>{
  assert.ok(oldRoot && path.isAbsolute(oldRoot),'provide exact old checkout');
  const oldDb=require(path.join(oldRoot,'apps/viewer/server/database'));
  const {ProcessingRepository:OldRepo}=require(path.join(oldRoot,'apps/viewer/server/processingRepository'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'lt-viewer-rollback-evidence-'));
  console.log('Retained synthetic Viewer root:',root);
  const file=path.join(root,'candidate.sqlite'),backup=path.join(root,'pre-upgrade.sqlite');
  const source=path.join(root,'source.bin');fs.writeFileSync(source,Buffer.from('synthetic source bytes'));
  let db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON');
  try{
    oldDb.applyMigrations(db);
    const old=new OldRepo(db),project=old.createProject({displayName:'Synthetic'});
    const dataset=old.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
    old.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=old.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER});
    const attempts=[];
    for(let i=0;i<2;i++){const task=old.createTask({projectId:project.id,datasetId:dataset.id,displayName:`Synthetic ${i}`});attempts.push(old.createAttempt({taskId:task.id,providerId:provider.id,options:{}}));}
    db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempts[0].id);
    old.transitionAttempt(attempts[0].id,'ingesting');old.enqueueJob(attempts[0].id,'ingest');
    db.exec("UPDATE processing_jobs SET available_at='9999' WHERE job_type='submit' AND status='pending'");
    const leased=old.claimJob('same-owner');assert.ok(leased);assert.equal(leased.job_type,'ingest');
    db.prepare("UPDATE processing_jobs SET available_at='9999' WHERE id<>?").run(leased.id);
    const oldRows=db.prepare('SELECT * FROM processing_jobs ORDER BY id').all();
    db.prepare('VACUUM INTO ?').run(backup);
    // Upgrade a representative populated DB after quiescing old writers.
    applyMigrations(db);
    assert.deepEqual(db.prepare('SELECT * FROM processing_jobs ORDER BY id').all(),oldRows);
    assert.ok(db.prepare('SELECT 1 FROM schema_migrations WHERE version=41').get());
    // A live old binary on the migrated DB is NOT fenced by newer source.
    db.prepare("UPDATE processing_jobs SET lease_expires_at='2000' WHERE id=?").run(leased.id);
    const current=new ProcessingRepository(db),reclaimed=current.claimJob('same-owner');
    assert.equal(reclaimed.id,leased.id);assert.ok(reclaimed.attempt_count>leased.attempt_count);
    assert.equal(current.heartbeatJob(leased.id,'same-owner',60,leased.attempt_count),false);
    assert.equal(old.heartbeatJob(leased.id,'same-owner',60),true,'old source bypasses generation check');
    // An old image accepts newer migrations; version pinning is not a fence.
    oldDb.applyMigrations(db);
    const task=db.prepare('SELECT attempt_id FROM processing_jobs WHERE id=?').get(leased.id);
    db.prepare('INSERT INTO ingest_publication_intents(attempt_id,job_id,lease_generation,created_at,updated_at) VALUES(?,?,?,?,?)')
      .run(task.attempt_id,leased.id,reclaimed.attempt_count,new Date().toISOString(),new Date().toISOString());
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_publication_intents').get().n,1);
    assert.equal(fs.readFileSync(source,'utf8'),'synthetic source bytes');
  }finally{db.close();}
  // Inspect the retained old snapshot independently; do not overwrite candidate.
  const snapshot=new DatabaseSync(backup,{readOnly:true});
  try{
    assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ingest_publication_intents'").get().n,0);
    assert.equal(snapshot.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get().n,3);
  }finally{snapshot.close();}
  // Exercise the old runtime against an isolated copy of the pre-upgrade
  // snapshot. This does not overwrite or roll back the upgraded database.
  const rollback=path.join(root,'isolated-old-rollback.sqlite');
  fs.copyFileSync(backup,rollback,fs.constants.COPYFILE_EXCL);
  const restored=new DatabaseSync(rollback);
  try{
    oldDb.applyMigrations(restored);
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get().n,3);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE status='leased'").get().n,1);
    assert.equal(restored.prepare("SELECT COUNT(*) AS n FROM processing_jobs WHERE status='pending'").get().n,1);
    assert.equal(restored.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{restored.close();}
  const upgraded=new DatabaseSync(file,{readOnly:true});
  try{
    assert.equal(upgraded.prepare('SELECT COUNT(*) AS n FROM ingest_publication_intents').get().n,1,
      'restoring old snapshot over this database would discard newer state');
    assert.equal(upgraded.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
  }finally{upgraded.close();}
});
