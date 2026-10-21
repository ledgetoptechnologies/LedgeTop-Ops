import test from 'node:test';
import assert from 'node:assert/strict';
import {exportMeasurements} from '../measurement-document.mjs';

const record={id:'example',name:'North face',collection:'spatial3d',kind:'polygon',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices:[[0,0,1],[2,0,1],[2,2,1],[0,2,1]],source:{kind:'mesh'}};
function csvRecord(document){
  const parse=line=>[...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(match=>match[1].replaceAll('""','"'));
  const [headers,row]=document.split('\r\n').map(parse);
  return Object.fromEntries(headers.map((key,index)=>[key,row[index]]));
}
test('CSV retains closed-object volume and provenance without rounding or inventing cut/fill coverage',()=>{
  const result={method:'closed-mesh',status:'complete',volumeM3:1.234567890123,calculationOrigin:'server-original-mesh',verified:false,calculationJobId:'job-1',checks:{closed:true},source:{assetId:'mesh-1',sha256:'abc',modelVersionId:'version-1'},warnings:['Observed enclosure, not material volume.']};
  const row=csvRecord(exportMeasurements([{...record,results:result}],'csv'));
  assert.equal(row.volume_m3,String(result.volumeM3));assert.equal(row.cut_m3,'');assert.equal(row.fill_m3,'');assert.equal(row.coverage,'');
  assert.deepEqual(JSON.parse(row.source_json),result.source);assert.deepEqual(JSON.parse(row.reference_json),{});
  assert.deepEqual(JSON.parse(row.provenance_json),{calculationOrigin:result.calculationOrigin,verified:false,calculationJobId:'job-1',checks:{closed:true}});
  assert.deepEqual(JSON.parse(row.warnings),result.warnings);
});
test('CSV preserves surface reference, zero coverage and numerical model with spreadsheet-safe text',()=>{
  const result={method:'surface-cut-fill',status:'incomplete',cutM3:0,fillM3:1.23456789,netM3:-1.23456789,coverage:0,reference:{type:'custom',elevationM:125.678901,offsetM:0},source:{assetId:'dsm-1',resolutionM:[0.1,0.1]},numericalModel:'native cells',provenance:{tool:'test fixture'}};
  const row=csvRecord(exportMeasurements([{...record,name:'=HYPERLINK("example")',results:result}],'csv'));
  assert.equal(row.name,'\'=HYPERLINK("example")');assert.equal(row.coverage,'0');assert.equal(row.cut_m3,'0');assert.equal(row.fill_m3,'1.23456789');assert.equal(row.net_m3,"'-1.23456789");assert.equal(row.volume_m3,'');
  assert.deepEqual(JSON.parse(row.reference_json),result.reference);assert.deepEqual(JSON.parse(row.source_json),result.source);assert.equal(JSON.parse(row.provenance_json).numericalModel,'native cells');assert.equal(JSON.parse(row.provenance_json).tool,'test fixture');
});
test('CSV geometry-only rows keep calculation quantities empty and record their source',()=>{
  const row=csvRecord(exportMeasurements([record],'csv'));
  for(const key of ['volume_m3','cut_m3','fill_m3','net_m3','coverage'])assert.equal(row[key],'');
  assert.deepEqual(JSON.parse(row.source_json),record.source);assert.deepEqual(JSON.parse(row.provenance_json),{});
});
test('CSV identifies the actual browser DSM source, not the mesh used to draw the boundary',()=>{
  const row=csvRecord(exportMeasurements([{...record,results:{method:'surface-cut-fill',sourceKind:'dsm',sourceResolutionM:[0.2,0.2],modelVersionId:'version-1',calculationOrigin:'browser'}}],'csv'));
  assert.deepEqual(JSON.parse(row.source_json),{kind:'dsm',resolutionM:[0.2,0.2],modelVersionId:'version-1'});
  assert.equal(JSON.parse(row.provenance_json).calculationOrigin,'browser');
});
