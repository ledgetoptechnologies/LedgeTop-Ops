'use strict';
// Synthetic integration runner: requires an isolated coordinator fixture and
// NODE_EXTRA_CA_CERTS. Never point this at a live coordinator.
const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const {applyMigrations}=require('../../server/database');
const {ProcessingRepository}=require('../../server/processingRepository');
const {ProviderCredentials}=require('../../server/providerCredentials');
const {NodeOdmProvider}=require('../../server/nodeOdmProvider');
const {processOne}=require('../../server/processingWorker');

(async()=>{
 const endpoint=process.env.TEST_COORDINATOR_URL,token=process.env.TEST_VIEWER_TOKEN;
 if(endpoint!=='https://127.0.0.1:28443'||!token?.startsWith('synthetic-'))throw new Error('isolated fixture configuration required');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-lost-upload-')),db=new DatabaseSync(path.join(root,'viewer.sqlite'));
 try{
  db.exec('PRAGMA foreign_keys=ON');applyMigrations(db);const processing=new ProcessingRepository(db);
  const credentials=new ProviderCredentials({activeKeyId:'fixture',keys:{fixture:crypto.randomBytes(32).toString('hex')}});credentials.resolve=()=>token;
  const observed=await new NodeOdmProvider({endpoint,token}).capabilities();
  assert.equal(observed.capabilities.ledgetopMaxUploadRequestBytes,131072);assert.equal(observed.capabilities.reservations?.version,1);
  const project=processing.createProject({displayName:'Synthetic'}),dataset=processing.createDataset({projectId:project.id,displayName:'Synthetic',storageMode:'managed',rootKey:'datasets',relativePath:'input'}),directory=path.join(root,'input');fs.mkdirSync(directory);
  const files=Array.from({length:3},(_,i)=>{const relativePath=`photo-${i}.jpg`,bytes=Buffer.alloc(30000,i);fs.writeFileSync(path.join(directory,relativePath),bytes);return{relativePath,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};});
  processing.finalizeDataset(dataset.id,files,crypto.createHash('sha256').update('fixture').digest('hex'));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Synthetic',endpoint,enabled:true,capabilities:observed.capabilities,capabilityFingerprint:observed.fingerprint});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Synthetic'}),attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  let uploads=0,callsAfterLoss=0,loss=false;
  const adapterFactory=(p,config,creds,capability)=>{const adapter=new NodeOdmProvider({endpoint:p.endpoint,token:creds.resolve(p.id),attemptCapability:capability});
   const upload=adapter.upload.bind(adapter),status=adapter.status.bind(adapter);adapter.status=async(...args)=>{if(loss)callsAfterLoss++;return status(...args);};
   adapter.upload=async(...args)=>{if(loss)callsAfterLoss++;uploads++;await upload(...args);loss=true;throw Object.assign(new Error('synthetic lost response'),{code:'ECONNRESET'});};return adapter;};
  const deps={processing,providerCredentials:credentials,storage:{resolve:(_key,relative)=>path.join(root,relative),requireProcessingHeadroom:()=>{}},config:{},adapterFactory};
  assert.equal(await processOne(deps,'fixture-worker'),true);assert.equal(uploads,1);
  const first=processing.getAttempt(attempt.id);assert.equal(first.submissionPhase,'uploading');
  const reservation=processing.getAttemptReservation(attempt.id),cap=credentials.openAttemptCapability(provider.id,attempt.id,attempt.providerTaskId,reservation);
  const upstream=await new NodeOdmProvider({endpoint,token,attemptCapability:cap}).status(attempt.providerTaskId);assert.ok(upstream.imagesCount>0);
  db.prepare("UPDATE processing_jobs SET available_at='2000' WHERE attempt_id=? AND job_type='submit'").run(attempt.id);
  assert.equal(await processOne(deps,'fixture-worker'),true);assert.equal(uploads,1);assert.equal(callsAfterLoss,0);
  assert.equal(processing.getAttempt(attempt.id).errorCode,'provider_upload_acceptance_unknown');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM processing_attempts WHERE task_id=?').get(task.id).n,1);
  console.log('PASS real accepted batch, simulated lost response, same-attempt hold without replay');
 }finally{db.close();fs.rmSync(root,{recursive:true,force:true});}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
