import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const line=name=>source.split(/\r?\n/).find(value=>value.startsWith(`function ${name}(`));
const start=source.indexOf('async function openGcpImage(');
const end=source.indexOf('\nfunction configureGcpImage(',start);

function fixture(){
  const pending=[],revoked=[],errors=[];
  const state={tasks:[{id:'task',datasetId:'dataset'}],taskDetails:{task:{gcp:{candidates:[{id:'A'},{id:'B'}],correspondences:[]}}},gcpWorkspaces:{}};
  const context=vm.createContext({state,workspaceAuthority:()=>state.token,AbortController,queueMicrotask,can:()=>true,
    URL:{revokeObjectURL:url=>revoked.push(url)},render(){},toast:message=>errors.push(message),content:{querySelector:()=>null},
    privateGcpImage(datasetId,fileId,signal){return new Promise((resolve,reject)=>pending.push({datasetId,fileId,signal,resolve,reject}));},
  });
  vm.runInContext(`${line('gcpWorkspace')}\n${line('releaseGcpImage')}\n${source.slice(start,end)}`,context);
  const workspace=context.gcpWorkspace('task');workspace.pointId='point';
  return {context,state,workspace,pending,revoked,errors};
}

test('late image response cannot replace the selected photo or its saved mark',async()=>{
  const f=fixture();
  f.state.taskDetails.task.gcp.correspondences.push({id:'mark-B',pointId:'point',imageFileId:'B',pixelX:12,pixelY:34});
  const a=f.context.openGcpImage('task','A');
  const b=f.context.openGcpImage('task','B');
  assert.equal(f.pending[0].signal.aborted,true);
  f.pending[1].resolve('blob:B');await b;
  f.pending[0].resolve('blob:A');await a;
  assert.equal(f.workspace.activeImage.id,'B');assert.equal(f.workspace.imageUrl,'blob:B');
  assert.equal(f.workspace.editingId,'mark-B');assert.equal(f.workspace.draftPixel.pixelX,12);
  assert.deepEqual(f.revoked,['blob:A']);
});

test('closing the image aborts its request and revokes a late object URL',async()=>{
  const f=fixture(),request=f.context.openGcpImage('task','A');
  f.context.releaseGcpImage(f.workspace);
  assert.equal(f.pending[0].signal.aborted,true);
  f.pending[0].resolve('blob:A');await request;
  assert.equal(f.workspace.activeImage,null);assert.equal(f.workspace.imageUrl,null);
  assert.equal(f.workspace.imageLoading,false);assert.deepEqual(f.revoked,['blob:A']);
});

test('late failure cannot clear the new selected image or report an obsolete error',async()=>{
  const f=fixture(),a=f.context.openGcpImage('task','A'),b=f.context.openGcpImage('task','B');
  f.pending[1].resolve('blob:B');await b;
  f.pending[0].reject(new Error('old request failed'));await a;
  assert.equal(f.workspace.activeImage.id,'B');assert.equal(f.workspace.imageUrl,'blob:B');
  assert.deepEqual(f.errors,[]);
});

test('replacement task details discard a pending source-image result',async()=>{
  const f=fixture(),request=f.context.openGcpImage('task','A');
  f.state.taskDetails.task={gcp:{candidates:[],correspondences:[]}};
  f.pending[0].resolve('blob:A');await request;
  assert.notEqual(f.workspace.imageUrl,'blob:A');assert.deepEqual(f.revoked,['blob:A']);
  assert.equal(f.workspace.imageLoading,false);assert.equal(f.workspace.activeImage,null);
});

test('quiet task refresh preserves a pending image request on the same task and dataset',async()=>{
  const f=fixture();f.state.token='token';const request=f.context.openGcpImage('task','A'),original=f.state.taskDetails.task;
  f.context.taskDetailRefreshes=new Set();
  f.context.api=async path=>path.includes('/storage?')?{}:path.includes('/gcp-sets')?{sets:[]}:path.includes('/attempts?')?{attempts:[]}:{task:{id:'task',datasetId:'dataset'}};
  const start=source.indexOf('async function refreshTaskDetails('),end=source.indexOf('\nfunction releaseGcpImage(',start);
  vm.runInContext(source.slice(start,end),f.context);
  await f.context.refreshTaskDetails('task',true);
  assert.equal(f.state.taskDetails.task,original);
  f.pending[0].resolve('blob:A');await request;
  assert.equal(f.workspace.imageUrl,'blob:A');assert.equal(f.workspace.activeImage.id,'A');assert.deepEqual(f.revoked,[]);
});

test('permission loss prevents a pending image from installing its object URL',async()=>{
  const f=fixture();let permitted=true;f.context.can=()=>permitted;
  const request=f.context.openGcpImage('task','A');permitted=false;f.pending[0].resolve('blob:A');await request;
  assert.equal(f.workspace.imageUrl,null);assert.equal(f.workspace.activeImage,null);assert.deepEqual(f.revoked,['blob:A']);
});
