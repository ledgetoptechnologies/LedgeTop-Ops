import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {resolveEptUtmCrs} from '../server/measurementEptCrs.mjs';
import {calculatePointSurface} from '../server/measurementPointSurface.mjs';

// Exact projection strings from the supplied retained EPT, with no point data or
// private identifiers. They lack a top-level horizontal EPSG identifier.
const wkt='PROJCS["unknown",GEOGCS["unknown",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
const wkt2='PROJCRS["unknown",BASEGEOGCRS["unknown",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ID["EPSG",6326]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8901]]],CONVERSION["UTM zone 16N",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],PARAMETER["Longitude of natural origin",-87,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1],ID["EPSG",8805]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1],ID["EPSG",8806]],PARAMETER["False northing",0,LENGTHUNIT["metre",1],ID["EPSG",8807]],ID["EPSG",16016]],CS[Cartesian,2],AXIS["easting",east,ORDER[1],LENGTHUNIT["metre",1,ID["EPSG",9001]]],AXIS["northing",north,ORDER[2],LENGTHUNIT["metre",1,ID["EPSG",9001]]]]';
const rejects=(srs,expected=32616)=>assert.throws(()=>resolveEptUtmCrs(srs,expected),{code:'measurement_source_crs_mismatch'});

// Canonical GDAL/PROJ WKT2:2019 output, whitespace compacted only, from
// https://gdal.org/en/stable/programs/gdalsrsinfo.html#example-3-wkt-output-latest-version
// Unlike the retained WKT above this contains a WGS84 ensemble and USAGE.
const canonical32722='PROJCRS["WGS 84 / UTM zone 22S",BASEGEOGCRS["WGS 84",ENSEMBLE["World Geodetic System 1984 ensemble",MEMBER["World Geodetic System 1984 (Transit)"],MEMBER["World Geodetic System 1984 (G730)"],MEMBER["World Geodetic System 1984 (G873)"],MEMBER["World Geodetic System 1984 (G1150)"],MEMBER["World Geodetic System 1984 (G1674)"],MEMBER["World Geodetic System 1984 (G1762)"],MEMBER["World Geodetic System 1984 (G2139)"],ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]],ENSEMBLEACCURACY[2.0]],PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]],ID["EPSG",4326]],CONVERSION["UTM zone 22S",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8801]],PARAMETER["Longitude of natural origin",-51,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8802]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1],ID["EPSG",8805]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1],ID["EPSG",8806]],PARAMETER["False northing",10000000,LENGTHUNIT["metre",1],ID["EPSG",8807]]],CS[Cartesian,2],AXIS["(E)",east,ORDER[1],LENGTHUNIT["metre",1]],AXIS["(N)",north,ORDER[2],LENGTHUNIT["metre",1]],USAGE[SCOPE["Navigation and medium accuracy spatial referencing."],AREA["Between 54°W and 48°W, southern hemisphere between 80°S and equator, onshore and offshore. Brazil. Uruguay."],BBOX[-80,-54,0,-48]],ID["EPSG",32722]]';

test('numeric plus canonical GDAL/PROJ ensemble WKT retains compatibility without skipping validation',()=>{
  for(const srs of [{wkt2:canonical32722},{horizontal:32722,wkt:canonical32722}])assert.equal(resolveEptUtmCrs(srs,32722),32722);
  // Member IDs and G2296 are from EPSG itself, not inferred from member labels:
  // https://epsg.org/crs/wkt/id/32721 . EPSG's 9102 degree has the same factor.
  const ids=[['Transit',1166],['G730',1152],['G873',1153],['G1150',1154],['G1674',1155],['G1762',1156],['G2139',1309]];
  let identified=canonical32722;for(const [name,code] of ids)identified=identified.replace(`MEMBER["World Geodetic System 1984 (${name})"]`,`MEMBER["World Geodetic System 1984 (${name})",ID["EPSG",${code}]]`);
  identified=identified.replace('ELLIPSOID[','MEMBER["World Geodetic System 1984 (G2296)",ID["EPSG",1383]],ELLIPSOID[').replace('ENSEMBLEACCURACY[2.0]','ENSEMBLEACCURACY[2.0],ID["EPSG",6326]').replaceAll('ANGLEUNIT["degree",0.0174532925199433]','ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9102]]');
  assert.equal(resolveEptUtmCrs({horizontal:32722,wkt2:identified},32722),32722);
  for(const changed of [identified.replace('1383','1309'),identified.replace('(G2296)','(Unknown)'),identified.replace('6326','6269'),identified.replace('6378137','6378138'),identified.replace('ENSEMBLEACCURACY[2.0]','ENSEMBLEACCURACY[20]'),identified.replace('World Geodetic System 1984 ensemble','Other ensemble'),identified.replace('0.0174532925199433','1'),identified.replace('9102','9101'),identified.replace('MEMBER["World Geodetic System 1984 (G730)",ID["EPSG",1152]],',''),identified.replace('(G730)','(Transit)'),identified.replace('ENSEMBLE[','DATUM["WGS_1984"],ENSEMBLE[')])rejects({horizontal:32722,wkt2:changed},32722);
  rejects({horizontal:32722,wkt2:canonical32722.replace('-51','-57')},32722);
});
test('exact EPSG registry WKT with CS identity and implicit axis order is validated',()=>{
  // Exact EPSG registry definition, whitespace compacted only:
  // https://epsg.org/crs/wkt/id/32721 (retrieved 2026-09-08).
  const epsg32721='PROJCRS["WGS 84 / UTM zone 21S",BASEGEOGCRS["WGS 84",ENSEMBLE["World Geodetic System 1984 ensemble",MEMBER["World Geodetic System 1984 (Transit)",ID["EPSG",1166]],MEMBER["World Geodetic System 1984 (G730)",ID["EPSG",1152]],MEMBER["World Geodetic System 1984 (G873)",ID["EPSG",1153]],MEMBER["World Geodetic System 1984 (G1150)",ID["EPSG",1154]],MEMBER["World Geodetic System 1984 (G1674)",ID["EPSG",1155]],MEMBER["World Geodetic System 1984 (G1762)",ID["EPSG",1156]],MEMBER["World Geodetic System 1984 (G2139)",ID["EPSG",1309]],MEMBER["World Geodetic System 1984 (G2296)",ID["EPSG",1383]],ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1,ID["EPSG",9001]],ID["EPSG",7030]],ENSEMBLEACCURACY[2],ID["EPSG",6326]],ID["EPSG",4326]],CONVERSION["UTM zone 21S",METHOD["Transverse Mercator",ID["EPSG",9807]],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9102]],ID["EPSG",8801]],PARAMETER["Longitude of natural origin",-57,ANGLEUNIT["degree",0.0174532925199433,ID["EPSG",9102]],ID["EPSG",8802]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1,ID["EPSG",9201]],ID["EPSG",8805]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1,ID["EPSG",9001]],ID["EPSG",8806]],PARAMETER["False northing",10000000,LENGTHUNIT["metre",1,ID["EPSG",9001]],ID["EPSG",8807]],ID["EPSG",16121]],CS[Cartesian,2,ID["EPSG",4400]],AXIS["Easting (E)",east],AXIS["Northing (N)",north],LENGTHUNIT["metre",1,ID["EPSG",9001]],ID["EPSG",32721]]';
  for(const srs of [{wkt2:epsg32721},{horizontal:32721,wkt2:epsg32721}])assert.equal(resolveEptUtmCrs(srs,32721),32721);
  for(const changed of [epsg32721.replace('4400','4401'),epsg32721.replace('CS[Cartesian,2','CS[Cartesian,3'),epsg32721.replace('east]','east,ORDER[2]]'),epsg32721.replace('east]','east,ORDER[1],ORDER[1]]'),epsg32721.replace('east]','north]'),epsg32721.replace('north]','south]'),epsg32721.replace('CS[Cartesian,2,ID["EPSG",4400]]','CS[Cartesian,2,ID["EPSG",4400],ID["EPSG",4400]]')])rejects({horizontal:32721,wkt2:changed},32721);
  assert.equal(resolveEptUtmCrs({horizontal:32721,wkt2:epsg32721.replace('east]','east,ORDER[1]]').replace('north]','north,ORDER[2]]')},32721),32721);
});
test('identity-only WKT1 TOWGS84 supports exactly three or seven finite zero parameters',()=>{
  for(const values of ['0,0,0','0,0,0,0,0,0,0','-0,0e0,0.0']){
    const modified=wkt.replace('DATUM["WGS_1984",',`DATUM["WGS_1984",TOWGS84[${values}],`);assert.equal(resolveEptUtmCrs({horizontal:32616,wkt:modified},32616),32616);
  }
  for(const values of ['0,0','0,0,0,0','0,0,0,0,0,0','0,0,0,0,0,0,0,0','0,0,1e-14','0,0,0,0,0,0,1','"0",0,0','NaN,0,0','1e999,0,0'])rejects({horizontal:32616,wkt:wkt.replace('DATUM["WGS_1984",',`DATUM["WGS_1984",TOWGS84[${values}],`)});
  rejects({horizontal:32616,wkt:wkt.replace('DATUM["WGS_1984",','DATUM["WGS_1984",TOWGS84[0,0,0],TOWGS84[0,0,0],')});
});
test('bounded WKT2 descriptive metadata cannot conceal transformations or malformed content',()=>{
  const usage='USAGE[SCOPE["Survey"],AREA["Area"],BBOX[0,-90,84,-84]]';
  for(const extra of [usage,'REMARK["Source survey"]',`${usage},REMARK["Source survey"]`])assert.equal(resolveEptUtmCrs({horizontal:32616,wkt2:wkt2.slice(0,-1)+','+extra+']'},32616),32616);
  for(const extra of ['USAGE[SCOPE["Survey"],AREA["Area"],BBOX[0,-90,84,-84],TOWGS84[0,0,0]]','USAGE[SCOPE["Survey"],AREA["Area"],BBOX[85,-90,84,-84]]','USAGE[SCOPE["Survey"],AREA["Area"],BBOX[-91,-90,84,-84]]','USAGE[SCOPE["Survey"],AREA["Area"],BBOX[0,-181,84,-84]]','USAGE[SCOPE["Survey"],AREA["Area"],BBOX[0,-90,84]]','USAGE[SCOPE["Survey"],AREA["Area"],BBOX[0,-90,84,"-84"]]','USAGE[SCOPE["Survey"],BBOX[0,-90,84,-84]]','REMARK["Text",TOWGS84[1,0,0]]','REMARK[1]','REMARK["a"],REMARK["b"]',`${usage},${usage}`])rejects({horizontal:32616,wkt2:wkt2.slice(0,-1)+','+extra+']'});
});
test('both documented degree authorities retain numeric plus WKT1 compatibility only at degree factor',()=>{
  for(const code of ['9102','9122'])assert.equal(resolveEptUtmCrs({horizontal:32616,wkt:wkt.replace('9122',code)},32616),32616);
  rejects({horizontal:32616,wkt:wkt.replace('9122','9102').replace('0.0174532925199433','1')});
});
test('omitted WKT2 Greenwich follows OGC default only after validated WGS84 base',()=>{
  // https://docs.ogc.org/is/12-063r5/12-063r5.html section 8.2.2;
  // https://proj.org/en/stable/development/reference/cpp/io.html .
  const omitted=wkt2.replace(',PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433],ID["EPSG",8901]]','');
  assert.equal(resolveEptUtmCrs({horizontal:32616,wkt2:omitted},32616),32616);
  assert.equal(resolveEptUtmCrs({horizontal:32722,wkt2:canonical32722.replace(',PRIMEM["Greenwich",0,ANGLEUNIT["degree",0.0174532925199433]]','')},32722),32722);
  rejects({horizontal:32616,wkt2:omitted.replace('World Geodetic System 1984','Other datum')});
  for(const changed of [wkt2.replace('Greenwich",0','Greenwich",1'),wkt2.replace('8901','8903'),wkt2.replace('Greenwich','Paris')])rejects({horizontal:32616,wkt2:changed});
  rejects({horizontal:32616,wkt:wkt.replace(',PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]]','')});
});

test('supplied WKT1 and WKT2 independently identify WGS84 UTM16N without numeric code',()=>{
  for(const srs of [{wkt},{wkt:wkt2},{wkt2},{wkt,wkt2},{authority:'EPSG',horizontal:'32616',wkt,wkt2}])assert.equal(resolveEptUtmCrs(srs,32616),32616);
});
test('legacy numeric declarations remain supported, without widening supported CRS families',()=>{
  for(const srs of [{horizontal:'32616'},{code:32616},{authority:'EPSG',horizontal:32616,code:'32616'}])assert.equal(resolveEptUtmCrs(srs,32616),32616);
  for(const srs of [{},{horizontal:3857},{horizontal:'EPSG:32616'},{horizontal:null},{authority:'ESRI',horizontal:32616},{authority:'EPSG'},{horizontal:'32616',code:'32617'}])rejects(srs);
  for(const expected of [3857,4326,32600,32661,32700,32761,32616.5])rejects({horizontal:expected},expected);
});
test('numeric code, WKT pair and top-level authority conflicts never use a permissive fallback',()=>{
  rejects({horizontal:'32617',wkt});rejects({horizontal:'32616',wkt:wkt.replace('-87','-81')});rejects({wkt,wkt2:wkt2.replace('-87','-81')});
  rejects({wkt:wkt.slice(0,-1)+',AUTHORITY["EPSG","32617"]]'});
  rejects({wkt2:wkt2.slice(0,-1)+',ID["EPSG",32716]]'});
  rejects({horizontal:32616,wkt:'not valid WKT'});
});
test('projection parameters and hemisphere are verified rather than inferred from labels',()=>{
  for(const changed of [wkt.replace('latitude_of_origin",0','latitude_of_origin",1'),wkt.replace('-87','-88'),wkt.replace('0.9996','1'),wkt.replace('500000','400000'),wkt.replace('false_northing",0','false_northing",10000000'),wkt.replace('Transverse_Mercator','Mercator')])rejects({wkt:changed});
  const south=wkt.replace('false_northing",0','false_northing",10000000');assert.equal(resolveEptUtmCrs({wkt:south},32716),32716);
  const south2=wkt2.replace('False northing",0','False northing",10000000').replace('16016','16116');assert.equal(resolveEptUtmCrs({wkt2:south2},32716),32716);
  rejects({wkt2:wkt2.replace('False northing",0','False northing",10000000')},32716);
  assert.equal(resolveEptUtmCrs({wkt:wkt.replace('-87','-81')},32617),32617);
});
test('datum, ellipsoid, prime meridian, horizontal units and axis direction/order remain strict',()=>{
  for(const changed of [wkt.replace('WGS_1984','NAD83'),wkt.replace('6326','6269'),wkt.replace('6378137','6378138'),wkt.replace('298.257223563','298.257222101'),wkt.replace('Greenwich",0','Greenwich",1'),wkt.replace('UNIT["metre",1','UNIT["foot",0.3048'),wkt.replace('9001','9002'),wkt.replace('Easting",EAST','Easting",WEST')])rejects({wkt:changed});
  for(const changed of [wkt2.replace('ORDER[1]','ORDER[2]'),wkt2.replace('CS[Cartesian,2]','CS[Cartesian,3]'),wkt2.replace('easting",east','easting",north'),wkt2.replace('LENGTHUNIT["metre",1','LENGTHUNIT["foot",0.3048'),wkt2.replace('ANGLEUNIT["degree",0.0174532925199433]','ANGLEUNIT["radian",1]')])rejects({wkt2:changed});
});
test('malformed, duplicate, extra transformation and excessive WKT input fail closed',()=>{
  for(const changed of [wkt.slice(0,-1),wkt+'trailing',wkt.replace('PARAMETER["latitude_of_origin",0]','PARAMETER["latitude_of_origin",0],PARAMETER["latitude_of_origin",0]'),wkt.replace('DATUM["WGS_1984",','DATUM["WGS_1984",TOWGS84[1,0,0],'),wkt.replace('0.9996','1e999'),`COMPD_CS["compound",${wkt}]`,'X['.repeat(100)+'1'+']'.repeat(100),' '.repeat(32769)])rejects({wkt:changed});
});
test('WKT-only source reaches real all-node point calculation but does not establish vertical units',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'measurement-wkt-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'ept-hierarchy'));fs.mkdirSync(path.join(root,'ept-data'));
  const files=[],write=(relative,value)=>{const bytes=Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));fs.writeFileSync(path.join(root,relative),bytes);const identity={relativePath:relative,byteSize:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};files.push(identity);return identity;};
  const manifest=write('ept.json',{srs:{wkt,wkt2},bounds:[0,0,0,1,1,2],dataType:'binary',schema:['X','Y','Z'].map(name=>({name,type:'floating',size:8}))});write('ept-hierarchy/0-0-0-0.json',{'0-0-0-0':1});const points=Buffer.alloc(24);[.5,.5,2].forEach((n,i)=>points.writeDoubleLE(n,i*8));write('ept-data/0-0-0-0.bin',points);
  const request={vertices:[[0,0,0],[1,0,0],[1,1,0],[0,1,0]],reference:{type:'custom',elevationM:0},coordinateReference:{crs:'EPSG:32616'},cellSizeM:1,source:{id:'test',byteSize:manifest.byteSize,sha256:manifest.sha256},modelVersionId:'test'};
  await assert.rejects(calculatePointSurface(path.join(root,'ept.json'),request,{sourceFiles:files}),{code:'measurement_source_vertical_units_required'});
  const result=await calculatePointSurface(path.join(root,'ept.json'),{...request,sourceVerticalUnit:'m'},{sourceFiles:files});assert.equal(result.cutM3,2);assert.equal(result.source.pointsRead,1);assert.equal(result.source.allIntersectingHierarchyLevels,true);assert.equal(result.source.crs,'EPSG:32616');assert.equal(result.source.verticalUnitBasis,'administrator-declared');
  await assert.rejects(calculatePointSurface(path.join(root,'ept.json'),{...request,coordinateReference:{crs:'EPSG:32617'},sourceVerticalUnit:'m'},{sourceFiles:files}),{code:'measurement_source_crs_mismatch'});
});
