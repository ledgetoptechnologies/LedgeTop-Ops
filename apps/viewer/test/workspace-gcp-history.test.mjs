import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const historySource=source.slice(source.indexOf('let historyRecovery=null;'),source.indexOf("addEventListener('beforeunload'"));
test('unindexed history retains unsaved mark and restores current URL, with explicit forward-history tradeoff',()=>{
 const calls=[],listeners={};const history={state:{},pushState:(_state,_unused,url)=>calls.push(['push',url]),go:delta=>calls.push(['go',delta])};
 const state={expandedTaskId:'task',gcpWorkspaces:{},taskDetails:{}};
 const context=vm.createContext({state,history,workspaceHistoryIndex:3,readWorkspaceView:()=>({section:'dashboard'}),workspaceUrl:()=>'/workspace?panel=gcp',navigationWork:{snapshot:()=>({pendingGcpSave:false})},hasUnsavedGcpMark:()=>true,addEventListener:(name,listener)=>{listeners[name]=listener},toast:message=>calls.push(['notice',message])});
 vm.runInContext(historySource,context);listeners.popstate({state:null});
 assert.deepEqual(calls,[['push','/workspace?panel=gcp'],['notice','Save the current photo mark before navigating']]);
 assert.equal(state.expandedTaskId,'task');
});
