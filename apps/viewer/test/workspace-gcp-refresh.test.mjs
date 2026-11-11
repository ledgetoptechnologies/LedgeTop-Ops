import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
const hydrateSource = source.split(/\r?\n/).find(line => line.startsWith('function hydrateExpandedTask('));
const workspaceSource = source.split(/\r?\n/).find(line => line.startsWith('function gcpWorkspace('));
const setListSource=source.split(/\r?\n/).find(line=>line.startsWith('function validGcpSetList('));
const refreshStart = source.indexOf('async function refreshGcpWorkspace(');
const refreshEnd = source.indexOf('\nasync function changeGcpSet', refreshStart);
const refreshSource = source.slice(refreshStart, refreshEnd);
const pageSource = source.slice(source.indexOf('async function loadMoreGcpCandidates('), source.indexOf('\nasync function privateGcpImage('));

function fixture(api = async () => ({}), { projectStatus = 'active', taskStatus = 'active' } = {}) {
  const state = {
    tasks: [{ id: 'task', datasetId: 'dataset', projectId: 'project', status: taskStatus }],
    projects: [{ id: 'project', status: projectStatus }],
    datasets: [{ id: 'dataset', status: 'finalized' }],
    taskDetails: { task: { gcp: { sets: [] } } },
    expandedTaskId: 'task', taskPage: 'gcp', gcpWorkspaces: {},
  };
  const context = vm.createContext({
    state, api, workspaceAuthority: () => state.token, can: () => true, URLSearchParams, encodeURIComponent,
    render() {}, releaseGcpImage() {}, toast() {}, refreshTaskDetails() {},
  });
  vm.runInContext(`const gcpAutoImports=new Map();${workspaceSource}\n${setListSource}\n${refreshSource}\n${pageSource}`, context);
  return { state, context };
}

test('late candidate pages are discarded after the selected point changes', async () => {
  let finish;
  const {state,context}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const workspace=context.gcpWorkspace('task');workspace.pointId='point-a';
  const gcp=state.taskDetails.task.gcp;
  Object.assign(gcp,{candidates:[{id:'photo-a'}],pagination:{hasMore:true,nextOffset:200}});
  const pending=context.loadMoreGcpCandidates('task');
  workspace.pointId='point-b';
  finish({images:[{id:'wrong-photo'}],pagination:{hasMore:false}});await pending;
  assert.deepEqual(gcp.candidates,[{id:'photo-a'}]);
  assert.equal(gcp.pagination.nextOffset,200);
});

test('repeated load-more clicks use one request and deduplicate page overlap', async () => {
  let finish,calls=0;
  const {state,context}=fixture(()=>{calls++;return new Promise(resolve=>{finish=resolve;});});
  const workspace=context.gcpWorkspace('task');workspace.pointId='point';
  const gcp=state.taskDetails.task.gcp;
  Object.assign(gcp,{candidates:[{id:'photo-a'}],pagination:{hasMore:true,nextOffset:200}});
  const first=context.loadMoreGcpCandidates('task');
  await context.loadMoreGcpCandidates('task');assert.equal(calls,1);
  finish({images:[{id:'photo-a'},{id:'photo-b'},{id:'photo-b'}],pagination:{hasMore:false}});await first;
  assert.deepEqual(Array.from(gcp.candidates,image=>image.id),['photo-a','photo-b']);
  assert.equal(gcp.pagination.hasMore,false);
  assert.equal(workspace.pageRequest,null);
});

test('hydration does not scan while task details are still loading', () => {
  let refreshes = 0;
  const context = vm.createContext({
    state: { expandedTaskId: 'task', taskPage: 'gcp', taskDetails: { task: { loading: true } } },
    refreshGcpWorkspace: async () => { refreshes++; }, refreshTaskDetails() {}, render() {}, toast() {},
  });
  vm.runInContext(hydrateSource, context);
  context.hydrateExpandedTask();
  assert.equal(refreshes, 0);
  context.state.taskDetails.task = { task: { id: 'task' } };
  context.hydrateExpandedTask();
  assert.equal(refreshes, 1);
});

test('concurrent GCP page refreshes share one auto-import request', async () => {
  let releaseImport;
  const importPending = new Promise(resolve => { releaseImport = resolve; });
  const calls = [];
  const { context } = fixture(async (path, options) => {
    calls.push([path, options?.method || 'GET']);
    if (path.endsWith('/auto-import')) return importPending;
    if (path === '/api/v1/gcp-sets/set') return { set: { id: 'set', pointCount: 1 }, points: [{ id: 'point' }] };
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?')) return { images: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const first = context.refreshGcpWorkspace('task');
  const second = context.refreshGcpWorkspace('task');
  await Promise.resolve();
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  releaseImport({ sets: [{ id: 'set', pointCount: 1 }] });
  await Promise.all([first, second]);
  assert.equal(calls.filter(([, method]) => method === 'POST').length, 1);
  assert.equal(context.state.gcpWorkspaces.task.autoScannedDatasetId, 'dataset');
});

test('failed dependent reads retry with the successfully imported set list', async () => {
  let importCalls = 0, failSetRead = true;
  const { context } = fixture(async (path, options) => {
    if (path.endsWith('/auto-import')) { importCalls++; return { sets: [{ id: 'set', pointCount: 1 }] }; }
    if (path === '/api/v1/gcp-sets/set') {
      if (failSetRead) { failSetRead = false; throw new Error('temporary set read failure'); }
      return { set: { id: 'set', pointCount: 1 }, points: [{ id: 'point' }] };
    }
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?')) return { images: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  await assert.rejects(context.refreshGcpWorkspace('task'), /temporary set read failure/);
  assert.equal(context.state.gcpWorkspaces.task.autoScannedDatasetId, 'dataset');
  await context.refreshGcpWorkspace('task');
  assert.equal(importCalls, 1);
  assert.equal(context.state.taskDetails.task.gcp.sets[0].id, 'set');
});

test('direct archived task routes never auto-import raw GCP sources', async () => {
  const calls = [];
  const { context } = fixture(async (path, options) => {
    calls.push([path, options?.method || 'GET']);
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    throw new Error(`Unexpected request ${path}`);
  }, { projectStatus: 'archived' });
  await context.refreshGcpWorkspace('task');
  assert.equal(calls.some(([, method]) => method === 'POST'), false);
});

test('a late response for a previous set cannot replace the latest selected set', async () => {
  let releaseSetA;
  const setAPending = new Promise(resolve => { releaseSetA = resolve; });
  const { context } = fixture(async path => {
    if (path === '/api/v1/gcp-sets/set-a') return setAPending;
    if (path === '/api/v1/gcp-sets/set-b') return { set: { id: 'set-b' }, points: [{ id: 'point-b' }] };
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?')) return { images: [{ id: 'photo-b' }] };
    throw new Error(`Unexpected request ${path}`);
  });
  const workspace = context.gcpWorkspace('task');
  workspace.autoScannedDatasetId = 'dataset';
  workspace.autoImportedSetsByDatasetId = { dataset: [{ id: 'set-a' }, { id: 'set-b' }] };
  workspace.setId = 'set-a';
  const stale = context.refreshGcpWorkspace('task');
  workspace.setId = 'set-b';
  workspace.pointId = null;
  const latest = context.refreshGcpWorkspace('task');
  await latest;
  releaseSetA({ set: { id: 'set-a' }, points: [{ id: 'point-a' }] });
  await stale;
  assert.equal(workspace.setId, 'set-b');
  assert.equal(workspace.pointId, 'point-b');
  assert.deepEqual(context.state.taskDetails.task.gcp.points.map(point => point.id), ['point-b']);
  assert.deepEqual(context.state.taskDetails.task.gcp.candidates.map(image => image.id), ['photo-b']);
});

test('a late candidate response for an old point cannot replace current point results', async () => {
  let releasePointA;
  const pointAPending = new Promise(resolve => { releasePointA = resolve; });
  const { context } = fixture(async path => {
    if (path === '/api/v1/gcp-sets/set') return { set: { id: 'set' }, points: [{ id: 'point-a' }, { id: 'point-b' }] };
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?pointId=point-a')) return pointAPending;
    if (path.includes('/gcp-images?pointId=point-b')) return { images: [{ id: 'photo-b' }] };
    throw new Error(`Unexpected request ${path}`);
  });
  const workspace = context.gcpWorkspace('task');
  workspace.autoScannedDatasetId = 'dataset';
  workspace.autoImportedSetsByDatasetId = { dataset: [{ id: 'set' }] };
  workspace.setId = 'set';
  workspace.pointId = 'point-a';
  const stale = context.refreshGcpWorkspace('task');
  await Promise.resolve();
  await Promise.resolve();
  workspace.pointId = 'point-b';
  const latest = context.refreshGcpWorkspace('task');
  await latest;
  releasePointA({ images: [{ id: 'photo-a' }] });
  await stale;
  assert.equal(workspace.pointId, 'point-b');
  assert.deepEqual(context.state.taskDetails.task.gcp.candidates.map(image => image.id), ['photo-b']);
});

test('fresh task details replace the cached auto-import set list after a manual import', async () => {
  const { context } = fixture(async path => {
    if (path === '/api/v1/gcp-sets/new-manual-set') return { set: { id: 'new-manual-set' }, points: [{ id: 'point-new' }] };
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?')) return { images: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const workspace = context.gcpWorkspace('task');
  workspace.autoScannedDatasetId = 'dataset';
  workspace.authoritativeGcpSets = true;
  workspace.autoImportedSetsByDatasetId = { dataset: [{ id: 'old-auto-set' }] };
  workspace.setId = 'old-auto-set';
  context.state.taskDetails.task.gcp = { sets: [{ id: 'new-manual-set' }] };
  await context.refreshGcpWorkspace('task');
  assert.equal(workspace.setId, 'new-manual-set');
  assert.deepEqual(context.state.taskDetails.task.gcp.points.map(point => point.id), ['point-new']);
});

test('fresh empty task details remove deleted sets instead of restoring cached rows', async () => {
  const { context } = fixture(async path => {
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const workspace = context.gcpWorkspace('task');
  workspace.autoScannedDatasetId = 'dataset';
  workspace.authoritativeGcpSets = true;
  workspace.autoImportedSetsByDatasetId = { dataset: [{ id: 'deleted-set' }] };
  workspace.setId = 'deleted-set';
  context.state.taskDetails.task.gcp = { sets: [] };
  await context.refreshGcpWorkspace('task');
  assert.equal(workspace.setId, null);
  assert.deepEqual(context.state.taskDetails.task.gcp.sets, []);
});

test('late auto-import cannot overwrite a newer authoritative manual-import list', async () => {
  let releaseImport;
  const importPending = new Promise(resolve => { releaseImport = resolve; });
  const { context } = fixture(async path => {
    if (path.endsWith('/auto-import')) return importPending;
    if (path === '/api/v1/datasets/dataset/gcp-sets') return { sets: [{ id: 'manual-set' }] };
    if (path === '/api/v1/gcp-sets/manual-set') return { set: { id: 'manual-set' }, points: [{ id: 'manual-point' }] };
    if (path.endsWith('/gcp-correspondences')) return { correspondences: [] };
    if (path.includes('/gcp-images?')) return { images: [] };
    throw new Error(`Unexpected request ${path}`);
  });
  const workspace = context.gcpWorkspace('task');
  const staleScan = context.refreshGcpWorkspace('task');
  await Promise.resolve();
  workspace.gcpSetListVersion = 1;
  workspace.authoritativeGcpSets = true;
  workspace.autoImportedSetsByDatasetId = { dataset: [{ id: 'manual-set' }] };
  context.state.taskDetails.task.gcp = { sets: [{ id: 'manual-set' }] };
  const authoritativeRefresh = context.refreshGcpWorkspace('task');
  releaseImport({ sets: [{ id: 'old-auto-set' }] });
  await Promise.all([staleScan, authoritativeRefresh]);
  assert.equal(workspace.autoScannedDatasetId, 'dataset');
  assert.equal(workspace.authoritativeGcpSets, true);
  assert.deepEqual(workspace.autoImportedSetsByDatasetId.dataset.map(set => set.id), ['manual-set']);
  assert.deepEqual(context.state.taskDetails.task.gcp.sets.map(set => set.id), ['manual-set']);
  assert.equal(workspace.setId, 'manual-set');
});

test('quiet task refresh keeps the current GCP page object while load-more is in flight',async()=>{
  let finish;const {state,context}=fixture(path=>path.includes('/gcp-images?')?new Promise(resolve=>{finish=resolve;}):Promise.resolve(path.includes('/storage?')?{}:path.includes('/gcp-sets')?{sets:[]}:path.includes('/attempts?')?{attempts:[]}:{task:{id:'task',datasetId:'dataset',projectId:'project',status:'active'}}));
  const workspace=context.gcpWorkspace('task');workspace.pointId='point';state.token='token';state.expandedTaskId=null;
  const detail=state.taskDetails.task,gcp=detail.gcp;Object.assign(gcp,{candidates:[{id:'photo-a'}],pagination:{hasMore:true,nextOffset:200}});
  const pending=context.loadMoreGcpCandidates('task');context.taskDetailRefreshes=new Set();
  const start=source.indexOf('async function refreshTaskDetails('),end=source.indexOf('\nfunction releaseGcpImage(',start);vm.runInContext(source.slice(start,end),context);
  await context.refreshTaskDetails('task',true);assert.equal(state.taskDetails.task,detail);assert.equal(detail.gcp,gcp);
  finish({images:[{id:'photo-b'}],pagination:{hasMore:false,nextOffset:null}});await pending;
  assert.deepEqual(Array.from(gcp.candidates,image=>image.id),['photo-a','photo-b']);
});

test('changing candidate mode clears the stale cursor and invalidates an in-flight page',async()=>{
  let finish;const {state,context}=fixture(()=>new Promise(resolve=>{finish=resolve;}));
  const workspace=context.gcpWorkspace('task');workspace.pointId='point';
  const gcp=state.taskDetails.task.gcp;Object.assign(gcp,{candidates:[{id:'old'}],ranking:{radiusM:10},pagination:{hasMore:true,nextOffset:200}});
  const pending=context.loadMoreGcpCandidates('task');
  const modeSource=source.split(/\r?\n/).find(line=>line.startsWith('function changeGcpCandidateMode('));vm.runInContext(modeSource,context);
  context.changeGcpCandidateMode('task','nearest');
  assert.equal(gcp.pagination,null);assert.equal(gcp.ranking,null);assert.equal(gcp.candidates.length,0);
  finish({images:[{id:'stale'}],pagination:{hasMore:true,nextOffset:400}});await pending;
  assert.equal(gcp.pagination,null);assert.equal(gcp.candidates.length,0);assert.equal(workspace.pageRequest,null);
});

for(const change of ['token','dataset','detail','permission'])test(`late GCP refresh cannot write after ${change} changes`,async()=>{
  let release;const {state,context}=fixture(path=>path.includes('/gcp-sets/set')?new Promise(resolve=>{release=resolve;}):Promise.resolve({correspondences:[]}));
  state.token='first';const workspace=context.gcpWorkspace('task');workspace.setId='set';workspace.autoScannedDatasetId='dataset';workspace.autoImportedSetsByDatasetId={dataset:[{id:'set'}]};
  let permitted=true;context.can=()=>permitted;const pending=context.refreshGcpWorkspace('task');await Promise.resolve();
  const old=state.taskDetails.task;
  if(change==='token')state.token='other';if(change==='dataset')state.tasks[0]={...state.tasks[0],datasetId:'other'};
  if(change==='detail')state.taskDetails.task={gcp:{sets:[{id:'new'}]}};if(change==='permission')permitted=false;
  release({set:{id:'set'},points:[{id:'old-point'}]});await pending;
  assert.equal(old.gcp.points,undefined);if(change==='detail')assert.equal(state.taskDetails.task.gcp.sets[0].id,'new');
});

test('quiet task detail response is discarded after dataset reassociation',async()=>{
  let release;const {state,context}=fixture(path=>path==='/api/v1/tasks/task'?new Promise(resolve=>{release=resolve;}):Promise.resolve(path.includes('/attempts?')?{attempts:[]}:{}));
  state.token='token';state.expandedTaskId=null;context.taskDetailRefreshes=new Set();
  const start=source.indexOf('async function refreshTaskDetails('),end=source.indexOf('\nfunction releaseGcpImage(',start);vm.runInContext(source.slice(start,end),context);
  const pending=context.refreshTaskDetails('task',true);state.tasks[0]={...state.tasks[0],datasetId:'other'};
  release({task:{id:'task',datasetId:'dataset',projectId:'project'}});await pending;
  assert.equal(state.tasks[0].datasetId,'other');
});

test('render draft handoff preserves the same file input node only for the same authorized task and dataset',()=>{
  const state={token:'token',tasks:[{id:'task',datasetId:'dataset'}]},file={name:'control.csv'},details={open:true};let removed=false,replaced=null,allowed=true;
  const old={dataset:{taskId:'task',datasetId:'dataset'},elements:{file:{files:[file]}},closest:()=>details,remove(){removed=true;}};
  const newDetails={open:false},target={dataset:{taskId:'task',datasetId:'dataset'},closest:()=>newDetails,replaceWith(form){replaced=form;}};
  const content={querySelector:()=>old,querySelectorAll:()=>[target]},context=vm.createContext({state,workspaceAuthority:()=>state.token,content,document:{activeElement:null},can:()=>allowed});
  const start=source.indexOf('function takeGcpImportDraft('),end=source.indexOf('\nfunction render(){',start);vm.runInContext(source.slice(start,end),context);
  const draft=context.takeGcpImportDraft();assert.equal(removed,true);context.restoreGcpImportDraft(draft);
  assert.equal(replaced,old);assert.equal(replaced.elements.file.files[0],file);assert.equal(newDetails.open,true);
  replaced=null;state.token='other';context.restoreGcpImportDraft(draft);assert.equal(replaced,null);
  state.token='token';allowed=false;context.restoreGcpImportDraft(draft);assert.equal(replaced,null);
  allowed=true;state.tasks[0].datasetId='other';context.restoreGcpImportDraft(draft);assert.equal(replaced,null);
});

test('permission loss prevents a pending candidate page from being appended',async()=>{
  let finish,allowed=true;const {state,context}=fixture(()=>new Promise(resolve=>{finish=resolve;}));context.can=()=>allowed;
  const workspace=context.gcpWorkspace('task');workspace.pointId='point';const gcp=state.taskDetails.task.gcp;
  Object.assign(gcp,{candidates:[{id:'old'}],pagination:{hasMore:true,nextOffset:200}});
  const pending=context.loadMoreGcpCandidates('task');allowed=false;finish({images:[{id:'new'}],pagination:{hasMore:false}});await pending;
  assert.deepEqual(gcp.candidates,[{id:'old'}]);assert.equal(workspace.pageRequest,null);
});

test('partial pixel input remains blank and cannot become a zero coordinate',()=>{
  const {state,context}=fixture();const workspace=context.gcpWorkspace('task');context.positionGcpMarker=()=>{};
  const fn=source.split(/\r?\n/).find(line=>line.startsWith('function setGcpDraft('));vm.runInContext(fn,context);
  context.setGcpDraft('task','','12');assert.equal(workspace.rawPixel.pixelX,'');assert.equal(workspace.rawPixel.pixelY,'12');assert.equal(workspace.draftPixel,null);
  context.setGcpDraft('task','0','12');assert.equal(workspace.draftPixel.pixelX,0);assert.equal(workspace.draftPixel.pixelY,12);
});

test('same-task import redraw restores focused input and caret',()=>{
  const state={token:'token',tasks:[{id:'task',datasetId:'dataset'}]},focused={selectionStart:2,selectionEnd:4,selectionDirection:'forward',focus(){this.didFocus=true;},setSelectionRange(...value){this.range=value;}};
  const old={dataset:{taskId:'task',datasetId:'dataset'},contains:node=>node===focused,closest:()=>({open:true}),remove(){}};
  const target={dataset:{taskId:'task',datasetId:'dataset'},closest:()=>({}),replaceWith(){}};
  const content={querySelector:()=>old,querySelectorAll:()=>[target]},context=vm.createContext({state,workspaceAuthority:()=>state.token,content,document:{activeElement:focused},can:()=>true});
  const start=source.indexOf('function takeGcpImportDraft('),end=source.indexOf('\nfunction render(){',start);vm.runInContext(source.slice(start,end),context);
  context.restoreGcpImportDraft(context.takeGcpImportDraft());assert.equal(focused.didFocus,true);assert.deepEqual(focused.range,[2,4,'forward']);
});

test('height source remains selected on redraw and unavailable saved choice cannot submit',()=>{
  const state={tasks:[{id:'task',datasetId:'dataset'}],gcpWorkspaces:{task:{setId:'set',heightScope:JSON.stringify(['dataset','set']),heightSource:'ellipsoidal'}}},calls=[],notices=[],context=vm.createContext({state,workspaceAuthority:()=>state.token,gcpWorkspace:id=>state.gcpWorkspaces[id],can:()=>true,mutate:(...args)=>calls.push(args),toast:message=>notices.push(message),encodeURIComponent});
  const start=source.indexOf('function bindGcpHeightChoice('),end=source.indexOf('\nfunction bind(){',start);vm.runInContext(source.slice(start,end),context);
  const select={value:'source',options:[{value:'source'},{value:'ellipsoidal'}]},form={dataset:{taskId:'task'},elements:{gcpHeightSource:select}};
  context.bindGcpHeightChoice(form);assert.equal(select.value,'ellipsoidal');
  select.options=[{value:'source'}];context.bindGcpHeightChoice(form);assert.equal(select.value,'');
  context.submitGcpPreparation({preventDefault(){},currentTarget:form});assert.equal(calls.length,0);assert.equal(notices.length,1);
  select.value='source';select.onchange();context.submitGcpPreparation({preventDefault(){},currentTarget:form});assert.equal(calls.length,1);
});

test('GCP import cannot preview after token changes while file is read',async()=>{
  let finish;const file={name:'source.csv',text:()=>new Promise(resolve=>{finish=resolve;})},form={dataset:{taskId:'task',datasetId:'dataset'},elements:{file:{files:[file]},format:{value:'generic-csv-v1'},displayName:{value:'Control'}}};
  const state={token:'one',taskPage:'gcp',expandedTaskId:'task',tasks:[{id:'task',datasetId:'dataset',projectId:'project',status:'active'}],taskDetails:{task:{}}},calls=[];
  const context=vm.createContext({state,workspaceAuthority:()=>state.token,can:()=>true,api:(...args)=>calls.push(args),toast(){},encodeURIComponent});
  const start=source.indexOf('async function importGcp('),end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),context);
  const pending=context.importGcp({preventDefault(){},currentTarget:form});state.token='two';finish('raw');await pending;assert.equal(calls.length,0);
});

test('GCP import confirmation cannot write after dataset changes',async()=>{
  const file={name:'source.csv',text:async()=> 'raw'},form={dataset:{taskId:'task',datasetId:'dataset'},elements:{file:{files:[file]},format:{value:'generic-csv-v1'},displayName:{value:'Control'}}};
  const state={token:'one',taskPage:'gcp',expandedTaskId:'task',tasks:[{id:'task',datasetId:'dataset',projectId:'project',status:'active'}],taskDetails:{task:{}}},calls=[],buttons={'.modal-cancel':{},'.gcp-confirm':{}};
  const context=vm.createContext({state,workspaceAuthority:()=>state.token,can:()=>true,api:async(...args)=>{calls.push(args);return{pointCount:1,columns:{},provenance:{},warnings:[],confirmationToken:'confirm'};},toast(){},encodeURIComponent,esc:x=>String(x),openModal(){},modalContent:{querySelector:key=>buttons[key]},modal:{close(){}},shell:{setAttribute(){},removeAttribute(){}}});
  const start=source.indexOf('async function importGcp('),end=source.indexOf('\n}',start)+2;vm.runInContext(source.slice(start,end),context);
  await context.importGcp({preventDefault(){},currentTarget:form});assert.equal(calls.length,1);state.tasks[0].datasetId='other';await buttons['.gcp-confirm'].onclick();assert.equal(calls.length,1);
});

test('list read started before auto-import commit is reconciled by a post-commit read',async()=>{
  let finishImport;const importPending=new Promise(resolve=>{finishImport=resolve;}),calls=[];
  const {state,context}=fixture(async path=>{
    calls.push(path);if(path.endsWith('/auto-import'))return importPending;
    if(path==='/api/v1/datasets/dataset/gcp-sets')return{sets:[{id:'new-set'}]};
    if(path==='/api/v1/gcp-sets/new-set')return{set:{id:'new-set'},points:[{id:'new-point'}]};
    if(path.endsWith('/gcp-correspondences'))return{correspondences:[]};if(path.includes('/gcp-images?'))return{images:[]};throw new Error(path);
  });
  const workspace=context.gcpWorkspace('task'),pending=context.refreshGcpWorkspace('task');await Promise.resolve();
  workspace.gcpSetListVersion=1;workspace.authoritativeGcpSets=true;state.taskDetails.task.gcp={sets:[]};
  finishImport({sets:[{id:'new-set'}]});await pending;
  assert.equal(calls.filter(path=>path==='/api/v1/datasets/dataset/gcp-sets').length,1);
  assert.equal(state.taskDetails.task.gcp.sets[0].id,'new-set');assert.equal(workspace.autoScannedDatasetId,'dataset');
});

test('a newer set-list change during post-import refetch cannot be overwritten',async()=>{
  let finishImport,finishList;const {state,context}=fixture(path=>{
    if(path.endsWith('/auto-import'))return new Promise(resolve=>{finishImport=resolve;});
    if(path==='/api/v1/datasets/dataset/gcp-sets')return new Promise(resolve=>{finishList=resolve;});
    if(path.endsWith('/gcp-correspondences'))return Promise.resolve({correspondences:[]});throw new Error(path);
  });
  const workspace=context.gcpWorkspace('task'),pending=context.refreshGcpWorkspace('task');await Promise.resolve();
  workspace.gcpSetListVersion=1;workspace.authoritativeGcpSets=true;state.taskDetails.task.gcp={sets:[]};finishImport({sets:[{id:'deleted'}]});
  await new Promise(resolve=>setImmediate(resolve));workspace.gcpSetListVersion=2;state.taskDetails.task.gcp={sets:[]};finishList({sets:[{id:'deleted'}]});await pending;
  assert.equal(state.taskDetails.task.gcp.sets.length,0);assert.notEqual(workspace.autoScannedDatasetId,'dataset');
});

test('auto-import receipt requires dataset-bound unique set IDs and complete scan status',()=>{
  const line=source.split(/\r?\n/).find(value=>value.startsWith('function validGcpAutoImportReceipt(')),context=vm.createContext({});vm.runInContext(`${setListSource}\n${line}`,context);
  const valid={sets:[{id:'set-1',datasetId:'dataset'}],scanned:1,imported:1,ignoredInvalid:0,failed:0,limited:false};
  assert.equal(context.validGcpAutoImportReceipt(valid,'dataset'),true);
  for(const invalid of [{}, {...valid,sets:null},{...valid,sets:[{id:'set-1',datasetId:'other'}]}, {...valid,sets:[{id:'',datasetId:'dataset'}]}, {...valid,sets:[valid.sets[0],valid.sets[0]]},{...valid,scanned:-1},{...valid,limited:'false'}])assert.equal(context.validGcpAutoImportReceipt(invalid,'dataset'),false);
});

test('limited scans continue only bounded progressing batches and allow an explicit retry',async()=>{
 let calls=0;const {state,context}=fixture(async path=>{
  if(path.endsWith('/auto-import')){calls++;return{sets:[],scanned:20,imported:0,ignoredInvalid:20,failed:0,limited:calls<4};}
  if(path.endsWith('/gcp-correspondences'))return{correspondences:[]};throw new Error(path);
 });
 const workspace=context.gcpWorkspace('task');await context.refreshGcpWorkspace('task');
 assert.equal(calls,3);assert.equal(workspace.autoScannedDatasetId,null);assert.equal(workspace.autoScanStatus.limited,true);assert.equal(workspace.autoScanStatus.scanned,60);
 await context.refreshGcpWorkspace('task');assert.equal(calls,3,'paused state must not auto-loop');
 const line=source.split(/\r?\n/).find(value=>value.startsWith('async function retryGcpAutoScan('));vm.runInContext(line,context);
 await context.retryGcpAutoScan('task');assert.equal(calls,4);assert.equal(workspace.autoScannedDatasetId,'dataset');assert.equal(workspace.autoScanStatus,null);
});
test('failed or nonprogressing scans pause immediately without retry loops',async()=>{
 for(const receipt of [{sets:[],scanned:2,imported:0,ignoredInvalid:1,failed:1,limited:true},{sets:[],scanned:0,imported:0,ignoredInvalid:0,failed:0,limited:true}]){
  let calls=0;const {context}=fixture(async path=>{if(path.endsWith('/auto-import')){calls++;return receipt}if(path.endsWith('/gcp-correspondences'))return{correspondences:[]};throw new Error(path)});
  const workspace=context.gcpWorkspace('task');await context.refreshGcpWorkspace('task');assert.equal(calls,1);assert.equal(workspace.autoScannedDatasetId,null);assert.ok(workspace.autoScanStatus);
  await context.refreshGcpWorkspace('task');assert.equal(calls,1);
 }
});

test('failed later batch refreshes committed sets once while retaining incomplete status',async()=>{
 let writes=0,reads=0;const {state,context}=fixture(async path=>{
  if(path.endsWith('/auto-import')){writes++;if(writes===1)return{sets:[{id:'set-1',datasetId:'dataset'}],scanned:20,imported:1,ignoredInvalid:19,failed:0,limited:true};throw new Error('second batch unavailable');}
  if(path==='/api/v1/datasets/dataset/gcp-sets'){reads++;return{sets:[{id:'set-1',datasetId:'dataset'}]};}
  throw new Error(path);
 });
 const workspace=context.gcpWorkspace('task');await assert.rejects(context.refreshGcpWorkspace('task'),/second batch unavailable/);
 assert.equal(writes,2);assert.equal(reads,1);assert.equal(state.taskDetails.task.gcp.sets[0].id,'set-1');
 assert.equal(workspace.autoScannedDatasetId,undefined);assert.equal(workspace.autoScanStatus.failed,1);assert.equal(workspace.autoScanStatus.scanned,20);
});
