'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { setTimeout: pause } = require('node:timers/promises');
const auth = require('../server/auth');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { StorageManager } = require('../server/storageManager');
const { createProcessingApi } = require('../server/processingApi');

test('storage endpoint preserves space DTO and adds eventually measured usage without writes', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(),'viewer-storage-api-'));
  const config = Object.fromEntries(['datasets','models','cache','trash'].map(key=>[`${key}Mount`,path.join(base,key)]));
  for(const dir of Object.values(config))await fs.mkdir(dir);
  config.storageReserveBytes=0; config.storageReservePercent=0;
  const db=openDatabase(path.join(base,'viewer.sqlite')), repository=new ViewerRepository(db), processing=new ProcessingRepository(db),storage=new StorageManager(config);
  const token='storage-census-read-only-token-00000000000000';
  processing.createAdminSession({tokenHash:auth.hashToken(token),subject:'ops:reader',permissions:['viewer.datasets.read'],displayUnits:'imperial',expiresAt:new Date(Date.now()+60000).toISOString()});
  await fs.writeFile(path.join(config.modelsMount,'unknown.bin'),Buffer.alloc(12)); await fs.writeFile(path.join(config.cacheMount,'active-import.bin'),Buffer.alloc(8));
  const app=express(); app.use(createProcessingApi({repository,processing,storage}));
  const server=await new Promise(resolve=>{const instance=app.listen(0,'127.0.0.1',()=>resolve(instance));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();await fs.rm(base,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}/api/v1/storage`, headers={authorization:`Bearer ${token}`};
  assert.equal((await fetch(url)).status,401);
  const first=await(await fetch(url,{headers})).json(); assert.equal(first.usage.status,'pending'); assert.equal(typeof first.storage.models.total,'number'); assert.ok(first.trash);
  let result=first;
  for(let i=0;i<100&&result.usage.status==='pending';i++){await pause(10); result=await(await fetch(url,{headers})).json();}
  assert.equal(result.usage.status,'complete'); assert.equal(result.usage.totalBytes,20); assert.equal(result.usage.categories.cache.bytes,8); assert.equal(result.usage.categories.other.bytes,12);
  assert.equal((await fs.stat(path.join(config.cacheMount,'active-import.bin'))).size,8);
});
