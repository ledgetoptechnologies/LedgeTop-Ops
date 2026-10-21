import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { prepareOrientedPoints, pointTree, parsePoissonPly, reconstructPoints, reconstructSelectedEpt, validateReconstructionBounds } from '../server/measurementReconstruction.mjs';
const sphere=(count=1000)=>Array.from({length:count},(_,i)=>{const z=1-2*(i+.5)/count,r=Math.sqrt(1-z*z),angle=i*Math.PI*(3-Math.sqrt(5));return[367000+r*Math.cos(angle),4759000+r*Math.sin(angle),100+z];});
test('PCA normals and seeded connected samples are stable at projected coordinates',()=>{
 const points=sphere(),oriented=prepareOrientedPoints(points,{seed:points[0],normalRadiusM:.4});
 assert.equal(oriented.selectedPointCount,1000);
 for(let i=0;i<oriented.points.length;i++)assert.ok(oriented.points[i].reduce((sum,x,k)=>sum+x*oriented.normals[i][k],0)>.98);
 const tree=pointTree([[0,0,0],[2,0,0],[1,0,0]]);assert.deepEqual(tree.nearest([.9,0,0],2).map(p=>p.index),[2,0]);
 assert.throws(()=>prepareOrientedPoints(Array.from({length:100},(_,i)=>[i,0,0]),{seed:[0,0,0],normalRadiusM:10}),/unstable/);
});
test('original EPT to explicit reconstructed estimate uses every source point',{skip:!process.env.MEASUREMENT_POISSON_BIN},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-reconstruction-source-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
 const points=sphere(2500),files=[],write=(relative,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(root,relative),bytes);const d={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};files.push(d);return d;};
 const manifest=write('ept.json',{bounds:[366998,4758998,98,367002,4759002,102],dataType:'binary',srs:{horizontal:'32616'},schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});
 write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':points.length});const data=Buffer.alloc(points.length*24);points.forEach((p,i)=>p.forEach((v,k)=>data.writeDoubleLE(v,i*24+k*8)));write('ept-data/0-0-0-0.bin',data);
 const result=await reconstructSelectedEpt(path.join(root,'ept.json'),{vertices:[[366998,4758998,0],[367002,4758998,0],[367002,4759002,0],[366998,4759002,0]],source:{id:'sphere',...manifest},modelVersionId:'v',coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',selection:{seed:points[0],minElevationM:98,maxElevationM:102},reconstruction:{depth:6,normalRadiusM:.3,supportDistanceM:.08,acknowledgeInferredGeometry:true}},{sourceFiles:files});
 assert.equal(result.source.pointsRead,2500);assert.ok(Math.abs(result.volumeM3-4*Math.PI/3)<.2);assert.equal(result.preview.inferred,true);
});
test('Poisson parser rejects unsupported formats and malformed faces',()=>{
 assert.throws(()=>parsePoissonPly('ply\nformat binary_little_endian 1.0\nend_header'),/invalid/);
 assert.throws(()=>parsePoissonPly('ply\nformat ascii 1.0\nelement vertex 999999\nend_header'),/limit/);
});
test('inferred geometry crossing height or concave selection bounds is rejected without clipping',()=>{
 const request={vertices:[[0,0,0],[3,0,0],[3,3,0],[2,3,0],[2,1,0],[1,1,0],[1,3,0],[0,3,0]],selection:{minElevationM:0,maxElevationM:2}};
 assert.throws(()=>validateReconstructionBounds({vertices:[[.5,2,1],[2.5,2,1],[.5,.5,1]],triangles:[[0,1,2]]},request),{code:'measurement_reconstruction_outside_selection'});
 assert.throws(()=>validateReconstructionBounds({vertices:[[.5,.5,3],[.8,.5,1],[.5,.8,1]],triangles:[[0,1,2]]},request),{code:'measurement_reconstruction_outside_selection'});
 assert.doesNotThrow(()=>validateReconstructionBounds({vertices:[[0,0,0],[1,0,1],[0,1,2]],triangles:[[0,1,2]]},request));
});
test('native inferred sphere estimate is closed, bounded, and explicitly labelled',{skip:!process.env.MEASUREMENT_POISSON_BIN},async()=>{
 const points=sphere(2500),result=await reconstructPoints(points,{source:{id:'sphere',sha256:'synthetic'},modelVersionId:'v',vertices:[[366998,4758998,0],[367002,4758998,0],[367002,4759002,0],[366998,4759002,0]],selection:{seed:points[0],minElevationM:98,maxElevationM:102},reconstruction:{depth:6,normalRadiusM:.3,supportDistanceM:.08,acknowledgeInferredGeometry:true}});
 assert.equal(result.status,'estimate');assert.ok(Math.abs(result.volumeM3-4*Math.PI/3)<.2,JSON.stringify(result));
 assert.equal(result.preview.inferred,true);assert.ok(result.warnings.some(w=>w.includes('Every reconstructed face')));
});
