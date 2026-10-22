'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { measureStorageUsage, createStorageUsageMonitor, registryCategories } = require('../server/storageUsage');

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'viewer-usage-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const roots = Object.fromEntries(['datasets','models','cache','trash'].map(key => [key, path.join(base,key)]));
  for (const root of Object.values(roots)) await fs.mkdir(root);
  const put = async (key, file, size) => { const target = path.join(roots[key],file); await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,Buffer.alloc(size)); return target; };
  return { roots, put, base };
}

test('same filesystem categories measure files, never repeat filesystem usage; hardlinks count once', async t => {
  const {roots,put} = await fixture(t), photo = await put('models','camera-photos/a.jpg',11), model = await put('models','mesh.glb',23);
  await put('cache','temporary.bin',7); await put('trash','removed.bin',5); await put('models','unregistered.json',3);
  await fs.link(model,path.join(roots.models,'mesh-copy.glb'));
  const result = await measureStorageUsage({roots,categories:new Map([[photo,'sources'],[model,'products'],[path.join(roots.models,'mesh-copy.glb'),'products']])});
  assert.equal(result.status,'complete'); assert.equal(result.totalBytes,49);
  assert.deepEqual(Object.fromEntries(Object.entries(result.categories).map(([key,value])=>[key,value.bytes])),{sources:11,products:23,cache:7,trash:5,other:3});
  assert.equal(result.filesystems.length,1);
});

test('nested/identical roots and import drop are counted once with most-specific category',async t=>{
  const {roots,put}=await fixture(t); roots.datasets=roots.models; roots.cache=path.join(roots.models,'cache'); await fs.mkdir(roots.cache); roots.dataset_import=path.join(roots.models,'incoming'); await fs.mkdir(roots.dataset_import);
  await put('models','a.bin',2); await put('cache','a.bin',3); await put('dataset_import','backup.zip',5);
  const value=await measureStorageUsage({roots,categories:new Map()}); assert.equal(value.totalBytes,10); assert.equal(value.categories.cache.bytes,8); assert.equal(value.categories.other.bytes,2);
});

test('live originals and products win over hardlink aliases in cache and trash without double counting',async t=>{
  const {roots,put}=await fixture(t);
  const photo=await put('models','retained/photos/original.jpg',17),product=await put('models','retained/tiles/detail.b3dm',29);
  await fs.link(photo,path.join(roots.trash,'photo-alias.jpg'));
  await fs.link(product,path.join(roots.cache,'tile-alias.b3dm'));
  const value=await measureStorageUsage({roots,categories:new Map([[photo,'sources'],[product,'products']])});
  assert.equal(value.status,'complete');assert.equal(value.totalBytes,46);
  assert.deepEqual(Object.fromEntries(Object.entries(value.categories).map(([key,entry])=>[key,entry.bytes])),{sources:17,products:29,cache:0,trash:0,other:0});
  assert.equal(Object.values(value.categories).reduce((sum,entry)=>sum+entry.files,0),2);
});

test('a file access failure yields an explicit partial lower bound instead of a complete subtotal',async t=>{
  const {roots,put}=await fixture(t);await put('models','readable.bin',7);const denied=await put('models','denied.bin',11);
  const io={...fs,lstat:async target=>{if(target===denied)throw Object.assign(new Error('denied'),{code:'EACCES'});return fs.lstat(target);}};
  const value=await measureStorageUsage({roots,categories:new Map(),io});
  assert.equal(value.status,'partial');assert.equal(value.totalBytes,7);
  assert.deepEqual(value.errors,[{root:'models',code:'EACCES'}]);
});

test('scan bounds and missing roots are explicit partial results, never complete zero',async t=>{
  const {roots,put}=await fixture(t); await put('models','a',7); await put('models','b',7); roots.trash=path.join(roots.trash,'missing');
  const value=await measureStorageUsage({roots,categories:new Map(),maxEntries:1}); assert.equal(value.status,'partial'); assert.ok(value.errors.some(e=>e.code==='ENOENT')); assert.ok(value.errors.some(e=>e.code==='scan_limit'));
});

test('symbolic directory links are not followed outside Viewer roots',async t=>{
  const {roots,base}=await fixture(t), outside=path.join(base,'external'); await fs.mkdir(outside); await fs.writeFile(path.join(outside,'secret'),Buffer.alloc(100));
  await fs.symlink(outside,path.join(roots.models,'escape'),process.platform==='win32'?'junction':'dir');
  const value=await measureStorageUsage({roots,categories:new Map()}); assert.equal(value.totalBytes,0); assert.equal(value.skippedSymlinks,1); assert.equal(value.status,'partial');
});

test('registry classifies exact source paths and hierarchical product members, not every image texture as a source',async t=>{
  const db=new DatabaseSync(':memory:'); t.after(()=>db.close());
  db.exec("CREATE TABLE retained_imports(id,dataset_id);CREATE TABLE retained_import_files(retained_import_id,relative_path,role);CREATE TABLE model_camera_photos(root_key,relative_path);CREATE TABLE datasets(id,root_key,relative_path,storage_mode);CREATE TABLE dataset_files(dataset_id,relative_path);CREATE TABLE model_assets(id,root_key,relative_path,kind);CREATE TABLE model_asset_files(asset_id,relative_path);INSERT INTO model_camera_photos VALUES('models','run/photos/p.jpg');INSERT INTO datasets VALUES('d','datasets','d','managed');INSERT INTO dataset_files VALUES('d','a.jpg');INSERT INTO model_assets VALUES('a','models','run/tiles/tileset.json','tiles');INSERT INTO model_asset_files VALUES('a','tex/a.jpg');");
  const roots={models:path.resolve('models'),datasets:path.resolve('datasets')}, values=await registryCategories(db,roots);
  assert.equal(values.get(path.join(roots.models,'run/photos/p.jpg')),'sources'); assert.equal(values.get(path.join(roots.datasets,'d/a.jpg')),'sources'); assert.equal(values.get(path.join(roots.models,'run/tiles/tex/a.jpg')),'products');
});

test('monitor returns immediately, coalesces concurrent reads and serves stale while refreshing',async()=>{
  let calls=0,resolve,clock=0;
  const monitor=createStorageUsageMonitor({storage:{roots:{}},now:()=>clock,ttlMs:10,measure:()=>{calls++;return new Promise(r=>resolve=r);}});
  assert.equal(monitor.read().status,'pending'); monitor.read(); await Promise.resolve(); assert.equal(calls,1);
  resolve({status:'complete',totalBytes:12,categories:{},measuredAt:'measured'}); await monitor.whenIdle(); assert.equal(monitor.read().totalBytes,12); assert.equal(calls,1);
  clock=20; const stale=monitor.read(); assert.equal(stale.stale,true); assert.equal(stale.totalBytes,12); await Promise.resolve(); assert.equal(calls,2); resolve({status:'complete',totalBytes:13,categories:{}}); await monitor.whenIdle();
});

test('retained recovery manifest roles classify relocated originals separately from mesh textures',async t=>{
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec("CREATE TABLE retained_imports(id,dataset_id);CREATE TABLE retained_import_files(retained_import_id,relative_path,role);CREATE TABLE model_camera_photos(root_key,relative_path);CREATE TABLE datasets(id,root_key,relative_path,storage_mode);CREATE TABLE dataset_files(dataset_id,relative_path);CREATE TABLE model_assets(id,root_key,relative_path,kind);CREATE TABLE model_asset_files(asset_id,relative_path);INSERT INTO datasets VALUES('recovery','models','recovered/run','managed');INSERT INTO retained_imports VALUES('manifest','recovery');INSERT INTO retained_import_files VALUES('manifest','camera-photos/image.jpg','source_photo'),('manifest','mesh/texture.jpg','mesh_texture'),('manifest','mesh/material.mtl','mesh_mtl'),('manifest','report.json','metadata');");
  const roots={models:path.resolve('models')},values=await registryCategories(db,roots);
  assert.equal(values.get(path.join(roots.models,'recovered/run/camera-photos/image.jpg')),'sources');
  assert.equal(values.get(path.join(roots.models,'recovered/run/mesh/texture.jpg')),'products');
  assert.equal(values.get(path.join(roots.models,'recovered/run/mesh/material.mtl')),'products');
  assert.equal(values.get(path.join(roots.models,'recovered/run/report.json')),'other');
});

test('diagnostics renders pending, partial, separate capacity and escaped cleanup reasons',async()=>{
  const source=await fs.readFile(path.join(__dirname,'../workspace-projects.js'),'utf8');
  const helper=source.slice(source.indexOf('function storageUsageCards('),source.indexOf('\n}',source.indexOf('function storageUsageCards('))+2);
  const context={metric:(a,b,c)=>[a,b,c].join('|'),bytes:n=>String(n),dateTime:n=>n}; vm.createContext(context); vm.runInContext(helper,context);
  assert.match(context.storageUsageCards(null),/Measuring/);
  assert.match(context.storageUsageCards({status:'error'}),/Unavailable/);
  const html=context.storageUsageCards({status:'partial',totalBytes:14,categories:{sources:{bytes:3},products:{bytes:11}},filesystems:[{availableBytes:999,totalBytes:1000,roots:['models','cache']}],errors:[{code:'scan_limit'}]});
  assert.match(html,/Partial lower bound/); assert.match(html,/Model products\|11/); assert.match(html,/not a folder subtotal/); assert.match(html,/scan_limit/);
  assert.match(source,/Cleanup reason: \$\{esc\(event\.details\.reason\)\}/);
});
