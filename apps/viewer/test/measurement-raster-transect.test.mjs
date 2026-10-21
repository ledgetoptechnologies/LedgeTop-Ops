import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeArrayBuffer} from 'geotiff';
import {createReference} from '../measurement-volume.mjs';
import {calculateNativeRasterTransect,traceRasterCells,frozenReferenceIntervals,transectRasterWindow} from '../server/measurementRasterTransect.mjs';
import {nativeTiffFixture} from './helpers/native-tiff-fixture.mjs';
import {calculateNativeRaster} from '../server/measurementRasterCalculation.mjs';
import {childCalculation} from '../server/measurementCalculationWorker.js';

const grid={ox:0,oy:4,dx:1,dy:-1,width:4,height:4};
const line=(start,end)=>({start,end});
function fixture(t,{values=Array.from({length:16},(_,i)=>i),width=4,height=4,verticalUnit=9001,nodata,vertices=[[0,0,0],[4,0,0],[4,4,0],[0,4,0]],reference={type:'custom',elevationM:0,offsetM:0},sourceBytes}={}){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-transect-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'surface.tif');
  const bytes=sourceBytes||Buffer.from(writeArrayBuffer(Float64Array.from(values),{width,height,ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,height,0],ProjectedCSTypeGeoKey:32616,GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1,...(verticalUnit?{VerticalUnitsGeoKey:verticalUnit}:{}),...(nodata!==undefined?{GDAL_NODATA:String(nodata)}:{})}));
  fs.writeFileSync(file,bytes);const base=createReference(vertices,reference),patches=base.patches.map(p=>p.polygon.map(v=>[v[0],v[1],p.sample(v[0],v[1])]));
  const request={schemaVersion:1,method:'surface-transect',parentCalculationId:'parent',modelVersionId:'version',collection:'map',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices,reference,referencePatches:patches,line:line([.25,3.5],[3.75,3.5]),source:{id:'surface',kind:'dsm',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length}};
  return {file,request,bytes};
}
function contiguous(result){assert.equal(result.segments[0].startM,0);assert.equal(result.segments.at(-1).endM,result.lengthM);for(let i=0;i<result.segments.length;i++){const s=result.segments[i];assert.ok(s.endM>s.startM);if(i)assert.equal(result.segments[i-1].endM,s.startM);if(s.status==='sample')assert.ok(Number.isFinite(s.surfaceM));else assert.equal(s.surfaceM,undefined);}}

test('raster profile and volume timing cross the child boundary without changing numerical results',async t=>{
  const f=fixture(t),timings=[];
  for(const method of ['surface-transect','surface-cut-fill']){
    const request={...f.request,method},calculate=method==='surface-transect'?calculateNativeRasterTransect:calculateNativeRaster;
    const baseline=await calculate(f.file,request);
    assert.deepEqual(await calculate(f.file,request,{onTiming:()=>{throw Error('diagnostic sink failure');}}),baseline);
    const actual=await childCalculation(f.file,request,{config:{measurementTimeoutMs:10000},isLive:()=>true,onTiming:x=>timings.push(x)});
    assert.deepEqual(actual,baseline);
    const phase=timings.at(-2);assert.equal(phase.phase,method==='surface-transect'?'raster-transect':'raster-volume');
    for(const key of ['sourceHashMs','rasterReadMs','sampleMs','totalMs'])assert.ok(Number.isFinite(phase[key])&&phase[key]>=0,key);
    assert.ok(phase.windowReads>0);assert.equal(timings.at(-1).phase,'child');assert.doesNotMatch(JSON.stringify(timings),/surface\.tif|vertices|sha256|authority/);
  }
});

test('ordered native cells cover horizontal, reverse, diagonal and exact grid-boundary lines once',()=>{
  const horizontal=traceRasterCells(line([.25,3.5],[3.75,3.5]),grid);assert.deepEqual(horizontal.map(c=>[c.col,c.row]),[[0,0],[1,0],[2,0],[3,0]]);
  assert.deepEqual(traceRasterCells(line([3.75,3.5],[.25,3.5]),grid).map(c=>[c.col,c.row]),[[3,0],[2,0],[1,0],[0,0]]);
  assert.deepEqual(traceRasterCells(line([0,4],[4,0]),grid).map(c=>[c.col,c.row]),[[0,0],[1,1],[2,2],[3,3]]);
  assert.deepEqual(traceRasterCells(line([1,3.5],[1,.5]),grid).map(c=>[c.col,c.row]),[[1,0],[1,1],[1,2],[1,3]]);
  assert.ok(traceRasterCells(line([4,3.5],[4,.5]),grid).every(c=>c.col===null),'excluded right edge has no positive-width owning cell');
  assert.throws(()=>traceRasterCells(line([0,3.5],[4,3.5]),grid,{maxCells:3}),{code:'measurement_transect_limit'});
});

test('raster traversal clips long exterior lines before enumerating bounded native cells',()=>{
  const cells=traceRasterCells(line([-1000000000,3.5],[1000000000,3.5]),grid);
  assert.equal(cells.filter(c=>c.col!==null).length,4);assert.equal(cells[0].col,null);assert.equal(cells.at(-1).col,null);
  assert.throws(()=>traceRasterCells(line([0,0],[0,0]),grid),{code:'measurement_transect_invalid'});
});

test('bounded windows never cross a native TIFF tile or thin strip',()=>{
  for(const layout of [{width:103,height:77,blockWidth:103,blockHeight:1},{width:103,height:77,blockWidth:16,blockHeight:16},{width:103,height:77,blockWidth:3,blockHeight:41}]){
    for(let row=0;row<layout.height;row++)for(let col=0;col<layout.width;col++){
      const [left,top,right,bottom]=transectRasterWindow(col,row,layout);
      assert.ok(col>=left&&col<right&&row>=top&&row<bottom);assert.ok(right-left<=32&&bottom-top<=32);
      assert.equal(Math.floor(left/layout.blockWidth),Math.floor((right-1)/layout.blockWidth));assert.equal(Math.floor(top/layout.blockHeight),Math.floor((bottom-1)/layout.blockHeight));
    }
  }
});

test('native ramp samples retain cell steps and frozen sloping base without applying offset twice',async t=>{
  const f=fixture(t,{vertices:[[0,0,0],[4,0,4],[4,4,4],[0,4,0]],reference:{type:'boundary-triangulated',offsetM:7}}),before=JSON.stringify(f.request);
  const result=await calculateNativeRasterTransect(f.file,f.request,{windowSize:1,maxWindows:1});contiguous(result);
  assert.equal(result.cellCount,4);assert.deepEqual([...new Set(result.segments.map(s=>s.surfaceM))],[0,1,2,3]);
  for(const s of result.segments){assert.ok(Math.abs(s.baseStartM-(s.start[0]+7))<1e-10);assert.ok(Math.abs(s.baseEndM-(s.end[0]+7))<1e-10);}
  assert.equal(result.baseHash,crypto.createHash('sha256').update(JSON.stringify(f.request.referencePatches)).digest('hex'));
  assert.equal(result.parentCalculationId,'parent');assert.equal(result.source.verticalDatum,'unknown');assert.equal(result.sampling,'native-cell-step');assert.equal(JSON.stringify(f.request),before);
});

test('native pile and NoData produce observed samples with explicit uninterpolated gaps',async t=>{
  const values=Array(16).fill(0);values.splice(0,4,0,5,-9999,1);const f=fixture(t,{values,nodata:-9999});
  const result=await calculateNativeRasterTransect(f.file,f.request);contiguous(result);
  assert.deepEqual([...new Set(result.segments.map(s=>s.status))],['sample','nodata']);
  assert.ok(result.segments.some(s=>s.surfaceM===0));assert.ok(result.segments.some(s=>s.surfaceM===5));assert.ok(result.segments.filter(s=>s.cell[0]===2).every(s=>s.status==='nodata'));
});

test('concave selection yields separate islands with explicit outside-selection intervals',async t=>{
  const vertices=[[0,0,0],[4,0,0],[4,4,0],[3,4,0],[3,1,0],[1,1,0],[1,4,0],[0,4,0]],f=fixture(t,{vertices});
  f.request.line=line([-.5,2.5],[4.5,2.5]);const result=await calculateNativeRasterTransect(f.file,f.request);contiguous(result);
  assert.ok(result.segments.some(s=>s.status==='outside-selection'&&s.start[0]>=1&&s.end[0]<=3));
  assert.ok(result.segments.filter(s=>s.status==='sample').every(s=>(s.start[0]>=0&&s.end[0]<=1)||(s.start[0]>=3&&s.end[0]<=4)));
});

test('selection outside raster and source feet conversion stay explicit without guessing vertical units',async t=>{
  const f=fixture(t,{values:Array(16).fill(1.123456789),verticalUnit:9002,vertices:[[-1,-1,0],[5,-1,0],[5,5,0],[-1,5,0]]});f.request.line=line([-.5,3.5],[4.5,3.5]);
  const result=await calculateNativeRasterTransect(f.file,f.request);contiguous(result);assert.equal(result.segments[0].status,'outside-raster');assert.equal(result.segments.at(-1).status,'outside-raster');
  for(const s of result.segments.filter(s=>s.status==='sample'))assert.ok(Math.abs(s.surfaceM-1.123456789*.3048)<1e-12);
  const missing=fixture(t,{verticalUnit:null});await assert.rejects(calculateNativeRasterTransect(missing.file,missing.request),{code:'measurement_source_vertical_units_required'});
});

test('transect cancellation, source identity changes, station limit and frozen-base mismatch fail closed',async t=>{
  const f=fixture(t),cancelled=new AbortController();cancelled.abort();await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{signal:cancelled.signal}),{code:'measurement_cancelled'});
  await assert.rejects(calculateNativeRasterTransect(f.file,{...f.request,source:{...f.request.source,sha256:'0'.repeat(64)}}),{code:'measurement_source_changed'});
  await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{maxCells:3}),{code:'measurement_transect_limit'});
  await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{maxSegments:3}),{code:'measurement_transect_limit'});
  await assert.rejects(calculateNativeRasterTransect(f.file,{...f.request,baseHash:'0'.repeat(64)}),{code:'measurement_transect_reference_invalid'});
  const controller=new AbortController();await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{signal:controller.signal,onProgress:()=>controller.abort()}),{code:'measurement_cancelled'});
  let changed=false;await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{onProgress:()=>{if(!changed){changed=true;fs.appendFileSync(f.file,Buffer.from([0]));}}}),{code:'measurement_source_changed'});
});

test('native transect validates real encoded and decoded block caps before reading cell data',async t=>{
  for(const options of [{encodedCountOverride:300_000_000},{tiled:true,tileWidth:16,tileLength:16}]){
    const f=fixture(t,{sourceBytes:nativeTiffFixture(options)});
    await assert.rejects(calculateNativeRasterTransect(f.file,f.request,{maxBlockBytes:options.tiled?100:256*1024*1024}),{code:'measurement_raster_block_too_large'});
  }
});

test('frozen reference sampling follows supplied effective triangles and rejects missing/degenerate bases',()=>{
  const intervals=frozenReferenceIntervals(line([0,.5],[1,.5]),[[[0,0,2],[1,0,3],[0,1,4]],[[1,0,3],[1,1,5],[0,1,4]]]);
  assert.equal(intervals.length,2);assert.equal(intervals[0].sample([.25,.5]),3.25);
  for(const patches of [[],[[[0,0,0],[1,0,0],[2,0,0]]]])assert.throws(()=>frozenReferenceIntervals(line([0,0],[1,0]),patches),{code:'measurement_transect_reference_invalid'});
});
