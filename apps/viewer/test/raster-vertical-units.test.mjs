import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fromArrayBuffer} from 'geotiff';
import {nativeTiffFixture} from './helpers/native-tiff-fixture.mjs';
import {readRasterBandMetadata,resolveRasterVerticalUnits} from '../raster-vertical-units.mjs';
import {calculateNativeRaster,preflightNativeRaster} from '../server/measurementRasterCalculation.mjs';
const image=key=>({getGeoKeys:()=>key===undefined?{}:{VerticalUnitsGeoKey:key},getSamplesPerPixel:()=>1});

test('explicit requester unit declarations preserve legacy basis but never override encoded units',()=>{
  assert.equal(resolveRasterVerticalUnits(image(),{confirmMeters:true,confirmationBasis:'requester-declared'}).verticalUnitBasis,'requester-declared');
  assert.equal(resolveRasterVerticalUnits(image(),{confirmMeters:true}).verticalUnitBasis,'administrator-declared','legacy callers and persisted basis remain compatible');
  assert.equal(resolveRasterVerticalUnits(image(9001),{confirmMeters:true,confirmationBasis:'requester-declared'}).verticalUnitBasis,'raster-metadata');
  assert.throws(()=>resolveRasterVerticalUnits(image(),{confirmationBasis:'requester-declared'}),{code:'measurement_source_vertical_units_required'});
  assert.throws(()=>resolveRasterVerticalUnits(image(),{confirmMeters:true,confirmationBasis:'verified-by-server'}),{code:'measurement_source_vertical_metadata_invalid'});
});

test('explicit band units are accepted independently of horizontal EPSG, and unknown/conflicts never fall back',()=>{
  for(const [unit,factor]of [['m',1],['metres',1],['ft',.3048],['US survey foot',1200/3937],['cm',.01]]){
    assert.deepEqual(resolveRasterVerticalUnits(image(),{bandMetadata:{UNITTYPE:unit}}),{verticalFactor:factor,verticalUnitBasis:'gdal-band-unit'});
  }
  assert.deepEqual(resolveRasterVerticalUnits(image(9001),{bandMetadata:{UNITTYPE:'m'}}),{verticalFactor:1,verticalUnitBasis:'raster-metadata'});
  assert.throws(()=>resolveRasterVerticalUnits(image(9001),{bandMetadata:{UNITTYPE:'ft'},confirmMeters:true}),{code:'measurement_source_vertical_units_conflict'});
  assert.throws(()=>resolveRasterVerticalUnits(image(9999),{bandMetadata:{UNITTYPE:'m'},confirmMeters:true}),{code:'measurement_source_vertical_units_unsupported'});
  assert.throws(()=>resolveRasterVerticalUnits(image(),{bandMetadata:{UNITTYPE:'furlong'},confirmMeters:true}),{code:'measurement_source_vertical_units_unsupported'});
  assert.throws(()=>resolveRasterVerticalUnits(image(),{bandMetadata:{UNITTYPE:''}}),{code:'measurement_source_vertical_units_required'});
  assert.throws(()=>resolveRasterVerticalUnits(image(),{bandMetadata:{UNITTYPE:'m',unittype:'ft'}}),{code:'measurement_source_vertical_units_conflict'});
  assert.throws(()=>resolveRasterVerticalUnits({...image(),getSamplesPerPixel:()=>3},{bandMetadata:{UNITTYPE:'m'}}),{code:'measurement_source_vertical_units_unsupported'});
});

test('GeoTIFF3 reads actual GDAL band UNITTYPE and native calculations preserve declared conversion and provenance',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-band-units-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const [unit,factor]of [['m',1],['ft',.3048],['us_survey_foot',1200/3937]]){
    const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:`<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">${unit}</Item></GDALMetadata>`});
    const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raster=await tiff.getImage();
    assert.equal(raster.getGeoKeys().VerticalUnitsGeoKey,undefined);const band=await readRasterBandMetadata(raster);assert.equal(band.UNITTYPE,unit);assert.equal(resolveRasterVerticalUnits(raster,{bandMetadata:band}).verticalFactor,factor);
    const file=path.join(directory,`${unit}.tif`);fs.writeFileSync(file,bytes);
    const request={modelVersionId:'v',coordinateReference:{crs:'EPSG:32616'},source:{id:'a',kind:'dsm',byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0}};
    assert.equal((await preflightNativeRaster(file,request)).verticalUnitBasis,'gdal-band-unit');const result=await calculateNativeRaster(file,request,{windowSize:1});assert.ok(Math.abs(result.cutM3-10*factor)<1e-12);assert.equal(result.source.verticalUnitBasis,'gdal-band-unit');assert.ok(!result.warnings.some(w=>/declared as metres/.test(w)));
  }
});

test('dataset-level UNITTYPE is not mistaken for elevation-band units',async()=>{
  const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:'<GDALMetadata><Item name="UNITTYPE">m</Item><Item name="UNITTYPE" sample="1" role="unittype">m</Item></GDALMetadata>'});
  const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raster=await tiff.getImage(),band=await readRasterBandMetadata(raster);
  assert.equal(band.UNITTYPE,undefined);assert.throws(()=>resolveRasterVerticalUnits(raster,{bandMetadata:band}),{code:'measurement_source_vertical_units_required'});
});

test('real GDAL band transforms and duplicate declarations fail before native pixels are decoded',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-band-invalid-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const base='<Item name="UNITTYPE" sample="0" role="unittype">m</Item>';
  const cases=[
    [`${base}<Item name="SCALE" sample="0" role="scale">0.01</Item><Item name="OFFSET" sample="0" role="offset">100</Item>`,'measurement_source_value_transform_unsupported'],
    [`${base}<Item name="OFFSET" sample="0" role="offset">NaN</Item>`,'measurement_source_value_transform_unsupported'],
    [`${base}<Item name="SCALE" sample="0" role="scale"></Item>`,'measurement_source_value_transform_unsupported'],
    [`<Item name="UNITTYPE" sample="0" role="unittype">ft</Item>${base}`,'measurement_source_vertical_units_conflict'],
    [`${base}${base}`,'measurement_source_vertical_units_conflict'],
    [`${base}<Item name="Z_SCALE" sample="0" role="scale">0.01</Item>`,'measurement_source_value_transform_unsupported'],
  ];
  for(const [index,[items,code]]of cases.entries()){
    const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:`<GDALMetadata>${items}</GDALMetadata>`}),file=path.join(directory,`${index}.tif`);fs.writeFileSync(file,bytes);
    const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raster=await tiff.getImage();
    await assert.rejects(readRasterBandMetadata(raster),{code});
    await assert.rejects(preflightNativeRaster(file,{coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',source:{byteSize:bytes.length}}),{code});
  }
});

test('explicit identity GDAL scale and offset are safe, but malformed values never fall through',async()=>{
  const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata:'<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">m</Item><Item name="SCALE" sample="0" role="scale">1.0</Item><Item name="OFFSET" sample="0" role="offset">0.0</Item></GDALMetadata>'}),tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)),raster=await tiff.getImage();
  assert.equal(resolveRasterVerticalUnits(raster,{bandMetadata:await readRasterBandMetadata(raster)}).verticalFactor,1);
  for(const value of ['',null,'NaN',.01])assert.throws(()=>resolveRasterVerticalUnits(image(9001),{bandMetadata:{SCALE:value},confirmMeters:true}),{code:'measurement_source_value_transform_unsupported'});
});

test('malformed raw GDAL item syntax fails closed rather than relying on a flattened last value',async()=>{
  for(const gdalMetadata of [
    '<GDALMetadata><Item name="UNITTYPE" sample="0">m</Item><Item name="OFFSET" sample="0">100</GDALMetadata>',
    '<GDALMetadata><Item name="UNITTYPE" name="OTHER" sample="0">m</Item></GDALMetadata>',
    '<GDALMetadata><Item name="UNITTYPE" sample=0>m</Item></GDALMetadata>',
    '<GDALMetadata><Item name="UNITTYPE" sample="">m</Item></GDALMetadata>',
    '<GDALMetadata><Item name="UNITTYPE" sample="0">m</Item><Item name="SCALE" sample="0" /></GDALMetadata>',
  ]){
    const bytes=nativeTiffFixture({verticalUnit:null,gdalMetadata}),tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    await assert.rejects(readRasterBandMetadata(await tiff.getImage()),{code:'measurement_source_vertical_metadata_invalid'});
  }
  const oversized={getGDALMetadata:async()=>({UNITTYPE:'m'}),fileDirectory:{GDAL_METADATA:' '.repeat(1024*1024+1)}};
  await assert.rejects(readRasterBandMetadata(oversized),{code:'measurement_source_vertical_metadata_invalid'});
  const valid={getGDALMetadata:async()=>({UNITTYPE:'m'}),fileDirectory:{GDAL_METADATA:'<?xml version="1.0" encoding="UTF-8"?>\n<GDALMetadata><Item name="UNITTYPE" sample="0" role="unittype">m</Item></GDALMetadata>'}};
  assert.equal((await readRasterBandMetadata(valid)).UNITTYPE,'m');
});
