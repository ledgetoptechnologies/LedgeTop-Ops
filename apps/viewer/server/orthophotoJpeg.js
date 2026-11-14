'use strict';

const path=require('node:path');
const MAX_DIMENSION=65500;
const LIMITS=Object.freeze({maxDimension:MAX_DIMENSION,stripeBytes:16*1024*1024,
  gdalCacheBytes:32*1024*1024,threads:1,minimumFreeReserveBytes:64*1024*1024});
const JPEG=Object.freeze({quality:90,progressive:false,writeMetadata:false});
const fail=code=>{throw Object.assign(new Error(code),{code});};
const identifier=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
function localPath(value){
  return typeof value==='string'&&value.length<=4096&&value!=='/'&&!value.endsWith('/')&&value.startsWith('/')&&
    !/[\x00-\x1f\\:]/.test(value)&&!value.startsWith('//')&&
    !value.startsWith('/vsi')&&path.posix.normalize(value)===value;
}

// Pure source contract. This does not start a converter, admit server work,
// register a product, publish it, or change download permissions.
function createOrthophotoJpegPlan({asset,sourceVersionId,operationId,stagingParent,width,height,backgroundRgb=[255,255,255]}){
  if(!asset||asset.kind!=='ortho'||!identifier(asset.id)||!identifier(sourceVersionId)||!uuid(operationId))fail('invalid_jpeg_source_identity');
  if(!localPath(asset.absolutePath)||!localPath(stagingParent)||!/^\.(?:tif|tiff)$/i.test(path.posix.extname(asset.absolutePath)))fail('invalid_jpeg_local_path');
  if(!/^[a-f0-9]{64}$/.test(asset.sha256)||!Number.isSafeInteger(asset.byteSize)||asset.byteSize<=0)fail('invalid_jpeg_source_integrity');
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1)fail('invalid_jpeg_dimensions');
  if(width>MAX_DIMENSION||height>MAX_DIMENSION)fail('full_resolution_jpeg_dimension_limit');
  if(!Array.isArray(backgroundRgb)||backgroundRgb.length!==3||backgroundRgb.some(v=>!Number.isInteger(v)||v<0||v>255))fail('invalid_jpeg_background');
  const stagingName=`ortho-jpeg-${operationId}`;
  const stagingPath=path.posix.join(stagingParent,stagingName);
  if(asset.absolutePath===stagingParent||asset.absolutePath.startsWith(stagingParent+'/')||stagingPath.startsWith(asset.absolutePath+'/'))fail('jpeg_source_staging_overlap');
  return {schemaVersion:1,kind:'orthophoto-jpeg-v1',operationId,sourceAssetId:asset.id,sourceVersionId,
    sourceSha256:asset.sha256,sourceByteSize:asset.byteSize,sourcePath:asset.absolutePath,
    stagingParent,stagingName,width,height,backgroundRgb:[...backgroundRgb],limits:{...LIMITS},jpeg:{...JPEG}};
}

function requiredJpegScratchBytes(width,height){
  if(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>MAX_DIMENSION||height>MAX_DIMENSION)fail('invalid_jpeg_dimensions');
  // Uncompressed disk-backed RGB TIFF plus conservative JPEG output allowance.
  return 2*width*height*3+LIMITS.minimumFreeReserveBytes;
}

module.exports={createOrthophotoJpegPlan,requiredJpegScratchBytes,MAX_DIMENSION,LIMITS,JPEG};
