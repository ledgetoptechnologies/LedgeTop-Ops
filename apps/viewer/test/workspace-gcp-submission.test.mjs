import {test} from 'node:test';
import assert from 'node:assert/strict';
import {submitOrPrepareGcpTask} from '../workspace-gcp-submission.mjs';
const common={submissionId:'00000000-0000-4000-8000-000000000001',projectId:'project',datasetId:'dataset',taskDisplayName:'Survey',providerId:'node',presetId:'preset',options:{quality:'high'},canWriteGcp:true};
test('recognized survey prepares draft with options and does not queue',async()=>{
 const calls=[];const api=async(path,init)=>{calls.push({path,init});return calls.length===1?{sets:[{id:'gcp'}]}:{task:{id:'task'}};};
 const result=await submitOrPrepareGcpTask({api,...common});
 assert.equal(result.pendingGcp,true);assert.equal(result.task.id,'task');assert.equal(calls[1].path,'/api/v1/tasks');assert.deepEqual(calls[1].init.body.processingSettings,{providerId:'node',presetId:'preset',options:{quality:'high'}});assert.equal(calls.length,2);
});
test('no recognized control submits normal task without changes',async()=>{
 const calls=[];const api=async(path,init)=>{calls.push({path,init});return calls.length===1?{sets:[]}:{task:{id:'task'}};};
 const result=await submitOrPrepareGcpTask({api,...common});assert.equal(result.pendingGcp,undefined);assert.equal(calls[1].path,'/api/v1/task-submissions');assert.equal(calls[1].init.body.taskDisplayName,'Survey');
});
test('failed or invalid discovery never silently queues',async()=>{
 const calls=[];await assert.rejects(submitOrPrepareGcpTask({api:async(path)=>{calls.push(path);return {};},...common}),/discovery/);assert.equal(calls.length,1);
});

test('permission boundary never silently queues an uncheckable CSV',async()=>{
 let calls=0;await assert.rejects(submitOrPrepareGcpTask({api:async()=>{calls++;return{};},...common,canReadGcp:false,hasCsv:true}),/access is required/);assert.equal(calls,0);
});
test('caller without GCP access retains ordinary no-CSV submission',async()=>{
 const calls=[];await submitOrPrepareGcpTask({api:async(path)=>{calls.push(path);return{task:{id:'x'}};},...common,canReadGcp:false,hasCsv:false});assert.deepEqual(calls,['/api/v1/task-submissions']);
});
