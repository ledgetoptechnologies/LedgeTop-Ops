import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasUnsavedGcpMark,createWorkspaceNavigationWork,workspaceNavigationState} from '../workspace-navigation-state.mjs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const mark={id:'mark',pointId:'point',imageFileId:'image',pixelX:10,pixelY:20};
const workspace={pointId:'point',activeImage:{id:'image'},editingId:'mark',draftPixel:{pixelX:10,pixelY:20}};
const details={task:{gcp:{correspondences:[mark]}}};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
test('saved GCP seeds and reverted edits are clean; actual changed or new marks are unsaved',()=>{
  assert.equal(hasUnsavedGcpMark({task:workspace},details),false);
  for(const axis of ['pixelX','pixelY']){
    const changed=structuredClone(workspace);changed.draftPixel[axis]++;
    assert.equal(hasUnsavedGcpMark({task:changed},details),true);
    changed.draftPixel[axis]=mark[axis];assert.equal(hasUnsavedGcpMark({task:changed},details),false);
  }
  assert.equal(hasUnsavedGcpMark({task:{...workspace,editingId:null}},details),false);
  assert.equal(hasUnsavedGcpMark({task:workspace},{task:{gcp:{correspondences:[]}}}),true);
  assert.equal(hasUnsavedGcpMark({task:{...workspace,draftPixel:null}},details),false);
  assert.equal(hasUnsavedGcpMark({task:{...workspace,draftPixel:{pixelX:NaN,pixelY:20}}},details),false);
});
test('actual GCP save handler exposes pending only during request, including rejected request finally',async()=>{
  const handler=source.split('\n').find(line=>line.startsWith('async function saveGcpMark('));
  for(const fail of [false,true]){
    const work=createWorkspaceNavigationWork(),wait=deferred(),state={busy:false,taskDetails:structuredClone(details)};
    const w=structuredClone(workspace);w.draftPixel.pixelX=11;
    const save=new Function('navigationWork','state','gcpWorkspace','api','toast','refreshGcpWorkspace',handler+';return saveGcpMark;')(
      work,state,()=>w,()=>wait.promise,()=>{},async()=>{throw Error("Refresh unavailable");});
    const pending=save({preventDefault(){},currentTarget:{dataset:{taskId:'task'},elements:{pixelX:{value:'11'},pixelY:{value:'20'},imageFileId:{value:'image'}}}});
    assert.equal(work.snapshot().pendingGcpSave,true);assert.equal(state.busy,true);
    if(fail)wait.reject(new Error('denied'));else wait.resolve({correspondence:{...mark,pixelX:11}});
    await pending;
    assert.equal(work.snapshot().pendingGcpSave,false);assert.equal(state.busy,false);
    if(fail)assert.equal(w.draftPixel.pixelX,11);
    assert.equal(hasUnsavedGcpMark({task:w},state.taskDetails),fail,'acknowledged save is clean even if subsequent refresh fails');
  }
});
test('unrelated generic busy is not reported as GCP save; concurrent tracker completions are independent',async()=>{
  assert.equal(workspaceNavigationState({work:{busy:true}}).pendingGcpSave,false);
  const work=createWorkspaceNavigationWork(),a=deferred(),b=deferred();
  const first=work.trackGcpSave(()=>a.promise),second=work.trackGcpSave(()=>b.promise);
  a.resolve();await first;assert.equal(work.snapshot().pendingGcpSave,true);
  b.resolve();await second;assert.equal(work.snapshot().pendingGcpSave,false);
  await assert.rejects(work.trackGcpSave(()=>{throw Error('sync');}));assert.equal(work.snapshot().pendingGcpSave,false);
});
test('reachable legacy upload wrapper tracks files and pending state through success and failure',async()=>{
  const wrapper=source.split('\n').find(line=>line.startsWith('function uploadFiles('));
  for(const fail of [false,true]){
    const work=createWorkspaceNavigationWork(),wait=deferred();
    const upload=new Function('navigationWork','performLegacyUpload',wrapper+';return uploadFiles;')(work,()=>wait.promise);
    const result=upload({elements:{files:{files:{length:4}}}});
    assert.deepEqual(work.snapshot(),{pendingGcpSave:false,pendingLegacyUpload:true,legacyUploadFileCount:4});
    const state=workspaceNavigationState({work:work.snapshot(),legacySelectedFileCount:4});
    assert.equal(state.pendingUpload,true);assert.equal(state.selectedFileCount,4,'same selected files are not double-counted');
    if(fail){wait.reject(Error('failure'));await assert.rejects(result);}else{wait.resolve();await result;}
    assert.equal(work.snapshot().pendingLegacyUpload,false);assert.equal(work.snapshot().legacyUploadFileCount,0);
  }
});
test('New Task flags survive aggregation and selected legacy files are counted before upload',()=>{
  assert.deepEqual(workspaceNavigationState({newTask:{pendingUpload:true,selectedFileCount:3,unsavedTaskDraft:true},legacySelectedFileCount:2}),{
    pendingUpload:true,selectedFileCount:5,unsavedTaskDraft:true,unsavedGcpMark:false,pendingGcpSave:false,
  });
  assert.equal(workspaceNavigationState({legacySelectedFileCount:2}).selectedFileCount,2);
  assert.equal(workspaceNavigationState({legacySelectedFileCount:2}).pendingUpload,false);
  assert.match(source,/getNavigationState:currentWorkspaceNavigationState/);
  assert.match(source,/legacySelectedFileCount:modalContent\.querySelector\('#upload-form input\[type="file"\]'\)\?\.files\?\.length\|\|0/);
});
