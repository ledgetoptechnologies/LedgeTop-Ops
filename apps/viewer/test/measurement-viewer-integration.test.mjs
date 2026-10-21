import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import * as geometry from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
import {createMeasurementListLayout} from '../measurement-list-layout.mjs';

const uiSource=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const main=readFileSync(new URL('../main.js',import.meta.url),'utf8');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

// Execute shipped interaction code with DOM/rendering seams. This validates
// event routing and state, not pixels or browser-specific pointer compatibility.
class Element {
  constructor(tag='div'){this.tagName=tag.toUpperCase();this.children=[];this.handlers=new Map();this.queries=new Map();this.dataset={};this.style={};const classes=new Set();this.classList={add(...names){names.forEach(n=>classes.add(n));},remove(...names){names.forEach(n=>classes.delete(n));},toggle(n,on){on?classes.add(n):classes.delete(n);},contains:n=>classes.has(n)};this.innerHTML='';this.textContent='';this.value='';this.attributes={};}
  append(...nodes){this.children.push(...nodes);for(const node of nodes)node.parentElement=this;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(n=>n!==this);}
  setAttribute(k,v){this.attributes[k]=v;}
  addEventListener(name,fn){if(!this.handlers.has(name))this.handlers.set(name,[]);this.handlers.get(name).push(fn);}
  removeEventListener(name,fn){this.handlers.set(name,(this.handlers.get(name)||[]).filter(f=>f!==fn));}
  querySelector(selector){if(!this.queries.has(selector)){const node=new Element();node.ownerDocument=this.ownerDocument;this.queries.set(selector,node);}return this.queries.get(selector);}
  closest(selector){if(this.interactive&&selector.split(',').some(part=>part.trim()===this.tagName.toLowerCase()||part.trim()==='.leaflet-control'&&this.leafletControl))return this;return null;}
  getBoundingClientRect(){return{left:0,top:0,right:400,bottom:300,width:400,height:300};}
  setPointerCapture(){} releasePointerCapture(){} focus(){} select(){} replaceWith(){}
  fire(name,event){for(const fn of this.handlers.get(name)||[])fn(event);}
}
function event(x=0,y=0,extra={}){return{clientX:x,clientY:y,button:0,buttons:0,pointerId:1,target:new Element(),preventDefault(){this.prevented=true;},stopImmediatePropagation(){this.stopped=true;},...extra};}
function fixture({resolveDisplayVertices=async record=>({vertices:record.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM display placement'})}={}){
  const windowRef=new Element(),documentRef={defaultView:windowRef,createElement(tag){const node=new Element(tag);node.ownerDocument=this;return node;},createElementNS(_ns,tag){return this.createElement(tag);}};
  documentRef.body=documentRef.createElement('body');documentRef.head=documentRef.createElement('head');
  const panel=documentRef.createElement('section'),canvas=documentRef.createElement('canvas'),host=documentRef.createElement('div'),tools=[];
  let mode='model',permitted=true,picks=0;
  const context=()=>({mode,element:canvas,host,pick:e=>{picks++;return[e.clientX,e.clientY,0];},project:p=>p.slice(0,2)});
  const scope=vm.createContext({...geometry,createMeasurementStore,createMeasurementListLayout,openSurfaceDialog:()=>{},document:documentRef,crypto,structuredClone,AbortController,DOMException,console,
    setInterval:()=>1,clearInterval(){},setTimeout,Blob,URL,performance:{now:()=>1000},window:windowRef});
  vm.runInContext(uiSource.replace(/^import .*;\r?\n/gm,'').replace('export function createMeasurementWorkspace','function createMeasurementWorkspace'),scope);
  const workspace=scope.createMeasurementWorkspace({panel,context,token:()=>null,permitted:()=>permitted,toolChanged:value=>tools.push(value),coordinateReference:()=>({crs:'EPSG:32616',verticalUnit:'m'}),toLonLat:p=>p,calculateSurface:()=>{},resolveDisplayVertices});
  const controls=panel.children[0],svg=()=>host.children.find(node=>node.tagName==='SVG');
  workspace.tick();
  return{workspace,canvas,windowRef,controls,svg,tools,panel,setMode:value=>{mode=value;},setPermission:value=>{permitted=value;},picks:()=>picks,
    click(x,y,extra={}){canvas.fire('pointerdown',event(x,y,extra));canvas.fire('pointerup',event(x,y,extra));}};
}

test('both source collections stay in the shared list and overlay across map detours without changing stored vertices',async()=>{
  const f=fixture(),r={id:crypto.randomUUID(),name:'Mesh distance',kind:'distance',collection:'spatial3d',vertices:[[10,10,0],[20,20,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  const map={...r,id:crypto.randomUUID(),name:'Map distance',collection:'map',vertices:[[150,150,0],[250,150,0]]};await f.workspace.store.save(r);await f.workspace.store.save(map);
  f.workspace.tick();assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/Mesh distance/);assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/Map distance/);
  for(const mode of ['ortho','dsm','dtm','cloud','model']){f.workspace.modeChanged();f.setMode(mode);f.workspace.tick();await flush();f.workspace.tick();for(const name of [/Map distance/,/Mesh distance/]){assert.match(f.controls.querySelector('[data-m-list]').innerHTML,name);assert.match(f.svg().innerHTML,name);}}
  assert.deepEqual(f.workspace.store.records.get(r.id).vertices,r.vertices);assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);f.workspace.dispose();
});

test('Shift navigation does not consume pointer gestures or add measurement vertices',async()=>{
  const f=fixture();f.workspace.setTool('area');f.click(10,10);const before=f.workspace.getDraft().vertices.length;
  const down=event(40,40,{shiftKey:true});f.canvas.fire('pointerdown',down);f.canvas.fire('pointermove',event(90,90,{shiftKey:true,buttons:1}));f.canvas.fire('pointerup',event(90,90,{shiftKey:true}));
  assert.equal(down.stopped,undefined);assert.equal(f.workspace.getDraft().vertices.length,before);f.workspace.dispose();
});

test('a record remains visible after a map/model switch even without destination-origin records',async()=>{
  for(const [from,to,collection] of [['model','ortho','spatial3d'],['ortho','model','map']]){
    const f=fixture();f.setMode(from);f.workspace.tick();await f.workspace.store.save({id:crypto.randomUUID(),name:'Only original view',kind:'distance',collection,vertices:[[10,10,0],[100,100,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}});f.workspace.tick();assert.match(f.svg().innerHTML,/Only original view/);
    f.workspace.modeChanged();f.setMode(to);f.workspace.tick();await flush();f.workspace.tick();assert.match(f.svg().innerHTML,/Only original view/);assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/Only original view/);assert.equal(f.workspace.store.records.size,1);f.workspace.dispose();
  }
});

test('failed map-to-3D placement remains listed honestly and still draws in the map without changing source coordinates',async()=>{
  const f=fixture({resolveDisplayVertices:async()=>{throw new Error('No verified elevation surface');}}),record={id:crypto.randomUUID(),name:'Map-only boundary',kind:'distance',collection:'map',vertices:[[20,20,0],[120,120,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  await f.workspace.store.save(record);f.workspace.tick();await flush();f.workspace.tick();assert.equal(f.svg().innerHTML,'');assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/Map-only boundary/);assert.match(f.controls.querySelector('[data-m-list]').innerHTML,/3D overlay unavailable/);
  f.workspace.modeChanged();f.setMode('ortho');f.workspace.tick();assert.match(f.svg().innerHTML,/Map-only boundary/);assert.deepEqual(f.workspace.store.records.get(record.id).vertices,record.vertices);f.workspace.dispose();
});

test('preview bursts perform one bounded pick and exact clicks remain independent',()=>{
  const f=fixture();f.workspace.setTool('area');const start=f.picks();
  for(let i=0;i<100;i++)f.canvas.fire('pointermove',event(i,100));assert.equal(f.picks(),start);
  f.workspace.tick();assert.equal(f.picks(),start+1);f.workspace.tick();assert.equal(f.picks(),start+1);
  f.click(50,60);assert.deepEqual(Array.from(f.workspace.getDraft().vertices[0]),[50,60,0]);f.workspace.dispose();
});

test('measurement cursor communicates placement, Shift navigation and vertex editing then restores',()=>{
  const f=fixture();f.canvas.style.cursor='grab';f.workspace.setTool('area');assert.equal(f.canvas.style.cursor,'crosshair');
  f.windowRef.fire('keydown',event(0,0,{key:'Shift'}));assert.equal(f.canvas.style.cursor,'grab');f.windowRef.fire('keyup',event(0,0,{key:'Shift'}));
  f.windowRef.fire('keydown',event(0,0,{code:'Space'}));assert.equal(f.canvas.style.cursor,'move');f.workspace.setTool('none');assert.equal(f.canvas.style.cursor,'grab');f.workspace.dispose();
});

test('newest records precede older rows and cards avoid obsolete export selection',async()=>{
  const f=fixture(),r={kind:'distance',collection:'spatial3d',vertices:[[10,10,0],[100,100,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
  await f.workspace.store.save({...r,id:crypto.randomUUID(),name:'Earlier'});await f.workspace.store.save({...r,id:crypto.randomUUID(),name:'Latest'});
  const html=f.controls.querySelector('[data-m-list]').innerHTML;assert.ok(html.indexOf('Latest')<html.indexOf('Earlier'));assert.doesNotMatch(html,/data-m="export-check"/);assert.match(html,/data-m="edit-record"/);f.workspace.dispose();
});

test('crowded overview labels are bounded and selected measurement is prioritized without losing records',async()=>{
  const f=fixture(),ids=[];for(let i=0;i<12;i++){const id=crypto.randomUUID();ids.push(id);await f.workspace.store.save({id,name:`Overlay ${i}`,kind:'distance',collection:'spatial3d',vertices:[[30,30,0],[70,70,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}});}
  f.workspace.tick();assert.ok((f.svg().innerHTML.match(/<text /g)||[]).length<12);
  f.controls.fire('click',{target:{closest:selector=>selector==='[data-m]'?{dataset:{m:'select'}}:selector==='[data-record]'?{dataset:{record:ids[0]}}:null}});f.workspace.tick();assert.match(f.svg().innerHTML,/Overlay 0/);assert.equal(f.workspace.store.records.size,12);f.workspace.dispose();
});

test('Backspace undoes committed points, ignores typed fields, and Space drag edits a vertex',()=>{
  const f=fixture();f.workspace.setTool('area');f.click(10,10);f.click(100,10);f.click(100,100);
  const input=new Element('input');input.interactive=true;f.windowRef.fire('keydown',event(0,0,{key:'Backspace',target:input}));assert.equal(f.workspace.getDraft().vertices.length,3);
  f.windowRef.fire('keydown',event(0,0,{key:'Backspace'}));assert.equal(f.workspace.getDraft().vertices.length,2);
  f.windowRef.fire('keydown',event(0,0,{key:' ',code:'Space'}));f.canvas.fire('pointerdown',event(10,10));f.canvas.fire('pointermove',event(20,25,{buttons:1}));f.canvas.fire('pointerup',event(20,25));f.windowRef.fire('keyup',event(0,0,{key:' ',code:'Space'}));
  assert.deepEqual(Array.from(f.workspace.getDraft().vertices[0]),[20,25,0]);assert.equal(f.workspace.getDraft().vertices.length,2);f.workspace.dispose();
});

test('cursor preview uses its own edge lengths and finishing preserves only committed vertices',async()=>{
  const f=fixture();f.workspace.setTool('area');f.click(10,10);f.click(100,10);f.click(100,100);
  f.canvas.fire('pointermove',event(10,100));f.workspace.tick();
  assert.match(f.svg().innerHTML,/10,10 100,10 100,100 10,100/);
  assert.equal((f.svg().innerHTML.match(new RegExp(geometry.measurementValue(90,1).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'g'))||[]).length,4);
  assert.match(f.svg().innerHTML,/r="4"/);
  f.windowRef.fire('keydown',event(0,0,{key:'Escape'}));await flush();assert.equal(f.workspace.store.records.size,1);assert.equal([...f.workspace.store.records.values()][0].vertices.length,3);f.workspace.dispose();
});

test('map control buttons remain usable while measuring and never place a point',()=>{
  const f=fixture();f.setMode('ortho');f.workspace.tick();f.workspace.setTool('area');
  const button=new Element('button');button.interactive=true;const down=event(20,20,{target:button});f.canvas.fire('pointerdown',down);f.canvas.fire('pointerup',event(20,20,{target:button}));
  assert.equal(down.stopped,undefined);assert.equal(f.workspace.getDraft().vertices.length,0);f.workspace.dispose();
});

test('permission loss disarms the draft and restores ordinary pointer navigation',()=>{
  const f=fixture();f.workspace.setTool('area');f.click(10,10);f.setPermission(false);f.workspace.tick();
  assert.equal(f.workspace.isDrawing(),false);
  const down=event(30,30);f.canvas.fire('pointerdown',down);assert.equal(down.stopped,undefined);assert.equal(f.svg().innerHTML,'');f.workspace.dispose();
});

test('coordinate reference never fabricates geographic metadata for local models',()=>{
  const start=main.indexOf('function measurementCoordinateReference()'),end=main.indexOf('function measurementViewContext()',start),scope=vm.createContext({PROJECT:{georef:{}},UTM_PROJECTION:{hemisphere:'N',zoneLon0Deg:-87}});
  vm.runInContext(main.slice(start,end),scope);assert.equal(scope.measurementCoordinateReference().crs,'LOCAL:unverified');
  scope.PROJECT.georef={utmZoneLon0Deg:-87,hemisphere:'N'};assert.equal(scope.measurementCoordinateReference().crs,'EPSG:32616');
});

test('3D adapter maps model picks to canonical E/N/Z and cloud picks remain canonical',()=>{
  const canvas=new Element('canvas');canvas.clientWidth=400;canvas.clientHeight=300;
  const camera=new THREE.PerspectiveCamera(60,4/3,.1,1000);camera.position.set(0,0,10);camera.updateMatrixWorld();
  const material={},point=new THREE.Vector3(500101,4800203,107),points={material,visibleNodes:[{}],pick:()=>({position:point})};
  const renderer={domElement:canvas,setRenderTarget(){},state:{reset(){}},setScissorTest(){}},viewer={scene:{getActiveCamera:()=>camera,pointclouds:[points]},renderer};
  const measurementDisplaySurfaceRevision=()=>{throw new Error('Picking must not sample the display surface');},resolveRenderedMeasurementVertices=()=>{throw new Error('Picking must not resolve display geometry');};
  const scope=vm.createContext({THREE,state:{activeMode:'model',cloudMode:'potree'},isMapMode:()=>false,camera,renderer,dom:{cloudContainer:{},threeContainer:{}},document:{getElementById:()=>({contentWindow:{THREE,viewer}})},pickSurface:()=>new THREE.Vector3(1,2,-3),eventNdc:()=>new THREE.Vector2(),worldToUtm:p=>({e:p.x+500100,n:-p.z+4800200,alt:p.y+105}),utmToWorld:(e,n,z)=>new THREE.Vector3(e-500100,z-105,-(n-4800200))});
  Object.assign(scope,{measurementDisplaySurfaceRevision,resolveRenderedMeasurementVertices});
  const start=main.indexOf('function measurementViewContext()'),end=main.indexOf('async function calculateSavedMeasurementSurface',start);vm.runInContext(main.slice(start,end),scope);
  assert.equal(scope.measurementViewContext().getDisplaySurfaceRevision,measurementDisplaySurfaceRevision);
  assert.equal(scope.measurementViewContext().resolveRenderedDisplayVertices,resolveRenderedMeasurementVertices);
  assert.deepEqual(Array.from(scope.measurementViewContext().pick(event(20,20))),[500101,4800203,107]);
  scope.state.activeMode='cloud';assert.deepEqual(Array.from(scope.measurementViewContext().pick(event(20,20))),[500101,4800203,107]);assert.equal(points.material,material);
});

test('basemap initialization opts into anonymous CORS for measurement exports',()=>{
  const start=main.indexOf('function ensureMap()'),end=main.indexOf('  map.setView(',start);
  const layers=[],mapStub={createPane(){},getPane:()=>({style:{}})};
  const scope=vm.createContext({map:null,dom:{leafletMap:{style:{}}},L:{map:()=>mapStub,tileLayer:(url,options)=>{layers.push({url,options});return{addTo(){}};}}});
  vm.runInContext(main.slice(start,end)+'}',scope);scope.ensureMap();
  assert.equal(layers.length,1);assert.match(layers[0].url,/server\.arcgisonline\.com/);
  assert.equal(layers[0].options.crossOrigin,'anonymous');assert.equal(layers[0].options.attribution,'Tiles © Esri');
});

test('map screenshots preserve transparent tiles and reject cross-origin-tainted captures',async()=>{
  const draws=[],ctx={globalAlpha:1,fillRect(){},drawImage(tile,...bounds){draws.push({tile,alpha:this.globalAlpha,bounds});}};
  const canvas={getContext:()=>ctx,toDataURL:()=> 'data:image/png;base64,AA=='};
  const pane={querySelector:()=>null,querySelectorAll:()=>[tile],parentElement:null};
  const tile={parentElement:pane,getBoundingClientRect:()=>({left:10,top:20,right:110,bottom:120,width:100,height:100})};
  const mapElement={getBoundingClientRect:()=>({left:0,top:0,right:400,bottom:300,width:400,height:300}),querySelectorAll:()=>[pane]};
  const styles=new Map([[pane,{zIndex:'400',opacity:'1'}],[tile,{zIndex:'auto',opacity:'0'}]]);
  const scope=vm.createContext({state:{activeMode:'ortho'},isMapMode:()=>true,map:{},dom:{leafletMap:mapElement},document:{createElement:()=>canvas},getComputedStyle:node=>styles.get(node)||{opacity:'1',zIndex:'0'}});
  const start=main.indexOf('function measurementViewContext()'),end=main.indexOf('async function calculateSavedMeasurementSurface',start);vm.runInContext(main.slice(start,end),scope);
  await scope.measurementViewContext().capture();assert.equal(canvas.width,400);assert.equal(canvas.height,300);
  assert.ok(draws.length===0||draws.every(draw=>draw.alpha===0),'zero-opacity imagery must not become opaque in exports');
  styles.get(tile).opacity='1';canvas.toDataURL=()=>{throw new Error('SecurityError');};
  await assert.rejects(scope.measurementViewContext().capture(),/basemap prevents browser image export|screenshot/i);
});
