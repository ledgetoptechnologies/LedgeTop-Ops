import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { BoxGeometry } from 'three';
import { validateClosedMesh, calculateClosedObj } from '../server/measurementMeshCalculation.mjs';
function box(offset=[0,0,0]) {const g=new BoxGeometry(2,3,4),p=g.attributes.position;return{vertices:Array.from({length:p.count},(_,i)=>[p.getX(i)+offset[0],p.getY(i)+offset[1],p.getZ(i)+offset[2]]),triangles:Array.from({length:g.index.count/3},(_,i)=>[g.index.getX(i*3),g.index.getX(i*3+1),g.index.getX(i*3+2)])};}
test('validated closed mesh measures original geometry, exact coincident welds and large coordinates',()=>{
  const result=validateClosedMesh(box([600000,4500000,200]));assert.equal(result.volumeM3,24);assert.equal(result.surfaceAreaM2,52);assert.equal(result.vertexCount,8);assert.equal(result.checks.selfIntersections,false);
  const reversed=box();reversed.triangles=reversed.triangles.map(t=>[t[2],t[1],t[0]]);assert.equal(validateClosedMesh(reversed).volumeM3,24);
});
test('open, degenerate, inconsistent, disconnected, and intersecting geometry never becomes a box estimate',()=>{
  const open=box();open.triangles.pop();assert.throws(()=>validateClosedMesh(open),{code:'measurement_mesh_not_closed_or_oriented'});
  const flipped=box();flipped.triangles[0].reverse();assert.throws(()=>validateClosedMesh(flipped),{code:'measurement_mesh_not_closed_or_oriented'});
  const duplicate=box();duplicate.triangles.push(duplicate.triangles[0]);assert.throws(()=>validateClosedMesh(duplicate),{code:'measurement_mesh_degenerate'});
  const a=box(),b=box([4,0,0]),offset=a.vertices.length;assert.throws(()=>validateClosedMesh({vertices:[...a.vertices,...b.vertices],triangles:[...a.triangles,...b.triangles.map(t=>t.map(v=>v+offset))]}),{code:'measurement_mesh_multiple_components'});
  // Move one corner through the opposite face while preserving topology.
  const crossed=validateClosedMesh(box());crossed.vertices[0]=[0,0,-5];assert.throws(()=>validateClosedMesh(crossed),{code:'measurement_mesh_self_intersection'});
});
test('bounded original OBJ selection uses connected seed component and rejects clipping that opens geometry',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-obj-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'source.obj'),mesh=box();
  const bytes=Buffer.from([...mesh.vertices.map(p=>`v ${p.join(' ')}`),...mesh.triangles.map(t=>`f ${t.map(i=>i+1).join(' ')}`)].join('\n'));fs.writeFileSync(file,bytes);
  const request={source:{id:'obj',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length},sourceCoordinateFrame:'projected',modelVersionId:'v1',vertices:[[-2,-2,0],[2,-2,0],[2,2,0],[-2,2,0]],selection:{seed:[0,0,2],minElevationM:-3,maxElevationM:3}};
  const result=await calculateClosedObj(file,request);assert.equal(result.volumeM3,24);assert.equal(result.calculationOrigin,'server-original-mesh');assert.equal(result.preview.previewOnly,false);
  await assert.rejects(calculateClosedObj(file,{...request,selection:{...request.selection,minElevationM:0}}),/measurement_mesh/);
});
