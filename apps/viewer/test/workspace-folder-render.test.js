'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');
const take = (start, end) => {
  const at = source.indexOf(start), stop = source.indexOf(end, at);
  assert.ok(at >= 0 && stop > at, `missing shipped source ${start}`);
  return source.slice(at, stop);
};
const treeModule = () => import(pathToFileURL(path.join(__dirname, '..', 'workspace-folder-tree.mjs')).href);

async function treeContext(overrides = {}) {
  const tree = await treeModule();
  const context = {
    ...tree,
    state: { section: 'dashboard', selectedProjectId: 'p', expandedTaskId: null, projects: [{ id: 'p', displayName: 'Project', status: 'active' }], tasks: [
      { id: 'root-task', projectId: 'p', folderId: null }, { id: 'nested-task', projectId: 'p', folderId: 'child' },
      { id: 'folder-task', projectId: 'p', folderId: 'f' }, { id: 'other-task', projectId: 'other', folderId: null },
    ], datasets: [] },
    folderCache: new Map([['p', { folders: [{ id: 'f', projectId: 'p', parentId: null, displayName: 'Folder' }, { id: 'child', projectId: 'p', parentId: 'f', displayName: 'Child' }, { id: 'empty', projectId: 'p', parentId: null, displayName: 'Archive' }], loading: false, error: null }]]),
    treeState: { projects: new Set(['p']), folders: new Set() }, treePending: null, treeRenaming: null,
    can: () => true, queueMicrotask: () => {}, loadProjectFolders: () => {},
    button: (action, id, label) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    taskPanel: (task, row) => `<article data-tree-key="t:${task.id}" aria-level="${row.level}" data-tree-parent="${row.parentKey}">${task.id}</article>`,
    matchMedia: () => ({ matches: false }),
    ...overrides,
  };
  vm.createContext(context);
  vm.runInContext([
    source.split(/\r?\n/).find(line => line.startsWith('const esc=')),
    source.split(/\r?\n/).find(line => line.startsWith('function countLabel(')),
    'function isProjectOpen(projectId){return state.section===\'dashboard\'&&(projectId===state.selectedProjectId||treeState.projects.has(projectId))}',
    take('const TREE_ICONS={', '\nfunction datasetActions('),
  ].join('\n'), context);
  return context;
}

test('an open project shows its folders and tasks inline, with nested folders expanding in place', async () => {
  const context = await treeContext();
  let html = context.projectTree(context.state.projects[0]);
  assert.match(html, /class="project-detail tree-body"[^>]*role="rowgroup"[^>]*data-tree-body="p"/);
  // Collapsed: folders by name, then the top-level task; nothing from inside a folder or another project.
  assert.deepEqual([...html.matchAll(/data-tree-key="([^"]+)"/g)].map(match => match[1]), ['f:empty', 'f:f', 't:root-task']);
  assert.match(html, /<strong>Folder<\/strong><span class="tree-count">2 tasks<\/span>/, 'a folder counts tasks in its subfolders too');
  assert.match(html, /<strong>Archive<\/strong><span class="tree-count">Empty<\/span>/);
  assert.match(html, /data-tree-key="f:f"[^>]*aria-expanded="false" data-task-drop-project="p" data-task-drop-folder="f"/);
  assert.doesNotMatch(html, /nested-task|folder-task|other-task/);
  // Expanded folders show their children one level deeper, subfolders first.
  context.treeState.folders.add('f'); context.treeState.folders.add('child');
  html = context.projectTree(context.state.projects[0]);
  assert.deepEqual([...html.matchAll(/data-tree-key="([^"]+)"/g)].map(match => match[1]), ['f:empty', 'f:f', 'f:child', 't:nested-task', 't:folder-task', 't:root-task']);
  assert.match(html, /data-tree-key="f:child"[^>]*data-tree-parent="f:f"/);
  assert.match(html, /<article data-tree-key="t:nested-task" aria-level="4"/);
  // Folder "⋯": New subfolder, Rename (F2), separator, Delete (only when empty).
  const menu = html.slice(html.indexOf('data-tree-key="f:f"'), html.indexOf('data-tree-key="f:child"'));
  assert.deepEqual([...menu.matchAll(/data-action="([^"]+)"/g)].map(match => match[1]), ['folder-toggle', 'folder-new', 'folder-rename', 'folder-delete']);
  assert.match(menu, /data-action="folder-delete"[^>]*aria-disabled="true" title="Only empty folders can be deleted\."/);
  assert.match(html.slice(html.indexOf('data-tree-key="f:empty"')), /data-action="folder-delete" data-id="empty"  data-project-id/);
  // An empty open folder shows a drop row.
  context.treeState.folders.add('empty');
  assert.match(context.projectTree(context.state.projects[0]), /data-tree-key="e:empty"[^>]*data-task-drop-project="p" data-task-drop-folder="empty"><div class="tree-cell" role="gridcell">Empty\. Drop tasks here\./);
  context.can = () => false;
  assert.doesNotMatch(context.projectTree(context.state.projects[0]), /folder-rename|folder-delete|folder-new/);
});

test('an inline row names a new folder or renames one, with a free default name', async () => {
  const context = await treeContext({ treePending: { projectId: 'p', parentId: null } });
  let html = context.projectTree(context.state.projects[0]);
  assert.match(html, /data-tree-key="n:p"[^>]*><div class="tree-cell tree-name-cell" role="gridcell"><span class="tree-toggle folder-toggle is-editing">[\s\S]*<input class="tree-inline-name" data-tree-new-folder="" data-project-id="p" value="New folder"/);
  context.folderCache.get('p').folders.push({ id: 'n1', projectId: 'p', parentId: null, displayName: 'New folder' });
  assert.match(context.projectTree(context.state.projects[0]), /value="New folder 2"/);
  context.treePending = null; context.treeRenaming = 'f:f';
  html = context.projectTree(context.state.projects[0]);
  assert.match(html, /<input class="tree-inline-name" data-tree-rename="f" data-project-id="p" value="Folder" aria-label="Folder name"/);
  const renamed = html.slice(html.indexOf('data-tree-key="f:f"'));
  assert.doesNotMatch(renamed.slice(0, renamed.indexOf('</div></div>')), /tree-menu/, 'no menu while renaming');
});

test('loading folders shows top-level tasks only; a folder error shows every task of this project', async () => {
  const context = await treeContext();
  context.folderCache.set('p', { folders: null, loading: true, error: null });
  let html = context.projectTree(context.state.projects[0]);
  assert.match(html, /role="status">Loading folders/);
  assert.deepEqual([...html.matchAll(/data-tree-key="(t:[^"]+)"/g)].map(match => match[1]), ['t:root-task']);
  context.folderCache.set('p', { folders: null, loading: false, error: 'Folders could not be loaded.' });
  html = context.projectTree(context.state.projects[0]);
  assert.match(html, /role="alert">Folders could not be loaded\. Showing every task at the top level/);
  assert.match(html, /data-action="folder-retry"/);
  assert.deepEqual([...html.matchAll(/data-tree-key="(t:[^"]+)"/g)].map(match => match[1]), ['t:root-task', 't:nested-task', 't:folder-task']);
  // A project opened for the first time queues exactly one folder read.
  const queued = [];
  context.queueMicrotask = callback => queued.push(callback);
  context.folderCache.delete('p');
  context.projectTree(context.state.projects[0]);
  assert.equal(queued.length, 1); assert.equal(context.folderCache.get('p').loading, true);
  context.projectTree(context.state.projects[0]);
  assert.equal(queued.length, 1, 'a pending read is not queued twice');
});

test('URLs name the project and task only; an old folder link and the open task reveal their folders', async () => {
  const saved = [];
  const context = {
    URL, URLSearchParams, location: { href: 'https://viewer.example/workspace', origin: 'https://viewer.example' }, WORKSPACE_SECTIONS: new Set(['dashboard', 'providers']), projectDataGeneration: 0,
    state: { section: 'dashboard', selectedProjectId: 'p', expandedTaskId: null, taskPage: null, tasks: [{ id: 'task', projectId: 'p', folderId: 'f' }] },
    treeState: { projects: new Set(), folders: new Set() }, treeReveals: new Map(), saveTreeState: () => saved.push(1),
    touchOpenProject: id => { context.treeState.projects.delete(id); context.treeState.projects.add(id); },
    folderCache: new Map([['p', { folders: [{ id: 'top', projectId: 'p', parentId: null }, { id: 'f', projectId: 'p', parentId: 'top' }] }]]),
  };
  vm.createContext(context);
  const tree = await treeModule();
  context.folderAncestry = tree.folderAncestry;
  vm.runInContext(take('function readWorkspaceView(', '\nconst initialView') + take('function workspaceView()', '\nfunction syncWorkspaceView') + take('function revealTreeFolder(', '\nfunction folderPath('), context);
  context.applyWorkspaceView(context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&folder=f'));
  assert.deepEqual([...context.treeState.projects], ['p']);
  assert.deepEqual([...context.treeState.folders], ['top', 'f'], 'an old ?folder= link opens that folder path');
  assert.doesNotMatch(context.workspaceUrl(), /folder=/);
  context.treeState.folders.clear();
  context.applyWorkspaceView(context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&task=task'));
  assert.deepEqual([...context.treeState.folders], ['top', 'f'], 'the open task stays visible');
  assert.match(context.workspaceUrl(), /project=p&task=task$/);
  context.treeState.folders.clear();
  context.applyWorkspaceView(context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&folder=foreign'));
  assert.deepEqual([...context.treeState.folders], []);
  assert.ok(saved.length > 0);
});

test('a folder response for a closed project or a superseded request is dropped', async () => {
  for (const change of ['close', 'newer', 'section']) {
    let resolveRequest, paints = 0;
    const request = new Promise(resolve => { resolveRequest = resolve; });
    const context = {
      api: () => request, can: () => true, workspaceAuthorizationClearing: false, paintProjectTree: () => { paints++; }, revealTreeFolder: () => {},
      folderAuthorizationGeneration: 0, state: { token: 'token', adminSession: {}, section: 'dashboard', selectedProjectId: 'a', projects: [{ id: 'a' }, { id: 'b' }] },
      treeState: { projects: new Set(['a']), folders: new Set() }, folderCache: new Map(),
    };
    vm.createContext(context);
    vm.runInContext(take('function isProjectOpen(', '\nfunction loadTreeState(') + take('function folderAuthorizationGuard(', '\nfunction folderRequestOptions(') + take('async function loadProjectFolders(', '\n// Expands the saved path'), context);
    const pending = context.loadProjectFolders('a');
    assert.equal(context.folderCache.get('a').loading, true);
    if (change === 'close') { context.treeState.projects.delete('a'); context.state.selectedProjectId = null; }
    if (change === 'newer') context.folderCache.set('a', { folders: null, loading: true });
    if (change === 'section') context.state.section = 'providers';
    resolveRequest({ folders: [{ id: 'a-folder', projectId: 'a', parentId: null }] });
    await pending;
    assert.equal(paints, 0, change);
    assert.equal(context.folderCache.get('a').folders, null, change);
  }
});

test('folders load only for an open project, and several open projects keep their own folders', async () => {
  let calls = 0;
  const context = {
    api: async url => { calls++; const project = url.split('/')[4]; return { folders: [{ id: `${project}-folder`, projectId: project, parentId: null }, { id: 'foreign', projectId: 'elsewhere', parentId: null }] }; },
    can: () => true, workspaceAuthorizationClearing: false, paintProjectTree: () => {}, revealTreeFolder: () => {}, folderAuthorizationGeneration: 0,
    state: { token: 'token', adminSession: {}, section: 'dashboard', selectedProjectId: 'a' },
    treeState: { projects: new Set(['b']), folders: new Set() }, folderCache: new Map(),
  };
  vm.createContext(context);
  vm.runInContext(take('function isProjectOpen(', '\nfunction loadTreeState(') + take('function folderAuthorizationGuard(', '\nfunction folderRequestOptions(') + take('async function loadProjectFolders(', '\n// Expands the saved path'), context);
  await context.loadProjectFolders('closed');
  assert.equal(calls, 0);
  await Promise.all([context.loadProjectFolders('a'), context.loadProjectFolders('b')]);
  assert.deepEqual(context.folderCache.get('a').folders.map(folder => folder.id), ['a-folder']);
  assert.deepEqual(context.folderCache.get('b').folders.map(folder => folder.id), ['b-folder']);
});

test('scoped refresh ignores a move-racing response and reconciles only its own project', async () => {
  const start = source.indexOf('async function refreshProjectData('), end = source.indexOf('\nconst TREE_ICONS=', start);
  const first = { id: 'one', projectId: 'p', folderId: null, folderRevision: 0 }, other = { id: 'two', projectId: 'q' };
  let resolveTasks, resolveFolders, paintCount = 0;
  const entry = { folders: [], loading: false };
  const context = {
    projectDataGeneration: 0, projectArtifactsRefreshId: null, outputFences: new Map(), workspaceLoads: 0,
    can: () => true, document: { hidden: false }, folderAuthorizationGuard: () => () => true, console,
    state: { section: 'dashboard', selectedProjectId: 'p', expandedTaskId: 'one', projectQuery: 'search', tasks: [first, other], busy: false, taskDetails: {} },
    folderCache: new Map([['p', entry]]),
    pagedApi: () => new Promise(resolve => { resolveTasks = resolve; }),
    api: () => new Promise(resolve => { resolveFolders = resolve; }),
    syncSelectedTaskFolder: () => false, patchProjectTree: () => { paintCount++; return false; },
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  let refresh = context.refreshProjectData('p');
  const moved = { ...first, folderId: 'folder', folderRevision: 1 };
  context.projectDataGeneration++;
  context.state.tasks = [moved, other];
  resolveTasks({ tasks: [first] }); resolveFolders({ folders: [] }); await refresh;
  assert.equal(context.state.tasks[0], moved); assert.equal(paintCount, 0);
  refresh = context.refreshProjectData('p');
  const current = { ...moved, status: 'processing' };
  resolveTasks({ tasks: [current, { id: 'unexpected', projectId: 'foreign' }] });
  resolveFolders({ folders: [{ id: 'folder', projectId: 'p' }, { id: 'foreign', projectId: 'q' }] }); await refresh;
  assert.deepEqual(Array.from(context.state.tasks), [other, current]);
  assert.equal(context.state.expandedTaskId, 'one'); assert.equal(context.state.projectQuery, 'search');
  assert.equal(entry.folders.length, 1); assert.equal(paintCount, 1);
  // An artifact read that began before a public link published a model keeps its other data, not its outputs, and stays queued.
  context.projectArtifactsRefreshId = new Set(['p']);
  let resolveOutputs;
  context.pagedApi = path => new Promise(resolve => { if (path.includes('/outputs')) resolveOutputs = resolve; else if (path.includes('/datasets')) resolve({ datasets: [] }); else resolveTasks = resolve; });
  context.state.datasets = [];
  const published = { id: 'output', projectId: 'p', status: 'published', viewSessionUrl: '/view' }, finished = { ...current, status: 'published' };
  context.state.outputs = [published];
  refresh = context.refreshProjectData('p');
  context.outputFences.set('p', 1);
  resolveTasks({ tasks: [finished] }); resolveFolders({ folders: [] }); resolveOutputs({ outputs: [{ ...published, status: 'ready', viewSessionUrl: null }] }); await refresh;
  assert.equal(context.state.tasks.at(-1), finished); assert.deepEqual([...context.state.outputs], [published]);
  assert.deepEqual([...context.projectArtifactsRefreshId], ['p']);
  // The next read, started after the link, commits.
  refresh = context.refreshProjectData('p');
  resolveTasks({ tasks: [finished] }); resolveFolders({ folders: [] }); resolveOutputs({ outputs: [{ ...published, reportUrl: '/report' }] }); await refresh;
  assert.equal(context.state.outputs[0].reportUrl, '/report'); assert.equal(context.projectArtifactsRefreshId.size, 0);
  // A project still loading its folders is skipped; its own load paints it.
  entry.loading = true;
  assert.equal(await context.refreshProjectData('p'), false);
});

test('a late guarded 401 cannot clear renewed workspace authorization', async () => {
  const start = source.indexOf('async function api('), end = source.indexOf('\nasync function authenticatedDownload', start);
  let resolveBody, clearCount = 0, captured;
  const context = {
    state: { token: 'old' }, clearWorkspaceAuthorization: () => { clearCount++; },
    fetch: (_path, request) => { captured = request.headers.Authorization; return { status: 401, ok: false, json: () => new Promise(resolve => { resolveBody = resolve; }) }; }
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const pending = context.api('/api/v1/tasks?projectId=p', { recoveryGuard: () => context.state.token === 'old' });
  await Promise.resolve();
  assert.equal(captured, 'Bearer old');
  context.state.token = 'new';
  resolveBody({ code: 'unauthorized' });
  await assert.rejects(pending, { code: 'recovery_session_changed' });
  assert.equal(clearCount, 0);
});

test('an externally removed selected task waits for an active editor and then clears selection', () => {
  const start = source.indexOf('function syncSelectedTaskFolder('), end = source.indexOf('\nfunction taskEditActive(', start);
  let activeEdit = true, rewrites = 0, renders = 0;
  const context = {
    state: { tasks: [], selectedProjectId: 'p', expandedTaskId: 'one', taskPage: 'settings', taskDetails: {} },
    CSS: { escape: String }, content: { querySelector: () => ({}) }, taskEditActive: () => activeEdit,
    syncWorkspaceView: () => { rewrites++; }, render: () => { renders++; }
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  assert.equal(context.syncSelectedTaskFolder('other'), false, 'another open project never clears the selected task');
  assert.equal(context.state.expandedTaskId, 'one');
  assert.equal(context.syncSelectedTaskFolder('p'), true);
  assert.equal(context.state.expandedTaskId, 'one');
  activeEdit = false;
  assert.equal(context.syncSelectedTaskFolder('p'), false);
  assert.equal(context.state.expandedTaskId, null); assert.equal(context.state.taskPage, null);
  assert.equal(rewrites, 1); assert.equal(renders, 1);
});

test('Undo follows the server window after a slow response despite browser clock skew', async () => {
  const start = source.indexOf('function clearFolderUndo('), end = source.indexOf('\n// ---- Drag and drop', start);
  const task = { id: 'one', projectId: 'p', folderId: null, folderRevision: 0, displayName: 'One' };
  const target = { children: [], replaceChildren(...items) { this.children = items; } };
  const responseTime = Date.parse('2026-11-20T22:00:00.000Z');
  let wall = responseTime + 60_000, monotonic = 0, reply, delay;
  const announced = [];
  const context = {
    state: { tasks: [task] }, folderUndo: null, folderUndoTimer: null, projectDataGeneration: 0, projectPaintPending: false,
    canDragFolderTask: () => true, folderAuthorizationGuard: () => () => true,
    folderRequestOptions: (_method, body) => body, Date: { parse: Date.parse, now: () => wall }, performance: { now: () => monotonic },
    clearTimeout: () => {}, setTimeout: (_callback, ms) => { delay = ms; return 1; },
    document: { querySelector: () => target, createElement: () => ({}), createTextNode: text => text },
    mutateFolder: async (_project, _url, _body, _message, _guard, accept) => {
      const result = await new Promise(resolve => { reply = resolve; });
      accept(result); return result;
    },
    scheduleProjectRefresh: () => {}, patchProjectTree: () => false, syncSelectedTaskFolder: () => {}, revealTaskDestination: () => {},
    captureTaskMoveFocus: () => ({ mode: 'none' }), settleTaskMoveFocus: () => {}, flashTreeRow: () => {},
    treeLocationLabel: () => 'Project / Folder', announce: message => announced.push(message),
  };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  const pending = context.moveFolderTask(task, 'folder', {});
  wall += 15_000; monotonic += 15_000;
  assert.deepEqual(target.children, []); assert.equal(delay, undefined);
  const moved = { ...task, folderId: 'folder', folderRevision: 1 };
  const serverTime = new Date(responseTime).toISOString();
  const undoExpiresAt = new Date(responseTime + 10_000).toISOString();
  reply({ task: moved, undoExpiresAt, serverTime }); await pending;
  assert.equal(target.children[0], 'Task moved to Project / Folder');
  assert.equal(target.children[1].textContent, 'Undo'); assert.equal(delay, 10_000);
  assert.deepEqual(announced, ['Moved One to Project / Folder.'], 'the move is announced to screen readers');
  wall = responseTime - 60_000;
  context.offerFolderUndo(moved, null, undoExpiresAt, new Date(responseTime + 8_000).toISOString());
  assert.equal(target.children[1].textContent, 'Undo'); assert.equal(delay, 2_000);
  monotonic += 2_000;
  target.children[1].onclick();
  assert.deepEqual(target.children, [], 'the click guard uses the monotonic deadline');
  context.offerFolderUndo(moved, null, undoExpiresAt, new Date(responseTime + 10_001).toISOString());
  assert.deepEqual(target.children, [], 'an expired server result cannot advertise a new window');
});

test('Delete and F2 follow the task menu rules: nothing for a read-only project or live processing', async () => {
  const start = source.indexOf('// The same rules as the task menu'), end = source.indexOf('\nasync function deleteTaskWithUndo(', start);
  const fnStart = end + 1, fnEnd = source.indexOf('\n// ---- Keyboard', fnStart);
  let requests = 0, confirmations = 0;
  const toasts = [];
  const context = {
    state: { busy: false, projects: [{ id: 'archived', status: 'archived' }, { id: 'active', status: 'active' }], tasks: [
      { id: 'read-only', projectId: 'archived', status: 'ready_for_review' },
      { id: 'live', projectId: 'active', status: 'processing', latestAttempt: { status: 'running' } },
      { id: 'archived-task', projectId: 'active', status: 'archived' },
    ] },
    can: () => true, LIVE_ATTEMPT_STATUSES: new Set(['running']), api: async () => { requests++; return {}; },
    toast: message => toasts.push(message), trashMutation: async () => { confirmations++; }, taskHasPublishedOutput: () => false,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + '\n' + source.slice(fnStart, fnEnd), context);
  assert.equal(context.taskWritable(context.state.tasks[0]), false);
  assert.equal(context.taskWritable(context.state.tasks[2]), false);
  assert.equal(context.taskWritable(context.state.tasks[1]), true);
  await context.deleteTaskWithUndo('read-only');
  await context.deleteTaskWithUndo('archived-task');
  await context.deleteTaskWithUndo('live');
  assert.equal(requests, 0); assert.equal(confirmations, 0);
  assert.deepEqual(toasts, ['Stop processing before deleting this task.']);
  // F2 on a task or project row uses the same write rules as the menus.
  assert.match(source, /kind==='t'&&taskWritable\(state\.tasks\.find\(task=>task\.id===id\)\)\)editTask\(id\)/);
  assert.match(source, /kind==='p'&&canWriteFolders\(state\.projects\.find\(project=>project\.id===id\)\)\)editProject\(id\)/);
});

test('re-opening a project makes it the newest; one dropped past ten closes on the page at once', async () => {
  const { limitOpenProjects } = await treeModule();
  const start = source.indexOf('// Opening (or re-opening) a project makes it the newest'), end = source.indexOf('\nfunction invalidateFolderAuthorization(', start);
  const removed = [], heads = [], focused = [];
  const section = id => ({ id, contains: () => id === 'p0', remove() { removed.push(id); }, closest: () => ({ classList: { remove: name => removed.push(`${id}:${name}`) } }) });
  const writes = [];
  const context = {
    limitOpenProjects, writeTreeState: (_storage, _subject, tree) => writes.push([...tree.projects]), globalThis: {},
    state: { section: 'dashboard', selectedProjectId: 'p5', projects: Array.from({ length: 12 }, (_, index) => ({ id: `p${index}` })) },
    treeState: { projects: new Set(Array.from({ length: 10 }, (_, index) => `p${index}`)), folders: new Set() }, treeSubject: 'ops:alice', draggedFolderTask: null,
    CSS: { escape: String }, document: { activeElement: {} },
    content: { querySelector: selector => section(selector.match(/"([^"]+)"/)[1]) },
    syncProjectHead: project => heads.push(project.id), focusTreeRow: key => focused.push(key),
  };
  vm.createContext(context);
  vm.runInContext('function isProjectOpen(projectId){return state.section===\'dashboard\'&&(projectId===state.selectedProjectId||treeState.projects.has(projectId))}\n' + source.slice(start, end), context);
  // p0 is re-opened, so p1 is now the oldest and the one that closes when p10 opens.
  context.touchOpenProject('p0'); context.touchOpenProject('p10'); context.saveTreeState();
  assert.equal(context.treeState.projects.has('p0'), true);
  assert.equal(context.treeState.projects.has('p1'), false);
  assert.deepEqual(removed, ['p1:selected', 'p1']); assert.deepEqual(heads, ['p1']);
  assert.deepEqual(writes.at(-1).slice(-2), ['p0', 'p10']);
  // A dropped project that held focus hands it to its own row; the drag's project is never dropped.
  context.draggedFolderTask = { projectId: 'p2' };
  context.touchOpenProject('p11'); context.saveTreeState();
  assert.equal(context.treeState.projects.has('p2'), true);
  assert.equal(context.treeState.projects.has('p3'), false);
  context.draggedFolderTask = null;
  context.treeState.projects = new Set(['p0', ...Array.from({ length: 9 }, (_, index) => `p${index + 3}`), 'p11']);
  context.treeState.projects.delete('p0'); context.treeState.projects = new Set(['p0', ...context.treeState.projects]);
  context.touchOpenProject('p1'); context.saveTreeState();
  assert.equal(context.treeState.projects.has('p0'), false);
  assert.deepEqual(focused, ['p:p0']);
});

test('an Undo that lands late leaves focus where the user went meanwhile', () => {
  const start = source.indexOf('function captureUndoFocus('), end = source.indexOf('\nasync function deleteTaskWithUndo(', start);
  const focused = [];
  const element = (name, inTree = false) => ({ name, isConnected: true, closest: () => (inTree ? {} : null), focus() { context.document.activeElement = this; } });
  const body = { name: 'body', isConnected: true, closest: () => null };
  const context = { document: { body, activeElement: body }, focusTreeRow: key => focused.push(key), focusLocator: () => null };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  // Undo clicked: its control (then gone) had focus, so the restored row may take it ...
  let focus = context.captureUndoFocus();
  assert.equal(focus.mode, 'tree');
  // ... but not after the user clicks into the search box while the restore and reload run.
  context.document.activeElement = element('search');
  context.settleUndoFocus(focus, 't:one');
  assert.deepEqual(focused, []);
  assert.equal(context.document.activeElement.name, 'search');
  // Focus still in the tree, or on nothing, is taken over.
  context.document.activeElement = element('row', true);
  context.settleUndoFocus(focus, 't:one');
  context.document.activeElement = body;
  context.settleUndoFocus(focus, 't:two');
  assert.deepEqual(focused, ['t:one', 't:two']);
  // A control the user had chosen before Undo keeps focus or gets it back after a render.
  const chosen = element('filter');
  context.document.activeElement = chosen;
  focus = context.captureUndoFocus();
  context.document.activeElement = body;
  context.settleUndoFocus(focus, 't:three');
  assert.equal(context.document.activeElement, chosen);
  assert.deepEqual(focused, ['t:one', 't:two']);
});

test('an Undo that lands late leaves focus on a tree row the user went to after an outside control was captured', () => {
  const start = source.indexOf('function captureUndoFocus('), end = source.indexOf('\nasync function deleteTaskWithUndo(', start);
  const focused = [];
  const element = (name, inTree = false) => ({ name, isConnected: true, closest: () => (inTree ? {} : null), focus() { context.document.activeElement = this; } });
  const body = { name: 'body', isConnected: true, closest: () => null };
  const context = { document: { body, activeElement: body }, focusTreeRow: key => focused.push(key), focusLocator: () => null };
  vm.createContext(context); vm.runInContext(source.slice(start, end), context);
  // A control outside the tree had focus when Undo ran (Ctrl+Z), so it is captured ...
  const chosen = element('filter');
  context.document.activeElement = chosen;
  const focus = context.captureUndoFocus();
  assert.equal(focus.mode, 'other');
  // ... but the user then focuses a live, connected tree row while the restore and reload run.
  const row = element('row', true);
  context.document.activeElement = row;
  context.settleUndoFocus(focus, 't:one');
  assert.equal(context.document.activeElement, row);
  assert.deepEqual(focused, []);
  // Focus lost to a removed node is still given back to the captured control.
  context.document.activeElement = { name: 'gone', isConnected: false, closest: () => null };
  context.settleUndoFocus(focus, 't:one');
  assert.equal(context.document.activeElement, chosen);
  assert.deepEqual(focused, []);
});
