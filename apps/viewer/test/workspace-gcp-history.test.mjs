import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const historySource=source.slice(source.indexOf('let historyRecovery=null;'),source.indexOf("addEventListener('beforeunload'"));
test('unindexed history retains unsaved mark without rewriting browser history',()=>{
 const calls=[],listeners={};const history={state:{},pushState:(_state,_unused,url)=>calls.push(['push',url]),go:delta=>calls.push(['go',delta])};
 const state={expandedTaskId:'task',gcpWorkspaces:{task:{draftPixel:{pixelX:1,pixelY:2}}},taskDetails:{},taskPage:'gcp'};
 const context=vm.createContext({state,history,workspaceHistoryIndex:3,workspaceHistoryReliable:true,readWorkspaceView:()=>({section:'dashboard'}),workspaceUrl:()=>'/workspace?panel=gcp',releaseAllGcpImages:preserve=>calls.push(['release',preserve]),applyWorkspaceView:()=>{state.expandedTaskId=null;state.taskPage=null},validateWorkspaceView:()=>{},render:()=>{},hydrateExpandedTask:()=>{},navigationWork:{snapshot:()=>({pendingGcpSave:false})},hasUnsavedGcpMark:()=>true,addEventListener:(name,listener)=>{listeners[name]=listener},toast:message=>calls.push(['notice',message])});
 vm.runInContext(historySource,context);listeners.popstate({state:null});
 assert.deepEqual(calls,[['release',true],['notice','Your photo mark is retained. Return to the task to finish it.']]);
 assert.equal(state.gcpWorkspaces.task.suspended,true);assert.deepEqual(state.gcpWorkspaces.task.draftPixel,{pixelX:1,pixelY:2});assert.equal(state.expandedTaskId,null);
});

import {hasUnsavedGcpMark} from '../workspace-navigation-state.mjs';
test('missing set or point retains the draft and marks a conflict instead of releasing it',async()=>{
 const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
 const body=source.slice(source.indexOf('async function refreshGcpWorkspace('),source.indexOf('async function startGcpProcessing('));
 for(const missing of ['set','point']){
  let released=0;const workspace={setId:'set',pointId:'point',activeImage:{id:'image'},draftPixel:{pixelX:12,pixelY:14},pointCache:{},suspended:true};
  const detail={gcp:{sets:missing==='set'?[]:[{id:'set'}],points:[{id:'point'}],correspondences:[]}},state={tasks:[{id:'task',datasetId:'data'}],taskDetails:{task:detail},expandedTaskId:'task'};
  const refresh=new Function('state','gcpWorkspace','api','releaseGcpImage','render','hasUnsavedGcpMark','navigationWork',`${body};return refreshGcpWorkspace`)(state,()=>workspace,async()=>({set:{id:'set'},points:[]}),()=>released++,()=>{},hasUnsavedGcpMark,{snapshot:()=>({pendingGcpSave:false})});
  await refresh('task');assert.equal(released,0);assert.equal(workspace.pointId,'point');assert.deepEqual(workspace.draftPixel,{pixelX:12,pixelY:14});assert.equal(detail.gcp.conflict,true);assert.match(detail.gcp.error,/retained/);
 }
});
