'use strict';
// Archive-entry presence is diagnostic only; it is not a tileset validation.
function processingOutputWarnings(attempt,archive){
  if(attempt?.options?.['3d-tiles']!==true||!Array.isArray(archive?.archiveFiles))return [];
  const paths=new Set(archive.archiveFiles.map(file=>file?.relativePath).filter(path=>typeof path==='string'));
  return [
    ['3d_tiles/model/tileset.json','mesh_3d_tiles_missing','Requested mesh 3D Tiles were not found in the processing archive.'],
    ['3d_tiles/pointcloud/tileset.json','pointcloud_3d_tiles_missing','Requested point-cloud 3D Tiles were not found in the processing archive.'],
  ].filter(([path])=>!paths.has(path)).map(([,code,message])=>({code,message}));
}
module.exports={processingOutputWarnings};
