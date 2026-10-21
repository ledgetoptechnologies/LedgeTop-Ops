import test from 'node:test';
import assert from 'node:assert/strict';
import {adminCalculationRequest,priorMeterDeclaration} from '../measurement-admin-dialog.mjs';

test('source review restores meters for another measurement only with matching immutable identity',()=>{
 const record={id:'new-polygon',modelId:'model',modelVersionId:'version',coordinateReference:{crs:'EPSG:32616'}};
 const source={assetId:'cloud',kind:'ept',modelVersionId:'version',byteSize:100,sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
 source.unitEvidence={...source,modelId:'model',crs:'EPSG:32616',verticalUnit:'m',verticalDatum:'unknown',basis:'administrator-reviewed-source'};
 assert.equal(priorMeterDeclaration(record,source,[]),true);
 const converted={...source,unitEvidence:{...source.unitEvidence,basis:'server-verified-ept-conversion',verticalFactor:1}};
 assert.equal(priorMeterDeclaration(record,converted,[]),true);
 assert.equal(priorMeterDeclaration(record,{...converted,unitEvidence:{...converted.unitEvidence,verticalFactor:.3048,verticalUnit:'ft'}},[]),false);
 assert.equal(priorMeterDeclaration(record,{...converted,unitEvidence:{...converted.unitEvidence,verticalFactor:undefined}},[]),false);
 for(const [key,value] of [['modelId','other'],['crs','EPSG:32617'],['byteSize',101],['manifestSha256','c'.repeat(64)],['verticalUnit','ft']]){
   assert.equal(priorMeterDeclaration(record,{...source,unitEvidence:{...source.unitEvidence,[key]:value}},[]),false);
 }
});

test('point calculation leaves encoded units to server without inventing a meter declaration',()=>{
  const record={id:'one',kind:'polygon',revision:2},sources=[{assetId:'cloud',kind:'ept',methods:['point-surface-cut-fill']}];
  const body=adminCalculationRequest(record,{sourceAssetId:'cloud',method:'point-surface-cut-fill',reference:'boundary-triangulated',offsetM:0,cellSizeM:.1,classFilter:'all',confirmMeters:false},sources);
  assert.equal(Object.hasOwn(body,'sourceVerticalUnit'),false);assert.equal(body.cellSizeM,.1);
});
test('reuse staff declaration only for exact measurement/version/source file and EPT closure',()=>{
  const record={id:'one',modelVersionId:'version'},source={assetId:'cloud',kind:'ept',modelVersionId:'version',sha256:'a'.repeat(64),manifestSha256:'b'.repeat(64)};
  const job={measurementId:'one',status:'complete',method:'point-surface-cut-fill',parameters:{sourceAssetId:'cloud',sourceVerticalUnit:'m'},result:{source:{...source,verticalUnit:'m',verticalUnitBasis:'administrator-declared'}}};
  job.result.source.assetId=source.assetId;
  assert.equal(priorMeterDeclaration(record,source,[job]),true);
  for(const modify of [j=>j.measurementId='other',j=>j.status='failed',j=>j.result.source.sha256='c'.repeat(64),j=>j.result.source.manifestSha256='c'.repeat(64),j=>j.result.source.modelVersionId='other',j=>j.result.source.verticalUnitBasis='ept-vertical-crs',j=>j.parameters.sourceVerticalUnit=null]){
    const invalid=structuredClone(job);modify(invalid);assert.equal(priorMeterDeclaration(record,source,[invalid]),false);
  }
  assert.equal(priorMeterDeclaration(record,{...source,sha256:undefined},[job]),false);
  assert.equal(priorMeterDeclaration(record,{...source,modelVersionId:'other'},[job]),false);
  assert.equal(priorMeterDeclaration(record,source,[]),false);
});
