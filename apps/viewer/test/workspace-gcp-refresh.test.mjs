import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../workspace-projects.js', import.meta.url), 'utf8');
const hydrateSource = source.split(/\r?\n/).find(line => line.startsWith('function hydrateExpandedTask('));
const workspaceSource = source.split(/\r?\n/).find(line => line.startsWith('function gcpWorkspace('));
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
    state, api, can: () => true, URLSearchParams, encodeURIComponent,
    render() {}, releaseGcpImage() {}, toast() {}, refreshTaskDetails() {},
  });
  vm.runInContext(`const gcpAutoImports=new Map();${workspaceSource}\n${refreshSource}\n${pageSource}`, context);
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
