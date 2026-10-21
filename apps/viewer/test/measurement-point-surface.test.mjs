import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { calculatePointSurface, pointSurfaceGrid, preflightPointSurface } from '../server/measurementPointSurface.mjs';
import {calculatePointSurfaceTransect} from '../server/measurementPointTransect.mjs';
import {traceRasterCells,frozenReferenceIntervals} from '../server/measurementRasterTransect.mjs';
import {childCalculation} from '../server/measurementCalculationWorker.js';
import unitRegistry from '../server/measurementSourceUnitEvidence.js';
function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-point-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
  const files=[],write=(relative,bytes)=>{bytes=Buffer.isBuffer(bytes)?bytes:Buffer.from(JSON.stringify(bytes));fs.writeFileSync(path.join(root,relative),bytes);const file={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};files.push(file);return file;};
  const data=points=>{const bytes=Buffer.alloc(points.length*25);points.forEach(([x,y,z,classification],i)=>{bytes.writeDoubleLE(x,i*25);bytes.writeDoubleLE(y,i*25+8);bytes.writeDoubleLE(z,i*25+16);bytes[i*25+24]=classification;});return bytes;};
  const manifest=write('ept.json',{bounds:[0,0,0,4,4,4],dataType:'binary',srs:{horizontal:'32616'},schema:[{name:'X',type:'floating',size:8},{name:'Y',type:'floating',size:8},{name:'Z',type:'floating',size:8},{name:'Classification',type:'unsigned',size:1}]});
  write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':2,'1-0-0-0':-1});write('ept-hierarchy/1-0-0-0.json',{'1-0-0-0':2});
  write('ept-data/0-0-0-0.bin',data([[.5,.5,1,2],[1.5,.5,2,6]]));write('ept-data/1-0-0-0.bin',data([[.5,1.5,3,2],[1.5,1.5,4,2]]));
  const request={vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0},coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',cellSizeM:1,source:{id:'ept',byteSize:manifest.byteSize,sha256:manifest.sha256,manifestSha256:'b'.repeat(64)},modelVersionId:'v1'};
  return{root,files,request,write};
}

test('source-bound staff evidence permits untagged point preflight without a client assertion',async t=>{
  const f=fixture(t),request={...f.request,modelId:'model',sourceVerticalUnit:null,source:{...f.request.source,kind:'ept'},requireEncodedVerticalUnits:true};
  request.sourceUnitEvidence={schemaVersion:1,...unitRegistry.sourceBinding(request),verticalUnit:'m',verticalDatum:'unknown',basis:'administrator-reviewed-source'};
  const result=await preflightPointSurface(path.join(f.root,'ept.json'),request,{requireEncodedVerticalUnits:true});
  assert.equal(result.vertical.verticalFactor,1);
  assert.equal(result.vertical.verticalUnitBasis,'administrator-reviewed-source');
  assert.equal(result.vertical.verticalDatum,'unknown');
  for(const change of [{modelVersionId:'changed'},{modelId:'changed'},{sourceUnitEvidence:{...request.sourceUnitEvidence,manifestSha256:'c'.repeat(64)}}]){
    await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...request,...change},{requireEncodedVerticalUnits:true}),{code:'measurement_source_vertical_units_required'});
  }
});

test('staff evidence and metre confirmation cannot bypass an unvalidated encoded vertical CRS',async t=>{
  const f=fixture(t),file=path.join(f.root,'ept.json'),header=JSON.parse(fs.readFileSync(file,'utf8'));
  header.srs.vertical='6360';
  const identity=f.write('ept.json',header);
  const request={...f.request,modelId:'model',source:{...f.request.source,kind:'ept',sha256:identity.sha256,byteSize:identity.byteSize}};
  for(const reviewed of [false,true]){
    const input={...request,...(reviewed?{sourceUnitEvidence:{schemaVersion:1,...unitRegistry.sourceBinding(request),verticalUnit:'m',verticalDatum:'unknown',basis:'administrator-reviewed-source'}}:{})};
    await assert.rejects(preflightPointSurface(file,input),{code:'measurement_source_vertical_units_unsupported'});
  }
});

test('receipt-bound EPT units preserve feet through preflight and calculation',async t=>{
  const f=fixture(t),request={...f.request,modelId:'model',sourceVerticalUnit:null,source:{...f.request.source,kind:'ept'}};
  request.sourceUnitEvidence={schemaVersion:1,...unitRegistry.sourceBinding(request),verticalUnit:'ft',verticalFactor:.3048,verticalDatum:'unknown',basis:'server-verified-ept-conversion',conversionProof:{jobId:'job',receiptSha256:'c'.repeat(64),inputProofSha256:'d'.repeat(64)}};
  const preflight=await preflightPointSurface(path.join(f.root,'ept.json'),request,{requireEncodedVerticalUnits:true});
  assert.equal(preflight.vertical.verticalFactor,.3048);
  assert.equal(preflight.vertical.verticalUnitBasis,'server-verified-ept-conversion');
  const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files,requireEncodedVerticalUnits:true});
  assert.ok(Math.abs(result.cutM3-10*.3048)<1e-10);
  assert.equal(result.source.verticalUnitEvidence.verticalUnit,'ft');
  assert.equal(result.source.verticalUnitEvidence.conversionProof,undefined,'private receipt details not exported');
  for(const change of [{conversionProof:null},{verticalFactor:1},{manifestSha256:'e'.repeat(64)},{kind:'dsm'}]){
    await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...request,sourceUnitEvidence:{...request.sourceUnitEvidence,...change}},{requireEncodedVerticalUnits:true}),{code:'measurement_source_vertical_units_required'});
  }
});

test('exact point grid survives independent volume/section calls with verified reads and identical output',async t=>{
  const f=fixture(t),pointGridCacheRoot=path.join(f.root,'cache'),source={...f.request.source,kind:'ept'},request={...f.request,source},timings=[];
  const options={sourceFiles:f.files,pointGridCacheRoot,onTiming:value=>timings.push(value)};
  const cold=await calculatePointSurface(path.join(f.root,'ept.json'),request,options);
  const warm=await calculatePointSurface(path.join(f.root,'ept.json'),request,options);
  assert.deepEqual(warm,cold);assert.equal(timings[0].cacheHit,false);assert.equal(timings[1].cacheHit,true);assert.equal(timings[1].decodeGridMs,0);assert.equal(timings[1].nodesRead,2);
  const referencePatches=cold.preview.referencePatches,section={...request,method:'surface-transect',parentCalculationId:'parent',samplingGrid:cold.source.samplingGrid,referencePatches,baseHash:crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex'),line:{start:[0,.5],end:[2,.5]}};
  const cached=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),section,options);
  assert.equal(timings.findLast(value=>value.phase==='point-surface').cacheHit,true,'volume grid is reusable without preview subsampling');
  assert.equal(timings.at(-1).phase,'point-transect');assert.ok(timings.at(-1).sampleMs>=0);
  const fresh=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),section,{sourceFiles:f.files});
  assert.deepEqual(cached,fresh);
  // Same-size edits cannot hide behind timestamps or a valid cache header.
  const node=path.join(f.root,'ept-data/0-0-0-0.bin'),before=fs.statSync(node);fs.writeFileSync(node,Buffer.alloc(before.size));fs.utimesSync(node,before.atime,before.mtime);
  await assert.rejects(calculatePointSurfaceTransect(path.join(f.root,'ept.json'),section,options),{code:'measurement_source_changed'});
});

test('point grid cache keys isolate source version manifest polygon units class and cell resolution',async t=>{
  const f=fixture(t),timings=[],options={sourceFiles:f.files,pointGridCacheRoot:path.join(f.root,'cache'),onTiming:x=>timings.push(x)};
  await calculatePointSurface(path.join(f.root,'ept.json'),f.request,options);
  for(const change of [{modelVersionId:'v2'},{source:{...f.request.source,manifestSha256:'c'.repeat(64)}},{vertices:[[0,0,0],[1,0,0],[1,2,0],[0,2,0]]},{cellSizeM:.5},{classFilter:'ground'}]){
    await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,...change},options);assert.equal(timings.at(-1).cacheHit,false);
  }
  await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,sourceVerticalUnit:null},options),{code:'measurement_source_vertical_units_required'});
  await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,requireEncodedVerticalUnits:true},options),{code:'measurement_source_vertical_units_required'});
  await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),f.request,{...options,maxCells:1}),{code:'measurement_limit'});
});

test('corrupt or unavailable disk grid cache falls back and collected reconstruction points bypass it',async t=>{
  const f=fixture(t),pointGridCacheRoot=path.join(f.root,'cache'),timings=[],options={sourceFiles:f.files,pointGridCacheRoot,onTiming:x=>timings.push(x)};
  const cold=await calculatePointSurface(path.join(f.root,'ept.json'),f.request,options);
  for(const file of fs.readdirSync(pointGridCacheRoot))fs.writeFileSync(path.join(pointGridCacheRoot,file),'bad');
  assert.deepEqual(await calculatePointSurface(path.join(f.root,'ept.json'),f.request,options),cold);assert.equal(timings.at(-1).cacheHit,false);
  const selected=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,selection:{minElevationM:1.5,maxElevationM:3.5}},{...options,collectOnly:true});
  assert.deepEqual(selected.points,[[1.5,.5,2],[.5,1.5,3]]);assert.equal(timings.at(-1).cacheHit,false);
  const unavailable=path.join(f.root,'file-not-directory');fs.writeFileSync(unavailable,'x');
  assert.deepEqual(await calculatePointSurface(path.join(f.root,'ept.json'),f.request,{...options,pointGridCacheRoot:unavailable}),cold);
});

test('separate bounded child jobs reuse worker-owned point grid and preserve full results',async t=>{
  const f=fixture(t),timings=[],config={cacheMount:path.join(f.root,'worker-cache'),measurementTimeoutMs:10000},options={config,isLive:()=>true,sourceFiles:f.files,onTiming:x=>timings.push(x)},request={...f.request,method:'point-surface-cut-fill',source:{...f.request.source,kind:'ept'}};
  const first=await childCalculation(path.join(f.root,'ept.json'),request,options);
  const cacheRoot=path.join(config.cacheMount,'measurement-point-surfaces-v1'),files=fs.readdirSync(cacheRoot);
  assert.equal(files.length,1);
  const entry=path.join(cacheRoot,files[0]);fs.utimesSync(entry,1000,1000);const timestamp=fs.statSync(entry).mtimeMs;
  const second=await childCalculation(path.join(f.root,'ept.json'),request,options);
  assert.deepEqual(second,first);assert.equal(fs.statSync(entry).mtimeMs,timestamp,'second process hit does not rebuild/rewrite grid');
  assert.deepEqual(timings.map(x=>x.phase),['point-surface','child','point-surface','child']);assert.equal(timings[2].cacheHit,true);assert.equal(timings[2].decodeGridMs,0);assert.ok(timings[2].verifiedReadMs>=0);
  assert.ok(timings.every(x=>JSON.stringify(x).length<512));assert.doesNotMatch(JSON.stringify(timings),/worker-cache|authority|vertices/);
});

test('UTM point sections omit only collapsed metric contacts and preserve continuous positive station coverage',async t=>{
  const f=fixture(t),poly=[[500018.4621418826,4870020.323978993,0],[500094.7803548956,4870021.415496769,0],[500099.24383717007,4870047.501313193,0],[500018.4621418826,4870047.501313193,0]];
  f.files.length=0;
  const header=f.write('ept.json',{bounds:[500010,4870010,0,500110,4870060,10],dataType:'binary',srs:{horizontal:'32616'},schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});
  f.write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':1});const bytes=Buffer.alloc(24);[500050,4870030,5].forEach((v,i)=>bytes.writeDoubleLE(v,i*8));f.write('ept-data/0-0-0-0.bin',bytes);
  const grid=pointSurfaceGrid(poly,.1),samplingGrid={version:1,width:grid.width,height:grid.height,bounds:grid.bounds,cellSizeM:.1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'};
  const referencePatches=[[poly[0],poly[1],poly[2]],[poly[0],poly[2],poly[3]]],request={...f.request,vertices:poly,cellSizeM:.1,source:{id:'ept',kind:'ept',sha256:header.sha256,byteSize:header.byteSize,manifestSha256:'b'.repeat(64)},method:'surface-transect',parentCalculationId:'parent',samplingGrid,referencePatches,baseHash:crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex')};
  let random=12345;const rand=()=>((random=Math.imul(random,1664525)+1013904223>>>0)/4294967296);
  const lines=[{start:[500017.4621418826,4870042.137615444],end:[500099.7803548956,4870043.802819616]},...Array.from({length:30},()=>({start:[500010+rand()*100,4870010+rand()*50],end:[500010+rand()*100,4870010+rand()*50]}))];
  let collapsed=0;
  for(const line of lines){
    const cells=traceRasterCells(line,{ox:grid.bounds.minE,oy:grid.bounds.maxN,dx:.1,dy:-.1,width:grid.width,height:grid.height}),patches=frozenReferenceIntervals(line,referencePatches),length=Math.hypot(...line.end.map((v,i)=>v-line.start[i]));
    const breaks=[...new Set([0,1,...cells.flatMap(c=>[c.startT,c.endT]),...patches.flatMap(p=>[p.startT,p.endT])])].sort((a,b)=>a-b);
    const positive=[];for(let i=1;i<breaks.length;i++){const start=breaks[i-1]*length,end=breaks[i]*length;if(start===end)collapsed++;else positive.push([start,end]);}
    const result=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,line},{sourceFiles:f.files});
    // This test also runs inside the server-only production image. Assert its
    // numerical contract independently; client validation/recovery is covered
    // by measurement-server-profile without importing browser code here.
    for(const segment of result.segments){
      assert.ok(['sample','nodata','outside-surface','outside-selection'].includes(segment.status));
      assert.ok(Number.isFinite(segment.startM)&&Number.isFinite(segment.endM)&&segment.endM>segment.startM);
      for(const [key,station]of [['start',segment.startM],['end',segment.endM]])for(let axis=0;axis<2;axis++)assert.ok(Math.abs(segment[key][axis]-(line.start[axis]+(line.end[axis]-line.start[axis])*station/length))<=1e-6);
      if(segment.status==='sample')assert.ok([segment.surfaceM,segment.baseStartM,segment.baseEndM].every(Number.isFinite));
    }
    assert.deepEqual(result.segments.map(s=>[s.startM,s.endM]),positive,'no positive station interval is merged or dropped');
    assert.equal(result.segments[0].startM,0);assert.equal(result.segments.at(-1).endM,length);
    for(let i=1;i<result.segments.length;i++)assert.equal(result.segments[i].startM,result.segments[i-1].endM);
    assert.ok(result.segments.some(s=>s.status!=='sample'),'missing cells/outside intervals remain explicit');
  }
  assert.ok(collapsed>0,'regression actually exercises parameter breakpoints that collapse after metric conversion');
});
test('point surface reads every intersecting hierarchy level at full point count',async t=>{
  const f=fixture(t),result=await calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files});
  assert.equal(result.cutM3,10);assert.equal(result.coverage,1);assert.equal(result.source.pointsRead,4);assert.equal(result.source.nodesRead,2);assert.equal(result.source.allIntersectingHierarchyLevels,true);
  const ground=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,classFilter:'ground'},{sourceFiles:f.files});assert.equal(ground.cutM3,8);assert.equal(ground.coverage,.75);assert.equal(ground.status,'incomplete');
});
test('point result identifies its source and exact sampling policy without claiming verified height units',async t=>{
  const f=fixture(t),request={...f.request,method:'point-surface-cut-fill',source:{...f.request.source,kind:'ept'}};
  const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
  assert.equal(result.method,request.method);
  assert.equal(result.source.kind,'ept');
  assert.equal(result.source.manifestSha256,request.source.manifestSha256);
  assert.equal(result.source.verticalUnitBasis,'administrator-declared');
  assert.deepEqual(result.source.samplingGrid,{version:1,width:2,height:2,bounds:{minE:0,minN:0,maxE:2,maxN:2},cellSizeM:1,rowOrder:'north-to-south',reduction:'maximum-z',emptyCells:'missing'});
  assert.equal(result.preview.previewOnly,true);
  assert.equal(result.cutM3,10);
  await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...request,sourceVerticalUnit:undefined},{sourceFiles:f.files}),{code:'measurement_source_vertical_units_required'});
});
test('point surface missing or changed node fails instead of reporting partial full-resolution success',async t=>{
  const f=fixture(t);await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files.filter(file=>!file.relativePath.endsWith('1-0-0-0.bin'))}),{code:'measurement_ept_file_unavailable'});
  fs.writeFileSync(path.join(f.root,'ept-data/1-0-0-0.bin'),Buffer.alloc(50));await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),f.request,{sourceFiles:f.files}),{code:'measurement_source_changed'});
});
test('point preflight verifies metadata before hierarchy or point reads',async t=>{
  const f=fixture(t);
  // Metadata preflight must not perform the expensive source-node traversal.
  fs.unlinkSync(path.join(f.root,'ept-data/0-0-0-0.bin'));
  const result=await preflightPointSurface(path.join(f.root,'ept.json'),f.request);
  assert.equal(result.expected,32616);
  await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...f.request,sourceVerticalUnit:null}),{code:'measurement_source_vertical_units_required'});
  await assert.rejects(preflightPointSurface(path.join(f.root,'ept.json'),{...f.request,source:{...f.request.source,sha256:'0'.repeat(64)}}),{code:'measurement_source_changed'});
});
test('point section rebuilds the parent grid and frozen base, with missing cells remaining gaps',async t=>{
  const f=fixture(t),source={...f.request.source,kind:'ept'};
  const parent=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,source},{sourceFiles:f.files});
  const referencePatches=parent.preview.referencePatches;
  const request={...f.request,source,method:'surface-transect',parentCalculationId:'parent',samplingGrid:parent.source.samplingGrid,referencePatches,baseHash:crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex'),line:{start:[0,.5],end:[2,.5]}};
  const result=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
  assert.equal(result.sampling,'point-grid-step');
  assert.equal(result.calculationOrigin,'server-original-point-surface');
  assert.equal(result.source.manifestSha256,source.manifestSha256);
  assert.ok(result.segments.every(s=>s.status==='sample'&&s.baseStartM===0&&s.baseEndM===0));
  assert.equal(result.segments.reduce((sum,s)=>sum+(s.endM-s.startM)*s.surfaceM,0),3);
  const ground=await calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,classFilter:'ground'},{sourceFiles:f.files});
  assert.ok(ground.segments.some(s=>s.status==='nodata'&&!('surfaceM' in s)));
  await assert.rejects(calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,samplingGrid:{...request.samplingGrid,width:3}},{sourceFiles:f.files}),{code:'measurement_transect_source_mismatch'});
  await assert.rejects(calculatePointSurfaceTransect(path.join(f.root,'ept.json'),{...request,baseHash:'bad'},{sourceFiles:f.files}),{code:'measurement_transect_reference_invalid'});
});
test('point surface explicit sampling limits reject oversize; no automatic cell enlargement',()=>{
  assert.throws(()=>pointSurfaceGrid([[0,0,0],[1000,0,0],[1000,1000,0]],.001),{code:'measurement_limit'});
  assert.throws(()=>pointSurfaceGrid([[0,0,0],[1,0,0],[1,1,0]],NaN),{code:'measurement_point_cell_size_required'});
});

test('map reference samples the native point grid, not placeholder zero, and preview stays selected',async t=>{
 const f=fixture(t),request={...f.request,collection:'map',reference:{type:'boundary-triangulated'}};
 const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
 assert.ok(Math.abs(result.netM3)<1e-9);assert.ok(result.preview.samples.every(p=>p[3]>0));
 await assert.rejects(calculatePointSurface(path.join(f.root,'ept.json'),{...request,classFilter:'ground'},{sourceFiles:f.files}),{code:'measurement_boundary_elevation_unavailable'});
 const selected=await calculatePointSurface(path.join(f.root,'ept.json'),{...f.request,selection:{minElevationM:1.5,maxElevationM:3.5}},{sourceFiles:f.files,collectOnly:true});
 assert.deepEqual(selected.points,[[1.5,.5,2],[.5,1.5,3]]);
});

test('sampled point boundary persists for display without changing volume or declaring DSM units',async t=>{
 const f=fixture(t),request={...f.request,collection:'map',reference:{type:'boundary-triangulated'}},before=structuredClone(request);
 const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,{sourceFiles:f.files});
 assert.deepEqual(result.boundaryVertices,[[0,0,1],[2,0,2],[2,2,4],[0,2,3]]);
 assert.equal(result.source.boundaryElevationBasis,'point-grid');
 assert.equal(result.source.verticalUnitBasis,'administrator-declared');
 assert.equal(result.source.verticalUnit,'m');
 assert.ok(Math.abs(result.netM3)<1e-9);assert.deepEqual(request,before);
 // Browser reuse is covered by measurement-display-elevations and the actual
 // HTTP save/reload integration suite. Keep this runtime-image test server-only.
 for(const options of [{...request,reference:{type:'custom',elevationM:0}},{...request,collection:'spatial3d'}]){
  const unsampled=await calculatePointSurface(path.join(f.root,'ept.json'),options,{sourceFiles:f.files});
  assert.equal(unsampled.boundaryVertices,undefined);assert.equal(unsampled.source.boundaryElevationBasis,undefined);
 }
});

test('native LAZ source decodes all points using bundled offline WASM',async t=>{
 const f=fixture(t),bytes=fs.readFileSync(new URL('./fixtures/synthetic-ept-node.laz',import.meta.url));
 const manifest=f.write('ept.json',{bounds:[367000,4759000,99,367016,4759004,101],dataType:'laszip',srs:{horizontal:'32616'},schema:[{name:'X',type:'signed',size:4},{name:'Y',type:'signed',size:4},{name:'Z',type:'signed',size:4},{name:'Classification',type:'unsigned',size:1}]});
 f.write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':64});f.write('ept-data/0-0-0-0.laz',bytes);
 const request={...f.request,vertices:[[367000,4759000,0],[367016,4759000,0],[367016,4759004,0],[367000,4759004,0]],source:{...f.request.source,byteSize:manifest.byteSize,sha256:manifest.sha256}};
 const timings=[],options={sourceFiles:f.files,pointGridCacheRoot:path.join(f.root,'cache'),onTiming:x=>timings.push(x)};
 const result=await calculatePointSurface(path.join(f.root,'ept.json'),request,options);assert.equal(result.source.pointsRead,64);assert.ok(result.cutM3>0);
 assert.deepEqual(await calculatePointSurface(path.join(f.root,'ept.json'),request,options),result);
 assert.equal(timings[1].cacheHit,true);assert.equal(timings[1].decodeGridMs,0);assert.equal(timings[1].pointsRead,64);
 t.diagnostic(`Synthetic LAZ cold/warm only, not live speed: ${JSON.stringify(timings)}`);
});
