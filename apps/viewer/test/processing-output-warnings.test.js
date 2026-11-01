'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),{processingOutputWarnings:warnings}=require('../server/processingOutputWarnings');
const attempt={id:'attempt',providerTaskId:'provider-task',options:{'3d-tiles':true}},sha=x=>crypto.createHash('sha256').update(x).digest('hex');
function files(...paths){const archiveFiles=paths.map(relativePath=>({relativePath,byteSize:1,sha256:sha('x')}));return{schemaVersion:1,attemptId:attempt.id,providerTaskId:attempt.providerTaskId,archiveSha256:sha('zip'),archiveByteSize:100,archiveFiles,archiveManifestSha256:sha(JSON.stringify(archiveFiles))};}
test('requested 3D Tiles are reported independently from the recorded archive listing',()=>{
  assert.deepEqual(warnings(attempt,files('other.txt')).map(x=>x.code),['mesh_3d_tiles_missing','pointcloud_3d_tiles_missing']);
  assert.deepEqual(warnings(attempt,files('3d_tiles/model/tileset.json')).map(x=>x.code),['pointcloud_3d_tiles_missing']);
  assert.match(warnings(attempt,files('3d_tiles/model/tileset.json'))[0].message,/Viewer uses EPT.*when an EPT asset is available/);
  assert.deepEqual(warnings(attempt,files('3d_tiles/pointcloud/tileset.json')).map(x=>x.code),['mesh_3d_tiles_missing']);
  assert.deepEqual(warnings(attempt,files('3d_tiles/model/tileset.json','3d_tiles/pointcloud/tileset.json')),[]);
  assert.deepEqual(warnings({...attempt,options:{}},files('other.txt')),[]);assert.deepEqual(warnings({...attempt,options:{'3d-tiles':false}},files('other.txt')),[]);
});
test('absent, malformed, truncated or mismatched inventory reports unknown, not missing',()=>{
  const valid=files('other.txt','another.txt'),cases=[null,files(),{...valid,attemptId:'other'},{...valid,providerTaskId:'other'},{...valid,archiveSha256:'invalid'},{...valid,archiveFiles:valid.archiveFiles.slice(0,1)},{...valid,archiveManifestSha256:sha('wrong')},{...valid,archiveFiles:Array(10001).fill(valid.archiveFiles[0])},{...valid,archiveFiles:[{relativePath:'../unsafe',byteSize:1,sha256:sha('x')}]},{...valid,archiveFiles:[valid.archiveFiles[0],valid.archiveFiles[0]]}];
  for(const item of cases)assert.deepEqual(warnings(attempt,item).map(x=>x.code),['3d_tiles_inventory_unavailable']);
});
test('ODM-shaped inventory with EPT and mesh tiles but no point-cloud tileset reports only the provider point-cloud notice',()=>{
  const synthetic=files('entwine_pointcloud/ept.json','odm_georeferencing/odm_georeferenced_model.laz','odm_texturing/odm_textured_model_geo.obj','odm_texturing/odm_textured_model_geo.glb','odm_orthophoto/odm_orthophoto.tif','3d_tiles/model/tileset.json','3d_tiles/pointcloud/entwine/ept.json');
  const result=warnings(attempt,synthetic);assert.deepEqual(result.map(item=>item.code),['pointcloud_3d_tiles_missing']);assert.match(result[0].message,/Viewer uses EPT/);
});
