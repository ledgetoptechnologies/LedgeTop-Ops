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

// This deliberately fails until chunk writes and all cleanup paths share a
// cross-process fence. It is not a release test while the protocol is disabled.
test('an already authorized chunk cannot be acknowledged after cleanup claims its upload',{skip:process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{StorageManager}=require('../server/storageManager');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-chunk-fence-'));
 const db=openDatabase(path.join(root,'viewer.sqlite')),otherDb=openDatabase(path.join(root,'viewer.sqlite'));
 const processing=new ProcessingRepository(db),cleaner=new ProcessingRepository(otherDb),repository=new ViewerRepository(db);
 const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0};
 const storage=new StorageManager(config);storage.initialize();
 const token='synthetic-chunk-fence-token-000000000000',subject='ops:synthetic',body=Buffer.from('synthetic');
 const sha=crypto.createHash('sha256').update(body).digest('hex');
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256:sha}],created=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'});
 const transaction=processing.transaction.bind(processing);let claimed=false;processing.transaction=fn=>{if(!claimed){claimed=true;otherDb.prepare("UPDATE upload_sessions SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(created.upload.id);assert.equal(cleaner.expireUpload(created.upload.id),true);storage.cleanupUpload(created.upload.id);}return transaction(fn);};
 const app=express();app.use(createProcessingApi({repository,processing,storage}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));otherDb.close();db.close();fs.rmSync(root,{recursive:true,force:true});});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${created.upload.id}/files/photo/chunks/0`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-upload-token':created.token,'x-chunk-sha256':sha},body});
 assert.equal(response.ok,false,`cleanup has claimed the upload; the stale writer must not be acknowledged (HTTP ${response.status})`);
 assert.equal(processing.listChunks(created.upload.id,'photo').length,0);
 processing.transaction=transaction;
 const second=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'});
 otherDb.exec('PRAGMA busy_timeout=0');let blocked=false;
 const write=storage.writeChunk.bind(storage);storage.writeChunk=(...args)=>{
  try{cleaner.expireUpload(second.upload.id);}catch(error){assert.match(error.message,/locked|busy/i);blocked=true;}
  const script="const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=0');try{db.prepare('UPDATE upload_sessions SET status=\\'expired\\' WHERE id=?').run(process.argv[2]);process.stdout.write('updated');}catch(e){if(!/locked|busy/i.test(e.message))throw e;process.stdout.write('busy');}finally{db.close();}";
  const child=require('node:child_process').spawnSync(process.execPath,['-e',script,path.join(root,'viewer.sqlite'),second.upload.id],{encoding:'utf8',timeout:5000});
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout,'busy','a separate process cannot claim cleanup during publication');
  return write(...args);
 };
 const accepted=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${second.upload.id}/files/photo/chunks/0`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-upload-token':second.token,'x-chunk-sha256':sha},body});
 assert.equal(accepted.status,201);assert.equal(blocked,true,'a second database connection cannot claim cleanup during publication');
 assert.equal(processing.listChunks(second.upload.id,'photo').length,1);
});

test('a lost chunk response can be retried without duplicating the receipt',{skip:process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{StorageManager}=require('../server/storageManager');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-lost-chunk-response-')),db=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0},storage=new StorageManager(config);storage.initialize();
 const token='synthetic-lost-chunk-response-token-0000',subject='ops:synthetic',body=Buffer.from('synthetic response loss'),sha=crypto.createHash('sha256').update(body).digest('hex');
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'}),files=[{id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256:sha}],created=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'});
 const originalSynchronous=db.prepare('PRAGMA synchronous').get().synchronous,recordChunk=processing.recordChunk.bind(processing);let durableRecord=false;processing.recordChunk=input=>{assert.ok(db.prepare('PRAGMA synchronous').get().synchronous>=2);durableRecord=true;return recordChunk(input);};
 let drop=true,capturedError=null;const app=express();app.use((req,res,next)=>{const json=res.json.bind(res);res.json=value=>{if(drop&&req.method==='PUT'&&res.statusCode===201){drop=false;res.destroy();return res;}return json(value);};next();});app.use(createProcessingApi({repository,processing,storage}));app.use((error,_req,res,_next)=>{capturedError=error;res.status(500).end();});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();fs.rmSync(root,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${created.upload.id}/files/photo/chunks/0`,options={method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream','x-upload-token':created.token,'x-chunk-sha256':sha},body};
 await assert.rejects(fetch(url,options));assert.equal(drop,false);assert.equal(durableRecord,true);assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,originalSynchronous);assert.equal(processing.listChunks(created.upload.id,'photo').length,1);
 const retry=await fetch(url,options);assert.equal(retry.status,200);assert.equal((await retry.json()).chunk.replayed,true);assert.equal(processing.listChunks(created.upload.id,'photo').length,1);assert.deepEqual(fs.readFileSync(storage.chunkPath(created.upload.id,'photo',0)),body);
 const second=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'}),secondUrl=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${second.upload.id}/files/photo/chunks/0`,sync=fs.fsyncSync;let injected=false;
 try{fs.fsyncSync=fd=>{if(!injected&&fs.fstatSync(fd).isFile()){injected=true;throw Object.assign(new Error('synthetic sync failure'),{code:'EIO'});}return sync(fd);};const failed=await fetch(secondUrl,{...options,headers:{...options.headers,'x-upload-token':second.token}});assert.equal(failed.status,500);}finally{fs.fsyncSync=sync;}
 assert.equal(injected,true);assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,originalSynchronous);assert.equal(processing.listChunks(second.upload.id,'photo').length,0,'failed durability must not create a receipt');
 const recovered=await fetch(secondUrl,{...options,headers:{...options.headers,'x-upload-token':second.token}});assert.equal(recovered.status,201);assert.equal(processing.listChunks(second.upload.id,'photo').length,1);
 const third=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'}),thirdUrl=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${third.upload.id}/files/photo/chunks/0`;let directoryFailure=false;
 try{fs.fsyncSync=fd=>{if(!directoryFailure&&fs.fstatSync(fd).isDirectory()){directoryFailure=true;throw Object.assign(new Error('synthetic directory sync failure'),{code:'EIO'});}return sync(fd);};const failed=await fetch(thirdUrl,{...options,headers:{...options.headers,'x-upload-token':third.token}});assert.equal(failed.status,500);}finally{fs.fsyncSync=sync;}
 assert.equal(directoryFailure,true);assert.equal(processing.listChunks(third.upload.id,'photo').length,0);assert.deepEqual(fs.readFileSync(storage.chunkPath(third.upload.id,'photo',0)),body);
 const reconciled=await fetch(thirdUrl,{...options,headers:{...options.headers,'x-upload-token':third.token}});assert.equal(reconciled.status,200);assert.equal(processing.listChunks(third.upload.id,'photo').length,1);
 const fourth=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'}),fourthUrl=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${fourth.upload.id}/files/photo/chunks/0`;let restoreFailure=false;
 processing.database=new Proxy(db,{get(target,key){if(key==='exec')return sql=>{if(sql==='PRAGMA synchronous=NORMAL'&&!restoreFailure){restoreFailure=true;throw new Error('synthetic SQLite setting restore failure');}return target.exec(sql);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 try{const failed=await fetch(fourthUrl,{...options,headers:{...options.headers,'x-upload-token':fourth.token}});assert.equal(failed.status,500);assert.equal(restoreFailure,true);assert.equal(processing.listChunks(fourth.upload.id,'photo').length,1);assert.equal(db.prepare('PRAGMA synchronous').get().synchronous,2);
  const replay=await fetch(fourthUrl,{...options,headers:{...options.headers,'x-upload-token':fourth.token}});assert.equal(replay.status,200);assert.equal(processing.listChunks(fourth.upload.id,'photo').length,1);
 }finally{processing.database=db;db.exec(`PRAGMA synchronous=${['OFF','NORMAL','FULL','EXTRA'][originalSynchronous]}`);}
 const fifth=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'}),fifthUrl=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${fifth.upload.id}/files/photo/chunks/0`;
 db.exec('BEGIN IMMEDIATE');try{const rejected=await fetch(fifthUrl,{...options,headers:{...options.headers,'x-upload-token':fifth.token}});assert.equal(rejected.status,500);assert.equal(db.isTransaction,true);assert.equal(processing.listChunks(fifth.upload.id,'photo').length,0);}finally{db.exec('ROLLBACK');}
 const sixth=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'}),sixthUrl=`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${sixth.upload.id}/files/photo/chunks/0`;
 let combinedRestore=false,combinedSync=false;capturedError=null;processing.database=new Proxy(db,{get(target,key){if(key==='exec')return sql=>{if(sql==='PRAGMA synchronous=NORMAL'&&!combinedRestore){combinedRestore=true;throw new Error('synthetic restore error');}return target.exec(sql);};const value=target[key];return typeof value==='function'?value.bind(target):value;}});
 try{fs.fsyncSync=fd=>{if(!combinedSync&&fs.fstatSync(fd).isFile()){combinedSync=true;throw new Error('synthetic chunk sync error');}return sync(fd);};const failed=await fetch(sixthUrl,{...options,headers:{...options.headers,'x-upload-token':sixth.token}});assert.equal(failed.status,500);assert.ok(capturedError instanceof AggregateError);assert.deepEqual(capturedError.errors.map(error=>error.message),['synthetic chunk sync error','synthetic restore error']);assert.equal(processing.listChunks(sixth.upload.id,'photo').length,0);
 }finally{fs.fsyncSync=sync;processing.database=db;db.exec(`PRAGMA synchronous=${['OFF','NORMAL','FULL','EXTRA'][originalSynchronous]}`);}
});

test('a rotated upload token cannot enqueue finalization',{skip:process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},async t=>{
 const db=openDatabase(':memory:'),processing=new ProcessingRepository(db),repository=new ViewerRepository(db);
 const token='synthetic-finalize-fence-token-00000000',subject='ops:synthetic';
 processing.createAdminSession({tokenHash:auth.hashToken(token),subject,permissions:['viewer.datasets.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'});
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)}],created=processing.createUpload({datasetId:dataset.id,subject,files,chunkSize:1,expiresAt:'2999-01-01T00:00:00.000Z'});
 processing.recordChunk({uploadId:created.upload.id,fileId:'photo',chunkIndex:0,relativePath:'photo.jpg',byteSize:1,sha256:'a'.repeat(64)});
 const enqueue=processing.createUploadFinalizeOperation.bind(processing);processing.createUploadFinalizeOperation=(...args)=>{const resumed=processing.resumeUpload(dataset.id,subject,files,'2999-12-31T00:00:00.000Z');assert.ok(resumed.token);return enqueue(...args);};
 const app=express();app.use(express.json({verify(req,_res,body){req.rawBody=body;}}));app.use(createProcessingApi({repository,processing,storage:{}}));
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
 const response=await fetch(`http://127.0.0.1:${server.address().port}/api/v1/admin/uploads/${created.upload.id}/finalize`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({uploadToken:created.token})});
 assert.equal(response.ok,false,`a stale token must not enqueue finalization (HTTP ${response.status})`);
});

for(const phase of ['before publication','after link','after publication','after commit'])test(`chunk retry succeeds when a writer dies ${phase}`,{skip:process.platform!=='linux'||process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawnSync}=require('node:child_process'),{StorageManager}=require('../server/storageManager');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-chunk-crash-')),dbPath=path.join(root,'viewer.sqlite'),db=openDatabase(dbPath),processing=new ProcessingRepository(db);
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0},storage=new StorageManager(config);storage.initialize();
 const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'synthetic'}),body=Buffer.from('synthetic crash fixture'),sha=crypto.createHash('sha256').update(body).digest('hex');
 const files=[{id:'photo',relativePath:'photo.jpg',byteSize:body.length,sha256:sha}],created=processing.createUpload({datasetId:dataset.id,subject:'ops:synthetic',files,chunkSize:body.length,expiresAt:'2999-01-01T00:00:00.000Z'});
 const script="const fs=require('node:fs'),p=JSON.parse(process.argv[1]),{openDatabase}=require(p.dbModule),{ProcessingRepository}=require(p.repoModule),{StorageManager}=require(p.storageModule),db=openDatabase(p.dbPath),processing=new ProcessingRepository(db),storage=new StorageManager(p.config);processing.transaction(()=>{if(p.phase==='before publication')fs.linkSync=()=>process.kill(process.pid,'SIGKILL');if(p.phase==='after link')fs.unlinkSync=()=>process.kill(process.pid,'SIGKILL');const chunk=storage.writeChunk(p.uploadId,'photo',0,Buffer.from(p.body),p.sha);if(p.phase==='after publication')process.kill(process.pid,'SIGKILL');processing.recordChunk({uploadId:p.uploadId,fileId:'photo',chunkIndex:0,relativePath:'photo.jpg',...chunk});});process.kill(process.pid,'SIGKILL');";
 const result=spawnSync(process.execPath,['-e',script,JSON.stringify({dbPath,config,uploadId:created.upload.id,body:body.toString(),sha,phase,dbModule:require.resolve('../server/database'),repoModule:require.resolve('../server/processingRepository'),storageModule:require.resolve('../server/storageManager')})],{encoding:'utf8',timeout:10000});
 assert.equal(result.signal,'SIGKILL',result.stderr);assert.equal(processing.listChunks(created.upload.id,'photo').length,phase==='after commit'?1:0);
 const written=processing.transaction(()=>{const chunk=storage.writeChunk(created.upload.id,'photo',0,body,sha);processing.recordChunk({uploadId:created.upload.id,fileId:'photo',chunkIndex:0,relativePath:'photo.jpg',...chunk});return chunk;});
 assert.equal(written.replayed,phase!=='before publication');assert.equal(processing.listChunks(created.upload.id,'photo').length,1);assert.deepEqual(fs.readFileSync(storage.chunkPath(created.upload.id,'photo',0)),body);
 if(['before publication','after link'].includes(phase))assert.ok(fs.readdirSync(path.dirname(storage.chunkPath(created.upload.id,'photo',0))).some(name=>name.endsWith('.tmp')),'interrupted temporary file remains for later cleanup');
});

test('concurrent chunk publication cannot replace existing bytes',{skip:process.platform!=='linux'||process.env.LTDS_UPLOAD_CHUNK_FENCING_REGRESSION!=='1'},t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{StorageManager}=require('../server/storageManager'),root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-chunk-no-replace-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const config={datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),storageReserveBytes:0,storageReservePercent:0},storage=new StorageManager(config);storage.initialize();
 const body=Buffer.from('new bytes'),existing=Buffer.from('existing bytes'),sha=crypto.createHash('sha256').update(body).digest('hex'),link=fs.linkSync;let injected=false;
 try{fs.linkSync=(source,target)=>{injected=true;fs.writeFileSync(target,existing,{flag:'wx'});return link(source,target);};assert.throws(()=>storage.writeChunk('fixture-upload','photo',0,body,sha),error=>error.code==='chunk_conflict');}finally{fs.linkSync=link;}
 assert.equal(injected,true);assert.deepEqual(fs.readFileSync(storage.chunkPath('fixture-upload','photo',0)),existing);
 try{fs.linkSync=(source,target)=>{fs.writeFileSync(target,body,{flag:'wx'});return link(source,target);};const result=storage.writeChunk('matching-upload','photo',0,body,sha);assert.equal(result.replayed,true);}finally{fs.linkSync=link;}
 assert.deepEqual(fs.readFileSync(storage.chunkPath('matching-upload','photo',0)),body);
});
