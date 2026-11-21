'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const auth=require('../server/auth'),{openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
const {listener}=require('./helpers/bounded-test-listener.cjs');

test('upload creation returns its token once and redacts receipt; replay requires explicit recovery',async()=>{
 let database,server;try{database=openDatabase(':memory:');const repository=new ViewerRepository(database),processing=new ProcessingRepository(database);
 const token=crypto.randomBytes(32).toString('base64url');processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'synthetic',permissions:['viewer.datasets.write'],expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()});
 const app=express();app.use(express.json({verify:(req,_res,buf)=>{req.rawBody=Buffer.from(buf)}}));app.use(createProcessingApi({repository,processing,storage:{sameFilesystem:()=>true,requireSpace:()=>{}}}));
 server=listener(app);const port=await server.start();
  const url=`http://127.0.0.1:${port}/api/v1/datasets/${dataset.id}/uploads`,body=JSON.stringify({files:[{id:'photo',relativePath:'photo.jpg',byteSize:5,sha256:'a'.repeat(64)}]}),headers={authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':'synthetic-request-01'};
  const request=(h=headers,b=body)=>fetch(url,{method:'POST',headers:h,body:b,signal:AbortSignal.timeout(3000)});
  let response=await request();assert.equal(response.status,201);const created=await response.json();assert.equal(typeof created.uploadToken,'string');const id=created.upload.id,hash=processing.getUpload(id).tokenHash;
  const receipt=database.prepare('SELECT response_json FROM admin_idempotency WHERE idempotency_key=?').get('synthetic-request-01').response_json;assert.equal(receipt.includes(created.uploadToken),false);assert.equal(Object.hasOwn(JSON.parse(receipt),'uploadToken'),false);
  response=await request();assert.equal(response.status,409);assert.equal((await response.json()).code,'upload_token_recovery_required');assert.equal(processing.getUpload(id).tokenHash,hash);
  database.prepare('UPDATE admin_idempotency SET response_json=? WHERE idempotency_key=?').run(JSON.stringify(created),'synthetic-request-01');response=await request();assert.equal(response.status,409);const legacyBody=await response.text();assert.equal(legacyBody.includes(created.uploadToken),false);assert.equal(processing.getUpload(id).tokenHash,hash);
  response=await request(headers,JSON.stringify({files:[{id:'different',relativePath:'other.jpg',byteSize:5,sha256:'a'.repeat(64)}]}));assert.equal(response.status,409);assert.equal((await response.json()).code,'idempotency_conflict');
  response=await request({...headers,authorization:'Bearer invalid'});assert.equal(response.status,401);assert.equal(processing.getUpload(id).tokenHash,hash);
  for(const [suffix,key] of [['/','synthetic-request-02'],['/','synthetic-request-03'],['','synthetic-request-04']]){
   const variant=key.endsWith('03')?url.replace('/api/v1/datasets/','/API/V1/DATASETS/')+suffix:key.endsWith('04')?url.replace(dataset.id,dataset.id.replace('-','%2D')):url+suffix;
   const options={method:'POST',headers:{...headers,'idempotency-key':key},body,signal:AbortSignal.timeout(3000)};
   response=await fetch(variant,options);assert.equal(response.status,201);const first=await response.json();const stored=database.prepare('SELECT response_json FROM admin_idempotency WHERE idempotency_key=?').get(key).response_json;assert.equal(stored.includes(first.uploadToken),false);
   database.prepare('UPDATE admin_idempotency SET response_json=? WHERE idempotency_key=?').run(JSON.stringify(first),key);response=await fetch(variant,{...options,signal:AbortSignal.timeout(3000)});assert.equal(response.status,409);assert.equal((await response.json()).code,'upload_token_recovery_required');
  }
 }finally{if(server)await server.stop();if(database)database.close();}
});
