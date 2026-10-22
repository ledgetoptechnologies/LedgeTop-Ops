import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {calculatePointSurface,preflightPointSurface} from '../server/measurementPointSurface.mjs';
import {calculatePointSurfaceTransect} from '../server/measurementPointTransect.mjs';
import sourceUnits from '../server/measurementSourceUnitEvidence.js';

const horizontal='PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
const compound=(name,factor,id)=>`COMPD_CS["Survey",${horizontal},VERT_CS["Height",VERT_DATUM["Survey datum",2005],UNIT["${name}",${factor},AUTHORITY["EPSG","${id}"]],AXIS["Height",UP]]]`;
const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function fixture(t,srs){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'point-encoded-units-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
  const files=[],write=(relative,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(root,relative),bytes);const identity={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};files.push(identity);return identity;};
  const manifest=write('ept.json',{srs,bounds:[0,0,0,2,2,4],dataType:'binary',schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});
  write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':4});
  const data=Buffer.alloc(4*24);[[.5,.5,1],[1.5,.5,2],[.5,1.5,3],[1.5,1.5,4]].forEach((point,i)=>point.forEach((value,j)=>data.writeDoubleLE(value,i*24+j*8)));write('ept-data/0-0-0-0.bin',data);
  const request={method:'point-surface-cut-fill',requireEncodedVerticalUnits:true,vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0},coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},cellSizeM:1,modelVersionId:'fixture-v1',source:{id:'fixture-ept',kind:'ept',byteSize:manifest.byteSize,sha256:manifest.sha256,manifestSha256:'a'.repeat(64)}};
  return{root,file:path.join(root,'ept.json'),files,request};
}

for(const [unit,factor,id] of [['metre',1,9001],['foot',.3048,9002],['US survey foot',1200/3937,9003]])test(`encoded ${unit} point heights are converted consistently in volume and parent-grid section`,async t=>{
  const f=fixture(t,{wkt:compound(unit,factor,id)}),options={sourceFiles:f.files};
  const preflight=await preflightPointSurface(f.file,f.request,{requireEncodedVerticalUnits:true});near(preflight.vertical.verticalFactor,factor);
  const result=await calculatePointSurface(f.file,f.request,options);
  near(result.cutM3,10*factor);assert.equal(result.fillM3,0);assert.equal(result.coverage,1);
  assert.equal(result.source.verticalUnitBasis,'ept-vertical-crs');assert.equal(result.source.verticalUnit,'m');assert.equal(result.source.verticalDatum,'unknown');assert.equal(result.source.pointsRead,4);
  assert.ok(!result.warnings.some(w=>/administrator-declared|declared as metres/.test(w)));
  const referencePatches=result.preview.referencePatches,baseHash=crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex');
  const section=await calculatePointSurfaceTransect(f.file,{...f.request,method:'surface-transect',parentCalculationId:'parent',samplingGrid:result.source.samplingGrid,referencePatches,baseHash,line:{start:[0,.5],end:[2,.5]}},options);
  assert.equal(section.source.verticalUnitBasis,'ept-vertical-crs');assert.equal(section.source.verticalUnit,'m');
  assert.ok(section.segments.every(s=>s.status==='sample'&&s.baseStartM===0&&s.baseEndM===0));
  for(const segment of section.segments)near(segment.surfaceM,(segment.cell[0]+1)*factor);
  near(section.segments.reduce((sum,s)=>sum+(s.endM-s.startM)*s.surfaceM,0),3*factor);
});

test('persisted explicit point units require current matching metadata, with original units retained',async t=>{
  const bind=(request,verticalUnit,verticalFactor)=>({...request,modelId:'m',sourceVerticalUnit:'m',sourceUnitEvidence:{schemaVersion:1,...sourceUnits.sourceBinding({...request,modelId:'m'}),verticalUnit,verticalFactor,verticalDatum:'unknown',basis:'server-inspected-explicit-metadata'}});
  for(const [name,verticalUnit,factor,id] of [['metre','m',1,9001],['foot','ft',.3048,9002],['US survey foot','us-ft',1200/3937,9003]]){
    const f=fixture(t,{wkt:compound(name,factor,id)}),request=bind(f.request,verticalUnit,factor);
    const result=await calculatePointSurface(f.file,request,{sourceFiles:f.files});
    near(result.cutM3,10*factor);assert.equal(result.source.verticalUnitEvidence.verticalUnit,verticalUnit);
    await assert.rejects(preflightPointSurface(f.file,bind(f.request,verticalUnit==='m'?'ft':'m',verticalUnit==='m'?.3048:1)),{code:'measurement_source_vertical_units_conflict'});
    await assert.rejects(preflightPointSurface(f.file,{...request,source:{...request.source,sha256:'f'.repeat(64)}}),{code:'measurement_source_changed'});
  }
  const untagged=fixture(t,{wkt:horizontal});
  for(const [unit,factor] of [['m',1],['ft',.3048],['us-ft',1200/3937]])await assert.rejects(preflightPointSurface(untagged.file,bind(untagged.request,unit,factor)),{code:'measurement_source_vertical_units_required'});
});

test('ordinary point requests cannot forge a metre declaration on a horizontal-only source',async t=>{
  const f=fixture(t,{wkt:horizontal}),request={...f.request,sourceVerticalUnit:'m'};
  await assert.rejects(preflightPointSurface(f.file,request,{requireEncodedVerticalUnits:true}),{code:'measurement_source_vertical_units_required'});
  await assert.rejects(calculatePointSurface(f.file,request,{sourceFiles:f.files}),{code:'measurement_source_vertical_units_required'});
  // The legacy staff calculation still identifies this as a declaration.
  const legacy=await calculatePointSurface(f.file,{...request,requireEncodedVerticalUnits:false},{sourceFiles:f.files});
  assert.equal(legacy.source.verticalUnitBasis,'administrator-declared');
});
test('ordinary feet outline takes boundary heights from normalized original points, not raw picked Z',async t=>{
  const f=fixture(t,{wkt:compound('foot',.3048,9002)});
  const request={...f.request,collection:'spatial3d',vertices:f.request.vertices.map(([e,n])=>[e,n,10]),reference:{type:'boundary-triangulated'}};
  const result=await calculatePointSurface(f.file,request,{sourceFiles:f.files});
  near(result.netM3,0);
  const boundaryHeights=result.preview.referencePatches.flat().map(p=>p[2]);
  near(Math.min(...boundaryHeights),.3048);near(Math.max(...boundaryHeights),4*.3048);
  const referencePatches=result.preview.referencePatches;
  const section=await calculatePointSurfaceTransect(f.file,{...request,method:'surface-transect',parentCalculationId:'parent',samplingGrid:result.source.samplingGrid,referencePatches,baseHash:crypto.createHash('sha256').update(JSON.stringify(referencePatches)).digest('hex'),line:{start:[0,.5],end:[2,.5]}},{sourceFiles:f.files});
  assert.ok(section.segments.every(s=>s.baseStartM<2&&s.baseEndM<2));
});

test('conflicting encoded units cannot fall back to an administrator or client declaration',async t=>{
  const f=fixture(t,{wkt:compound('metre',1,9002)});
  for(const requireEncodedVerticalUnits of [true,false]){
    const request={...f.request,sourceVerticalUnit:'m',requireEncodedVerticalUnits};
    await assert.rejects(preflightPointSurface(f.file,request,{requireEncodedVerticalUnits}),{code:'measurement_source_vertical_units_conflict'});
    await assert.rejects(calculatePointSurface(f.file,request,{sourceFiles:f.files}),{code:'measurement_source_vertical_units_conflict'});
  }
});

test('encoded-unit preflight verifies header hash without needing point or hierarchy files',async t=>{
  const f=fixture(t,{wkt:compound('metre',1,9001)});
  fs.unlinkSync(path.join(f.root,'ept-hierarchy/0-0-0-0.json'));fs.unlinkSync(path.join(f.root,'ept-data/0-0-0-0.bin'));
  const result=await preflightPointSurface(f.file,f.request,{requireEncodedVerticalUnits:true});assert.equal(result.vertical.verticalUnitBasis,'ept-vertical-crs');
  await assert.rejects(preflightPointSurface(f.file,{...f.request,source:{...f.request.source,sha256:'0'.repeat(64)}},{requireEncodedVerticalUnits:true}),{code:'measurement_source_changed'});
  // Preserve the size so this proves cryptographic verification, not a size check.
  const bytes=fs.readFileSync(f.file);const at=bytes.indexOf(Buffer.from('Survey'));bytes[at]='s'.charCodeAt(0);fs.writeFileSync(f.file,bytes);
  await assert.rejects(preflightPointSurface(f.file,f.request,{requireEncodedVerticalUnits:true}),{code:'measurement_source_changed'});
});
