import test from 'node:test';
import assert from 'node:assert/strict';
import { directClientReviewName, SHARE_TARGET_MISSING, directClientAccess, directClientLabel, directClientsPath, directGrantRows, directScopeSummary, directShareDefaultScope, directShareErrorText, directShareForm, directShareReviewMarkup, loadDirectClientAccess, readDirectShareForm, shareableTasks } from '../workspace-direct-client-share.mjs';
import { directProjectShareEditForm, editableDirectProjectGrant, publicationFolderPath, publishAudience, readDirectProjectShareEdit, syncDirectProjectSelection } from '../workspace-direct-client-share.mjs';

const clients=[{sourceId:'source-a',workspaceId:'ws-1',displayName:'Acme Construction',businessName:'Ledge Top'},{sourceId:'source-a',workspaceId:'ws-2',displayName:'Harbor Works',businessName:null}];
const tasks=[{id:'task-1',name:'North wall'},{id:'task-2',name:'South wall'}];
function form({client='',scope='project',checked=[],later=true,expiresAt='',permissions={measure:true,cameras:true,download:false},notify}={}){
  const taskInputs=tasks.map(task=>({value:task.id,checked:checked.includes(task.id)}));
  return {elements:{client:{value:client},includeLater:{checked:later},expiresAt:{value:expiresAt},
    measure:{checked:permissions.measure},cameras:{checked:permissions.cameras},download:{checked:permissions.download},
    ...(notify===undefined?{}:{notifyClient:{checked:notify}})},
    querySelector:selector=>selector==='input[name="scope"]:checked'?{value:scope}:null,
    querySelectorAll:selector=>selector==='input[name="taskId"]'?taskInputs:[]};
}
const key=JSON.stringify(['source-a','ws-1']);

test('first project Share and saved-share editing use the same short titles without project form notes',()=>{
  const catalog={folders:[{id:'folder',displayName:'North'}],tasks};
  const html=directShareForm({projectName:'Site',tasks,selectionCatalog:catalog});
  const options=[...html.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match=>match.slice(1));
  assert.deepEqual(options,[['whole','Everything'],['except','All except'],['only','Only']]);
  assert.match(html,/<label><span>What this client can see<\/span><select name="mode">/);
  assert.match(html,/<option value="whole" selected>Everything<\/option>/);
  assert.doesNotMatch(html,/data-direct-mode-wording|Everything except unticked folders and tasks|Only ticked folders and tasks/);
  const saved=directProjectShareEditForm({grant:{clientDisplayName:'Acme'},...catalog});
  assert.deepEqual([...saved.matchAll(/<option value="([^"]+)"[^>]*>([^<]+)<\/option>/g)].map(match=>match.slice(1)),options);
  for(const markup of [html,saved])assert.doesNotMatch(markup,/A folder includes its subfolders|class="form-note">No (folders|tasks)\./);
  assert.doesNotMatch(saved,/unticked/);
});

test('first-share existing tree heading explains tick direction for each short title',()=>{
  const legend={textContent:''},catalog={folders:[],tasks:[]};
  const input={querySelector:selector=>selector==='[data-direct-share-targets] legend'?legend:null,querySelectorAll:()=>[]};
  for(const [mode,heading] of [['only','Tick folders and tasks to include'],['except','Untick folders and tasks to exclude']]){
    syncDirectProjectSelection(input,mode,catalog);
    assert.equal(legend.textContent,heading);
  }
});

test('first Except share sends only unticked targets as exclusions; Only sends ticked targets',()=>{
  const catalog={folders:[{id:'folder',displayName:'North'}],tasks};
  for(const mode of ['only','except']){
    const input=form({client:key});input.elements.mode={value:mode};
    const original=input.querySelectorAll;
    input.querySelectorAll=selector=>selector===`input[name="folder"]${mode==='except'?':not(:checked)':':checked'}`
      ?[{value:'folder',hasAttribute:()=>false}]:original(selector);
    const body=readDirectShareForm(input,{projectId:'project',projectName:'Site',tasks,clients,entry:'project',selectionCatalog:catalog}).bodies()[0];
    assert.deepEqual(body.selection,{version:1,mode,folderIds:['folder'],taskIds:[]});
  }
});

for(const mode of ['only','except'])test(`first-share ${mode} derives deep inheritance and preserves intentional task choices`,()=>{
  const catalog={folders:[{id:'root',parentId:null,displayName:'Root'},{id:'child',parentId:'root',displayName:'Child'},
    {id:'leaf',parentId:'child',displayName:'Leaf'}],tasks:[{id:'nested',folderId:'leaf',name:'Nested'},{id:'loose',folderId:null,name:'Loose'}]};
  const selected=mode==='only',input=form({client:key});input.elements.mode={value:mode};
  const controls={folder:catalog.folders,task:catalog.tasks};
  for(const name of Object.keys(controls))controls[name]=controls[name].map(item=>({value:item.id,checked:!selected,disabled:true,hasAttribute:()=>false}));
  input.querySelectorAll=selector=>{
    const match=/^input\[name="(folder|task)"\](.*)$/.exec(selector);
    return match?controls[match[1]].filter(item=>match[2]===':checked'?item.checked:match[2]===':not(:checked)'?!item.checked:true):[];
  };
  const sync=()=>syncDirectProjectSelection(input,mode,catalog);
  sync();controls.task[0].checked=selected;sync();
  controls.folder[0].checked=selected;sync();
  for(const control of [...controls.folder.slice(1),controls.task[0]]){
    assert.equal(control.checked,selected);assert.equal(control.disabled,true);assert.match(control.title,/Inherited from Root/);
  }
  const context={projectId:'project',projectName:'Site',tasks,clients,entry:'project',selectionCatalog:catalog};
  const read=()=>readDirectShareForm(input,context);
  assert.deepEqual(read().bodies()[0].selection,{version:1,mode,folderIds:['root'],taskIds:[]});
  // Even if a caller changes disabled and checked without a change event, descendants do not become explicit.
  controls.folder[1].checked=!selected;controls.folder[1].disabled=false;
  controls.task[0].checked=!selected;controls.task[0].disabled=false;
  assert.deepEqual(read().bodies()[0].selection,{version:1,mode,folderIds:['root'],taskIds:[]});
  controls.folder[0].checked=!selected;sync();
  assert.equal(controls.task[0].checked,selected);assert.equal(controls.task[0].disabled,false);
  assert.equal(controls.folder[1].checked,!selected);assert.equal(controls.folder[1].disabled,false);
  assert.deepEqual(read().bodies()[0].selection,{version:1,mode,folderIds:[],taskIds:['nested']});
});

test('only tasks with a live published model can be chosen one by one',()=>{
  const all=[{id:'a',projectId:'p',displayName:'Published'},{id:'b',projectId:'p',displayName:'Ready only'},{id:'c',projectId:'other',displayName:'Other project'}];
  const outputs=[{taskId:'a',activePublished:true,status:'published'},{taskId:'b',activePublished:false,status:'ready'},{taskId:'c',activePublished:true,status:'published'}];
  assert.deepEqual(shareableTasks('p',all,outputs),[{id:'a',name:'Published'}]);
});

test('the summary says who gets access and what stays hidden',()=>{
  assert.equal(directScopeSummary({clientName:'',projectName:'Site',scope:'project',taskNames:[]}),'');
  assert.match(directScopeSummary({clientName:'Acme',projectName:'Site',scope:'project',taskNames:[]}),/every published task in Site, including tasks published later/);
  const one=directScopeSummary({clientName:'Acme',projectName:'Site',scope:'tasks',taskNames:['North wall']});
  assert.match(one,/only “North wall”/);assert.match(one,/Other tasks in Site stay hidden/);
});

test('whole-project access is one grant that includes tasks published later',()=>{
  const read=readDirectShareForm(form({client:key}),{projectId:'project',projectName:'Site',tasks,clients});
  assert.equal(read.bodies()[0].confirmedScope,false,'only the Share click on the review confirms');
  assert.deepEqual(read.bodies({confirmed:true}),[{sourceId:'source-a',workspaceId:'ws-1',viewerProjectId:'project',permissions:{measure:true,cameras:true,download:false},
    expiresAt:null,confirmedScope:true,taskId:null,scopeType:'project',includeFuturePublished:true}]);
});

test('chosen tasks become exact task grants that never include later tasks',()=>{
  const bodies=readDirectShareForm(form({client:key,scope:'tasks',checked:['task-2']}),{projectId:'project',projectName:'Site',tasks,clients}).bodies();
  assert.equal(bodies.length,1);
  assert.equal(bodies[0].taskId,'task-2');assert.equal(bodies[0].scopeType,'task');assert.equal(bodies[0].includeFuturePublished,false);
});

test('nothing is sent without a client, a task choice or a future expiry',()=>{
  const read=options=>()=>readDirectShareForm(form(options),{projectId:'project',projectName:'Site',tasks,clients}).bodies();
  assert.throws(read({}),/Choose a client/);
  assert.throws(read({client:key,scope:'tasks'}),/at least one task/);
  assert.throws(read({client:key,later:false}),/always includes models published later/);
  assert.equal(readDirectShareForm(form({client:key,scope:'tasks',checked:['task-1'],later:false}),{projectId:'project',projectName:'Site',tasks,clients}).bodies()[0].scopeType,'task');
  assert.throws(read({client:key,expiresAt:'2000-01-01T00:00'}),/future/);
});

test('a client is its name; the one picked among same-named clients keeps its word',()=>{
  assert.equal(directClientLabel(clients[0]),'Acme Construction');
  assert.equal(directClientLabel({...clients[0],pickerLabel:'Acme Construction (Drone Services)'}),'Acme Construction (Drone Services)');
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
  // Choosing a client never shares by itself: the review is still required. No confirmation box or help text.
  assert.match(html,/data-direct-review hidden/);assert.doesNotMatch(html,/confirmedScope|I confirm|Authorized members|Choose a client/);
});

test('Share project starts on the whole project with models published later, which can be unticked',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  assert.match(html,/name="scope" value="project" checked/);
  assert.match(html,/name="includeLater" checked>/);
  assert.match(html,/name="scope" value="tasks"  >/);
  assert.throws(()=>readDirectShareForm(form({client:key,later:false}),{projectId:'project',projectName:'Site',tasks,clients}).bodies(),/always includes models published later/);
  assert.doesNotMatch(html,/name="taskId"[^>]*(?:checked|disabled)/);
  for(const scope of ['tasks','',undefined,'unknown']){
    const selected=form({client:key,scope});
    if(scope===undefined)selected.querySelector=()=>null;
    assert.throws(()=>readDirectShareForm(selected,{projectId:'project',projectName:'Site',tasks,clients}).bodies(),/at least one task/);
  }
});

test('a project with no published tasks shares only as a whole project',()=>{
  const html=directShareForm({projectName:'Site',tasks:[],access:{clients,grants:[]}});
  assert.match(html,/value="project" checked>/);assert.match(html,/name="includeLater" checked>/);
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

test('saved project selections display what they include or exclude',()=>{
  const folders=[{id:'folder',displayName:'Model drafts'}];
  const grant={grantId:'selected',sourceId:'source-a',workspaceId:'ws-1',viewerProjectId:'project',scopeType:'project'};
  const markup=(mode)=>directGrantRows({grants:[{...grant,selection:{version:1,mode,folderIds:['folder'],taskIds:['task-1']}}]},
    {projectId:'project',tasks,folders});
  assert.match(markup('only'),/Only “Model drafts”, “North wall”/);
  assert.match(markup('except'),/Whole project except “Model drafts”, “North wall”/);
});

test('publication warnings follow the current complete folder path and report unavailable ancestry',()=>{
  const scope={projectId:'project',taskId:'task-1'};
  const folders=[{id:'root',projectId:'project',parentId:null},{id:'child',projectId:'project',parentId:'root'}];
  const task={id:'task-1',projectId:'project',folderId:'child'};
  const grant={grantId:'selected',sourceId:'source-a',workspaceId:'ws-1',viewerProjectId:'project',scopeType:'project'};
  const client={key, name:'a client', id:'ws-1'};
  const audience=(mode,folderPath)=>publishAudience({grants:[{...grant,selection:{version:1,mode,folderIds:['root'],taskIds:[]}}]},
    {...scope,folderPath});
  const path=publicationFolderPath(task,folders,scope);
  assert.deepEqual(path,['child','root']);
  assert.deepEqual(audience('only',path),{clients:[client],complete:true});
  assert.deepEqual(audience('except',path),{clients:[],complete:true});
  const moved=publicationFolderPath({...task,folderId:null},folders,scope);
  assert.deepEqual(audience('only',moved),{clients:[],complete:true});
  assert.deepEqual(audience('except',moved),{clients:[client],complete:true});
  const incomplete=publicationFolderPath(task,folders.slice(1),scope);
  assert.equal(incomplete,null);
  assert.deepEqual(audience('except',incomplete),{clients:[],complete:false});
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

test('new client shares start with everything on and no end date',()=>{
  const html=directShareForm({projectName:'Site',tasks,access:{clients,grants:[]}});
  for(const name of ['measure','cameras','download'])assert.match(html,new RegExp(`name="${name}" checked`));
  assert.match(html,/name="expiresAt" type="datetime-local">/);
});

test('Share project opens on the whole project with later models ticked; a task Share opens on that task',()=>{
  assert.equal(directShareDefaultScope({taskId:null}),'project');
  assert.equal(directShareDefaultScope({taskId:'task-2'}),'tasks');
  assert.equal(directShareDefaultScope({entry:'task',taskId:null}),'tasks');
  const project=directShareForm({projectName:'Site',tasks});
  assert.match(project,/name="scope" value="project" checked/);assert.match(project,/name="includeLater" checked>/);
  assert.match(project,/Also share models published later/);assert.match(project,/data-direct-review hidden/);assert.match(project,/Review share<\/button>/);
  const task=directShareForm({projectName:'Site',tasks,taskId:'task-2'});
  assert.match(task,/name="scope" value="tasks" checked/);assert.match(task,/name="includeLater" disabled>/);assert.match(task,/value="task-2" checked/);
});

test('a Share opened from a task that is not published never starts on the whole project',()=>{
  for(const list of [tasks,[]]){
    const html=directShareForm({projectName:'Site',tasks:list,taskId:'draft',taskName:'<b>East</b> wall'});
    assert.match(html,/name="scope" value="tasks" checked >/);assert.doesNotMatch(html,/value="project" checked/);
    assert.match(html,/name="includeLater" disabled>/);assert.doesNotMatch(html,/name="taskId"[^>]*checked/);
    assert.match(html,/“&lt;b&gt;East&lt;\/b&gt; wall” is not published yet/);
    assert.throws(()=>readDirectShareForm(form({client:key,scope:'tasks'}),{projectId:'project',projectName:'Site',tasks:list,clients}).bodies(),/at least one task/);
  }
  assert.doesNotMatch(directShareForm({projectName:'Site',tasks,taskId:'task-1',taskName:'North wall'}),/not published yet/);
  assert.doesNotMatch(directShareForm({projectName:'Site',tasks}),/not published yet/);
});

test('a Share whose task has gone offers no form at all',()=>{
  const html=directShareForm({projectName:'Site',tasks,entry:'task',taskId:'task-1',taskName:'North wall',targetMissing:true});
  assert.match(html,/role="alert"/);assert.ok(html.includes(SHARE_TARGET_MISSING));assert.doesNotMatch(html,/<form|<input|<button/);
});

test('the shared-with list says what a client can do and shows an expired share as expired',()=>{
  const now=Date.parse('2026-06-01T00:00:00Z'),base={viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Acme'};
  const rows=grant=>directGrantRows({clients:[],grants:[{grantId:'g',...base,...grant}]},{projectId:'project',tasks,now});
  const live=rows({expiresAt:'2026-06-02T00:00:00Z',permissions:{measure:true,cameras:false,download:true}});
  assert.match(live,/Can view, measure and download · Expires 2026-06-02T00:00:00Z/);assert.doesNotMatch(live,/active</);
  const over=rows({expiresAt:'2026-06-01T00:00:00Z',permissions:{measure:false,cameras:true,download:false}});
  assert.match(over,/Can view and see camera positions · Expired 2026-06-01T00:00:00Z; revoke it to share this again/);
  assert.match(over,/status expired">expired</);assert.match(over,/data-action="revoke-direct-client-grant"/);
  assert.match(rows({expiresAt:null,permissions:{measure:false,cameras:false,download:false}}),/Can view · No end date/);
});

test('the review step repeats who, what, permissions and expiry',()=>{
  const client={...clients[0],displayName:'<b>Acme</b>',businessName:'Ledge Top Drone Services Project Alpha'};
  const read=readDirectShareForm(form({client:key}),{projectId:'project',projectName:'Site',tasks,clients:[{...client,organizationName:'Acme Group',workspaceId:'ws-1'}]});
  const text=directShareReviewMarkup({client:read.client,what:read.what,permissions:{measure:true,cameras:false,download:true},expiresAt:'2030-01-02T00:00:00.000Z',dateTime:()=>'Jan 2, 2030'});
  assert.equal(text,'<dt>Client</dt><dd>&lt;b&gt;Acme&lt;/b&gt; (Drone Services, Acme Group)<small class="direct-share-reference">Workspace ws-1</small></dd><dt>Who</dt><dd>Authorized members of &lt;b&gt;Acme&lt;/b&gt; (Drone Services, Acme Group)’s portal account</dd><dt>Shared</dt><dd>Whole project Site. Published when this opened: “North wall”, “South wall”, and later ones</dd><dt>Can</dt><dd>View, measure and download</dd><dt>Ends</dt><dd>Jan 2, 2030</dd>');
  const task=readDirectShareForm(form({client:key,scope:'tasks',checked:['task-1']}),{projectId:'project',projectName:'Site',tasks,clients});
  assert.match(directShareReviewMarkup({client:task.client,what:task.what,permissions:{},expiresAt:null}),/Task “North wall”.*No end date/);
});

test('the shared-with list shows each active grant with a revoke control, and never a revoked one',()=>{
  const grants=[{grantId:'g-1',viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Acme',expiresAt:null},
    {grantId:'g-2',viewerProjectId:'project',scopeType:'task',taskId:'task-1',revokedAt:'2026-01-01T00:00:00Z',clientDisplayName:'Gone',expiresAt:null}];
  const rows=directGrantRows({clients:[],grants},{projectId:'project',tasks});
  assert.match(rows,/Acme/);assert.match(rows,/data-action="revoke-direct-client-grant" data-id="g-1"/);assert.doesNotMatch(rows,/Gone/);
});

test('same-named clients with access are told apart by business, and never by name alone',async()=>{
  const grant=(id,sourceId,workspaceId)=>({grantId:id,sourceId,workspaceId,viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Pat Example',expiresAt:null});
  const found=[{sourceId:'a',workspaceId:'w-1',displayName:'Pat Example',businessName:'Ledge Top Drone Services Project Alpha'},{sourceId:'b',workspaceId:'w-2',displayName:'Pat Example',businessName:'Ledge Top Technologies Project Alpha'}];
  const api=async path=>/include=clients/.test(path)?{clients:found,grants:[]}:{clients:[],grants:[grant('g-1','a','w-1'),grant('g-2','b','w-2')]};
  const rows=directGrantRows(await loadDirectClientAccess(api,'project'),{projectId:'project',tasks});
  assert.match(rows,/Pat Example <span[^>]*>Drone Services<.*g-1.*Pat Example <span[^>]*>Technologies<.*g-2/s);assert.doesNotMatch(rows,/ref |Project Alpha/);
  const single=directGrantRows({grants:[grant('g-1','a','w-1'),{...grant('g-3','a','w-1'),scopeType:'task',taskId:'task-1'}]},{projectId:'project',tasks});
  assert.doesNotMatch(single,/client-picker-meta/,'one client with two shares needs no word');
});

test('a chosen task that can no longer be shared refuses the whole share and is named',()=>{
  const context={projectId:'project',projectName:'Site',tasks:[tasks[0]],clients,known:tasks};
  const picked=form({client:key,scope:'tasks',checked:['task-1','task-2']});
  assert.throws(()=>readDirectShareForm(picked,context).bodies({confirmed:true}),/“South wall” can no longer be shared. Nothing was sent/);
  assert.throws(()=>readDirectShareForm(picked,{...context,known:[]}).bodies(),/A chosen task can no longer be shared/);
  assert.match(readDirectShareForm(form({client:key}),{...context,fresh:true}).what,/Published now: “North wall”, and later ones/);
});

test('every new share has an Email client box, ticked by default, that the share follows',()=>{
  const markup=directShareForm({projectName:'Site',tasks,notifyClient:true});
  assert.match(markup,/<label class="check"><input type="checkbox" name="notifyClient" checked> Email client<\/label>/);
  // An Operations that does not offer the email shows no box, and the share asks for nothing.
  assert.doesNotMatch(directShareForm({projectName:'Site',tasks}),/notifyClient|Email client/);
  assert.equal('notifyClient' in readDirectShareForm(form({client:key}),{projectId:'project',projectName:'Site',tasks,clients}).bodies()[0],false);
  const read=options=>readDirectShareForm(form({client:key,scope:'tasks',checked:['task-1','task-2'],...options}),{projectId:'project',projectName:'Site',tasks,clients}).bodies();
  assert.deepEqual(read({notify:true}).map(body=>body.notifyClient),[true,true]);
  assert.deepEqual(read({notify:false}).map(body=>body.notifyClient),[false,false]);
});

test('the Email client offer comes from the first page Operations answers when Share opens',async()=>{
  const offered=await loadDirectClientAccess(async()=>({clients:[],grants:[],grantsNextCursor:null,capabilities:{replaces:true,notifyClient:true}}),'project');
  assert.deepEqual(offered.capabilities,{replaces:true,notifyClient:true});
  const older=await loadDirectClientAccess(async()=>({clients:[],grants:[],grantsNextCursor:null,capabilities:{replaces:true}}),'project');
  assert.deepEqual(older.capabilities,{replaces:true});
});

const editableGrant={grantId:'grant-1',grantVersion:4,sourceId:'project-alpha:native',workspaceId:'workspace-1',
  viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Acme',includeFuturePublished:true,
  permissions:{measure:false,cameras:true,download:false},expiresAt:'2031-01-02T03:04:05.678Z'};
const editFolders=[{id:'folder-1',displayName:'East / Level 1'},{id:'folder-2',displayName:'West'}];
const editForm=(mode,folderIds=[],taskIds=[],missing=[])=>({
  elements:{mode:{value:mode}},
  querySelectorAll:selector=>(selector.includes('folder')?folderIds:taskIds)
    .map(value=>({value,hasAttribute:attribute=>attribute==='data-missing'&&missing.includes(value)})),
});

test('project edit is available only for a single editable share of that exact recipient and project',()=>{
  const options={projectId:'project',tasks,now:Date.parse('2030-01-01T00:00:00Z')};
  const other={...editableGrant,grantId:'other',workspaceId:'workspace-2'};
  const access={listedProjectId:'project',capabilities:{replaces:true},grants:[editableGrant,other]};
  assert.equal(editableDirectProjectGrant(access,'project','grant-1',options.now),editableGrant);
  assert.match(directGrantRows(access,options),/data-action="edit-direct-project-share" data-id="grant-1"/);
  assert.doesNotMatch(directGrantRows(access,{...options,taskId:'task-1'}),/Edit selection/);
  assert.doesNotMatch(directGrantRows({...access,grantsIncomplete:true},options),/Edit selection/);
  assert.doesNotMatch(directGrantRows({...access,listedProjectId:'other'},options),/Edit selection/);
  assert.doesNotMatch(directGrantRows({...access,grants:[editableGrant,{...editableGrant,grantId:'expired-sibling',scopeType:'task',
    taskId:'task-1',expiresAt:'2020-01-01T00:00:00Z'}]},options),/Edit selection/);
});

test('Edit selection requires strictly true capability from the current relevant list, never grant rows',async()=>{
  const options={projectId:'project',tasks,now:Date.parse('2030-01-01T00:00:00Z')};
  for(const capabilities of [undefined,{},null,{replaces:false},{replaces:'true'},{replaces:1},{replaces:true}]){
    const access=await loadDirectClientAccess(async()=>({clients:[],grants:[editableGrant],capabilities}),'project');
    assert.equal(directGrantRows(access,options).includes('Edit selection'),capabilities?.replaces===true);
    assert.match(directGrantRows(access,options),/Revoke/);
    assert.equal(editableDirectProjectGrant(access,'other','grant-1',options.now),null);
  }
  const pages=[{clients:[],grants:[editableGrant],capabilities:{replaces:true},grantsNextCursor:'next'},
    {clients:[],grants:[],grantsNextCursor:null}];
  const mixed=await loadDirectClientAccess(async()=>pages.shift(),'project');
  assert.doesNotMatch(directGrantRows(mixed,options),/Edit selection/);
  const fresh=await loadDirectClientAccess(async()=>({clients:[],grants:[editableGrant]}),'project');
  assert.doesNotMatch(directGrantRows(fresh,options),/Edit selection/);
});

test('project share review preserves the recipient, permissions, exact expiry and grant version',()=>{
  const context={grant:editableGrant,tasks,folders:editFolders,projectName:'Site'};
  const change=readDirectProjectShareEdit(editForm('only',['folder-2','folder-1'],['task-2']),context);
  assert.deepEqual(change.body,{
    sourceId:'project-alpha:native',workspaceId:'workspace-1',viewerProjectId:'project',taskId:null,
    scopeType:'project',includeFuturePublished:true,permissions:{measure:false,cameras:true,download:false},
    expiresAt:'2031-01-02T03:04:05.678Z',confirmedScope:true,selection:{version:1,mode:'only',folderIds:['folder-1','folder-2'],taskIds:['task-2']},
    replaces:[{grantId:'grant-1',grantVersion:4}],
  });
  assert.match(change.summary,/Acme.+Site.+Only “East \/ Level 1”, “West”, “South wall”/);
  assert.match(readDirectProjectShareEdit(editForm('except',[],['task-1']),context).summary,/Whole project except “North wall”/);
  assert.throws(()=>readDirectProjectShareEdit(editForm('only'),context),/Choose between/);
  assert.throws(()=>readDirectProjectShareEdit(editForm('whole'),context),/different selection/);
  const prior={...context,grant:{...editableGrant,selection:{version:1,mode:'except',folderIds:['removed-folder'],taskIds:[]}}};
  assert.match(directProjectShareEditForm(prior),/removed-folder" checked data-missing/);
  assert.throws(()=>readDirectProjectShareEdit(editForm('except',['removed-folder'],[],['removed-folder']),prior),/unavailable selections/);
  const whole=readDirectProjectShareEdit(editForm('whole',['removed-folder']),prior);
  assert.equal(Object.hasOwn(whole.body,'selection'),false);
  assert.match(whole.summary,/every published task in Site, including tasks published later/);

});
