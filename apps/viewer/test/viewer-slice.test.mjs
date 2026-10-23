import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {readFileSync} from 'node:fs';
import {createViewerSlice,slicePlane} from '../viewer-slice.mjs';
import {pickDirectPointSurface} from '../direct-pointcloud-picking.mjs';

function fixture(){
  const fields=new Map(),panel={querySelector(selector){if(!fields.has(selector))fields.set(selector,{disabled:false,value:'',addEventListener(){},setAttribute(){}});return fields.get(selector);}};
  const scene=new THREE.Scene(),data=new THREE.Group(),material=new THREE.MeshBasicMaterial(),mesh=new THREE.Mesh(new THREE.BoxGeometry(2,2,2),material);
  data.add(mesh);scene.add(data);
  let available=true;
  const slice=createViewerSlice({renderer:{},scene,panel,getRoots:()=>[data],getBounds:()=>new THREE.Box3(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1)),supported:()=>available});
  return{slice,scene,data,mesh,material,fields,setAvailable:value=>{available=value;}};
}

test('axis planes retain higher canonical E/N/elevation coordinates and flip exactly',()=>{
  const bounds=new THREE.Box3(new THREE.Vector3(-10,-20,-30),new THREE.Vector3(10,20,30));
  for(const [axis,point]of [['easting',[1,0,0]],['elevation',[0,1,0]],['northing',[0,0,-1]]]){
    const plane=slicePlane(bounds,{axis});assert.equal(plane.distanceToPoint(new THREE.Vector3(...point)),1);
    assert.equal(slicePlane(bounds,{axis,flipped:true}).distanceToPoint(new THREE.Vector3(...point)),-1);
  }
  assert.equal(slicePlane(bounds,{axis:'elevation',fraction:.75}).constant,-10);
  assert.equal(slicePlane(bounds,{axis:'northing',fraction:1}).constant,-30);
  assert.throws(()=>slicePlane(bounds,{fraction:NaN}),/finite/);
});

test('default is full surface; only data materials clip, streaming arrivals share plane, reset restores original material state',()=>{
  const f=fixture(),original=new THREE.Plane(new THREE.Vector3(1,0,0),3);f.material.clippingPlanes=[original];
  f.slice.set({enabled:true});assert.equal(f.slice.active,true);assert.equal(f.material.clippingPlanes.length,2);
  const second=new THREE.Points(new THREE.BufferGeometry(),new THREE.PointsMaterial());f.data.add(second);f.slice.register(second);
  assert.equal(second.material.clippingPlanes.at(-1),f.material.clippingPlanes.at(-1));
  f.slice.set({fraction:.75});assert.equal(f.material.clippingPlanes.at(-1).constant,-.5);
  const guide=f.scene.children.find(object=>object instanceof THREE.PlaneHelper);assert.equal(guide.visible,true);assert.equal(guide.material.clippingPlanes,null);
  assert.equal(f.slice.accepts(new THREE.Vector3(0,0,0)),false);assert.equal(f.slice.accepts(new THREE.Vector3(0,1,0)),true);
  f.slice.reset();assert.deepEqual(f.material.clippingPlanes,[original]);assert.equal(second.material.clippingPlanes,null);assert.equal(guide.visible,false);assert.equal(f.slice.active,false);
  f.slice.dispose();
});

test('unsupported views disable slicing and restore complete data without changing geometry',()=>{
  const f=fixture(),before=f.mesh.geometry.getAttribute('position').array.slice();f.slice.set({enabled:true});f.setAvailable(false);f.slice.refresh();
  assert.equal(f.slice.active,false);assert.equal(f.material.clippingPlanes,null);assert.deepEqual(f.mesh.geometry.getAttribute('position').array,before);
  assert.equal(f.fields.get('[data-slice="enabled"]').disabled,true);assert.match(f.fields.get('[data-slice="status"]').textContent,/not available/);f.slice.dispose();
});

test('direct point selection excludes a hidden source vertex even when its ray projection lies in retained half-space',()=>{
  const points=new THREE.Points(new THREE.BufferGeometry().setAttribute('position',new THREE.Float32BufferAttribute([-.01,0,0,.01,0,-1],3)),new THREE.PointsMaterial());
  points.updateMatrixWorld(true);
  const camera=new THREE.PerspectiveCamera(60,1,.1,100);camera.position.set(0,0,10);camera.updateMatrixWorld();
  const seen=[],raycaster=new THREE.Raycaster();
  const result=pickDirectPointSurface({raycaster,camera,points,ndc:new THREE.Vector2(),viewportHeight:600,accepts:point=>{seen.push(point.x);return point.x>0;}});
  assert.equal(result.z,-1);assert.ok(seen.some(x=>x<0));assert.ok(seen.some(x=>x>0));
  assert.equal(pickDirectPointSurface({raycaster,camera,points,ndc:new THREE.Vector2(),viewportHeight:600,accepts:()=>false}),null);
});

test('production connects streaming arrivals and slicing lifecycle; mesh picks traverse beyond clipped nearest BVH hits',()=>{
  const source=readFileSync(new URL('../main.js',import.meta.url),'utf8');
  assert.match(source,/viewerSlice\?\.register\(ev.scene\)/);
  assert.match(source,/const prevMode = state.activeMode;\s+viewerSlice\?\.reset\(\)/);
  assert.match(source,/if\(next==='unavailable'\)viewerSlice\?\.reset\(\)/);
  assert.match(source,/if\(viewerSlice\?\.active\)raycaster.firstHitOnly=false/);
  assert.match(source,/finally\{raycaster.firstHitOnly=firstHitOnly;\}/);
});
