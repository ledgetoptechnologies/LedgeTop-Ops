import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {rasterDirectoryValue,rasterDecodedBlockBytes,validateRasterEncodedBlocks} from '../raster-source-metadata.mjs';
import {readRasterBandMetadata,resolveRasterVerticalUnits} from '../raster-vertical-units.mjs';
const main=readFileSync(new URL('../main.js',import.meta.url),'utf8');
const start=main.indexOf('async function calculateSavedMeasurementSurface('),end=main.indexOf('function installMeasurementWorkspace()',start);
const record={collection:'spatial3d',kind:'polygon',vertices:[[0,0,0],[2,0,0],[2,2,0],[0,2,0]],coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'}};
function fixture(overrides={}){
  const state={reads:[],closed:0,calculated:null};
  const image={getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001}),fileDirectory:{BitsPerSample:[32],RowsPerStrip:2},getBoundingBox:()=>[0,0,2,2],getWidth:()=>2,getHeight:()=>2,getResolution:()=>[1,-1],getGDALNoData:()=>'-9999',readRasters:async options=>{state.reads.push(options);return [new Float32Array([0,2,4,6])];},...overrides};
  const scope=vm.createContext({rasterDirectoryValue,rasterDecodedBlockBytes,validateRasterEncodedBlocks,DSM_URL:'/native-dsm',DTM_URL:null,requestedVolumeSurface:()=>({type:'dsm',url:'/native-dsm'}),openGeoTiff:async(_url,options)=>{assert.equal(options.allowFullFile,false);return{getImage:async i=>{assert.equal(i,0);return image;},close:async()=>{state.closed++;}};},parseFiniteGdalNoData:Number,geoPool:null,PROJECT:{activeVersion:{id:'version'}},calculateBrowserSurface:async options=>{state.calculated=options;return{cutM3:12,warnings:[]};},DOMException});
  scope.preflightBrowserRasterHeader=async()=>{};
  Object.assign(scope,{readRasterBandMetadata,resolveRasterVerticalUnits});
  vm.runInContext(main.slice(start,end),scope);return{state,calculate:(r=record,options)=>scope.calculateSavedMeasurementSurface(r,options)};
}
test('browser source validation rejects bad metadata before decoding pixels or statistics',async()=>{
  const cases=[
    [{getGeoKeys:()=>({})},/CRS/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32617,VerticalUnitsGeoKey:9001})},/CRS/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9001,GTRasterTypeGeoKey:2})},/point-sample/],
    [{fileDirectory:{BitsPerSample:[32],RowsPerStrip:2,ModelTransformation:[1,0,1,0,0,-1,0,0,0,0,1,0,0,0,0,1]}},/rotated/],
    [{getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616})},/elevations are meters/],
    [{fileDirectory:{BitsPerSample:[64],RowsPerStrip:2},getWidth:()=>20_000_000},/oversized decode/],
    [{fileDirectory:{BitsPerSample:[32],RowsPerStrip:1},getWidth:()=>2000,getHeight:()=>2000,getResolution:()=>[.001,-.001]},/safe browser calculation limit/],
  ];
  for(const [overrides,error]of cases){const f=fixture(overrides);await assert.rejects(f.calculate(),error);assert.equal(f.state.reads.length,0);assert.equal(f.state.calculated,null);assert.equal(f.state.closed,1);}
});
test('browser calculation reads only native selected window and preserves zero elevations',async()=>{
  const f=fixture();const result=await f.calculate();assert.equal(f.state.reads.length,1);
  assert.deepEqual(Array.from(f.state.reads[0].window),[0,0,2,2]);assert.deepEqual(Array.from(f.state.reads[0].samples),[0]);
  assert.equal(f.state.calculated.values[0],0);assert.equal(result.modelVersionId,'version');assert.equal(f.state.closed,1);
});
test('map boundary elevations are sampled from native source, not stored Z placeholders, with units converted',async()=>{
  const f=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,VerticalUnitsGeoKey:9002})});
  await f.calculate({...record,collection:'map',vertices:[[.25,.25,0],[1.75,.25,0],[1.75,1.75,0],[.25,1.75,0]]});
  assert.deepEqual(Array.from(f.state.calculated.vertices,p=>p[2]),[4*.3048,6*.3048,2*.3048,0]);
  assert.equal(f.state.calculated.values[0],0);assert.equal(f.state.calculated.nodata,-9999*.3048);
});
test('explicit missing-unit assertion adds provenance warning and cancelled decode never calculates',async()=>{
  const f=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616})});
  const confirmed=await f.calculate(record,{confirmMeters:true});assert.match(confirmed.warnings.join(' '),/explicitly confirmed/);assert.equal(confirmed.sourceVerticalUnitBasis,'user-declared');
  const controller=new AbortController(),cancelled=fixture({readRasters:async()=>{controller.abort();return[new Float32Array(4)];}});
  await assert.rejects(cancelled.calculate(record,{signal:controller.signal}),{name:'AbortError'});assert.equal(cancelled.state.calculated,null);assert.equal(cancelled.state.closed,1);
});

test('browser uses explicit GDAL band units and rejects conflicts before pixel decode',async()=>{
  const f=fixture({getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616}),getGDALMetadata:async sample=>{assert.equal(sample,0);return{UNITTYPE:'ft'};}});
  const result=await f.calculate();assert.equal(f.state.calculated.values[1],2*.3048);assert.equal(result.sourceVerticalUnitBasis,'gdal-band-unit');assert.ok(!result.warnings.some(w=>/explicitly confirmed/.test(w)));
  const conflict=fixture({getGDALMetadata:async()=>({UNITTYPE:'ft'})});await assert.rejects(conflict.calculate(record,{confirmMeters:true}),{code:'measurement_source_vertical_units_conflict'});assert.equal(conflict.state.reads.length,0);
  const scaled=fixture({getGDALMetadata:async()=>({UNITTYPE:'m',SCALE:'.01',OFFSET:'100'})});await assert.rejects(scaled.calculate(record,{confirmMeters:true}),{code:'measurement_source_value_transform_unsupported'});assert.equal(scaled.state.reads.length,0);
});
