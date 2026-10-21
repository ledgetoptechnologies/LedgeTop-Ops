import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const main=readFileSync(new URL('../main.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');

test('advanced Layers stays hidden through model/cloud/map/DSM/DTM return sequences',()=>{
  const start=main.indexOf("  document.getElementById('panel-3d-layers').hidden"),end=main.indexOf("  document.getElementById('panel-camera-positions').style.display",start);
  assert.ok(start>=0&&end>start);
  const panel={hidden:false,style:{display:'block'}},scope=vm.createContext({document:{getElementById:id=>{assert.equal(id,'panel-3d-layers');return panel;}}});
  for(const mode of ['model','cloud','ortho','dsm','dtm','model']){
    scope.mode=mode;scope.is3D=mode==='model';vm.runInContext(main.slice(start,end),scope);
    assert.equal(panel.hidden,true);assert.equal(panel.style.display,'none');
  }
  assert.match(html,/id="panel-3d-layers" hidden/);
  assert.doesNotMatch(main,/getElementById\('panel-3d-layers'\)\.style\.display = is3D/);
});

test('hidden mesh controls request maximum detail and use Auto memory without bypassing safety policy',()=>{
  assert.match(html,/id="lod-detail"[^>]*max="24"[^>]*value="24"/);
  assert.match(main,/let lodMemoryMode = 'auto';/);
  assert.match(main,/detailSlider\.value = String\(MAX_LOD_DETAIL\)/);
  assert.match(main,/detail: detailSlider\?\.value \?\? MAX_LOD_DETAIL/);
  assert.match(main,/resolveLodMemoryProfile\(\{\s*mode: lodMemoryMode,/);
  assert.match(main,/configureLodRenderer\(rendererInstance,[\s\S]*?memoryProfile,/);
});

test('camera visibility uses compact Show/Hide with explicit accessible action and pressed state',()=>{
  const start=main.indexOf('function syncCameraLayer()'),end=main.indexOf('// Keep color-range intent',start);
  const button={textContent:'',attributes:{},classList:{toggle(){}},setAttribute(k,v){this.attributes[k]=v;}},size={style:{}};
  const state={camerasVisible:false,camerasLoaded:true,activeMode:'model'};
  const scope=vm.createContext({state,camGroupParent:{visible:false},refreshCameraMarkerScales(){},refreshMapCameraLayer(){},document:{getElementById:id=>id==='layer-cameras'?button:size}});
  vm.runInContext(main.slice(start,end),scope);
  for(const visible of [false,true,false]){
    state.camerasVisible=visible;scope.syncCameraLayer();
    assert.equal(button.textContent,visible?'Hide':'Show');
    assert.equal(button.attributes['aria-label'],visible?'Hide camera positions':'Show camera positions');
    assert.equal(button.attributes['aria-pressed'],String(visible));
  }
  assert.match(html,/id="layer-cameras" aria-label="Show camera positions" aria-pressed="false">Show/);
});
