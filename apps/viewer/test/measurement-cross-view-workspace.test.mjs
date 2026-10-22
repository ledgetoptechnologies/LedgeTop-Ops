import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import * as geometry from '../measurement-document.mjs';
import {createMeasurementStore} from '../measurement-store.mjs';
import {createMeasurementListLayout} from '../measurement-list-layout.mjs';
import {retainedDisplayBoundary} from '../measurement-display-elevations.mjs';

const source=readFileSync(new URL('../measurement-workspace.mjs',import.meta.url),'utf8');
const {validateMeasurement}=createRequire(import.meta.url)('../server/measurementRepository.js');
const flush=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};
const codedError=(message,code)=>Object.assign(new Error(message),{code});

// DOM/render seams execute the actual workspace event handlers. Assertions cover
// collection identity and async lifetime, not browser pixels or native picking.
class Element {
  constructor(tag='div'){this.tagName=tag;this.children=[];this.dataset={};this.style={};this.queries=new Map();this.handlers=new Map();this.attributes={};this.innerHTML='';this.textContent='';this.value='';this.classList={add(){},remove(){},toggle(){}};}
  append(...nodes){this.children.push(...nodes);for(const node of nodes)node.parentElement=this;}
  remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(node=>node!==this);}
  setAttribute(key,value){this.attributes[key]=value;}
  getAttribute(key){return this.attributes[key];}
  querySelector(key){if(!this.queries.has(key)){const node=new Element();node.ownerDocument=this.ownerDocument;this.queries.set(key,node);}return this.queries.get(key);}
  querySelectorAll(){return [];}
  addEventListener(key,fn){if(!this.handlers.has(key))this.handlers.set(key,[]);this.handlers.get(key).push(fn);}
  removeEventListener(key,fn){this.handlers.set(key,(this.handlers.get(key)||[]).filter(value=>value!==fn));}
  fire(key,event){return Promise.all((this.handlers.get(key)||[]).map(fn=>fn(event)));}
  closest(){return null;}
  getBoundingClientRect(){return{left:0,top:0,width:800,height:600};}
  setPointerCapture(){} releasePointerCapture(){} focus(){} click(){}
}

function fixture({resolveDisplayVertices=async record=>({vertices:record.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'}),resolveRenderedDisplayVertices,displaySurfaceRevision='surface-1',viewCrs='EPSG:32616',surfaceRequest,adminRequest,pick=event=>[event.clientX,event.clientY,0],project=point=>point.slice(0,2),onBeforeAccessLost=()=>{},token=()=>null,storeFactory=createMeasurementStore}={}){
  const window=new Element(),document={defaultView:window,createElement(tag){const node=new Element(tag);node.ownerDocument=this;return node;},createElementNS(_ns,tag){return this.createElement(tag);}};
  document.body=document.createElement('body');document.head=document.createElement('head');
  const panel=document.createElement('section'),canvas=document.createElement('canvas'),host=document.createElement('div');
  const projected=[],downloads=[],mutations=[],calculationCalls=[],resolverCalls=[],renderedResolverCalls=[],focused=[];
  let mode='model',permission=true,surfaceRevision=displaySurfaceRevision,surfaceRevisionReads=0,now=1000;
  const context=()=>{
    const view={mode,element:canvas,host,viewSignature:()=>mode,getDisplaySurfaceRevision:()=>{surfaceRevisionReads++;return surfaceRevision;},pick,project(point){projected.push({mode,point:Array.from(point)});return project(point);},focus(vertices){focused.push({mode,vertices:structuredClone(vertices)});}};
    if(resolveRenderedDisplayVertices)view.resolveRenderedDisplayVertices=(record,options)=>{renderedResolverCalls.push({record:structuredClone(record),options,mode});return resolveRenderedDisplayVertices(record,options);};
    return view;
  };
  const scope=vm.createContext({...geometry,createMeasurementStore:storeFactory,createMeasurementListLayout,retainedDisplayBoundary,availableAdminSources:()=>[],document,window,crypto,structuredClone,AbortController,DOMException,console,Blob,
    URL:{createObjectURL(blob){downloads.push(blob);return'blob:fixture';},revokeObjectURL(){}},
    setInterval:()=>1,clearInterval(){},setTimeout:()=>1,performance:{now:()=>now},
    openSurfaceDialog:options=>{calculationCalls.push(options);return{close(){}};},openAdminCalculationDialog:()=>{throw new Error('Unexpected server calculation dialog');}});
  vm.runInContext(source.replace(/^import .*;\r?\n/gm,'').replace('export function createMeasurementWorkspace','function createMeasurementWorkspace'),scope);
  const workspace=scope.createMeasurementWorkspace({panel,context,token,permitted:()=>permission,toolChanged(){},onBeforeAccessLost,coordinateReference:()=>({crs:viewCrs,verticalUnit:'m'}),toLonLat:p=>p.slice(0,2),calculateSurface:()=>{calculationCalls.push('calculate');},surfaceRequest,adminRequest,resolveDisplayVertices:(record,options)=>{resolverCalls.push({id:record.id,record:structuredClone(record),options});return resolveDisplayVertices(record,options);}});
  const controls=panel.children[0];workspace.tick();
  const action=(name,id)=>controls.fire('click',{target:{closest:selector=>selector==='[data-m]'?{dataset:{m:name}}:selector==='[data-record]'&&id?{dataset:{record:id}}:null}});
  return{workspace,controls,panel,canvas,window,projected,downloads,mutations,calculationCalls,resolverCalls,renderedResolverCalls,focused,action,
    svg:()=>host.children.find(node=>node.tagName==='svg'),list:()=>controls.querySelector('[data-m-list]').innerHTML,
    async switchTo(next){workspace.modeChanged();mode=next;workspace.tick();await flush();workspace.tick();},
    setSurfaceRevision(next,{advance=0}={}){surfaceRevision=next;now+=advance;},advance(ms){now+=ms;},
    surfaceRevisionReadCount:()=>surfaceRevisionReads,
    expireBeforeTick(){permission=false;},deny(){permission=false;workspace.tick();},
    exportCheck(id){return controls.fire('change',{target:{dataset:{m:'export-check'},checked:true,closest:()=>({dataset:{record:id}})}});},
    watchMutations(){for(const name of ['save','patch','remove','attachResults']){const original=workspace.store[name];workspace.store[name]=(...args)=>{mutations.push(name);return original(...args);};}},
    async exportJson(){controls.querySelector('[data-m="format"]').value='json';await action('export');return JSON.parse(await downloads.at(-1).text());}
  };
}

const document=(collection,name)=>({id:crypto.randomUUID(),name,collection,kind:'distance',vertices:collection==='map'?[[250,200,0],[390,230,0]]:[[20,40,132.123456789],[100,60,139.987654321]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},visible:true,source:{kind:collection==='map'?'ortho':'mesh'},results:{status:'geometry-only',method:'vertex-geometry',...(collection==='map'?{elevationBasis:'not-sampled'}:{})}});

test('public page-only measurements clearly distinguish temporary records and exports from saved project data',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());
  assert.equal(f.controls.querySelector('[data-m-list-title]').textContent,'Temporary measurements');
  assert.match(f.controls.querySelector('[data-m-list-caption]').textContent,/page only.*reset on refresh or closing the tab.*not saved to the project.*Export all measurements/);
  assert.match(f.list(),/No temporary measurements yet/);
  await f.workspace.store.save(document('spatial3d','Public scratch measurement'));
  assert.match(f.controls.querySelector('[data-m-list]').getAttribute('aria-label'),/^Temporary measurements, 1 record/);
  assert.match(f.list(),/Temporary — resets on refresh/);
  assert.equal(f.workspace.store.persistent(),false);
  assert.equal((await f.exportJson()).measurements.length,1);
});

for(const persistence of [true,false])test(`authenticated measurement capability personalPersistence=${persistence} controls collection copy`,async t=>{
  const calls=[];
  const f=fixture({token:()=> 'fixture-session',storeFactory:options=>createMeasurementStore({...options,fetcher:async(url,request)=>{calls.push(request.method);return{ok:true,status:200,json:async()=>({measurements:[],capabilities:{personalPersistence:persistence}})};}})});t.after(()=>f.workspace.dispose());
  await flush();f.workspace.tick();
  assert.equal(f.controls.querySelector('[data-m-list-title]').textContent,persistence?'Saved measurements':'Temporary measurements');
  assert.match(f.controls.querySelector('[data-m-list-caption]').textContent,persistence?/Exports include all saved measurements/:/not saved to the project/);
  assert.ok(calls.length>=2);assert.ok(calls.every(method=>method==='GET'));
});
function attachedPoint(basis='ept-vertical-crs'){
  const record={...document('map','Saved point boundary'),kind:'polygon',modelVersionId:'point-version',revision:2,vertices:[[250,200,0],[390,200,0],[390,300,0]],results:{method:'point-surface-cut-fill',calculationOrigin:'browser',calculationJobId:'point-job',source:{verticalUnitBasis:basis},netM3:77}};
  const result={method:'point-surface-cut-fill',calculationOrigin:'server-original-point-surface',boundaryVertices:record.vertices.map(([e,n])=>[e,n,181]),source:{kind:'ept',assetId:'ept-source',modelVersionId:record.modelVersionId,crs:'EPSG:32616',verticalUnit:'m',verticalUnitBasis:basis,boundaryElevationBasis:'point-grid',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)}};
  return{record,job:{id:'point-job',measurementId:record.id,method:'point-surface-cut-fill',status:'complete',attachmentRevision:2,result}};
}

test('saved point boundary reads one authorized attached result and never changes saved volume',async t=>{
  const {record,job}=attachedPoint(),calls=[],f=fixture({surfaceRequest:async(op,payload)=>{calls.push([op,payload]);return{calculation:job};}});t.after(()=>f.workspace.dispose());
  f.workspace.store.records.set(record.id,record);f.watchMutations();const before=JSON.stringify(record);
  f.workspace.tick();await flush();for(let i=0;i<50;i++)f.workspace.tick();await flush();
  assert.equal(calls.length,1);assert.equal(calls[0][0],'status');assert.equal(calls[0][1].jobId,job.id);
  assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===181));assert.equal(f.resolverCalls.length,0);
  assert.equal(JSON.stringify(record),before);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
});

test('unbound, wrong-source or untrusted point job replies never supply display geometry or fall back',async t=>{
  for(const change of [j=>j.id='other',j=>j.measurementId='other',j=>j.attachmentRevision=1,j=>j.status='failed',j=>j.result.source.modelVersionId='other',j=>j.result.calculationOrigin='browser',j=>j.result.boundaryVertices[0][0]++]){
    const {record,job}=attachedPoint();change(job);const f=fixture({surfaceRequest:async()=>({calculation:job})});t.after(()=>f.workspace.dispose());f.workspace.store.records.set(record.id,record);f.workspace.tick();await flush();f.workspace.tick();
    assert.equal(f.projected.length,0);assert.equal(f.resolverCalls.length,0);assert.match(f.list(),/3D overlay unavailable/);
  }
});

test('invalid saved point jobs may use only sanitized current rendered geometry for display',async t=>{
  for(const change of [j=>j.id='other',j=>j.attachmentRevision=1,j=>j.result.source.modelVersionId='other']){
    const {record,job}=attachedPoint();change(job);
    const f=fixture({surfaceRequest:async()=>({calculation:job}),resolveRenderedDisplayVertices:async display=>({vertices:display.vertices.map(([e,n])=>[e,n,222]),basis:'Current visible surface',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-1'})});
    t.after(()=>f.workspace.dispose());f.workspace.store.records.set(record.id,record);f.watchMutations();const before=JSON.stringify(record);
    f.workspace.tick();await flush();f.workspace.tick({force:true});
    assert.equal(f.resolverCalls.length,0,'an invalid attachment must not enter the generic saved-result fallback');
    assert.equal(f.renderedResolverCalls.length,1);const display=f.renderedResolverCalls[0].record;
    assert.equal(Object.hasOwn(display,'results'),false);assert.deepEqual(display.vertices,record.vertices.map(([e,n])=>[e,n,0]));assert.deepEqual(display.coordinateReference,record.coordinateReference);
    assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===222));
    assert.equal(JSON.stringify(record),before);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
  }
});

test('unavailable saved point jobs strip attached results before independent native or rendered placement',async t=>{
  const {record}=attachedPoint(),f=fixture({surfaceRequest:async()=>{throw new Error('Old job unavailable');},resolveDisplayVertices:async()=>{throw new Error('Raster metadata is unavailable');},resolveRenderedDisplayVertices:async display=>({vertices:display.vertices.map(([e,n])=>[e,n,223]),basis:'Current visible surface',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-1'})});
  t.after(()=>f.workspace.dispose());f.workspace.store.records.set(record.id,record);f.watchMutations();const before=JSON.stringify(record);
  f.workspace.tick();await flush();f.workspace.tick({force:true});
  assert.equal(f.resolverCalls.length,1);assert.equal(Object.hasOwn(f.resolverCalls[0].record,'results'),false);
  assert.equal(f.renderedResolverCalls.length,1);assert.equal(Object.hasOwn(f.renderedResolverCalls[0].record,'results'),false);
  assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===223));
  assert.equal(JSON.stringify(record),before);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
});

test('late independent rendered placement cannot restore an invalid attachment after access loss',async t=>{
  const {record,job}=attachedPoint();job.id='other';const waiting=deferred();
  const f=fixture({surfaceRequest:async()=>({calculation:job}),resolveRenderedDisplayVertices:(_record,{signal})=>{waiting.signal=signal;return waiting.promise;}});t.after(()=>f.workspace.dispose());
  f.workspace.store.records.set(record.id,record);f.workspace.tick();await flush();assert.equal(f.renderedResolverCalls.length,1);
  f.deny();assert.equal(waiting.signal.aborted,true);waiting.resolve({vertices:record.vertices.map(([e,n])=>[e,n,999]),basis:'Late surface',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-1'});await flush();f.workspace.tick({force:true});
  assert.equal(f.projected.length,0);assert.equal(f.svg().innerHTML,'');assert.equal(f.workspace.store.records.size,0);
});

test('late attached job reads cannot restore overlays after access loss',async t=>{
  const {record,job}=attachedPoint(),wait=deferred(),f=fixture({surfaceRequest:()=>wait.promise});t.after(()=>f.workspace.dispose());f.workspace.store.records.set(record.id,record);f.workspace.tick();await flush();f.deny();wait.resolve({calculation:job});await flush();f.workspace.tick();assert.equal(f.projected.length,0);assert.equal(f.svg().innerHTML,'');
});

test('verified staff capability arriving later retries only waiting declared-point placement',async t=>{
  const {record,job}=attachedPoint('administrator-declared'),caps=deferred();let ordinaryCalls=0,staffReads=0;
  const f=fixture({resolveDisplayVertices:async()=>{throw Error('No verified elevation surface');},surfaceRequest:async()=>{ordinaryCalls++;throw Error('No ordinary fallback');},adminRequest:async op=>{if(op==='capabilities')return caps.promise;staffReads++;return{calculation:job};}});t.after(()=>f.workspace.dispose());f.workspace.store.records.set(record.id,record);f.workspace.tick();await flush();assert.equal(staffReads,0);assert.match(f.list(),/No verified elevation surface/);
  caps.resolve({capabilities:{serverCalculations:true}});await flush();f.workspace.tick();await flush();f.workspace.tick();assert.equal(staffReads,1);assert.equal(ordinaryCalls,0);assert.ok(f.projected.every(p=>p.point[2]===181));assert.ok(f.projected.length>0);
});

test('legacy point results and unavailable job reads retain strict elevation-resolver fallback',async t=>{
  for(const type of ['no-boundary','no-transport','unavailable','staff-unavailable']){
    const {record,job}=attachedPoint(type==='staff-unavailable'?'administrator-declared':'ept-vertical-crs');delete job.result.boundaryVertices;
    const f=fixture({surfaceRequest:type==='no-transport'?undefined:async()=>{if(type==='unavailable')throw Error('Job unavailable');return{calculation:job};}});t.after(()=>f.workspace.dispose());
    f.workspace.store.records.set(record.id,record);f.workspace.tick();await flush();f.workspace.tick();
    assert.equal(f.resolverCalls.length,1);assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===145));assert.equal(record.results.calculationOrigin,'browser');
  }
});
async function seed(f){
  const spatial=document('spatial3d','Measured roof'),map={...document('map','Map boundary'),kind:'polygon',vertices:[[250,200,0],[390,200,0],[390,300,0],[250,300,0]],
    results:{status:'complete',method:'surface-cut-fill',cutM3:1234.567890123,fillM3:2.123456789,netM3:1232.444433334,coverage:1,sourceKind:'dsm',modelVersionId:'fixture-version',reference:{type:'custom',elevationM:140,offsetM:0},calculationOrigin:'browser',verified:false,warnings:['Fixture source vertical datum'],boundaryVertices:[[250,200,145],[390,200,145],[390,300,145],[250,300,145]]}};
  await f.workspace.store.save(spatial);await f.workspace.store.save(map);await flush();return{spatial,map};
}

test('all five views expose both original collections without duplicate records, switch writes, or calculations',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const{spatial,map}=await seed(f);const snapshot=JSON.stringify([...f.workspace.store.records.values()]);f.watchMutations();
  for(const mode of ['model','cloud','ortho','dsm','dtm','model']){
    await f.switchTo(mode);assert.match(f.list(),/Measured roof/);assert.match(f.list(),/Map boundary/);assert.equal(f.controls.querySelector('[data-m-count]').textContent,'2');
    assert.match(f.svg().innerHTML,/Measured roof/);assert.match(f.svg().innerHTML,/Map boundary/);assert.equal(f.workspace.store.records.size,2);
  }
  assert.equal(JSON.stringify([...f.workspace.store.records.values()]),snapshot);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
  assert.equal(f.workspace.store.records.get(spatial.id).collection,'spatial3d');assert.equal(f.workspace.store.records.get(map.id).collection,'map');
  assert.ok(f.projected.filter(p=>['model','cloud'].includes(p.mode)).every(p=>p.point[2]!==0),'map placeholder Z must not be projected as measured elevation');
});

test('selection survives map/3D detours and export-all retains original geometry and provenance',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const{spatial,map}=await seed(f);await f.action('select',spatial.id);
  for(const mode of ['ortho','dsm','dtm','cloud','model']){
    await f.switchTo(mode);
    assert.match(f.list(),new RegExp(`measurement-row selected[^>]*data-record="${spatial.id}"`));
    const row=f.list().split(`data-record="${map.id}"`)[1]?.split('</article>')[0];assert.match(row,/Map boundary/);
  }
  // Export all now includes all saved records, independent of prior selection.
  const exported=await f.exportJson();assert.equal(exported.measurements.length,2);const exportedMap=exported.measurements.find(r=>r.id===map.id);
  for(const key of ['vertices','collection','coordinateReference','source','results'])assert.deepEqual(exportedMap[key],map[key]);
});

test('spatial editing in maps remains refused and never substitutes placeholder Z for measured elevation',async t=>{
  for(const [collection,mode]of [['spatial3d','ortho'],['spatial3d','dsm'],['spatial3d','dtm']]){
    const f=fixture();t.after(()=>f.workspace.dispose());const record=document(collection,'Original geometry');await f.workspace.store.save(record);await f.switchTo(mode);await f.action('select',record.id);f.watchMutations();
    await f.action('edit');assert.equal(f.workspace.getDraft(),null);
    assert.match(f.panel.children[1].textContent,/switch|return|open|edit/i);assert.match(f.panel.children[1].textContent,/map|3D|point cloud|orthophoto/i);
    assert.deepEqual(f.workspace.store.records.get(record.id).vertices,record.vertices);assert.deepEqual(f.mutations,[]);
    await f.switchTo(collection==='map'?'ortho':'model');await f.action('edit');assert.equal(f.workspace.getDraft()?.id,record.id,'editing still works in the origin family');
  }
});

const pointer=(x,y,extra={})=>({clientX:x,clientY:y,button:0,buttons:0,pointerId:1,target:{closest:()=>null},preventDefault(){},stopImmediatePropagation(){},...extra});
test('editing passes ordinary navigation through in all five modes and changes cursor only over handles',async t=>{
  for(const mode of ['model','cloud','ortho','dsm','dtm']){
    const f=fixture();t.after(()=>f.workspace.dispose());await f.switchTo(mode);const record={...document('map','Navigation'),kind:'polygon',vertices:[[100,100,0],[300,100,0],[300,300,0],[100,300,0]]};await f.workspace.store.save(record);f.workspace.tick();await flush();await f.action('edit-record',record.id);f.workspace.tick();
    const before=JSON.stringify(f.workspace.getDraft());let stopped=0;const event=(x,y,extra={})=>pointer(x,y,{stopImmediatePropagation(){stopped++;},...extra});
    assert.equal(f.canvas.style.cursor||'','');await f.canvas.fire('pointermove',event(100,100));assert.equal(f.canvas.style.cursor,'move');await f.canvas.fire('pointermove',event(650,450));assert.equal(f.canvas.style.cursor,'');
    for(const button of [0,1,2]){await f.canvas.fire('pointerdown',event(650,450,{button}));await f.canvas.fire('pointermove',event(660,460,{button,buttons:button===2?2:1}));await f.canvas.fire('pointerup',event(660,460,{button}));}
    await f.canvas.fire('contextmenu',event(650,450,{button:2}));await f.canvas.fire('dblclick',event(650,450));assert.equal(stopped,0);assert.equal(JSON.stringify(f.workspace.getDraft()),before);assert.match(f.panel.children[1].textContent,/Enter, Esc or Finish/);
    await f.canvas.fire('pointerdown',event(100,100));assert.equal(stopped,1,'handle gesture stays exclusive');await f.canvas.fire('pointerup',event(100,100));await f.window.fire('keydown',event(0,0,{key:'Enter'}));await flush();assert.equal(f.workspace.getDraft(),null);
  }
});
test('changed geometry retains bounded historical values without current totals, trust or export confusion',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const {map}=await seed(f);map.revision=4;map.updatedAt='2026-09-27T12:00:00Z';map.results.calculationJobId='old-job';f.workspace.store.records.set(map.id,map);await f.switchTo('ortho');await f.action('edit-record',map.id);
  await f.canvas.fire('pointerdown',pointer(250,200));await f.canvas.fire('pointerup',pointer(240,200));await f.action('finish');const saved=f.workspace.store.records.get(map.id),history=saved.results.previousVolume;
  assert.equal(history.netM3,map.results.netM3);assert.equal(history.unit,'m3');assert.equal(history.status,'historical');assert.equal(history.revision,4);assert.equal(history.recordedAt,map.updatedAt);assert.equal(history.calculationJobId,undefined);assert.equal(history.source,undefined);assert.equal(history.boundaryVertices,undefined);assert.equal(saved.results.netM3,undefined);assert.equal(saved.results.calculationJobId,undefined);
  const body=Object.fromEntries(['id','name','collection','kind','vertices','coordinateReference','visible','source','results','displayPreferences','revision'].filter(key=>saved[key]!==undefined).map(key=>[key,saved[key]]));const validated=validateMeasurement(body,{update:true});assert.equal(validated.results.previousVolume.netM3,history.netM3);assert.equal(validated.results.verified,false);
  const csv=geometry.exportMeasurements([saved],'csv');assert.doesNotMatch(csv,/1232\.444433334/);const json=JSON.parse(geometry.exportMeasurements([saved],'json'));assert.equal(json.measurements[0].results.previousVolume.status,'historical');assert.equal(json.measurements[0].results.netM3,undefined);
  await f.action('edit-record',map.id);await f.canvas.fire('pointerdown',pointer(240,200));await f.canvas.fire('pointerup',pointer(230,200));await f.action('finish');assert.deepEqual(f.workspace.store.records.get(map.id).results.previousVolume,history,'repeat edits retain a single bounded prior summary');
});
test('ephemeral draft recovery restores only matching mode CRS and unchanged saved revision',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const {map}=await seed(f);await f.switchTo('ortho');await f.action('edit-record',map.id);await f.canvas.fire('pointerdown',pointer(250,200));await f.canvas.fire('pointerup',pointer(240,200));const snapshot=f.workspace.exportDraft();
  const next=fixture();t.after(()=>next.workspace.dispose());await next.switchTo('ortho');next.workspace.store.records.set(map.id,structuredClone(map));next.watchMutations();assert.equal(await next.workspace.restoreDraft(snapshot),true);assert.equal(next.workspace.getDraft().vertices[0][0],240);assert.deepEqual(next.mutations,[]);
  for(const change of ['revision','geometry','mode','denied']){const other=fixture();t.after(()=>other.workspace.dispose());await other.switchTo(change==='mode'?'dsm':'ortho');const stored=structuredClone(map);if(change==='revision')stored.revision=88;if(change==='geometry')stored.vertices[0][0]++;other.workspace.store.records.set(map.id,stored);if(change==='denied')other.deny();assert.equal(await other.workspace.restoreDraft(snapshot),false);assert.equal(other.workspace.getDraft(),null);}
});
test('known-expiry checkpoint remains memory-only after permit expiry but never after invalidation',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());await f.switchTo('ortho');f.workspace.setTool('area');await f.canvas.fire('pointerdown',pointer(100,100));await f.canvas.fire('pointerup',pointer(100,100));const active=f.workspace.exportDraft();assert.equal(active.draft.vertices.length,1);f.watchMutations();f.expireBeforeTick();assert.equal(f.workspace.exportDraft(),null);const expired=f.workspace.exportDraft({recoverExpiredSession:true});assert.deepEqual(expired,active);assert.deepEqual(f.mutations,[]);f.workspace.invalidate();assert.equal(f.workspace.exportDraft({recoverExpiredSession:true}),null);
  const next=fixture();t.after(()=>next.workspace.dispose());await next.switchTo('ortho');next.watchMutations();assert.equal(await next.workspace.restoreDraft(expired),true);assert.equal(next.workspace.getDraft().vertices.length,1);assert.deepEqual(next.mutations,[]);
});
test('draft restoration distinguishes retryable saved-load failure from explicit conflict and retries read-only',async t=>{
  const original=fixture();t.after(()=>original.workspace.dispose());await original.switchTo('ortho');original.workspace.setTool('area');const snapshot=original.workspace.exportDraft();let failing=true,loads=0;
  const f=fixture({storeFactory:options=>{const store=createMeasurementStore(options),load=store.load;store.load=()=>{loads++;return failing?Promise.reject(new Error('temporary network failure')):load();};return store;}});t.after(()=>f.workspace.dispose());await f.switchTo('ortho');f.watchMutations();await assert.rejects(f.workspace.restoreDraft(snapshot),error=>error.code==='measurement_draft_restore_retry');f.workspace.showRecoveryNotice(true);assert.match(f.panel.children[1].textContent,/kept in this tab.*retry.*nothing has been saved/);assert.equal(f.workspace.getDraft(),null);failing=false;assert.equal(await f.workspace.restoreDraft(snapshot),true);assert.ok(loads>=3);assert.deepEqual(f.mutations,[]);
});
test('render-loop expiry checkpoints before retiring draft but explicit denial never invokes checkpoint hook',async t=>{
  let checkpoint=null,calls=0;const f=fixture({onBeforeAccessLost:()=>{calls++;checkpoint=f.workspace.exportDraft({recoverExpiredSession:true});}});t.after(()=>f.workspace.dispose());await f.switchTo('ortho');f.workspace.setTool('area');await f.canvas.fire('pointerdown',pointer(100,100));await f.canvas.fire('pointerup',pointer(100,100));f.expireBeforeTick();f.workspace.tick();assert.equal(calls,1);assert.equal(checkpoint.draft.vertices.length,1);assert.equal(f.workspace.getDraft(),null);f.workspace.tick();assert.equal(calls,1);
  const denied=fixture({onBeforeAccessLost:()=>{throw Error('Explicit denial must never checkpoint');}});t.after(()=>denied.workspace.dispose());denied.workspace.invalidate();assert.equal(denied.workspace.exportDraft({recoverExpiredSession:true}),null);
});
test('map outlines edit on model/cloud display heights but persist only XY and never calculate automatically',async t=>{
  for(const mode of ['model','cloud']){
    const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:e=>[e.clientX,e.clientY+160,160]});t.after(()=>f.workspace.dispose());
    const record={...document('map','Editable map outline'),kind:'polygon',vertices:[[100,200,0],[300,200,0],[300,400,0],[100,400,0]],results:{cutM3:85,fillM3:8,netM3:77}};
    await f.workspace.store.save(record);await f.switchTo(mode);await f.action('select',record.id);f.watchMutations();
    const before=JSON.stringify(f.workspace.store.records.get(record.id));await f.action('edit');f.workspace.tick();
    assert.ok(f.workspace.getDraft());assert.ok(f.workspace.getDraft().vertices.every(p=>p[2]===0));assert.match(f.svg().innerHTML,/cy="55"/,'handles project at display Z, not zero');
    await f.action('finish');assert.deepEqual(f.mutations,[],'unchanged finish must not bump saved revision or detach result');assert.equal(JSON.stringify(f.workspace.store.records.get(record.id)),before);
    await f.action('edit');f.workspace.tick();
    await f.canvas.fire('pointerdown',pointer(100,55));await f.canvas.fire('pointermove',pointer(120,65,{buttons:1}));f.advance(70);f.workspace.tick();await f.canvas.fire('pointerup',pointer(120,65));f.workspace.tick();
    assert.deepEqual(Array.from(f.workspace.getDraft().vertices[0]),[120,225,0]);assert.match(f.svg().innerHTML,/cx="120" cy="65"/,'moved handle retains picked display height');
    assert.equal(JSON.stringify(f.workspace.store.records.get(record.id)),before,'draft editing does not mutate saved record');
    await f.action('finish');assert.deepEqual(f.mutations,['save']);const saved=f.workspace.store.records.get(record.id);
    assert.equal(saved.collection,'map');assert.deepEqual(saved.source,record.source);assert.ok(saved.vertices.every(p=>p[2]===0));assert.equal(saved.results.volumeInvalidated,true);assert.equal(saved.results.netM3,undefined);assert.deepEqual(f.calculationCalls,[]);
    await f.switchTo('ortho');assert.equal(f.workspace.store.records.get(record.id).vertices[0][0],120);
  }
});

test('map 3D editing waits for placement, rejects mismatched CRS and retires its draft on access loss',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const record=document('map','Waiting outline');await f.workspace.store.save(record);f.workspace.tick();await flush();await f.action('edit-record',record.id);
  assert.equal(f.workspace.getDraft(),null);assert.match(f.panel.children[1].textContent,/Wait for the outline/);
  waiting.resolve({vertices:record.vertices.map(([e,n])=>[e,n,145])});await flush();f.workspace.tick();await f.action('edit-record',record.id);assert.ok(f.workspace.getDraft());f.watchMutations();f.deny();assert.equal(f.workspace.getDraft(),null);assert.deepEqual(f.mutations,[]);
  const mismatch=fixture({viewCrs:'EPSG:32615'});t.after(()=>mismatch.workspace.dispose());await mismatch.workspace.store.save(record);await mismatch.action('edit-record',record.id);assert.equal(mismatch.workspace.getDraft(),null);assert.match(mismatch.panel.children[1].textContent,/coordinate reference/);
});

test('map 3D edit insertion/deletion and invalid drags keep canonical and display vertices aligned',async t=>{
  const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:e=>[e.clientX,e.clientY+145,145]});t.after(()=>f.workspace.dispose());
  const record={...document('map','Edit rollback'),kind:'polygon',vertices:[[100,200,0],[300,200,0],[300,400,0],[100,400,0]],results:{cutM3:10,netM3:10,fillM3:0}};
  await f.workspace.store.save(record);await f.switchTo('cloud');await f.action('edit-record',record.id);f.watchMutations();
  await f.canvas.fire('pointerdown',pointer(200,55));await f.canvas.fire('pointerup',pointer(200,55));f.workspace.tick();
  assert.equal(f.workspace.getDraft().vertices.length,5);assert.deepEqual(Array.from(f.workspace.getDraft().vertices[1]),[200,200,0]);assert.match(f.svg().innerHTML,/cx="200" cy="55"/);
  await f.window.fire('keydown',pointer(0,0,{key:'Delete',code:'Delete'}));f.workspace.tick();assert.equal(f.workspace.getDraft().vertices.length,4);assert.doesNotMatch(f.svg().innerHTML,/data-measurement-vertex="4"/);
  await f.canvas.fire('pointerdown',pointer(100,55));await f.canvas.fire('pointermove',pointer(300,55,{buttons:1}));f.advance(70);f.workspace.tick();await f.canvas.fire('pointerup',pointer(300,55));f.workspace.tick();
  assert.deepEqual(JSON.parse(JSON.stringify(f.workspace.getDraft().vertices)),record.vertices,'invalid overlapping point rolls back saved-coordinate draft');assert.match(f.svg().innerHTML,/cx="100" cy="55"/,'display point rolls back too');
  await f.action('finish');assert.deepEqual(f.mutations,[]);assert.equal(f.workspace.store.records.get(record.id).results.netM3,10);
});

test('switching away from a changed map edit saves horizontal geometry once without invoking volume',async t=>{
  const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:e=>[e.clientX,e.clientY+200,200]});t.after(()=>f.workspace.dispose());
  const record=document('map','View switch edit');await f.workspace.store.save(record);await f.switchTo('cloud');await f.action('edit-record',record.id);f.watchMutations();
  await f.canvas.fire('pointerdown',pointer(250,55));await f.canvas.fire('pointerup',pointer(270,65));
  await f.switchTo('dsm');await flush();assert.equal(f.workspace.getDraft(),null);assert.deepEqual(f.mutations,['save']);assert.deepEqual(f.workspace.store.records.get(record.id).vertices[0],[270,265,0]);assert.deepEqual(f.calculationCalls,[]);
});

test('cancelled map 3D drags restore both coordinate arrays and never save a partial gesture',async t=>{
  for(const cancel of ['pointercancel','blur','modeChanged']){
    const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:e=>[e.clientX,e.clientY+200,200]});t.after(()=>f.workspace.dispose());const record=document('map','Cancelled edit');await f.workspace.store.save(record);await f.switchTo('model');await f.action('edit-record',record.id);f.watchMutations();
    await f.canvas.fire('pointerdown',pointer(250,55));await f.canvas.fire('pointermove',pointer(270,65,{buttons:1}));f.advance(70);f.workspace.tick();assert.equal(f.workspace.getDraft().vertices[0][0],270);
    if(cancel==='modeChanged')await f.switchTo('dtm');else{await(cancel==='blur'?f.window:f.canvas).fire(cancel,pointer(270,65));f.workspace.tick();assert.deepEqual(JSON.parse(JSON.stringify(f.workspace.getDraft().vertices)),record.vertices);assert.match(f.svg().innerHTML,/cx="250" cy="55"/);await f.action('finish');}
    assert.deepEqual(f.mutations,[]);assert.deepEqual(f.workspace.store.records.get(record.id).vertices,record.vertices);
  }
});

test('a different display height at unchanged map XY cannot invalidate the saved volume',async t=>{
  const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:()=>[250,200,900]});t.after(()=>f.workspace.dispose());
  const record={...document('map','Same XY'),results:{cutM3:11,fillM3:1,netM3:10,calculationJobId:'unchanged-job'}};await f.workspace.store.save(record);await f.switchTo('model');const before=JSON.stringify(f.workspace.store.records.get(record.id));await f.action('edit-record',record.id);f.watchMutations();
  await f.canvas.fire('pointerdown',pointer(250,55));await f.canvas.fire('pointerup',pointer(270,65));await f.action('finish');
  assert.deepEqual(f.mutations,[]);assert.equal(JSON.stringify(f.workspace.store.records.get(record.id)),before);assert.deepEqual(f.calculationCalls,[]);
});

test('click jitter on an elevated edit handle restores the preview and does not invalidate volume',async t=>{
  const f=fixture({project:p=>[p[0],p[1]-p[2]],pick:e=>[e.clientX,e.clientY+145,145]});t.after(()=>f.workspace.dispose());
  const record={...document('map','No jitter edit'),results:{cutM3:11,fillM3:1,netM3:10}};await f.workspace.store.save(record);await f.switchTo('cloud');const before=JSON.stringify(f.workspace.store.records.get(record.id));await f.action('edit-record',record.id);f.watchMutations();
  await f.canvas.fire('pointerdown',pointer(250,55));await f.canvas.fire('pointermove',pointer(251,55,{buttons:1}));f.advance(70);f.workspace.tick();await f.canvas.fire('pointerup',pointer(251,55));f.workspace.tick();assert.match(f.svg().innerHTML,/cx="250" cy="55"/);await f.action('finish');
  assert.deepEqual(f.mutations,[]);assert.equal(JSON.stringify(f.workspace.store.records.get(record.id)),before);
});

test('pending map draping is bounded and never renders placeholder elevations; completion is display-only',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Pending boundary');await f.workspace.store.save(map);f.watchMutations();
  for(let i=0;i<100;i++)f.workspace.tick();await flush();
  assert.match(f.list(),/Pending boundary/);assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/Pending boundary/);assert.equal(f.resolverCalls.length,1,'do not request a raster per animation frame');
  waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'});await flush();f.workspace.tick();
  assert.match(f.svg().innerHTML,/Pending boundary/);assert.ok(f.projected.every(p=>p.point[2]===145));assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);assert.deepEqual(f.mutations,[]);
});

test('application rendered-pending errors switch retries to the view adapter without reopening native placement',async t=>{
  const f=fixture({resolveDisplayVertices:async()=>{throw codedError('Waiting for displayed surface detail.','measurement_display_surface_pending');},resolveRenderedDisplayVertices:async record=>({vertices:record.vertices.map(([e,n])=>[e,n,161]),basis:'Visible detail',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-2'})});
  t.after(()=>f.workspace.dispose());const map=document('map','Waiting rendered boundary');await f.workspace.store.save(map);f.watchMutations();
  f.workspace.tick();await flush();for(let i=0;i<20;i++)f.workspace.tick();
  assert.equal(f.resolverCalls.length,1);assert.equal(f.renderedResolverCalls.length,0);assert.equal(f.projected.length,0);assert.match(f.list(),/Waiting for displayed surface detail/);
  f.setSurfaceRevision('surface-2',{advance:500});f.workspace.tick();await flush();f.workspace.tick({force:true});
  assert.equal(f.resolverCalls.length,1,'surface-generation retries must not repeat native raster work');assert.equal(f.renderedResolverCalls.length,1);
  assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===161));assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
});

test('rendered placement retains its last complete outline while throttled surface generations are pending',async t=>{
  let renderedRefresh=0;
  const f=fixture({resolveDisplayVertices:async record=>({vertices:record.vertices.map(([e,n])=>[e,n,151]),basis:'Initial visible detail',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-1'}),resolveRenderedDisplayVertices:async record=>{
    renderedRefresh++;
    if(renderedRefresh===1)throw codedError('New visible tiles do not cover every outline point yet.','measurement_display_surface_pending');
    return{vertices:record.vertices.map(([e,n])=>[e,n,181]),basis:'Refined visible detail',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-3'};
  }});
  t.after(()=>f.workspace.dispose());const map=document('map','Stable rendered boundary');await f.workspace.store.save(map);f.watchMutations();
  f.workspace.tick();await flush();f.projected.length=0;f.workspace.tick({force:true});assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===151));
  f.setSurfaceRevision('surface-2',{advance:499});f.workspace.tick({force:true});assert.equal(f.renderedResolverCalls.length,0);assert.ok(f.projected.every(p=>p.point[2]===151));
  f.advance(1);f.workspace.tick();await flush();assert.equal(f.renderedResolverCalls.length,1);assert.equal(f.resolverCalls.length,1);
  f.projected.length=0;f.workspace.tick({force:true});assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===151),'pending refinement keeps the complete prior outline');assert.match(f.list(),/previous 3D overlay/i);
  for(let i=0;i<20;i++)f.workspace.tick();await flush();assert.equal(f.renderedResolverCalls.length,1,'one surface generation is attempted once');
  f.setSurfaceRevision('surface-3',{advance:499});f.workspace.tick();assert.equal(f.renderedResolverCalls.length,1,'rapid frontier churn is throttled');
  f.advance(1);f.workspace.tick();await flush();f.projected.length=0;f.workspace.tick({force:true});
  assert.equal(f.renderedResolverCalls.length,2);assert.equal(f.resolverCalls.length,1);assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===181));
  assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);assert.deepEqual(f.mutations,[]);assert.deepEqual(f.calculationCalls,[]);
});

test('a stale rendered reply is not installed or mistaken for the requested surface generation',async t=>{
  let refresh=0;
  const f=fixture({resolveDisplayVertices:async record=>({vertices:record.vertices.map(([e,n])=>[e,n,151]),basis:'Initial visible detail',renderedSurface:true,displayOnly:true,surfaceRevision:'surface-1'}),resolveRenderedDisplayVertices:async record=>{
    refresh++;const stale=refresh===1;
    return{vertices:record.vertices.map(([e,n])=>[e,n,stale?999:181]),basis:stale?'Stale detail':'Current detail',renderedSurface:true,displayOnly:true,surfaceRevision:stale?'surface-1':'surface-2'};
  }});
  t.after(()=>f.workspace.dispose());const map=document('map','Revision-bound boundary');await f.workspace.store.save(map);f.workspace.tick();await flush();
  f.setSurfaceRevision('surface-2',{advance:500});f.workspace.tick();await flush();f.projected.length=0;f.workspace.tick({force:true});
  assert.equal(f.renderedResolverCalls.length,1);assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===151),'a stale reply must retain the prior complete outline');assert.match(f.list(),/previous 3D overlay/i);
  f.advance(500);f.workspace.tick();await flush();f.projected.length=0;f.workspace.tick({force:true});
  assert.equal(f.renderedResolverCalls.length,2);assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===181));assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('native display placement remains cached across rendered-surface generation changes',async t=>{
  const f=fixture();t.after(()=>f.workspace.dispose());const map=document('map','Native cached boundary');await f.workspace.store.save(map);
  assert.equal(f.surfaceRevisionReadCount(),0,'an empty workspace does not inspect renderer generations');
  f.workspace.tick();await flush();f.workspace.tick({force:true});assert.equal(f.resolverCalls.length,1);assert.ok(f.projected.every(p=>p.point[2]===145));const initialRevisionReads=f.surfaceRevisionReadCount();
  for(const revision of ['surface-2','surface-3','surface-4']){f.setSurfaceRevision(revision,{advance:1000});f.workspace.tick();await flush();}
  f.projected.length=0;f.workspace.tick({force:true});assert.equal(f.resolverCalls.length,1);assert.equal(f.renderedResolverCalls.length,0);assert.equal(f.surfaceRevisionReadCount(),initialRevisionReads,'native cached placements do not inspect rendered frontier generations');assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.point[2]===145));
});

test('missing map elevation keeps the record available but does not invent a zero-height 3D overlay',async t=>{
  const f=fixture({resolveDisplayVertices:async()=>{throw new Error('No verified elevation surface');}});t.after(()=>f.workspace.dispose());const map=document('map','No surface');await f.workspace.store.save(map);
  f.workspace.tick();await flush();for(let i=0;i<100;i++)f.workspace.tick();await flush();
  assert.match(f.list(),/No surface/);assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/No surface/);assert.equal(f.resolverCalls.length,1,'failure must not cause per-frame retries');
  await f.switchTo('ortho');assert.match(f.svg().innerHTML,/No surface/);assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('late display samples cannot revive private records after access is invalidated',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Private boundary');await f.workspace.store.save(map);f.workspace.tick();await flush();
  assert.equal(f.resolverCalls.length,1);f.deny();waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture DSM samples'});await flush();f.workspace.tick();
  assert.equal(f.workspace.store.records.size,0);assert.equal(f.controls.hidden,true);assert.equal(f.svg().innerHTML,'');assert.equal(f.projected.length,0);
  await f.action('export');assert.equal(f.downloads.length,0);
});

test('five queued map records use no more than two concurrent elevation requests and drain without per-frame retries',async t=>{
  const pending=[],settled=new Set();let active=0,peak=0;
  const f=fixture({resolveDisplayVertices:record=>{
    const waiting=deferred();active++;peak=Math.max(peak,active);pending.push({record,waiting});
    return waiting.promise.finally(()=>active--);
  }});t.after(()=>f.workspace.dispose());
  for(let i=0;i<5;i++)await f.workspace.store.save(document('map',`Boundary ${i}`));
  for(let i=0;i<100;i++)f.workspace.tick();await flush();assert.equal(pending.length,2);assert.equal(active,2);
  for(let round=0;round<3;round++){
    for(const item of [...pending])if(!settled.has(item)){settled.add(item);item.waiting.resolve({vertices:item.record.vertices.map(([e,n])=>[e,n,145]),basis:'Fixture samples'});}
    await flush();f.workspace.tick();assert.ok(active<=2);assert.ok(peak<=2);
  }
  assert.equal(pending.length,5);assert.equal(active,0);assert.equal(f.resolverCalls.length,5);
  for(let i=0;i<100;i++)f.workspace.tick();await flush();assert.equal(f.resolverCalls.length,5);assert.equal(f.workspace.store.records.size,5);
});

test('mode changes abort pending placement and late source replies cannot replace the destination geometry',async t=>{
  const requests=[],f=fixture({resolveDisplayVertices:(record,{signal})=>{const waiting=deferred();requests.push({record,signal,waiting});return waiting.promise;}});t.after(()=>f.workspace.dispose());
  const map=document('map','Across views');await f.workspace.store.save(map);f.workspace.tick();await flush();assert.equal(requests.length,1);
  await f.switchTo('ortho');assert.equal(requests[0].signal.aborted,true);assert.match(f.svg().innerHTML,/Across views/);
  const mapMarkup=f.svg().innerHTML;f.projected.length=0;
  requests[0].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,999]),basis:'Obsolete source'});await flush();f.workspace.tick();
  assert.equal(f.svg().innerHTML,mapMarkup);assert.ok(f.projected.every(p=>p.mode==='ortho'&&p.point[2]===0));
  await f.switchTo('model');assert.equal(requests.length,2);await f.switchTo('cloud');assert.equal(requests[1].signal.aborted,true);assert.equal(requests.length,3);
  requests[2].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,180]),basis:'Destination source'});await flush();f.workspace.tick();assert.match(f.svg().innerHTML,/Across views/);
  f.projected.length=0;requests[1].waiting.resolve({vertices:map.vertices.map(([e,n])=>[e,n,888]),basis:'Obsolete second source'});await flush();f.workspace.tick({force:true});
  assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.mode==='cloud'&&p.point[2]===180));assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('two signal-ignoring placement promises release their slots when the view changes',async t=>{
  const requests=[],f=fixture({resolveDisplayVertices:(record,{signal})=>{
    const request={record,signal,waiting:deferred()};requests.push(request);
    if(requests.length<=2)return request.waiting.promise;
    return{vertices:record.vertices.map(([e,n])=>[e,n,177]),basis:'Destination surface'};
  }});t.after(()=>f.workspace.dispose());
  for(let i=0;i<2;i++)await f.workspace.store.save(document('map',`Ignoring boundary ${i}`));
  f.workspace.tick();await flush();assert.equal(requests.length,2);
  await f.switchTo('ortho');assert.ok(requests.slice(0,2).every(request=>request.signal.aborted));
  await f.switchTo('model');assert.equal(requests.length,4,'aborted promises that ignore their signals cannot starve the new view');
  f.projected.length=0;f.workspace.tick({force:true});assert.ok(f.projected.length>0);assert.ok(f.projected.every(p=>p.mode==='model'&&p.point[2]===177));
});

test('malformed or horizontally shifted elevation results are rejected instead of projecting false geometry',async t=>{
  const cases=[
    vertices=>vertices.slice(1),
    vertices=>vertices.map(([e,n])=>[e,n]),
    vertices=>vertices.map(([e,n])=>[e,n,NaN]),
    vertices=>vertices.map(([e,n])=>[e,n,Infinity]),
    vertices=>vertices.map(([e,n])=>[e,n,'145']),
    vertices=>vertices.map(([e,n])=>[e+.001,n,145]),
    vertices=>vertices.map(([e,n])=>[e,n+.001,145]),
    vertices=>vertices.map(([e,n])=>[e,n,1e10]),
  ];
  for(const result of cases){
    const f=fixture({resolveDisplayVertices:async record=>({vertices:result(record.vertices),basis:'Invalid fixture'})});t.after(()=>f.workspace.dispose());
    const map=document('map','Rejected placement');await f.workspace.store.save(map);f.workspace.tick();await flush();f.workspace.tick();
    assert.equal(f.projected.length,0);assert.doesNotMatch(f.svg().innerHTML,/Rejected placement/);assert.match(f.list(),/unavailable|finite|matching/i);
    assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
  }
});

test('focus waits for valid display elevations and never centers a map record at placeholder Z in 3D',async t=>{
  const waiting=deferred(),f=fixture({resolveDisplayVertices:()=>waiting.promise});t.after(()=>f.workspace.dispose());const map=document('map','Focus boundary');await f.workspace.store.save(map);await f.action('select',map.id);
  await f.action('focus');assert.equal(f.focused.length,0);await flush();
  const vertices=map.vertices.map(([e,n])=>[e,n,145]);waiting.resolve({vertices,basis:'Verified fixture'});await flush();f.workspace.tick();await f.action('focus');
  assert.equal(f.focused.length,1);assert.deepEqual(f.focused[0].vertices,vertices);assert.equal(f.focused[0].mode,'model');assert.deepEqual(f.workspace.store.records.get(map.id).vertices,map.vertices);
});

test('missing and mismatched coordinate references retain records without unsafe projection or focus',async t=>{
  for(const [viewCrs,recordCrs]of [['EPSG:32616','EPSG:32617'],['EPSG:32616',undefined],[undefined,'EPSG:32616'],['','EPSG:32616']]){
    // Explicit undefined must reach the fixture rather than its default parameter.
    const f=fixture({viewCrs:viewCrs??null});t.after(()=>f.workspace.dispose());
    for(const collection of ['spatial3d','map']){
      const record={...document(collection,`Unaligned ${collection}`),coordinateReference:{crs:recordCrs,verticalUnit:'m'}};await f.workspace.store.save(record);await f.action('select',record.id);await f.action('focus');
    }
    for(const mode of ['model','cloud','ortho','dsm','dtm'])await f.switchTo(mode);
    assert.equal(f.workspace.store.records.size,2);assert.equal(f.projected.length,0);assert.equal(f.focused.length,0);assert.equal(f.resolverCalls.length,0);assert.equal(f.svg().innerHTML,'');
    assert.match(f.list(),/Unaligned spatial3d/);assert.match(f.list(),/Unaligned map/);assert.match(f.list(),/coordinate|reference|alignment/i);
  }
});
