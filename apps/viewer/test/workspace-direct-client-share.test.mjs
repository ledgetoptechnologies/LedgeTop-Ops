import test from 'node:test';
import assert from 'node:assert/strict';
import { directClientAccess, directClientLabel, directClientsPath, directGrantRows, directScopeSummary, directShareErrorText, directShareForm, readDirectShareForm, shareableTasks } from '../workspace-direct-client-share.mjs';

const clients=[{sourceId:'source-a',workspaceId:'ws-1',displayName:'Acme Construction',businessName:'Ledge Top'},{sourceId:'source-a',workspaceId:'ws-2',displayName:'Harbor Works',businessName:null}];
const tasks=[{id:'task-1',name:'North wall'},{id:'task-2',name:'South wall'}];
function form({client='',scope='project',checked=[],confirmed=true,expiresAt='',permissions={measure:true,cameras:true,download:false}}={}){
  const taskInputs=tasks.map(task=>({value:task.id,checked:checked.includes(task.id)}));
  return {elements:{client:{value:client},confirmedScope:{checked:confirmed},expiresAt:{value:expiresAt},
    measure:{checked:permissions.measure},cameras:{checked:permissions.cameras},download:{checked:permissions.download}},
    querySelector:selector=>selector==='input[name="scope"]:checked'?{value:scope}:null,
    querySelectorAll:selector=>selector==='input[name="taskId"]'?taskInputs:[]};
}
const key=JSON.stringify(['source-a','ws-1']);

test('only tasks with a live published model can be chosen one by one',()=>{
  const all=[{id:'a',projectId:'p',displayName:'Published'},{id:'b',projectId:'p',displayName:'Ready only'},{id:'c',projectId:'other',displayName:'Other project'}];
  const outputs=[{taskId:'a',activePublished:true,status:'published'},{taskId:'b',activePublished:false,status:'ready'},{taskId:'c',activePublished:true,status:'published'}];
  assert.deepEqual(shareableTasks('p',all,outputs),[{id:'a',name:'Published'}]);
});

test('the summary says who gets access and what stays hidden',()=>{
  assert.match(directScopeSummary({clientName:'',projectName:'Site',scope:'project',taskNames:[]}),/Choose a client/);
  assert.match(directScopeSummary({clientName:'Acme',projectName:'Site',scope:'project',taskNames:[]}),/every published task in Site, including tasks published later/);
  const one=directScopeSummary({clientName:'Acme',projectName:'Site',scope:'tasks',taskNames:['North wall']});
  assert.match(one,/only “North wall”/);assert.match(one,/Other tasks in Site stay hidden/);
});

test('whole-project access is one grant that includes tasks published later',()=>{
  const read=readDirectShareForm(form({client:key}),{projectId:'project',projectName:'Site',tasks,clients});
  assert.deepEqual(read.bodies(),[{sourceId:'source-a',workspaceId:'ws-1',viewerProjectId:'project',permissions:{measure:true,cameras:true,download:false},
    expiresAt:null,confirmedScope:true,taskId:null,scopeType:'project',includeFuturePublished:true}]);
});

test('chosen tasks become exact task grants that never include later tasks',()=>{
  const bodies=readDirectShareForm(form({client:key,scope:'tasks',checked:['task-2']}),{projectId:'project',projectName:'Site',tasks,clients}).bodies();
  assert.equal(bodies.length,1);
  assert.equal(bodies[0].taskId,'task-2');assert.equal(bodies[0].scopeType,'task');assert.equal(bodies[0].includeFuturePublished,false);
});

test('nothing is sent without a client, a task choice, confirmation or a future expiry',()=>{
  const read=options=>()=>readDirectShareForm(form(options),{projectId:'project',projectName:'Site',tasks,clients}).bodies();
  assert.throws(read({}),/Choose a client/);
  assert.throws(read({client:key,scope:'tasks'}),/at least one task/);
  assert.throws(read({client:key,confirmed:false}),/Confirm/);
  assert.throws(read({client:key,expiresAt:'2000-01-01T00:00'}),/future/);
});

test('client labels use the business name only to tell clients apart',()=>{
  assert.equal(directClientLabel(clients[0]),'Acme Construction — Ledge Top');
  assert.equal(directClientLabel(clients[1]),'Harbor Works');
  assert.equal(directClientLabel({displayName:null}),'Client');
});

test('the client picker is searched and paged, never loaded all at once',()=>{
  const url=new URL(directClientsPath('project',{query:' acme ',cursor:'next'}),'https://viewer.test');
  assert.equal(url.pathname,'/api/v1/workspace/direct-client-grants');
  assert.deepEqual(Object.fromEntries(url.searchParams),{viewerProjectId:'project',limit:'25',q:'acme',cursor:'next'});
});

test('a malformed response is treated as unavailable',()=>{
  assert.equal(directClientAccess(null),null);assert.equal(directClientAccess({clients:[]}),null);
  assert.ok(directClientAccess({clients:[],grants:[]}));
});

test('the form escapes names and preselects the task being shared',()=>{
  const html=directShareForm({projectName:'Site',tasks:[{id:'task-1',name:'<b>North</b>'}],access:{clients:[{...clients[0],displayName:'<script>'}],grants:[]},taskId:'task-1'});
  assert.doesNotMatch(html,/<script>|<b>North/);
  assert.match(html,/value="tasks" checked/);assert.match(html,/value="task-1" checked/);
});

test('the access list shows active grants for this project, with whole-project grants on every task',()=>{
  const access={clients,grants:[
    {grantId:'g-project',viewerProjectId:'project',scopeType:'project',taskId:null,clientDisplayName:'Acme',expiresAt:null,revokedAt:null},
    {grantId:'g-task',viewerProjectId:'project',scopeType:'task',taskId:'task-2',clientDisplayName:null,expiresAt:null,revokedAt:null},
    {grantId:'g-revoked',viewerProjectId:'project',scopeType:'task',taskId:'task-1',clientDisplayName:'Gone',revokedAt:'2026-10-01T00:00:00Z'},
    {grantId:'g-other',viewerProjectId:'other',scopeType:'project',taskId:null,clientDisplayName:'Elsewhere',revokedAt:null}]};
  const forTask=directGrantRows(access,{projectId:'project',tasks,taskId:'task-1'});
  assert.match(forTask,/g-project/);assert.doesNotMatch(forTask,/g-task|g-revoked|g-other/);
  const all=directGrantRows(access,{projectId:'project',tasks});
  assert.match(all,/Task: South wall/);assert.match(all,/<strong>Client<\/strong>/);
});

test('server codes become plain explanations',()=>{
  assert.match(directShareErrorText({code:'relationship_missing',message:'x'}),/not connected/);
  assert.equal(directShareErrorText({message:'Request failed (503)'}),'Request failed (503)');
});
