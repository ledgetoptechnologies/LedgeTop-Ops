import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

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
  'exactClientAssociations','clientGrantBody','clientSharePanel','clientShareCard','rememberShareResult','clearShareResult','visibleShareResult','shareModal','confirmSharedVersionUpdate',
  'createOutputShare','bindShareModal','bindProjectShareCard','shareViewLabels','availableShareViews','shareViewControls','bindShareViewControls','selectedShareViews','shareSettingsSummary','shareExpiryInput','editShareModal','retrieveShareLink'];
function fixture(permissions=['viewer.shares.read','viewer.shares.create','viewer.shares.revoke','viewer.processing.publish','viewer.client_grants.manage']){
  const output={id:'output',modelId:'model',projectId:'project',taskId:'task',attemptId:'attempt',status:'ready',activePublished:false,assetKinds:['glb']};
  const state={token:'signed-in',projects:[{id:'project',displayName:'Site'}],tasks:[{id:'task',projectId:'project'}],outputs:[output],
    shares:{},sharePreflight:{},projectShares:{},clientAccess:{projects:[],associations:[],grants:[]},shareContext:{id:'context'},lastShareUrl:null};
  const calls=[],notices=[],rendered=[],decisions=[],copyButtons=[];
  let sequence=0,respond=async(path,options)=>options.method==='POST'
    ?{share:{id:'share',permissions:{view:true,download:false}},viewUrl:'https://viewer.test/view/capability'}
    :path.endsWith('/client-grants')?state.clientAccess:{shares:[],publicationRequired:true,existingAccessUpdateRequired:false,eligibleAssetKinds:['glb']};
  const clientPanel={innerHTML:''},modal={open:true,close(){this.open=false}},modalContent={
    querySelector:selector=>selector==='.share-columns'?{dataset:{shareContext:state.shareContext?.id}}:selector==='[data-client-share-panel]'?clientPanel:null,
    querySelectorAll:selector=>selector==='[data-action="copy-share"]'?copyButtons:[],
  };
  const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
  const context=vm.createContext({state,modal,modalContent,crypto:{randomUUID:()=>`request-${++sequence}`},
    can:permission=>permissions.includes(permission),esc,dateTime:value=>value,card:(title,body)=>`<section><h3>${esc(title)}</h3>${body}</section>`,
    empty:text=>`<p>${esc(text)}</p>`,field:(label,name,attrs='')=>`<label>${esc(label)}<input name="${name}" ${attrs}></label>`,
    badge:value=>`<span>${esc(value)}</span>`,button:(action,id,label)=>`<button data-action="${action}" data-id="${id}">${label}</button>`,
    openModal:(title,html)=>{rendered.push({title,html});modal.open=true},injectProjectShareCard:()=>{},
    values:form=>({label:form.elements.label?.value||'',password:form.elements.password?.value||'',expiresAt:form.elements.expiresAt.value}),
    api:async(path,options={})=>{calls.push({path,options:JSON.parse(JSON.stringify(options))});return respond(path,options)},
    mutate:async(...args)=>calls.push({mutation:args}),toast:(...args)=>notices.push(args),navigator:{clipboard:{writeText:async()=>{throw new Error('clipboard denied')}}},
    dialogs:{confirm:async()=>{decisions.push('confirm');return true},form:async()=>null},
  });
  vm.runInContext(names.map(declaration).join('\n'),context);
  const form={dataset:{outputId:'output'},isConnected:true,elements:{label:{value:''},password:{value:''},expiresAt:{value:''},
    measure:{checked:true},cameras:{checked:true},download:{checked:false}},button:{disabled:false},querySelector(){return this.button},
    querySelectorAll(selector){return selector==='input[name="allowedViews"]'?[{checked:true,value:'model'}]:[]}};
  return {context,state,output,calls,notices,rendered,decisions,modal,modalContent,clientPanel,form,copyButtons,
    respond(fn){respond=fn},html:()=>rendered.at(-1)?.html||''};
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
  assert.match(f.html(),/data-share-mode="internal" aria-pressed="true"/);
  assert.match(f.html(),/data-share-mode-panel="public" hidden/);
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
  f.form.elements.associationId={value:'match'};
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

test('whole-project client scope and future publications are separate opt-ins',()=>{
  const f=fixture();associated(f);
  f.form.elements.projectId={value:'ops-project'};f.form.elements.wholeProject={checked:false};
  assert.throws(()=>f.context.clientGrantBody(f.form,null),/explicitly approve/);
  f.form.elements.wholeProject.checked=true;f.form.elements.includeFuturePublished.checked=false;
  assert.equal(f.context.clientGrantBody(f.form,null).grant.includeFuturePublished,false);
  f.context.shareModal('project');assert.match(f.html(),/name="wholeProject" required/);
  assert.doesNotMatch(f.html(),/name="(?:includeFuturePublished|wholeProject)" checked/);
});

test('project sharing has no public creation form or public task forms',async()=>{
  const f=fixture();f.context.shareModal('project');f.context.bindProjectShareCard('project');
  assert.doesNotMatch(f.html(),/project-share-form|class="manage-form share-form"|Create public link|Create whole-project link/);
  assert.match(f.html(),/whole projects with authenticated Operations clients/);
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
