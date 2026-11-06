import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const raw=readFileSync(new URL('./fixtures/job-presentation-v1.json',import.meta.url));
const fixtures=JSON.parse(raw.toString('utf8'));
function harness(){
 const state={providers:[],presentationWitnesses:new Map()};
 const context=vm.createContext({state,Date,Number,Map,Object});
 for(const name of ['validPresentationTime','validJobPresentationV1','referencePresentationView','taskPresentationView','queueReasonText','taskOutputStage']){
  const declaration=source.split(/\r?\n/).find(line=>line.startsWith(`function ${name}(`));
  assert.ok(declaration,`missing ${name}`);
  vm.runInContext(declaration,context);
 }
 return{state,context};
}
function attemptFor(item){
 const job=item.job||{};
 return{id:job.attemptId||'22222222-2222-4222-8222-222222222222',status:job.status==='queued'?'queued_upstream':job.status||'running',
  errorCode:job.error||null,errorMessage:job.error||null,providerStatus:{upstreamPhase:job.phase,queueReason:job.queueReason,
   held:job.status==='held',presentation:job.presentation,presentationGeneration:job.generation,
   presentationUnavailable:item.reachable===false}};
}

test('Viewer consumes the exact shared cross-language v1 vectors',()=>{
 assert.equal(createHash('sha256').update(raw).digest('hex'),'1977eab229b0cabb71aef94f82b142c8360ccd932a3bca84634a8f91c0716f71');
 assert.equal(raw.includes(13),false,'fixture bytes are LF pinned');
 assert.equal(fixtures.cases.length,84);
 assert.deepEqual([...new Set(fixtures.cases.map(item=>item.group))].sort(),['attempt-generation','disconnected','malformed','precedence']);
 const {context}=harness();
 for(const item of fixtures.cases){
  const view=context.referencePresentationView(attemptFor(item),{reachable:item.reachable!==false,retained:item.retained||null});
  assert.equal(view.display,item.expected.display,item.name);
  assert.equal(view.confirmedAt,item.expected.confirmedAt,item.name);
 }
});

test('Reference v2 display does not infer live processing from logs and uses historical wording',()=>{
 const {state,context}=harness();
 state.providers=[{id:'reference-v2',capabilities:{detectionMethod:'pinned-reference-coordinator'}}];
 const attempt={id:'attempt',providerId:'reference-v2',status:'running',providerStatus:{upstreamPhase:'processing',presentationGeneration:4,
  presentation:{schemaVersion:1,protocol:'ltds-job-presentation-v1',state:'processing',processingConfirmedAt:'2026-11-05T10:00:01.000Z'}}};
 const label=context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]);
 assert.equal(label,'Processing was observed at 2026-11-05T10:00:01.000Z. Current activity is unknown.');
 attempt.providerStatus.presentation={schemaVersion:1,protocol:'ltds-job-presentation-v1',state:'preparing',processingConfirmedAt:null};
 assert.equal(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),'Preparing the processing engine.');
 attempt.providerStatus.presentationUnavailable=true;
 assert.match(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),/disconnected; status is unavailable/);
 assert.doesNotMatch(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),/Orthophoto/);
 attempt.providerStatus.queueReason='node_lost';
 assert.match(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),/disconnected; status is unavailable/);
});

test('previously validated witness is retained only for the same attempt and generation',()=>{
 const {context}=harness(),base={id:'attempt-a',status:'running',providerStatus:{upstreamPhase:'processing',presentationGeneration:7,
  presentation:{schemaVersion:1,protocol:'ltds-job-presentation-v1',state:'processing',processingConfirmedAt:'2026-11-05T10:00:01.000Z'}}};
 const retained={attemptId:'attempt-a',generation:7,processingConfirmedAt:'2026-11-05T10:00:01.000Z'};
 const missing={...base,providerStatus:{...base.providerStatus,presentation:null}};
 assert.equal(context.referencePresentationView(missing,{retained}).display,'processing_confirmed');
 assert.equal(context.referencePresentationView({...missing,id:'attempt-b'},{retained}).display,'status_unavailable');
 assert.equal(context.referencePresentationView({...missing,providerStatus:{...missing.providerStatus,presentationGeneration:8}},{retained}).display,'status_unavailable');
 assert.equal(context.referencePresentationView(missing,{reachable:false,retained}).display,'disconnected');
});

test('rendered coordinator disconnect clears the witness before a later missing projection',()=>{
 const {state,context}=harness();
 state.providers=[{id:'reference-v2',capabilities:{detectionMethod:'pinned-reference-coordinator'}}];
 const attempt={id:'attempt-a',providerId:'reference-v2',status:'running',providerStatus:{upstreamPhase:'processing',presentationGeneration:7,
  presentation:{schemaVersion:1,protocol:'ltds-job-presentation-v1',state:'processing',processingConfirmedAt:'2026-11-05T10:00:01.000Z'}}};
 assert.match(context.taskOutputStage(attempt,[]),/Processing was observed at 2026-11-05T10:00:01.000Z/);
 assert.equal(state.presentationWitnesses.size,1);
 attempt.providerStatus={...attempt.providerStatus,presentation:undefined,presentationUnavailable:true};
 assert.match(context.taskOutputStage(attempt,[]),/coordinator disconnected; status is unavailable/);
 assert.equal(state.presentationWitnesses.size,0,'rendered disconnect retires the historical witness');
 attempt.providerStatus={upstreamPhase:'processing',presentationGeneration:7};
 assert.match(context.taskOutputStage(attempt,[]),/Processing status unavailable/);
 assert.doesNotMatch(context.taskOutputStage(attempt,[]),/Processing was observed/);
});
