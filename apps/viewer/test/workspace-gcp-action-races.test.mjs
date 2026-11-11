import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const actions=source.slice(source.indexOf('function reportGcpActionError('),source.indexOf('\nfunction newProjectModal('));
function fixture(){
  const workspace={setId:'set',pointId:'point',activeImage:{id:'image',width:100,height:80},editingId:null,rawPixel:{pixelX:'1',pixelY:'2'},pointCache:{}};
  const detail={gcp:{sets:[{id:'set'}],correspondences:[{id:'mark',pointId:'point',imageFileId:'image'}]}};
  const state={token:'one',tasks:[{id:'task',datasetId:'dataset',projectId:'project',status:'active'}],taskDetails:{task:detail},gcpWorkspaces:{task:workspace},busy:false};
  const calls=[],notices=[];let resolveRequest,permit=true;
  const context=vm.createContext({state,workspaceAuthority:()=>state.token,can:()=>permit,gcpWorkspace:()=>workspace,encodeURIComponent,toast:(...v)=>notices.push(v),navigationWork:{trackGcpSave:fn=>fn()},api:(...args)=>{calls.push(args);return new Promise(resolve=>{resolveRequest=resolve;});},refreshGcpWorkspace:async()=>{},openGcpImage:async()=>{},dialogs:{confirm:async()=>true}});
  vm.runInContext(actions,context);
  const form=(x='1',y='2')=>({preventDefault(){},currentTarget:{dataset:{taskId:'task'},elements:{pixelX:{value:x},pixelY:{value:y},imageFileId:{value:'image'}}}});
  return{context,state,workspace,detail,calls,notices,form,resolve:value=>resolveRequest(value),deny:()=>{permit=false;}};
}
test('save validates blank, negative and image bounds before issuing a request',async()=>{
  const f=fixture();for(const [x,y] of [['','1'],['-1','1'],['100','1'],['1','80'],['1','Infinity']])await f.context.saveGcpMark(f.form(x,y));
  assert.equal(f.calls.length,0);assert.equal(f.notices.length,5);
  const pending=f.context.saveGcpMark(f.form('0','0'));assert.equal(f.calls.length,1);f.resolve({correspondence:{id:'saved',pixelX:0,pixelY:0}});await pending;
  assert.equal(f.workspace.draftPixel.pixelX,0);
});
for(const change of ['permission','token','dataset','selection','draft'])test(`successful save leaves changed ${change} UI untouched`,async()=>{
  const f=fixture(),pending=f.context.saveGcpMark(f.form());
  if(change==='permission')f.deny();if(change==='token')f.state.token='two';if(change==='dataset')f.state.tasks[0].datasetId='other';if(change==='selection')f.workspace.pointId='other';if(change==='draft')f.workspace.rawPixel={pixelX:'9',pixelY:'2'};
  f.resolve({correspondence:{id:'new',pixelX:1,pixelY:2}});await pending;
  assert.equal(f.detail.gcp.correspondences.length,1);assert.equal(f.workspace.editingId,null);assert.equal(f.notices.length,0);
});
test('delete confirmation and response cannot mutate a newly selected context',async()=>{
  const f=fixture();let accept;f.context.dialogs.confirm=()=>new Promise(resolve=>{accept=resolve;});
  const rejected=f.context.deleteGcpMark('task','mark');f.workspace.pointId='other';accept(true);await rejected;assert.equal(f.calls.length,0);
  f.workspace.pointId='point';const pending=f.context.deleteGcpMark('task','mark');accept(true);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
  f.workspace.pointId='other';f.resolve({});await pending;assert.equal(f.notices.length,0);
});
test('late edit point lookup cannot change current selection',async()=>{
  const f=fixture(),pending=f.context.editGcpMark('task','mark');f.workspace.pointId='other';
  f.resolve({points:[{id:'point'}]});await pending;assert.equal(f.workspace.pointId,'other');assert.equal(f.workspace.pointCache.set,undefined);
});

test('successful write reports refresh failure without claiming the save failed',async()=>{
  const f=fixture();f.context.refreshGcpWorkspace=async()=>{throw new Error('offline');};
  const pending=f.context.saveGcpMark(f.form());f.resolve({correspondence:{id:'saved',pixelX:1,pixelY:2}});await pending;
  assert.match(f.notices[0][0],/updated/);assert.match(f.notices[1][0],/saved, but refresh failed/);
});
test('edit lookup cannot open an image after navigation',async()=>{
  const f=fixture();let opened=0;f.state.taskPage='gcp';f.state.expandedTaskId='task';f.context.openGcpImage=async()=>{opened++;};
  const pending=f.context.editGcpMark('task','mark');f.state.taskPage='overview';f.resolve({points:[{id:'point'}]});await pending;assert.equal(opened,0);
});

test('unknown mutation outcome is reported without exposing stale context',async()=>{
 const f=fixture();let reject;f.context.api=()=>new Promise((_resolve,fail)=>{reject=fail;});const pending=f.context.saveGcpMark(f.form());
 f.state.token='replacement';reject(Object.assign(new Error('private stale details'),{code:'workspace_mutation_outcome_unknown'}));await pending;
 assert.equal(f.notices.length,1);assert.match(f.notices[0][0],/may have completed/);assert.doesNotMatch(f.notices[0][0],/private/);
});

test('save passes a receipt validator bound to exact task, point, image and coordinates',async()=>{
 const f=fixture(),pending=f.context.saveGcpMark(f.form('1','2')),options=f.calls[0][1],valid={correspondence:{id:'mark',taskId:'task',pointId:'point',imageFileId:'image',pixelX:1,pixelY:2}};
 assert.equal(options.validateReceipt(valid),true);assert.equal(options.validateReceipt({}),false);assert.equal(options.validateReceipt({correspondence:{...valid.correspondence,pointId:'wrong'}}),false);
 f.resolve(valid);await pending;
});
