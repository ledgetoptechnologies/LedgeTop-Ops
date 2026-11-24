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
  'clientProjectKey','clientProjectLabel','clientAccessSnapshot','exactClientAssociations','clientGrantBody','clientSharePanel','legacyClientSharePanel','clientShareCard','directShareContext','directClientShareCard','rerenderClientSharePanel','bindDirectShare','rememberShareResult','clearShareResult','visibleShareResult','shareModal','shareFence','publicationAudience','confirmPublication','reopenMovedShare',
  'createOutputShare','clientGrantRevocationMessage','bindShareModal','bindProjectShareCard','shareViewLabels','availableShareViews','shareViewControls','bindShareViewControls','selectedShareViews','shareSettingsSummary','shareExpiryInput','editShareModal','retrieveShareLink'];
function fixture(permissions=['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']){
  const output={id:'output',modelId:'model',projectId:'project',taskId:'task',attemptId:'attempt',status:'ready',activePublished:false,assetKinds:['glb']};
  const state={token:'signed-in',projects:[{id:'project',displayName:'Site'}],tasks:[{id:'task',projectId:'project'}],outputs:[output],
    shares:{},sharePreflight:{},projectShares:{},clientAccess:{projects:[],associations:[],grants:[]},shareContext:{id:'context'},lastShareUrl:null};
  const calls=[],notices=[],rendered=[],decisions=[],copyButtons=[];
  let nativeRespond=async()=>({targets:[],grants:[]}),directRespond=async()=>{throw Object.assign(new Error('Not found'),{status:404})};
  let sequence=0,respond=async(path,options)=>options.method==='POST'
    ?{share:{id:'share',permissions:{view:true,download:false}},viewUrl:'https://viewer.test/view/capability'}
    :path.endsWith('/client-grants')?state.clientAccess:{shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']};
  const clientPanel={innerHTML:''},modal={open:true,close(){this.open=false}},modalContent={
    querySelector:selector=>selector==='.share-columns'?{dataset:{shareContext:state.shareContext?.id}}:selector==='[data-client-share-panel]'?clientPanel:null,
    querySelectorAll:selector=>selector==='[data-action="copy-share"]'?copyButtons:[],
  };
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context=vm.createContext({...directClientShare,state,modal,modalContent,crypto:{randomUUID:()=>`request-${++sequence}`},
    can:permission=>permissions.includes(permission),esc,dateTime:value=>value,card:(title,body)=>`<section><h3>${esc(title)}</h3>${body}</section>`,
    empty:text=>`<p>${esc(text)}</p>`,field:(label,name,attrs='')=>`<label>${esc(label)}<input name="${name}" ${attrs}></label>`,
    badge:value=>`<span>${esc(value)}</span>`,button:(action,id,label)=>`<button data-action="${action}" data-id="${id}">${label}</button>`,
    openModal:(title,html)=>{rendered.push({title,html});modal.open=true},injectProjectShareCard:()=>{},
    values:form=>({label:form.elements.label?.value||'',password:form.elements.password?.value||'',expiresAt:form.elements.expiresAt.value}),
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});return path.startsWith('/api/v1/workspace/direct-client-grants')?directRespond(path,options):path.endsWith('/native-client-grants')?nativeRespond(path,options):respond(path,options)},
    mutate:async(...args)=>calls.push({mutation:args}),toast:(...args)=>notices.push(args),navigator:{clipboard:{writeText:async()=>{throw new Error('clipboard denied')}}},
    dialogs:{confirm:async()=>{decisions.push('confirm');return true},form:async()=>null},
  });
  vm.runInContext(names.map(declaration).join('\n'),context);
  const form={dataset:{outputId:'output'},isConnected:true,elements:{label:{value:''},password:{value:''},expiresAt:{value:''},
    measure:{checked:true},cameras:{checked:true},download:{checked:false}},button:{disabled:false},querySelector(){return this.button},
    querySelectorAll(selector){return selector==='input[name="allowedViews"]'?[{checked:true,value:'model'}]:[]}};
  const posts=()=>calls.filter(call=>call.options?.method==='POST');
  return {context,state,output,posts,calls,notices,rendered,decisions,modal,modalContent,clientPanel,form,copyButtons,
    respond(fn){respond=fn},respondPost(fn){const base=respond;respond=(path,options)=>options.method==='POST'?fn(path,options):base(path,options)},respondNative(fn){nativeRespond=fn},respondDirect(fn){directRespond=fn},html:()=>rendered.at(-1)?.html||''};
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
  assert.match(f.html(),/Links follow this model’s latest published version\./);assert.doesNotMatch(f.html(),/not published yet/);
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
  const form={isConnected:true,elements:{client:{value:JSON.stringify(['s','w'])},confirmedScope:{checked:true},includeLater:{checked:true,disabled:true},expiresAt:{value:''},measure:{checked:true},cameras:{checked:false},download:{checked:false}},
    querySelector:selector=>({'[data-direct-summary]':summary,'[data-direct-review]':review,'[data-direct-review-button]':reviewButton,'input[name="scope"]:checked':{value:'tasks'}})[selector]||box,
    querySelectorAll:selector=>selector==='input[name="taskId"]'?[{value:'task',checked:true}]:[]};
  g.context.bindDirectShare(form,'project','output');form.elements.confirmedScope.checked=true;
  await form.onsubmit({preventDefault(){}});assert.equal(form.reviewing,true,'the form works while its task is there');
  g.state.outputs=[];await form.onsubmit({preventDefault(){}});
  assert.equal(summary.textContent,directClientShare.SHARE_TARGET_MISSING);assert.equal(g.calls.some(call=>call.options?.method==='POST'),false);
  g.state.outputs=[g.output];await form.onsubmit({preventDefault(){}});
  g.state.tasks=[];await form.onsubmit({preventDefault(){}});
  assert.equal(g.calls.some(call=>call.options?.method==='POST'),false);
});
test('a project Share is unaffected by task rows coming and going',async()=>{
  const f=fixture();f.respondDirect(async()=>({clients:[],grants:[],clientsNextCursor:null}));f.state.outputs=[];f.state.tasks=[];
  await f.context.openShareModal('project');await new Promise(resolve=>setImmediate(resolve));
  const html=f.html()+f.clientPanel.innerHTML;
  assert.match(html,/name="scope" value="project" checked/);assert.doesNotMatch(html,/no longer in this project/);
});

const grantFor=(clientDisplayName,extra={})=>({grantId:clientDisplayName,sourceId:'s',workspaceId:clientDisplayName,viewerProjectId:'project',scopeType:'project',taskId:null,revokedAt:null,expiresAt:null,clientDisplayName,...extra});
function askFixture(grants){
  const f=fixture(),asked=[];f.direct=grants;f.legacy=async()=>({projects:[],associations:[],grants:[]});
  f.context.dialogs.confirm=async(text,options)=>{asked.push({text,options:{...options}});f.onAsk?.(asked.length);return f.answer!==false};
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
  f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409})});
  if(known)f.state.tasks=[{...f.state.tasks[0],projectId:'other'}];
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,known?0:1);if(!known)assert.equal(f.posts()[0].options.body.expectedProjectId,'project');
  assert.deepEqual(reopened,[['other','output']]);assert.equal(f.state.shareContext.mode,'public');
  assert.equal(f.state.tasks[0].projectId,'other');assert.equal(f.state.outputs[0].projectId,'other');
  assert.match(f.notices.at(-1)[0],/North wall.*moved to Other site.*Nothing was shared/);assert.equal(f.output.activePublished,false);
});
const changes={
  token:f=>{f.state.token='other'},'signed-in person':f=>{f.state.adminSession={subject:'ops:other'}},dialog:f=>{f.state.shareContext={id:'another'}},
  'closed dialog':f=>{f.modal.open=false},'replaced form':f=>{f.form.isConnected=false},'share permission':f=>f.permissions.delete('viewer.shares.create'),
  'publish permission':f=>f.permissions.delete('viewer.processing.publish'),'model row':f=>{f.state.outputs=[]},'model task':f=>{f.state.outputs=[{...f.output,taskId:'elsewhere'}]},
  'task row':f=>{f.state.tasks=[]}};
for(const [label,change] of Object.entries(changes))for(const point of ['first read','question','read after the answer','retry check'])
test(`nothing is sent when the ${label} changes during the ${point}`,async()=>{
  const f=askFixture([grantFor('Acme')]);f.state.adminSession={subject:'ops:me'};
  f.permissions=new Set(['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']);f.context.can=name=>f.permissions.has(name);
  let expected=0;
  if(point==='retry check'){
    f.respondPost(async()=>{throw new Error('network')});await f.context.createOutputShare(f.form,'project','output');expected=1;assert.equal(f.posts().length,1);
    const base=f.context.api;f.context.api=async(path,options)=>{const value=await base(path,options);if(path.endsWith('/outputs/output/shares')&&options?.method!=='POST')change(f);return value};
    f.respondPost(async()=>({share:{id:'share'},viewUrl:'https://viewer.test/view/x'}));
  }else if(point==='question')f.onAsk=()=>change(f);
  else{let reads=0;f.legacy=async()=>{if(++reads===(point==='first read'?1:2))change(f);return{projects:[],associations:[],grants:[]}}}
  const asked=f.asked.length;await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,expected);assert.equal(f.output.activePublished,false);assert.equal(f.state.lastShareUrl,null);
  if(point==='first read'||point==='retry check')assert.equal(f.asked.length,asked,'and nothing more is asked');
});
for(const changed of ['token','person'])test(`a link that answers after the ${changed} changed is not kept in the new session`,async()=>{
  const f=askFixture([]);f.state.adminSession={subject:'ops:me'};
  f.respondPost(async()=>{if(changed==='token')f.state.token='other';else f.state.adminSession={subject:'ops:other'};return{share:{id:'share'},viewUrl:'https://viewer.test/view/secret'}});
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
  f.respondPost(async()=>{f.modal.open=false;f.form.isConnected=false;throw Object.assign(new Error('output_project_changed'),{status:409})});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(reopened,0);assert.match(f.notices.at(-1)[0],/North wall moved to another project\. Nothing was shared/);
});
test('losing the right to see client shares while they are read makes the list incomplete',async()=>{
  const f=askFixture([]);let allowed=true;const base=f.context.can;f.context.can=name=>name==='viewer.client_grants.manage'?allowed:base(name);
  f.legacy=async()=>{allowed=false;return{projects:[],associations:[],grants:[]}};f.answer=false;
  await f.context.createOutputShare(f.form,'project','output');assert.match(f.asked[0].text,/could not be checked/);
});
test('a task read for reopening is ignored after the dialog or sign-in changed',async()=>{
  for(const change of [f=>{f.state.shareContext={id:'another'}},f=>{f.state.token='other'}]){
    const f=askFixture([]);let reopened=0;f.context.openShareModal=async()=>{reopened++};
    const base=f.context.api;f.context.api=async(path,options)=>{if(path!=='/api/v1/tasks/task')return base(path,options);change(f);return{task:{id:'task',projectId:'other'}}};
    f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409})});
    await f.context.createOutputShare(f.form,'project','output');
    assert.equal(reopened,0);assert.equal(f.state.tasks[0].projectId,'project');assert.equal(f.state.outputs[0].projectId,'project');
  }
});
test('a moved task whose project cannot be read closes to sharing with a clear message',async()=>{
  const f=askFixture([]);let reopened=0;f.context.openShareModal=async()=>{reopened++};
  const base=f.context.api;f.context.api=(path,options)=>path==='/api/v1/tasks/task'?Promise.reject(new Error('down')):base(path,options);
  f.respondPost(async()=>{throw Object.assign(new Error('output_project_changed'),{status:409})});
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(reopened,0);assert.match(f.notices.at(-1)[0],/moved to another project.*Nothing was shared.*Close Share/);
});
test('a retry asks again: refused first attempt, and an uncertain one that did not publish',async()=>{
  const f=askFixture([grantFor('Acme')]);let failure=Object.assign(new Error('publish_conflict'),{status:409}),fail=true;
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
test('an uncertain attempt that did publish is replayed unasked; one that cannot be checked is not sent',async()=>{
  const f=askFixture([grantFor('Acme')]);let fail=true;
  f.respondPost(async()=>{if(fail)throw Object.assign(new Error('bad gateway'),{status:502});return{share:{id:'share'},viewUrl:'https://viewer.test/view/x'}});
  await f.context.createOutputShare(f.form,'project','output');fail=false;
  const base=f.context.api;let preflight=async()=>({publicationRequired:false,shares:[]});
  f.context.api=(path,options)=>path.endsWith('/outputs/output/shares')&&options?.method!=='POST'?preflight():base(path,options);
  f.direct=[grantFor('Acme'),grantFor('North Farm')];
  preflight=async()=>{throw new Error('down')};await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);assert.equal(f.asked.length,1);assert.match(f.notices.at(-1)[0],/Could not check whether the link was created/);
  preflight=async()=>({publicationRequired:false,shares:[]});await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.asked.length,1);assert.equal(f.posts().length,2);assert.deepEqual(f.posts()[1].options,f.posts()[0].options);
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
  await f.context.createOutputShare(f.form,'project','output');assert.equal(f.posts().length,0);assert.equal(f.form.button.disabled,false);
  f.context.dialogs.confirm=async()=>true;
  await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts().length,1);assert.equal(f.posts()[0].options.body.publishIfReady,true);
  assert.equal(f.posts()[0].options.body.allowExistingAccessUpdate,true);assert.equal(f.posts()[0].options.body.permissions.download,false);
  assert.equal(f.state.lastShareUrl,'https://viewer.test/view/capability');assert.match(f.html(),/New public link/);
  assert.equal(f.notices.some(item=>/clipboard|failed/i.test(item[0])),false,'creation must not attempt clipboard');
});

test('raced consent retry uses new key, uncertain retry retains exact consent payload even if output refreshes as published',async()=>{
  const f=fixture();let attempt=0;
  f.respondPost(async()=>{
    attempt++;
    if(attempt===1)throw Object.assign(new Error('existing_access_update_confirmation_required'),{status:409});
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

test('same-form uncertain network retry retains key; changing visible request input rotates it',async()=>{
  const f=fixture();f.respondPost(async()=>{throw new Error('offline')});
  await f.context.createOutputShare(f.form,'project','output');await f.context.createOutputShare(f.form,'project','output');
  assert.equal(f.posts()[0].options.headers['Idempotency-Key'],f.posts()[1].options.headers['Idempotency-Key']);
  f.form.elements.label.value='Changed';await f.context.createOutputShare(f.form,'project','output');
  assert.notEqual(f.posts()[1].options.headers['Idempotency-Key'],f.posts()[2].options.headers['Idempotency-Key']);
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
  f.context.shareModal('project');assert.match(f.html(),/name="wholeProject" required/);
  assert.doesNotMatch(f.html(),/name="(?:includeFuturePublished|wholeProject)" checked/);
});

test('project sharing has no public creation form or public task forms',async()=>{
  const f=fixture();f.context.shareModal('project');f.context.bindProjectShareCard('project');
  assert.doesNotMatch(f.html(),/project-share-form|class="manage-form share-form"|Create public link|Create whole-project link/);
  assert.match(f.html(),/whole project or only chosen tasks with a client’s portal account/);
  assert.match(f.html(),/data-legacy-project-shares/);assert.equal(f.calls.length,0);
  await f.context.createOutputShare(f.form,'project',null);assert.equal(f.calls.length,0);
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
