'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {DatabaseSync}=require('node:sqlite');
const express=require('express');
const auth=require('../server/auth');
const {ProcessingRepository}=require('../server/processingRepository');
const {createProcessingApi}=require('../server/processingApi');

test('attempt warnings require processing read and expose no raw archive inventory',async t=>{
  const db=new DatabaseSync(':memory:');db.exec('CREATE TABLE processing_attempt_transfer_provenance(attempt_id TEXT, archive_json TEXT)');
  const sha=x=>crypto.createHash('sha256').update(x).digest('hex'),attempt={id:'fixture-attempt',providerTaskId:'fixture-provider',status:'ready_for_review',options:{'3d-tiles':true}};
  const files=['3d_tiles/model/tileset.json',...Array.from({length:70},(_,i)=>`fixture/file-${i}`)].map(relativePath=>({relativePath,byteSize:1,sha256:sha('x')}));
  const archive={schemaVersion:1,attemptId:attempt.id,providerTaskId:attempt.providerTaskId,archiveSha256:sha('zip'),archiveByteSize:100,archiveFiles:files,archiveManifestSha256:sha(JSON.stringify(files))};
  db.prepare('INSERT INTO processing_attempt_transfer_provenance VALUES(?,?)').run(attempt.id,JSON.stringify(archive));
  const allowed='fixture-processing-reader-token-000000000000',denied='fixture-other-permission-token-000000000000';
  const sessions=new Map([[auth.hashToken(allowed),{id:'s1',subject:'reader',permissions:['viewer.processing.read']}],[auth.hashToken(denied),{id:'s2',subject:'other',permissions:['viewer.datasets.read']}] ]);
  const processing={database:db,getAdminSessionByHash:h=>sessions.get(h),adminSessionLive:()=>true,getAttempt:id=>id===attempt.id?attempt:null,listLogs:()=>[],getOutputWarningArchive:id=>ProcessingRepository.prototype.getOutputWarningArchive.call({database:db},id)};
  const app=express();app.use(createProcessingApi({repository:{},processing,storage:{}}));const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x))});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close()});
  const url=`http://127.0.0.1:${server.address().port}/api/v1/attempts/${attempt.id}`;
  let response=await fetch(url,{headers:{authorization:`Bearer ${denied}`}});assert.equal(response.status,403);
  response=await fetch(url,{headers:{authorization:`Bearer ${allowed}`}});assert.equal(response.status,200);let body=await response.json();assert.deepEqual(body.outputWarnings.map(x=>x.code),['pointcloud_3d_tiles_missing']);assert.equal(JSON.stringify(body).includes('fixture/file-'),false);
  db.prepare('UPDATE processing_attempt_transfer_provenance SET archive_json=? WHERE attempt_id=?').run('x'.repeat(1048577),attempt.id);
  response=await fetch(url,{headers:{authorization:`Bearer ${allowed}`}});body=await response.json();assert.deepEqual(body.outputWarnings.map(x=>x.code),['3d_tiles_inventory_unavailable']);
  attempt.status='running';response=await fetch(url,{headers:{authorization:`Bearer ${allowed}`}});body=await response.json();assert.deepEqual(body.outputWarnings,[]);
});
