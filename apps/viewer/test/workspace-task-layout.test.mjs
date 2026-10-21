import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const lines=source.split(/\r?\n/);
function declaration(name){const line=lines.find(line=>line.startsWith(`function ${name}(`)||line.startsWith(`const ${name}=`));assert.ok(line,`Missing shipped declaration ${name}`);return line;}
const names=['esc','available','empty','field','button','dangerButton','badge','taskFact','datasetActions','activeTaskAction','artifactActions','outputPanel','gcpPanel','taskQuickActions','taskPanel','taskDetail','taskWorkspaceBody','taskWorkspacePage','readWorkspaceView','workspaceView','workspaceUrl','applyWorkspaceView','validateWorkspaceView','syncWorkspaceView','navigateWorkspace','hydrateExpandedTask','render'];
function fixture(permissions=['viewer.gcp.read','viewer.gcp.write','viewer.processing.write','viewer.processing.publish','viewer.shares.create','viewer.storage.purge']){
const task={id:'task',projectId:'project',datasetId:'dataset',displayName:'Church <test>',createdAt:'2026-09-01',status:'ready_for_review',latestAttempt:{id:'active',status:'ready_for_review',providerId:'provider'},metrics:{sourceImageCount:20}},dataset={id:'dataset',status:'finalized',displayName:'Source'},state={section:'dashboard',selectedProjectId:'project',expandedTaskId:'task',taskPage:null,projects:[{id:'project',displayName:'Site',status:'active'}],tasks:[task],datasets:[dataset],outputs:[],providers:[{id:'provider',displayName:'Processing node'}],presets:[],taskDetails:{task:{task,gcp:{sets:[]},storage:{task:{totalBytes:4096}}}}},events=[],listeners={};
  const content={innerHTML:''},title={textContent:''},location={origin:'https://viewer.test',href:'https://viewer.test/workspace?section=dashboard&project=project&task=task'};
const context=vm.createContext({state,URL,URLSearchParams,location,history:{pushState:(_state,_unused,url)=>{events.push(['push',url]);location.href=new URL(url,location.origin).href;},replaceState:(_state,_unused,url)=>{events.push(['replace',url]);location.href=new URL(url,location.origin).href;}},WORKSPACE_SECTIONS:new Set(['dashboard','providers','background','trash','diagnostics']),ACTIVE:new Set(['running','queued_upstream','derivatives']),NAV:[['dashboard','x','Dashboard']],can:permission=>permissions.includes(permission),bytes:value=>`${value} B`,dateTime:value=>String(value),duration:attempt=>`runtime:${attempt.id||'none'}`,durationFromMs:value=>`${value} ms`,formatGsd:value=>`${value} GSD`,formatArea:value=>`${value} area`,groupedNumber:value=>String(value),orthophotoPreview:()=>'<figure class="orthophoto-preview">Ortho</figure>',canShareOutput:()=>false,lodAction:()=>'',taskLodNotice:()=>'',gcpWorkspace:()=>({}),gcpPointName:point=>point?.id||'',gcpImageName:image=>image?.id||'',gcpMarkerStyle:()=>'',releaseAllGcpImages:()=>events.push(['release-images']),shell:{classList:{remove:()=>{}}},refreshTaskDetails:taskId=>events.push(['hydrate',taskId]),content,document:{querySelector:selector=>selector==='#page-title'?title:null},renderNav:()=>{},updateActivityIndicator:()=>{},bind:()=>{},bindTaskDisclosures:()=>{},hydrateOrthophotoPreviews:()=>{},storageUsagePoll:{sync:()=>{}},clearInterval:()=>{},setInterval:()=>1,dashboard:()=>'<div>Dashboard</div>',background:()=>'',providers:()=>'',trash:()=>'',diagnostics:()=>'',addEventListener:(name,listener)=>{listeners[name]=listener;}});
  // Keep the shipped render lifecycle hook, while forbidding node requests in
  // this task-navigation harness. Capability refresh has its own focused tests.
  context.refreshProviderCapabilities=()=>{throw new Error('Task navigation must not refresh node capabilities');};
  vm.runInContext(`let lastProviderEntry=null;\n${source.slice(source.indexOf('function refreshOpenedProvider('),source.indexOf('function providerDetail('))}`,context);
  vm.runInContext([...names,'taskOutputStage','logPanel'].map(declaration).join('\n'),context);
  vm.runInContext(source.slice(source.indexOf('function canShareOutput('),source.indexOf('async function openShareModal(')),context);
  vm.runInContext(lines.find(line=>line.startsWith("addEventListener('popstate'")),context);
  const route=lines.find(line=>line.trimStart().startsWith("if(['task-gcp','task-settings','task-files','task-return']"));
  context.taskAction=vm.runInContext(`(action,id)=>{${route}}`,context);
  return {context,state,task,dataset,events,listeners,content,title,location};
}

test('expanded task has compact facts and one task menu, without duplicate tools or inline specialist pages',()=>{
  const f=fixture(),html=f.context.taskPanel(f.task);
  assert.match(html,/compact-task-detail/);assert.match(html,/class="task-facts"/);
  assert.match(html,/orthophoto-preview/);assert.match(html,/Church &lt;test&gt;/);
  for(const action of ['task-gcp','task-settings','task-files','task-history'])assert.match(html,new RegExp(`data-action="${action}"`));
  assert.match(html,/class="project-more-actions task-more-actions"/);
  assert.doesNotMatch(html,/class="row-actions task-tools"|gcp-import-form|task-options|Outputs and review/);
  assert.equal((html.match(/data-action="task-settings"/g)||[]).length,1);
  assert.equal((html.match(/data-action="toggle-task"/g)||[]).length,1);
});

test('collapsed task retains one summary and quick actions without nested content',()=>{
  const f=fixture();f.state.expandedTaskId=null;
  f.state.outputs=[{id:'output',taskId:'task',status:'published',activePublished:true,viewSessionUrl:'/session',downloadUrl:'/download',assetKinds:['tiles']}];
  const html=f.context.taskPanel(f.task);
  assert.match(html,/aria-expanded="false"/);assert.match(html,/ inert/);
  assert.match(html,/data-action="view-output"/);assert.match(html,/data-action="download-output"/);
  assert.doesNotMatch(html,/compact-task-detail/);
  assert.match(html,/More task actions/);
});

test('active expanded task exposes live output without forcing a settings detour',()=>{
  const f=fixture(['viewer.processing.read']);f.task.latestAttempt.status='running';f.task.latestAttempt.progress=.25;
  f.state.taskDetails.task.attempt=f.task.latestAttempt;f.state.taskDetails.task.logs=[{message:'Running odm_meshing'}];
  const html=f.context.taskPanel(f.task);assert.match(html,/Task output/);assert.match(html,/Building mesh/);assert.match(html,/25% reported by processing node/);
  f.task.latestAttempt.status='ready_for_review';assert.doesNotMatch(f.context.taskPanel(f.task),/Task output/);
  f.state.taskPage='settings';assert.match(f.context.taskWorkspaceBody(f.task,f.dataset),/Task output/);
});

test('daily task menu exposes rename but leaves destructive lifecycle actions in Details',()=>{
  const f=fixture(),overview=f.context.taskPanel(f.task);
  assert.doesNotMatch(overview,/data-action="(?:trash-task|trash-dataset)"/);
  assert.equal((overview.match(/data-action="edit-task"/g)||[]).length,1);
  f.state.taskPage='settings';const settings=f.context.taskWorkspaceBody(f.task,f.dataset);
  assert.equal((settings.match(/data-action="trash-task"/g)||[]).length,1);
  assert.equal((settings.match(/data-action="edit-task"/g)||[]).length,1);
  assert.match(settings,/Move task to Recycle Bin/);assert.match(settings,/Move source to Recycle Bin/);
  assert.match(settings,/task-streaming-settings/);
});

test('quick actions exclude tile generation status; unknown image count is explicit, not a zero',()=>{
  const f=fixture();f.state.outputs=[{id:'output',taskId:'task',status:'ready',attemptId:'active',downloadUrl:'/download',reportUrl:'/report',assetKinds:['tiles','report']}];
  f.context.lodAction=()=>'<button>3D tiles ready</button>';
  assert.doesNotMatch(f.context.taskQuickActions(f.task),/3D tiles|derivative-status/);
  f.task.metrics={};assert.match(f.context.taskPanel(f.task),/Not recorded/);
  f.task.metrics={sourceImageCount:0};assert.match(f.context.taskPanel(f.task),/<strong>0<\/strong><small>images/);
});

test('task toolbar keeps View, Model report and Share primary with every secondary action in More',()=>{
  const f=fixture();f.state.outputs=[{id:'output',taskId:'task',status:'published',activePublished:true,viewSessionUrl:'/view',downloadUrl:'/download',reportUrl:'/report',assetKinds:['tiles','report']}];
  const html=f.context.taskQuickActions(f.task),[primary,menu]=html.split('<details');
  assert.deepEqual([...primary.matchAll(/data-action="([^"]+)"/g)].map(match=>match[1]),['view-output','download-report','share-output']);
  for(const action of ['edit-task','download-output','task-settings','task-files','task-history','task-gcp'])assert.match(menu,new RegExp(`data-action="${action}"`));
  f.state.outputs=[];assert.match(f.context.taskQuickActions(f.task),/More task actions/,'unfinished tasks retain navigation');
  f.task.status='archived';assert.doesNotMatch(f.context.taskQuickActions(f.task),/edit-task|share-output|task-gcp/);
});

test('specialist task sections retain context and direct navigation rather than dead-end pages',()=>{
  const f=fixture();f.state.taskPage='files';const html=f.context.taskWorkspacePage();
  assert.match(html,/Back to project/);assert.match(html,/aria-label="Task sections"/);
  assert.match(html,/Details &amp; processing/);assert.match(html,/Files &amp; versions/);assert.match(html,/Church &lt;test&gt;/);
});

test('original processing PDF is consistently labeled Model report in quick actions and files',()=>{
  const f=fixture(),output={id:'output',taskId:'task',status:'ready',attemptId:'active',reportUrl:'/report',assetKinds:['report']};
  f.state.outputs=[output];
  for(const html of [f.context.taskQuickActions(f.task),f.context.artifactActions(output)]){
    assert.match(html,/data-action="download-report"[^>]*>Model report<\/button>/);
    assert.doesNotMatch(html,/>Report<|>Measurements report</);
  }
  delete output.reportUrl;
  assert.doesNotMatch(f.context.taskQuickActions(f.task),/download-report/);
  assert.doesNotMatch(f.context.artifactActions(output),/download-report/);
});

test('streaming notices are noninteractive and disappear when ready, while queued/error work stays visible',()=>{
  const f=fixture();f.context.lodJobForOutput=()=>null;f.context.recoveryOperationForOutput=()=>null;
  vm.runInContext(source.slice(source.indexOf('function taskLodNotice('),source.indexOf('function selectedProject(')),f.context);
  const output={id:'o',taskId:'task',status:'ready',lod:{status:'available'}};f.state.outputs=[output];
  assert.equal(f.context.taskLodNotice(f.task),'');
  for(const status of ['failed','complete']){f.context.lodJobForOutput=()=>({status});assert.equal(f.context.taskLodNotice(f.task),'','verified available overrides retained job status');}
  output.lod.status='fallback';assert.match(f.context.taskLodNotice(f.task),/needs attention/,'unverified complete does not hide fallback');f.context.lodJobForOutput=()=>null;
  for(const status of ['queued','running','failed','fallback']){output.lod.status=status;const html=f.context.taskLodNotice(f.task);assert.match(html,/task-lod-notice/);assert.doesNotMatch(html,/<button/);}
  output.lod={status:'available'};f.context.recoveryOperationForOutput=()=>({status:'awaiting_derivatives'});assert.match(f.context.taskLodNotice(f.task),/Preparing streaming/);
});

test('project summary counts ready tasks once and distinguishes source collections from tasks',()=>{
  const f=fixture();f.state.projectQuery='';f.context.selectedProject=()=>'';
  f.state.datasets=[{id:'dataset',projectId:'project',status:'finalized'},{id:'unused',projectId:'project',status:'draft'},{id:'old',projectId:'project',status:'trashed'},{id:'archived',projectId:'project',status:'archived'}];
  f.state.outputs=[{taskId:'task',status:'ready'},{taskId:'task',status:'published',activePublished:true}];
  vm.runInContext(declaration('projectRows'),f.context);
  const html=f.context.projectRows();assert.match(html,/<strong>1<\/strong><small>ready/);assert.match(html,/<strong>2<\/strong><small>source sets/);assert.doesNotMatch(html,/<small>published/);
});

test('project actions prioritize enabled new task for empty projects and keep secondary actions in More',()=>{
  const f=fixture(['viewer.processing.write','viewer.projects.write','viewer.datasets.import','viewer.shares.create']);
  f.state.tasks=[];f.state.datasets=[];f.state.providers=[];
  vm.runInContext(source.slice(source.indexOf('function selectedProject('),source.indexOf('function datasetActions(')),f.context);
  const html=f.context.selectedProject();
  assert.match(html,/data-action="project-process"[^>]*>New task/);
  assert.doesNotMatch(html,/data-action="project-process"[^>]*disabled/);
  assert.ok(html.indexOf('New task')<html.indexOf('>Share<'));
  assert.ok(html.indexOf('>Share<')<html.indexOf('<details'));
  const menu=html.slice(html.indexOf('<details'),html.indexOf('</details>'));
  assert.match(menu,/Rename project/);assert.match(menu,/Import existing results/);assert.match(menu,/Delete project/);
  f.state.projects[0].status='archived';assert.doesNotMatch(f.context.selectedProject(),/data-action="project-process"/);
});

test('expanded project is one unified card, without repeated name, description or all-projects control',()=>{
  const f=fixture();f.state.projectQuery='';f.state.projects[0].description='Keep this once';
  vm.runInContext(declaration('projectRows'),f.context);
  vm.runInContext(source.slice(source.indexOf('function selectedProject('),source.indexOf('function datasetActions(')),f.context);
  const html=f.context.projectRows();
  assert.equal((html.match(/Keep this once/g)||[]).length,1);
  assert.equal((html.match(/<strong>Site<\/strong>/g)||[]).length,1);
  assert.doesNotMatch(html,/All projects|<h2>Site|No project description|project-columns/);
  assert.ok(html.indexOf('class="project-detail"')<html.lastIndexOf('</article>'));
  assert.match(html,/aria-expanded="true" aria-controls="project-detail-project"/);
  f.state.selectedProjectId=null;assert.doesNotMatch(f.context.projectRows(),/class="project-detail"/);
});

test('GCP action renders dedicated page, releases prior images and pushes shareable route',()=>{
  const f=fixture();f.context.taskAction('task-gcp','task');
  assert.equal(f.state.taskPage,'gcp');assert.match(f.location.href,/panel=gcp/);
  assert.deepEqual(f.events[0],['release-images']);assert.equal(f.events[1][0],'push');
  assert.equal(f.title.textContent,'Ground control points');
  assert.match(f.content.innerHTML,/task-workspace-page/);assert.match(f.content.innerHTML,/gcp-import-form/);
  assert.match(f.content.innerHTML,/data-action="task-return"/);assert.doesNotMatch(f.content.innerHTML,/compact-task-detail|task-summary-toggle/);
});

test('Back to task preserves project/expanded task while removing panel; browser history restores GCP',()=>{
  const f=fixture();f.context.taskAction('task-gcp','task');const gcpUrl=f.location.href;
  f.context.taskAction('task-return','task');
  assert.equal(f.state.taskPage,null);assert.equal(f.state.expandedTaskId,'task');assert.equal(f.state.selectedProjectId,'project');assert.doesNotMatch(f.location.href,/panel=/);
  f.location.href=gcpUrl;f.listeners.popstate();
  assert.equal(f.state.taskPage,'gcp');assert.match(f.content.innerHTML,/gcp-import-form/);
  assert.equal(f.events.filter(event=>event[0]==='push').length,2,'popstate must not create another history entry');
});

test('route parsing and validation reject invalid panels, cross-project tasks and unknown projects',()=>{
  const f=fixture();
  for(const [url,project,task,panel]of [
    ['/workspace?section=dashboard&project=project&task=task&panel=bogus','project','task',null],
    ['/workspace?section=dashboard&project=missing&task=task&panel=gcp',null,null,null],
    ['/workspace?section=dashboard&project=project&task=other&panel=files','project',null,null],
    ['/workspace?section=diagnostics&project=project&task=task&panel=gcp',null,null,null],
    ['/workspace?section=dashboard&task=task&panel=gcp',null,null,null],
  ]){f.context.applyWorkspaceView(f.context.readWorkspaceView(new URL(url,f.location.origin).href));f.context.validateWorkspaceView();assert.equal(f.state.selectedProjectId,project,url);assert.equal(f.state.expandedTaskId,task,url);assert.equal(f.state.taskPage,panel,url);}
  f.state.tasks.push({...f.task,id:'other',projectId:'different'});f.context.applyWorkspaceView({section:'dashboard',selectedProjectId:'project',expandedTaskId:'other',taskPage:'gcp'});f.context.validateWorkspaceView();assert.equal(f.state.expandedTaskId,null);
});

test('direct task page hydration renders loading before asynchronous details, once only',()=>{
  const f=fixture();delete f.state.taskDetails.task;
  f.context.taskAction('task-gcp','task');
  assert.match(f.content.innerHTML,/Loading authoritative task details/);assert.doesNotMatch(f.content.innerHTML,/gcp-import-form/);
  assert.equal(f.events.filter(event=>event[0]==='hydrate').length,1);
  f.context.hydrateExpandedTask();assert.equal(f.events.filter(event=>event[0]==='hydrate').length,1);
});

test('GCP route denies missing read permission and archived task/project without showing editing forms',()=>{
  for(const denied of ['permission','task','project']){
    const f=fixture(denied==='permission'?[]:undefined);if(denied==='task')f.task.status='archived';if(denied==='project')f.state.projects[0].status='archived';
    f.context.taskAction('task-gcp','task');
    assert.match(f.content.innerHTML,/unavailable/);assert.doesNotMatch(f.content.innerHTML,/gcp-import-form|gcp-mark-form/);
    const compact=f.context.taskDetail(f.task,f.dataset);if(denied==='permission')assert.doesNotMatch(compact,/data-action="task-gcp"/);else assert.match(compact,/archived and read-only/);
    assert.doesNotMatch(compact,/data-action="edit-task"|data-action="trash-task"/);
  }
});

test('read-only GCP route keeps coordinates/images readable but removes every mutation form/action',()=>{
  const f=fixture(['viewer.gcp.read']);
  f.context.gcpWorkspace=()=>({setId:'set',pointId:'point',activeImage:{id:'image'},imageUrl:'blob:fixture',draftPixel:{pixelX:10,pixelY:20}});
  f.state.taskDetails.task.gcp={sets:[{id:'set',displayName:'Survey',pointCount:1}],points:[{id:'point',latitude:44,longitude:-89,elevationM:240}],candidates:[{id:'image'}],correspondences:[{id:'mark',pointId:'point',imageFileId:'image',pixelX:10,pixelY:20}]};
  f.context.taskAction('task-gcp','task');
  assert.match(f.content.innerHTML,/gcp-set-select|gcp-point-select/);assert.match(f.content.innerHTML,/blob:fixture/);assert.match(f.content.innerHTML,/Saved correspondences/);
  assert.doesNotMatch(f.content.innerHTML,/gcp-import-form|gcp-mark-form|data-action="gcp-(?:edit|delete)-mark"/);
  vm.runInContext(declaration('markGcpImage'),f.context);
  assert.doesNotThrow(()=>f.context.markGcpImage({get currentTarget(){throw Error('read-only clicks must stop before coordinate mutation');}}));
});

test('GCP page fails closed when linked dataset is missing or belongs to another task',()=>{
  const f=fixture();f.state.taskPage='gcp';
  for(const dataset of [undefined,{id:'different',projectId:'project'}]){
    const html=f.context.taskWorkspaceBody(f.task,dataset);
    assert.match(html,/unavailable/i);assert.doesNotMatch(html,/gcp-import-form|gcp-mark-form/);
  }
});

test('settings route displays authoritative metadata and preserves dataset lifecycle permissions',()=>{
  const f=fixture();f.state.taskDetails.task.task={...f.task,metrics:{sourceImageCount:123,processingDurationMs:9000,outputCount:2,processingStatus:'ready_for_review'}};
  f.context.taskAction('task-settings','task');
  assert.equal(f.title.textContent,'Task settings');assert.match(f.content.innerHTML,/task-options/);assert.match(f.content.innerHTML,/123/);assert.match(f.content.innerHTML,/9000 ms/);assert.match(f.content.innerHTML,/Processing node/);assert.match(f.content.innerHTML,/data-action="trash-dataset"/);assert.doesNotMatch(f.content.innerHTML,/gcp-import-form/);
  const denied=fixture([]);denied.context.taskAction('task-settings','task');assert.doesNotMatch(denied.content.innerHTML,/trash-dataset|upload-dataset/);
});

test('file route renders verified artifact actions and gates mutations for archived/read-only cases',()=>{
  const f=fixture(),output={id:'output',taskId:'task',status:'ready',attemptId:'active',assetKinds:['tiles','report'],downloadUrl:'/download',reportUrl:'/report'};f.state.outputs=[output];
  f.context.taskAction('task-files','task');
  assert.equal(f.title.textContent,'Task files');assert.match(f.content.innerHTML,/Model files/);
  for(const action of ['download-output','download-report','open-review','share-output','trash-output'])assert.match(f.content.innerHTML,new RegExp(`data-action="${action}"`));
  assert.doesNotMatch(f.content.innerHTML,/publish-attempt|Review & publish/);
  f.task.status='archived';f.context.render();assert.doesNotMatch(f.content.innerHTML,/data-action="(?:share-output|publish-attempt|trash-output|open-review)"/);assert.match(f.content.innerHTML,/data-action="download-output"/);
  for(const permissions of [[],['viewer.processing.publish'],['viewer.shares.create']]){
    const denied=fixture(permissions);denied.state.outputs=[output];denied.context.taskAction('task-files','task');
    assert.doesNotMatch(denied.content.innerHTML,/publish-attempt|share-output/);
    if(!permissions.includes('viewer.processing.publish'))assert.doesNotMatch(denied.content.innerHTML,/open-review|trash-output/);
  }
});

test('authoritative active latestAttempt, not newest history failure, selects task lifecycle/file actions',()=>{
  const f=fixture();f.task.latestAttempt={id:'stale',status:'failed',providerId:'provider'};
  f.state.taskDetails.task={task:{...f.task,latestAttempt:{id:'active',status:'running',providerId:'provider'}},attempts:[{id:'newer-failed',status:'failed'}],gcp:{sets:[]}};
  const html=f.context.taskDetail(f.task,f.dataset);
  assert.match(html,/data-action="cancel-attempt" data-id="active"/);assert.doesNotMatch(html,/restart-task|retry-attempt|trash-task/);
  f.state.taskPage='files';assert.doesNotMatch(f.context.taskWorkspacePage(),/publish-attempt/);
});
