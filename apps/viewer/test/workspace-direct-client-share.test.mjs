import test from 'node:test';
import assert from 'node:assert/strict';
import { directClientAccess, directClientLabel, directClientsPath, directGrantRows, directScopeSummary, directShareDefaultScope, directShareErrorText, directShareForm, directShareReviewText, loadDirectClientAccess, readDirectShareForm, shareableTasks } from '../workspace-direct-client-share.mjs';

const clients=[{sourceId:'source-a',workspaceId:'ws-1',displayName:'Acme Construction',businessName:'Ledge Top'},{sourceId:'source-a',workspaceId:'ws-2',displayName:'Harbor Works',businessName:null}];
const tasks=[{id:'task-1',name:'North wall'},{id:'task-2',name:'South wall'}];
function form({client='',scope='project',checked=[],confirmed=true,later=true,expiresAt='',permissions={measure:true,cameras:true,download:false}}={}){
  const taskInputs=tasks.map(task=>({value:task.id,checked:checked.includes(task.id)}));
  return {elements:{client:{value:client},confirmedScope:{checked:confirmed},includeLater:{checked:later},expiresAt:{value:expiresAt},
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
  assert.throws(read({client:key,later:false}),/always includes models published later/);
  assert.equal(readDirectShareForm(form({client:key,scope:'tasks',checked:['task-1'],later:false}),{projectId:'project',projectName:'Site',tasks,clients}).bodies()[0].scopeType,'task');
  assert.throws(read({client:key,expiresAt:'2000-01-01T00:00'}),/future/);
});

test('client labels add the organisation and division to tell clients apart',()=>{
  assert.equal(directClientLabel(clients[0]),'Acme Construction (Ledge Top, ref ws-1)');
  assert.equal(directClientLabel(clients[1]),'Harbor Works (ref ws-2)');
  assert.equal(directClientLabel({...clients[0],organizationName:'Acme Group',rootType:'organization'}),'Acme Construction — Acme Group (Ledge Top, Organisation, ref ws-1)');
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
  // Opening Share asks for existing shares only: no client is listed before staff search.
  const access=await loadDirectClientAccess(async path=>{paths.push(path);return pages[paths.length-1]},'project');
  assert.deepEqual(access.grants.map(item=>item.grantId),['g-1','g-2','g-3']);assert.equal(access.grantsIncomplete,false);
  assert.match(paths[0],/include=grants/);assert.doesNotMatch(paths[0],/include=all/);assert.match(paths[1],/include=grants/);assert.match(paths[1],/grantsCursor=g-1/);assert.match(paths[2],/grantsCursor=g-2/);
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

test('Share project starts on the whole project but still requires an explicit choice for future publications',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  assert.match(html,/name="scope" value="project" checked/);
  assert.match(html,/name="includeLater" >/);assert.doesNotMatch(html,/name="includeLater" checked/);
  assert.match(html,/name="scope" value="tasks"  >/);
  assert.throws(()=>readDirectShareForm(form({client:key,later:false}),{projectId:'project',projectName:'Site',tasks,clients}).bodies(),/always includes models published later/);
  assert.doesNotMatch(html,/name="taskId"[^>]*(?:checked|disabled)/);
  for(const scope of ['tasks','',undefined,'unknown']){
    const selected=form({client:key,scope});
    if(scope===undefined)selected.querySelector=()=>null;
    assert.throws(()=>readDirectShareForm(selected,{projectId:'project',projectName:'Site',tasks,clients}).bodies(),/at least one task/);
  }
});

test('a project with no published tasks does not silently select future publications',()=>{
  const html=directShareForm({projectName:'Site',tasks:[],access:{clients,grants:[]}});
  assert.match(html,/value="project" checked>/);assert.doesNotMatch(html,/name="includeLater" checked/);
  assert.match(html,/value="tasks"  disabled/);
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

test('replacement overflow directs staff to the individual revoke controls, including for expired shares',async()=>{
  const grants=Array.from({length:101},(_,index)=>({
    grantId:`legacy-${index}`,viewerProjectId:'project',scopeType:'task',taskId:`legacy-task-${index}`,expiresAt:'2020-01-01T00:00:00Z',revokedAt:null,
  }));
  const message=directShareErrorText({code:'share_replacement_limit'});
  assert.match(message,/more than 100 shares/);
  assert.match(message,/Clients with access, revoke shares .* one at a time, then try again/);
  const access=await loadDirectClientAccess(async path=>new URLSearchParams(path.split('?')[1]).has('grantsCursor')
    ? {clients:[],grants:grants.slice(100),grantsNextCursor:null}
    : {clients:[],grants:grants.slice(0,100),grantsNextCursor:'legacy-99'},'project');
  const rows=directGrantRows(access,{projectId:'project',tasks:[]});
  assert.equal([...rows.matchAll(/data-action="revoke-direct-client-grant"/g)].length,101);
  assert.match(rows,/data-id="legacy-100">Revoke/);
});

test('new client shares start with measurements on and camera positions and downloads off',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  assert.match(html,/name="measure" checked/);
  assert.doesNotMatch(html,/name="cameras" checked/);assert.doesNotMatch(html,/name="download" checked/);
});

test('Share project opens on the whole project with later models unticked; a task Share opens on that task',()=>{
  assert.equal(directShareDefaultScope({taskId:null,tasks}),'project');
  assert.equal(directShareDefaultScope({taskId:'task-2',tasks}),'tasks');
  assert.equal(directShareDefaultScope({taskId:'gone',tasks}),'project');
  const project=directShareForm({projectName:'Site',tasks});
  assert.match(project,/name="scope" value="project" checked/);assert.match(project,/name="includeLater" >/);
  assert.match(project,/Also share models published later/);assert.match(project,/data-direct-review hidden/);assert.match(project,/Review share<\/button>/);
  const task=directShareForm({projectName:'Site',tasks,taskId:'task-2'});
  assert.match(task,/name="scope" value="tasks" checked/);assert.match(task,/name="includeLater" disabled>/);assert.match(task,/value="task-2" checked/);
});

test('the review step repeats who, what, permissions and expiry',()=>{
  const summary=directScopeSummary({clientName:'Acme',projectName:'Site',scope:'project',taskNames:[]});
  const text=directShareReviewText({summary,permissions:{measure:true,cameras:false,download:true},expiresAt:'2030-01-02T00:00:00.000Z',dateTime:()=>'Jan 2, 2030'});
  assert.match(text,/every published task in Site, including tasks published later/);assert.match(text,/They can view, measure and download\./);assert.match(text,/Access ends Jan 2, 2030\./);
  assert.match(directShareReviewText({summary,permissions:{measure:false,cameras:false,download:false},expiresAt:null}),/They can view\. Access does not expire until you revoke it\./);
});

test('the shared-with list shows each active grant with a revoke control, and never a revoked one',()=>{
  const grants=[{grantId:'g-1',viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Acme',expiresAt:null},
    {grantId:'g-2',viewerProjectId:'project',scopeType:'task',taskId:'task-1',revokedAt:'2026-01-01T00:00:00Z',clientDisplayName:'Gone',expiresAt:null}];
  const rows=directGrantRows({clients:[],grants},{projectId:'project',tasks});
  assert.match(rows,/Acme/);assert.match(rows,/data-action="revoke-direct-client-grant" data-id="g-1"/);assert.doesNotMatch(rows,/Gone/);
});
