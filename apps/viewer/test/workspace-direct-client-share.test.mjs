import test from 'node:test';
import assert from 'node:assert/strict';
import { directClientAccess, directClientLabel, directClientsPath, directGrantRows, directScopeSummary, directShareErrorText, directShareForm, loadDirectClientAccess, readDirectShareForm, shareableTasks } from '../workspace-direct-client-share.mjs';

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

test('client labels add the organisation and division to tell clients apart',()=>{
  assert.equal(directClientLabel(clients[0]),'Acme Construction (Ledge Top)');
  assert.equal(directClientLabel(clients[1]),'Harbor Works');
  assert.equal(directClientLabel({...clients[0],organizationName:'Acme Group'}),'Acme Construction — Acme Group (Ledge Top)');
  assert.equal(directClientLabel({displayName:null}),'Client');
});

test('the client picker is searched and paged, never loaded all at once',()=>{
  const url=new URL(directClientsPath('project',{query:' acme ',cursor:'v1.next',include:'clients'}),'https://viewer.test');
  assert.equal(url.pathname,'/api/v1/workspace/direct-client-grants');
  assert.deepEqual(Object.fromEntries(url.searchParams),{viewerProjectId:'project',limit:'25',include:'clients',q:'acme',cursor:'v1.next'});
  assert.deepEqual(Object.fromEntries(new URL(directClientsPath('project'),'https://viewer.test').searchParams),{viewerProjectId:'project',limit:'25',include:'all'});
});

test('every page of existing shares is loaded, past 100',async()=>{
  const grant=index=>({grantId:`g-${index}`,viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null});
  const pages=[{clients,clientsNextCursor:null,grants:[grant(1)],grantsNextCursor:'g-1'},{clients:[],clientsNextCursor:null,grants:[grant(2)],grantsNextCursor:'g-2'},
    {clients:[],clientsNextCursor:null,grants:[grant(3)],grantsNextCursor:null}],paths=[];
  const access=await loadDirectClientAccess(async path=>{paths.push(path);return pages[paths.length-1]},'project');
  assert.deepEqual(access.grants.map(item=>item.grantId),['g-1','g-2','g-3']);assert.equal(access.grantsIncomplete,false);
  assert.match(paths[1],/include=grants/);assert.match(paths[1],/grantsCursor=g-1/);assert.match(paths[2],/grantsCursor=g-2/);
  assert.equal(access.clients,clients);
  const endless=await loadDirectClientAccess(async()=>({clients:[],grants:[grant(9)],grantsNextCursor:'again'}),'project');
  assert.equal(endless.grantsIncomplete,true);assert.match(directGrantRows(endless,{projectId:'project',tasks}),/Some shares could not be listed/);
  assert.equal(await loadDirectClientAccess(async()=>({clients:[]}),'project'),null);
});

test('a malformed response is treated as unavailable',()=>{
  assert.equal(directClientAccess(null),null);assert.equal(directClientAccess({clients:[]}),null);
  assert.ok(directClientAccess({clients:[],grants:[]}));
});

test('the form escapes names and preselects the task being shared',()=>{
  const html=directShareForm({projectName:'Site',tasks:[{id:'task-1',name:'<b>North</b>'}],taskId:'task-1'});
  assert.doesNotMatch(html,/<script>|<b>North/);
  assert.match(html,/value="tasks" checked/);assert.match(html,/value="task-1" checked/);
});

test('the client is chosen with a type-to-filter combobox: no Search button and no select',()=>{
  const html=directShareForm({projectName:'Site',tasks});
  assert.match(html,/role="combobox"[^>]*aria-controls="direct-client-picker-list"/);
  assert.match(html,/<input type="hidden" name="client" value="">/);
  assert.doesNotMatch(html,/search-direct-clients|more-direct-clients|<select name="client"/);
  // Choosing a client never shares by itself: confirmation is still required.
  assert.match(html,/name="confirmedScope" required/);
});

test('project sharing defaults to selected tasks and requires an explicit choice for future publications',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  assert.match(html,/name="scope" value="project">/);
  assert.match(html,/name="scope" value="tasks" checked/);
  assert.doesNotMatch(html,/name="taskId"[^>]*(?:checked|disabled)/);
  for(const scope of ['tasks','',undefined,'unknown']){
    const selected=form({client:key,scope});
    if(scope===undefined)selected.querySelector=()=>null;
    assert.throws(()=>readDirectShareForm(selected,{projectId:'project',projectName:'Site',tasks,clients}).bodies(),/at least one task/);
  }
});

test('a project with no published tasks does not silently select future publications',()=>{
  const html=directShareForm({projectName:'Site',tasks:[],access:{clients,grants:[]}});
  assert.match(html,/value="project">/);
  assert.match(html,/value="tasks" checked disabled/);
  assert.throws(()=>readDirectShareForm(form({client:key,scope:'tasks'}),{projectId:'project',projectName:'Site',tasks:[],clients}).bodies(),/at least one task/);
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

test('new client shares start with measurements on and camera positions and downloads off',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  assert.match(html,/name="measure" checked/);
  assert.doesNotMatch(html,/name="cameras" checked/);assert.doesNotMatch(html,/name="download" checked/);
});
