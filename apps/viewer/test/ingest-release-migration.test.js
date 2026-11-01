'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('migration 41 preserves existing pending and leased work in a populated database',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
    // Reconstruct the schema immediately before migration 41, without touching disk.
    db.exec('DROP TABLE ingest_publication_intents; DELETE FROM schema_migrations WHERE version=41');
    const repo=new ProcessingRepository(db),project=repo.createProject({displayName:'Synthetic'});
    const dataset=repo.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
    repo.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
    const provider=repo.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint:'http://127.0.0.1:9',enabled:true,authEnvKey:require('../server/providerAuth').NO_AUTH_MARKER});
    for(let i=0;i<2;i++){const task=repo.createTask({projectId:project.id,datasetId:dataset.id,displayName:`Task ${i}`});repo.createAttempt({taskId:task.id,providerId:provider.id,options:{}});}
    const pending=db.prepare("SELECT id FROM processing_jobs WHERE status='pending' ORDER BY id").all();assert.equal(pending.length,2);
    const leased=repo.claimJob('synthetic-worker');assert.ok(leased);
    const before=db.prepare('SELECT * FROM processing_jobs ORDER BY id').all();
    applyMigrations(db);assert.deepEqual(db.prepare('SELECT * FROM processing_jobs ORDER BY id').all(),before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ingest_publication_intents').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM processing_tasks').get().n,2);
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0);
  }finally{db.close();}
});
