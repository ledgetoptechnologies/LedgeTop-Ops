import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveEptUtmCrs,resolveEptVerticalUnits} from '../server/measurementEptCrs.mjs';

const horizontal='PROJCS["WGS84 UTM16N",GEOGCS["WGS84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-87],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH]]';
const horizontal2='PROJCRS["WGS84 UTM16N",BASEGEOGCRS["WGS84",DATUM["World Geodetic System 1984",ELLIPSOID["WGS 84",6378137,298.257223563,LENGTHUNIT["metre",1]]]],CONVERSION["UTM16N",METHOD["Transverse Mercator"],PARAMETER["Latitude of natural origin",0,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Longitude of natural origin",-87,ANGLEUNIT["degree",0.0174532925199433]],PARAMETER["Scale factor at natural origin",0.9996,SCALEUNIT["unity",1]],PARAMETER["False easting",500000,LENGTHUNIT["metre",1]],PARAMETER["False northing",0,LENGTHUNIT["metre",1]]],CS[Cartesian,2],AXIS["Easting",east],AXIS["Northing",north],LENGTHUNIT["metre",1]]';
const vertical='VERT_CS["Survey height",VERT_DATUM["Survey datum",2005],UNIT["metre",1],AXIS["Height",UP]]';
const vertical2='VERTCRS["Survey height",VDATUM["Survey datum"],CS[vertical,1],AXIS["Height",up],LENGTHUNIT["metre",1]]';
const compound=(v=vertical,h=horizontal)=>`COMPD_CS["Survey",${h},${v}]`;
const compound2=(v=vertical2,h=horizontal2)=>`COMPOUNDCRS["Survey",${h},${v}]`;
const resolve=srs=>resolveEptVerticalUnits(srs,32616);
const reject=(srs,code)=>assert.throws(()=>resolve(srs),{code});

test('explicit upward vertical WKT1/WKT2 units are independent of horizontal metres',()=>{
  for(const wkt of [compound(),compound2()]){
    assert.equal(resolveEptUtmCrs({wkt},32616),32616);
    assert.deepEqual(resolve({wkt}),{verticalFactor:1,verticalUnitBasis:'ept-vertical-crs',verticalUnit:'m',verticalDatum:'unknown'});
  }
  for(const [name,factor,id] of [['foot',.3048,9002],['US survey foot',1200/3937,9003]]){
    assert.equal(resolve({wkt:compound(vertical.replace('UNIT["metre",1]',`UNIT["${name}",${factor},AUTHORITY["EPSG","${id}"]]`))}).verticalFactor,factor);
  }
  assert.equal(resolve({wkt2:compound2(vertical2.replace('AXIS["Height",up],LENGTHUNIT["metre",1]','AXIS["Height",up,ORDER[1],LENGTHUNIT["metre",1]]'))}).verticalFactor,1);
});

test('horizontal-only CRS, numeric vertical IDs, schema units and confirmations cannot supply absent evidence',()=>{
  for(const srs of [{horizontal:32616},{wkt:horizontal},{wkt2:horizontal2},{wkt:horizontal,verticalUnit:'m',sourceVerticalUnit:'m',schema:[{name:'Z',scale:.001}]}])reject(srs,'measurement_source_vertical_units_required');
  for(const vertical of [5703,'6360'])reject({horizontal:32616,vertical},'measurement_source_vertical_units_unsupported');
  for(const vertical of ['',null,{},'unknown'])reject({horizontal:32616,vertical},'measurement_source_vertical_metadata_invalid');
});

test('unit, authority and multiple-WKT conflicts fail closed',()=>{
  reject({wkt:compound(),wkt2:compound2(vertical2.replace('"metre",1','"foot",0.3048'))},'measurement_source_vertical_units_conflict');
  reject({wkt:compound(vertical.replace('UNIT["metre",1]','UNIT["metre",1,AUTHORITY["EPSG","9002"]]'))},'measurement_source_vertical_units_conflict');
  reject({wkt:compound(vertical.replace('"metre",1','"metre",0.3048'))},'measurement_source_vertical_units_unsupported');
  reject({wkt:compound(vertical.replace('"metre",1','"furlong",201.168'))},'measurement_source_vertical_units_unsupported');
  reject({wkt2:compound2(vertical2.replace('AXIS["Height",up]','AXIS["Height",up,LENGTHUNIT["foot",0.3048]]'))},'measurement_source_vertical_units_conflict');
  const identified=compound(vertical.replace('AXIS["Height",UP]]','AXIS["Height",UP],AUTHORITY["EPSG","5703"]]'));
  assert.equal(resolve({wkt:identified,vertical:5703}).verticalFactor,1);
  reject({wkt:identified,vertical:6360},'measurement_source_vertical_units_conflict');
  reject({wkt:compound(),vertical:5703},'measurement_source_vertical_units_unsupported');
});

test('malformed, downward, transformed, duplicate or ambiguous vertical frames are rejected',()=>{
  for(const v of [vertical.replace('UP','DOWN'),vertical.replace('2005','2006'),vertical.replace('AXIS[','AXIS["Other",UP],AXIS['),vertical.replace('VERT_DATUM["Survey datum",2005]','VERT_DATUM["Survey datum",2005,TOWGS84[0,0,0]]')])reject({wkt:compound(v)},'measurement_source_vertical_metadata_invalid');
  for(const v of [vertical2.replace('vertical,1','vertical,2'),vertical2.replace('up]','up,ORDER[2]]'),vertical2.replace('VDATUM[','DYNAMIC[FRAMEEPOCH[2020]],VDATUM[')])reject({wkt2:compound2(v)},'measurement_source_vertical_metadata_invalid');
  reject({wkt2:compound2(vertical2.replace(',LENGTHUNIT["metre",1]',''))},'measurement_source_vertical_units_required');
  reject({wkt:`COMPD_CS["Survey",${vertical},${horizontal}]`},'measurement_source_vertical_metadata_invalid');
  reject({wkt:compound(vertical,horizontal.replace('-87','-81'))},'measurement_source_crs_mismatch');
  reject({wkt:compound(),horizontal:32617},'measurement_source_crs_mismatch');
  reject({wkt:compound()+'trailing'},'measurement_source_crs_mismatch');
});
