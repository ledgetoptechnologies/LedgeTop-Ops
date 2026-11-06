import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function fixture(api){
 const task={id:'task',datasetId:'dataset',latestAttempt:{id:'attempt',status:'running',progress:.42}};
 const state={token:'session',tasks:[task],taskDetails:{task:{attempt:task.latestAttempt,logs:[{message:'old tail'}]}},gcpWorkspaces:{},providers:[],expandedTaskId:null};
 const context=vm.createContext({state,api,ACTIVE:new Set(['running']),can:()=>true,esc:value=>String(value).replaceAll('<','&lt;'),refreshGcpWorkspace:async()=>{},content:{querySelector:()=>null},render:()=>{},CSS:{escape:x=>x}});
 for(const name of ['queueReasonText','taskOutputStage','logPanel'])vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith(`function ${name}(`)),context);
 vm.runInContext(source.slice(source.indexOf('const taskDetailRefreshes='),source.indexOf('async function refreshGcpWorkspace(')),context);
 return{state,context,task};
}
test('stage is derived only from recognized processing start markers, with honest fallback',()=>{
 const {context}=fixture();const stage=context.taskOutputStage;
 assert.equal(stage({status:'running'},[{message:'[INFO] Running odm_dem stage'}]),'Elevation models');
 assert.equal(stage({status:'running'},[{message:'Running opensfm'},{message:'Finished odm_dem'}]),'Camera reconstruction');
 assert.match(stage({status:'running'},[{message:'--rerun-from odm_dem'}]),/not reported/);
 assert.equal(stage({status:'ingesting'},[{message:'Running odm_dem'}]),'ingesting');
});
test('output displays bounded source progress and escaped text, and obeys read permission',()=>{
 const {context,state,task}=fixture();const html=context.logPanel(task,task.latestAttempt,[{message:'<script>bad</script>'}]);
 assert.match(html,/42% reported by processing node/);assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(context.logPanel(task,{id:'a',status:'running'},[]),/<progress/);
 state.taskDetails.task.logsError=true;assert.match(context.logPanel(task,task.latestAttempt,[]),/could not be refreshed/);
 context.can=()=>false;assert.equal(context.logPanel(task,task.latestAttempt,[]),'');
});

test('V2 upstream transfer and preparation phases stay queued and override stale engine logs',()=>{
 const {context,task}=fixture();
 for(const [phase,label] of [
  ['awaiting_transfer','Transferring inputs to the processing node.'],
  ['fetching','Transferring inputs to the processing node.'],
  ['source_receiving','Transferring inputs to the processing node.'],
  ['init_pending','Preparing the processing engine.'],
  ['initialized','Preparing the processing engine.'],
  ['upload_pending','Preparing the processing engine.'],
  ['uploaded','Preparing the processing engine.'],
  ['commit_pending','Preparing the processing engine.'],
 ]){
  const attempt={...task.latestAttempt,status:'queued_upstream',providerStatus:{upstreamPhase:phase,nodeId:'node-east-01'}};
  assert.equal(context.taskOutputStage(attempt,[{message:'Running odm_meshing'}]),label,phase);
  const html=context.logPanel(task,attempt,[{message:'Running odm_meshing'}]);
  assert.ok(html.includes(label),phase);
  assert.match(html,/Assigned processing node: node-east-01/);
  assert.doesNotMatch(html,/Building mesh/);
 }
});

test('V2 result handoff phases are reported explicitly rather than as queued node waits',()=>{
 const {context,task}=fixture();
 assert.equal(context.taskOutputStage({...task.latestAttempt,status:'running',providerStatus:{upstreamPhase:'waiting_for_delivery'}},[]),'Returning results to Viewer.');
 assert.equal(context.taskOutputStage({...task.latestAttempt,status:'running',providerStatus:{upstreamPhase:'awaiting_acceptance'}},[]),'Verifying processing results.');
});

test('Reference V2 processing does not infer an engine stage from old output before a start witness',()=>{
 const {context,state,task}=fixture();
 state.providers=[{id:'reference-v2',capabilities:{detectionMethod:'pinned-reference-coordinator'}}];
 const attempt={...task.latestAttempt,providerId:'reference-v2',status:'running',providerStatus:{upstreamPhase:'processing'}};
 assert.equal(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),'Preparing — engine start not confirmed');
 assert.equal(context.taskOutputStage(attempt,[{message:'Finished odm_dem'}]),'Preparing — engine start not confirmed');
});
test('legacy provider log-derived stage details remain unchanged',()=>{
 const {context,task}=fixture();
 const attempt={...task.latestAttempt,providerId:'legacy',status:'running',providerStatus:{upstreamPhase:'processing'}};
 assert.equal(context.taskOutputStage(attempt,[{message:'Running odm_orthophoto'}]),'Orthophoto');
 assert.equal(context.taskOutputStage(attempt,[{message:'Finished odm_dem'}]),'Processing — stage not reported in recent output');
});
test('queued upstream reason is humanized and takes precedence over stale processing logs',()=>{
 const {context,task}=fixture();
 const attempt={...task.latestAttempt,status:'queued_upstream',providerStatus:{queueState:'waiting_for_dispatch',queueReason:'waiting_node_capacity',nodeId:'node-east-01'}};
 const html=context.logPanel(task,attempt,[{message:'Running odm_meshing'}]);
 assert.match(html,/Waiting for an eligible processing node\./);
 assert.match(html,/Assigned processing node: node-east-01/);
 assert.doesNotMatch(html,/waiting_node_capacity/);
 assert.doesNotMatch(html,/Building mesh/);
});

test('unknown upstream queue reasons are not exposed as raw scheduler text',()=>{
 const {context,task}=fixture();
 const attempt={...task.latestAttempt,status:'queued_upstream',providerStatus:{queueReason:'raw-provider-error',queueMessage:'\\\\secret\\share'}};
 const html=context.logPanel(task,attempt,[]);
 assert.match(html,/Waiting for processing node/);
 assert.doesNotMatch(html,/raw-provider-error|secret|queueMessage/);
});
test('poll is single-flight and retains prior tail on transient failure',async()=>{
 let release,calls=0;const pending=new Promise(resolve=>release=resolve);
 const f=fixture(async path=>{calls++;if(path.includes('/attempts/attempt?'))throw Error('offline');if(path==='/api/v1/tasks/task')return pending;return{}});
 const first=f.context.refreshTaskDetails('task',true);await f.context.refreshTaskDetails('task',true);assert.equal(calls,5);
 release({task:f.task});await first;assert.equal(f.state.taskDetails.task.logs[0].message,'old tail');assert.equal(f.state.taskDetails.task.logsError,true);
});
test('new attempt is fetched before displaying logs, never paired with preceding tail',async()=>{
 const calls=[];const f=fixture(async path=>{calls.push(path);if(path==='/api/v1/tasks/task')return{task:{...f.task,latestAttempt:{id:'new',status:'running'}}};if(path.includes('/attempts/new?'))return{attempt:{id:'new',status:'running'},logs:[{message:'new output'}]};if(path.includes('/attempts/attempt?'))return{attempt:{id:'attempt'},logs:[{message:'wrong output'}]};return{}});
 await f.context.refreshTaskDetails('task',true);assert.equal(f.state.taskDetails.task.attempt.id,'new');assert.equal(f.state.taskDetails.task.logs[0].message,'new output');assert.ok(calls.some(path=>path.includes('/attempts/new?')));
});
test('authorization changes discard an in-flight poll',async()=>{
 let release;const pending=new Promise(resolve=>release=resolve);const f=fixture(async()=>pending);const previous=f.state.taskDetails.task;
 const run=f.context.refreshTaskDetails('task',true);f.state.token=null;release({});await run;assert.equal(f.state.taskDetails.task,previous);
});

test('quiet output refresh preserves scroll and focus without rebuilding the workspace',async()=>{
 const f=fixture(async path=>path==='/api/v1/tasks/task'?{task:f.task}:path.includes('/attempts/attempt?')?{attempt:f.task.latestAttempt,logs:[{message:'fresh'}]}:{});
 f.state.expandedTaskId='task';let replaced=false,focused=false;
 const oldTail={scrollTop:80,scrollHeight:900,clientHeight:200},newTail={scrollTop:0,scrollHeight:1000,focus:()=>focused=true};
 const replacement={querySelectorAll:()=>[],querySelector:()=>newTail};
 const panel={querySelector:()=>oldTail,replaceWith:()=>replaced=true};
 f.context.content={querySelector:()=>panel};f.context.document={activeElement:oldTail,createElement:()=>({firstElementChild:replacement})};
 f.context.render=()=>assert.fail('quiet poll must not rerender the whole workspace');
 await f.context.refreshTaskDetails('task',true);assert.equal(replaced,true);assert.equal(newTail.scrollTop,80);assert.equal(focused,true);
 oldTail.scrollTop=700;await f.context.refreshTaskDetails('task',true);assert.equal(newTail.scrollTop,1000,'tail follows new output only when already at end');
});
