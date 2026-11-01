'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../server/database'),fence=require('../server/nativeOperationFenceCandidate'),state=require('../server/nativeEpochStateCandidate');
test('durable epoch and revoke identity hold local writes through restart',{skip:process.platform!=='linux'},t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-epoch-state-')),file=path.join(root,'db.sqlite');let db=new DatabaseSync(file);t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
  applyMigrations(db);fence.install(db,true);state.install(db,true);let client=state.createState({db,enabled:true});const identitySha256='a'.repeat(64),attemptId='attempt-1';
  assert.throws(()=>client.begin({attemptId,identitySha256,checkContext:()=>false}),{code:'native_epoch_hold'});assert.equal(db.prepare('SELECT COUNT(*) n FROM native_operation_fence_candidate').get().n,0);
  const operationId=client.begin({attemptId,identitySha256,checkContext:()=>true});assert.equal(client.begin({attemptId,identitySha256,checkContext:()=>true}),operationId);
  assert.throws(()=>db.exec('INSERT INTO processing_attempts DEFAULT VALUES'),/native operation unresolved/);
  const script="const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),s=require(process.argv[1]),db=new DatabaseSync(process.argv[2]);const result=s.createState({db,enabled:true}).prepareRevoke({attemptId:'attempt-1',identitySha256:'a'.repeat(64),buildBody:requestId=>({schemaVersion:2,requestId,expectedManifestSha256:'a'.repeat(64),expectedManifestBindingId:null,expectedPlanSha256:null})});fs.writeSync(1,JSON.stringify(result));process.kill(process.pid,'SIGKILL');";
  const killed=require('node:child_process').spawnSync(process.execPath,['-e',script,require.resolve('../server/nativeEpochStateCandidate'),file],{encoding:'utf8',timeout:5000});assert.equal(killed.signal,'SIGKILL');const first=JSON.parse(killed.stdout);
  db.close();db=new DatabaseSync(file);client=state.createState({db,enabled:true});assert.deepEqual(client.prepareRevoke({attemptId,identitySha256,buildBody:()=>{throw new Error('must not regenerate');}}),first);
  assert.throws(()=>client.begin({attemptId,identitySha256:'b'.repeat(64),checkContext:()=>true}),{code:'native_epoch_hold'});assert.throws(()=>db.exec('INSERT INTO processing_attempts DEFAULT VALUES'),/native operation unresolved/);
  assert.equal(db.prepare('SELECT operation_id FROM native_operation_fence_candidate').get().operation_id,operationId);
});
