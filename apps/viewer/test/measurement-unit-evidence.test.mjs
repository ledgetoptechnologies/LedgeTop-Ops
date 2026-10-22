import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeRasterDefinition } from '../server/measurementRasterCalculation.mjs';

const request = {
  modelId:'9322ab51-dbb3-44f8-ae6f-b170c6fbd48c',
  modelVersionId:'7400b8ba-68f2-4c8c-b19c-3572b98e86f6',
  coordinateReference:{crs:'EPSG:32616'},
  source:{id:'207914cd-bff7-426e-8535-b2e43403a1b4',kind:'dsm',byteSize:556007817,
    sha256:'0265277ff9c34805e2de4aff20cf568bf36d5a205423f6b0c39631880be7f514'},
};
const image = (keys={}) => ({
  getGeoKeys:()=>({ProjectedCSTypeGeoKey:32616,ProjLinearUnitsGeoKey:9001,...keys}),
  fileDirectory:{BitsPerSample:[32],RowsPerStrip:1},
  getOrigin:()=>[406200,4905400],getResolution:()=>[.01,-.01],
  getWidth:()=>19229,getHeight:()=>21580,getSamplesPerPixel:()=>1,
});
test('reviewed County source provenance establishes metres without requester declaration',()=>{
  const value=nativeRasterDefinition(image(),request);
  assert.equal(value.verticalFactor,1);
  assert.equal(value.verticalUnitBasis,'reviewed-source-provenance');
  assert.equal(value.verticalUnitEvidence.reportSha256,'4684491d9c720dec0c5e4d5ebb6a3498bc32b3cb168ac56ea6020626d2a656c1');
  assert.equal(value.verticalUnitEvidence.verticalDatum,'unknown');
  assert.equal(nativeRasterDefinition(image(),{...request,sourceVerticalUnit:'m'}).verticalUnitBasis,'reviewed-source-provenance');
});
test('provenance is bound to source, model, version, dimensions and kind, not user evidence',()=>{
  const mutations=[{modelId:'other'},{modelVersionId:'other'},
    ...['id','sha256','byteSize','kind'].map(k=>({source:{...request.source,[k]:k==='byteSize'?1:'other'}}))];
  for(const mutation of mutations)assert.throws(()=>nativeRasterDefinition(image(),{...request,...mutation,verticalUnitEvidence:{verticalUnit:'m'}}),{code:'measurement_source_vertical_units_required'});
  assert.throws(()=>nativeRasterDefinition({...image(),getWidth:()=>19228},request),{code:'measurement_source_vertical_units_required'});
});
test('reviewed evidence cannot override explicit conflicting units or invalid physical transforms',()=>{
  assert.throws(()=>nativeRasterDefinition(image({VerticalUnitsGeoKey:9002}),request),{code:'measurement_source_vertical_units_conflict'});
  assert.throws(()=>nativeRasterDefinition(image(),request,{bandMetadata:{UNITTYPE:'ft'}}),{code:'measurement_source_vertical_units_conflict'});
  assert.throws(()=>nativeRasterDefinition(image({VerticalUnitsGeoKey:9999}),request),{code:'measurement_source_vertical_units_unsupported'});
  assert.throws(()=>nativeRasterDefinition(image(),request,{bandMetadata:{SCALE:'2'}}),{code:'measurement_source_value_transform_unsupported'});
  assert.equal(nativeRasterDefinition(image({VerticalUnitsGeoKey:9001}),request).verticalUnitBasis,'raster-metadata');
});
