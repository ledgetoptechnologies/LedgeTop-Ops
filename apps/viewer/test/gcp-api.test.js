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
  return {base,dataset,required,imagePath,database,root};
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
  assert.equal(response.status,409);const payload=await response.json();assert.equal(payload.code,'invalid_source_file');assert.doesNotMatch(payload.error,/SELECT|constraint|sqlite/i);
});

test('manual linked GCP import verifies the managed source bytes and keeps an immutable CSV copy',async(t)=>{
  const {base,dataset,root,database}=await fixture(t),source='point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n';
  const sha=crypto.createHash('sha256').update(source).digest('hex'),createdAt=new Date().toISOString();
  database.prepare('INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('linked-gcp',dataset.id,'control.csv',Buffer.byteLength(source),sha,'text/csv',createdAt);
  const headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'manual-linked-gcp'};
  const route=`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,body={displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',sourceFileId:'linked-gcp',content:source};
  const missing=await fetch(route,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(missing.status,409);assert.equal((await missing.json()).code,'invalid_source_file');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM gcp_sets').get().count,0);
  const rawPath=path.join(root,'datasets',dataset.relativePath,'control.csv');fs.writeFileSync(rawPath,source);
  const imported=await fetch(route,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal(imported.status,201);
  const set=(await imported.json()).set;
  assert.equal(set.sourceFileId,'linked-gcp');
  assert.equal(database.prepare('SELECT source_content FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(dataset.id,sha).source_content,source);
  await fetch(`${base}/api/v1/gcp-sets/${set.id}`,{method:'DELETE',headers:{...headers,'idempotency-key':'delete-editable-gcp-set'}});
  assert.equal(database.prepare('SELECT source_content FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(dataset.id,sha).source_content,source);
  fs.writeFileSync(rawPath,'tampered');
  const rejected=await fetch(route,{method:'POST',headers:{...headers,'idempotency-key':'manual-linked-gcp-tampered'},body:JSON.stringify(body)});
  assert.equal(rejected.status,409);assert.equal((await rejected.json()).code,'invalid_source_file');
});

test('legacy source custody issues block GCP-set deletion with a safe conflict',async(t)=>{
  const {base,dataset,database}=await fixture(t),source='point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n';
  const imported=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers:{authorization:'Bearer admin','content-type':'application/json','idempotency-key':'legacy-issue-import'},
    body:JSON.stringify({displayName:'Legacy',format:'generic-csv-v1',fileName:'legacy.csv',content:source})});
  assert.equal(imported.status,201);const set=(await imported.json()).set;
  database.prepare(`INSERT INTO retained_gcp_source_issues(gcp_set_id,dataset_id,issue_code,expected_sha256,observed_sha256,expected_byte_size,observed_byte_size,created_at)
    VALUES (?,?,?,NULL,NULL,NULL,NULL,?)`).run(set.id,dataset.id,'legacy_source_review_required',new Date().toISOString());
  const removed=await fetch(`${base}/api/v1/gcp-sets/${set.id}`,{method:'DELETE',headers:{authorization:'Bearer admin','idempotency-key':'blocked-delete'}});
  assert.equal(removed.status,409);assert.equal((await removed.json()).code,'gcp_source_requires_review');
  assert.equal(database.prepare('SELECT source_content FROM gcp_sets WHERE id=?').get(set.id).source_content,source);
});

test('automatic GCP CSV discovery imports exact Emlid sources idempotently and ignores unrelated CSVs',async(t)=>{
  const {base,dataset,root,database}=await fixture(t),directory=path.join(root,'datasets',dataset.relativePath),createdAt=new Date().toISOString();
  const valid='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nCP-01,500000,4900000,250,44.5,-88.1,230,NAD83(2011) / Projected (m) + NAVD88 height (m)\n';
  const invalid='date,temperature\n2026-01-01,12\n',validPath=path.join(directory,'survey.csv'),invalidPath=path.join(directory,'notes.csv');
  fs.writeFileSync(validPath,valid);fs.writeFileSync(invalidPath,invalid);
  const insert=database.prepare('INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,created_at) VALUES (?,?,?,?,?,?,?)');
  const validId='gcp-source-file',invalidId='unrelated-csv-file';
  insert.run(validId,dataset.id,'survey.csv',Buffer.byteLength(valid),crypto.createHash('sha256').update(valid).digest('hex'),'text/csv',createdAt);
  insert.run(invalidId,dataset.id,'notes.csv',Buffer.byteLength(invalid),crypto.createHash('sha256').update(invalid).digest('hex'),'text/csv',createdAt);
  const route=`${base}/api/v1/datasets/${dataset.id}/gcp-sets/auto-import`,headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'gcp-auto-import-1'};
  const first=await fetch(route,{method:'POST',headers,body:'{}'});assert.equal(first.status,200);const result=await first.json();
  assert.equal(result.imported,1);assert.equal(result.ignoredInvalid,1);assert.equal(result.sets.length,1);assert.equal(result.sets[0].sourceFileId,validId);
  assert.equal(result.sets[0].crs,'EPSG:6318');assert.equal(result.sets[0].provenance.horizontalCrs,'EPSG:6318');
  const points=await(await fetch(`${base}/api/v1/gcp-sets/${result.sets[0].id}`,{headers})).json();
  assert.equal(points.points[0].externalId,'CP-01');assert.equal(points.set.provenance.adapter,'emlid-all-columns-v1');
  assert.equal(fs.readFileSync(validPath,'utf8'),valid,'raw source CSV remains byte-for-byte in dataset storage');
  const second=await fetch(route,{method:'POST',headers:{...headers,'idempotency-key':'gcp-auto-import-2'},body:'{}'});assert.equal(second.status,200);assert.equal((await second.json()).imported,0);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM gcp_sets WHERE source_file_id=?').get(validId).count,1);
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
  const fixed=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius`,{headers:auth})).json();
  assert.ok(Math.abs(fixed.ranking.radiusM-15.24)<1e-9,'fixed-radius default is 50 feet expressed in meters');
  const firstPage=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=1000&limit=10`,{headers:auth})).json();
  assert.equal(firstPage.images.length,10);assert.equal(firstPage.pagination.hasMore,true);assert.equal(firstPage.pagination.nextOffset,10);
  const secondPage=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=1000&limit=10&offset=10`,{headers:auth})).json();
  assert.equal(secondPage.images.length,5);assert.equal(secondPage.pagination.hasMore,false);assert.equal(secondPage.pagination.nextOffset,null);
  assert.equal((await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&limit=10&offset=1000001`,{headers:auth})).status,400);
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

test('radius paging includes images beyond the former 200 result cutoff',async(t)=>{
 const {base,dataset,database}=await fixture(t),headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'paged'};
 const imported=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers,body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content:'point_id,label,latitude,longitude,elevation_m\nA,A,44.5,-88.1,250\n'})});
 const pointId=(await imported.json()).points[0].id,sha='a'.repeat(64),timestamp=new Date().toISOString();
 const insert=database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,mime_type,latitude,longitude) VALUES (?,?,?,?,?,?,'{}',?,?,?,?)`);
 for(let i=0;i<205;i++)insert.run(`page-${i}`,dataset.id,`page-${i}.jpg`,1,sha,'image/jpeg',timestamp,'image/jpeg',44.5+i*0.0000001,-88.1);
 const url=`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=15.24&limit=200`,auth={authorization:'Bearer admin'};
 const first=await(await fetch(url,{headers:auth})).json();assert.equal(first.pagination.total,205);assert.equal(first.images.length,200);assert.equal(first.pagination.nextOffset,200);
 const second=await(await fetch(url+'&offset=200',{headers:auth})).json();assert.equal(second.images.length,5);assert.equal(second.pagination.nextOffset,null);assert.equal(new Set([...first.images,...second.images].map(x=>x.id)).size,205);
 const last=await(await fetch(url+'&offset=204',{headers:auth})).json();assert.equal(last.images.length,1);assert.deepEqual(last.ranking.warnings,[]);
 const nearestUrl=`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=nearest&limit=200`;
 const nearestFirst=await(await fetch(nearestUrl,{headers:auth})).json(),nearestSecond=await(await fetch(nearestUrl+'&offset=200',{headers:auth})).json();
 assert.equal(nearestFirst.images.length,200);assert.equal(nearestFirst.pagination.nextOffset,200);assert.equal(nearestSecond.images.length,5);assert.equal(nearestSecond.pagination.nextOffset,null);
 assert.equal(new Set([...nearestFirst.images,...nearestSecond.images].map(x=>x.id)).size,205);
 const auto=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=auto`,{headers:auth});assert.equal(auto.status,409);assert.equal((await auto.json()).code,'gcp_auto_candidates_exceed_limit');
});

test('radius search filters a large dataset and wraps across the antimeridian',async(t)=>{
 const {base,dataset,database}=await fixture(t),headers={authorization:'Bearer admin','content-type':'application/json','idempotency-key':'dateline'};
 const imported=await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import`,{method:'POST',headers,body:JSON.stringify({displayName:'Control',format:'generic-csv-v1',fileName:'control.csv',content:'point_id,label,latitude,longitude,elevation_m\nA,A,0,179.99999,0\n'})});
 const pointId=(await imported.json()).points[0].id,sha='a'.repeat(64),timestamp=new Date().toISOString();
 const insert=database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,mime_type,latitude,longitude) VALUES (?,?,?,?,?,?,'{}',?,?,?,?)`);
 database.exec('BEGIN');try{for(let i=0;i<17000;i++)insert.run(`far-${i}`,dataset.id,`far-${i}.jpg`,1,sha,'image/jpeg',timestamp,'image/jpeg',1,179);for(const id of ['near-b','near-a'])insert.run(id,dataset.id,`${id}.jpg`,1,sha,'image/jpeg',timestamp,'image/jpeg',0,-179.99999);database.exec('COMMIT')}catch(error){database.exec('ROLLBACK');throw error;}
 const url=`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=15.24&limit=1`,auth={authorization:'Bearer admin'};
 const first=await(await fetch(url,{headers:auth})).json(),second=await(await fetch(url+'&offset=1',{headers:auth})).json();
 assert.equal(first.pagination.total,2);assert.equal(first.images[0].id,'near-a');assert.equal(second.images[0].id,'near-b');assert.equal(second.pagination.nextOffset,null);
 assert.ok(first.images[0].distanceM<15.24);
 const distance=first.images[0].distanceM;
 const inside=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=${distance+0.000001}`,{headers:auth})).json();
 const boundary=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=${distance}`,{headers:auth})).json();
 const outside=await(await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-images?pointId=${pointId}&mode=radius&radiusM=${distance-0.000001}`,{headers:auth})).json();
 assert.equal(inside.pagination.total,2);assert.equal(boundary.pagination.total,2);assert.equal(outside.pagination.total,0);
});
