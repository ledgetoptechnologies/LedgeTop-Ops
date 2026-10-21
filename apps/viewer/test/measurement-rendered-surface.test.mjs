import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {resolveRenderedMeshBoundary,resolveRenderedPointBoundary,renderedPointNodeDescriptor} from '../measurement-rendered-surface.mjs';

const record=()=>({collection:'map',coordinateReference:{crs:'EPSG:32616'},vertices:[[100,200,0],[101,200,0],[100,201,0]],results:{status:'geometry-only'}});
const toWorld=(e,n,z)=>new THREE.Vector3(e-100,z-20,-(n-200));
const fromWorld=p=>({e:p.x+100,n:200-p.z,alt:p.y+20});
function mesh(y=2){const m=new THREE.Mesh(new THREE.PlaneGeometry(8,8),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));m.rotation.x=-Math.PI/2;m.position.y=y;m.updateWorldMatrix(true,true);return m;}
function node(points,{spacing=1,matrixWorld=new THREE.Matrix4().makeTranslation(100,200,20)}={}){const positions=new THREE.Float32BufferAttribute(points.flat(),3);return{positions,matrixWorld,spacing,bounds:new THREE.Box3().setFromBufferAttribute(positions).applyMatrix4(matrixWorld)};}

test('actual Potree descriptor does not double-apply untranslated node bounds',async()=>{
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,1,1,0,2,0,1,3],3));
 const nodeBounds=new THREE.Box3(new THREE.Vector3(10,20,0),new THREE.Vector3(12,22,4));geometry.boundingBox=nodeBounds.clone();
 const parent=new THREE.Group();parent.position.set(90,180,20);const sceneNode=new THREE.Points(geometry);sceneNode.position.copy(nodeBounds.min);parent.add(sceneNode);parent.updateMatrixWorld(true);
 const descriptor=renderedPointNodeDescriptor({sceneNode,geometryNode:{boundingBox:nodeBounds,spacing:1}});
 assert.deepEqual(descriptor.bounds.min.toArray(),[100,200,20]);assert.deepEqual(descriptor.bounds.max.toArray(),[102,202,24]);
 assert.deepEqual((await resolveRenderedPointBoundary({record:record(),expectedCrs:'EPSG:32616',nodes:[descriptor]})).vertices.map(p=>p[2]),[21,22,23]);
 sceneNode.visible=false;assert.equal(renderedPointNodeDescriptor({sceneNode}),null);
});

test('rendered mesh placement preserves map XY/results and uses complete canonical transform',async()=>{
 const r=record(),before=structuredClone(r),root=mesh(),worldBounds=new THREE.Box3().setFromObject(root);
 const result=await resolveRenderedMeshBoundary({record:r,expectedCrs:'EPSG:32616',roots:[root],worldBounds,toWorld,fromWorld,surfaceRevision:'mesh1'});
 assert.deepEqual(result.vertices,[[100,200,22],[101,200,22],[100,201,22]]);assert.deepEqual(r,before);assert.equal(result.renderedSurface,true);assert.equal(result.surfaceRevision,'mesh1');assert.match(result.basis,/display only/);
});
test('mesh placement excludes hidden children and picks the displayed upper surface',async()=>{
 const group=new THREE.Group(),low=mesh(1),high=mesh(3),hidden=mesh(8);hidden.visible=false;group.add(low,high,hidden);
 const args={record:record(),expectedCrs:'EPSG:32616',roots:[group],worldBounds:new THREE.Box3().setFromObject(group),toWorld,fromWorld};
 assert.equal((await resolveRenderedMeshBoundary(args)).vertices[0][2],23);
 high.visible=false;assert.equal((await resolveRenderedMeshBoundary({...args,surfaceRevision:'changed'})).vertices[0][2],21);
 group.visible=false;await assert.rejects(resolveRenderedMeshBoundary(args),{code:'measurement_display_surface_pending'});
});
test('mesh gaps and coordinate mismatch never produce a zero-height substitute',async()=>{
 const root=mesh(),r=record();r.vertices[0][0]=1000;
 await assert.rejects(resolveRenderedMeshBoundary({record:r,expectedCrs:'EPSG:32616',roots:[root],worldBounds:new THREE.Box3().setFromObject(root),toWorld,fromWorld}),{code:'measurement_display_surface_pending'});
 await assert.rejects(resolveRenderedMeshBoundary({record:record(),expectedCrs:'EPSG:32617'}),{code:'measurement_display_reference_mismatch'});
});

test('visible fine child supersedes higher coarse ancestor while unrelated upper surfaces remain',async()=>{
 const parent={},child={parent},coarse=mesh(8),fine=mesh(2),bounds=new THREE.Box3().setFromObject(coarse).union(new THREE.Box3().setFromObject(fine));
 const args={record:record(),expectedCrs:'EPSG:32616',roots:[{root:coarse,tile:parent},{root:fine,tile:child}],worldBounds:bounds,toWorld,fromWorld};
 assert.equal((await resolveRenderedMeshBoundary(args)).vertices[0][2],22);
 args.roots[1].tile={};assert.equal((await resolveRenderedMeshBoundary(args)).vertices[0][2],28);
});
test('resident cloud lookup transforms coordinates and favors locally finer detail without changing source',async()=>{
 const r=record(),before=structuredClone(r),coarse=node([[0,0,1],[1,0,2],[0,1,3]],{spacing:1}),fine=node([[0,0,4],[1,0,5],[0,1,6]],{spacing:.1});
 const first=await resolveRenderedPointBoundary({record:r,expectedCrs:'EPSG:32616',nodes:[coarse],surfaceRevision:'coarse'});
 const refined=await resolveRenderedPointBoundary({record:r,expectedCrs:'EPSG:32616',nodes:[coarse,fine],surfaceRevision:'fine'});
 assert.deepEqual(first.vertices.map(p=>p[2]),[21,22,23]);assert.deepEqual(refined.vertices.map(p=>p[2]),[24,25,26]);assert.deepEqual(r,before);assert.match(refined.basis,/approximate/);
});
test('cloud coverage refuses wide gaps and ignores unrelated nodes',async()=>{
 const r=record(),far=node([[100,100,4]],{spacing:.1});
 await assert.rejects(resolveRenderedPointBoundary({record:r,expectedCrs:'EPSG:32616',nodes:[far]}),{code:'measurement_display_surface_pending'});
 await assert.rejects(resolveRenderedPointBoundary({record:r,expectedCrs:'EPSG:32616',nodes:[node([[0,0,4]],{spacing:.1})]}),{code:'measurement_display_surface_pending'});
});
test('large resident node scanning yields in bounded batches and aborts before returning stale data',async()=>{
 const points=new Float32Array(50000*3),positions=new THREE.BufferAttribute(points,3),n={positions,matrixWorld:new THREE.Matrix4().makeTranslation(100,200,20),spacing:1,bounds:new THREE.Box3(new THREE.Vector3(100,200,20),new THREE.Vector3(101,201,20))};
 const controller=new AbortController();let yields=0;
 await assert.rejects(resolveRenderedPointBoundary({record:record(),expectedCrs:'EPSG:32616',nodes:[n],signal:controller.signal,yieldControl:async()=>{yields++;controller.abort();}}),{name:'AbortError'});
 assert.equal(yields,1);
});

test('unchanged resident nodes reuse bounded lookup across polygons and LOD revisions',async()=>{
 const n=node([[0,0,1],[1,0,2],[0,1,3]]);let reads=0;const getX=n.positions.getX.bind(n.positions);n.positions.getX=i=>{reads++;return getX(i);};
 const args={record:record(),expectedCrs:'EPSG:32616',nodes:[n]};
 await resolveRenderedPointBoundary({...args,surfaceRevision:'first'});assert.equal(reads,3);
 await resolveRenderedPointBoundary({...args,record:{...record(),name:'another polygon'},surfaceRevision:'other-frontier'});assert.equal(reads,3,'frontier changes reuse unchanged geometry');
 n.matrixWorld.elements[14]++;await resolveRenderedPointBoundary(args);assert.equal(reads,6,'changed transform rebuilds placement');
});

test('oversized coarse index is skipped and remembered while fine coverage still resolves',async()=>{
 const array=new Float32Array(262145*3);for(let i=0;i<262145;i++)array[i*3]=i;
 const positions=new THREE.BufferAttribute(array,3);let reads=0;const getX=positions.getX.bind(positions);positions.getX=i=>{reads++;return getX(i);};
 const coarse={positions,matrixWorld:new THREE.Matrix4().makeTranslation(100,200,20),spacing:1,bounds:new THREE.Box3(new THREE.Vector3(100,200,20),new THREE.Vector3(262245,201,20))},fine=node([[0,0,4],[1,0,5],[0,1,6]],{spacing:.1});
 const args={record:record(),expectedCrs:'EPSG:32616',nodes:[coarse,fine],yieldControl:async()=>{}};
 assert.deepEqual((await resolveRenderedPointBoundary(args)).vertices.map(p=>p[2]),[24,25,26]);const initial=reads;
 await resolveRenderedPointBoundary(args);assert.equal(reads,initial,'unchanged overcapacity node is not rescanned');
});

test('parallel polygons share one in-flight resident node index',async()=>{
 const positions=new THREE.BufferAttribute(new Float32Array(17000*3),3);let reads=0;const getX=positions.getX.bind(positions);positions.getX=i=>{reads++;return getX(i);};
 const n={positions,matrixWorld:new THREE.Matrix4().makeTranslation(100,200,20),spacing:1,bounds:new THREE.Box3(new THREE.Vector3(100,200,20),new THREE.Vector3(101,201,20))};
 let release;const wait=new Promise(resolve=>{release=resolve;}),args={record:record(),expectedCrs:'EPSG:32616',nodes:[n],yieldControl:()=>wait};
 const first=resolveRenderedPointBoundary(args),second=resolveRenderedPointBoundary(args);release();await Promise.all([first,second]);assert.equal(reads,17000);
});
