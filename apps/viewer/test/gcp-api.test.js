'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {mountGcpRoutes}=require('../server/gcpApi');
const {PERMISSIONS}=require('../server/processingApi');

async function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-api-')),database=openDatabase(path.join(root,'viewer.sqlite'));
  const processing=new ProcessingRepository(database),project=processing.createProject({displayName:'Survey'}),relativePath=crypto.randomUUID();
  const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath});
  const imagePath=path.join(root,'datasets',relativePath,'photo.jpg'),imageBytes=Buffer.from('private-image');fs.mkdirSync(path.dirname(imagePath),{recursive:true});fs.writeFileSync(imagePath,imageBytes);
  const imageSha=crypto.createHash('sha256').update(imageBytes).digest('hex');processing.finalizeDataset(dataset.id,[{id:'image-one',relativePath:'photo.jpg',byteSize:imageBytes.length,sha256:imageSha,contentType:'image/jpeg'}],imageSha);
  const required=[];const app=express();app.use(express.json({limit:'3mb'}));const router=express.Router();
  const respond=(res,status,code,message=code)=>res.status(status).json({code,error:message});
  const authorize=(permission)=>(req,res,next)=>{required.push(permission);if(req.get('authorization')!=='Bearer admin')return respond(res,401,'unauthorized');req.actorId='ops:1';next();};
  const mutate=(req,res,next)=>req.get('idempotency-key')?next():respond(res,400,'idempotency_key_required');
  mountGcpRoutes(router,{repository:{audit(){}},processing,storage:{resolve(_rootKey,relative){return path.join(root,'datasets',...relative.split('/'));}},authorize,mutate,error:respond});app.use(router);
  const server=await new Promise((resolve)=>{const value=app.listen(0,'127.0.0.1',()=>resolve(value));});
  const base=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{await new Promise((resolve)=>server.close(resolve));database.close();fs.rmSync(root,{recursive:true,force:true});});
  return {base,dataset,required,imagePath,database};
}

test('GCP administrative routes enforce dedicated permissions, idempotency middleware, and private DTOs',async(t)=>{
  const {base,dataset,required,imagePath}=await fixture(t),route=`${base}/api/v1/datasets/${dataset.id}/gcp-sets`;
  assert.equal((await fetch(route)).status,401);
  const source='point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n',body={displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content:source};
  assert.equal((await fetch(`${route}/import`,{method:'POST',headers:{authorization:'Bearer admin','content-type':'application/json'},body:JSON.stringify(body)})).status,400);
  const imported=await fetch(`${route}/import`,{method:'POST',headers:{authorization:'Bearer admin','content-type':'application/json','idempotency-key':'import-1'},body:JSON.stringify(body)});
  assert.equal(imported.status,201);const payload=await imported.json();assert.equal(payload.points[0].externalId,'A');
  assert.equal(Object.hasOwn(payload.set,'sourceContent'),false);
  const listed=await fetch(route,{headers:{authorization:'Bearer admin'}});assert.equal(listed.status,200);
  assert.equal((await listed.json()).sets.length,1);
  assert.ok(required.includes('viewer.gcp.read'));assert.ok(required.includes('viewer.gcp.write'));
  assert.ok(PERMISSIONS.has('viewer.gcp.read'));assert.ok(PERMISSIONS.has('viewer.gcp.write'));
  assert.equal((await fetch(`${base}/api/v1/public/gcp-sets/${payload.set.id}`)).status,404);
  const imageRoute=`${base}/api/v1/datasets/${dataset.id}/gcp-images/image-one/content`;
  const original=await fetch(imageRoute,{headers:{authorization:'Bearer admin'}});assert.equal(original.status,200);assert.equal(original.headers.get('cache-control'),'private, no-store');await original.arrayBuffer();
  fs.writeFileSync(imagePath,'changed-image');
  const changed=await fetch(imageRoute,{headers:{authorization:'Bearer admin'}});assert.equal(changed.status,409);assert.equal((await changed.json()).code,'dataset_image_changed');
});

test('unexpected repository details are not reflected in GCP responses',async(t)=>{
  const {base,dataset}=await fixture(t),source='point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n';
  const response=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers:{authorization:'Bearer admin','content-type':'application/json','idempotency-key':'bad-source'},
    body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',sourceFileId:'missing-file',content:source})});
  assert.equal(response.status,400);const payload=await response.json();assert.equal(payload.code,'invalid_source_file');assert.doesNotMatch(payload.error,/SELECT|constraint|sqlite/i);
});

test('auto candidates adapt to camera spacing, accuracy and footprint metadata without claiming visibility',async(t)=>{
  const {base,dataset,database}=await fixture(t),headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'rank-import'};
  const imported=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers,body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content:'point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n'})});
  const pointId=(await imported.json()).points[0].id,timestamp=new Date().toISOString(),sha='a'.repeat(64);
  const insert=database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,mime_type,latitude,longitude)
    VALUES (?,?,?,?,?,?,'{}',?,?,?,?)`);
  for(let index=0;index<15;index+=1)insert.run(`rank-${index}`,dataset.id,`rank-${index}.jpg`,1,sha,'image/jpeg',timestamp,'image/jpeg',44.5+(index+1)*0.00001,-88.1);
  const route=`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=auto&limit=20`,auth={authorization:'Bearer admin'};
  const dense=await (await fetch(route,{headers:auth})).json();
  assert.equal(dense.ranking.reason,'adaptive_camera_spacing');assert.equal(dense.ranking.visibilityConfirmed,false);
  database.prepare("UPDATE dataset_files SET latitude=44.5+(CAST(substr(id,6) AS INTEGER)+1)*0.001 WHERE id LIKE 'rank-%'").run();
  const sparse=await (await fetch(route,{headers:auth})).json();
  assert.ok(sparse.ranking.radiusM>dense.ranking.radiusM);
  const metadata=database.prepare(`INSERT INTO gcp_image_ranking_metadata(dataset_file_id,horizontal_accuracy_m,source,updated_at) VALUES (?,50,'test',?)`);
  for(let index=0;index<15;index+=1)metadata.run(`rank-${index}`,timestamp);
  const accurate=await (await fetch(route,{headers:auth})).json();assert.ok(accurate.ranking.radiusM>sparse.ranking.radiusM);
  database.prepare('UPDATE gcp_image_ranking_metadata SET footprint_radius_m=1').run();
  const footprint=await (await fetch(route,{headers:auth})).json();
  assert.equal(footprint.ranking.reason,'median_camera_footprint_metadata');assert.equal(footprint.ranking.mode,'nearest_fallback');
  assert.equal(footprint.images.length,12);assert.equal(footprint.ranking.visibilityConfirmed,false);
});

test('omitted GCP search settings use 50 feet and never silently expand for fewer candidates',async(t)=>{
  const {base,dataset,database}=await fixture(t),headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'fixed-control'};
  const imported=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers,
    body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content:'point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n'})});
  const pointId=(await imported.json()).points[0].id,timestamp=new Date().toISOString(),sha='a'.repeat(64);
  const insert=database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,mime_type,latitude,longitude)
    VALUES (?,?,?,?,?,?,'{}',?,?,?,?)`);
  insert.run('near-camera',dataset.id,'near.jpg',1,sha,'image/jpeg',timestamp,'image/jpeg',44.5001,-88.1);
  insert.run('far-camera',dataset.id,'far.jpg',1,sha,'image/jpeg',timestamp,'image/jpeg',44.5002,-88.1);
  const route=`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}`,auth={authorization:'Bearer admin'};
  const defaults=await (await fetch(route,{headers:auth})).json();
  assert.equal(defaults.ranking.mode,'radius');assert.equal(defaults.ranking.radiusM,15.24);
  assert.equal(defaults.ranking.basis,'camera_proximity');assert.equal(defaults.ranking.visibilityConfirmed,false);
  assert.deepEqual(defaults.images.map(image=>image.id),['near-camera']);
  assert.equal(defaults.ranking.warnings.length,1);
  const fixed=await (await fetch(`${route}&mode=radius`,{headers:auth})).json();
  assert.deepEqual(fixed.images.map(image=>image.id),['near-camera']);assert.equal(fixed.ranking.radiusM,15.24);
  const custom=await (await fetch(`${route}&mode=radius&radiusM=30.48`,{headers:auth})).json();
  assert.deepEqual(custom.images.map(image=>image.id),['near-camera','far-camera']);
  const nearest=await (await fetch(`${route}&mode=nearest`,{headers:auth})).json();
  assert.equal(nearest.images.length,2);
  const adaptive=await (await fetch(`${route}&mode=auto`,{headers:auth})).json();
  assert.equal(adaptive.ranking.mode,'nearest_fallback');assert.equal(adaptive.images.length,2);
  for(const radius of ['0','-1','NaN','Infinity','100001']) {
    const response=await fetch(`${route}&radiusM=${radius}`,{headers:auth});assert.equal(response.status,400);
  }
});

test('attempt checkpoint report waits for output, then compares the DSM with surveyed NAVD88 elevations',async(t)=>{
  const {base,dataset,database,imagePath}=await fixture(t),processing=new ProcessingRepository(database),auth={authorization:'Bearer admin'};
  const content='point_id,label,latitude,longitude,elevation_m,role\nA,A,44.5,-89.5,250,control\nCHK,CHK,44.50001,-89.50001,249.9,checkpoint\n';
  const imported=await (await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers:{...auth,'content-type':'application/json','idempotency-key':'roles'},
    body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content})})).json();
  const task=processing.createTask({projectId:processing.getDataset(dataset.id).projectId,datasetId:dataset.id,displayName:'Model'});
  const gcp=new (require('../server/gcpRepository').GcpRepository)(database);
  for(const point of imported.points)gcp.createCorrespondence({taskId:task.id,pointId:point.id,imageFileId:'image-one',pixelX:1,pixelY:1});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),route=`${base}/api/v1/attempts/${attempt.id}/gcp-checkpoints`;
  assert.equal((await fetch(route)).status,401);
  const waiting=await (await fetch(route,{headers:auth})).json();
  assert.equal(waiting.reportStatus,'awaiting_output');assert.equal(waiting.report,null);
  assert.deepEqual(waiting.checkpoints.map(point=>point.externalId),['CHK']);
  const at=new Date().toISOString(),dsmRelative=`${crypto.randomUUID()}/dsm.tif`;
  database.prepare("INSERT INTO models(id,provider,provider_model_id,display_name,status,created_at,updated_at) VALUES ('m1','local','m1','Model','ready',?,?)").run(at,at);
  database.prepare("INSERT INTO model_versions(id,model_id,provider_version_id,source_locator_json,status,created_at,updated_at) VALUES ('v1','m1','v1','{}','ready',?,?)").run(at,at);
  database.prepare("INSERT INTO model_assets(id,version_id,kind,root_key,relative_path,format,created_at) VALUES ('a1','v1','dsm','datasets',?,'tif',?)").run(dsmRelative,at);
  processing.setAttemptResult(attempt.id,'m1','v1');
  // The fixture's storage resolves every path under <root>/datasets; the DSM file does not exist yet.
  const dsmFile=path.join(path.dirname(path.dirname(imagePath)),...dsmRelative.split('/'));
  const {writeArrayBuffer}=await import('geotiff'),{createUtmProjection}=await import('../utm-conversion.mjs');
  const [e,n]=createUtmProjection({zoneLon0Deg:-87}).latLonToUtm(44.50001,-89.50001);
  fs.mkdirSync(path.dirname(dsmFile),{recursive:true});
  fs.writeFileSync(dsmFile,Buffer.from(writeArrayBuffer(new Float32Array(36).fill(250),{width:6,height:6,ModelPixelScale:[1,1,0],ModelTiepoint:[0,0,0,e-3,n+3,0],ProjectedCSTypeGeoKey:32616,GTModelTypeGeoKey:1,GTRasterTypeGeoKey:1})));
  const ready=await (await fetch(route,{headers:auth})).json();
  assert.equal(ready.reportStatus,'ready');
  assert.equal(ready.report.points[0].externalId,'CHK');
  assert.ok(Math.abs(ready.report.points[0].dzM-0.1)<1e-4,JSON.stringify(ready.report.points[0]));
  assert.ok(Math.abs(ready.report.summary.rmseZM-0.1)<1e-4);
  const none=processing.createTask({projectId:processing.getDataset(dataset.id).projectId,datasetId:dataset.id,displayName:'No marks'});
  const plain=processing.createAttempt({taskId:none.id,providerId:provider.id,options:{}});
  assert.equal((await (await fetch(`${base}/api/v1/attempts/${plain.id}/gcp-checkpoints`,{headers:auth})).json()).reportStatus,'no_checkpoints');
  assert.equal((await fetch(`${base}/api/v1/attempts/missing/gcp-checkpoints`,{headers:auth})).status,404);
});
