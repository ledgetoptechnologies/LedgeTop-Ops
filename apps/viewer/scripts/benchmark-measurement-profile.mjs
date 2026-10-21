// Opt-in synthetic evidence, never a live-data benchmark or a default CI test.
// Run: node scripts/benchmark-measurement-profile.mjs
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {childCalculation} from '../server/measurementCalculationWorker.js';
import {nativeTiffFixture} from '../test/helpers/native-tiff-fixture.mjs';

const SIDE=1024, POINTS=SIDE*SIDE, CELL=.25;
const root=await fs.mkdtemp(path.join(os.tmpdir(),'viewer-synthetic-profile-benchmark-'));
const records=[];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function write(relative,bytes){
  bytes=Buffer.isBuffer(bytes)?bytes:Buffer.from(JSON.stringify(bytes));
  await fs.writeFile(path.join(root,relative),bytes);
  return{relativePath:relative,byteSize:bytes.length,sha256:sha(bytes)};
}
async function run(label,file,request,{cacheMount,sourceFiles}={}){
  const timings=[],started=performance.now();
  const result=await childCalculation(file,request,{
    config:{cacheMount,measurementTimeoutMs:120000,measurementMaxCells:POINTS,measurementRasterMaxCells:POINTS},
    sourceFiles,isLive:()=>true,onTiming:value=>timings.push(value),
  });
  records.push({label,wallMs:performance.now()-started,timings});
  return result;
}
try{
  await fs.mkdir(path.join(root,'ept-hierarchy'));
  await fs.mkdir(path.join(root,'ept-data'));
  const nodeKeys=['0-0-0-0','1-0-0-0','1-1-0-0','1-0-1-0','1-1-1-0'];
  // Root contains a sparse whole-footprint level. Remaining points occupy
  // four spatial children; all native samples are unique and explicitly read.
  const nodes=nodeKeys.map(()=>[]);
  for(let row=0;row<SIDE;row++)for(let col=0;col<SIDE;col++){
    const index=row*SIDE+col;
    const bucket=index%16===0?0:1+(col>=SIDE/2?1:0)+(row>=SIDE/2?2:0);
    nodes[bucket].push([CELL*(col+.5),CELL*(row+.5),5+Math.sin(col/53)+Math.cos(row/71)]);
  }
  const files=[],hierarchy={};
  for(let n=0;n<nodes.length;n++){
    const points=nodes[n],bytes=Buffer.alloc(points.length*24);
    for(let i=0;i<points.length;i++)for(let axis=0;axis<3;axis++)bytes.writeDoubleLE(points[i][axis],i*24+axis*8);
    files.push(await write(`ept-data/${nodeKeys[n]}.bin`,bytes));
    hierarchy[nodeKeys[n]]=points.length;
  }
  files.push(await write('ept-hierarchy/0-0-0-0.json',hierarchy));
  const extent=SIDE*CELL;
  const header=await write('ept.json',{bounds:[0,0,0,extent,extent,16],dataType:'binary',points:POINTS,
    srs:{horizontal:'32616'},schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});
  const vertices=[[0,0,0],[extent,0,0],[extent,extent,0],[0,extent,0]];
  const source={id:'synthetic-ept',kind:'ept',sha256:header.sha256,byteSize:header.byteSize,
    manifestSha256:sha(Buffer.from(JSON.stringify(files)))};
  const request={method:'point-surface-cut-fill',modelVersionId:'synthetic-only',collection:'map',
    coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',source,vertices,
    reference:{type:'custom',elevationM:0},cellSizeM:CELL};
  const file=path.join(root,'ept.json'),cacheMount=path.join(root,'volume-cache');
  const coldVolume=await run('EPT cold volume',file,request,{cacheMount,sourceFiles:files});
  const warmVolume=await run('EPT warm volume',file,request,{cacheMount,sourceFiles:files});
  assert.deepEqual(warmVolume,coldVolume);
  assert.equal(coldVolume.coverage,1);
  assert.equal(coldVolume.source.pointsRead,POINTS);assert.equal(coldVolume.source.nodesRead,5);
  assert.equal(coldVolume.source.samplingGrid.width* coldVolume.source.samplingGrid.height,POINTS);
  const patches=coldVolume.preview.referencePatches;
  const section={...request,method:'surface-transect',parentCalculationId:'synthetic-parent',
    samplingGrid:coldVolume.source.samplingGrid,referencePatches:patches,
    baseHash:sha(Buffer.from(JSON.stringify(patches))),line:{start:[.125,.125],end:[extent-.125,extent-.125]}};
  const freshProfile=await run('EPT uncached profile baseline',file,section,{sourceFiles:files});
  const sectionCache=path.join(root,'section-cache');
  const coldProfile=await run('EPT cold profile',file,section,{cacheMount:sectionCache,sourceFiles:files});
  const warmProfile=await run('EPT warm profile',file,section,{cacheMount:sectionCache,sourceFiles:files});
  const reusedProfile=await run('EPT profile reusing volume grid',file,section,{cacheMount,sourceFiles:files});
  for(const actual of [coldProfile,warmProfile,reusedProfile])assert.deepEqual(actual,freshProfile);
  assert.equal(freshProfile.cellCount,SIDE);
  for(const label of ['EPT warm volume','EPT warm profile','EPT profile reusing volume grid']){
    const timing=records.find(r=>r.label===label).timings.find(t=>t.phase==='point-surface');
    assert.equal(timing.cacheHit,true);assert.equal(timing.decodeGridMs,0);
    assert.equal(timing.pointsRead,POINTS);assert.equal(timing.nodesRead,5);
  }
  assert.equal(records.find(r=>r.label==='EPT cold profile').timings.find(t=>t.phase==='point-surface').cacheHit,false);
  // Source tampering must fail even with a valid warm grid and unchanged size.
  const nodePath=path.join(root,'ept-data/0-0-0-0.bin'),original=await fs.readFile(nodePath);
  const modified=Buffer.from(original);modified[modified.length-1]^=1;await fs.writeFile(nodePath,modified);
  await assert.rejects(childCalculation(file,section,{config:{cacheMount,measurementTimeoutMs:120000},sourceFiles:files,isLive:()=>true,onTiming:()=>{}}),{code:'measurement_source_changed'});
  await fs.writeFile(nodePath,original);

  const raster=await write('surface.tif',nativeTiffFixture({tiled:true,width:SIDE,height:SIDE,tileWidth:64,tileLength:64}));
  const rasterVertices=[[0,0,0],[SIDE,0,0],[SIDE,SIDE,0],[0,SIDE,0]];
  const rasterRequest={...request,method:'surface-cut-fill',vertices:rasterVertices,sourceVerticalUnit:undefined,
    source:{id:'synthetic-dsm',kind:'dsm',sha256:raster.sha256,byteSize:raster.byteSize}};
  const rasterFile=path.join(root,'surface.tif');
  const rasterCold=await run('TIFF first volume (no application cache)',rasterFile,rasterRequest);
  const rasterWarm=await run('TIFF repeated volume (no application cache)',rasterFile,rasterRequest);
  assert.deepEqual(rasterWarm,rasterCold);
  assert.equal(rasterCold.coverage,1);
  const rasterPatches=rasterCold.preview.referencePatches;
  const rasterSection={...rasterRequest,method:'surface-transect',parentCalculationId:'synthetic-raster-parent',
    referencePatches:rasterPatches,baseHash:sha(Buffer.from(JSON.stringify(rasterPatches))),line:{start:[.5,.5],end:[SIDE-.5,SIDE-.5]}};
  const rasterFresh=await run('TIFF first profile (no application cache)',rasterFile,rasterSection);
  const rasterRepeated=await run('TIFF repeated profile (no application cache)',rasterFile,rasterSection);
  assert.deepEqual(rasterRepeated,rasterFresh);
  assert.equal(rasterFresh.cellCount,SIDE);
  for(const record of records){
    assert.ok(Number.isFinite(record.wallMs)&&record.wallMs>=0);
    assert.ok(record.timings.some(t=>t.phase==='child'));
    for(const timing of record.timings)for(const[key,value]of Object.entries(timing)){
      if(key.endsWith('Ms'))assert.ok(Number.isFinite(value)&&value>=0,`${record.label}: ${key}`);
    }
  }
  console.log(JSON.stringify({synthetic:true,notLiveLatency:true,points:POINTS,eptNodes:5,pointGridCells:POINTS,
    pointCellSizeM:CELL,rasterCells:POINTS,rasterTileSize:64,
    equality:'full deepEqual: EPT volume cold/warm; EPT profile fresh/cold/warm/volume-grid reuse; TIFF volume/profile repeated',
    sourceTamperRejected:true,queueWaitMs:null,
    timingNotes:'Queue is bypassed by isolated child calls. EPT verifiedReadMs combines I/O and hash verification; no separate hash field exists. Point-surface total excludes volume accumulation; child and wall totals include it. TIFF repetitions do not claim persistent raster cache hits or cold OS caches.',records},null,2));
}finally{
  const resolved=path.resolve(root);
  assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('viewer-synthetic-profile-benchmark-'));
  await fs.rm(resolved,{recursive:true,force:true});
}
