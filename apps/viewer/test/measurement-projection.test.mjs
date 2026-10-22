import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from 'three';
import {projectMeasurementBoundary} from '../measurement-projection.mjs';

const viewport={width:800,height:600};
const clip=(vertices,camera)=>vertices.map(p=>new THREE.Vector4(...p,1).applyMatrix4(camera.matrixWorldInverse).applyMatrix4(camera.projectionMatrix).toArray());
function perspective(){const camera=new THREE.PerspectiveCamera(60,800/600,.1,100);camera.updateMatrixWorld();return camera;}
function finiteScreen(result){for(const p of [...result.positions.filter(Boolean),...result.fill,...result.segments.flatMap(e=>[e.start,e.end])])assert.ok(p.every(Number.isFinite));}
function contains(polygon,[x,y]){let inside=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;}return inside;}

test('close zoom retains original foreground edges when other polygon corners cross behind the camera',()=>{
  const camera=perspective(),vertices=[[-.2,-.2,-1],[.2,-.2,-1],[.2,.2,1],[-.2,.2,1]],before=JSON.stringify(vertices);
  const result=projectMeasurementBoundary(clip(vertices,camera),viewport,{closed:true});
  assert.equal(result.positions.filter(Boolean).length,2);
  assert.ok(result.segments.some(edge=>edge.index===0&&edge.end[0]-edge.start[0]>200));
  assert.ok(!result.segments.some(edge=>edge.index===2),'fully behind original edge is omitted');
  assert.equal(result.segments.length,3,'only three original edges survive, never a clipping cap');
  assert.ok(result.fill.length>=3);finiteScreen(result);assert.equal(JSON.stringify(vertices),before);
  assert.equal(result.positions.some(p=>!p),true,'old whole-polygon visibility gate rejects this valid boundary');
});

test('two outside endpoints retain their original crossing edge and an open distance never closes',()=>{
  const result=projectMeasurementBoundary([[-2,0,0,1],[2,0,0,1]],viewport);
  assert.deepEqual(result.positions,[null,null]);assert.deepEqual(result.segments,[{index:0,start:[0,300],end:[800,300]}]);assert.deepEqual(result.fill,[]);
});

test('all behind or beyond the far plane remains hidden without mirrored vertices',()=>{
  const camera=perspective();
  for(const z of [1,101,-101]){
    const result=projectMeasurementBoundary(clip([[-1,-1,z],[1,-1,z],[1,1,z]],camera),viewport,{closed:true});
    assert.deepEqual(result.segments,[]);assert.deepEqual(result.fill,[]);assert.ok(result.positions.every(p=>p===null));
  }
});

test('viewport-enclosing polygon keeps its fill even when none of its original boundary edges is onscreen',()=>{
  const result=projectMeasurementBoundary([[-2,-2,0,1],[2,-2,0,1],[2,2,0,1],[-2,2,0,1]],viewport,{closed:true});
  assert.equal(result.segments.length,0);assert.ok(contains(result.fill,[400,300]));finiteScreen(result);
});

test('clipped concave fill retains disconnected islands without filling the gap or stroking the clipped bridge',()=>{
  const xy=[[-.9,-2],[.9,-2],[.9,.8],[.4,.8],[.4,-1.5],[-.4,-1.5],[-.4,.8],[-.9,.8]];
  const result=projectMeasurementBoundary(xy.map(p=>[...p,0,1]),viewport,{closed:true});
  assert.equal(contains(result.fill,[400,300]),false);
  assert.equal(contains(result.fill,[120,300]),true);assert.equal(contains(result.fill,[680,300]),true);
  assert.ok(result.segments.every(edge=>!(edge.start[1]===600&&edge.end[1]===600)),'no synthetic clip-plane connector');finiteScreen(result);
});

test('near-plane intersections, zero-length edges and very large projections remain finite',()=>{
  for(const vertices of [[[0,0,-1,1],[0,0,-1,1]],[[0,0,-2,1],[.5,0,0,1]],[[-1e12,0,0,1],[1e12,0,0,1]],[[0,0,0,0],[0,0,0,1]]])finiteScreen(projectMeasurementBoundary(vertices,viewport));
  assert.deepEqual(projectMeasurementBoundary([[NaN,0,0,1],[0,0,0,1]],viewport).segments,[]);
});

test('orthographic camera clipping and CSS viewport size do not depend on render-buffer DPR',()=>{
  const camera=new THREE.OrthographicCamera(-2,2,1.5,-1.5,.1,100);camera.updateMatrixWorld();
  const vertices=clip([[-3,0,-1],[3,0,-1]],camera),normal=projectMeasurementBoundary(vertices,viewport),half=projectMeasurementBoundary(vertices,{width:400,height:300});
  assert.deepEqual(normal.segments[0],{index:0,start:[0,300],end:[800,300]});assert.deepEqual(half.segments[0],{index:0,start:[0,150],end:[400,150]});
});

test('shipped 3D adapter uses homogeneous camera projection; map adapter remains unchanged',()=>{
  const source=readFileSync(new URL('../main.js',import.meta.url),'utf8'),start=source.indexOf('    projectBoundary(vertices,viewport,'),end=source.indexOf('    focus(vertices)',start);
  assert.ok(start>0&&end>start);const method=source.slice(start,end).trim().replace(/,$/,'');
  const camera=perspective(),project=new Function('THREE','cloud','activeCamera','element','utmToWorld','projectMeasurementBoundary',`return ({${method}}).projectBoundary`)(THREE,false,camera,{clientWidth:800,clientHeight:600},(...p)=>new THREE.Vector3(...p),projectMeasurementBoundary);
  const result=project([[-.2,-.2,-1],[.2,-.2,-1],[.2,.2,1],[-.2,.2,1]],viewport,{closed:true});assert.equal(result.segments.length,3);
  assert.match(source,/project\(p\) \{ const ll=utmToLatLon\(p\[0\],p\[1\]\),screen=map.latLngToContainerPoint\(ll\);return \[screen.x,screen.y\]; \}/);
});

test('shipped vertex hit-testing uses the same visibility as its original handle',()=>{
  const source=readFileSync(new URL('../main.js',import.meta.url),'utf8'),start=source.indexOf('    project(p,viewport){'),end=source.indexOf('    projectBoundary(',start),method=source.slice(start,end).trim().replace(/,$/,'');
  const camera=perspective(),project=new Function('THREE','cloud','activeCamera','element','utmToWorld','projectMeasurementBoundary',`return ({${method}}).project`)(THREE,false,camera,{clientWidth:800,clientHeight:600},(...p)=>new THREE.Vector3(...p),projectMeasurementBoundary);
  for(const point of [[0,0,-.05],[0,0,-101],[0,0,1],[10,0,-1]])assert.equal(project(point,viewport),null);
  assert.deepEqual(project([0,0,-1],viewport),[400,300]);
});
