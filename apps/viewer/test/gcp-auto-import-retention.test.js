'use strict';

const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const test=require('node:test');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {mountGcpRoutes}=require('../server/gcpApi');

const EMLID='Name,Code,Code description,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name\nltds-1,,,903241.652,549596.746,833.164,Hub,-88.62836667,42.98018648,720.437,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n';

test('auto-imports exactly one valid Emlid CSV, defaults proximity to 50 ft, and protects every raw CSV',async(t)=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-retention-')),database=openDatabase(path.join(root,'viewer.sqlite')),processing=new ProcessingRepository(database),routes=new Map();
  t.after(()=>{database.close();fs.rmSync(root,{recursive:true,force:true});});
  const router={get(route,...handlers){routes.set(`GET ${route}`,handlers.at(-1));},post(route,...handlers){routes.set(`POST ${route}`,handlers.at(-1));},patch(route,...handlers){routes.set(`PATCH ${route}`,handlers.at(-1));},delete(route,...handlers){routes.set(`DELETE ${route}`,handlers.at(-1));}};
  const respond=(res,status,code,message=code)=>res.status(status).json({code,error:message});
  mountGcpRoutes(router,{repository:{audit(){}},processing,storage:{resolve(_root,relative){return path.join(root,'datasets',...relative.split('/'));}},authorize:()=>()=>{},mutate:()=>{},error:respond});
  function makeDataset(name,csvText){
    const project=processing.createProject({displayName:name}),relative=crypto.randomUUID(),dataset=processing.createDataset({projectId:project.id,displayName:name,storageMode:'managed',rootKey:'datasets',relativePath:relative}),base=path.join(root,'datasets',relative),csv=Buffer.from(csvText);
    fs.mkdirSync(base,{recursive:true});fs.writeFileSync(path.join(base,'control.csv'),csv);fs.writeFileSync(path.join(base,'near.jpg'),Buffer.from('image'));
    const csvSha=crypto.createHash('sha256').update(csv).digest('hex'),image=Buffer.from('image'),imageSha=crypto.createHash('sha256').update(image).digest('hex');
    processing.finalizeDataset(dataset.id,[
      {id:`${name}-csv`,relativePath:'control.csv',byteSize:csv.length,sha256:csvSha,contentType:'text/csv'},
      {id:`${name}-near`,relativePath:'near.jpg',byteSize:image.length,sha256:imageSha,contentType:'image/jpeg',metadata:{gps:{latitude:42.9802,longitude:-88.62836667},width:4000,height:3000}},
    ],csvSha);
    return dataset;
  }
  function invoke(method,route,req){const response={statusCode:200,status(value){this.statusCode=value;return this;},json(value){this.body=value;return this;}};routes.get(`${method} ${route}`)(req,response);return response;}
  const dataset=makeDataset('valid',EMLID),autoRoute='/api/v1/datasets/:datasetId/gcp-sets/auto-import',imageRoute='/api/v1/datasets/:datasetId/gcp-images';
  const imported=invoke('POST',autoRoute,{params:{datasetId:dataset.id},body:{},actorId:'ops:test'});
  assert.equal(imported.statusCode,201);assert.equal(imported.body.status,'imported');assert.equal(imported.body.points.length,1);
  assert.equal(processing.hasDatasetRetentionHold(dataset.id),true);assert.equal(processing.beginTrashMutation(dataset.id,'ops:test'),null);
  assert.throws(()=>database.prepare('DELETE FROM dataset_files WHERE id=?').run('valid-csv'),/raw CSV retention hold/);
  const selected=imported.body.points[0],ranked=invoke('GET',imageRoute,{params:{datasetId:dataset.id},query:{pointId:selected.id,mode:'radius'},actorId:'ops:test'});
  assert.equal(ranked.body.ranking.radiusM,15.24);assert.deepEqual(ranked.body.images.map(image=>image.id),['valid-near']);
  const invalid=makeDataset('invalid','not,a,valid,gcp,file\n');
  const ignored=invoke('POST',autoRoute,{params:{datasetId:invalid.id},body:{},actorId:'ops:test'});
  assert.equal(ignored.statusCode,200);assert.equal(ignored.body.status,'ignored');assert.equal(processing.hasDatasetRetentionHold(invalid.id),true);
  const ambiguous=makeDataset('ambiguous',EMLID),second=Buffer.from(EMLID),secondSha=crypto.createHash('sha256').update(second).digest('hex'),secondPath=path.join(root,'datasets',ambiguous.relativePath,'second.csv');
  fs.writeFileSync(secondPath,second);database.prepare(`INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,metadata_json,created_at,mime_type)
    VALUES (?,?,?,?,?,?,'{}',?,?)`).run('ambiguous-second-csv',ambiguous.id,'second.csv',second.length,secondSha,'text/csv',new Date().toISOString(),'text/csv');
  const ambiguousResult=invoke('POST',autoRoute,{params:{datasetId:ambiguous.id},body:{},actorId:'ops:test'});
  assert.equal(ambiguousResult.body.status,'ignored');assert.equal(ambiguousResult.body.reason,'multiple_valid_csv_sources');
});
