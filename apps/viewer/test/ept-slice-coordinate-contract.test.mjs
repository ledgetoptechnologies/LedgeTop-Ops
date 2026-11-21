import test from 'node:test';
import assert from 'node:assert/strict';
import {validateEptNativeCoordinates} from '../ept-slice-coordinate-contract.mjs';

const bounds={min:[-120,30,0],max:[-119,31,50]};
test('native coordinates stay generic when CRS or units are unknown',()=>{
  const result=validateEptNativeCoordinates({bounds});
  assert.equal(result.crs,null);assert.equal(result.horizontalUnit,null);assert.equal(result.verticalUnit,null);
  assert.deepEqual(result.labels,{easting:'X (native)',northing:'Y (native)',elevation:'Z (native)'});
  bounds.min[0]=-100;assert.equal(result.bounds.min[0],-120);bounds.min[0]=-120;
});
test('only explicitly supplied finite metadata is retained',()=>{
  const result=validateEptNativeCoordinates({bounds,crs:'EPSG:4326',horizontalUnit:null,verticalUnit:'m'});
  assert.equal(result.crs,'EPSG:4326');assert.equal(result.horizontalUnit,null);assert.equal(result.verticalUnit,'m');
  for(const invalid of [{bounds,crs:''},{bounds,crs:' EPSG:4326'},{bounds,verticalUnit:'feet'},{bounds,horizontalUnit:'degree'},{bounds:{min:[0,0,0],max:[NaN,1,1]}}])
    assert.throws(()=>validateEptNativeCoordinates(invalid));
});
