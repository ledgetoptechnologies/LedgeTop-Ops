'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {buildRetainedManifest}=require('../server/retainedManifest');
const {discoverAssets}=require('../server/catalogImport');
const {discoverOutputs}=require('../server/processingWorker');
const {publicDerivativeKind}=require('../server/processingSecurity');
const {registeredProducts,productDescriptor}=require('../server/productDownloads');
const {validateCutlineFile}=require('../server/orthophotoCutline');
const polygon={type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,0]]]}}]};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'viewer-cutline-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function put(root,relativePath,body){const absolutePath=path.join(root,...relativePath.split('/'));fs.mkdirSync(path.dirname(absolutePath),{recursive:true});fs.writeFileSync(absolutePath,body);return{absolutePath,relativePath};}

test('known polygon cutline survives retained import, catalog registration and permission-gated product listing',async t=>{
  const root=fixture(t),file=put(root,'odm_orthophoto/cutline.geojson',JSON.stringify(polygon));
  put(root,'odm_orthophoto/private.json','{"secret":"not a product"}');
  put(root,'other/cutline.geojson',JSON.stringify(polygon));
  put(root,'odm_orthophoto/orthophoto_cutline.json',JSON.stringify(polygon));
  const manifest=await buildRetainedManifest(root);
  assert.deepEqual(manifest.files.map(f=>[f.relativePath,f.role]),[[file.relativePath,'orthophoto_cutline']]);
  const {assets}=await discoverAssets(root);assert.equal(assets.length,1);assert.equal(assets[0].kind,'orthoCutline');assert.match(assets[0].sha256,/^[a-f0-9]{64}$/);
  assert.equal(publicDerivativeKind('orthoCutline'),true);
  assert.equal(registeredProducts(assets).length,0,'unpublished source not exposed publicly');
  assert.equal(registeredProducts(assets,{staff:true})[0].label,'Orthophoto cutline');
  assert.equal(registeredProducts(assets,{review:true})[0].kind,'orthoCutline');
  assert.equal(registeredProducts(assets.map(a=>({...a,published:true})))[0].format,'GEOJSON');
  assert.equal(discoverOutputs(root).find(a=>a.kind==='orthoCutline').relativePath,file.relativePath);
  assert.equal((await buildRetainedManifest(root,{policy:{orthophoto:false}})).files.length,0);
  assert.equal(productDescriptor({...assets[0],relativePath:'private.geojson',published:true}),null);
});

test('GeoPackage requires its file signature, GeoJSON requires polygon geometry, JSON archives never qualify',async t=>{
  const root=fixture(t),gpkg=Buffer.alloc(100);Buffer.from('SQLite format 3\0').copy(gpkg);gpkg.writeUInt32BE(0x47504b47,68);
  const file=put(root,'odm_orthophoto/cutline.gpkg',gpkg);assert.equal(validateCutlineFile(file),true);
  assert.equal((await discoverAssets(root)).assets[0].format,'gpkg');
  assert.equal((await buildRetainedManifest(root)).files[0].role,'orthophoto_cutline');
  gpkg.writeUInt32BE(0,68);fs.writeFileSync(file.absolutePath,gpkg);assert.equal(validateCutlineFile(file),false);
  const validGeoJSON=put(root,'odm_orthophoto/cutline.geojson',JSON.stringify(polygon));
  assert.equal(discoverOutputs(root).find(a=>a.kind==='orthoCutline').relativePath,validGeoJSON.relativePath,'invalid preferred package does not hide valid known GeoJSON');
  for(const [name,body]of [['cutline.geojson','{"type":"Point","coordinates":[1,2]}'],['orthophoto_cutline.geojson','{"token":"not a polygon"}'],['cutline.json',JSON.stringify(polygon)],['cutline.zip','archive']])assert.equal(validateCutlineFile(put(root,`odm_orthophoto/${name}`,body)),false);
  assert.equal((await discoverAssets(root)).assets.length,0);
  assert.equal((await buildRetainedManifest(root)).files.length,0);
});
