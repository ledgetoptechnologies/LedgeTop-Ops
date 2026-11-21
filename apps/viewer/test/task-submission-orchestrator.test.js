'use strict';
const assert=require('node:assert/strict');const crypto=require('node:crypto');const express=require('express');const fs=require('node:fs');const os=require('node:os');const path=require('node:path');const test=require('node:test');
const auth=require('../server/auth');const {openDatabase}=require('../server/database');const {ViewerRepository}=require('../server/repository');const {ProcessingRepository}=require('../server/processingRepository');const {createProcessingApi}=require('../server/processingApi');

async function fixture(t,providerTypes){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-orchestrator-')),database=openDatabase(path.join(root,'viewer.sqlite')),repository=new ViewerRepository(database),processing=new ProcessingRepository(database),token='orchestrator-test-token-0000000000000';
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:submitter',permissions:['viewer.processing.write','viewer.providers.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const project=processing.createProject({displayName:'Project'}),dataset=processing.createDataset({projectId:project.id,displayName:'Dataset',storageMode:'managed',rootKey:'datasets',relativePath:crypto.randomUUID()}),empty=crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(dataset.id,[{relativePath:'photo.jpg',byteSize:0,sha256:empty}],empty);
  const providers=providerTypes.map((type,index)=>{const provider=processing.upsertProvider({type,displayName:`${type} ${index}`,endpoint:`http://127.0.0.1:${3000+index}`,enabled:true});processing.updateProviderCapabilities(provider.id,{capabilities:{options:[{name:'pc-ept',type:'bool'},{name:'gltf',type:'bool'},{name:'3d-tiles',type:'bool'},{name:'boundary',type:'json'}]},fingerprint:'a'.repeat(64),health:'healthy'});return provider;});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({repository,processing,storage:{}}));
  const server=await new Promise(resolve=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
  const submit=(providerId,options={})=>{const submissionId=crypto.randomUUID();return fetch(`${base}/api/v1/task-submissions`,{method:'POST',headers:{...headers,'idempotency-key':`submit-${submissionId}`},body:JSON.stringify({submissionId,projectId:project.id,datasetId:dataset.id,taskDisplayName:'Flight',providerId,options})});};
  const list=async()=>(await fetch(`${base}/api/v1/processing/providers?limit=100`,{headers})).json();
  return{providers,submit,list};
}
const boundary=ring=>JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[ring]}}]});

test('new tasks are accepted only for the orchestrator the server binds and lists',async t=>{
  const f=await fixture(t,['nodeodm','clusterodm','nodeodm']),[worker,cluster]=f.providers;
  assert.equal((await f.list()).orchestratorProviderId,cluster.id);
  const rejected=await f.submit(worker.id);assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'provider_not_orchestrator');
  assert.equal((await f.submit(cluster.id)).status,201);
});

test('ambiguous deployments refuse new tasks until an orchestrator is configured',async t=>{
  const f=await fixture(t,['nodeodm','nodeodm']);
  assert.equal((await f.list()).orchestratorProviderId,null);
  const response=await f.submit(f.providers[0].id);assert.equal(response.status,409);assert.equal((await response.json()).code,'orchestrator_not_configured');
});

test('a single-node deployment keeps working and boundaries are validated at submission',async t=>{
  const f=await fixture(t,['nodeodm']),[only]=f.providers;
  const bad=await f.submit(only.id,{boundary:'{"type":"Polygon","coordinates":[]}'});assert.equal(bad.status,400);assert.equal((await bad.json()).code,'invalid_boundary');
  const crossing=await f.submit(only.id,{boundary:boundary([[0,0],[0.1,0.2],[0.1,0],[0,0.1],[0,0]])});assert.equal(crossing.status,400);
  const good=await f.submit(only.id,{boundary:boundary([[-90,45],[-89.999,45],[-89.999,45.001],[-90,45]])});assert.equal(good.status,201);
});
