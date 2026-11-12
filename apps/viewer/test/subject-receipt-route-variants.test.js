'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express');
const auth=require('../server/auth'),{openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
test('matched durable routes retain subject receipts across URL variants and admin sessions', {timeout:10000},async()=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db),tokens=[0,1].map(()=>crypto.randomBytes(32).toString('base64url'));
 for(const token of tokens)processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'synthetic',permissions:['viewer.datasets.import'],expiresAt:new Date(Date.now()+60000).toISOString()});
 const app=express();app.use(express.json({verify:(req,_res,buf)=>{req.rawBody=Buffer.from(buf)}}));app.use(createProcessingApi({repository,processing,storage:{}}));
 const server=await new Promise((resolve,reject)=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));s.once('error',reject)});
 try{const base=`http://127.0.0.1:${server.address().port}`,variants=[['/api/v1/dataset-imports/preview/',{rootKey:'dataset_import',relativePath:'synthetic'},202],['/API/V1/DATASET-IMPORTS/PREVIEW',{rootKey:'dataset_import',relativePath:'synthetic'},202],['/api/v1/processing/catalog-imports/candidates/not%2Dfound/map/',{},404],['/api/v1/dataset-imports/copy/',{},400]];
  for(let i=0;i<variants.length;i++){const [route,body,status]=variants[i],key=`synthetic-route-${i}`,request=(token)=>fetch(base+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':key},body:JSON.stringify(body),signal:AbortSignal.timeout(3000)});
   let response=await request(tokens[0]);assert.equal(response.status,status);await response.text();const receipt=db.prepare('SELECT response_status,operation_id FROM subject_operation_receipts WHERE subject=? AND client_key=?').get('synthetic',key);assert.ok(receipt);assert.equal(receipt.response_status,status);assert.equal(db.prepare('SELECT count(*) n FROM admin_idempotency WHERE idempotency_key=?').get(key).n,0);
   response=await request(tokens[1]);assert.equal(response.status,status);assert.equal(response.headers.get('idempotency-replayed'),'true');await response.text();if(status===202)assert.ok(receipt.operation_id);
  }
 }finally{server.closeAllConnections();await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));assert.equal(server.listening,false);db.close();}
});
