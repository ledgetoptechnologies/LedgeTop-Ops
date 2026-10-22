import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {buildMeasurementPreview,disposeMeasurementPreviewObject,mountMeasurementRegionPreview} from '../measurement-region-preview.mjs';

test('surface preview keeps base patches and cut/fill colors while translating large coordinates before Float32',()=>{
  const preview={samples:[[400000.1234,4500000.5678,200.1234,200],[400000.1235,4500000.568,199.8,200]],referencePatches:[[[400000.1,4500000.5,200],[400001,4500000.5,200],[400001,4500001,200]]]};
  const built=buildMeasurementPreview(preview);
  assert.equal(built.kind,'surface');assert.equal(built.pointPositions.length,6);assert.equal(built.segments.length,12);assert.equal(built.referencePositions.length,9);
  assert.deepEqual(Array.from(built.pointPositions.slice(0,3)),[0,0,0]);
  assert.ok(Math.abs(built.pointPositions[3]-.0001)<1e-9);
  assert.ok(built.pointColors[0]>built.pointColors[2],'above base is orange');assert.ok(built.pointColors[5]>built.pointColors[3],'below base is blue');
  assert.equal(built.absoluteBounds.min[2],199.8);assert.equal(built.absoluteBounds.max[2],200.1234);
  assert.equal(preview.samples[0][0],400000.1234,'input data stays canonical and unchanged');
});

test('mesh preview bounds use selected faces and distinguish declared inferred geometry',()=>{
  const built=buildMeasurementPreview({vertices:[[400000,4500000,200],[400001,4500000,200],[400000,4500001,201],[999999,9999999,999]],triangles:[[0,1,2]],inferredFaces:[0]});
  assert.equal(built.kind,'mesh');assert.equal(built.inferred,true);assert.equal(built.meshPositions.length,9);
  assert.deepEqual(built.bounds,{min:[0,0,0],max:[1,1,1]});assert.ok(built.meshColors[0]>built.meshColors[1]);
  assert.equal(built.absoluteBounds.max[2],201,'unreferenced source vertices do not enlarge the region');
});

test('oversized invalid and arbitrary reference geometry is rejected rather than silently simplified',()=>{
  for(const value of [{},{samples:[[0,0,NaN,0]]},{samples:Array.from({length:20001},()=>[0,0,1,0])},{vertices:[[0,0,0]],triangles:[[0,1,2]]},{samples:[[0,0,1,0]],referencePatches:[[[0,0,0],[1,0,0],[1,1,0],[0,1,0]]]},{vertices:[[0,0,0],[1,0,0],[0,1,1]],triangles:[[0,1,2]],inferredFaces:[2]}])assert.throws(()=>buildMeasurementPreview(value),/preview|patches|geometry|region/i);
});

test('preview object disposal releases each shared geometry/material once',()=>{
  const group=new THREE.Group(),geometry=new THREE.BufferGeometry(),material=new THREE.MeshBasicMaterial();let geometries=0,materials=0;
  geometry.addEventListener('dispose',()=>geometries++);material.addEventListener('dispose',()=>materials++);
  group.add(new THREE.Mesh(geometry,material));group.add(new THREE.Mesh(geometry,[material]));
  disposeMeasurementPreviewObject(group);assert.equal(geometries,1);assert.equal(materials,1);
});

test('unavailable preview leaves an honest numerical-result fallback and disposes its own wrapper only',()=>{
  class Element{constructor(){this.children=[];this.style={};this.removed=false;this.textContent='';}append(...items){this.children.push(...items);}setAttribute(){}remove(){this.removed=true;}}
  const doc={createElement:()=>new Element(),defaultView:{}};const host=new Element();host.ownerDocument=doc;
  const mounted=mountMeasurementRegionPreview(host,{preview:null});
  assert.match(mounted.element.children[1].textContent,/preview unavailable/);assert.match(mounted.element.children[1].textContent,/Numerical results remain available/);
  mounted.dispose();mounted.dispose();assert.equal(mounted.element.removed,true);assert.equal(host.removed,false);
});
