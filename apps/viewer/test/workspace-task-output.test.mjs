import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function fixture(api){
 const task={id:'task',datasetId:'dataset',latestAttempt:{id:'attempt',status:'running',progress:.42}};
 const state={token:'session',tasks:[task],taskDetails:{task:{attempt:task.latestAttempt,logs:[{message:'old tail'}]}},expandedTaskId:null};
 const context=vm.createContext({state,api,ACTIVE:new Set(['running']),LIVE_ATTEMPT_STATUSES:new Set(['pending','admitted','initializing','uploading','committed','queued_upstream','running','ingesting','derivatives']),can:()=>true,esc:value=>String(value).replaceAll('<','&lt;'),refreshGcpWorkspace:async()=>{},content:{querySelector:()=>null},render:()=>{},CSS:{escape:x=>x},projectDataGeneration:0});
 for(const name of ['taskOutputStage','logPanel'])vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith(`function ${name}(`)),context);
 vm.runInContext(source.slice(source.indexOf('function patchTaskOutput('),source.indexOf('function patchSelectedTaskDetail(')),context);
 vm.runInContext(source.slice(source.indexOf('const taskDetailRefreshes='),source.indexOf('async function refreshGcpWorkspace(')),context);
 return{state,context,task};
}
test('stage is derived only from recognized processing start markers, with honest fallback',()=>{
 const {context}=fixture();const stage=context.taskOutputStage;
 assert.equal(stage({status:'running'},[{message:'[INFO] Running odm_dem stage'}]),'Elevation models');
 assert.equal(stage({status:'running'},[{message:'Running opensfm'},{message:'Finished odm_dem'}]),'Camera reconstruction');
 assert.match(stage({status:'running'},[{message:'--rerun-from odm_dem'}]),/not reported/);
 assert.equal(stage({status:'ingesting'},[{message:'Running odm_dem'}]),'Viewer is ingesting completed results');
});
test('output displays bounded source progress and escaped text, and obeys read permission',()=>{
 const {context,state,task}=fixture();const html=context.logPanel(task,task.latestAttempt,[{message:'<script>bad</script>'}]);
 assert.match(html,/42% reported by processing node/);assert.match(html,/&lt;script>/);assert.doesNotMatch(html,/<script>/);
 assert.doesNotMatch(context.logPanel(task,{id:'a',status:'running'},[]),/<progress/);
 state.taskDetails.task.logsError=true;assert.match(context.logPanel(task,task.latestAttempt,[]),/could not be refreshed/);
 context.can=()=>false;assert.equal(context.logPanel(task,task.latestAttempt,[]),'');
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
 let polls=0;const f=fixture(async path=>path==='/api/v1/tasks/task'?{task:f.task}:path.includes('/attempts/attempt?')?{attempt:f.task.latestAttempt,logs:[{message:`fresh ${++polls}`}]}:{});
 f.state.expandedTaskId='task';let folderPatches=0;
 // The panel is patched in place (never replaced), so the focused element and its scroll position survive.
 const node=html=>html==null?null:{innerHTML:html,childNodes:[html],textContent:html,replaceChildren(...nodes){this.innerHTML=nodes.join('')}};
 const parsed=html=>{const pick=re=>html.match(re)?.[1]??null,parts={'.subsection-heading p':node(pick(/<h3>Task output<\/h3><p>([\s\S]*?)<\/p>/)),'.task-output-status':node(pick(/<div class="task-output-status" role="status">([\s\S]*?)<\/div>/)),'.form-note':node(pick(/<p class="form-note"[^>]*>([\s\S]*?)<\/p>/)),'.log-tail':node(pick(/<pre class="log-tail"[^>]*>([\s\S]*?)<\/pre>/))};return html?{querySelector:selector=>parts[selector]}:null};
 const heading=node('old heading'),status=node('old status'),tail={textContent:'old tail',scrollTop:80,scrollHeight:900,clientHeight:200,before:()=>assert.fail('no error note expected')};
 const panel={querySelector:selector=>({'.subsection-heading p':heading,'.task-output-status':status,'.form-note':null,'.log-tail':tail})[selector],replaceWith:()=>assert.fail('quiet poll must not replace the output panel')};
 f.context.content={querySelector:()=>panel};
 f.context.document={activeElement:tail,createElement:tag=>{assert.equal(tag,'template');const template={content:{firstElementChild:null}};Object.defineProperty(template,'innerHTML',{set:html=>template.content.firstElementChild=parsed(html)});return template}};
 f.context.patchProjectTree=()=>{folderPatches++;return false};
 f.context.render=()=>assert.fail('quiet poll must not rerender the whole workspace');
 await f.context.refreshTaskDetails('task',true);
 assert.match(tail.textContent,/fresh 1$/);assert.match(status.innerHTML,/42% reported by processing node/);assert.match(heading.innerHTML,/Latest 100 recorded lines/);
 assert.equal(tail.scrollTop,80);assert.equal(f.context.document.activeElement,tail);assert.equal(folderPatches,1);
 tail.scrollTop=700;await f.context.refreshTaskDetails('task',true);
 assert.match(tail.textContent,/fresh 2$/);assert.equal(tail.scrollTop,900,'tail follows new output only when already at end');assert.equal(f.context.document.activeElement,tail);
});
