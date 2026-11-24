import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import * as directClientShare from '../workspace-direct-client-share.mjs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
test('public and authenticated client sharing forms constrain intrinsic input widths',()=>{
  const css=readFileSync(new URL('../workspace-management.css',import.meta.url),'utf8');
  assert.match(css,/\.share-form,#client-grant-form\{min-width:0;grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css,/#client-grant-form label,#client-grant-form input,#client-grant-form select\{min-width:0\}/);
});
test('conditional sharing fields stay hidden despite managed-form layout rules',()=>{
  const css=readFileSync(new URL('../workspace-management.css',import.meta.url),'utf8');
  assert.match(css,/\.manage-form\s+\[hidden\]\s*\{\s*display:\s*none\s*!important\s*;?\s*\}/);
  assert.match(source,/data-password-input hidden/);
});
function declaration(name){
  const match=new RegExp(`^(?:async )?function ${name}\\(`,'m').exec(source);
  assert.ok(match,`Missing shipped function ${name}`);
  const rest=source.slice(match.index),next=/\n(?:async )?function \w+\(|\nconst \w+\s*=/.exec(rest);
  return next?rest.slice(0,next.index):rest;
}
const names=['clientAccessDiagnostic','canShareOutput','openShareModal','associationModelId','associationProjectId','portalAccountId',
  'clientProjectKey','clientProjectLabel','clientAccessSnapshot','exactClientAssociations','clientGrantBody','clientSharePanel','legacyClientSharePanel','clientShareCard','directShareContext','directClientShareCard','rerenderClientSharePanel','bindDirectShare','rememberShareResult','clearShareResult','visibleShareResult','shareModal','confirmSharedVersionUpdate',
  'createOutputShare','clientGrantRevocationMessage','bindShareModal','bindProjectShareCard','publicLinkState','publicTabLabel','shareViewLabels','availableShareViews','shareViewControls','bindShareViewControls','selectedShareViews','shareSettingsSummary','shareExpiryInput','editShareModal','retrieveShareLink'];
function fixture(permissions=['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']){
  const output={id:'output',modelId:'model',projectId:'project',taskId:'task',attemptId:'attempt',status:'ready',activePublished:false,assetKinds:['glb']};
  const state={token:'signed-in',projects:[{id:'project',displayName:'Site'}],tasks:[{id:'task',projectId:'project'}],outputs:[output],
    shares:{},sharePreflight:{},projectShares:{},clientAccess:{projects:[],associations:[],grants:[]},shareContext:{id:'context'},lastShareUrl:null};
  const calls=[],notices=[],rendered=[],decisions=[],copyButtons=[];
  let nativeRespond=async()=>({targets:[],grants:[]}),directRespond=async()=>{throw Object.assign(new Error('Not found'),{status:404})};
  let sequence=0,respond=async(path,options)=>options.method==='POST'
    ?{share:{id:'share',permissions:{view:true,download:false}},viewUrl:'https://viewer.test/view/capability'}
    :path.endsWith('/client-grants')?state.clientAccess:{shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']};
  const document={activeElement:null},clientPanel={innerHTML:''},modal={open:true,close(){this.open=false}},modalContent={
    querySelector:selector=>selector==='.share-columns'?{dataset:{shareContext:state.shareContext?.id}}:selector==='[data-client-share-panel]'?clientPanel:null,
    contains:()=>false,querySelectorAll:selector=>selector==='[data-action="copy-share"]'?copyButtons:[],
  };
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context=vm.createContext({...directClientShare,document,state,modal,modalContent,crypto:{randomUUID:()=>`request-${++sequence}`},
    can:permission=>permissions.includes(permission),esc,dateTime:value=>value,card:(title,body)=>`<section><h3>${esc(title)}</h3>${body}</section>`,
    empty:text=>`<p>${esc(text)}</p>`,field:(label,name,attrs='')=>`<label>${esc(label)}<input name="${name}" ${attrs}></label>`,
    badge:value=>`<span>${esc(value)}</span>`,button:(action,id,label)=>`<button data-action="${action}" data-id="${id}">${label}</button>`,
    openModal:(title,html)=>{rendered.push({title,html});modal.open=true},injectProjectShareCard:()=>{},
    values:form=>({label:form.elements.label?.value||'',password:form.elements.password?.value||'',expiresAt:form.elements.expiresAt.value}),
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});return path.startsWith('/api/v1/workspace/direct-client-grants')?directRespond(path,options):path.endsWith('/native-client-grants')?nativeRespond(path,options):respond(path,options)},
    outputFences:new Map(),projectDataGeneration:0,refreshProjectOutputs:async projectId=>{calls.refreshes=[...(calls.refreshes||[]),projectId]},
    mutate:async(...args)=>calls.push({mutation:args}),toast:(...args)=>notices.push(args),navigator:{clipboard:{writeText:async()=>{throw new Error('clipboard denied')}}},
    dialogs:{confirm:async()=>{decisions.push('confirm');return true},form:async()=>null},
  });
  vm.runInContext(names.map(declaration).join('\n'),context);
  const form={dataset:{outputId:'output'},isConnected:true,elements:{label:{value:''},password:{value:''},expiresAt:{value:''},
    measure:{checked:true},cameras:{checked:true},download:{checked:false}},button:{disabled:false},querySelector(){return this.button},
    querySelectorAll(selector){return selector==='input[name="allowedViews"]'?[{checked:true,value:'model'}]:[]}};
  return {context,document,state,output,calls,notices,rendered,decisions,modal,modalContent,clientPanel,form,copyButtons,
    respond(fn){respond=fn},respondNative(fn){nativeRespond=fn},respondDirect(fn){directRespond=fn},html:()=>rendered.at(-1)?.html||''};
}

test('ready share preflight and cancel execute only reads and never reopen a closed modal',async()=>{
  const f=fixture();let resolve;
  f.respond(path=>path.endsWith('/client-grants')?Promise.resolve(f.state.clientAccess):new Promise(done=>{resolve=done}));
  const opening=f.context.openShareModal('project','output');
  assert.match(f.html(),/Checking share eligibility/);assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
  f.modal.close();resolve({shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']});
  await opening;assert.equal(f.modal.open,false);assert.equal(f.rendered.length,1);assert.equal(f.output.activePublished,false);
  assert.equal(f.state.sharePreflight.output,undefined);assert.equal(f.state.shares.output,undefined);
});

for(const outcome of ['success','error'])for(const changed of ['context','token','subject'])test(`late public ${outcome} cannot overwrite state after ${changed} changes`,async()=>{
  const f=fixture(['viewer.shares.read','viewer.shares.create']);let settleOutput,settleProject;
  f.output.status='published';f.output.activePublished=true;
  f.respond(path=>new Promise((yes,no)=>{const settle=()=>outcome==='success'?yes({shares:[{id:'late'}]}):no(new Error('late failure'));if(path.endsWith('/public-shares'))settleProject=settle;else settleOutput=settle;}));
  const opening=f.context.openShareModal('project');
  if(changed==='context')f.state.shareContext={id:'replacement'};if(changed==='token')f.state.token='replacement';if(changed==='subject')f.state.adminSession={subject:'replacement'};
  settleOutput();settleProject();await opening;
  assert.equal(f.state.sharePreflight.output,undefined);assert.equal(f.state.shares.output,undefined);assert.equal(f.state.projectShares.project,undefined);
  assert.equal(f.rendered.length,1);
});

test('dedicated ready sharing offers explicit link creation without publish UX or whole-project form',async()=>{
  const f=fixture();await f.context.openShareModal('project','output');
  assert.match(f.html(),/Create public link/);assert.match(f.html(),/This model is private/);
  assert.doesNotMatch(f.html(),/Review & publish|publish-attempt|project-share-form|name="wholeProject"/);
  assert.doesNotMatch(f.html(),/name="download" checked/);assert.match(f.html(),/Optional password/);
  assert.match(f.html(),/Downloads, including model report/);
  assert.match(f.html(),/Direct Operations client sharing is not available/);
  assert.match(f.html(),/No Operations account or client workspace is required/);
  assert.match(f.html(),/data-share-mode="internal" role="tab"[^>]*aria-selected="true"/);
  assert.match(f.html(),/data-share-mode-panel="public"[^>]* hidden/);
  assert.equal(f.calls.every(call=>!call.options.method||call.options.method==='GET'),true);
});

test('public preflight settles while optional Operations client lookup remains pending',async()=>{
  const f=fixture();f.respond(path=>path.endsWith('/client-grants')?new Promise(()=>{}):Promise.resolve({shares:[],publicationRequired:true}));
  await f.context.openShareModal('project','output');
  assert.match(f.html(),/Create public link/);assert.doesNotMatch(f.html(),/Checking share eligibility/);
  assert.match(f.html(),/Checking Operations client access/);assert.equal(f.state.shareContext.clientLoading,true);
  assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
});

test('late optional client result updates only its panel without recreating a typed public form',async()=>{
  const f=fixture();let settle;
  f.respond(path=>path.endsWith('/client-grants')?new Promise(resolve=>{settle=resolve;}):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project','output');const renders=f.rendered.length;
  f.form.elements.label.value='Keep my label';f.form.elements.password.value='Keep my password';
  settle({projects:[],associations:[],grants:[]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.rendered.length,renders,'must not replace the modal or public form');
  assert.match(f.clientPanel.innerHTML,/Direct Operations client sharing is not available/);
  assert.equal(f.form.elements.label.value,'Keep my label');assert.equal(f.form.elements.password.value,'Keep my password');
});

test('optional client errors are honest and cannot hide the available public-link form',async()=>{
  const f=fixture();let reject;
  f.respond(path=>path.endsWith('/client-grants')?new Promise((_resolve,no)=>{reject=no;}):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project','output');reject(new Error('Unavailable'));await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.clientPanel.innerHTML,/could not be loaded.*Public links are unaffected/);
  assert.match(f.html(),/Create public link/);assert.equal(f.state.clientAccess,null);
});

for(const [label,status,code,requestId] of [
  ['local authorization',403,'permission_denied',null],
  ['upstream rejection',403,'operations_request_failed','59a59c20-c042-4e70-966b-ab87ad0aa833'],
  ['service unavailable',502,'operations_unavailable','59a59c20-c042-4e70-966b-ab87ad0aa833'],
])test(`client lookup displays safe ${label} diagnostics without altering public fields`,async()=>{
  const f=fixture();let reject;
  f.respond(path=>path.endsWith('/client-grants')?new Promise((_yes,no)=>{reject=no;}):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project','output');const renders=f.rendered.length;
  f.form.elements.label.value='Keep label';f.form.elements.password.value='Keep password';
  reject(Object.assign(new Error('https://upstream.test/private?token=secret'),{status,code,requestId}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.clientPanel.innerHTML,new RegExp(`HTTP ${status}`));assert.match(f.clientPanel.innerHTML,new RegExp(`Code: ${code}`));
  if(requestId)assert.match(f.clientPanel.innerHTML,new RegExp(`Reference: ${requestId}`));
  else assert.match(f.clientPanel.innerHTML,/No proxy reference was returned; this alone does not identify the failure stage/);
  assert.doesNotMatch(f.clientPanel.innerHTML,/upstream\.test|token=|secret/);
  assert.equal(f.rendered.length,renders);assert.equal(f.form.elements.label.value,'Keep label');assert.equal(f.form.elements.password.value,'Keep password');
});

test('client-grants API keeps only bounded status, allowlisted code and UUID reference, and no raw error body',async()=>{
  const f=fixture();let response,cleared=0;
  f.context.workspaceFetch=async()=>response;f.context.clearWorkspaceAuthorization=()=>{cleared++;};
  vm.runInContext([declaration('responseError'),declaration('api')].join('\n'),f.context);
  const uuid='59a59c20-c042-4e70-966b-ab87ad0aa833';
  for(const [status,code,header,expectedCode,expectedReference]of [
    [403,'permission_denied',null,'permission_denied',null],
    [403,'operations_request_failed',uuid,'operations_request_failed',uuid],
    [502,'operations_unavailable',uuid,'operations_unavailable',uuid],
    [401,'authentication_required',null,'authentication_required',null],
    [502,'<script>secret</script>','https://private.test/token',null,null],
    [502,'operations_unavailable',`${uuid}\nsecret`, 'operations_unavailable',null],
    [502,{toString:()=> 'operations_unavailable'},'secret',null,null],
  ]){
    response={status,ok:false,json:async()=>({code,error:'raw secret',message:'https://private.test/token'}),headers:{get:name=>name==='X-LTDS-Client-Access-Request'?header:null}};
    await assert.rejects(()=>f.context.api('/api/v1/workspace/client-grants'),error=>{
      assert.equal(error.message,'Operations client access request failed');assert.equal(error.status,status);
      assert.equal(error.code,expectedCode);assert.equal(error.requestId,expectedReference);return true;
    });
  }
  assert.equal(cleared,1,'401 must retain the existing authentication-loss behavior');
  response={status:403,ok:false,json:async()=>({code:'permission_denied'}),headers:{get:()=>uuid}};
  await assert.rejects(()=>f.context.api('/api/v1/processing/outputs/output/shares'),error=>{
    assert.equal(error.message,'Your current Viewer grant does not permit this action');assert.equal(error.code,undefined);assert.equal(error.requestId,undefined);return true;
  });
});

test('client panel independently suppresses malformed diagnostic fields rather than rendering arbitrary error text',()=>{
  const f=fixture();
  for(const diagnostic of [
    {status:'502<script>secret</script>',code:'operations_unavailable<script>secret</script>',requestId:'https://private.test/secret'},
    {status:200,code:{toString:()=> 'operations_unavailable'},requestId:'59a59c20-c042-4e70-966b-ab87ad0aa833\nsecret'},
    {status:600,code:'authentication_required secret',requestId:'<img src=secret>'},
  ]){
    f.state.shareContext.clientError=diagnostic;
    const html=f.context.clientSharePanel(f.output,'output');
    assert.match(html,/could not be loaded/);assert.match(html,/No proxy reference was returned/);
    assert.doesNotMatch(html,/HTTP |Code: |Reference: |secret|private\.test|script|img src/);
  }
});

for(const change of ['closed','context','token','subject','permission'])test(`late client diagnostic is ignored after ${change} changes`,async()=>{
  const permissions=['viewer.shares.read','viewer.shares.create','viewer.processing.publish','viewer.client_grants.manage'],f=fixture(permissions);let reject;
  f.respond(path=>path.endsWith('/client-grants')?new Promise((_yes,no)=>{reject=no;}):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project','output');const context=f.state.shareContext,access=f.state.clientAccess;
  if(change==='closed')f.modal.close();if(change==='context')f.state.shareContext={id:'other'};
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={subject:'other'};
  if(change==='permission')permissions.splice(permissions.indexOf('viewer.client_grants.manage'),1);
  reject(Object.assign(new Error('unsafe secret'),{status:502,code:'operations_unavailable',requestId:'59a59c20-c042-4e70-966b-ab87ad0aa833'}));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.clientAccess,access);assert.equal(context.clientError,null);assert.equal(f.clientPanel.innerHTML,'');
});

for(const change of ['closed','context','token','subject','permission'])test(`late client result is ignored after ${change} changes`,async()=>{
  const permissions=['viewer.shares.read','viewer.shares.create','viewer.processing.publish','viewer.client_grants.manage'],f=fixture(permissions);let settle;
  f.respond(path=>path.endsWith('/client-grants')?new Promise(resolve=>{settle=resolve;}):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project','output');const access=f.state.clientAccess;
  if(change==='closed')f.modal.close();if(change==='context')f.state.shareContext={id:'other'};
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={subject:'other'};
  if(change==='permission')permissions.splice(permissions.indexOf('viewer.client_grants.manage'),1);
  settle({projects:[{id:'late'}]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.clientAccess,access);assert.equal(f.clientPanel.innerHTML,'');
});

test('legacy active published output needs no processing attempt or publication grant for public sharing',async()=>{
  const f=fixture(['viewer.shares.create','viewer.shares.read']);delete f.output.attemptId;f.output.status='published';f.output.activePublished=true;
  assert.equal(f.context.canShareOutput(f.output),true);await f.context.openShareModal('project','output');
  assert.match(f.html(),/Create public link/);assert.equal(f.calls.some(call=>call.path.endsWith('/client-grants')),false);
});

test('ready create form requires share-create and publish; published share needs only share-create',()=>{
  for(const permissions of [[],['viewer.processing.publish'],['viewer.shares.create'],['viewer.shares.read']]){
    const f=fixture(permissions);f.context.shareModal('project','output');assert.doesNotMatch(f.html(),/class="manage-form share-form"/);
  }
  const f=fixture(['viewer.shares.create']);f.output.activePublished=true;f.output.status='published';
  f.context.shareModal('project','output');assert.match(f.html(),/class="manage-form share-form"/);
  assert.doesNotMatch(f.html(),/data-action="revoke-share"/);
});

test('cancelled exposure confirmation sends nothing; accepted confirmation carries explicit consent and no download permission',async()=>{
  const f=fixture();f.state.sharePreflight.output={existingAccessUpdateRequired:true};
  f.context.dialogs.confirm=async()=>false;
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.calls.length,0);assert.equal(f.form.button.disabled,false);
  f.context.dialogs.confirm=async()=>true;
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].options.body.publishIfReady,true);
  assert.equal(f.calls[0].options.body.allowExistingAccessUpdate,true);assert.equal(f.calls[0].options.body.permissions.download,false);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');assert.match(f.html(),/New public link/);
  assert.equal(f.notices.some(item=>/clipboard|failed/i.test(item[0])),false,'creation must not attempt clipboard');
});

// The row actions a task shows in the project tree, as shipped.
function rowActions(f){
  for(const [name,value] of Object.entries({LIVE_ATTEMPT_STATUSES:new Set(),MENU_SEPARATOR:'',folderCache:new Map(),menuItem:()=>'',treeMenu:()=>''}))f.context[name]=value;
  vm.runInContext(declaration('taskQuickActions'),f.context);
  return [...f.context.taskQuickActions(f.state.tasks[0]).matchAll(/data-action="([^"]+)" data-id="[^"]*">([^<]+)</g)].map(match=>`${match[2]}:${match[1]}`);
}
test('a task keeps its View button after a public link publishes its ready model',async()=>{
  const f=fixture();f.state.projects[0].status='active';f.state.tasks[0].status='ready_for_review';
  assert.deepEqual(rowActions(f),['View:open-review','Share:share-output']);
  await f.context.createOutputShare(f.form,'project','output');
  // The next tree repaint (the open project polls every 8 s) must still offer View, now of the published model.
  f.state.tasks[0].status='published';
  assert.deepEqual(rowActions(f),['View:view-output','Share:share-output']);
  // The rest of the row (older version, report, download) comes from the server; unrelated reads stay valid.
  assert.deepEqual(f.calls.refreshes,['project']);assert.equal(f.context.outputFences.get('project'),1);assert.equal(f.context.projectDataGeneration,0);
});
test('a model list read while the public link was being made cannot leave the row without View',async()=>{
  const f=fixture();f.state.projects[0].status='active';f.state.tasks[0].status='ready_for_review';
  f.respond(async()=>{f.state.outputs=[{...f.output}];return{share:{id:'share'},viewUrl:'https://viewer.test/view/capability'}});
  await f.context.createOutputShare(f.form,'project','output');
  assert.deepEqual(rowActions(f),['View:view-output','Share:share-output']);
});
test('a public link for an already published model keeps its View address and reads nothing again',async()=>{
  const f=fixture();f.state.projects[0].status='active';f.state.tasks[0].status='published';
  Object.assign(f.output,{status:'published',activePublished:true,viewSessionUrl:'/server/view-sessions'});
  await f.context.createOutputShare(f.form,'project','output');
  assert.deepEqual(rowActions(f),['View:view-output','Share:share-output']);
  assert.equal(f.output.viewSessionUrl,'/server/view-sessions');
  assert.equal(f.calls.refreshes,undefined);assert.equal(f.context.outputFences.size,0);
});
// The shipped full load and output refresh around the shipped share, with every read held until the test answers it.
function loadFixture({section='dashboard',share=undefined}={}){
  const f=fixture(),row=(id,projectId,extra={})=>({id,projectId,taskId:`task-of-${id}`,...extra}),held=new Map(),painted=[],renders=[];
  Object.assign(f.state,{section,adminSession:{subject:'ops:staff'},projects:[{id:'project',displayName:'Site',status:'active'}],taskDetails:{},expandedTaskId:null,diagnosticRuns:[]});
  f.state.outputs=[f.output,row('other-old','elsewhere')];
  if(share)f.respond(share);
  const answer=(path,value)=>{const entry=held.get(path);assert.ok(entry,`${path} was not read`);held.delete(path);entry.resolve(value)};
  const hold=path=>{assert.equal(held.has(path),false,path);return new Promise((resolve,reject)=>held.set(path,{resolve,reject}))};
  const shareApi=f.context.api;
  Object.assign(f.context,{pagedApi:path=>hold(path),pagedStorage:()=>hold('storage'),
    api:(path,options)=>options?.method==='POST'?shareApi(path,options):hold(path),workspaceLoads:0,projectPaintPending:false,projectArtifactsRefreshId:null,
    validateWorkspaceView(){},syncWorkspaceView(){},setWorkspaceHealth(){},document:{querySelector:()=>null},hydrateExpandedTask(){},scheduleOperationRefresh(){},scheduleProjectRefresh(){},
    access(){throw new Error('signed out')},render:()=>renders.push(1),patchProjectTree:id=>{painted.push(id);return false},console:{warn(){}}});
  delete f.context.refreshProjectOutputs;
  vm.runInContext(['fencedOutputs','currentShares','refreshProjectOutputs','load'].map(declaration).join('\n'),f.context);
  const settle=()=>new Promise(resolve=>setImmediate(resolve));
  const answerLoad=overrides=>{for(const path of [...held.keys()]){if(path.includes('?projectId=')||path.endsWith('/shares'))continue;answer(path,overrides[path]||{})}};
  return {...f,row,held,painted,renders,answer,answerLoad,settle,published:row('output','project',{taskId:'task',attemptId:'attempt',modelId:'model',status:'published',activePublished:true,viewSessionUrl:'/server/view',reportUrl:'/server/report'})};
}
for(const order of ['share answers before its project read','project read answers first'])
test(`a full load already in flight keeps its fresh data and cannot undo the share: ${order}`,async()=>{
  const f=loadFixture(),loading=f.context.load();
  assert.equal(f.context.workspaceLoads,1);
  await f.context.createOutputShare(f.form,'project','output');
  const project='/api/v1/processing/outputs?projectId=project';
  if(order==='project read answers first'){f.answer(project,{outputs:[f.published]});await f.settle()}
  // These answers were read before the link published the model: new project and new other-project outputs, old row for this one.
  f.answerLoad({'/api/v1/projects':{projects:[{id:'project',displayName:'Renamed',status:'active'},{id:'new',displayName:'New',status:'active'}]},
    '/api/v1/tasks':{tasks:[{id:'task',projectId:'project',status:'ready_for_review'}]},
    '/api/v1/processing/outputs':{outputs:[f.row('output','project',{taskId:'task',attemptId:'attempt',status:'ready',activePublished:false}),f.row('other-new','elsewhere')]},
    '/api/v1/processing/ready':{ok:true}});
  await f.settle();
  if(f.held.has('/api/v1/processing/outputs/output/shares'))f.answer('/api/v1/processing/outputs/output/shares',{shares:[{id:'share'}]});
  await loading;
  assert.equal(f.context.workspaceLoads,0);assert.equal(f.renders.length,1,'the load rendered');
  assert.deepEqual(f.state.projects.map(item=>item.displayName),['Renamed','New'],'unrelated fresh data committed');
  assert.deepEqual([...f.state.outputs].map(item=>item.id).sort(),['other-new','output']);
  assert.deepEqual(rowActions(f).slice(0,1),['View:view-output']);
  if(order!=='project read answers first'){f.answer(project,{outputs:[f.published]});await f.settle()}
  assert.equal(f.state.outputs.find(item=>item.id==='output').reportUrl,'/server/report','the server row replaced the local one');
  assert.deepEqual([...f.state.shares.output].map(item=>item.id),['share']);
  assert.deepEqual(f.painted,['project']);
  assert.equal(rowActions(f)[0],'View:view-output');
});
// A full load that has committed its outputs and now waits for the link list of every published output.
async function loadReadingLinks(f){
  Object.assign(f.output,{status:'published',activePublished:true,viewSessionUrl:'/view'});
  const ready=f.row('ready','project',{modelId:'ready-model',status:'ready',activePublished:false,attemptId:'ready-attempt',assetKinds:['glb']});
  f.state.outputs.push(ready);
  const loading=f.context.load();
  f.answerLoad({'/api/v1/processing/outputs':{outputs:[{...f.output},{...ready}]},'/api/v1/projects':{projects:f.state.projects},'/api/v1/processing/ready':{ok:true}});await f.settle();
  assert.deepEqual([...f.held.keys()],['/api/v1/processing/outputs/output/shares']);
  return {loading};
}
const shareIds=(f,id)=>f.state.shares[id]&&[...f.state.shares[id]].map(item=>item.id);
for(const projectRead of ['answered first','still pending'])
test(`a link that publishes another model while the load reads links is still listed: project read ${projectRead}`,async()=>{
  const f=loadFixture(),{loading}=await loadReadingLinks(f);
  f.form.dataset.outputId='ready';await f.context.createOutputShare(f.form,'project','ready');
  assert.deepEqual(shareIds(f,'ready'),['share']);
  const project='/api/v1/processing/outputs?projectId=project',answer=()=>f.answer(project,{outputs:[{...f.output},f.row('ready','project',{status:'published',activePublished:true,viewSessionUrl:'/server/view'})]});
  if(projectRead==='answered first'){answer();await f.settle()}
  f.answer('/api/v1/processing/outputs/output/shares',{shares:[{id:'older'}]});await loading;
  assert.deepEqual(shareIds(f,'ready'),['share'],'the new link survived the older read');
  assert.deepEqual(shareIds(f,'output'),['older'],'the unrelated list committed');
  if(projectRead!=='answered first'){answer();await f.settle();assert.deepEqual(shareIds(f,'ready'),['share'])}
});
test('a new link on an already published model is kept, although it moves no output fence',async()=>{
  const f=loadFixture(),{loading}=await loadReadingLinks(f);
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.context.outputFences.size,0);assert.deepEqual(shareIds(f,'output'),['share']);
  f.answer('/api/v1/processing/outputs/output/shares',{shares:[]});await loading;
  assert.deepEqual(shareIds(f,'output'),['share']);
});
test('link settings saved while the load reads links are kept, and an untouched list is replaced',async()=>{
  const f=loadFixture();f.state.shares={output:[{id:'mine',label:'old'}]};
  const {loading}=await loadReadingLinks(f);
  // The same replacement editShareModal makes with the PATCH answer.
  f.state.shares.output=f.state.shares.output.map(item=>({...item,label:'new'}));
  f.answer('/api/v1/processing/outputs/output/shares',{shares:[{id:'mine',label:'old'}]});await loading;
  assert.equal(f.state.shares.output[0].label,'new');
  const g=loadFixture();g.state.shares={output:[{id:'stale'}],gone:[{id:'removed'}]};
  const {loading:second}=await loadReadingLinks(g);g.answer('/api/v1/processing/outputs/output/shares',{shares:[{id:'fresh'}]});await second;
  assert.deepEqual(shareIds(g,'output'),['fresh']);assert.equal(g.state.shares.gone,undefined);
});
test('outside the dashboard with no project open, the outputs are still read again and nothing is painted',async()=>{
  const f=loadFixture({section:'storage'});
  await f.context.createOutputShare(f.form,'project','output');
  f.answer('/api/v1/processing/outputs?projectId=project',{outputs:[f.published]});await f.settle();
  assert.deepEqual([...f.state.outputs].map(item=>item.id),['other-old','output']);
  assert.equal(f.state.outputs[1].viewSessionUrl,'/server/view');assert.deepEqual(f.painted,[]);assert.equal(f.renders.length,0);
});
for(const changed of ['token','session'])test(`a project read is dropped when the ${changed} changes`,async()=>{
  const f=loadFixture();await f.context.createOutputShare(f.form,'project','output');
  if(changed==='token')f.state.token='replacement';else f.state.adminSession={subject:'ops:other'};
  f.answer('/api/v1/processing/outputs?projectId=project',{outputs:[]});await f.settle();
  assert.equal(f.state.outputs.some(item=>item.id==='output'),true);assert.deepEqual(f.painted,[]);assert.equal(f.context.projectArtifactsRefreshId,null);
});
test('a failed project read keeps View and leaves the project queued for its next poll',async()=>{
  const f=loadFixture();await f.context.createOutputShare(f.form,'project','output');
  f.held.get('/api/v1/processing/outputs?projectId=project').reject(new Error('offline'));await f.settle();
  assert.deepEqual([...f.context.projectArtifactsRefreshId],['project']);assert.equal(rowActions(f)[0],'View:view-output');
});

test('raced consent retry uses new key, uncertain retry retains exact consent payload even if output refreshes as published',async()=>{
  const f=fixture();let attempt=0;
  f.respond(async()=>{
    attempt++;
    if(attempt===1)throw Object.assign(new Error('existing_access_update_confirmation_required'),{status:409});
    if(attempt===2)throw new Error('network interrupted');
    return{share:{id:'share'},viewUrl:'https://viewer.test/view/same-link'};
  });
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,2);assert.notEqual(f.calls[0].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
  f.output.activePublished=true;f.output.status='published';
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls.length,3);assert.deepEqual(f.calls[2].options,f.calls[1].options);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/same-link');
});

test('same-form uncertain network retry retains key; changing visible request input rotates it',async()=>{
  const f=fixture();f.respond(async()=>{throw new Error('offline')});
  await f.context.createOutputShare(f.form,'project','output');await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.calls[0].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
  f.form.elements.label.value='Changed';await f.context.createOutputShare(f.form,'project','output');
  assert.notEqual(f.calls[1].options.headers['Idempotency-Key'],f.calls[2].options.headers['Idempotency-Key']);
});

test('double submit is suppressed while creation is pending and close suppresses stale modal rendering',async()=>{
  const f=fixture();let done;f.respond(()=>new Promise(resolve=>{done=resolve}));
  const pending=f.context.createOutputShare(f.form,'project','output');
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.calls.length,1);
  f.modal.close();f.form.isConnected=false;done({share:{id:'share'},viewUrl:'https://viewer.test/view/success'});await pending;
  assert.equal(f.modal.open,false);assert.equal(f.state.lastShareUrl,'https://viewer.test/view/success');
});

test('copy failure cannot create another link and preserves manual-copy URL',async()=>{
  const f=fixture();await f.context.createOutputShare(f.form,'project','output');
  const copy={dataset:{url:f.state.lastShareUrl}};f.copyButtons.push(copy);
  f.context.bindShareModal('project','output');await copy.onclick();
  assert.equal(f.calls.length,1);assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');
  assert.match(f.notices.at(-1)[0],/link is created.*copy it manually/);
});

function associated(f){
  f.output.activePublished=true;f.output.status='published';
  f.state.clientAccess={projects:[{id:'ops-project',accountId:'account',name:'Client site'}],associations:[
    {id:'match',modelId:'model',projectId:'ops-project'},
    {id:'wrong-model',modelId:'other',projectId:'ops-project'},
  ],grants:[]};
  f.form.elements.associationId={value:JSON.stringify(['match','ops-project','account'])};
  f.form.elements.includeFuturePublished={checked:true};
}
test('per-model client scope is exact task association and future=false despite forged broad inputs',()=>{
  const f=fixture();associated(f);
  f.form.elements.scopeType={value:'project'};f.form.elements.projectId={value:'unrelated'};
  const body=JSON.parse(JSON.stringify(f.context.clientGrantBody(f.form,'output')));
  assert.equal(body.grant.scopeType,'task');assert.equal(body.grant.includeFuturePublished,false);
  assert.equal(body.grant.associationId,'match');assert.equal(body.grant.projectId,'ops-project');assert.equal(body.grant.accountId,'account');
  f.form.elements.associationId.value='wrong-model';assert.throws(()=>f.context.clientGrantBody(f.form,'output'),/exact Operations/);
});

test('missing, conflicting, ambiguous, and private model associations fail closed',()=>{
  const f=fixture();associated(f);
  f.state.clientAccess.associations.push({id:'duplicate',modelId:'model',projectId:'ops-project'});
  assert.equal(f.context.exactClientAssociations(f.output).length,0);
  f.state.clientAccess.associations.pop();f.state.clientAccess.associations[0].accountId='other';
  assert.equal(f.context.exactClientAssociations(f.output).length,0);
  delete f.state.clientAccess.associations[0].accountId;f.output.activePublished=false;f.output.status='ready';
  assert.equal(f.context.exactClientAssociations(f.output).length,0);assert.throws(()=>f.context.clientGrantBody(f.form,'output'),/exact Operations/);
});

test('whole-project client scope requires current and future publications',()=>{
  const f=fixture();associated(f);
  f.form.elements.projectId={value:JSON.stringify(['ops-project','account'])};f.form.elements.wholeProject={checked:false};
  assert.throws(()=>f.context.clientGrantBody(f.form,null),/explicitly approve/);
  f.form.elements.wholeProject.checked=true;f.form.elements.includeFuturePublished.checked=false;
  assert.throws(()=>f.context.clientGrantBody(f.form,null),/must include/);
  f.form.elements.includeFuturePublished.checked=true;assert.equal(f.context.clientGrantBody(f.form,null).grant.includeFuturePublished,true);
  f.context.shareModal('project');assert.match(f.html(),/name="wholeProject" required/);
  assert.doesNotMatch(f.html(),/name="(?:includeFuturePublished|wholeProject)" checked/);
});

test('project sharing has no public creation form or public task forms',async()=>{
  const f=fixture();f.context.shareModal('project');f.context.bindProjectShareCard('project');
  assert.doesNotMatch(f.html(),/project-share-form|class="manage-form share-form"|Create public link|Create whole-project link/);
  assert.match(f.html(),/A public link opens one task\. Use Share on that task to create one\./);
  assert.match(f.html(),/data-legacy-project-shares/);assert.equal(f.calls.length,0);
  await f.context.createOutputShare(f.form,'project',null);assert.equal(f.calls.length,0);
});

test('a project and a task open the same Share dialog: same tabs, same order, starting on Client Workspace',()=>{
  const frame=f=>({title:f.rendered.at(-1).title,
    tabs:[...f.html().matchAll(/data-share-mode="([^"]+)" role="tab" id="([^"]+)" aria-controls="([^"]+)" tabindex="([^"]+)" aria-selected="([^"]+)">([^<]+)</g)].map(match=>match.slice(1)),
    panels:[...f.html().matchAll(/data-share-mode-panel="([^"]+)" role="tabpanel" id="([^"]+)" aria-labelledby="([^"]+)" (hidden)?/g)].map(match=>match.slice(1))});
  const f=fixture();f.state.tasks[0].displayName='North wall';f.output.displayName='odm_textured_model.glb';
  f.context.shareModal('project');const project=frame(f);
  f.context.shareModal('project','output');const task=frame(f);
  assert.equal(project.title,'Share project: Site');assert.equal(task.title,'Share task: North wall');
  assert.deepEqual(task.tabs,project.tabs);assert.deepEqual(task.panels,project.panels);
  assert.deepEqual(project.tabs.map(item=>[item[5],item[4]]),[['Public link','false'],['Client Workspace','true']]);
  assert.deepEqual(project.panels.map(item=>[item[0],item[3]]),[['internal',undefined],['public','hidden']]);
  // Both dialogs switch tabs, and a refresh of the dialog keeps the chosen tab.
  const tabs=['public','internal'].map(mode=>({dataset:{shareMode:mode},tabIndex:0,setAttribute(){},focus(){},click(){this.onclick()}}));
  const panels=['public','internal'].map(mode=>({dataset:{shareModePanel:mode},hidden:false}));
  f.modalContent.querySelectorAll=selector=>selector==='[data-share-mode]'?tabs:selector==='[data-share-mode-panel]'?panels:[];
  f.context.bindShareModal('project',null);tabs[0].onclick();
  assert.deepEqual(panels.map(panel=>panel.hidden),[false,true]);
  f.context.shareModal('project');assert.deepEqual(frame(f).panels.map(item=>[item[0],item[3]]),[['internal','hidden'],['public',undefined]]);
});

test('the Public link tab counts only links that still open',()=>{
  const f=fixture(),past='2020-01-01T00:00:00Z';
  assert.equal(f.context.publicTabLabel(null),'Public link');
  assert.equal(f.context.publicTabLabel([{revokedAt:past},{expiresAt:past}]),'Public link');
  assert.equal(f.context.publicTabLabel([{},{expiresAt:'2999-01-01T00:00:00Z'},{revokedAt:past}]),'Public link (2)');
  f.state.shares.output=[{id:'one',permissions:{}}];f.context.shareModal('project','output');
  assert.match(f.html(),/data-share-mode="public"[^>]*>Public link \(1\)</);
});

test('the tab count, task rows and old project rows use one rule, the server rule, for a live link',()=>{
  const f=fixture(),at=Date.parse('2026-06-01T00:00:00Z'),state=share=>f.context.publicLinkState(share,at);
  for(const [share,expected] of [[{},'active'],[{expiresAt:'2026-06-01T00:00:01Z'},'active'],[{expiresAt:'2026-06-01T00:00:00Z'},'expired'],
    [{expiresAt:'not a date'},'expired'],[{revokedAt:'2026-05-01T00:00:00Z'},'revoked'],[{revokedAt:'2026-05-01T00:00:00Z',expiresAt:'2026-05-02T00:00:00Z'},'revoked']])assert.equal(state(share),expected);
  const past='2020-01-01T00:00:00Z',later='2999-01-01T00:00:00Z',rows=[{id:'live',expiresAt:later},{id:'over',expiresAt:past},{id:'gone',revokedAt:past},{id:'open'}];
  const target={innerHTML:''},tab={textContent:''};
  f.modalContent.querySelector=selector=>selector==='[data-legacy-project-shares]'?target:selector==='#share-tab-public'?tab:null;
  f.state.projectShares.project=rows;vm.runInContext(declaration('injectProjectShareCard'),f.context);f.context.injectProjectShareCard('project');
  assert.equal(tab.textContent,'Public link (2)');
  assert.deepEqual([...target.innerHTML.matchAll(/<span>(active|expired|revoked)<\/span>/g)].map(match=>match[1]),['active','expired','revoked','active']);
  assert.match(target.innerHTML,/Expired 2020-01-01T00:00:00Z/);assert.match(target.innerHTML,/Expires 2999-01-01T00:00:00Z/);assert.match(target.innerHTML,/No expiry/);
  assert.match(target.innerHTML,/A link marked active opens the project until it expires or you revoke it/);assert.doesNotMatch(target.innerHTML,/remain active until you revoke/);
  f.modalContent.querySelector=()=>null;f.state.shares.output=rows.map(row=>({...row,permissions:{}}));f.context.shareModal('project','output');
  assert.deepEqual([...f.html().matchAll(/<span>(active|expired|revoked)<\/span>/g)].map(match=>match[1]),['active','expired','revoked','active']);
});

for(const [label,id,close] of [['the Public link tab','share-tab-public',false],['Close','',true]])test(`late project links keep keyboard focus on ${label}`,async()=>{
  const f=fixture();let settle;
  f.respond(path=>path.endsWith('/public-shares')?new Promise(resolve=>{settle=resolve}):Promise.resolve({shares:[]}));
  const old={id,classList:{contains:name=>close&&name==='modal-close'},focus(){throw new Error('the replaced control was focused')}},fresh={focused:0,focus(){this.focused++}};
  const opening=f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  // The person moved to the control, and chose the tab, while the links were still loading.
  f.document.activeElement=old;f.modalContent.contains=element=>element===old;
  if(!close)f.state.shareContext.mode='public';
  const query=f.modalContent.querySelector;f.modalContent.querySelector=selector=>selector===(close?'.modal-close':'#share-tab-public')?fresh:query(selector);
  settle({shares:[{id:'live'}]});await opening;
  assert.equal(f.rendered.length,2);assert.equal(fresh.focused,1);
  assert.match(f.html(),close?/data-share-mode="internal"[^>]*aria-selected="true"/:/data-share-mode="public"[^>]*aria-selected="true"/);
});

test('a dialog refresh moves focus only when the person was on its tabs or Close, never when opening or from outside',()=>{
  const f=fixture(),moves=[];f.modalContent.querySelector=selector=>/^#share-tab|^.modal-close/.test(selector)?{focus(){moves.push(selector)}}:null;
  const tab={id:'share-tab-internal',classList:{contains:()=>false}};
  f.document.activeElement=tab;f.context.shareModal('project');assert.deepEqual(moves,[],'focus outside the dialog');
  f.modalContent.contains=()=>true;f.modal.open=false;f.context.shareModal('project');assert.deepEqual(moves,[],'first opening');
  f.modal.open=true;f.document.activeElement={id:'other',classList:{contains:()=>false}};f.context.shareModal('project');assert.deepEqual(moves,[],'another control');
  f.document.activeElement=tab;f.context.shareModal('project');assert.deepEqual(moves,['#share-tab-internal']);
});

test('new link result is bound to its project, output and share identity',async()=>{
  const f=fixture();await f.context.createOutputShare(f.form,'project','output');
  assert.match(f.html(),/New public link/);
  f.context.shareModal('other-project');assert.doesNotMatch(f.html(),/New public link|view\/capability/);
  f.context.shareModal('project','different-output');assert.doesNotMatch(f.html(),/New public link|view\/capability/);
  f.context.shareModal('project','output');assert.match(f.html(),/New public link/);
  f.context.clearShareResult('different-share','model');assert.ok(f.state.lastShareResult);
  f.context.clearShareResult('share','project');assert.ok(f.state.lastShareResult);
});

test('loaded revoked or expired link metadata hides and clears the stale creation card',async()=>{
  for(const metadata of [{revokedAt:'2026-01-01T00:00:00Z'},{expiresAt:'2020-01-01T00:00:00Z'}]){
    const f=fixture();await f.context.createOutputShare(f.form,'project','output');
    Object.assign(f.state.shares.output[0],metadata);
    f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link|created successfully/);
    assert.equal(f.state.lastShareUrl,null);
  }
  const f=fixture();f.context.rememberShareResult({share:{id:'project-share',expiresAt:'2020-01-01T00:00:00Z'},viewUrl:'https://viewer.test/project/expired'},'project',null);
  f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link/);assert.equal(f.state.lastShareUrl,null);
});

for(const kind of ['model','project'])test(`successful ${kind} revoke clears only its matching creation result`,async()=>{
  const f=fixture(),element={dataset:{id:'share'},isConnected:true};
  f.context.rememberShareResult({share:{id:'share'},viewUrl:'https://viewer.test/link'},'project',kind==='model'?'output':null);
  f.modalContent.querySelectorAll=selector=>selector===`[data-action="revoke-${kind==='model'?'share':'project-share'}"]`?[element]:[];
  f.context.mutate=async()=>({share:{id:'share',revokedAt:'now'}});
  if(kind==='model')f.context.bindShareModal('project','output');else f.context.bindProjectShareCard('project');
  await element.onclick();assert.equal(f.state.lastShareUrl,null);assert.equal(f.state.lastShareResult,null);
  f.context.shareModal('project');assert.doesNotMatch(f.html(),/New public link|created successfully/);
});

test('failed or cancelled revoke does not erase an otherwise valid created link',async()=>{
  const f=fixture(),element={dataset:{id:'share'},isConnected:true};
  f.context.rememberShareResult({share:{id:'share'},viewUrl:'https://viewer.test/link'},'project','output');
  f.modalContent.querySelectorAll=selector=>selector==='[data-action="revoke-share"]'?[element]:[];
  f.context.bindShareModal('project','output');f.context.dialogs.confirm=async()=>false;
  await element.onclick();assert.equal(f.state.lastShareUrl,'https://viewer.test/link');
  f.context.dialogs.confirm=async()=>true;f.context.mutate=async()=>undefined;
  await element.onclick();assert.equal(f.state.lastShareUrl,'https://viewer.test/link');
});

test('available-view selection comes from verified kinds and defaults to all supported views only',()=>{
  const f=fixture();f.state.sharePreflight.output={eligibleAssetKinds:['glb','tiles','ept','ortho','dsm','dtm','report','camera']};
  assert.deepEqual([...f.context.availableShareViews(f.output)],['model','pointCloud','ortho','dsm','dtm']);
  const html=f.context.shareViewControls(f.output);
  assert.equal((html.match(/name="allowedViews"/g)||[]).length,5);
  assert.match(html,/data-all-share-views checked/);assert.doesNotMatch(html,/value="report"|value="camera"/);
  const scoped=f.context.shareViewControls(f.output,['ortho']);assert.doesNotMatch(scoped,/data-all-share-views checked/);assert.match(scoped,/value="ortho" checked/);
  assert.throws(()=>f.context.selectedShareViews({querySelectorAll:()=>[]}),/at least one/);
});
test('existing task share lists settings and durable management actions without exposing password',()=>{
  const f=fixture();f.state.shares.output=[{id:'saved',label:'Client',hasPassword:true,permissions:{measure:true,cameras:false,download:false},allowedViews:['model'],linkRecoverable:true}];
  f.context.shareModal('project','output');
  for(const action of ['copy-existing-share','open-existing-share','edit-share','revoke-share'])assert.match(f.html(),new RegExp(action));
  assert.match(f.html(),/Temporary measurements.*No camera positions.*No downloads.*Password protected/);
  assert.doesNotMatch(f.html(),/No expiry.*secret/);
});
test('unencrypted legacy task links still offer Copy and Open for receipt-based recovery',()=>{
  const f=fixture();f.state.shares.output=[{id:'legacy',label:'Legacy',hasPassword:false,permissions:{view:true},allowedViews:null,linkRecoverable:false}];
  f.context.shareModal('project','output');
  assert.match(f.html(),/copy-existing-share/);assert.match(f.html(),/open-existing-share/);
  assert.doesNotMatch(f.html(),/cannot be retrieved|not recoverable/);
});
test('editing preserves legacy all-views and password unless explicitly changed; same-body retries reuse receipt',async()=>{
  const f=fixture(),status={},all={checked:true},views=[{checked:true,value:'model'}];
  const share={id:'share',allowedViews:null,hasPassword:true,expiresAt:'2030-01-01T12:00:37.000Z',permissions:{view:true,measure:true,cameras:true,download:false}};
  f.state.shares.output=[share];
  const form={isConnected:true,elements:{label:{value:'Client'},passwordAction:{value:'keep'},password:{value:''},expiresAt:{value:f.context.shareExpiryInput(share.expiresAt)},measure:{checked:true},cameras:{checked:true},download:{checked:false}},
    querySelector:selector=>selector==='[data-all-share-views]'?all:selector==='[role="status"]'?status:{},
    querySelectorAll:selector=>selector==='input[name="allowedViews"]'?views:[]};
  f.modalContent.querySelector=selector=>selector==='#share-edit-form'?form:null;
  f.context.editShareModal('project','output','share');f.respond(async()=>{throw new Error('Network unavailable')});
  const submit=()=>form.onsubmit({preventDefault(){}});
  await submit();await submit();
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
  assert.equal(f.calls[0].options.body.expiresAt,share.expiresAt);
  assert.equal(Object.hasOwn(f.calls[0].options.body,'password'),false);assert.equal(Object.hasOwn(f.calls[0].options.body,'allowedViews'),false);
  form.elements.passwordAction.value='remove';form.shareViewsChanged=true;await submit();
  assert.equal(f.calls[2].options.body.password,null);assert.deepEqual(f.calls[2].options.body.allowedViews,['model']);
  assert.notEqual(f.calls[2].options.headers['Idempotency-Key'],f.calls[1].options.headers['Idempotency-Key']);
});
test('link editing suppresses duplicate saves and does not replace a newer dialog',async()=>{
  const f=fixture(),status={},form={isConnected:true,elements:{label:{value:'Client'},passwordAction:{value:'keep'},password:{value:''},expiresAt:{value:''},measure:{checked:true},cameras:{checked:true},download:{checked:false}},
    querySelector:selector=>selector==='[data-all-share-views]'?null:status,querySelectorAll:()=>[]};
  f.state.shares.output=[{id:'share',allowedViews:null,permissions:{view:true}}];f.modalContent.querySelector=selector=>selector==='#share-edit-form'?form:null;
  f.context.editShareModal('project','output','share');const renders=f.rendered.length;let finish;f.respond(()=>new Promise(resolve=>{finish=resolve}));
  const save=form.onsubmit({preventDefault(){}});await form.onsubmit({preventDefault(){}});assert.equal(f.calls.length,1);
  form.isConnected=false;finish({share:{id:'share',label:'Client'}});await save;assert.equal(f.rendered.length,renders);
});
test('existing link copy is read-only and ignores responses for detached dialogs',async()=>{
  const f=fixture(),copied=[],element={isConnected:true,disabled:false,dataset:{id:'saved',action:'copy-existing-share'}};
  f.context.URL=URL;f.context.location={origin:'https://viewer.test'};
  f.context.navigator.clipboard.writeText=async value=>copied.push(value);
  f.respond(async()=>({viewUrl:'https://viewer.test/view/existing'}));
  await f.context.retrieveShareLink(element);
  assert.equal(f.calls[0].path,'/api/v1/processing/shares/saved/link');assert.equal(f.calls[0].options.method,undefined);
  assert.deepEqual(copied,['https://viewer.test/view/existing']);
  let complete;f.respond(()=>new Promise(resolve=>{complete=resolve}));
  const pending=f.context.retrieveShareLink(element);element.isConnected=false;complete({viewUrl:'https://viewer.test/view/late'});await pending;
  assert.equal(copied.length,1);assert.equal(element.disabled,false);
});
test('Open reserves isolated popup synchronously and validates returned URL before navigation',async()=>{
  const f=fixture(),navigated=[],popup={opener:'original',location:{replace:value=>navigated.push(value)},close(){this.closed=true}};
  f.context.URL=URL;f.context.location={origin:'https://viewer.test'};let opens=0;
  f.context.window={open:()=>{opens++;return popup}};
  let complete;f.respond(()=>new Promise(resolve=>{complete=resolve}));
  const element={isConnected:true,disabled:false,dataset:{id:'saved',action:'open-existing-share'}};
  const pending=f.context.retrieveShareLink(element);assert.equal(opens,1);assert.equal(popup.opener,null);
  complete({viewUrl:'https://viewer.test/view/existing'});await pending;assert.deepEqual(navigated,['https://viewer.test/view/existing']);
  f.respond(async()=>({viewUrl:'https://unrelated.test/view/secret'}));await f.context.retrieveShareLink(element);
  assert.equal(navigated.length,1);assert.equal(popup.closed,true);
});
test('failed legacy URL recovery reports unrecoverable only after GET and never creates or revokes links',async()=>{
  const f=fixture(),element={isConnected:true,disabled:false,dataset:{id:'legacy',action:'copy-existing-share'}};
  f.state.shares.output=[{id:'legacy',linkRecoverable:false}];
  f.respond(async()=>{const error=new Error('The original link cannot be recovered; it has not been changed.');error.status=409;throw error});
  await f.context.retrieveShareLink(element);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].path,'/api/v1/processing/shares/legacy/link');assert.equal(f.calls[0].options.method,undefined);
  assert.match(f.notices.at(-1)[0],/not recoverable.*not been changed or revoked/);
  assert.equal(f.state.shares.output[0].revokedAt,undefined);assert.equal(element.disabled,false);
});


test('duplicate project rows select the exact client account for project and task grants',()=>{
  const f=fixture();associated(f);
  f.state.clientAccess.projects.push({id:'ops-project',accountId:'account-two',accountName:'Second account',name:'Client site'});
  const choices=f.context.exactClientAssociations(f.output);
  assert.equal(choices.length,2);
  f.form.elements.associationId.value=choices[1].selectionKey;
  assert.equal(f.context.clientGrantBody(f.form,'output').grant.accountId,'account-two');
  f.form.elements.projectId={value:f.context.clientProjectKey(f.state.clientAccess.projects[1])};
  f.form.elements.wholeProject={checked:true};
  assert.equal(f.context.clientGrantBody(f.form,null).grant.accountId,'account-two');
  f.form.elements.projectId.value='ops-project';
  assert.throws(()=>f.context.clientGrantBody(f.form,null),/explicitly approve/);
  assert.match(f.context.clientShareCard(f.output,'output'),/Second account/);
});

test('native connected workspace uses the exact verified source, workspace, project and model association',()=>{
  const f=fixture();associated(f);
  f.state.clientNativeAccess={grants:[],targets:[{sourceId:'project-alpha:primary',workspaceId:'workspace',workspaceName:'Client workspace',projectPublicId:'native-project',projectName:'Site',associations:[{id:'native-association',viewerModelId:'model',modelTitle:'Model'}]}]};
  const choice=f.context.exactClientAssociations(f.output).find(item=>item.id==='native-association');
  f.form.elements.associationId.value=choice.selectionKey;
  const body=f.context.clientGrantBody(f.form,'output');
  assert.equal(body.connection,'native');
  assert.deepEqual(JSON.parse(JSON.stringify(body.grant)),{sourceId:'project-alpha:primary',workspaceId:'workspace',projectPublicId:'native-project',scopeType:'task',associationId:'native-association',includeFuturePublished:false,expiresAt:null,permissions:{measure:true,cameras:true,download:false}});
  assert.match(f.context.clientShareCard(f.output,'output'),/Connected Client Workspaces/);
  f.state.clientNativeAccess.targets[0].associations[0].viewerModelId='another-model';
  assert.throws(()=>f.context.clientGrantBody(f.form,'output'),/exact Operations/);
});

test('project grant list only displays grants associated with the current Viewer project',()=>{
  const f=fixture();associated(f);f.state.shareContext.projectId='project';
  f.state.clientAccess.grants=[{id:'related',projectId:'ops-project',clientName:'Related client',scopeType:'project'},{id:'unrelated',projectId:'other-project',clientName:'Unrelated client',scopeType:'project'}];
  const html=f.context.clientShareCard(null,null);
  assert.match(html,/Related client/);assert.doesNotMatch(html,/Unrelated client/);
});

test('sharing tabs support arrow keys and synchronize focus, selection and panels',()=>{
  const f=fixture();
  const tabs=['internal','public'].map(shareMode=>({dataset:{shareMode},attributes:{},setAttribute(key,value){this.attributes[key]=value},click(){this.onclick()},focus(){this.focused=true}}));
  const panels=['internal','public'].map(shareModePanel=>({dataset:{shareModePanel}}));
  f.modalContent.querySelectorAll=selector=>selector==='[data-share-mode]'?tabs:selector==='[data-share-mode-panel]'?panels:[];
  f.context.bindShareModal('project','output');let prevented=false;
  tabs[0].onkeydown({key:'ArrowRight',preventDefault(){prevented=true}});
  assert.equal(prevented,true);assert.equal(tabs[1].focused,true);assert.equal(tabs[1].attributes['aria-selected'],'true');assert.equal(tabs[0].tabIndex,-1);assert.equal(panels[0].hidden,true);assert.equal(panels[1].hidden,false);
});


test('native lookup failure remains visible while legacy client sharing works',async()=>{
  const f=fixture();associated(f);
  f.respondNative(async()=>{throw Object.assign(new Error('Unavailable'),{status:502})});
  await f.context.openShareModal('project','output');await new Promise(resolve=>setImmediate(resolve));
  const html=f.clientPanel.innerHTML||f.html();
  assert.match(html,/Connected Client Workspaces could not be loaded/);
  assert.match(html,/Grant client access/);assert.match(html,/Client site/);
  assert.match(f.html(),/Create public link/);
});

test('native-only targets preselect the connected workspace portal',()=>{
  const f=fixture();associated(f);f.state.clientAccess={projects:[],associations:[],grants:[]};
  f.state.clientNativeAccess={grants:[],targets:[{sourceId:'project-alpha:primary',workspaceId:'workspace',workspaceName:'Client',projectPublicId:'project',projectName:'Site',associations:[{id:'native-association',viewerModelId:'model',modelTitle:'Model'}]}]};
  assert.match(f.context.clientShareCard(f.output,'output'),/<option value="native" selected>Connected Client Workspaces/);
});


test('native revocation reports validated open-session lifetime and preserves legacy pending status',async()=>{
  const f=fixture();const action={dataset:{action:'revoke-native-client-grant',id:'native-grant'}};
  f.context.dialogs.form=async()=>({reason:'Ended access'});
  f.modalContent.querySelectorAll=selector=>selector.includes('revoke-native-client-grant')?[action]:[];
  let responseMessage;
  f.context.mutate=async(path,options,message)=>{assert.equal(path,'/api/v1/workspace/native-client-grants');assert.equal(options.body.grantId,'native-grant');responseMessage=message({existingSessionsExpireWithinSeconds:1800})};
  f.context.bindShareModal('project','output');await action.onclick();
  assert.match(responseMessage,/New client access revoked.*up to 30 minutes/);
  assert.match(f.context.clientGrantRevocationMessage({existingSessionsExpireWithinSeconds:90},true),/up to 2 minutes/);
  assert.match(f.context.clientGrantRevocationMessage({existingSessionsExpireWithinSeconds:'1800'},true),/until they expire/);
  assert.match(f.context.clientGrantRevocationMessage({sessionRevocation:{pending:true}},false),/existing sessions is pending/);
  assert.equal(f.context.clientGrantRevocationMessage({sessionRevocation:{pending:false}},false),'Client access revoked');
});

test('direct client sharing leads the Share dialog and keeps Operations project sharing available',async()=>{
  const f=fixture();f.output.status='published';f.output.activePublished=true;
  f.respondDirect(async path=>{assert.match(path,/viewerProjectId=project/);return {clients:[{sourceId:'s',workspaceId:'w',displayName:'Acme',businessName:null}],grants:[],clientsNextCursor:null}});
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.html()+f.clientPanel.innerHTML;
  assert.match(html,/Share with a client/);assert.match(html,/Share through an Operations project instead/);
  assert.match(html,/The whole project<\/label>/);assert.match(html,/Also share models published later/);
  assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
});
test('changing or clearing the chosen client unticks the confirmation',()=>{
  const f=fixture();f.state.clientDirectAccess={clients:[],grants:[]};let bound;
  f.context.bindClientPicker=(_root,options)=>{bound=options;return {dispose(){}}};
  const confirmed={checked:false},summary={textContent:''};
  const form={isConnected:true,elements:{client:{value:''},confirmedScope:confirmed,includeLater:{checked:false},expiresAt:{value:''},measure:{checked:true},cameras:{checked:false},download:{checked:false}},
    querySelector:selector=>selector==='[data-direct-summary]'?summary:selector==='[data-client-picker]'?{}:selector==='input[name="scope"]:checked'?{value:'project'}:selector==='[data-direct-review]'?{hidden:true}:selector==='[data-direct-review-button]'?{hidden:false}:selector==='[data-direct-back]'?{}:null,
    querySelectorAll:()=>[]};
  f.context.bindDirectShare(form,'project',null);
  const first={sourceId:'project-alpha:primary',workspaceId:'ws-1',displayName:'Pat Example',businessName:'Division A'};
  bound.onSelect(first);confirmed.checked=true;
  bound.onSelect({...first});assert.equal(confirmed.checked,true,'the same client again keeps the confirmation');
  bound.onSelect({...first,workspaceId:'ws-2'});assert.equal(confirmed.checked,false,'a different client needs a fresh confirmation');
  confirmed.checked=true;bound.onSelect(null);assert.equal(confirmed.checked,false,'clearing the client needs a fresh confirmation');
  assert.match(summary.textContent,/Choose a client/);
});
test('without direct client sharing the Share dialog is unchanged',async()=>{
  const f=fixture();await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.html()+f.clientPanel.innerHTML;
  assert.doesNotMatch(html,/Share with a client|Share through an Operations project instead/);
});

for(const directAvailable of [false,true])for(const legacyFailed of [false,true])test(`direct availability ${directAvailable} is independent of legacy failure ${legacyFailed}`,async()=>{
  const f=fixture();
  f.output.status='published';f.output.activePublished=true;
  if(directAvailable)f.respondDirect(async()=>({clients:[{sourceId:'s',workspaceId:'w',displayName:'Acme'}],grants:[]}));
  if(legacyFailed)f.respond(path=>path.endsWith('/client-grants')?Promise.reject(Object.assign(new Error('Unavailable'),{status:503})):Promise.resolve({shares:[]}));
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.context.clientSharePanel(f.output,null);
  assert.equal(html.includes('id="direct-client-grant-form"'),directAvailable);
  assert.equal(html.includes('Operations client access could not be loaded'),legacyFailed);
  if(directAvailable&&legacyFailed)assert.match(html,/<details[^>]*class="share-legacy"[\s\S]*Operations client access could not be loaded[\s\S]*<\/details>/);
  assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
});

test('healthy direct sharing renders while both Operations project lookups are still pending',async()=>{
  const f=fixture();f.output.status='published';f.output.activePublished=true;
  f.respond(path=>path.endsWith('/client-grants')?new Promise(()=>{}):Promise.resolve({shares:[]}));
  f.respondNative(()=>new Promise(()=>{}));
  f.respondDirect(async()=>({clients:[{sourceId:'s',workspaceId:'w',displayName:'Acme'}],grants:[]}));
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.context.clientSharePanel(f.output,null);
  assert.equal(f.state.shareContext.clientLoading,true);
  assert.match(html,/id="direct-client-grant-form"/);
  assert.match(html,/<details[^>]*class="share-legacy"[\s\S]*Checking Operations client access[\s\S]*<\/details>/);
});

for(const change of ['closed','context','token','subject','permission'])test(`late direct result is ignored after ${change} changes`,async()=>{
  const permissions=['viewer.shares.read','viewer.client_grants.manage'],f=fixture(permissions);let settle;
  f.respondDirect(()=>new Promise(resolve=>{settle=resolve}));
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const access=f.state.clientDirectAccess,panel=f.clientPanel.innerHTML;
  if(change==='closed')f.modal.close();if(change==='context')f.state.shareContext={id:'other'};
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={subject:'other'};
  if(change==='permission')permissions.splice(permissions.indexOf('viewer.client_grants.manage'),1);
  settle({clients:[{sourceId:'s',workspaceId:'w',displayName:'Late'}],grants:[]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.clientDirectAccess,access);assert.equal(f.clientPanel.innerHTML,panel);
});
