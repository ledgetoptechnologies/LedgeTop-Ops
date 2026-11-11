'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),express=require('express'),http=require('node:http');
const {openDatabase}=require('../server/database');const {ProcessingRepository}=require('../server/processingRepository');const {ViewerRepository}=require('../server/repository');
const {StorageManager}=require('../server/storageManager');const {createProcessingApi}=require('../server/processingApi');const {config}=require('../server/config');const auth=require('../server/auth');
const {processOneDatasetOperation}=require('../server/datasetOperationWorker');
const sha=value=>crypto.createHash('sha256').update(value).digest('hex');
function request(server,method,url,body,headers={}){return new Promise((resolve,reject)=>{const req=http.request({host:'127.0.0.1',port:server.address().port,path:url,method,headers},res=>{const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks).toString()}));});req.on('error',reject);if(body)req.write(body);req.end();});}
test('storage rejects dot file components before storage or filesystem lookup',async()=>{
 const storage=Object.create(StorageManager.prototype);let accessed=0;storage.resolve=()=>{accessed++;throw Error('unexpected storage lookup');};storage.requireSpace=()=>{accessed++;throw Error('unexpected disk lookup');};
 for(const id of ['.','..']){
  assert.throws(()=>storage.chunkPath('upload',id,0),{code:'invalid_upload_file_id'});
  assert.throws(()=>storage.writeChunk('upload',id,0,Buffer.from('x'),sha('x')),{code:'invalid_upload_file_id'});
  await assert.rejects(storage.assembleFile({id:'upload'},{id,relativePath:'file.csv'},[],'dataset'),{code:'invalid_upload_file_id'});
 }
 assert.equal(accessed,0);
});
test('upload API rejects dot IDs and holds legacy uploads while valid neighbors continue',async t=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db),calls=[];
 const storage={sameFilesystem:()=>true,requireSpace:()=>{},writeChunk(...args){calls.push(['write',...args]);return {sha256:sha('x'),byteSize:1,replayed:false};},cleanupUpload(id){calls.push(['cleanup',id]);}};
 const token='synthetic-upload-component-test-token-000000000',subject='ops:fixture';processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write','viewer.storage.purge'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Upload',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'});
 const app=express();app.use(express.json());app.use(createProcessingApi({repository,processing,storage,config:{...config,uploadMaxFiles:100,uploadMaxManifestBytes:100000,uploadChunkBytes:4}}));
 app.use((err,_req,res,_next)=>res.status(500).json({error:err.code||'internal'}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
 t.after(async()=>{server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));db.close();});
 const spec=id=>({id,relativePath:'source.jpg',byteSize:1,sha256:sha('x')}),headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 let sequence=0;const post=(url,body)=>request(server,'POST',url,JSON.stringify(body),{...headers,'idempotency-key':`fixture-key-${++sequence}`});
 for(const id of ['.','..']){const response=await post(`/api/v1/datasets/${dataset.id}/uploads`,{files:[spec(id)]});assert.equal(response.status,400);assert.equal(JSON.parse(response.body).error,'invalid_manifest');}
 const valid=await post(`/api/v1/datasets/${dataset.id}/uploads`,{files:[spec('.hidden')]});assert.equal(valid.status,201,valid.body);
 const validId=JSON.parse(valid.body).upload.id;db.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(validId);
 // Bypass only admission to represent retained records made by an old release.
 for(const id of ['.','..']){
  const legacy=processing.createUpload({datasetId:dataset.id,files:[spec(id)],subject,chunkSize:4,expiresAt:new Date(Date.now()+60000).toISOString()});
  db.prepare('INSERT INTO upload_chunks(upload_id,file_id,chunk_index,byte_size,sha256,relative_path,created_at) VALUES (?,?,0,1,?,?,?)').run(legacy.upload.id,id,sha('x'),'source.jpg',new Date().toISOString());
  const encoded=id==='.'?'%2e':'%2e%2e';
  const result=await request(server,'PUT',`/api/v1/admin/uploads/${legacy.upload.id}/files/${encoded}/chunks/0`,Buffer.from('x'),{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-upload-token':legacy.token,'x-chunk-sha256':sha('x')});
  assert.equal(result.status,409,result.body);assert.equal(JSON.parse(result.body).code,'invalid_upload_file_id');
  const finalize=await post(`/api/v1/admin/uploads/${legacy.upload.id}/finalize`,{uploadToken:legacy.token});assert.equal(finalize.status,409,finalize.body);
  const oldOperation=processing.createUploadFinalizeOperation(legacy.upload.id,subject);assert.ok(oldOperation);
  assert.equal(await processOneDatasetOperation({processing,storage,config:{}},'fixture-legacy-worker'),true);
  assert.equal(processing.getDatasetOperation(oldOperation.id,subject).errorCode,'invalid_upload_file_id');
  db.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(legacy.upload.id);
  assert.equal(processing.expiredUploads().includes(legacy.upload.id),false);assert.equal(processing.listChunks(legacy.upload.id,id).length,1);
 }
 assert.equal(processing.expiredUploads().includes(validId),true,'valid neighboring uploads remain eligible for normal expiry');
 const unknown=processing.createUpload({datasetId:dataset.id,files:[spec('legacy')],subject,chunkSize:4,expiresAt:new Date(Date.now()+60000).toISOString()}).upload;
 db.prepare("UPDATE upload_sessions SET expected_manifest_json='{bad',expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(unknown.id);
 assert.equal(processing.expiredUploads().includes(unknown.id),false,'unreadable legacy manifest remains held');
 const removed=await request(server,'DELETE',`/api/v1/datasets/${dataset.id}`,JSON.stringify({}),{...headers,'idempotency-key':'fixture-delete-key'});
 assert.equal(removed.status,409,removed.body);assert.equal(JSON.parse(removed.body).code,'invalid_upload_file_id');
 assert.deepEqual(calls,[]);
});
