import test from 'node:test';
import assert from 'node:assert/strict';
import {sidebarWidth,installSidebarResize} from '../viewer-sidebar-resize.mjs';
test('sidebar width keeps a usable model viewport and bounded navigation panel',()=>{
  assert.equal(sidebarWidth(500,1920),500);
  assert.equal(sidebarWidth(900,1920),720);
  assert.equal(sidebarWidth(700,1000),640);
  assert.equal(sidebarWidth(50,1920),240);
  assert.equal(sidebarWidth(NaN,1920),300);
});

function fixture(){
  const listeners=()=>{const entries=new Map();return{addEventListener:(type,fn)=>entries.set(type,fn),removeEventListener:(type,fn)=>{if(entries.get(type)===fn)entries.delete(type);},fire:(type,event={})=>entries.get(type)?.({preventDefault(){},...event}),count:()=>entries.size};};
  const values=new Map(),classes=new Set(),captures=new Set(),frames=new Map(),attributes=new Map();let next=0,notifications=0;
  const sidebar={style:{setProperty:(k,v)=>values.set(k,v),getPropertyValue:k=>values.get(k)||''},classList:{add:k=>classes.add(k),remove:k=>classes.delete(k),contains:k=>classes.has(k)},getBoundingClientRect:()=>({width:parseFloat(values.get('--sidebar-width'))||300})};
  const handle={...listeners(),setAttribute:(k,v)=>attributes.set(k,v),setPointerCapture:id=>captures.add(id),hasPointerCapture:id=>captures.has(id),releasePointerCapture:id=>captures.delete(id)};
  const view={...listeners(),innerWidth:1200,requestAnimationFrame:fn=>{frames.set(++next,fn);return next;},cancelAnimationFrame:id=>frames.delete(id)};
  const dispose=installSidebarResize({sidebar,handle,window:view,onResize:()=>notifications++});
  return{sidebar,handle,view,attributes,captures,classes,dispose,width:()=>parseFloat(values.get('--sidebar-width')),notifications:()=>notifications,flush(){const pending=[...frames.values()];frames.clear();for(const fn of pending)fn();}};
}
test('pointer ownership, clamping and resize notifications remain bounded',()=>{
  const f=fixture();f.flush();assert.equal(f.notifications(),1);
  f.handle.fire('pointerdown',{button:0,pointerId:4,clientX:300});assert.ok(f.captures.has(4));assert.ok(f.classes.has('resizing'));
  f.handle.fire('pointermove',{pointerId:8,clientX:900});assert.equal(f.width(),300);
  f.handle.fire('pointermove',{pointerId:4,clientX:400});f.handle.fire('pointermove',{pointerId:4,clientX:500});assert.equal(f.width(),500);assert.equal(f.notifications(),1);f.flush();assert.equal(f.notifications(),2);
  f.handle.fire('pointermove',{pointerId:4,clientX:10000});assert.equal(f.width(),720);
  f.handle.fire('pointerup',{pointerId:4});assert.equal(f.captures.size,0);assert.ok(!f.classes.has('resizing'));f.dispose();
});
test('keyboard and viewport resize respect bounds; collapsed panel ignores input',()=>{
  const f=fixture();f.handle.fire('keydown',{key:'ArrowRight'});assert.equal(f.width(),320);f.handle.fire('keydown',{key:'ArrowLeft'});assert.equal(f.width(),300);
  f.handle.fire('keydown',{key:'End'});assert.equal(f.width(),720);f.view.innerWidth=800;f.view.fire('resize');assert.equal(f.width(),440);assert.equal(f.attributes.get('aria-valuemax'),'440');
  f.view.innerWidth=390;f.view.fire('resize');assert.equal(f.width(),240);assert.equal(f.attributes.get('aria-valuenow'),'240');
  f.classes.add('collapsed');f.handle.fire('keydown',{key:'End'});f.handle.fire('pointerdown',{button:0,pointerId:1,clientX:240});assert.equal(f.width(),240);assert.equal(f.captures.size,0);f.dispose();
});
test('blur, capture loss, cancellation, collapse and disposal release drag state',()=>{
  for(const stop of ['blur','lostpointercapture','pointercancel','collapse','dispose']){
    const f=fixture();f.handle.fire('pointerdown',{button:0,pointerId:1,clientX:300});
    if(stop==='blur')f.view.fire('blur');else if(stop==='collapse'){f.classes.add('collapsed');f.handle.fire('pointermove',{pointerId:1,clientX:500});}else if(stop==='dispose')f.dispose();else f.handle.fire(stop,{pointerId:1});
    assert.equal(f.captures.size,0,stop);assert.ok(!f.classes.has('resizing'),stop);f.dispose();f.flush();assert.equal(f.notifications(),0,'disposed queued redraw never runs');assert.equal(f.handle.count(),0);assert.equal(f.view.count(),0);
  }
});
