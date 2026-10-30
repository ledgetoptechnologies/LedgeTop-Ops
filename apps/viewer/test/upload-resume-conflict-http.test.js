'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const auth=require('../server/auth');
const {openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');

test('a lost resume race returns a conflict without creating another upload',async t=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const token='synthetic-resume-conflict-token-000000000',subject='ops:synthetic';
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}];
 processing.resumeUpload=()=>({conflict:true});let created=false;processing.createUpload=()=>{created=true;throw Error('must not create');};
 const app=express();app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(createProcessingApi({repository,processing,storage:{sameFilesystem:()=>true,requireSpace:()=>{}}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/datasets/${dataset.id}/uploads`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({files})});
 const body=await response.json();assert.equal(response.status,409,JSON.stringify(body));assert.equal(body.code,'upload_resume_conflict');assert.equal(created,false);
});
