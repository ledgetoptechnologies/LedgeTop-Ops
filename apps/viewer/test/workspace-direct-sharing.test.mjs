import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as directClientShare from '../workspace-direct-client-share.mjs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
test('public and authenticated client sharing forms constrain intrinsic input widths',()=>{
  const css=readFileSync(new URL('../workspace-management.css',import.meta.url),'utf8');
  assert.match(css,/\.share-dialog-form\{min-width:0;grid-template-columns:minmax\(0,1fr\)\}/);
  assert.match(css,/\.share-dialog-form label,\.share-dialog-form input,\.share-dialog-form select\{min-width:0\}/);
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
const names=['folderPath','pagedApi','loadProjectShareSelectionCatalog','projectShareSelectionCatalog','sameShareSelectionCatalog','editDirectProjectShare','invalidatePublicationAuthority','publicationAuthorityLive','clientAccessDiagnostic','canShareOutput','openShareModal','associationModelId','associationProjectId','portalAccountId',
  'clientProjectKey','clientProjectLabel','clientAccessSnapshot','exactClientAssociations','clientGrantBody','clientSharePanel','legacyClientSharePanel','clientShareCard','directShareContext','directClientShareCard','rerenderClientSharePanel','bindDirectShare','rememberShareResult','clearShareResult','visibleShareResult','shareModal','createOutputShare','clientGrantRevocationMessage','bindShareModal','bindProjectShareCard','publicLinkState','publicTabLabel','shareViewLabels','availableShareViews','shareViewControls','bindShareViewControls','selectedShareViews','shareSettingsSummary','shareExpiryInput','editShareModal','retrieveShareLink','shareFence','publicationAudience','confirmPublication','reopenMovedShare'];

function fixture(permissions=['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']){
  const output={id:'output',modelId:'model',projectId:'project',taskId:'task',attemptId:'attempt',status:'ready',activePublished:false,assetKinds:['glb']};
  const state={token:'signed-in',adminSession:{id:'session',subject:'ops:me',expiresAt:'2099-01-01T00:00:00Z'},projects:[{id:'project',displayName:'Site'}],tasks:[{id:'task',projectId:'project'}],outputs:[output],
    shares:{},sharePreflight:{},projectShares:{},clientAccess:{projects:[],associations:[],grants:[]},shareContext:{id:'context'},lastShareUrl:null};
  const calls=[],notices=[],rendered=[],decisions=[],copyButtons=[];
  let groupsRespond=async()=>({groups:[]}),nativeRespond=async()=>({targets:[],grants:[]}),directRespond=async()=>{throw Object.assign(new Error('Not found'),{status:404})};
  let receipt=async()=>{throw Object.assign(new Error('No saved receipt'),{status:404,code:'share_receipt_missing'})};
  let sequence=0,respond=async(path,options)=>options.method==='POST'
    ?{share:{id:'share',permissions:{view:true,download:false}},viewUrl:'https://viewer.test/view/capability'}
    :path.endsWith('/client-grants')?state.clientAccess:{shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']};
  const document={activeElement:null},clientPanel={innerHTML:''},modal={open:true,close(){this.open=false}},modalContent={
    querySelector:selector=>selector==='.share-columns'?{dataset:{shareContext:state.shareContext?.id}}:selector==='[data-client-share-panel]'?clientPanel:null,
    contains:()=>false,querySelectorAll:selector=>selector==='[data-action="copy-share"]'?copyButtons:[],
  };
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context=vm.createContext({...directClientShare,document,state,modal,modalContent,AbortController,folderCache:new Map(),publicationReads:new Set(),publicationAuthorityGeneration:0,workspaceAuthorizationClearing:false,workspaceRecovery:{isPaused:()=>false},workspaceRenewal:null,crypto:{randomUUID:()=>`request-${++sequence}`},
    can:permission=>permissions.includes(permission),esc,dateTime:value=>value,card:(title,body)=>`<section><h3>${esc(title)}</h3>${body}</section>`,
    empty:text=>`<p>${esc(text)}</p>`,field:(label,name,attrs='')=>`<label>${esc(label)}<input name="${name}" ${attrs}></label>`,
    badge:value=>`<span>${esc(value)}</span>`,button:(action,id,label)=>`<button data-action="${action}" data-id="${id}">${label}</button>`,
    openModal:(title,html)=>{rendered.push({title,html});modal.open=true},injectProjectShareCard:()=>{},
    values:form=>({label:form.elements.label?.value||'',password:form.elements.password?.value||'',expiresAt:form.elements.expiresAt.value}),
    api:async(path,options={})=>{if(options.beforeDispatch)(await options.beforeDispatch())();calls.push({path,options:JSON.parse(JSON.stringify(options))});if(options.headers?.['X-Viewer-Share-Receipt-Only'])return receipt(path,options);return path==='/api/v1/workspace/direct-client-groups'?groupsRespond(path,options):path.startsWith('/api/v1/workspace/direct-client-grants')?directRespond(path,options):path.endsWith('/native-client-grants')?nativeRespond(path,options):respond(path,options)},
    outputFences:new Map(),projectDataGeneration:0,refreshProjectOutputs:async projectId=>{calls.refreshes=[...(calls.refreshes||[]),projectId]},
    mutate:async(...args)=>calls.push({mutation:args}),toast:(...args)=>notices.push(args),navigator:{clipboard:{writeText:async()=>{throw new Error('clipboard denied')}}},
    dialogs:{confirm:async()=>{decisions.push('confirm');return true},form:async()=>null},
  });
  vm.runInContext(names.map(declaration).join('\n'),context);
  const form={dataset:{outputId:'output'},isConnected:true,elements:{label:{value:''},password:{value:''},expiresAt:{value:''},
    measure:{checked:true},cameras:{checked:true},download:{checked:false}},button:{disabled:false},querySelector(){return this.button},
    querySelectorAll(selector){return selector==='input[name="allowedViews"]'?[{checked:true,value:'model'}]:[]}};
  const receipts=()=>calls.filter(call=>call.options?.headers?.['X-Viewer-Share-Receipt-Only']);
  const posts=()=>calls.filter(call=>call.options?.method==='POST'&&!call.options.headers?.['X-Viewer-Share-Receipt-Only']);
  return {context,document,state,output,posts,receipts,calls,notices,rendered,decisions,modal,modalContent,clientPanel,form,copyButtons,
    respondReceipt(fn){receipt=fn},respond(fn){respond=fn},respondPost(fn){const base=respond;respond=(path,options)=>options.method==='POST'?fn(path,options):base(path,options)},respondNative(fn){nativeRespond=fn},respondDirect(fn){directRespond=fn},respondGroups(fn){groupsRespond=fn},html:()=>rendered.at(-1)?.html||''};
}

function projectShareEditFixture(){
  const f=fixture();
  f.state.projects[0].status='active';
  f.state.tasks[0].displayName='North wall';
  f.state.tasks[0].folderId='root';
  f.state.shareContext.projectId='project';
  const grant={grantId:'grant',grantVersion:7,sourceId:'project-alpha:native',workspaceId:'client',viewerProjectId:'project',
    scopeType:'project',taskId:null,includeFuturePublished:true,clientDisplayName:'Acme',revokedAt:null,
    permissions:{measure:false,cameras:true,download:false},expiresAt:'2098-01-02T00:00:00.123Z'};
  f.state.clientDirectAccess={listedProjectId:'project',capabilities:{replaces:true},clients:[],grants:[grant],clientsNextCursor:null};
  const stateControls={status:{},fields:{},mode:{value:'only'},submit:{disabled:false},back:{}};
  const editForm={isConnected:true,elements:{mode:stateControls.mode},
    querySelector:selector=>({
      '[role="status"]':stateControls.status,'[data-edit-share-targets]':stateControls.fields,
      '[data-edit-share-back]':stateControls.back,'button[type="submit"]':stateControls.submit,
    })[selector],
    querySelectorAll:selector=>selector.includes('folder')?[{value:'root',hasAttribute:()=>false}]:[],
  };
  const previousQuery=f.modalContent.querySelector;
  f.modalContent.querySelector=selector=>selector==='#direct-project-share-edit'?editForm:previousQuery(selector);
  f.respond(async path=>path.endsWith('/folders')?{folders:[{id:'root',projectId:'project',parentId:null,displayName:'Main'}]}
    :path.startsWith('/api/v1/tasks?')?{tasks:[f.state.tasks[0]],nextCursor:null}:{});
  const original={dataset:{id:grant.grantId},isConnected:true,disabled:false};
  const submit=()=>editForm.onsubmit({preventDefault(){}});
  return {...f,grant,original,submit,stateControls};
}

test('staff project share editing requires review and reuses the exact request after an uncertain result',async()=>{
  const f=projectShareEditFixture();
  let writes=0;
  f.respondDirect(async (_path,options)=>{
    if(options.method!=='POST')return f.state.clientDirectAccess;
    if(++writes===1)throw new Error('Temporary network failure');
    return {grant:{grantId:'replacement'},sessionRevocation:{pending:true}};
  });
  await f.context.editDirectProjectShare('project',f.original);
  assert.match(f.html(),/Edit client share|Editing access for/);
  assert.match(f.html(),/Main \/ North wall/);
  assert.equal(f.posts().length,0);
  f.context.dialogs.confirm=async text=>{assert.match(text,/replaces.+Acme.+Only “Main”/);return false};
  await f.submit();
  assert.equal(f.posts().length,0);
  f.context.dialogs.confirm=async()=>true;
  await f.submit();
  assert.equal(f.posts().length,1);
  await f.submit();
  assert.equal(f.posts().length,2);
  const [first,second]=f.posts().map(call=>call.options);
  assert.equal(second.headers['Idempotency-Key'],first.headers['Idempotency-Key']);
  assert.deepEqual(second.body,first.body);
  assert.deepEqual(first.body.replaces,[{grantId:'grant',grantVersion:7}]);
  assert.deepEqual(first.body.permissions,f.grant.permissions);
  assert.equal(first.body.expiresAt,f.grant.expiresAt);
  assert.ok(f.notices.some(([notice])=>notice.includes('Revocation of prior sessions is pending')));
});

test('a refused replacement keeps the existing plain error, grants and legacy fallback unchanged',async()=>{
  const f=projectShareEditFixture();
  const before=JSON.stringify(f.state.clientDirectAccess.grants),legacy=JSON.stringify(f.state.clientAccess);
  f.respondDirect(async (_path,options)=>{
    if(options.method!=='POST')return f.state.clientDirectAccess;
    throw Object.assign(new Error('Operations rejected the client access request'),{code:'operations_request_failed'});
  });
  await f.context.editDirectProjectShare('project',f.original);
  await f.submit();
  assert.equal(f.stateControls.status.textContent,'Operations rejected the client access request');
  assert.equal(f.stateControls.submit.disabled,false);
  assert.equal(f.stateControls.fields.disabled,false);
  assert.equal(f.stateControls.back.disabled,false);
  assert.equal(f.posts().length,1);
  assert.deepEqual(f.posts()[0].options.body.replaces,[{grantId:'grant',grantVersion:7}]);
  assert.equal(JSON.stringify(f.state.clientDirectAccess.grants),before);
  assert.equal(JSON.stringify(f.state.clientAccess),legacy);
});

test('old lists and fresh capability withdrawal cannot send a replacement from stale access',async()=>{
  for(const stale of [false,true]){
    const f=projectShareEditFixture();
    if(!stale)delete f.state.clientDirectAccess.capabilities;
    f.respondDirect(async()=>({clients:[],grants:[f.grant],clientsNextCursor:null}));
    await f.context.editDirectProjectShare('project',f.original);
    assert.doesNotMatch(f.html(),/Editing access for/);
    assert.equal(f.posts().length,0);
  }
});

test('capability withdrawal before submitting Edit is refreshed and cannot send',async()=>{
  for(const capabilities of [undefined,{replaces:false}]){
    const f=projectShareEditFixture();
    let current=f.state.clientDirectAccess;
    f.respondDirect(async()=>current);
    await f.context.editDirectProjectShare('project',f.original);
    current={...current,capabilities};
    await f.submit();
    assert.equal(f.posts().length,0);
    assert.match(f.stateControls.status.textContent,/shares changed|Access changed/i);
  }
});

test('a list replaced during review cannot send using the earlier capability',async()=>{
  const f=projectShareEditFixture();
  f.respondDirect(async()=>f.state.clientDirectAccess);
  await f.context.editDirectProjectShare('project',f.original);
  f.context.dialogs.confirm=async()=>{
    f.state.clientDirectAccess={clients:[],grants:[f.grant]};return true;
  };
  await f.submit();
  assert.equal(f.posts().length,0);
});

test('a changed project-share version requires a fresh access list before another edit',async()=>{
  const f=projectShareEditFixture();
  f.respondDirect(async (_path,options)=>{
    if(options.method!=='POST')return f.state.clientDirectAccess;
    throw Object.assign(new Error('Share changed'),{code:'share_changed'});
  });
  await f.context.editDirectProjectShare('project',f.original);
  await f.submit();
  assert.equal(f.posts().length,1);
  assert.equal(f.stateControls.submit.disabled,true);
  assert.equal(f.stateControls.back.disabled,false);
  assert.match(f.stateControls.status.textContent,/Return to the access list/);
  await f.submit();
  assert.equal(f.posts().length,1);
});

test('the workspace API accepts committed replacement replays and pending revocations with the dispatch guard',async()=>{
  const cases=[
    {status:200,payload:{grant:{grantId:'replacement'},sessionRevocation:{pending:false}}},
    {status:202,payload:{grant:{grantId:'replacement'},sessionRevocation:{pending:true}}},
  ];
  const events=[];
  const scope=vm.createContext({
    state:{token:'synthetic',adminSession:{id:'same'}},workspaceRecovery:{wait:async()=>{}},workspaceRenewal:null,
    fetch:async(path,request)=>{
      events.push(['dispatch',path,request.headers['Idempotency-Key']]);
      const {status,payload}=cases.shift();
      return Response.json(payload,{status});
    },
  });
  vm.runInContext(declaration('workspaceFetch')+'\n'+declaration('api'),scope);
  const path='/api/v1/workspace/direct-client-grants';
  const options={method:'POST',headers:{'Idempotency-Key':'replacement-key'},
    beforeDispatch:()=>()=>events.push(['authority verified'])};
  assert.deepEqual(await scope.api(path,options),{grant:{grantId:'replacement'},sessionRevocation:{pending:false}});
  assert.deepEqual(await scope.api(path,options),{grant:{grantId:'replacement'},sessionRevocation:{pending:true}});
  assert.deepEqual(events,[
    ['authority verified'],['dispatch',path,'replacement-key'],
    ['authority verified'],['dispatch',path,'replacement-key'],
  ]);
});

test('public link creation still requires its exact committed response',async()=>{
  const scope=vm.createContext({
    state:{token:'synthetic'},workspaceFetch:async()=>Response.json({share:{id:'link'}},{status:200}),
  });
  vm.runInContext(declaration('api'),scope);
  await assert.rejects(scope.api('/api/v1/processing/outputs/model/shares',{
    method:'POST',headers:{'Idempotency-Key':'link-key'},publicShareCreate:true,
  }),/link request outcome could not be read/);
});

test('a confirmed edit is discarded if sharing authority is paused while the review is open',async()=>{
  const f=projectShareEditFixture();
  f.respondDirect(async()=>f.state.clientDirectAccess);
  await f.context.editDirectProjectShare('project',f.original);
  f.context.dialogs.confirm=async()=>{f.context.invalidatePublicationAuthority();return true};
  await f.submit();
  assert.equal(f.posts().length,0);
  assert.match(f.stateControls.status.textContent,/Access changed while reviewing/);
});

test('publication preview reads current folder placement for saved selections',async()=>{
  const f=fixture();
  f.respondDirect(async()=>({clients:[],grants:[
    {sourceId:'source',workspaceId:'allow',viewerProjectId:'project',scopeType:'project',clientDisplayName:'Allowed client',
      selection:{version:1,mode:'only',folderIds:['root'],taskIds:[]}},
    {sourceId:'source',workspaceId:'leave-out',viewerProjectId:'project',scopeType:'project',clientDisplayName:'Other client',
      selection:{version:1,mode:'except',folderIds:['root'],taskIds:[]}},
  ]}));
  let folderId='nested';
  f.respond(async path=>{
    if(path==='/api/v1/tasks/task')return {task:{id:'task',projectId:'project',folderId}};
    if(path==='/api/v1/projects/project/folders')return {folders:[
      {id:'root',projectId:'project',parentId:null},{id:'nested',projectId:'project',parentId:'root'},
    ]};
    return f.state.clientAccess;
  });
  const inside=await f.context.publicationAudience(f.output,'project');
  assert.equal(inside.text,'Publishing this task shows it to Allowed client.');
  assert.equal(inside.complete,true);
  folderId=null;
  const outside=await f.context.publicationAudience(f.output,'project');
  assert.equal(outside.text,'Publishing this task shows it to Other client.');
  assert.equal(f.calls.filter(call=>call.path==='/api/v1/tasks/task').length,2);
  assert.equal(f.posts().length,0);
});

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
  if(changed==='context')f.state.shareContext={id:'replacement'};if(changed==='token')f.state.token='replacement';if(changed==='subject')f.state.adminSession={...f.state.adminSession,subject:'replacement'};
  settleOutput();settleProject();await opening;
  assert.equal(f.state.sharePreflight.output,undefined);assert.equal(f.state.shares.output,undefined);assert.equal(f.state.projectShares.project,undefined);
  assert.equal(f.rendered.length,1);
});

test('dedicated ready sharing offers explicit link creation without publish UX or whole-project form',async()=>{
  const f=fixture();await f.context.openShareModal('project','output');
  assert.match(f.html(),/Create public link/);assert.match(f.html(),/This model is private/);
  assert.doesNotMatch(f.html(),/Review & publish|publish-attempt|project-share-form|name="wholeProject"/);
  assert.match(f.html(),/Optional password/);
  assert.match(f.html(),/Downloads, including model report/);
  assert.match(f.html(),/Direct Operations client sharing is not available/);
  assert.doesNotMatch(f.html(),/No Operations account|Links follow/);
  assert.match(f.html(),/class="segmented-tabs" role="tablist"[^>]*><button[^>]*data-share-mode="internal".*data-share-mode="public"/);
  assert.match(f.html(),/data-share-mode="internal" role="tab"[^>]*aria-selected="true"/);
  assert.match(f.html(),/data-share-mode-panel="public"[^>]* hidden/);
  assert.equal(f.calls.every(call=>!call.options.method||call.options.method==='GET'),true);
});

test('creating a link for a private model says clients with the whole project get it too, and a task Share never offers the project first',async()=>{
  const f=fixture();f.state.tasks[0].displayName='North wall';f.respondDirect(async()=>({clients:[],grants:[],clientsNextCursor:null}));
  await f.context.openShareModal('project','output');await new Promise(resolve=>setImmediate(resolve));
  const html=f.html()+f.clientPanel.innerHTML;
  assert.match(html,/This model is private\. Create public link publishes it, which also shows this task to every client who has the whole project\./);
  assert.match(html,/“North wall” is not published yet/);assert.doesNotMatch(html,/name="scope" value="project" checked/);
  f.state.sharePreflight.output={existingAccessUpdateRequired:true,eligibleAssetKinds:['glb']};f.context.shareModal('project','output');
  assert.match(f.html(),/shows this task to every client who has the whole project\. Confirmation is required/);
  let asked='';f.context.dialogs.confirm=async text=>{asked=text;return false};await f.context.confirmPublication(f.output,'project',true,f.context.shareFence(f.form,f.output,'project'));
  assert.match(asked,/clients who have the whole project also get newly activated tasks/);
  Object.assign(f.output,{status:'published',activePublished:true});f.state.sharePreflight={};f.context.shareModal('project','output');
  assert.doesNotMatch(f.html(),/Links follow/);assert.doesNotMatch(f.html(),/not published yet/);
});

for(const gone of ['output row','task','task moved to another project','every row'])for(const when of ['before the client panel is built','before a later panel rebuild'])
test(`a task Share never becomes a project Share when its target disappears: ${gone}, ${when}`,async()=>{
  const f=fixture();Object.assign(f.output,{status:'published',activePublished:true});f.state.tasks[0].displayName='North wall';
  // Another task stays shareable, so falling back to the project form would look normal.
  f.state.tasks.push({id:'other',projectId:'project',displayName:'South wall'});
  const other={id:'other-output',taskId:'other',projectId:'project',status:'published',activePublished:true};f.state.outputs.push(other);
  const grants=[{grantId:'g-1',viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,clientDisplayName:'Acme',expiresAt:null}];let direct;
  f.respondDirect(()=>new Promise(resolve=>{direct=()=>resolve({clients:[],grants,clientsNextCursor:null})}));
  await f.context.openShareModal('project','output');
  const vanish=()=>{
    if(gone==='output row')f.state.outputs=[other];
    else if(gone==='task')f.state.tasks=f.state.tasks.slice(1);
    else if(gone==='every row'){f.state.outputs=[];f.state.tasks=[]}
    else f.state.tasks=[{...f.state.tasks[0],projectId:'elsewhere'},f.state.tasks[1]];
  };
  const before=when==='before the client panel is built';if(before)vanish();
  direct();await new Promise(resolve=>setImmediate(resolve));
  if(!before){
    assert.match(f.clientPanel.innerHTML,/name="scope" value="tasks" checked/);assert.match(f.clientPanel.innerHTML,/value="task" checked> North wall/);
    vanish();f.context.rerenderClientSharePanel('project','output');
  }
  const html=f.clientPanel.innerHTML;
  assert.match(html,/no longer in this project/);assert.doesNotMatch(html,/direct-client-grant-form|name="scope"|The whole project<\/label>/);
  assert.match(html,/data-action="revoke-direct-client-grant" data-id="g-1"/,'existing access can still be revoked');
  assert.equal(f.calls.some(call=>call.options?.method==='POST'),false);
});
test('a task Share opened without its model row offers no form, and a form already open sends nothing once its task is gone',async()=>{
  const f=fixture();f.state.outputs=[];f.respondDirect(async()=>({clients:[],grants:[],clientsNextCursor:null}));
  await f.context.openShareModal('project','output');await new Promise(resolve=>setImmediate(resolve));
  assert.match(f.html()+f.clientPanel.innerHTML,/no longer in this project/);assert.doesNotMatch(f.html()+f.clientPanel.innerHTML,/name="scope"/);

  const g=fixture();Object.assign(g.output,{status:'published',activePublished:true});g.state.clientDirectAccess={clients:[],grants:[]};
  g.state.shareContext={id:'context',projectId:'project',taskId:'task',taskName:'North wall'};
  g.context.bindClientPicker=(_root,options)=>{options.onSelect({sourceId:'s',workspaceId:'w',displayName:'Acme'});return{dispose(){}}};
  const summary={textContent:''},review={hidden:true},reviewButton={hidden:false},box={dataset:{},onclick:null,textContent:'',focus(){}};
  const form={isConnected:true,elements:{client:{value:JSON.stringify(['s','w'])},includeLater:{checked:true,disabled:true},expiresAt:{value:''},measure:{checked:true},cameras:{checked:false},download:{checked:false}},
    querySelector:selector=>({'[data-direct-summary]':summary,'[data-direct-review]':review,'[data-direct-review-button]':reviewButton,'input[name="scope"]:checked':{value:'tasks'}})[selector]||box,
    querySelectorAll:selector=>selector==='input[name="taskId"]'?[{value:'task',checked:true}]:[]};
  g.context.bindDirectShare(form,'project','output');
  await form.onsubmit({preventDefault(){}});assert.equal(form.reviewing,true,'the form works while its task is there');
  g.state.outputs=[];await form.onsubmit({preventDefault(){}});
  assert.equal(summary.textContent,directClientShare.SHARE_TARGET_MISSING);assert.equal(g.calls.some(call=>call.options?.method==='POST'),false);
  g.state.outputs=[g.output];await form.onsubmit({preventDefault(){}});
  g.state.tasks=[];await form.onsubmit({preventDefault(){}});
  assert.equal(g.calls.some(call=>call.options?.method==='POST'),false);
});
test('a task unpublished before or during the review sends nothing and is named',async()=>{
  for(const when of ['reading','reviewed']){
    const g=fixture();Object.assign(g.output,{status:'published',activePublished:true});g.state.clientDirectAccess={clients:[],grants:[]};
    g.state.tasks[0].displayName='North wall';g.state.shareContext={id:'context',projectId:'project',taskId:'task',taskName:'North wall'};
    g.context.bindClientPicker=(_root,options)=>{options.onSelect({sourceId:'s',workspaceId:'w',displayName:'Acme'});return{dispose(){}}};
    const unpublish=()=>{g.state.outputs=[{...g.output,status:'ready',activePublished:false}]};
    g.context.refreshProjectOutputs=async()=>{if(when==='reading')unpublish();return true};
    const summary={textContent:''},box={dataset:{},focus(){}};
    const form={isConnected:true,elements:{client:{value:JSON.stringify(['s','w'])},includeLater:{checked:false,disabled:true},expiresAt:{value:''},measure:{checked:true},cameras:{checked:true},download:{checked:true}},
      querySelector:selector=>({'[data-direct-summary]':summary,'input[name="scope"]:checked':{value:'tasks'}})[selector]||box,
      querySelectorAll:selector=>selector==='input[name="taskId"]'?[{value:'task',checked:true}]:[]};
    g.context.bindDirectShare(form,'project','output');
    await form.onsubmit({preventDefault(){}});
    if(when==='reviewed'){assert.equal(form.reviewing,true);unpublish();await form.onsubmit({preventDefault(){}})}
    assert.ok(!form.reviewing);assert.match(summary.textContent,/“North wall” can no longer be shared/);
    assert.equal(g.calls.filter(call=>call.options?.method==='POST').length,0);
  }
});
test('a project Share is unaffected by task rows coming and going',async()=>{
  const f=fixture();f.respondDirect(async()=>({clients:[],grants:[],clientsNextCursor:null}));f.state.outputs=[];f.state.tasks=[];
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.html()+f.clientPanel.innerHTML;
  assert.match(html,/name="scope" value="project" checked/);assert.doesNotMatch(html,/no longer in this project/);
});

async function firstProjectShare(mode,loadFolders,loadTasks=readyTasks,recipient={sourceId:'s',workspaceId:'w',displayName:'Acme'}){
  const f=fixture();
  f.state.tasks=[
    {id:'task-z',projectId:'project',folderId:'folder-z',displayName:'Stale task name'},
    {id:'task-stale',projectId:'project',folderId:null,displayName:'Removed task'},
  ];
  f.context.folderCache.set('project',{folders:[{id:'cached',displayName:'Stale folder'}]});
  f.respond(path=>path.endsWith('/folders')?loadFolders():path.startsWith('/api/v1/tasks?')?loadTasks(path):{shares:[]});
  f.respondDirect(async()=>({clients:[],grants:[],grantsNextCursor:null}));
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));

  f.context.bindClientPicker=(_root,options)=>{options.onSelect(recipient);return {dispose(){}}};
  const controls={
    '[data-direct-summary]':{},'[data-direct-share-targets]':{},'[data-direct-review]':{},
    '[data-direct-review-button]':{},'[data-direct-review-text]':{},'[data-direct-back]':{},
    '[data-direct-send]':{focus(){}},'[data-client-picker]':{},'input[name="scope"]:checked':{value:'project'},
  };
  const selected=ids=>ids.map(value=>({value,hasAttribute:()=>false}));
  const choices={
    [`input[name="folder"]${mode==='except'?':not(:checked)':':checked'}`]:selected(['folder-z','folder-a']),
    [`input[name="task"]${mode==='except'?':not(:checked)':':checked'}`]:selected(['task-z','task-a']),
  };
  const form={isConnected:true,elements:{mode:{value:mode},client:{value:directClientShare.directClientKey(recipient)},
    includeLater:{checked:true},confirmedScope:{checked:false},expiresAt:{value:'2098-01-02T03:04'},
    measure:{checked:false},cameras:{checked:true},download:{checked:false}},
    querySelector:selector=>controls[selector]||null,querySelectorAll:selector=>choices[selector]||[]};
  f.context.bindDirectShare(form,'project',null);
  form.elements.confirmedScope.checked=true;
  return {...f,form,controls,choices,submit:()=>form.onsubmit({preventDefault(){}})};
}

const readyFolders=()=>({folders:[
  {id:'folder-z',projectId:'project',parentId:'folder-a',displayName:'South'},
  {id:'folder-a',projectId:'project',parentId:null,displayName:'Site'},
]});
const readyTasks=path=>path.includes('cursor=next-page')
  ?{tasks:[{id:'task-a',projectId:'project',folderId:null,displayName:'Roof'}],nextCursor:null}
  :{tasks:[{id:'task-z',projectId:'project',folderId:'folder-z',displayName:'Wall'}],nextCursor:'next-page'};

async function nestedFirstShare(mode){
  let moved=false;
  const f=await firstProjectShare('whole',readyFolders,path=>{
    const page=readyTasks(path);
    return moved?{...page,tasks:page.tasks.map(task=>({...task,folderId:null}))}:page;
  });
  const inputs={folder:['folder-a','folder-z'],task:['task-a','task-z']};
  for(const name of Object.keys(inputs))inputs[name]=inputs[name].map(value=>({name,value,checked:false,disabled:false,dataset:{},hasAttribute:()=>false}));
  const original=f.form.querySelectorAll;
  f.form.querySelectorAll=selector=>{
    if(selector==='input[name="folder"],input[name="task"]')return [...inputs.folder,...inputs.task];
    const match=/^input\[name="(folder|task)"\](.*)$/.exec(selector);
    if(match)return inputs[match[1]].filter(input=>match[2]===':checked'?input.checked:match[2]===':not(:checked)'?!input.checked:true);
    return original(selector);
  };
  f.form.elements.mode.value=mode;f.form.onchange();
  return {...f,inputs,move(){moved=true}};
}
for(const mode of ['only','except'])test(`first-share ${mode} locks nested ticks to ancestor precedence and restores direct choices`,async()=>{
  const f=await nestedFirstShare(mode),selected=mode==='only';
  const [root,child]=f.inputs.folder,task=f.inputs.task[1];
  child.checked=selected;f.form.onchange();
  root.checked=selected;f.form.onchange();
  assert.equal(task.checked,selected,'nested task ticks must agree with their ancestor');
  assert.equal(child.checked,selected);assert.equal(child.disabled,true);
  assert.equal(task.disabled,true);
  // Disabled is cosmetic: a contradictory tick must not become an explicit request ID.
  task.checked=!selected;
  await f.submit();assert.equal(f.form.reviewing,true);
  assert.match(f.controls['[data-direct-review-text]'].innerHTML,/“Site”/);
  f.controls['[data-direct-back]'].onclick();
  assert.equal(task.checked,selected);
  root.checked=!selected;f.form.onchange();
  assert.equal(child.disabled,false);assert.equal(child.checked,selected,'intentional child choice is restored');
  assert.equal(task.disabled,true,'the direct child folder still controls its task');
  child.checked=!selected;f.form.onchange();
  assert.equal(task.disabled,false);assert.equal(task.checked,!selected);
  root.checked=selected;f.form.onchange();
  await f.submit();await f.submit();
  assert.deepEqual(f.posts().map(call=>call.options.body.selection),[{version:1,mode,folderIds:['folder-a'],taskIds:[]}]);
});
for(const mode of ['only','except'])test(`first-share ${mode} blocks a task moved after nested selection review`,async()=>{
  const f=await nestedFirstShare(mode);
  f.inputs.folder[0].checked=mode==='only';f.form.onchange();
  await f.submit();assert.equal(f.form.reviewing,true);
  f.move();await f.submit();
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/changed.*Close and reopen Share.*review/);
});

const {createClientGrantProxy}=createRequire(import.meta.url)('../server/clientGrantProxy.js');
const syntheticRecipient={sourceId:'project-alpha:synthetic',workspaceId:'synthetic-client',displayName:'Synthetic client'};
const syntheticFolder='00000000-0000-4000-8000-000000000001';
const syntheticTask='00000000-0000-4000-8000-000000000002';
// Captured at Viewer 913d4a31 and accepted by the strict grant schema at
// Operations 4a1c05e6. Convert only the datetime-local field for the host TZ.
const legacyWholeBody=`{"sourceId":"project-alpha:synthetic","workspaceId":"synthetic-client","viewerProjectId":"project","permissions":{"measure":false,"cameras":true,"download":false},"expiresAt":"${new Date('2098-01-02T03:04').toISOString()}","confirmedScope":true,"taskId":null,"scopeType":"project","includeFuturePublished":true}`;
const legacyWholeEnvelope=`{"subject":"ops:synthetic","action":"create","connection":"direct","idempotencyKey":"synthetic-first-share-key-0001","grant":${legacyWholeBody}}`;
async function legacyContractShare(mode,{rejection=null}={}){
  const f=await firstProjectShare(mode,
    ()=>({folders:[{id:syntheticFolder,projectId:'project',parentId:null,displayName:'Synthetic folder'}]}),
    ()=>({tasks:[{id:syntheticTask,projectId:'project',folderId:syntheticFolder,displayName:'Synthetic task'}],nextCursor:null}),
    syntheticRecipient);
  for(const key of Object.keys(f.choices))delete f.choices[key];
  const suffix=mode==='except'?':not(:checked)':':checked';
  f.choices[`input[name="folder"]${suffix}`]=[{value:syntheticFolder,hasAttribute:()=>false}];
  f.choices[`input[name="task"]${suffix}`]=[{value:syntheticTask,hasAttribute:()=>false}];

  const wire=[],envelopes=[],responses=[],routes=new Map();
  createClientGrantProxy({
    config:{opsAutomationBaseUrl:'https://synthetic.example.test',viewerEventSecret:'s'.repeat(32),viewerEventKeyId:'synthetic'},
    authorize:()=>()=>{},diagnostic(){},
    fetchImpl:async(_url,init)=>{
      envelopes.push(init.body);
      const envelope=JSON.parse(init.body);
      // Simulate the older Worker boundary with the captured accepted envelope.
      if(rejection)return Response.json(rejection.payload,{status:rejection.status});
      if(init.body!==legacyWholeEnvelope)return Response.json({error:'Viewer client-grant request is invalid'},{status:400});
      const {confirmedScope,...scope}=envelope.grant;
      return Response.json({grant:{...scope,grantId:'synthetic-grant',grantVersion:1,revokedAt:null,
        createdAt:'2026-01-01T00:00:00Z',clientDisplayName:syntheticRecipient.displayName},replayed:false},{status:201});
    },
  }).mount(Object.fromEntries(['get','post','delete'].map(method=>[method,(path,...handlers)=>routes.set(`${method.toUpperCase()} ${path}`,handlers.at(-1))])));
  const originalApi=f.context.api;
  f.context.fetch=async(path,init)=>{
    wire.push({path,method:init.method,body:init.body});
    const handler=routes.get(`${init.method} ${path}`);assert.ok(handler,'no alternate grant endpoint');
    let status=200,response;
    const res={set(){return this},status(value){status=value;return this},json(payload){response=Response.json(payload,{status});return this}};
    await handler({adminPrincipal:{subject:'ops:synthetic'},body:JSON.parse(init.body),get:name=>init.headers[name]},res);
    responses.push({status:response.status,payload:await response.clone().json()});return response;
  };
  f.context.clearWorkspaceAuthorization=()=>{};
  f.context.workspaceRecovery.wait=async()=>{};
  vm.runInContext(['responseError','workspaceFetch','api'].map(declaration).join('\n'),f.context);
  const shippedApi=f.context.api;
  f.context.api=(path,options={})=>options.method==='POST'?shippedApi(path,options):originalApi(path,options);
  f.context.crypto.randomUUID=()=> 'synthetic-first-share-key-0001';
  await f.submit();assert.equal(f.form.reviewing,true);assert.equal(wire.length,0);
  await f.submit();
  return {...f,wire,envelopes,responses};
}

test('Everything first-share outgoing JSON bytes equal the pinned legacy request and succeed on the old schema',async()=>{
  const current=await legacyContractShare('whole');
  assert.equal(current.wire.length,1);assert.equal(current.envelopes.length,1);
  assert.equal(current.wire[0].body,legacyWholeBody);
  assert.equal(current.envelopes[0],legacyWholeEnvelope);
  assert.equal(Object.hasOwn(JSON.parse(current.wire[0].body),'selection'),false);

  assert.equal(current.responses[0].status,201);
  assert.ok(current.notices.some(([text,error])=>text==='Shared with the client'&&!error));
});
for(const mode of ['except','only'])test(`old Operations refuses first-share ${mode} once with selection, without broadening or another grant endpoint`,async()=>{
  const f=await legacyContractShare(mode);
  assert.equal(f.wire.length,1);assert.equal(f.envelopes.length,1);
  assert.equal(f.wire[0].path,directClientShare.DIRECT_CLIENT_GRANTS_PATH);
  const body=JSON.parse(f.wire[0].body);
  assert.deepEqual(body.selection,{version:1,mode,folderIds:[syntheticFolder],taskIds:[]});
  assert.equal(Object.hasOwn(body,'replaces'),false);
  assert.equal(JSON.parse(f.envelopes[0]).action,'create');
  assert.deepEqual(JSON.parse(f.envelopes[0]).grant,body);
  assert.equal(f.responses[0].status,400);
  assert.equal(f.responses[0].payload.code,'operations_selection_unsupported');
  assert.match(f.controls['[data-direct-summary]'].textContent,/Operations must be updated.*Nothing was shared/);
  assert.ok(f.notices.some(([text,error])=>error&&/Operations must be updated/.test(text)));
  assert.equal(f.form.reviewing,false);assert.equal(f.form.elements.mode.value,mode);
  assert.equal(f.wire.length,1);
});
for(const [mode,status,payload,expected] of [
  ['whole',400,{error:'Viewer client-grant request is invalid'},'Operations rejected the client access request'],
  ['only',400,{error:'Different legacy error'},'Operations rejected the client access request'],
  ['only',400,{error:'Invalid details',code:'invalid_request'},'Some of the details were not accepted. Check them and try again.'],
  ['only',401,{error:'Unauthorized'},'authorization_required'],
  ['except',403,{error:'Forbidden'},'Your current Viewer grant does not permit this action'],
  ['only',409,{error:'Unavailable',code:'relationship_missing'},'This client is not connected to Ledge Top yet, so nothing was shared.'],
  ['except',429,{error:'Too many requests'},'Operations rejected the client access request'],
  ['only',503,{error:'Unavailable'},'Operations rejected the client access request'],
])test(`first-share ${mode} preserves existing error behavior for HTTP ${status}`,async()=>{
  const f=await legacyContractShare(mode,{rejection:{status,payload}});
  assert.equal(f.wire.length,1);assert.equal(f.envelopes.length,1);
  assert.equal(f.responses[0].status,status>=500?502:status);
  assert.equal(f.controls['[data-direct-summary]'].textContent,expected);
  assert.ok(f.notices.some(([text,error])=>error&&text===expected));
});
test('first-share mode changes start Except ticked and Only unticked, without resetting choices on other changes',async()=>{
  const f=await nestedFirstShare('except');
  const inputs=[f.inputs.folder[1],f.inputs.task[0]];
  assert.deepEqual(inputs.map(input=>input.checked),[true,true]);
  inputs[0].checked=false;f.form.onchange();
  assert.deepEqual(inputs.map(input=>input.checked),[false,true]);
  f.form.elements.mode.value='only';f.form.onchange();
  assert.deepEqual(inputs.map(input=>input.checked),[false,false]);
});
for(const mode of ['only','except'])test(`first-issued ${mode} project access sends the exact reviewed selection without replacements`,async()=>{
  const f=await firstProjectShare(mode,readyFolders);
  assert.equal(f.calls.filter(call=>call.path==='/api/v1/projects/project/folders').length,1);
  assert.match(f.html()+f.clientPanel.innerHTML,/Site \/ South \/ Wall/);
  assert.doesNotMatch(f.html()+f.clientPanel.innerHTML,/Stale folder|Stale task name|Removed task/);
  assert.equal(f.controls['[data-direct-share-targets]'].hidden,false);
  await f.submit();
  assert.equal(f.form.reviewing,true);
  const review=f.controls['[data-direct-review-text]'].innerHTML;
  assert.match(review,mode==='only'?/Only “Site”, “Roof”/
    :/Whole project except “Site”, “Roof”/);
  assert.match(review,/matching tasks published later.+see camera positions.+<dt>Ends<\/dt>/);
  assert.match(review,/Workspace w/);
  assert.equal(f.posts().length,0);
  await f.submit();
  assert.deepEqual(f.posts().map(call=>call.options.body),[{
    sourceId:'s',workspaceId:'w',viewerProjectId:'project',taskId:null,scopeType:'project',includeFuturePublished:true,
    permissions:{measure:false,cameras:true,download:false},expiresAt:new Date('2098-01-02T03:04').toISOString(),confirmedScope:true,
    selection:{version:1,mode,folderIds:['folder-a'],taskIds:['task-a']},
  }]);
  assert.equal(f.calls.filter(call=>call.path==='/api/v1/projects/project/folders').length,2);
  assert.equal(f.calls.filter(call=>call.path.includes('projectId=project&limit=100&cursor=next-page')).length,2);
});

for(const [label,loadFolders] of [
  ['failed',()=>{throw new Error('Folder service unavailable')}],
  ['incomplete',()=>({folders:readyFolders().folders.slice(0,1)})],
])test(`a ${label} fresh folder read cannot fall back to cached choices or a whole share`,async()=>{
  const f=await firstProjectShare('except',loadFolders);
  const html=f.html()+f.clientPanel.innerHTML;
  assert.match(html,/value="except"\s+disabled/);
  assert.match(html,/Folders and tasks could not be verified/);
  assert.doesNotMatch(html,/Stale folder/);
  await f.submit();
  assert.equal(Boolean(f.form.reviewing),false);
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/could not be verified/);
});

test('changing selected access to whole during review sends nothing',async()=>{
  const f=await firstProjectShare('only',readyFolders);
  await f.submit();
  assert.equal(f.form.reviewing,true);
  f.form.elements.mode.value='whole';
  await f.submit();
  assert.equal(f.form.reviewing,false);
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/Something changed since the review/);
});

for(const [label,updateTasks] of [
  ['missing task folder',page=>({...page,tasks:page.tasks.map(task=>({...task,folderId:'unlisted-folder'}))})],
  ['duplicate task',page=>({...page,tasks:[...page.tasks,...page.tasks]})],
  ['missing task page',page=>({nextCursor:page.nextCursor})],
])test(`a project catalog with a ${label} cannot offer or send a selection`,async()=>{
  const f=await firstProjectShare('only',readyFolders,path=>updateTasks(readyTasks(path)));
  assert.match(f.html()+f.clientPanel.innerHTML,/value="only"\s+disabled/);
  await f.submit();
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/could not be verified/);
});

for(const [label,updateTasks] of [
  ['task moves out of a selected folder',page=>({...page,tasks:page.tasks.map(task=>({...task,folderId:null}))})],
  ['selected task is renamed',page=>({...page,tasks:page.tasks.map(task=>({...task,displayName:'Changed task'}))})],
])test(`a reviewed Except share sends nothing when a ${label}`,async()=>{
  let changed=false;
  const f=await firstProjectShare('except',readyFolders,path=>{
    const page=readyTasks(path);
    return changed?updateTasks(page):page;
  });
  await f.submit();
  assert.equal(f.form.reviewing,true);
  changed=true;
  await f.submit();
  assert.equal(f.form.reviewing,false);
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/changed.*Close and reopen Share/);
});

test('a scoped first issuance ignores a matching catalog returned after the signed-in subject changed',async()=>{
  let resumeFolders,refreshStarted=false;
  const f=await firstProjectShare('only',()=>refreshStarted
    ?new Promise(resolve=>{resumeFolders=resolve}):readyFolders());
  await f.submit();
  refreshStarted=true;
  const sending=f.submit();
  assert.equal(typeof resumeFolders,'function');
  f.state.adminSession={...f.state.adminSession,subject:'ops:other'};
  resumeFolders(readyFolders());
  await sending;
  assert.equal(f.posts().length,0);
  assert.match(f.controls['[data-direct-summary]'].textContent,/Access changed while reviewing/);
});

const grantFor=(clientDisplayName,extra={})=>({grantId:clientDisplayName,sourceId:'s',workspaceId:clientDisplayName,viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,expiresAt:null,clientDisplayName,...extra});
function askFixture(grants){
  const f=fixture(),asked=[];f.direct=grants;f.legacy=async()=>({projects:[],associations:[],grants:[]});
  f.context.dialogs.confirm=async(text,{signal,...options})=>{asked.push({text,options});f.onAsk?.(asked.length);return f.answer!==false};
  f.respondDirect(async()=>({clients:[],grants:f.direct,clientsNextCursor:null,grantsNextCursor:null}));
  const base=f.context.api;f.context.api=(path,options)=>path==='/api/v1/workspace/client-grants'?(f.calls.push({path,options:{}}),f.legacy()):base(path,options);
  return Object.assign(f,{asked});
}
test('a link that publishes a task names the clients who will see it, and cancelling sends nothing',async()=>{
  const past='2020-01-01T00:00:00Z',f=askFixture([grantFor('North Farm'),grantFor('Acme'),grantFor('Acme'),grantFor('Ended',{expiresAt:past}),grantFor('Revoked',{revokedAt:past}),
    grantFor('Elsewhere',{viewerProjectId:'other'}),grantFor('Same task',{scopeType:'task',taskId:'task'}),grantFor('Other task',{scopeType:'task',taskId:'other'})]);
  f.answer=false;await f.context.createOutputShare(f.form,'project','output');
  assert.deepEqual(f.asked,[{text:'Publishing this task shows it to Acme, North Farm and Same task.',options:{title:'Publish this task?',submitLabel:'Publish and create link'}}]);
  assert.equal(f.posts().length,0);assert.equal(f.output.activePublished,false);assert.equal(f.form.button.disabled,false);
  f.answer=true;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked.length,2,'a cancelled publication is asked again');assert.equal(f.posts().length,1);
  assert.equal(f.posts()[0].options.body.publishIfReady,true);assert.equal(f.posts()[0].options.body.allowExistingAccessUpdate,undefined,'naming clients is not consent to change existing links');
  assert.equal(f.posts()[0].options.body.expectedProjectId,'project');
  assert.ok(f.calls.some(call=>/include=grants/.test(call.path||'')));assert.equal(f.calls.some(call=>/include=(clients|all)/.test(call.path||'')),false,'clients are never listed');
});
test('no client gains the task: no extra question; already published: nothing is read or asked',async()=>{
  const f=askFixture([grantFor('Other task',{scopeType:'task',taskId:'other'})]);await f.context.createOutputShare(f.form,'project','output');
  assert.deepEqual(f.asked,[]);assert.equal(f.posts().length,1);
  const g=askFixture([grantFor('Acme')]);Object.assign(g.output,{status:'published',activePublished:true});await g.context.createOutputShare(g.form,'project','output');
  assert.deepEqual(g.asked,[]);assert.equal(g.calls.length,1);
});
for(const [label,arrange] of [['the read fails',f=>f.respondDirect(async()=>{throw new Error('offline')})],['the answer is malformed',f=>f.respondDirect(async()=>({clients:[]}))],
  ['older Operations shares cannot be read now',f=>{f.legacy=async()=>{throw new Error('down')}}],['older Operations shares are malformed',f=>{f.legacy=async()=>({grants:[]})}],['connected workspaces cannot be read now',f=>f.respondNative(async()=>{throw new Error('down')})]])
test(`unknown access is said and asked, never taken as none: ${label}`,async()=>{
  const f=askFixture([]);arrange(f);f.answer=false;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked[0].text,'Client access could not be checked. Publishing this task shows it to every client who has the whole project.');assert.equal(f.posts().length,0);
});
test('staff who cannot see client shares are told in general terms and nothing is read',async()=>{
  const f=fixture(['viewer.shares.read','viewer.shares.create','viewer.processing.publish']),asked=[];f.context.dialogs.confirm=async text=>{asked.push(text);return true};
  await f.context.createOutputShare(f.form,'project','output');
  assert.match(asked[0],/every client who has the whole project/);assert.equal(f.calls.length,1);
});
test('a partly read list names what it has and says the rest is unknown; long lists are cut',async()=>{
  const f=askFixture([]);f.respondDirect(async()=>({clients:[],grants:[grantFor('Acme')],clientsNextCursor:null,grantsNextCursor:'more'}));f.answer=false;
  await f.context.createOutputShare(f.form,'project','output');
  assert.match(f.asked[0].text,/^Publishing this task shows it to Acme\. Some client access could not be checked/);
  assert.equal(directClientShare.publishAudienceText(['a','b','c','d','e','f','g'],{complete:true}),'Publishing this task shows it to a, b, c, d, e and 2 other clients.');
  assert.equal(directClientShare.publishAudienceText(['a','b','c','d','e','f'],{complete:true}),'Publishing this task shows it to a, b, c, d, e and 1 other client.');
});
test('older and connected Operations shares of the same model are read now, not taken from when Share opened',async()=>{
  const f=askFixture([]);
  // What the dialog loaded when it opened says nobody; that is not used.
  f.state.clientAccess={projects:[],associations:[],grants:[]};f.state.clientNativeAccess={targets:[],grants:[]};
  f.legacy=async()=>({projects:[],associations:[{id:'a1',modelId:'model',projectId:'p1'},{id:'a2',modelId:'other',projectId:'p2'}],grants:[
    {id:'1',scopeType:'task',associationId:'a1',clientName:'Task client',accountId:'acc-1'},{id:'2',scopeType:'project',projectId:'p1',clientName:'Project client',accountId:'acc-2'},
    {id:'3',scopeType:'task',associationId:'a2',clientName:'Other model',accountId:'acc-3'},{id:'4',scopeType:'project',projectId:'p1',clientName:'Gone',status:'revoked',accountId:'acc-4'}]});
  f.respondNative(async()=>({targets:[{sourceId:'s',workspaceId:'w9',projectPublicId:'pp',workspaceName:'Connected client',projectName:'P',associations:[{id:'n1',viewerModelId:'model',modelTitle:'M'}]}],
    grants:[{id:'5',source_id:'s',workspace_id:'w9',project_public_id:'pp',workspace_name:'Connected client',project_name:'P',scope_type:'task',association_id:'n1',status:'active'}]}));
  f.answer=false;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked[0].text,'Publishing this task shows it to Connected client, Project client and Task client.');
  assert.deepEqual(f.state.clientAccess.grants,[],'the open dialog is not rewritten');
});
test('two different clients with one name are told apart; one client in two lists is one',async()=>{
  const f=askFixture([grantFor('Acme',{workspaceId:'workspace-aaa111'}),grantFor('acme',{workspaceId:'workspace-bbb222'}),grantFor('North Farm')]);
  f.respondNative(async()=>({targets:[{sourceId:'s',workspaceId:'North Farm',projectPublicId:'pp',workspaceName:'North Farm',projectName:'P',associations:[{id:'n1',viewerModelId:'model',modelTitle:'M'}]}],
    grants:[{id:'5',source_id:'s',workspace_id:'North Farm',project_public_id:'pp',workspace_name:'North Farm',project_name:'P',scope_type:'task',association_id:'n1',status:'active'}]}));
  f.answer=false;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked[0].text,'Publishing this task shows it to Acme (ref aaa111), acme (ref bbb222) and North Farm.');
});
test('a client added while the question is open is asked about before anything is sent; a client removed is not',async()=>{
  const f=askFixture([grantFor('Acme')]);f.onAsk=count=>{if(count===1)f.direct=[grantFor('Acme'),grantFor('North Farm')]};
  await f.context.createOutputShare(f.form,'project','output');
  assert.deepEqual(f.asked.map(item=>item.text),['Publishing this task shows it to Acme.','Client access changed while you were deciding. Publishing this task shows it to Acme and North Farm.']);
  assert.equal(f.posts().length,1);
  const g=askFixture([grantFor('Acme'),grantFor('North Farm')]);g.onAsk=()=>{g.direct=[grantFor('Acme')]};
  await g.context.createOutputShare(g.form,'project','output');assert.equal(g.asked.length,1);assert.equal(g.posts().length,1);
  const h=askFixture([grantFor('A0')]);h.onAsk=count=>{h.direct=[...h.direct,grantFor(`A${count}`)]};
  await h.context.createOutputShare(h.form,'project','output');
  assert.equal(h.posts().length,0);assert.equal(h.asked.length,3);assert.match(h.notices.at(-1)[0],/keeps changing/);
  const k=askFixture([grantFor('Acme')]);k.onAsk=()=>k.respondDirect(async()=>{throw new Error('down')});k.answers=0;
  await k.context.createOutputShare(k.form,'project','output');
  assert.match(k.asked[1].text,/could not be checked/,'losing the list is a change too');
});
for(const known of [true,false])test(`a task moved to another project while Share is open is never published there unasked: ${known?'already known here':'refused by the server'}`,async()=>{
  const f=askFixture([]);f.state.tasks[0].displayName='North wall';f.state.projects.push({id:'other',displayName:'Other site'});
  const reopened=[];f.context.openShareModal=async(projectId,outputId)=>{reopened.push([projectId,outputId]);f.state.shareContext={id:'new',projectId}};
  const base=f.context.api;f.context.api=(path,options)=>path==='/api/v1/tasks/task'?(f.calls.push({path,options:{}}),Promise.resolve({task:{id:'task',projectId:'other',displayName:'North wall'}})):base(path,options);
  f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409,code:'output_project_changed',receiptRecorded:true})});
  if(known)f.state.tasks=[{...f.state.tasks[0],projectId:'other'}];
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,known?0:1);if(!known)assert.equal(f.posts()[0].options.body.expectedProjectId,'project');
  assert.deepEqual(reopened,[['other','output']]);assert.equal(f.state.shareContext.mode,'public');
  assert.equal(f.state.tasks[0].projectId,'other');assert.equal(f.state.outputs[0].projectId,'other');
  assert.match(f.notices.at(-1)[0],/North wall.*moved to Other site.*Nothing was shared/);assert.equal(f.output.activePublished,false);
});
const changes={
  token:f=>{f.state.token='other'},'signed-in person':f=>{f.state.adminSession={...f.state.adminSession,subject:'ops:other'}},dialog:f=>{f.state.shareContext={id:'another'}},
  'closed dialog':f=>{f.modal.open=false},'replaced form':f=>{f.form.isConnected=false},'share permission':f=>f.permissions.delete('viewer.shares.create'),
  'publish permission':f=>f.permissions.delete('viewer.processing.publish'),'model row':f=>{f.state.outputs=[]},'model task':f=>{f.state.outputs=[{...f.output,taskId:'elsewhere'}]},
  'task row':f=>{f.state.tasks=[]}};
for(const [label,change] of Object.entries(changes))for(const point of ['first read','question','read after the answer','retry check'])
test(`nothing is sent when the ${label} changes during the ${point}`,async()=>{
  const f=askFixture([grantFor('Acme')]);f.state.adminSession={...f.state.adminSession,subject:'ops:me'};
  f.permissions=new Set(['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']);f.context.can=name=>f.permissions.has(name);
  let expected=0;
  if(point==='retry check'){
    f.respondPost(async()=>{throw new Error('network')});await f.context.createOutputShare(f.form,'project','output');expected=1;assert.equal(f.posts().length,1);
    f.respondReceipt(async()=>{change(f);throw Object.assign(new Error('No saved receipt'),{status:404,code:'share_receipt_missing'})});
    f.respondPost(async()=>({share:{id:'share'},viewUrl:'https://viewer.test/view/x'}));
  }else if(point==='question')f.onAsk=()=>change(f);
  else{let reads=0;f.legacy=async()=>{if(++reads===(point==='first read'?1:2))change(f);return{projects:[],associations:[],grants:[]}}}
  const asked=f.asked.length;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,expected);assert.equal(f.output.activePublished,false);assert.equal(f.state.lastShareUrl,null);
  if(point==='first read'||point==='retry check')assert.equal(f.asked.length,asked,'and nothing more is asked');
});
for(const changed of ['token','person'])test(`a link that answers after the ${changed} changed is not kept in the new session`,async()=>{
  const f=askFixture([]);f.state.adminSession={...f.state.adminSession,subject:'ops:me'};
  f.respondPost(async()=>{if(changed==='token')f.state.token='other';else f.state.adminSession={...f.state.adminSession,subject:'ops:other'};return{share:{id:'share'},viewUrl:'https://viewer.test/view/secret'}});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.state.lastShareUrl,null);assert.deepEqual(f.state.shares,{});assert.equal(f.output.activePublished,false);assert.equal(f.rendered.length,0);
});
for(const [label,leave,same] of [
  ['closed',f=>{f.modal.open=false;f.form.isConnected=false},false],
  ['switched to another task',f=>{f.state.shareContext={id:'another',mode:'internal',projectId:'project',onlyOutputId:'other'};f.form.isConnected=false},false],
  ['closed and opened again on the same task',f=>{f.state.shareContext={id:'again',mode:'internal',projectId:'project',onlyOutputId:'output'};f.form.isConnected=false},false],
  ['redrawn by a late read',f=>{f.form.isConnected=false},true]])
test(`a link that answers after its dialog was ${label} is saved for its model and leaves other dialogs alone`,async()=>{
  const f=askFixture([]);f.state.tasks[0].displayName='North wall';f.state.shareContext={id:'mine',mode:'internal',projectId:'project',onlyOutputId:'output'};
  const mine=f.state.shareContext;let done;f.respondPost(()=>new Promise(resolve=>{done=resolve}));
  const pending=f.context.createOutputShare(f.form,'project','output');await new Promise(resolve=>setImmediate(resolve));assert.equal(f.posts().length,1);
  const rendered=f.rendered.length;leave(f);
  done({share:{id:'share',expiresAt:null},viewUrl:'https://viewer.test/view/secret'});await pending;
  // The model's own cache is updated: the link exists and the model is published.
  assert.deepEqual([...f.state.shares.output].map(item=>item.id),['share']);assert.equal(f.state.sharePreflight.output.publicationRequired,false);
  assert.equal(f.output.activePublished,true);assert.equal(f.output.status,'published');
  assert.equal(f.rendered.length,rendered,'no dialog is drawn over');
  if(same){assert.equal(mine.mode,'public');assert.equal(f.state.lastShareUrl,'https://viewer.test/view/secret');}
  else{
    if(f.state.shareContext!==mine)assert.equal(f.state.shareContext.mode,'internal','the open dialog keeps its tab');
    assert.equal(mine.mode,'internal');assert.equal(f.state.lastShareUrl,null);assert.equal(f.state.lastShareResult,undefined);
    assert.match(f.notices.at(-1)[0],/Public link created for North wall/);assert.doesNotMatch(f.notices.at(-1)[0],/Use Copy/);
  }
});
test('a refusal for a moved task, after its dialog closed, still says nothing was shared',async()=>{
  const f=askFixture([]);f.state.tasks[0].displayName='North wall';let reopened=0;f.context.openShareModal=async()=>{reopened++};
  f.respondPost(async()=>{f.modal.open=false;f.form.isConnected=false;throw Object.assign(new Error('output_project_changed'),{status:409,code:'output_project_changed',receiptRecorded:true})});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(reopened,0);assert.match(f.notices.at(-1)[0],/North wall moved to another project\. Nothing was shared/);
});
test('losing the right to see client shares while they are read makes the list incomplete',async()=>{
  const f=askFixture([grantFor('Acme')]);let allowed=true;const base=f.context.can;f.context.can=name=>name==='viewer.client_grants.manage'?allowed:base(name);
  f.legacy=async()=>{allowed=false;return{projects:[],associations:[],grants:[]}};f.answer=false;
  await f.context.createOutputShare(f.form,'project','output');assert.match(f.asked[0].text,/could not be checked/);assert.doesNotMatch(f.asked[0].text,/Acme/);
});
test('a task read for reopening is ignored after the dialog or sign-in changed',async()=>{
  for(const change of [f=>{f.state.shareContext={id:'another'}},f=>{f.state.token='other'}]){
    const f=askFixture([]);let reopened=0;f.context.openShareModal=async()=>{reopened++};
    const base=f.context.api;f.context.api=async(path,options)=>{if(path!=='/api/v1/tasks/task')return base(path,options);change(f);return{task:{id:'task',projectId:'other'}}};
    f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409,code:'output_project_changed',receiptRecorded:true})});
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(reopened,0);assert.equal(f.state.tasks[0].projectId,'project');assert.equal(f.state.outputs[0].projectId,'project');
  }
});
test('a moved task whose project cannot be read closes to sharing with a clear message',async()=>{
  const f=askFixture([]);let reopened=0;f.context.openShareModal=async()=>{reopened++};
  const base=f.context.api;f.context.api=(path,options)=>path==='/api/v1/tasks/task'?Promise.reject(new Error('down')):base(path,options);
  f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409,code:'output_project_changed',receiptRecorded:true})});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(reopened,0);assert.match(f.notices.at(-1)[0],/moved to another project.*Nothing was shared.*Close Share/);
});
test('a retry asks again: refused first attempt, and an uncertain one that did not publish',async()=>{
  const f=askFixture([grantFor('Acme')]);let failure=Object.assign(new Error('publish_conflict'),{status:409,code:'publish_conflict',receiptRecorded:true}),fail=true;
  f.respondPost(async()=>{if(fail)throw failure;return{share:{id:'share'},viewUrl:'https://viewer.test/view/x'}});
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.asked.length,1);
  f.direct=[grantFor('Acme'),grantFor('North Farm')];fail=false;
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked.length,2);assert.match(f.asked[1].text,/Acme and North Farm/);
  assert.notEqual(f.posts()[0].options.headers['Idempotency-Key'],f.posts()[1].options.headers['Idempotency-Key'],'a refused request is over');

  const g=askFixture([grantFor('Acme')]);fail=true;failure=new Error('network');
  g.respondPost(async()=>{if(fail)throw failure;return{share:{id:'share'},viewUrl:'https://viewer.test/view/x'}});
  await g.context.createOutputShare(g.form,'project','output');g.direct=[grantFor('Acme'),grantFor('North Farm')];fail=false;
  await g.context.createOutputShare(g.form,'project','output');
  assert.equal(g.asked.length,2);assert.match(g.asked[1].text,/Acme and North Farm/);
  assert.deepEqual(g.posts()[1].options,g.posts()[0].options,'the same request and key, so it can never be created twice');
});
test('a completed receipt recovers the exact request without another write or confirmation',async()=>{
  const f=askFixture([grantFor('Acme')]);
  f.respondPost(async()=>{throw Object.assign(new Error('bad gateway'),{status:502})});
  await f.context.createOutputShare(f.form,'project','output');
  f.direct=[grantFor('Acme'),grantFor('North Farm')];
  f.respondReceipt(async()=>{throw new Error('down')});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);assert.equal(f.asked.length,1);
  const live={id:'share',revokedAt:'2026-11-24T12:00:00Z'};
  const base=f.context.api;
  f.context.api=(path,options)=>path.endsWith('/outputs/output/shares')&&options?.method!=='POST'
    ? Promise.resolve({shares:[live],publicationRequired:true}):base(path,options);
  f.respondReceipt(async()=>({share:{id:'share',revokedAt:null},viewUrl:'https://viewer.test/view/x',receiptReplayed:true}));
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked.length,1);assert.equal(f.posts().length,1);assert.equal(f.receipts().length,2);
  assert.equal(f.receipts()[1].options.headers['Idempotency-Key'],f.posts()[0].options.headers['Idempotency-Key']);
  assert.deepEqual(f.receipts()[1].options.body,f.posts()[0].options.body);
  assert.equal(f.state.lastShareUrl,null);
  assert.equal(f.output.activePublished,false);
  assert.equal(f.state.shares.output[0],live);
});
test('an existing version asks once, with the clients and the existing links together',async()=>{
  const f=askFixture([grantFor('Acme')]);f.state.sharePreflight.output={existingAccessUpdateRequired:true};
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked.length,1);assert.match(f.asked[0].text,/^Publishing this task shows it to Acme\. Activating this model version can change/);
  assert.equal(f.posts()[0].options.body.allowExistingAccessUpdate,true);
});
test('a dialog closed while access is read sends nothing',async()=>{
  const f=askFixture([]);let answer;f.respondDirect(()=>new Promise(resolve=>{answer=resolve}));
  const pending=f.context.createOutputShare(f.form,'project','output');await new Promise(resolve=>setImmediate(resolve));
  f.modal.open=false;answer({clients:[],grants:[grantFor('Acme')],clientsNextCursor:null});await pending;assert.equal(f.posts().length,0);assert.equal(f.asked.length,0);
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
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={...f.state.adminSession,subject:'other'};
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
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={...f.state.adminSession,subject:'other'};
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
    const f=fixture(permissions);f.context.shareModal('project','output');assert.doesNotMatch(f.html(),/class="manage-form share-dialog-form share-form"/);
  }
  const f=fixture(['viewer.shares.create']);f.output.activePublished=true;f.output.status='published';
  f.context.shareModal('project','output');assert.match(f.html(),/class="manage-form share-dialog-form share-form"/);
  assert.doesNotMatch(f.html(),/data-action="revoke-share"/);
});

test('cancelled exposure confirmation sends nothing; accepted confirmation carries explicit consent and no download permission',async()=>{
  const f=fixture();f.state.sharePreflight.output={existingAccessUpdateRequired:true};
  f.context.dialogs.confirm=async()=>false;
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.posts().length,0);assert.equal(f.form.button.disabled,false);
  f.context.dialogs.confirm=async()=>true;
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);assert.equal(f.posts()[0].options.body.publishIfReady,true);
  assert.equal(f.posts()[0].options.body.allowExistingAccessUpdate,true);assert.equal(f.posts()[0].options.body.permissions.download,false);
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
  Object.assign(f.state,{section,adminSession:{...f.state.adminSession,subject:'ops:staff'},projects:[{id:'project',displayName:'Site',status:'active'}],taskDetails:{},expandedTaskId:null,diagnosticRuns:[]});
  f.state.outputs=[f.output,row('other-old','elsewhere')];
  if(share)f.respond(share);
  const answer=(path,value)=>{const entry=held.get(path);assert.ok(entry,`${path} was not read`);held.delete(path);entry.resolve(value)};
  const hold=path=>{assert.equal(held.has(path),false,path);return new Promise((resolve,reject)=>held.set(path,{resolve,reject}))};
  const shareApi=f.context.api;
  Object.assign(f.context,{publicationAudience:async()=>({clients:[],complete:true,text:''}),pagedApi:path=>hold(path),pagedStorage:()=>hold('storage'),
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
  if(changed==='token')f.state.token='replacement';else f.state.adminSession={...f.state.adminSession,subject:'ops:other'};
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
  f.respondPost(async()=>{
    attempt++;
    if(attempt===1)throw Object.assign(new Error('existing_access_update_confirmation_required'),{status:409,code:'existing_access_update_confirmation_required',receiptRecorded:true});
    if(attempt===2)throw new Error('network interrupted');
    return{share:{id:'share'},viewUrl:'https://viewer.test/view/same-link'};
  });
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,2);assert.notEqual(f.posts()[0].options.headers['Idempotency-Key'],f.posts()[1].options.headers['Idempotency-Key']);
  f.output.activePublished=true;f.output.status='published';
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,3);assert.deepEqual(f.posts()[2].options,f.posts()[1].options);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/same-link');
});

test('uncertain retry with edited settings explicitly resends the frozen original',async()=>{
  const f=fixture();f.respondPost(async()=>{throw new Error('offline')});
  await f.context.createOutputShare(f.form,'project','output');await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts()[0].options.headers['Idempotency-Key'],f.posts()[1].options.headers['Idempotency-Key']);
  f.form.elements.label.value='Changed';await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,3);
  assert.equal(f.receipts().length,2);
  assert.equal(f.receipts()[1].options.headers['Idempotency-Key'],f.posts()[0].options.headers['Idempotency-Key']);
  assert.deepEqual(f.posts()[2].options,f.posts()[0].options);
});

test('double submit is suppressed while creation is pending and close suppresses stale modal rendering',async()=>{
  const f=fixture();let done;f.respondPost(()=>new Promise(resolve=>{done=resolve}));
  const pending=f.context.createOutputShare(f.form,'project','output');await new Promise(resolve=>setImmediate(resolve));
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.posts().length,1);
  f.modal.close();f.form.isConnected=false;done({share:{id:'share'},viewUrl:'https://viewer.test/view/success'});await pending;
  assert.equal(f.modal.open,false);assert.equal(f.state.lastShareUrl,null);assert.deepEqual([...f.state.shares.output].map(item=>item.id),['share'],'the link is in the saved list');
});

test('copy failure cannot create another link and preserves manual-copy URL',async()=>{
  const f=fixture();await f.context.createOutputShare(f.form,'project','output');
  const copy={dataset:{url:f.state.lastShareUrl}};f.copyButtons.push(copy);
  f.context.bindShareModal('project','output');await copy.onclick();
  assert.equal(f.posts().length,1);assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');
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
  // New legacy project grants are refused by the server; the legacy panel no longer offers the form.
  f.context.shareModal('project');assert.doesNotMatch(f.html(),/name="wholeProject"|name="includeFuturePublished"/);
  assert.match(f.context.clientShareCard(f.output,null),/New whole-project shares are direct client shares\./);
  assert.doesNotMatch(f.context.clientShareCard(f.output,null),/id="client-grant-form"/);
});

test('project sharing has no public creation form or public task forms',async()=>{
  const f=fixture();f.context.shareModal('project');f.context.bindProjectShareCard('project');
  assert.doesNotMatch(f.html(),/project-share-form|class="manage-form share-dialog-form share-form"|Create public link|Create whole-project link/);
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
  assert.deepEqual(project.tabs.map(item=>[item[5],item[4]]),[['Client Workspace','true'],['Public link','false']]);
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

test('a new public link starts with everything on and no end; saved links keep their own settings',()=>{
  const f=fixture();
  for(const [published,status] of [[false,'ready'],[true,'published']]){
    Object.assign(f.output,{activePublished:published,status});f.context.shareModal('project','output');
    const form=/<form class="manage-form share-dialog-form share-form"[\s\S]*?<\/form>/.exec(f.html())[0];
    for(const name of ['measure','cameras','download'])assert.match(form,new RegExp(`name="${name}" checked`));
    assert.match(form,/name="expiresAt" type="datetime-local">/);
  }
  f.state.shares.output=[{id:'old',permissions:{view:true,measure:false,cameras:true,download:true},expiresAt:null,hasPassword:false}];
  f.modalContent.querySelector=()=>({elements:{passwordAction:{}},querySelector:()=>null,querySelectorAll:()=>[]});
  f.context.editShareModal('project','output','old');
  const edit=f.html();assert.match(edit,/name="cameras" type="checkbox" checked/);assert.match(edit,/name="expiresAt" type="datetime-local" value=""/);
});

test('the emergency admin page starts a link the same way, and an empty end is an explicit no end',()=>{
  const page=readFileSync(new URL('../index.html',import.meta.url),'utf8'),script=readFileSync(new URL('../main.js',import.meta.url),'utf8');
  const input=id=>new RegExp(`<input[^>]*id="${id}"[^>]*>`).exec(page)[0];
  assert.doesNotMatch(input('share-new-perm-cameras'),/checked/);assert.match(input('share-new-perm-measure'),/checked/);
  assert.match(input('share-new-expires'),/value="30"/);assert.match(input('share-new-expires'),/placeholder="Never"/);
  const create=script.slice(script.indexOf('async function createShareLink('),script.indexOf('\n}\n',script.indexOf('async function createShareLink(')));
  assert.match(create,/expiresDays: dom\.shareNewExpires\.value \? Number\(dom\.shareNewExpires\.value\) : null/);
  assert.match(create,/dom\.shareNewExpires\.value = dom\.shareNewExpires\.defaultValue;/);
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
  assert.equal(Object.hasOwn(f.calls[0].options.body,'permissions'),false);
  form.elements.passwordAction.value='remove';form.shareViewsChanged=true;form.elements.download.checked=true;await submit();
  assert.deepEqual(f.calls[2].options.body.permissions,{view:true,download:true});
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
  assert.match(html,/Project access<\/label>/);assert.match(html,/value="whole" selected>Everything/);
  assert.match(html,/Also share models published later/);
  assert.equal(f.calls.some(call=>call.options.method==='POST'),false);
});
test('changing or clearing the chosen client leaves the review',()=>{
  const f=fixture();f.state.clientDirectAccess={clients:[],grants:[]};let bound;
  f.context.bindClientPicker=(_root,options)=>{bound=options;return {dispose(){}}};
  const summary={textContent:''},review={hidden:true};
  const form={isConnected:true,elements:{client:{value:''},includeLater:{checked:false},expiresAt:{value:''},measure:{checked:true},cameras:{checked:false},download:{checked:false}},
    querySelector:selector=>selector==='[data-direct-summary]'?summary:selector==='[data-client-picker]'?{}:selector==='input[name="scope"]:checked'?{value:'project'}:selector==='[data-direct-review]'?review:selector==='[data-direct-review-button]'?{hidden:false}:selector==='[data-direct-back]'?{}:null,
    querySelectorAll:()=>[]};
  f.context.bindDirectShare(form,'project',null);
  const first={sourceId:'project-alpha:primary',workspaceId:'ws-1',displayName:'Pat Example',businessName:'Division A'};
  for(const next of [first,{...first,workspaceId:'ws-2'},null]){form.reviewing=true;review.hidden=false;bound.onSelect(next);assert.equal(form.reviewing,false);assert.equal(review.hidden,true)}
  assert.equal(summary.textContent,'');
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
  if(change==='token')f.state.token='other';if(change==='subject')f.state.adminSession={...f.state.adminSession,subject:'other'};
  if(change==='permission')permissions.splice(permissions.indexOf('viewer.client_grants.manage'),1);
  settle({clients:[{sourceId:'s',workspaceId:'w',displayName:'Late'}],grants:[]});await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.state.clientDirectAccess,access);assert.equal(f.clientPanel.innerHTML,panel);
});


test('a reopened share checks the original pending request before writing',async()=>{
  const f=fixture();
  f.respondPost(async()=>{throw new Error('response unavailable')});
  await f.context.createOutputShare(f.form,'project','output');
  const reopened={...f.form,shareBusy:false,elements:{...f.form.elements,label:{value:'Another label'}}};
  f.form.isConnected=false;
  f.state.shareContext={id:'reopened'};
  f.respondReceipt(async()=>{throw Object.assign(new Error('Pending'),{status:409,code:'idempotency_in_progress'})});
  await f.context.createOutputShare(reopened,'project','output');
  assert.equal(f.posts().length,1);assert.equal(f.receipts().length,1);
  assert.equal(f.receipts()[0].options.headers['Idempotency-Key'],f.posts()[0].options.headers['Idempotency-Key']);
  assert.deepEqual(f.receipts()[0].options.body,f.posts()[0].options.body);
  assert.match(f.notices.at(-1)[0],/still being processed/);
});

test('workspace transport rechecks the dispatch guard after a session renewal',async()=>{
  const events=[],session={id:'same'};
  const state={token:'synthetic',adminSession:session};
  const workspaceRenewal={expiresAtMs:Date.now()+10_000,waitForRenewal:async()=>{
    events.push('renewed');state.adminSession={id:'same'};return true;
  }};
  const fetch=async()=>{
    events.push('dispatch');return{status:events.filter(item=>item==='dispatch').length===1?401:200};
  };
  const scope=vm.createContext({state,workspaceRenewal,workspaceRecovery:{wait:async()=>{}},fetch});
  vm.runInContext(declaration('workspaceFetch'),scope);
  const result=await scope.workspaceFetch('/fixture',{},async()=>{
    events.push('review');return()=>events.push('checked');
  });
  assert.equal(result.status,200);
  assert.deepEqual(events,['review','checked','dispatch','renewed','review','checked','dispatch']);
});


test('a recorded terminal refusal clears only the previous request',async()=>{
  const f=fixture();
  f.respondPost(async()=>{throw new Error('response unavailable')});
  await f.context.createOutputShare(f.form,'project','output');
  f.respondReceipt(async()=>{throw Object.assign(new Error('Previous expiry was refused'),{status:400,code:'invalid_expiry',receiptReplayed:true,receiptRecorded:true})});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);
  assert.equal(f.receipts().length,1);
  assert.match(f.notices.at(-1)[0],/Previous expiry was refused/);
  f.respondPost(async()=>({share:{id:'saved'},viewUrl:'https://viewer.test/view/after-refusal'}));
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,2);
  assert.notEqual(f.posts()[0].options.headers['Idempotency-Key'],f.posts()[1].options.headers['Idempotency-Key']);
});

test('a recorded historical authorization refusal does not renew or clear the current workspace',async()=>{
  const historical=new Response(null,{status:401,headers:{'Idempotency-Replayed':'true'}});
  const scope=vm.createContext({state:{token:'synthetic',adminSession:{id:'same'}},
    workspaceRecovery:{wait:async()=>{}},workspaceRenewal:{expiresAtMs:Date.now()+10_000,
      waitForRenewal:async()=>{throw new Error('unexpected renewal')}},
    clearWorkspaceAuthorization:()=>{throw new Error('unexpected authorization clearing')},fetch:async()=>historical});
  vm.runInContext(declaration('workspaceFetch'),scope);
  assert.equal(await scope.workspaceFetch('/fixture',{headers:{'X-Viewer-Share-Receipt-Only':'true'}}),historical);
});


test('unreadable create and unverified receipt responses preserve the original key',async()=>{
  const f=fixture();
  f.respondPost(async()=>undefined);
  await f.context.createOutputShare(f.form,'project','output');
  const original=f.posts()[0].options.headers['Idempotency-Key'];
  assert.match(f.notices.at(-1)[0],/outcome could not be read/);
  for(const response of [undefined,{share:{id:'saved'}},{receiptReplayed:true}]){
    f.respondReceipt(async()=>response);
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(f.posts().length,1);
    assert.equal(f.receipts().at(-1).options.headers['Idempotency-Key'],original);
  }
  f.respondReceipt(async()=>({share:{id:'saved'},receiptReplayed:true}));
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);
  assert.equal(f.state.pendingOutputShares.size,0);
});

test('unrecorded refusals cannot drop the dispatched key or start a revised write',async()=>{
  for(const [status,code] of [[404,'upstream_not_found'],[409,'existing_access_update_confirmation_required'],[429,'rate_limited']]){
    const f=fixture();
    f.respondPost(async()=>{throw Object.assign(new Error(code),{status,code})});
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(f.posts().length,1);
    const original=f.posts()[0];
    assert.equal(f.state.pendingOutputShares.size,1);
    f.respondPost(async()=>({share:{id:'saved'}}));
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(f.receipts()[0].options.headers['Idempotency-Key'],original.options.headers['Idempotency-Key']);
    assert.deepEqual(f.posts()[1].options,original.options);
  }
});

test('a pause invalidates in-flight audience reads even if the same sign-in resumes',async()=>{
  const f=fixture();let finish,signal;
  f.respondDirect((_path,options)=>new Promise(resolve=>{finish=resolve;signal=options.signal}));
  const result=f.context.publicationAudience(f.output,'project');
  f.context.invalidatePublicationAuthority();
  assert.equal(signal.aborted,true);
  finish({clients:[],grants:[grantFor('Acme')],clientsNextCursor:null});
  const audience=await result;
  assert.equal(audience.complete,false);
  assert.equal(audience.clients.length,0);
  assert.doesNotMatch(audience.text,/Acme/);
});

test('the final transport check rejects a paused or expired authority for writes and receipt reads',async()=>{
  for(const receipt of [false,true])for(const change of ['pause','renewalPause','expire','replace']){
    const f=fixture();
    if(receipt){
      f.respondPost(async()=>{throw new Error('answer lost')});
      await f.context.createOutputShare(f.form,'project','output');
    }
    const base=f.context.api;
    f.context.api=(path,options)=>!options?.beforeDispatch?base(path,options):base(path,{
      ...options,beforeDispatch:async()=>{
        const finalCheck=await options.beforeDispatch();
        if(change==='pause')f.context.workspaceRecovery.isPaused=()=>true;
        if(change==='renewalPause')f.context.workspaceRenewal={paused:true};
        if(change==='expire')f.state.adminSession.expiresAt='2000-01-01T00:00:00Z';
        if(change==='replace')f.state.adminSession={...f.state.adminSession};
        return finalCheck;
      },
    });
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(f.posts().length,receipt?1:0,change);
    assert.equal(f.receipts().length,0,change);
    assert.equal(f.state.pendingOutputShares.size,receipt?1:0,change);
  }
});

test('individual views are a spaced, indented list like the other checks',()=>{
  const css=readFileSync(new URL('../workspace-management.css',import.meta.url),'utf8');
  assert.match(css,/\.share-dialog-form fieldset\{display:grid;gap:10px\}/);assert.match(css,/\.share-view-list\{display:grid;gap:10px;margin-top:10px;padding-left:24px\}/);
  const f=fixture();f.state.sharePreflight.output={eligibleAssetKinds:['glb','ept']};f.context.shareModal('project','output');
  assert.match(f.html(),/<summary>Choose individual views<\/summary><div class="share-view-list"><label class="check">/);
});

test('client grouping is read once per Share open and joins only linked workspaces in the access list',async()=>{
  const f=fixture();Object.assign(f.output,{status:'published',activePublished:true});
  const A='project-alpha:division-a',B='project-alpha:division-b';
  const grant=(grantId,sourceId,workspaceId,taskId)=>({grantId,sourceId,workspaceId,viewerProjectId:'project',scopeType:taskId?'task':'project',taskId,
    includeFuturePublished:!taskId,revokedAt:null,clientDisplayName:'Acme Survey',expiresAt:null,permissions:{measure:true,cameras:false,download:false}});
  f.respondGroups(async()=>({groups:[[[A,'ws-a'],[B,'ws-b']]]}));
  f.respondDirect(async path=>path.includes('include=grants')
    ?{clients:[],grants:[grant('g-1',A,'ws-a',null),grant('g-2',B,'ws-b','task')],clientsNextCursor:null}
    :{clients:[{sourceId:A,workspaceId:'ws-a',displayName:'Acme Survey',businessName:'Ledge Top Drone Services Project Alpha'},
      {sourceId:B,workspaceId:'ws-b',displayName:'Acme Survey',businessName:'Ledge Top Technologies Project Alpha'}],grants:[],clientsNextCursor:null});
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const groupCalls=()=>f.calls.filter(call=>call.path==='/api/v1/workspace/direct-client-groups').length;
  assert.equal(groupCalls(),1);
  const html=f.clientPanel.innerHTML;
  assert.match(html,/data-id="g-1"/);assert.match(html,/data-id="g-2"/);
  assert.doesNotMatch(html,/client-picker-meta/,'one client, not two divisions');
  f.context.rerenderClientSharePanel('project',null);
  assert.equal(groupCalls(),1,'never read again while the dialog is open');
});
