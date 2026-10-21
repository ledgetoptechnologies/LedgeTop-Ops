import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import * as geometry from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
import {createMeasurementListLayout} from '../measurement-list-layout.mjs';
import {projectMeasurementBoundary} from '../measurement-projection.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.queries=new Map();this.handlers=new Map();this.attributes={};this.innerHTML='';this.textContent='';this.classList={add(){},remove(){},toggle(){}};}
  append(...nodes){this.children.push(...nodes);for(const node of nodes)node.parentElement=this;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
  setAttribute(k,v){this.attributes[k]=v;}getAttribute(k){return this.attributes[k];}
  querySelector(key){if(!this.queries.has(key))this.queries.set(key,new Element());return this.queries.get(key);}
  addEventListener(k,fn){if(!this.handlers.has(k))this.handlers.set(k,[]);this.handlers.get(k).push(fn);}
  removeEventListener(k,fn){this.handlers.set(k,(this.handlers.get(k)||[]).filter(f=>f!==fn));}
  closest(){return null;}fire(k,event){for(const fn of this.handlers.get(k)||[])fn(event);}
}
function fixture({storeFactory=createMeasurementStore,token=()=>null}={}){
  const counts={layout:0,project:0,signature:0},window=new Element(),document={defaultView:window,createElement(tag){const e=new Element(tag);e.ownerDocument=this;return e;},createElementNS(_ns,tag){return this.createElement(tag);}};
  document.body=document.createElement('body');document.head=document.createElement('head');
  const panel=document.createElement('section'),canvas=document.createElement('canvas'),host=document.createElement('div');
  let mode='cloud',signature='view-1',permission=true,width=400;
  canvas.getBoundingClientRect=()=>{counts.layout++;return{left:0,top:0,width,height:300};};
  const context=()=>({mode,element:canvas,host,viewSignature(){counts.signature++;return signature;},project(p,viewport){counts.project++;assert.ok(viewport.width);return p.slice(0,2);},pick:e=>[e.clientX,e.clientY,0]});
  const scope=vm.createContext({...geometry,createMeasurementStore:storeFactory,createMeasurementListLayout,openSurfaceDialog:()=>{},openAdminCalculationDialog:()=>{},document,window,crypto,structuredClone,console,setInterval:()=>1,clearInterval(){},setTimeout,Blob,URL,performance:{now:()=>1000}});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createMeasurementWorkspace','function createMeasurementWorkspace'),scope);
  const workspace=scope.createMeasurementWorkspace({panel,context,token,permitted:()=>permission,toolChanged(){},coordinateReference:()=>({crs:'EPSG:32616',verticalUnit:'m'}),toLonLat:p=>p,calculateSurface:()=>{}});
  const controls=panel.children[0];workspace.tick();
  return{workspace,counts,controls,canvas,svg:()=>host.children.find(e=>e.tagName==='svg'),camera(){signature+='c';},resize(){width=600;signature+='r';},setMode(next){mode=next;},deny(){permission=false;},
    action(name,record){controls.fire('click',{target:{closest:selector=>selector==='[data-m]'?{dataset:{m:name}}:selector==='[data-record]'?{dataset:{record}}:null}});},
    units(value){controls.fire('change',{target:{dataset:{m:'units'},value}});},
    click(x,y){const event={clientX:x,clientY:y,button:0,pointerId:1,target:canvas,preventDefault(){},stopImmediatePropagation(){}};canvas.fire('pointerdown',event);canvas.fire('pointerup',event);}
  };
}
const record=()=>({id:crypto.randomUUID(),name:'Distance',kind:'distance',collection:'spatial3d',vertices:[[10,10,0],[120,100,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}});

test('signed-in retry loading control stays hidden until failure and hides after recovery across rerenders',async()=>{
  let fail=false;const f=fixture({token:()=> 'signed-in',storeFactory:({changed})=>({records:new Map(),statuses:new Map(),persistent:()=>true,load:async()=>{if(fail)throw new Error('Temporary failure');changed();},invalidate(){}})});
  const retry=f.controls.querySelector('[data-m="reload"]'),flush=()=>new Promise(resolve=>setImmediate(resolve));
  assert.equal(retry.hidden,true);await flush();assert.equal(retry.hidden,true);f.units('metric');assert.equal(retry.hidden,true);
  assert.equal(f.controls.querySelector('[data-m-list-title]').textContent,'Saved measurements');
  fail=true;f.action('reload');await flush();assert.equal(retry.hidden,false);f.units('feet');assert.equal(retry.hidden,false);
  fail=false;f.action('reload');await flush();assert.equal(retry.hidden,true);f.units('metric');assert.equal(retry.hidden,true);
  assert.equal(f.controls.querySelector('[data-m-list-title]').textContent,'Saved measurements');f.workspace.dispose();
});

test('centered polygon label and card preserve negative net volume rather than converting fill to positive',async()=>{
  const f=fixture();f.units('metric');const r={...record(),name:'Below base',kind:'polygon',vertices:[[20,20,0],[380,20,0],[380,280,0],[20,280,0]],results:{status:'calculated',method:'surface-cut-fill',cutM3:2,fillM3:7,netM3:-5}};
  await f.workspace.store.save(r);f.workspace.tick();
  assert.match(f.svg().innerHTML,/text-anchor="middle"[^>]*>Below base<tspan[^>]*>Volume -5\.000 m³/);
  assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/Net volume: -5\.000 m³/);
  assert.equal(f.workspace.store.records.get(r.id).results.netM3,-5);f.workspace.dispose();
});

test('empty and entirely hidden collections perform no viewport reads or projections over 100 ticks',async()=>{
  const f=fixture();for(let i=0;i<100;i++)f.workspace.tick();
  assert.deepEqual(f.counts,{layout:0,project:0,signature:0});
  await f.workspace.store.save({...record(),visible:false});for(let i=0;i<100;i++)f.workspace.tick();
  assert.deepEqual(f.counts,{layout:0,project:0,signature:0});f.workspace.dispose();
});

test('stationary saved overlay draws once; camera and viewport changes each produce one fresh draw',async()=>{
  const f=fixture();await f.workspace.store.save(record());for(let i=0;i<100;i++)f.workspace.tick();
  assert.equal(f.counts.layout,1);assert.equal(f.counts.project,2);assert.match(f.svg().innerHTML,/Distance/);
  f.camera();f.workspace.tick();assert.equal(f.counts.layout,2);assert.equal(f.counts.project,4);
  f.resize();f.workspace.tick();assert.equal(f.counts.layout,3);assert.equal(f.svg().attributes.viewBox,'0 0 600 300');
  for(let i=0;i<100;i++)f.workspace.tick();assert.equal(f.counts.layout,3);f.workspace.dispose();
});

test('rename, units, selection, visibility and view group transitions cannot leave stale overlay',async()=>{
  const f=fixture(),r=record();await f.workspace.store.save(r);f.workspace.tick();
  await f.workspace.store.patch(f.workspace.store.records.get(r.id),{name:'Renamed'});f.workspace.tick();assert.match(f.svg().innerHTML,/Renamed/);
  f.units('metric');f.workspace.tick();assert.match(f.svg().innerHTML,/ m</);
  f.action('select',r.id);f.workspace.tick();assert.match(f.svg().innerHTML,/stroke="#fff"/);
  await f.workspace.store.patch(f.workspace.store.records.get(r.id),{visible:false});f.workspace.tick();assert.equal(f.svg().innerHTML,'');
  await f.workspace.store.patch(f.workspace.store.records.get(r.id),{visible:true});f.workspace.tick();assert.match(f.svg().innerHTML,/Renamed/);
  const beforeMap={...f.counts};
  f.setMode('ortho');f.workspace.modeChanged();f.workspace.tick();assert.match(f.svg().innerHTML,/Renamed/);
  assert.equal(f.counts.layout,beforeMap.layout+1);assert.equal(f.counts.project,beforeMap.project+2);
  const stationaryMap={...f.counts};for(let i=0;i<100;i++)f.workspace.tick();
  assert.equal(f.counts.layout,stationaryMap.layout);assert.equal(f.counts.project,stationaryMap.project);
  f.setMode('model');f.workspace.modeChanged();f.workspace.tick();assert.match(f.svg().innerHTML,/Renamed/);f.workspace.dispose();
});

test('draft vertex changes invalidate a stationary view while access expiry clears it without further projection',()=>{
  const f=fixture();f.workspace.setTool('area');f.click(10,10);f.workspace.tick();const one=f.svg().innerHTML;
  f.click(120,10);f.workspace.tick();assert.notEqual(f.svg().innerHTML,one);
  const before=f.counts.project;f.deny();f.workspace.tick();assert.equal(f.svg().innerHTML,'');assert.equal(f.counts.project,before);assert.equal(f.controls.hidden,true);f.workspace.dispose();
});

test('explicit capture refresh bypasses stationary cache without altering stored geometry',async()=>{
  const f=fixture(),r=record();await f.workspace.store.save(r);f.workspace.tick();
  f.workspace.tick({force:true});assert.equal(f.counts.layout,2);assert.equal(f.counts.project,4);assert.deepEqual(f.workspace.store.records.get(r.id).vertices,r.vertices);
  assert.match(source,/async function screenshot\(\{allowIncomplete=false\}=\{\}\)\s*\{\s*draw\(\{force:true\}\)/);f.workspace.dispose();
});

test('Potree adapter creation/signature/projection do not force layout and picker timing is cleaned safely',()=>{
  const main=readFileSync(new URL('../main.js',import.meta.url),'utf8'),start=main.indexOf('function measurementViewContext()'),end=main.indexOf('\nasync function calculateSavedMeasurementSurface',start);
  let layout=0;const marks=[],original={},canvas={width:800,height:600,get clientWidth(){layout++;return 400;},get clientHeight(){layout++;return 300;},getBoundingClientRect(){layout++;return{left:0,top:0,width:400,height:300};}};
  const camera=new THREE.PerspectiveCamera(60,4/3,.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);camera.updateMatrixWorld();
  const points={visible:true,visibleNodes:[{}],material:original,pick(){this.material={};return{position:new THREE.Vector3(0,0,0)};}},viewer={scene:{getActiveCamera:()=>camera,pointclouds:[points]},renderer:{domElement:canvas,setRenderTarget(){},setScissorTest(){},state:{reset(){}}}};
  const win={viewer,THREE,Potree:{measureTimings:false},performance:{clearMarks:n=>marks.push(n),clearMeasures:n=>marks.push(n)}};
  const measurementDisplaySurfaceRevision=()=>{throw new Error('Adapter creation/projection must not scan resident geometry');},resolveRenderedMeasurementVertices=()=>{throw new Error('Adapter creation/projection must not resolve display placement');};
  const scope=vm.createContext({state:{activeMode:'cloud',cloudMode:'potree'},isMapMode:()=>false,document:{getElementById:()=>({contentWindow:win})},dom:{cloudContainer:{}},camera,renderer:viewer.renderer,THREE,projectMeasurementBoundary});
  Object.assign(scope,{measurementDisplaySurfaceRevision,resolveRenderedMeasurementVertices});
  vm.runInContext(main.slice(start,end),scope);const adapter=scope.measurementViewContext();
  assert.equal(adapter.getDisplaySurfaceRevision,measurementDisplaySurfaceRevision);assert.equal(adapter.resolveRenderedDisplayVertices,resolveRenderedMeasurementVertices);
  const signature=adapter.viewSignature();assert.deepEqual(adapter.project([0,0,0],{width:400,height:300}),[200,150]);assert.equal(layout,0);
  const boundary=adapter.projectBoundary([[-.2,-.2,9],[.2,-.2,9],[.2,.2,11],[-.2,.2,11]],{width:400,height:300},{closed:true});
  assert.equal(boundary.segments.length,3,'partly behind-camera polygon retains its original visible edges');
  assert.equal(boundary.positions.filter(Boolean).length,2,'only original visible handles remain');
  assert.ok(boundary.fill.length>=3);assert.equal(layout,0,'boundary clipping uses the supplied CSS viewport without layout reads');
  assert.equal(adapter.project([0,0,9.95],{width:400,height:300}),null,'hidden near-plane handle is not selectable');
  assert.equal(layout,0);
  canvas.width=1600;assert.notEqual(adapter.viewSignature(),signature);
  adapter.pick({clientX:200,clientY:150});assert.equal(points.material,original);assert.deepEqual(marks,['pick-start','pick-end','pick']);
  marks.length=0;win.Potree.measureTimings=true;adapter.pick({clientX:200,clientY:150});assert.deepEqual(marks,[]);
});
