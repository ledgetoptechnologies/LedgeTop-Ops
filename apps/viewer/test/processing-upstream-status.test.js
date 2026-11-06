'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');

test('queued upstream stays queued and persists only validated scheduler state',t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);
  const processing=new ProcessingRepository(db),project=processing.createProject({displayName:'Queue status fixture'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Input',storageMode:'managed',rootKey:'datasets',relativePath:'input'});
  processing.finalizeDataset(dataset.id,[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],'b'.repeat(64));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Queue node',endpoint:'http://127.0.0.1:3000',enabled:true});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Queue task'});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id});
  assert.equal(processing.transitionAttempt(attempt.id,'queued_upstream').status,'queued_upstream');
  assert.equal(processing.getTask(task.id).status,'queued');

  const leaseExpiresAt=new Date(Date.now()+60_000).toISOString(),now=new Date().toISOString();
  db.prepare("UPDATE processing_jobs SET status='complete' WHERE attempt_id=?").run(attempt.id);
  db.prepare(`INSERT INTO processing_jobs(id,attempt_id,job_type,status,available_at,lease_owner,lease_expires_at,created_at,updated_at)
    VALUES ('queue-poll',?,'reconcile','leased',?,'worker',?,?,?)`).run(attempt.id,now,leaseExpiresAt,now,now);
  assert.equal(processing.advanceReconcileJob('queue-poll','worker',{
    status:'queued_upstream',progress:0,queueState:'waiting_for_dispatch',queueReason:'waiting_node_capacity',nodeId:'node-east-01',held:true,
  },leaseExpiresAt),true);
  assert.deepEqual(processing.getAttempt(attempt.id).providerStatus,{queueState:'waiting_for_dispatch',queueReason:'waiting_node_capacity',nodeId:'node-east-01',held:true});
  assert.equal(processing.getTask(task.id).status,'queued');

  const next=db.prepare("SELECT id FROM processing_jobs WHERE attempt_id=? AND job_type='reconcile' AND status='pending'").get(attempt.id);
  db.prepare("UPDATE processing_jobs SET status='leased',lease_owner='worker',lease_expires_at=? WHERE id=?").run(leaseExpiresAt,next.id);
  assert.equal(processing.advanceReconcileJob(next.id,'worker',{
    status:'running',progress:0.2,nodeId:'node-east-01',queueState:'not-a-supported-state',queueReason:'raw-provider-error',held:'true',
  },leaseExpiresAt),true);
  const running=processing.getAttempt(attempt.id);
  assert.equal(running.status,'running');assert.equal(processing.getTask(task.id).status,'processing');
  assert.deepEqual(running.providerStatus,{nodeId:'node-east-01'});
});
