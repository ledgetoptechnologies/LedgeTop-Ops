import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function refreshGcpWorkspace('),source.indexOf('async function changeGcpSet('));
test('stale point response cannot replace a newer selection',async()=>{
 let releaseOld;const old=new Promise(resolve=>{releaseOld=resolve});
 const workspace={setId:'set',pointId:'a',mode:'radius',radiusM:15.24,pointCache:{}};
 const detail={gcp:{sets:[{id:'set'}]}}, state={tasks:[{id:'task',datasetId:'data'}],taskDetails:{task:detail},expandedTaskId:'task'};
 let setCalls=0;
 const api=async path=>{if(path.startsWith('/api/v1/gcp-sets/')){if(++setCalls===1)return old;return {set:{id:'set'},points:[{id:'a'},{id:'b'}]}};if(path.endsWith('/gcp-correspondences'))return {correspondences:[]};if(path.includes('/gcp-images?'))return {images:[{id:new URLSearchParams(path.split('?')[1]).get('pointId')}],pagination:{nextOffset:null}};throw Error(path)};
 const refresh=new Function('state','gcpWorkspace','api','releaseGcpImage','render',`${body}; return refreshGcpWorkspace;`)(state,()=>workspace,api,()=>{},()=>{});
 const first=refresh('task');workspace.pointId='b';await refresh('task');releaseOld({set:{id:'set'},points:[{id:'a'}]});await first;
 assert.equal(workspace.pointId,'b');assert.equal(detail.gcp.candidates[0].id,'b');
});
