import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {pointGridCacheKey,readPointGridCache,writePointGridCache,POINT_GRID_CACHE_SLOTS,POINT_GRID_CACHE_MAX_BYTES} from '../server/measurementPointGridCache.mjs';

test('fixed cache slots bound disk, key collisions miss safely, metadata and checksums are verified',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'point-grid-cache-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const grid={width:2,height:1,bounds:{minE:0,minN:0,maxE:2,maxN:1},values:new Float64Array([5,NaN])};
  for(let i=0;i<40;i++)await writePointGridCache(root,i.toString(16).padStart(8,'0')+'0'.repeat(56),grid,1);
  assert.equal(fs.readdirSync(root).length,POINT_GRID_CACHE_SLOTS);
  assert.equal(await readPointGridCache(root,'0'.repeat(64),grid),null);
  const key=(39).toString(16).padStart(8,'0')+'0'.repeat(56),hit=await readPointGridCache(root,key,grid);
  assert.deepEqual(hit.values,grid.values);
  assert.equal(await readPointGridCache(root,key,{...grid,width:1}),null);
  const slot=path.join(root,'7.grid'),bytes=fs.readFileSync(slot);bytes[bytes.length-1]^=1;fs.writeFileSync(slot,bytes);
  assert.equal(await readPointGridCache(root,key,grid),null);
  assert.equal(await writePointGridCache(root,key,{...grid,values:new Float64Array(POINT_GRID_CACHE_MAX_BYTES/8)},1),false);
});

test('cache evidence includes unit decisions and source manifest file inventory regardless of object key order',()=>{
  const request={vertices:[[0,0,0],[1,0,0],[1,1,0]],cellSizeM:1,source:{id:'a',sha256:'b'},coordinateReference:{crs:'EPSG:32616'}},files=new Map([['a',{byteSize:5,sha256:'abc'}]]),vertical={verticalFactor:1};
  const key=pointGridCacheKey('root',request,files,vertical);
  assert.equal(pointGridCacheKey('root',{...request,source:{sha256:'b',id:'a'},sourceVerticalUnit:null},files,vertical),key);
  assert.notEqual(pointGridCacheKey('root',{...request,sourceUnitEvidence:{basis:'verified-pipeline',revision:1}},files,vertical),key);
  assert.notEqual(pointGridCacheKey('root',request,new Map([['a',{byteSize:5,sha256:'changed'}]]),vertical),key);
  assert.notEqual(pointGridCacheKey('root',request,files,{verticalFactor:.3048}),key);
});
