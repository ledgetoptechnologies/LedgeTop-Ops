import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {hasUnsavedGcpMark} from '../workspace-navigation-state.mjs';
const source=readFileSync(new URL('../workspace-projects.js',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function startGcpProcessing('),source.indexOf('async function confirmGcpCrs('));
function fixture(){
  const task={id:'task',status:'draft',metadata:{pendingGcpProcessingSettings:{providerId:'provider',presetId:'preset',options:{dsm:true}}}};
  const state={tasks:[task],busy:false,taskDetails:{task:{gcp:{correspondences:[{id:'mark',pointId:'point',imageFileId:'photo',pixelX:10,pixelY:20}]}}}};
  const workspace={pointId:'point',activeImage:{id:'photo'},draftPixel:{pixelX:10,pixelY:20},editingId:'mark'};
  const calls=[],messages=[],dialogs={confirm:async()=>true},navigationWork={snapshot:()=>({pendingGcpSave:false})};
  const run=new Function('state','gcpWorkspace','dialogs','api','toast','load','navigationWork','hasUnsavedGcpMark',`${body}; return startGcpProcessing;`)(state,()=>workspace,dialogs,async(...args)=>calls.push(args),message=>messages.push(message),async()=>{},navigationWork,hasUnsavedGcpMark);
  return {state,workspace,calls,messages,run};
}
test('draft starts an attempt with its saved provider settings and marked photos',async()=>{
  const f=fixture();await f.run('task');assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],'/api/v1/tasks/task/attempts');assert.deepEqual(f.calls[0][1].body,{providerId:'provider',presetId:'preset',options:{dsm:true}});
});
test('draft refuses to start with an unsaved image mark',async()=>{
  const f=fixture();f.workspace.draftPixel.pixelX=11;await f.run('task');assert.equal(f.calls.length,0);assert.match(f.messages[0],/Save the current photo mark/);
});
