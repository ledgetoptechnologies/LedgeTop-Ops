import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {calculateBrowserSurface} from '../measurement-browser-surface.mjs';
import {integrateSurfaceVolume,createReference} from '../measurement-volume.mjs';
import {pointInPolygon} from '../map-volume.mjs';

test('browser worker result, cancellation and failure always release worker resources',async()=>{
  let worker;
  class WorkerStub{constructor(){worker=this;this.terminated=false;}postMessage(options){this.options=options;}terminate(){this.terminated=true;}}
  const success=calculateBrowserSurface({native:true},{WorkerClass:WorkerStub});worker.onmessage({data:{ok:true,result:{cutM3:2}}});assert.deepEqual(await success,{cutM3:2});assert.equal(worker.terminated,true);
  const controller=new AbortController(),cancelled=calculateBrowserSurface({}, {WorkerClass:WorkerStub,signal:controller.signal});controller.abort();await assert.rejects(cancelled,{name:'AbortError'});assert.equal(worker.terminated,true);
  const failure=calculateBrowserSurface({}, {WorkerClass:WorkerStub});worker.onerror();await assert.rejects(failure,/No reduced-resolution substitute/);assert.equal(worker.terminated,true);
});
test('shipped worker integrates exact native cells and returns only bounded preview samples',()=>{
  let response;
  const scope=vm.createContext({self:{postMessage:value=>{response=value;}},integrateSurfaceVolume,createReference,pointInPolygon});
  vm.runInContext(readFileSync(new URL('../measurement-surface-worker.mjs',import.meta.url),'utf8').replace(/^import .*;\r?\n/gm,''),scope);
  const vertices=[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],options={vertices,reference:{type:'custom',elevationM:0},values:new Float64Array(10000).fill(2),width:100,height:100,bounds:{minE:0,maxE:2,minN:0,maxN:2},maxCells:10000};
  scope.self.onmessage({data:options});assert.equal(response.ok,true);assert.ok(Math.abs(response.result.cutM3-8)<1e-8);assert.ok(response.result.preview.samples.length<=1500);assert.equal(response.result.preview.referencePatches.length,2);
  scope.self.onmessage({data:{...options,maxCells:1}});assert.equal(response.ok,false);assert.match(response.error,/limit/);
});
