import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {providerSubmissionState,selectSubmissionProvider} from '../server/providerSelection.mjs';
const require=createRequire(import.meta.url),express=require('express'),auth=require('../server/auth');
const {openDatabase}=require('../server/database'),{ViewerRepository}=require('../server/repository'),{ProcessingRepository}=require('../server/processingRepository'),{createProcessingApi}=require('../server/processingApi');
const now=Date.parse('2026-09-22T12:00:00Z'),options=['pc-ept','gltf','3d-tiles'].map(name=>({name,type:'bool'}));
const ready=(id='one')=>({id,enabled:true,capabilityFingerprint:'a'.repeat(64),capabilities:{options},lastHealth:'healthy',lastHealthAt:new Date(now).toISOString()});
test('selection keeps eligible choice, auto-selects sole eligible node, and never guesses among multiple',()=>{
  const a=ready(),b=ready('two'),disabled={...ready('disabled'),enabled:false},o={now};
  assert.equal(selectSubmissionProvider([a], '',o),'one');assert.equal(selectSubmissionProvider([a,b], '',o),'');assert.equal(selectSubmissionProvider([a,b],'two',o),'two');
  assert.equal(selectSubmissionProvider([a,disabled],'disabled',o),'one');assert.equal(selectSubmissionProvider([disabled],'disabled',o),'');assert.equal(selectSubmissionProvider([], '',o),'');
});
test('disabled, unknown, stale, unavailable, unsupported nodes cannot be selected; healthy busy nodes can queue',()=>{
  for(const [patch,reason]of [[{enabled:false},'provider_not_enabled'],[{lastHealthAt:null},'provider_health_required'],[{lastHealth:'unknown'},'provider_unavailable'],[{lastHealth:'unhealthy'},'provider_unavailable'],[{lastHealthAt:new Date(now-600001).toISOString()},'provider_health_stale'],[{capabilityFingerprint:null},'provider_capabilities_required'],[{capabilities:{options:[]}},'provider_missing_viewer_outputs']]){
    const result=providerSubmissionState({...ready(),...patch},{now});assert.equal(result.eligible,false);assert.equal(result.reason,reason);
  }
  const busy=providerSubmissionState({...ready(),activeAttempts:3,capabilities:{options,taskQueueCount:9}},{now});assert.equal(busy.eligible,true);assert.equal(busy.status,'busy');
});
test('freshest health observation wins: explicit recheck recovers old failure but new runtime failure blocks',()=>{
  const p={...ready(),runtimeHealth:'unhealthy',runtimeHealthAt:new Date(now-1000).toISOString()};assert.equal(providerSubmissionState(p,{now}).eligible,true);
  p.runtimeHealthAt=new Date(now).toISOString();assert.equal(providerSubmissionState(p,{now}).eligible,false);
  p.lastHealthAt=new Date(now+120000).toISOString();assert.equal(providerSubmissionState(p,{now}).reason,'provider_health_required');
});
test('actual submission API rejects offline and stale nodes without creating jobs, accepts a freshly rechecked busy node',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'provider-selection-')),database=openDatabase(path.join(dir,'test.sqlite')),processing=new ProcessingRepository(database),repository=new ViewerRepository(database);
  t.after(()=>{database.close();fs.rmSync(dir,{recursive:true,force:true});});
  const project=processing.createProject({displayName:'Fixture'}),dataset=processing.createDataset({projectId:project.id,displayName:'Images',storageMode:'managed',rootKey:'datasets',relativePath:'fixture'});
  processing.finalizeDataset(dataset.id,[{relativePath:'one.jpg',byteSize:0,sha256:'a'.repeat(64)}],'a'.repeat(64));
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture node',endpoint:'http://127.0.0.1:3000',enabled:true});
  processing.updateProviderCapabilities(provider.id,{capabilities:{options,taskQueueCount:3},fingerprint:'a'.repeat(64),health:'healthy'});
  const token='provider-selection-test-bearer-000000000000';processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:test',permissions:['viewer.processing.write'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  const app=express();app.use(express.json({verify:(req,_res,buffer)=>{req.rawBody=Buffer.from(buffer);}}));app.use(createProcessingApi({processing,repository,storage:{}}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>new Promise(resolve=>server.close(resolve)));
  async function submit(){return fetch(`http://127.0.0.1:${server.address().port}/api/v1/task-submissions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':crypto.randomUUID()},body:JSON.stringify({submissionId:crypto.randomUUID(),projectId:project.id,datasetId:dataset.id,taskDisplayName:'Test only',providerId:provider.id,options:{}})});}
  for(const [health,at,code]of [['unhealthy',new Date(Date.now()+10).toISOString(),'provider_unavailable'],['healthy','2020-01-01T00:00:00.000Z','provider_health_stale'],[null,null,'provider_health_required']]){
    database.prepare('UPDATE processing_providers SET runtime_health=?,runtime_health_at=?,last_health_at=? WHERE id=?').run(health,at,at,provider.id);
    const response=await submit();assert.equal(response.status,409);assert.equal((await response.json()).code,code);assert.equal(database.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get().n,0);
  }
  database.prepare('UPDATE processing_providers SET runtime_health_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',provider.id);
  processing.updateProviderCapabilities(provider.id,{capabilities:{options,taskQueueCount:3},fingerprint:'a'.repeat(64),health:'healthy'});
  const response=await submit();assert.equal(response.status,201);assert.equal(database.prepare('SELECT COUNT(*) AS n FROM processing_jobs').get().n,1,'only an internal fixture job is queued; no worker or provider runs');
});
