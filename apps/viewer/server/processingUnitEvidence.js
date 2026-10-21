'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {MAX_ARTIFACT_BYTES,resolveOdmSourceUnitProvenance}=require('./odmSourceUnitProvenance');

const changed=()=>{throw Object.assign(new Error('Processing evidence source changed'),{code:'source_changed'});};
async function readArtifact(destination,relativePath,files,signal){
  const entry=files.find(file=>file.relativePath===relativePath);
  if(!entry||entry.byteSize>MAX_ARTIFACT_BYTES)return null;
  signal?.throwIfAborted();
  const absolute=path.join(destination,...relativePath.split('/')),stat=await fs.promises.lstat(absolute);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size!==entry.byteSize)changed();
  // Bounded read even if a concurrently changed file grows after stat.
  const handle=await fs.promises.open(absolute,'r');
  let bytes;
  try{
    bytes=Buffer.alloc(entry.byteSize+1);let length=0;
    while(length<bytes.length){const read=await handle.read(bytes,length,bytes.length-length,length);if(!read.bytesRead)break;length+=read.bytesRead;}
    if(length!==entry.byteSize)changed();bytes=bytes.subarray(0,length);
  }finally{await handle.close();}
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==entry.sha256)changed();
  return{relativePath,bytes};
}

// Async preparation performs no database writes. The caller must recheck the
// ingestion lease and persist these candidates in one synchronous transaction.
async function prepareProcessingUnitEvidence({producer,destination,sourcePrefix,modelId,modelVersionId,assets,signal}){
  if(!producer)return[];
  const files=producer.archiveFiles;
  const logPath=files.some(file=>file.relativePath==='log.json')?'log.json':'assets/log.json';
  const log=await readArtifact(destination,logPath,files,signal),photos=await readArtifact(destination,'images.json',files,signal),coords=await readArtifact(destination,'odm_georeferencing/coords.txt',files,signal);
  if(!log||!photos||!coords)return[];
  const {inspectProcessingRasterUnits}=await import('./processingRasterUnitInspection.mjs');
  const {inspectNativePointUnits}=await import('./nativePointUnitInspection.mjs');
  const candidates=[];
  for(const asset of assets){
    if(!['dsm','dtm','pointCloud'].includes(asset.kind))continue;
    const nativePoint=asset.kind==='pointCloud';
    const relativePath=nativePoint?'odm_georeferencing/odm_georeferenced_model.laz':`odm_dem/${asset.kind}.tif`;
    if(asset.relativePath!==`${sourcePrefix}/${relativePath}`)continue;
    const entry=files.find(file=>file.relativePath===relativePath);
    if(!entry||entry.sha256!==asset.sha256||entry.byteSize!==asset.byteSize)continue;
    let physical;
    try{
      const inspect=nativePoint?inspectNativePointUnits:inspectProcessingRasterUnits;
      physical=await inspect(path.join(destination,...relativePath.split('/')),asset,{signal});
      if(nativePoint&&physical)physical={...physical,verticalUnit:
        physical.originalUnit===null&&physical.verticalFactor===null?null:
          physical.originalUnit==='m'&&physical.verticalFactor===1?'metre':'nonmetre'};
    }
    catch(error){
      // Unsupported/conflicting physical metadata remains unknown; never turn
      // its parse/scale/unit error into an "absent units" metre declaration.
      if(typeof error.code==='string'&&(error.code.startsWith('measurement_')||error.code.startsWith('native_point_metadata_')))continue;
      throw error;
    }
    if(!physical)continue;
    const input={...producer,log,photos,coords,source:{relativePath,kind:asset.kind,sha256:asset.sha256,byteSize:asset.byteSize,...physical}};
    if(resolveOdmSourceUnitProvenance(input).status!=='resolved')continue;
    candidates.push({request:{modelId,modelVersionId,coordinateReference:{crs:`EPSG:${physical.horizontalEpsg}`},source:asset},input});
  }
  return candidates;
}
module.exports={prepareProcessingUnitEvidence};
