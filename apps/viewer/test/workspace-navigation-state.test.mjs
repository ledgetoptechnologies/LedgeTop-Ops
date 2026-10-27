import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasUnsavedGcpMark,createWorkspaceNavigationWork,workspaceNavigationState} from '../workspace-navigation-state.mjs';
import {createLegacyUploader} from './legacy-upload-fixture.mjs';
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

function uploadWindow(){
  const handlers=new Set(),removed=[];
  return {handlers,removed,
    addEventListener(type,handler){assert.equal(type,'beforeunload');handlers.add(handler);},
    removeEventListener(type,handler){assert.equal(type,'beforeunload');removed.push(handler);handlers.delete(handler);},
    leave(){const event={prevented:false,preventDefault(){this.prevented=true;}};for(const handler of handlers)handler(event);return event;},
  };
}

test('actual legacy uploader guards all navigation until upload settles and preserves unrelated unload handlers',async()=>{
  for(const outcome of ['success','creation-failed','chunk-failed','finalize-failed']){
    const windowRef=uploadWindow(),unrelated=()=>{},work=createWorkspaceNavigationWork({windowRef});
    windowRef.handlers.add(unrelated);
    const entered=deferred(),create=deferred(),state={busy:false,token:'test-only'},calls=[],messages=[];
    let specs;
    const upload=createLegacyUploader({navigationWork:work,state,sessionStorage:{setItem(){},removeItem(){}},
      modal:{close(){}},toast:message=>messages.push(message),load:async()=>{},digest:async()=> 'test-digest',
      api:async(path,init)=>{
        calls.push(path);
        if(path.endsWith('/uploads')){specs=init.body.files;entered.resolve();return create.promise;}
        if(outcome==='finalize-failed')throw Error('Finalize unavailable');
        return {};
      },workspaceFetch:async()=>({ok:outcome!=='chunk-failed',status:outcome==='chunk-failed'?503:200}),
    });
    const files=[new File(['payload'],'model.obj')],form={elements:{files:{files},datasetId:{value:'dataset'},processingRole:{value:'model'}},querySelector:()=>({value:0})};
    const result=upload(form);await entered.promise;
    assert.equal(windowRef.handlers.size,2,outcome);
    const guard=[...windowRef.handlers].find(handler=>handler!==unrelated);
    const leave=windowRef.leave();assert.equal(leave.prevented,true);assert.equal(leave.returnValue,'');
    assert.equal(work.snapshot().pendingLegacyUpload,true,'a cancelled leave does not dispose the upload');
    assert.equal(form.elements.files.files,files);assert.equal(calls.length,1,'unload guard sends or retries nothing');
    if(outcome==='creation-failed')create.reject(Error('Create unavailable'));
    else create.resolve({uploadToken:'test-upload',upload:{id:'upload',chunkSize:1024,files:specs.map(spec=>({...spec,chunkCount:1,missingChunks:[0]}))}});
    await result;
    assert.equal(state.busy,false);assert.equal(work.snapshot().pendingLegacyUpload,false);
    assert.deepEqual([...windowRef.handlers],[unrelated],outcome);
    assert.equal(windowRef.removed.includes(guard),true);
    assert.equal(windowRef.leave().prevented,false,'completed/failed uploads stop blocking navigation');
    assert.equal(messages.some(message=>message.includes('Reselect')),outcome!=='success');
  }
});

test('concurrent tracked uploads share one unload guard until the last completion, including synchronous failure',async()=>{
  const windowRef=uploadWindow(),work=createWorkspaceNavigationWork({windowRef}),first=deferred(),second=deferred();
  const a=work.trackLegacyUpload(1,()=>first.promise),b=work.trackLegacyUpload(2,()=>second.promise);
  assert.equal(windowRef.handlers.size,1);
  first.resolve();await a;assert.equal(windowRef.handlers.size,1);assert.equal(windowRef.leave().prevented,true);
  second.reject(Error('Failed'));await assert.rejects(b);
  assert.equal(windowRef.handlers.size,0);assert.equal(windowRef.removed.length,1);
  await assert.rejects(work.trackLegacyUpload(1,()=>{throw Error('Synchronous failure');}));
  assert.equal(windowRef.handlers.size,0);assert.equal(work.snapshot().pendingLegacyUpload,false);
});
