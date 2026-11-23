'use strict';
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const test=require('node:test');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database');
const {ViewerRepository}=require('../server/repository');
const {ProcessingRepository}=require('../server/processingRepository');
const {createProcessingApi}=require('../server/processingApi');

test('real staff authentication and idempotency bind original upload bytes and filename',async t=>{
  const database=openDatabase(':memory:'),processing=new ProcessingRepository(database);
  const repository=new ViewerRepository(database),writer=crypto.randomBytes(32).toString('base64url');
  const reader=crypto.randomBytes(32).toString('base64url');
  const session=processing.createAdminSession({tokenHash:auth.hashToken(writer),subject:'synthetic:writer',
    permissions:['viewer.gcp.read','viewer.gcp.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  processing.createAdminSession({tokenHash:auth.hashToken(reader),subject:'synthetic:reader',
    permissions:['viewer.gcp.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const project=processing.createProject({displayName:'Synthetic GCP idempotency'});
  const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
  const empty=crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id,[],empty);
  const app=express();app.use(express.json({verify(req,_res,bytes){req.rawBody=Buffer.from(bytes);}}));
  app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();});
  const base=`http://127.0.0.1:${server.address().port}`;
  const route=`${base}/api/v1/datasets/${dataset.id}/gcp-source-originals?fileName=control.csv`;
  const bytes=Buffer.from('\ufeffName,Latitude,Longitude\r\nA,44.5,-88.1\r\n');
  const options={method:'POST',headers:{authorization:`Bearer ${writer}`,'content-type':'application/octet-stream','idempotency-key':'original-retry-0001'},body:bytes};
  const first=await fetch(route,options);assert.equal(first.status,201);const created=await first.json();
  const replay=await fetch(route,options);assert.equal(replay.status,201);
  assert.equal(replay.headers.get('idempotency-replayed'),'true');assert.deepEqual(await replay.json(),created);
  assert.equal((await fetch(route,{...options,body:Buffer.from('different bytes')})).status,409);
  assert.equal((await fetch(route.replace('control.csv','other.csv'),options)).status,409);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM viewer_gcp_source_originals').get().n,1);
  assert.equal((await fetch(route,{...options,headers:{...options.headers,authorization:`Bearer ${reader}`}})).status,403);
  const download=`${base}/api/v1/gcp-source-originals/${created.original.id}/content`;
  assert.equal(processing.revokeAdminSession(session.id),true);
  assert.equal((await fetch(route,options)).status,401);
  assert.equal((await fetch(download,{headers:{authorization:`Bearer ${writer}`}})).status,401);
  const readable=await fetch(download,{headers:{authorization:`Bearer ${reader}`}});
  assert.equal(readable.status,200);assert.deepEqual(Buffer.from(await readable.arrayBuffer()),bytes);
});
