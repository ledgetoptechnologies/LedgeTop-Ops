'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{processingOutputWarnings:warnings}=require('../server/processingOutputWarnings');
const attempt={options:{'3d-tiles':true}},files=(...paths)=>({archiveFiles:paths.map(relativePath=>({relativePath}))});
test('requested 3D Tiles are reported independently from the recorded archive listing',()=>{
  assert.deepEqual(warnings(attempt,files()).map(x=>x.code),['mesh_3d_tiles_missing','pointcloud_3d_tiles_missing']);
  assert.deepEqual(warnings(attempt,files('3d_tiles/model/tileset.json')).map(x=>x.code),['pointcloud_3d_tiles_missing']);
  assert.deepEqual(warnings(attempt,files('3d_tiles/pointcloud/tileset.json')).map(x=>x.code),['mesh_3d_tiles_missing']);
  assert.deepEqual(warnings(attempt,files('3d_tiles/model/tileset.json','3d_tiles/pointcloud/tileset.json')),[]);
  assert.deepEqual(warnings({options:{}},files()),[]);assert.deepEqual(warnings({options:{'3d-tiles':false}},files()),[]);assert.deepEqual(warnings(attempt,null),[]);
});
