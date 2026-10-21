import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {writeArrayBuffer} from 'geotiff';
import {createReference} from '../measurement-volume.mjs';
import {calculateNativeRasterTransect} from '../server/measurementRasterTransect.mjs';
import {validateNativeProfile,exportNativeProfile,profileStation} from '../measurement-native-profile.mjs';

// Source-only cross-layer contract. The exact-container gate independently runs
// the engine suite; raw frontend modules intentionally are not shipped there.
test('real native result passes shipped presentation validation, hover lookup and unrounded CSV export',async t=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'profile-contract-'));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));const file=path.join(directory,'surface.tif');
  const bytes=Buffer.from(writeArrayBuffer(Float64Array.from([-2.123456789,5,-9999,1,...Array(12).fill(0)]),{width:4,height:4,ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,500000,4800004,0],ProjectedCSTypeGeoKey:32616,GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1,VerticalUnitsGeoKey:9001,GDAL_NODATA:'-9999'}));fs.writeFileSync(file,bytes);
  const vertices=[[500000,4800000,0],[500004,4800000,0],[500004,4800004,0],[500000,4800004,0]],reference={type:'custom',elevationM:0,offsetM:0},base=createReference(vertices,reference);
  const request={method:'surface-transect',parentCalculationId:'parent',modelVersionId:'version',collection:'map',coordinateReference:{crs:'EPSG:32616',verticalUnit:'m'},vertices,reference,referencePatches:base.patches.map(p=>p.polygon.map(v=>[v[0],v[1],p.sample(v[0],v[1])])),line:{start:[500000.25,4800003.5],end:[500003.75,4800003.5]},source:{id:'surface',kind:'dsm',sha256:crypto.createHash('sha256').update(bytes).digest('hex'),byteSize:bytes.length}};
  const result=await calculateNativeRasterTransect(file,request);
  assert.equal(validateNativeProfile(result,{line:request.line,parentCalculationId:request.parentCalculationId,source:{assetId:request.source.id,kind:request.source.kind,sha256:request.source.sha256,modelVersionId:request.modelVersionId}}),result);
  assert.equal(result.cellCount,4);assert.equal(result.source.verticalUnitBasis,'raster-metadata');
  const rows=exportNativeProfile(result).split('\r\n');assert.equal(rows.length,result.segments.length+1);assert.ok(rows.some(row=>row.includes('"-2.123456789"')));assert.ok(rows.some(row=>row.includes('"nodata","","",""')));
  const gap=result.segments.find(s=>s.status==='nodata');assert.equal(profileStation(result,(gap.startM+gap.endM)/2).base,null);
  assert.ok(rows.every(row=>row.split(',').length===19));
});
