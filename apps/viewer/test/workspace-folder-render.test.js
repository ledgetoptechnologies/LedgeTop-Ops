'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('project overview shows folders and tasks at the selected level, and keeps project sharing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'workspace-projects.js'), 'utf8');
  const extract = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const context = {
    state: { selectedProjectId: 'p', projects: [{ id: 'p', displayName: 'Project', status: 'active' }], tasks: [
      { id: 'root-task', projectId: 'p', folderId: null }, { id: 'nested-task', projectId: 'p', folderId: 'f' },
      { id: 'other-task', projectId: 'other', folderId: null },
    ], datasets: [] },
    folderState: { projectId: 'p', currentId: null, folders: [{ id: 'f', projectId: 'p', parentId: null, displayName: 'Folder' }, { id: 'child', projectId: 'p', parentId: 'f', displayName: 'Child' }], loading: false, error: null },
    LIVE_ATTEMPT_STATUSES: new Set(), can: () => true, esc: String,
    button: (action, id, label) => `<button data-action="${action}" data-id="${id}">${label}</button>`,
    dangerButton: () => '', taskPanel: task => `<article>${task.id}</article>`, empty: message => message,
  };
  vm.createContext(context);
  vm.runInContext(source.split(/\r?\n/).find(line=>line.startsWith('function countLabel('))+'\n'+extract('function folderPath(', '\nconst ')+extract('function selectedProject()', '\nfunction datasetActions'), context);
  let html = context.selectedProject();
  assert.match(html, /root-task/); assert.doesNotMatch(html, /nested-task|other-task/);
  assert.match(html, /Folder/); assert.match(html, /project-share/);
  assert.match(html, /folder-rename/); assert.match(html, /folder-delete/);
  context.folderState.currentId = 'f';
  html = context.selectedProject();
  assert.match(html, /nested-task/); assert.match(html, /Child/); assert.doesNotMatch(html, /root-task|other-task/);
  assert.match(html, /aria-label="Folder path"/);
  context.can = () => false;
  html = context.selectedProject();
  assert.doesNotMatch(html, /folder-rename|folder-delete/);
  // While the folder request is pending, the current level's tasks stay visible with the loading status.
  context.can = () => true;
  Object.assign(context.folderState, { loading: true, folders: null, currentId: null });
  html = context.selectedProject();
  assert.match(html, /role="status">Loading folders/); assert.match(html, /<article>root-task<\/article>/);
  assert.doesNotMatch(html, /nested-task|other-task|folder-create|folder-rename/);
  context.folderState.currentId = 'f';
  html = context.selectedProject();
  assert.match(html, /<article>nested-task<\/article>/); assert.doesNotMatch(html, /root-task|other-task/);
  // Errors still fall back to every task of this project only.
  Object.assign(context.folderState, { loading: false, error: 'Folders could not be loaded.', currentId: null });
  html = context.selectedProject();
  assert.match(html, /role="alert"/); assert.match(html, /root-task/); assert.match(html, /nested-task/); assert.doesNotMatch(html, /other-task/);
});

test('folder URLs round-trip and task history restores the task folder', () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const take=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const context={URL,URLSearchParams,location:{href:'https://viewer.example/workspace',origin:'https://viewer.example'},WORKSPACE_SECTIONS:new Set(['dashboard','providers']),selectedFolderId:null,projectDataGeneration:0,
    state:{section:'dashboard',selectedProjectId:'p',expandedTaskId:null,taskPage:null,tasks:[{id:'task',projectId:'p',folderId:'f'}]},folderState:{projectId:'p',currentId:null,folders:[{id:'f',projectId:'p'}]}};
  vm.createContext(context);
  vm.runInContext(take('function readWorkspaceView(', '\nconst initialView')+take('function workspaceView()', '\nfunction syncWorkspaceView'),context);
  const view=context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&folder=f');
  context.applyWorkspaceView(view);assert.equal(context.folderState.currentId,'f');assert.match(context.workspaceUrl(),/folder=f/);
  context.applyWorkspaceView(context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&task=task'));assert.equal(context.folderState.currentId,'f');
  context.applyWorkspaceView(context.readWorkspaceView('https://viewer.example/workspace?section=dashboard&project=p&folder=foreign'));assert.equal(context.folderState.currentId,null);
});

test('late folder response cannot overwrite a different project or section', async () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const take=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  for(const nextView of [{section:'dashboard',selectedProjectId:'b',selectedFolderId:'b-folder'},{section:'providers'}]){
    let resolveRequest,rewrites=0;const request=new Promise(resolve=>{resolveRequest=resolve;});
    const context={api:()=>request,render:()=>{},syncWorkspaceView:()=>{rewrites++;},selectedFolderId:'a-folder',WORKSPACE_SECTIONS:new Set(['dashboard','providers']),can:()=>true,workspaceAuthorizationClearing:false,
      state:{token:'token',adminSession:{},section:'dashboard',selectedProjectId:'a',expandedTaskId:null,taskPage:null,tasks:[]},folderState:{projectId:'a',currentId:'a-folder',folders:null,error:null,loading:false,epoch:0}};
    vm.createContext(context);vm.runInContext(take('let folderAuthorizationGeneration=', '\nfunction folderPath')+take('function applyWorkspaceView(', '\nfunction validateWorkspaceView'),context);
    const pending=context.loadProjectFolders('a');context.applyWorkspaceView(nextView);
    resolveRequest({folders:[{id:'a-folder',projectId:'a',parentId:null}]});await pending;
    assert.equal(context.state.section,nextView.section);assert.equal(context.state.selectedProjectId,nextView.selectedProjectId||null);
    assert.equal(context.selectedFolderId,nextView.selectedFolderId||null);assert.equal(context.folderState.folders,null);assert.equal(rewrites,0);
  }
});

test('refresh for an old project cannot interrupt the current project', async () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const start=source.indexOf('async function loadProjectFolders('),end=source.indexOf('\nfunction folderPath',start);
  let calls=0;const context={api:()=>{calls++;throw new Error('must not call');},state:{section:'dashboard',selectedProjectId:'b'},folderState:{projectId:'b',currentId:'b-folder',folders:null,loading:true,epoch:7}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);await context.loadProjectFolders('a');
  assert.equal(calls,0);assert.equal(context.folderState.projectId,'b');assert.equal(context.folderState.epoch,7);assert.equal(context.folderState.loading,true);
});

test('scoped refresh ignores a move-racing response and reconciles only its current project', async () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const start=source.indexOf('async function refreshProjectWorkspace('),end=source.indexOf('\nfunction selectedProject(',start);
  const first={id:'one',projectId:'p',folderId:null,folderRevision:0},other={id:'two',projectId:'q'};
  let resolveTasks,resolveFolders,paintCount=0;
  const context={
    projectDataGeneration:0,projectArtifactsRefreshId:null,projectRefreshBusy:false,projectPaintPending:false,workspaceLoads:0,
    can:()=>true,document:{hidden:false},folderAuthorizationGuard:()=>()=>true,
    state:{section:'dashboard',selectedProjectId:'p',expandedTaskId:'one',projectQuery:'search',tasks:[first,other],busy:false},
    folderState:{projectId:'p',folders:[],loading:false},
    pagedApi:()=>new Promise(resolve=>{resolveTasks=resolve;}),
    api:()=>new Promise(resolve=>{resolveFolders=resolve;}),
    syncSelectedTaskFolder:()=>{},patchProjectFolderView:()=>{paintCount++;return false;},
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  let refresh=context.refreshProjectWorkspace();
  const moved={...first,folderId:'folder',folderRevision:1};
  context.projectDataGeneration++;
  context.state.tasks=[moved,other];
  resolveTasks({tasks:[first]});resolveFolders({folders:[]});await refresh;
  assert.equal(context.state.tasks[0],moved);assert.equal(paintCount,0);
  refresh=context.refreshProjectWorkspace();
  const current={...moved,status:'processing'};
  resolveTasks({tasks:[current,{id:'unexpected',projectId:'foreign'}]});
  resolveFolders({folders:[{id:'folder',projectId:'p'},{id:'foreign',projectId:'q'}]});await refresh;
  assert.deepEqual(Array.from(context.state.tasks),[other,current]);
  assert.equal(context.state.expandedTaskId,'one');assert.equal(context.state.projectQuery,'search');
  assert.equal(context.folderState.folders.length,1);assert.equal(paintCount,1);
});

test('a late guarded 401 cannot clear renewed workspace authorization', async () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const start=source.indexOf('async function api('),end=source.indexOf('\nasync function authenticatedDownload',start);
  let resolveBody,clearCount=0,captured;
  const context={
    state:{token:'old'},clearWorkspaceAuthorization:()=>{clearCount++;},
    fetch:(_path,request)=>{captured=request.headers.Authorization;return {status:401,ok:false,json:()=>new Promise(resolve=>{resolveBody=resolve;})};}
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  const pending=context.api('/api/v1/tasks?projectId=p',{recoveryGuard:()=>context.state.token==='old'});
  await Promise.resolve();
  assert.equal(captured,'Bearer old');
  context.state.token='new';
  resolveBody({code:'unauthorized'});
  await assert.rejects(pending,{code:'recovery_session_changed'});
  assert.equal(clearCount,0);
});

test('an externally removed selected task waits for an active editor and then clears selection', () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const start=source.indexOf('function syncSelectedTaskFolder('),end=source.indexOf('\nfunction taskEditActive(',start);
  let activeEdit=true,rewrites=0,renders=0;
  const context={
    state:{tasks:[],expandedTaskId:'one',taskPage:'settings'},selectedFolderId:null,folderState:{folders:[]},
    CSS:{escape:String},content:{querySelector:()=>({})},taskEditActive:()=>activeEdit,
    syncWorkspaceView:()=>{rewrites++;},render:()=>{renders++;}
  };
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  assert.equal(context.syncSelectedTaskFolder('p'),true);
  assert.equal(context.state.expandedTaskId,'one');
  activeEdit=false;
  assert.equal(context.syncSelectedTaskFolder('p'),false);
  assert.equal(context.state.expandedTaskId,null);assert.equal(context.state.taskPage,null);
  assert.equal(rewrites,1);assert.equal(renders,1);
});
