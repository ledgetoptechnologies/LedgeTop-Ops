import test from 'node:test';
import assert from 'node:assert/strict';
import {changeMeasurementVertex,measurementEditHandles} from '../measurement-document.mjs';
const square=()=>({kind:'polygon',vertices:[[0,0,1],[10,0,3],[10,10,5],[0,10,7]]});
test('midpoints preserve all three coordinates and closing edge ordering',()=>{
  const r=square(),vertices=changeMeasurementVertex(r,{type:'insert',index:3});
  assert.deepEqual(vertices[4],[0,5,4]);assert.equal(r.vertices.length,4);
  assert.deepEqual(changeMeasurementVertex(r,{type:'insert',index:0})[1],[5,0,2]);
});
test('delete selected and move reject invalid outlines without mutating original',()=>{
  const r=square(),snapshot=JSON.stringify(r);
  assert.deepEqual(changeMeasurementVertex(r,{type:'delete',index:1}),[r.vertices[0],r.vertices[2],r.vertices[3]]);
  assert.throws(()=>changeMeasurementVertex(r,{type:'move',index:1,point:[0,10,7]}));
  assert.throws(()=>changeMeasurementVertex({...r,vertices:r.vertices.slice(0,3)},{type:'delete',index:1}),/three points/);
  assert.equal(JSON.stringify(r),snapshot);
});
test('distance endpoints retain minimum and insertion never invents closing edge',()=>{
  const r={kind:'distance',vertices:[[0,0,0],[4,0,6]]};
  assert.throws(()=>changeMeasurementVertex(r,{type:'delete',index:0}),/two points/);
  assert.throws(()=>changeMeasurementVertex(r,{type:'insert',index:1}),/existing edge/);
  assert.deepEqual(changeMeasurementVertex(r,{type:'insert',index:0})[1],[2,0,3]);
});
test('edit handles skip invisible/short edges and place delete away from selected point',()=>{
  const r=square(),h=measurementEditHandles(r,[[100,100],[300,100],[300,300],[100,300]],0,800,600);
  assert.equal(h.midpoints.length,4);assert.deepEqual(h.midpoints[0],{index:0,x:200,y:100});
  assert.ok(h.deletion.x>=120);assert.ok(h.deletion.y+h.deletion.height<100);
  assert.equal(measurementEditHandles(r,[null,[10,10],[20,10],[10,20]],0,800,600).midpoints.length,0);
  assert.equal(measurementEditHandles({...r,vertices:r.vertices.slice(0,3)},[[0,0],[100,0],[0,100]],0,800,600).deletion,null);
});
