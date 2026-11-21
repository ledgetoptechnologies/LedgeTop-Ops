import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
function harness({write=true,api=async()=>({providers:[],presets:[]})}={}){
  const state={section:'providers',selectedProviderId:'node',providers:[],presets:[]};
  const context={state,api,can:permission=>permission!=='viewer.providers.write'||write,render(){context.renders++;},renders:0,Map,Date,
    providerName:value=>value,esc:value=>String(value),available:value=>String(value),
    dateTime:value=>value,badge:value=>value,empty:value=>value,
    button:(action,id,label)=>`<button data-action="${action}">${label}</button>`,
    dangerButton:(action,id,label)=>`<button data-action="${action}">${label}</button>`};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('const providerCapabilityRefreshes='),source.indexOf('function providerForm('))+'\nthis.subject={refreshProviderCapabilities,refreshOpenedProvider,providerDetail,providerCapabilityNotice};',context);
  return context;
}
test('node detail exposes preset management, stale presets and no raw option list',()=>{
  const ctx=harness(),provider={id:'node',type:'nodeodm',enabled:false,capabilityFingerprint:'new',capabilities:{options:[{name:'raw-option-secret-label',value:7}]}};
  ctx.state.presets=[{id:'old',providerType:'nodeodm',capabilityFingerprint:'old',displayName:'Old preset'},{id:'builtin',providerType:'nodeodm',capabilityFingerprint:'new',displayName:'Built in',builtIn:true}];
  const html=ctx.subject.providerDetail(provider);
  for(const action of ['view-preset','new-preset','import-preset','duplicate-preset','edit-preset','delete-preset','delete-provider'])assert.ok(html.includes(action));
  assert.ok(html.includes('capabilities changed'));assert.ok(html.includes('Built in · read-only'));
  assert.ok(!html.includes('raw-option-secret-label'));assert.ok(!html.includes('Detected processing options'));
  assert.equal((html.match(/data-action="edit-preset"/g)||[]).length,1);
  assert.ok(!ctx.subject.providerDetail({...provider,enabled:true}).includes('delete-provider'));
});
test('read-only node view can inspect presets and refresh observations without management rights',async()=>{
  const calls=[];const ctx=harness({write:false,api:async path=>{calls.push(path);return {};}});
  ctx.state.presets=[{id:'one',providerType:'nodeodm',displayName:'Preset'}];
  const html=ctx.subject.providerDetail({id:'node',type:'nodeodm',capabilities:{}});
  assert.ok(html.includes('view-preset'));assert.ok(!html.includes('edit-preset'));assert.ok(!html.includes('import-preset'));
  assert.ok(!html.includes('delete-provider'));
  assert.equal(await ctx.subject.refreshProviderCapabilities('node'),true);assert.equal(calls[0],'/api/v1/processing/providers/node/capabilities/refresh');assert.equal(calls.length,3);
  assert.ok(html.includes('Cached capabilities'));
});
test('opening a node coalesces probe and rendering does not recursively probe',async()=>{
  let resolveProbe,calls=[];const ctx=harness({api:async path=>{calls.push(path);if(path.endsWith('/refresh'))await new Promise(resolve=>{resolveProbe=resolve});return path.includes('/providers?')?{providers:[{id:'node',capabilities:{options:[]}}]}:{presets:[]};}});
  ctx.subject.refreshOpenedProvider();ctx.subject.refreshOpenedProvider();
  const completed=ctx.subject.refreshProviderCapabilities('node');assert.equal(calls.length,1);
  resolveProbe();assert.equal(await completed,true);assert.equal(calls.length,3);assert.equal(ctx.renders,1);
  ctx.subject.refreshOpenedProvider();assert.equal(calls.length,3);
  assert.ok(ctx.subject.providerCapabilityNotice({id:'node'}).includes('refreshed'));
});
test('failed refresh retains cached node and clearly reports stale state',async()=>{
  const ctx=harness({api:async()=>{throw new Error('Node offline');}});
  ctx.state.providers=[{id:'node',capabilities:{options:[{name:'keep'}]}}];
  assert.equal(await ctx.subject.refreshProviderCapabilities('node'),false);
  assert.equal(ctx.state.providers[0].capabilities.options[0].name,'keep');
  assert.match(ctx.subject.providerCapabilityNotice({id:'node'}),/Cached capabilities.*Node offline/);
});
function presetHarness(){
  let connected=[],active={},uuid=0;
  const editor={getOptions:()=>({}),setDisabled(value){this.disabled=value;},dispose(){}};
  const field=(value='')=>({value,disabled:false,closest:()=>null});
  const context={state:{providers:[{id:'node',capabilities:{options:[]}}],presets:[]},can:()=>true,esc:String,field:()=>'',providerCapabilityNotice:()=>'',mountTaskOptions:()=>editor,crypto:{randomUUID:()=>`receipt-${++uuid}`},
    refreshProviderCapabilities:async()=>true,api:async()=>{},toast(){},load:async()=>{},calls:[],editor,
    modal:{open:false,close(){this.open=false;context.closes++;},addEventListener(){}},closes:0,
    modalContent:{querySelector(selector){return active[selector];}},
    openModal(title,body){for(const node of connected)node.isConnected=false;connected=[];active={};context.modal.open=true;
      if(body.includes('id="preset-form"')){
        const controls=[field('Name'),field('Description'),{...field(),checked:true},field()],status={};
        const form={isConnected:true,elements:{displayName:controls[0],description:controls[1],enabled:controls[2]},querySelectorAll:()=>controls,
          querySelector:selector=>selector==='#preset-save-status'?status:selector==='.task-options-editor'?null:{}};
        active['#preset-form']=form;connected.push(form);context.form=form;context.controls=controls;
      }else{const node={isConnected:true};active['[role="status"]']=node;connected.push(node);}
    }};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('let presetEditorGeneration='),source.indexOf('function importPresetModal('))+'\nthis.openPreset=presetModal;',context);
  return context;
}
test('late capability result cannot replace an unrelated modal',async()=>{
  const ctx=presetHarness();let complete;ctx.refreshProviderCapabilities=()=>new Promise(resolve=>{complete=resolve;});
  const opening=ctx.openPreset('node');ctx.openModal('Other','Other dialog');complete(true);await opening;
  assert.equal(ctx.form,undefined);assert.equal(ctx.closes,0);
});
test('preset save is single-flight, disables editing, reuses receipt on retry, and does not close newer dialogs',async()=>{
  const ctx=presetHarness();await ctx.openPreset('node');
  let rejectRequest,resolveRequest;const calls=[];
  ctx.api=async(path,request)=>{calls.push(request);return new Promise((resolve,reject)=>{resolveRequest=resolve;rejectRequest=reject;});};
  const submit=()=>ctx.form.onsubmit({preventDefault(){}});
  const first=submit();assert.equal(ctx.editor.disabled,true);assert.ok(ctx.controls.every(control=>control.disabled));
  await submit();assert.equal(calls.length,1);
  rejectRequest(new Error('Response lost'));await first;assert.equal(ctx.editor.disabled,false);assert.ok(ctx.controls.every(control=>!control.disabled));
  const retry=submit();assert.equal(calls[0].headers['Idempotency-Key'],calls[1].headers['Idempotency-Key']);
  ctx.openModal('Other','Other dialog');resolveRequest({});await retry;assert.equal(ctx.closes,0);assert.equal(ctx.modal.open,true);
});


test('deleting a node waits for confirmation and ignores provider lists fetched before deletion',async()=>{
  let releaseNodes,notifyListStarted,approve=false;
  const listStarted=new Promise(resolve=>{notifyListStarted=resolve;});
  const ctx=harness({api:async path=>{
    if(path.includes('/providers?')){
      notifyListStarted();
      return new Promise(resolve=>{releaseNodes=resolve;});
    }
    return {};
  }});
  ctx.state.providers=[{id:'node',displayName:'Cluster',enabled:true}];
  ctx.dialogs={confirm:async(message,{destructive})=>{
    assert.match(message,/Delete node "Cluster".*Past runs will remain/);
    assert.equal(destructive,true);
    return approve;
  }};
  ctx.modal={open:false};
  const calls=[];
  ctx.mutate=async(path,request,onSuccess)=>{
    calls.push({path,method:request.method});
    assert.equal(onSuccess(),'Node deleted');
    ctx.state.providers=[];
  };
  vm.runInContext(source.slice(source.indexOf('async function deleteProvider('),source.indexOf('function bindModalActions('))+'\nthis.deleteNode=deleteProvider;',ctx);
  approve=true;
  await ctx.deleteNode('node');
  assert.deepEqual(calls,[]);
  approve=false;
  ctx.state.providers[0].enabled=false;
  await ctx.deleteNode('node');
  assert.deepEqual(calls,[]);
  const refreshing=ctx.subject.refreshProviderCapabilities('node');
  await listStarted;
  approve=true;
  await ctx.deleteNode('node');
  assert.deepEqual(calls,[{path:'/api/v1/processing/providers/node',method:'DELETE'}]);
  releaseNodes({providers:[{id:'node'}]});
  await refreshing;
  assert.deepEqual(ctx.state.providers,[]);
});


test('a full workspace load started before node deletion cannot restore the removed node',async()=>{
  let releaseOldNodes;
  let firstList=true;
  const ctx=harness({api:async path=>{
    if(!path.includes('/providers?'))return {};
    if(!firstList)return {providers:[]};
    firstList=false;
    return new Promise(resolve=>{releaseOldNodes=resolve;});
  }});
  ctx.state.token='session';
  ctx.state.providers=[{id:'node',displayName:'Cluster',enabled:false}];
  const noop=()=>{};
  Object.assign(ctx,{
    pagedApi:async()=>({}),pagedStorage:async()=>({}),validateWorkspaceView:noop,syncWorkspaceView:noop,
    setWorkspaceHealth:noop,document:{querySelector:noop},hydrateExpandedTask:noop,scheduleOperationRefresh:noop,
    dialogs:{confirm:async()=>true},modal:{open:false},
    mutate:async(_path,_request,onSuccess)=>{onSuccess();await ctx.loadWorkspace();},
  });
  vm.runInContext(source.slice(source.indexOf('async function deleteProvider('),source.indexOf('function bindModalActions('))+'\nthis.deleteNode=deleteProvider;',ctx);
  vm.runInContext(source.slice(source.indexOf('async function load(){'),source.indexOf('function access(){'))+'\nthis.loadWorkspace=load;',ctx);
  const oldLoad=ctx.loadWorkspace();
  await ctx.deleteNode('node');
  assert.equal(ctx.state.providers.length,0);
  releaseOldNodes({providers:[{id:'node'}]});
  await oldLoad;
  assert.equal(ctx.state.providers.length,0);
});
