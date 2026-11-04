'use strict';
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
function validateSurveyCrs(mapping, points){
 const input=JSON.stringify({epsgCode:mapping.epsgCode,horizontalUnit:mapping.horizontalUnit,points:points.map(p=>({easting:p.easting,northing:p.northing,latitude:p.latitude,longitude:p.longitude}))});
 const result=spawnSync('/usr/bin/python3',['-I',path.join(__dirname,'gcp_validate_crs.py')],{input,encoding:'utf8',timeout:15000,maxBuffer:4096,env:{PATH:'/usr/bin:/bin',PROJ_NETWORK:'OFF'}});
 if(result.error || result.status!==0 || result.stdout.trim()!=='{"ok":true}')
   throw Object.assign(new Error('The projected CRS, horizontal units, or surveyed coordinates could not be verified against the geographic coordinates'),{code:'gcp_crs_unmapped'});
}
function surveyValidationHash(sourceSha256,mapping,points){return crypto.createHash('sha256').update(JSON.stringify([sourceSha256,mapping.epsgCode,mapping.horizontalUnit,mapping.verticalDatum,points.map(p=>[p.id,p.easting,p.northing,p.latitude,p.longitude,p.elevationM])])).digest('hex');}
module.exports={validateSurveyCrs,surveyValidationHash};
