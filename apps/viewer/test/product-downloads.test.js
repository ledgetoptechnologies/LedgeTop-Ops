'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const express=require('express');
const auth=require('../server/auth');
const {productDescriptor,registeredProducts,createDownloadCapabilities}=require('../server/productDownloads');
const assetsRouter=require('../server/assets');
const {createProcessingApi}=require('../server/processingApi');
const asset=(kind,relativePath=`${kind}.tif`,rest={})=>({id:kind,kind,rootKey:'fixture',relativePath,byteSize:10,sha256:'a'.repeat(64),published:true,...rest});

test('catalog offers real files and never represents manifests as original products',()=>{
  const items=[asset('ortho'),asset('dsm'),asset('dtm'),asset('ept','ept.json'),asset('tiles','tileset.json'),asset('pointCloud','cloud.laz'),asset('glb','mesh.glb'),asset('obj','mesh.obj'),asset('shots','shots.geojson'),asset('report','report.pdf'),asset('backup','backup.zip')];
  assert.deepEqual(registeredProducts(items).map(p=>p.kind),['ortho','dsm','dtm','glb','shots']);
  assert.deepEqual(registeredProducts(items,{staff:true}).map(p=>p.kind),['ortho','dsm','dtm','pointCloud','glb','obj','shots','report','backup']);
  assert.equal(productDescriptor(asset('pointCloud','ept.json'),{staff:true}),null);
  assert.equal(productDescriptor(asset('ortho','../escape.tif')),null);
  assert.equal(productDescriptor(asset('ortho','/abs.tif')),null);
  assert.equal(productDescriptor(asset('ortho','a/../x.tif')),null);
  assert.equal(productDescriptor(asset('ortho','ortho.tif',{sha256:null})),null);
  assert.equal(productDescriptor(asset('ortho','ortho.tif',{published:false})),null);
  assert.equal(productDescriptor(asset('shots','shots.geojson'),{cameras:false}),null);
});

test('opaque download tickets expire, remain narrow, and recheck revocation for range resume',async()=>{
  let now=1000,allowed=true,calls=0;
  const tickets=createDownloadCapabilities({ttlMs:500,maxEntries:1,now:()=>now});
  const ticket=tickets.issue(()=>{calls++;return allowed?{kind:'ortho'}:null;});
  assert.match(ticket.token,/^[A-Za-z0-9_-]{43}$/);
  assert.throws(()=>tickets.issue(()=>true),{status:429});
  assert.equal((await tickets.resolve(ticket.token)).kind,'ortho');
  assert.equal((await tickets.resolve(ticket.token)).kind,'ortho');assert.equal(calls,2);
  allowed=false;assert.equal(await tickets.resolve(ticket.token),null);
  allowed=true;assert.equal(await tickets.resolve(ticket.token),null);
  const next=tickets.issue(()=>true);now=1501;assert.equal(await tickets.resolve(next.token),null);
  assert.equal(await tickets.resolve('../guess'),null);
});

test('large-file request admission survives ticket expiry but not source revocation',async()=>{
  let now=0,live=true;const tickets=createDownloadCapabilities({ttlMs:100,now:()=>now});
  const ticket=tickets.issue(()=>live?{kind:'ortho'}:null),request=await tickets.acquire(ticket.token);
  now=200;assert.equal(await tickets.resolve(ticket.token),null,'a new Range request is expired');
  assert.equal((await request.revalidate()).kind,'ortho','an admitted slow integrity read may finish');
  live=false;assert.equal(await request.revalidate(),null,'revocation still blocks bytes');
});

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-product-download-')),body=Buffer.from('0123456789');
  fs.writeFileSync(path.join(root,'ortho.tif'),body);
  const ortho=asset('ortho','ortho.tif',{sha256:crypto.createHash('sha256').update(body).digest('hex')}),version={id:'version',status:'ready',assets:[ortho,asset('ept','ept.json'),asset('pointCloud','cloud.laz')],sourceLocator:{legacyAssetRoots:{fixture:root}}};
  const model={id:'model',status:'ready',provider:'ltds-processing',activeVersionId:'version',activeVersion:version};
  const viewerToken='viewer-session-token-0000000000000000',adminToken='admin-session-token-00000000000000000';
  const session={id:'viewer',modelId:'model',modelVersionId:'version',permissions:{view:true,download:true,cameras:true},expiresAt:new Date(Date.now()+60000).toISOString()};
  const staff={id:'admin',subject:'ops:admin',permissions:['viewer.processing.read'],expiresAt:session.expiresAt};
  const output={id:'version',modelId:'model',status:'ready'};
  const repository={resolveModelId:id=>id==='model'?id:null,getModel:id=>id==='model'?model:null,getModelVersion:(id,versionId)=>id==='model'&&versionId==='version'?model:null,
    getViewerSessionByHash:hash=>hash===auth.hashToken(viewerToken)?session:null,viewerSessionLive:value=>!!value&&!value.revokedAt&&Date.parse(value.expiresAt)>Date.now(),rateLimited:()=>false,getModelAssetChunks:()=>[],getPublicShare:()=>null,publicShareLive:()=>false};
  const processing={database:{},getModelOutput:id=>id==='version'?output:null,getAdminSessionByHash:hash=>hash===auth.hashToken(adminToken)?staff:null,adminSessionLive:value=>!!value&&!value.revokedAt&&Date.parse(value.expiresAt)>Date.now()};
  assetsRouter.setRepository(repository);assetsRouter.setProcessingRepository(processing);
  const app=express();app.use(express.json());app.use(assetsRouter);app.use(createProcessingApi({repository,processing,storage:{resolve:(_root,relative)=>path.join(root,relative)}}));
  const server=await new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});assetsRouter.setRepository(null);assetsRouter.setProcessingRepository(null);});
  return{base:`http://127.0.0.1:${server.address().port}`,repository,processing,session,staff,output,model,version,ortho,root,viewerToken,adminToken};
}

test('Viewer product routes stream ranges, enforce scope and honor revoked download permission',async(t)=>{
  const c=await fixture(t),base=`${c.base}/session-products/${c.viewerToken}/model`;
  const list=await fetch(base);assert.equal(list.status,200);const {products}=await list.json();assert.deepEqual(products.map(p=>p.kind),['ortho']);
  assert.equal((await fetch(`${c.base}/session-products/${c.viewerToken}/other-model`)).status,403);
  assert.equal((await fetch(`${base}/pointCloud/download-grants`,{method:'POST'})).status,404);
  assert.equal((await fetch(products[0].grantUrl.startsWith('/')?c.base+products[0].grantUrl:'invalid',{method:'POST',headers:{origin:'https://evil.test'}})).status,403);
  const issued=await fetch(c.base+products[0].grantUrl,{method:'POST'});assert.equal(issued.status,201);const grant=await issued.json();assert.ok(!grant.url.includes(c.viewerToken));
  const range=await fetch(c.base+grant.url,{headers:{Range:'bytes=2-5'}});assert.equal(range.status,206);assert.equal(await range.text(),'2345');assert.match(range.headers.get('content-disposition'),/attachment; filename="ortho.tif"/);assert.equal(range.headers.get('cache-control'),'private, no-store');
  const head=await fetch(c.base+grant.url,{method:'HEAD'});assert.equal(head.status,200);assert.equal(head.headers.get('content-length'),'10');
  c.session.permissions.download=false;assert.equal((await fetch(c.base+grant.url,{headers:{Range:'bytes=6-9'}})).status,403);assert.equal((await fetch(base)).status,403);
});

test('registered orthophoto cutline download streams unchanged geometry and revokes with model download access',async t=>{
  const c=await fixture(t),relative='odm_orthophoto/cutline.geojson';
  const body=JSON.stringify({type:'FeatureCollection',features:[{type:'Feature',properties:{},geometry:{type:'Polygon',coordinates:[[[0,0],[2,0],[2,2],[0,0]]]}}]});
  fs.mkdirSync(path.join(c.root,'odm_orthophoto'));fs.writeFileSync(path.join(c.root,relative),body);
  const {discoverAssets}=require('../server/catalogImport'),found=(await discoverAssets(c.root)).assets.find(a=>a.kind==='orthoCutline');
  c.version.assets.push({...found,id:'cutline',rootKey:'fixture',published:true});
  const base=`${c.base}/session-products/${c.viewerToken}/model`,list=await(await fetch(base)).json(),product=list.products.find(p=>p.kind==='orthoCutline');
  assert.ok(product);assert.equal(product.format,'GEOJSON');
  const grant=await(await fetch(c.base+product.grantUrl,{method:'POST'})).json();
  const downloaded=await fetch(c.base+grant.url);assert.equal(downloaded.status,200);assert.equal(await downloaded.text(),body);
  assert.match(downloaded.headers.get('content-disposition'),/attachment; filename="orthoCutline.geojson"/);
  c.session.permissions.download=false;assert.equal((await fetch(c.base+grant.url)).status,403);
});

test('original report is an explicit download product without entering public asset publication',()=>{
  const report=asset('report','odm_report/report.pdf',{format:'pdf',contentType:'application/pdf',published:false});
  assert.equal(productDescriptor(report),null);
  assert.equal(productDescriptor(report,{modelReport:true}).label,'Model report — processing & quality');
  assert.equal(productDescriptor({...report,contentType:'text/html'},{modelReport:true}),null);
  assert.equal(productDescriptor({...report,relativePath:'odm_report/report.html'},{modelReport:true}),null);
  assert.equal(require('../server/processingSecurity').publicDerivativeKind('report'),false);
});

test('imported and node-processed original PDF reports download unchanged with version-scoped authorization',async t=>{
  const c=await fixture(t),relative='odm_report/report.pdf',body=Buffer.from('%PDF-1.7\nOriginal processing quality report\n%%EOF');
  fs.mkdirSync(path.join(c.root,'odm_report'));fs.writeFileSync(path.join(c.root,relative),body);
  const imported=(await require('../server/catalogImport').discoverAssets(c.root)).assets.find(a=>a.kind==='report');
  assert.ok(imported,'import discovers the original PDF');
  const processed=require('../server/processingWorker').discoverOutputs(c.root).find(a=>a.kind==='report');
  assert.equal(processed.relativePath,relative,'node processing discovers the same original PDF');
  const report={...imported,id:'original-report',rootKey:'fixture',published:false};c.version.assets.push(report);
  const base=`${c.base}/session-products/${c.viewerToken}/model`;
  const products=(await(await fetch(base)).json()).products,product=products.find(p=>p.kind==='report');assert.ok(product);
  const grant=await(await fetch(c.base+product.grantUrl,{method:'POST'})).json();
  const downloaded=await fetch(c.base+grant.url);assert.equal(downloaded.status,200);assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()),body);
  assert.equal(report.published,false,'download does not publish the original source');
  assert.equal((await fetch(`${c.base}/session-assets/${c.viewerToken}/model/fixture/${relative}`)).status,404);
  c.session.permissions.download=false;assert.equal((await fetch(c.base+grant.url)).status,403);
  assert.equal((await fetch(c.base+product.grantUrl,{method:'POST'})).status,403);
  c.session.permissions.download=true;
  const next=await(await fetch(c.base+product.grantUrl,{method:'POST'})).json();
  fs.writeFileSync(path.join(c.root,relative),Buffer.alloc(body.length,32));assert.equal((await fetch(c.base+next.url)).status,409);
  c.model.activeVersionId='replacement';assert.equal((await fetch(c.base+next.url)).status,403);
});

test('shared original model reports honor existing download permission and share revocation',async t=>{
  const c=await fixture(t),body=Buffer.from('%PDF-original');fs.writeFileSync(path.join(c.root,'report.pdf'),body);
  c.version.assets.push(asset('report','report.pdf',{format:'pdf',contentType:'application/pdf',published:false,byteSize:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}));
  const share={id:'share',modelId:'model',permissions:{view:true,download:false},versionPolicy:'active'};
  c.repository.getPublicShare=id=>id==='share'?share:null;c.repository.publicShareLive=value=>!!value&&!value.revokedAt;
  const token=auth.sign({kind:'share-asset',shareId:'share',modelId:'model'},60000),base=`${c.base}/session-products/${token}/model`;
  assert.equal((await fetch(base)).status,403);
  share.permissions.download=true;
  const grant=await(await fetch(`${base}/report/download-grants`,{method:'POST'})).json();assert.ok(grant.url);
  assert.deepEqual(Buffer.from(await(await fetch(c.base+grant.url)).arrayBuffer()),body);
  share.revokedAt=new Date().toISOString();assert.equal((await fetch(c.base+grant.url)).status,403);
});

test('staff capability binds output state and exact registered asset without revealing admin bearer',async(t)=>{
  const c=await fixture(t),endpoint=`${c.base}/api/v1/processing/outputs/version/products/ortho/download-grants`,headers={authorization:`Bearer ${c.adminToken}`,'content-type':'application/json'};
  assert.equal((await fetch(endpoint,{method:'POST',headers:{authorization:`Bearer ${c.viewerToken}`,'content-type':'application/json'},body:'{}'})).status,401);
  const issued=await fetch(endpoint,{method:'POST',headers,body:'{}'});assert.equal(issued.status,201);const grant=await issued.json();assert.ok(!grant.url.includes(c.adminToken));
  const response=await fetch(c.base+grant.url,{headers:{Range:'bytes=0-2'}});assert.equal(response.status,206);assert.equal(await response.text(),'012');
  c.output.status='trashed';assert.equal((await fetch(c.base+grant.url)).status,403);
  c.output.status='ready';const grant2=await(await fetch(endpoint,{method:'POST',headers,body:'{}'})).json();c.staff.revokedAt=new Date().toISOString();assert.equal((await fetch(c.base+grant2.url)).status,403);
});

test('public-share products retain task/version permissions and stop on share revocation',async(t)=>{
  const c=await fixture(t),share={id:'share',modelId:'model',permissions:{view:true,download:true},versionPolicy:'active'};
  c.repository.getPublicShare=id=>id==='share'?share:null;c.repository.publicShareLive=value=>!!value&&!value.revokedAt;
  const token=auth.sign({kind:'share-asset',shareId:'share',modelId:'model'},60000),base=`${c.base}/session-products/${token}/model`;
  const list=await fetch(base);assert.equal(list.status,200);assert.deepEqual((await list.json()).products.map(p=>p.kind),['ortho']);
  const grant=await(await fetch(`${base}/ortho/download-grants`,{method:'POST'})).json();
  share.revokedAt=new Date().toISOString();assert.equal((await fetch(c.base+grant.url)).status,403);
});

test('tampered products and replaced versions do not serve source bytes',async(t)=>{
  const c=await fixture(t),base=`${c.base}/session-products/${c.viewerToken}/model/ortho/download-grants`;
  const grant=await(await fetch(base,{method:'POST'})).json();
  fs.writeFileSync(path.join(c.root,'ortho.tif'),'9876543210');
  assert.equal((await fetch(c.base+grant.url)).status,409);
  c.model.activeVersionId='different-version';assert.equal((await fetch(c.base+grant.url)).status,403);
});
