'use strict';
const crypto=require('node:crypto');
const {safeRelativePath}=require('./processingSecurity');
// Archive-entry presence is diagnostic only; it is not a tileset validation.
function processingOutputWarnings(attempt,archive){
  if(attempt?.options?.['3d-tiles']!==true)return [];
  const unknown=[{code:'3d_tiles_inventory_unavailable',message:'The processing archive inventory is unavailable or invalid, so 3D Tiles presence is unknown.'}],digest=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value),seen=new Set(),files=[];
  if(typeof attempt.id!=='string'||!attempt.id||typeof attempt.providerTaskId!=='string'||!attempt.providerTaskId||archive?.schemaVersion!==1||archive.attemptId!==attempt.id||archive.providerTaskId!==attempt.providerTaskId||!digest(archive.archiveSha256)||!digest(archive.archiveManifestSha256)||(archive.archiveByteSize!==null&&(!Number.isSafeInteger(archive.archiveByteSize)||archive.archiveByteSize<=0))||!Array.isArray(archive.archiveFiles)||!archive.archiveFiles.length||archive.archiveFiles.length>100000)return unknown;
  for(const file of archive.archiveFiles){if(!file||typeof file.relativePath!=='string'||file.relativePath.includes('\\')||safeRelativePath(file.relativePath)!==file.relativePath||seen.has(file.relativePath.toLowerCase())||!Number.isSafeInteger(file.byteSize)||file.byteSize<0||!digest(file.sha256))return unknown;seen.add(file.relativePath.toLowerCase());files.push({relativePath:file.relativePath,byteSize:file.byteSize,sha256:file.sha256});}
  if(crypto.createHash('sha256').update(JSON.stringify(files)).digest('hex')!==archive.archiveManifestSha256)return unknown;
  const paths=new Set(files.map(file=>file.relativePath));
  return [
    ['3d_tiles/model/tileset.json','mesh_3d_tiles_missing','Requested mesh 3D Tiles were not found in the processing archive.'],
    ['3d_tiles/pointcloud/tileset.json','pointcloud_3d_tiles_missing','Requested point-cloud 3D Tiles were not found in the processing archive.'],
  ].filter(([path])=>!paths.has(path)).map(([,code,message])=>({code,message}));
}
module.exports={processingOutputWarnings};
