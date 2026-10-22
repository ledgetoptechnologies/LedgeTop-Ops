import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeArrayBuffer, fromArrayBuffer } from 'geotiff';
import { rasterDecodedBlockBytes, validateRasterEncodedBlocks } from '../raster-source-metadata.mjs';
import { validateMeasurementTiffHeader } from '../server/measurementTiffHeader.mjs';
import { nativeTiffFixture } from './helpers/native-tiff-fixture.mjs';
import sourceUnits from '../server/measurementSourceUnitEvidence.js';
import { calculateNativeRaster, nativeRasterDefinition, preflightNativeRaster, NATIVE_RASTER_BLOCK_LIMIT } from '../server/measurementRasterCalculation.mjs';
function image(overrides = {}) {
  return { getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, ProjLinearUnitsGeoKey: 9001, VerticalUnitsGeoKey: 9001 }), fileDirectory: { BitsPerSample: [32], RowsPerStrip: 2 }, getOrigin: () => [0, 2], getResolution: () => [1, -1], getWidth: () => 2, getHeight: () => 2, ...overrides };
}
test('persisted explicit raster units require matching current metadata and never grant a metre override',()=>{
  const request={modelId:'m',modelVersionId:'v',coordinateReference:{crs:'EPSG:32616'},sourceVerticalUnit:'m',source:{id:'a',kind:'dsm',sha256:'a'.repeat(64),byteSize:123}};
  for(const [verticalUnit,verticalFactor,key] of [['m',1,9001],['ft',.3048,9002],['us-ft',1200/3937,9003]]){
    const bound={...request,sourceUnitEvidence:{schemaVersion:1,...sourceUnits.sourceBinding(request),verticalUnit,verticalFactor,verticalDatum:'unknown',basis:'server-inspected-explicit-metadata'}};
    const raster=value=>image({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,...(value?{VerticalUnitsGeoKey:value}:{})})});
    const result=nativeRasterDefinition(raster(key),bound);
    assert.equal(result.verticalFactor,verticalFactor);assert.equal(result.verticalUnit,'m');assert.equal(result.verticalUnitEvidence.verticalUnit,verticalUnit);
    assert.throws(()=>nativeRasterDefinition(raster(key===9001?9002:9001),bound),{code:'measurement_source_vertical_units_conflict'});
    assert.throws(()=>nativeRasterDefinition(raster(null),bound),{code:'measurement_source_vertical_units_required'});
    assert.throws(()=>nativeRasterDefinition(raster(key),bound,{bandMetadata:{UNITTYPE:key===9001?'ft':'m'}}),{code:'measurement_source_vertical_units_conflict'});
  }
});
test('native source validation rejects CRS, units, point pixels, rotation and oversized codec blocks', () => {
  const request = { coordinateReference: { crs: 'EPSG:32616' } };
  assert.equal(nativeRasterDefinition(image(), request).dx, 1);
  for(const units of [9002,9003,9999,null,0])assert.throws(() => nativeRasterDefinition(image({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,ProjLinearUnitsGeoKey:units,VerticalUnitsGeoKey:9001})}),request),{code:'measurement_source_crs_mismatch'},'explicit nonmetric/invalid horizontal units cannot be overridden by UTM EPSG');
  assert.equal(nativeRasterDefinition(image({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001})}),request).dx,1,'UTM supplies meters only when horizontal-unit metadata is absent');
  assert.throws(() => nativeRasterDefinition(image(), { coordinateReference: { crs: 'EPSG:32617' } }), { code: 'measurement_source_crs_mismatch' });
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, VerticalUnitsGeoKey: 9999 }) }), request), { code: 'measurement_source_vertical_units_unsupported' });
  assert.equal(nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, VerticalUnitsGeoKey: 9002 }) }), request).verticalFactor, 0.3048);
  assert.equal(nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, VerticalUnitsGeoKey: 9003 }) }), request).verticalFactor, 1200/3937);
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616, GTRasterTypeGeoKey: 2 }) }), request), { code: 'measurement_pixel_is_point_unsupported' });
  assert.throws(() => nativeRasterDefinition(image({ getGeoKeys: () => ({ ProjectedCSTypeGeoKey: 32616 }) }), request), { code: 'measurement_source_vertical_units_required' });
  assert.equal(nativeRasterDefinition(image({ getWidth: () => 20_000_000 }), request).blockBytes, 160_000_000);
  assert.throws(() => nativeRasterDefinition(image({ getWidth: () => 20_000_000 }), request, { maxBlockBytes: 64*1024*1024 }), { code: 'measurement_raster_block_too_large' });
  assert.throws(() => nativeRasterDefinition(image({ getWidth: () => 40_000_000 }), request), { code: 'measurement_raster_block_too_large' });
  assert.equal(NATIVE_RASTER_BLOCK_LIMIT, 256*1024*1024);
  assert.throws(() => nativeRasterDefinition(image({fileDirectory:{BitsPerSample:[32],RowsPerStrip:2,StripByteCounts:[NATIVE_RASTER_BLOCK_LIMIT+1]}}), request), {code:'measurement_raster_block_too_large'});
});
test('actual GeoTIFF native windows preserve zero and fractional pixels, source hashes and caps', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'measurement-native-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'dsm.tif');
  const bytes = Buffer.from(writeArrayBuffer([0, 2, 4, 6], { width: 2, height: 2, ModelPixelScale: [1,1,0], ModelTiepoint: [0,0,0,0,2,0], ProjectedCSTypeGeoKey: 32616, GTModelTypeGeoKey: 1, GTRasterTypeGeoKey: 1 })); fs.writeFileSync(file, bytes);
  const request = { modelVersionId: 'v1', coordinateReference: { crs: 'EPSG:32616' }, sourceVerticalUnit: 'm', source: { id: 'a', kind: 'dsm', byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }, vertices: [[0,0,0],[2,0,0],[2,2,0],[0,2,0]], reference: { type: 'custom', elevationM: 0 } };
  const result = await calculateNativeRaster(file, request, { windowSize: 1 });
  const definition = await preflightNativeRaster(file, request); assert.equal(definition.verticalUnitBasis, 'requester-declared');
  await assert.rejects(preflightNativeRaster(file, { ...request, sourceVerticalUnit: null }), { code: 'measurement_source_vertical_units_required' });
  assert.equal(result.cutM3, 12); assert.equal(result.coverage, 1); assert.equal(result.sampleCount, 4); assert.equal(result.source.verticalUnitBasis, 'requester-declared');
  assert.match(result.warnings.join(' '),/by the requester.*not encoded.*independently verified/);assert.doesNotMatch(result.warnings.join(' '),/administrator/);
  const clientRequest={...request,authority:{scope:'personal-raster',audience:'client',subject:'client-one'}};
  const clientResult=await calculateNativeRaster(file,clientRequest,{windowSize:1});assert.equal(clientResult.cutM3,12);assert.equal(clientResult.source.verticalUnitBasis,'requester-declared');
  const adminResult=await calculateNativeRaster(file,{...request,authority:{adminHash:'separately-validated-admin'}},{windowSize:1});assert.equal(adminResult.source.verticalUnitBasis,'administrator-declared');assert.match(adminResult.warnings.join(' '),/requesting administrator/);
  await assert.rejects(calculateNativeRaster(file, request, { maxCells: 3 }), { code: 'measurement_limit' });
  for(const windowSize of [0,513,NaN,Infinity])await assert.rejects(calculateNativeRaster(file,request,{windowSize}),{code:'measurement_limit'});
  for(const maxCells of [0,NaN,Infinity])await assert.rejects(calculateNativeRaster(file,request,{maxCells}),{code:'measurement_limit'});
  const largeWindow=await calculateNativeRaster(file,request,{windowSize:512});
  assert.equal(largeWindow.cutM3,result.cutM3,'larger streamed windows preserve exact native-cell results');
  await assert.rejects(calculateNativeRaster(file, { ...request, source: { ...request.source, sha256: '0'.repeat(64) } }), { code: 'measurement_source_changed' });
  const map={...request,collection:'map',vertices:[[.25,.25,0],[1.75,.25,0],[1.75,1.75,0],[.25,1.75,0]],reference:{type:'boundary-triangulated'}};
  const sampled=await calculateNativeRaster(file,map);assert.ok(Math.abs(sampled.netM3)<1e-9);assert.ok(sampled.preview.samples.some(p=>p[3]>0));
  const spatial=await calculateNativeRaster(file,{...map,collection:'spatial3d',vertices:map.vertices.map(([x,y])=>[x,y,999])});
  assert.equal(spatial.netM3,sampled.netM3,'picked heights and originating view do not change a raster-based volume');
  assert.deepEqual(spatial.preview.referencePatches,sampled.preview.referencePatches);
  assert.deepEqual(spatial.boundaryVertices,sampled.boundaryVertices);
  assert.ok(spatial.boundaryVertices.every(p=>p[2]<999));
  assert.equal(spatial.source.boundaryElevationBasis,'native-raster');
  await assert.rejects(calculateNativeRaster(file,{...map,vertices:request.vertices}),{code:'measurement_boundary_elevation_unavailable'});
  const triangle=await calculateNativeRaster(file,{...request,vertices:[[0,0,0],[2,0,0],[0,2,0]]});
  assert.ok(triangle.preview.samples.every(([e,n])=>e+n<=2));
});

test('encoded vertical feet are converted without rounding, preserving NoData and native precision', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-native-units-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  const file=path.join(directory,'dsm.tif');
  const bytes=Buffer.from(writeArrayBuffer(new Float64Array([1.123456789, -9999, 2.75, 4.5]), {width:2,height:2,ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,0,2,0],ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9002,GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1,GDAL_NODATA:'-9999'}));
  fs.writeFileSync(file,bytes);
  const request={modelVersionId:'v1',coordinateReference:{crs:'EPSG:32616'},source:{id:'a',kind:'dsm',byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0}};
  assert.equal((await preflightNativeRaster(file,request)).verticalUnitBasis,'raster-metadata');
  const result=await calculateNativeRaster(file,request,{windowSize:1});
  assert.ok(Math.abs(result.cutM3-(1.123456789+2.75+4.5)*.3048)<1e-12, JSON.stringify(result));
  assert.equal(result.coverage,.75); assert.equal(result.source.verticalUnitBasis,'raster-metadata');
  assert.ok(result.preview.samples.every(p=>p[2]>0&&p[2]<2));
});

test('GeoTIFF3 actual strips and padded tiles use real metadata and deferred encoded-count accessors', async t => {
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-tiff-layout-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const options of [{rowsPerStrip:1},{tiled:true,tileWidth:16,tileLength:16}]){
    const bytes=nativeTiffFixture(options),file=path.join(directory,options.tiled?'tile.tif':'strip.tif');fs.writeFileSync(file,bytes);
    const request={modelVersionId:'v',coordinateReference:{crs:'EPSG:32616'},source:{id:'a',kind:'dsm',byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')},vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],reference:{type:'custom',elevationM:0}};
    const tiff=await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.length)),image=await tiff.getImage();
    assert.equal(image.fileDirectory.BitsPerSample,undefined,'the library does not expose plain properties');
    assert.deepEqual(Array.from(image.fileDirectory.getValue('BitsPerSample')),[32]);
    assert.equal(rasterDecodedBlockBytes(image),options.tiled?1024:8,'padded tile byte count, not whole-image/default64bit estimate');
    const result=await calculateNativeRaster(file,request,{windowSize:1});assert.equal(result.cutM3,10);
    assert.equal((await preflightNativeRaster(file,request)).blockBytes,options.tiled?1024:8);
    await validateRasterEncodedBlocks(image,{maxBlockBytes:1024});
    await assert.rejects(validateRasterEncodedBlocks(image,{maxBlockBytes:options.tiled?1023:7}),{code:'measurement_raster_block_too_large'});
  }
});

test('real TIFF encoded oversize and rotated transforms fail before raster decoding',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-tiff-invalid-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const [name,options,code]of [
    ['encoded',{encodedCountOverride:NATIVE_RASTER_BLOCK_LIMIT+1},'measurement_raster_block_too_large'],
    ['rotated',{transform:[1,.5,0,0,0,-1,0,2,0,0,1,0,0,0,0,1]},'measurement_rotated_raster_unsupported'],
  ]){
    const bytes=nativeTiffFixture(options),file=path.join(directory,`${name}.tif`);fs.writeFileSync(file,bytes);
    await assert.rejects(preflightNativeRaster(file,{coordinateReference:{crs:'EPSG:32616'},source:{byteSize:bytes.length}}),{code});
  }
});

test('raw TIFF preflight bounds IFD counts and lazy metadata allocation declarations',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-tiff-header-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  for(const [name,mutate]of [
    ['entries',b=>b.writeUInt16LE(65535,8)],
    ['array',b=>b.writeUInt32LE(0xffffffff,14)],
    ['offset',b=>b.writeUInt32LE(0xfffffff0,4)],
  ]){const bytes=nativeTiffFixture();mutate(bytes);const file=path.join(directory,`${name}.tif`);fs.writeFileSync(file,bytes);await assert.rejects(validateMeasurementTiffHeader(file),{code:'measurement_raster_metadata_limit'});}
});
