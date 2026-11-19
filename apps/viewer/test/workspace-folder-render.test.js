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
});

test('folder URLs round-trip and task history restores the task folder', () => {
  const source=fs.readFileSync(path.join(__dirname,'..','workspace-projects.js'),'utf8');
  const take=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
  const context={URL,URLSearchParams,location:{href:'https://viewer.example/workspace',origin:'https://viewer.example'},WORKSPACE_SECTIONS:new Set(['dashboard','providers']),selectedFolderId:null,
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
