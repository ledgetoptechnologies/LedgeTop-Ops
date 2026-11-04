'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {discoverDatasetGcp}=require('../server/gcpDiscovery');
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
test('synthetic projected Emlid GCP is held until output evidence binds its CRS and units',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-combined-flow-')),db=openDatabase(path.join(root,'viewer.sqlite'));
 t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const processing=new ProcessingRepository(db),gcp=new GcpRepository(db),project=processing.createProject({displayName:'Synthetic'}),provider=processing.upsertProvider({type:'nodeodm',displayName:'Fixture',endpoint:'http://127.0.0.1:3000',enabled:true});
 const source='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,500000,0,100,0,-87,110,WGS 84 / UTM zone 16N (m) + NAVD88 height (m)\n',image=Buffer.from('synthetic-photo');
 const dataset=processing.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:'source'}),base=path.join(root,'source');fs.mkdirSync(base);fs.writeFileSync(path.join(base,'control.csv'),source);fs.writeFileSync(path.join(base,'photo.jpg'),image);
 processing.finalizeDataset(dataset.id,[{id:'csv',relativePath:'control.csv',byteSize:Buffer.byteLength(source),sha256:digest(source),contentType:'text/csv'},{id:'image',relativePath:'photo.jpg',byteSize:image.length,sha256:digest(image),contentType:'image/jpeg',metadata:{width:100,height:80,gps:{latitude:0.00001,longitude:-87}}}],digest('manifest'));
 const storage={resolve:(_,relative)=>path.join(root,...relative.split('/'))};
 const sets=discoverDatasetGcp({processing,storage,datasetId:dataset.id,actorId:'ops:test'});assert.equal(sets.length,1);const set=sets[0],point=gcp.getSet(set.id,true).points[0];
 const settings={providerId:provider.id,presetId:null,options:{dsm:true}},request={subject:'ops:test',submissionId:crypto.randomUUID(),requestHash:digest('request'),projectId:project.id,datasetId:dataset.id,displayName:'Flight',processingSettings:settings};
 const draft=processing.createTaskDraft(request).task;assert.equal(draft.status,'draft');assert.deepEqual(draft.metadata.pendingGcpProcessingSettings,settings);assert.equal(processing.listAttemptsPage(draft.id).items.length,0);
 const nearby=gcp.listRankedImages(dataset.id,point.id,null).images;assert.ok(nearby.find(photo=>photo.id==='image').distanceM<15.24);
 gcp.createCorrespondence({taskId:draft.id,pointId:point.id,imageFileId:'image',pixelX:12,pixelY:14,createdBy:'ops:test'});
 assert.throws(()=>processing.createAttempt({taskId:draft.id,providerId:provider.id,options:settings.options}),{code:'gcp_crs_confirmation_required'});
 const mapping={epsgCode:32616,horizontalUnit:'m',verticalDatum:set.provenance.verticalDatum};
 const validationHash=require('../server/gcpCrsValidation').surveyValidationHash(set.sourceSha256,mapping,gcp.getSet(set.id,true).points);
 db.prepare('INSERT INTO gcp_odm_crs_confirmations VALUES (?,?,?,?,?,?,?,?)').run(set.id,set.sourceSha256,mapping.epsgCode,mapping.horizontalUnit,mapping.verticalDatum,validationHash,'ops:test','2026-01-01');
 assert.equal(gcp.getSet(set.id).odmCrsConfirmed,true);
 assert.throws(()=>processing.createAttempt({taskId:draft.id,providerId:provider.id,options:settings.options}),{code:'gcp_output_evidence_binding_required'});
 assert.equal(processing.listAttemptsPage(draft.id).items.length,0);
 assert.equal(fs.readFileSync(path.join(base,'control.csv'),'utf8'),source);assert.equal(db.prepare('SELECT source_content FROM gcp_sets WHERE id=?').get(set.id).source_content,source);
});


test('no CSV and an unrelated CSV do not create GCP sets or block ordinary task creation',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-no-control-')),db=openDatabase(path.join(root,'viewer.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Synthetic'}),storage={resolve:(_,relative)=>path.join(root,...relative.split('/'))};
 for(const [name,csv] of [['no-csv',null],['invalid-csv','Name,Notes\nNot a control point,ordinary record\n']]){
  const dataset=p.createDataset({projectId:project.id,displayName:name,storageMode:'managed',rootKey:'datasets',relativePath:name}),folder=path.join(root,name);fs.mkdirSync(folder);
  const files=[];if(csv!==null){fs.writeFileSync(path.join(folder,'ordinary.csv'),csv);files.push({relativePath:'ordinary.csv',byteSize:Buffer.byteLength(csv),sha256:digest(csv),contentType:'text/csv'});}
  p.finalizeDataset(dataset.id,files,digest('manifest'));assert.deepEqual(discoverDatasetGcp({processing:p,storage,datasetId:dataset.id,actorId:'ops:test'}),[]);
  assert.equal(new GcpRepository(db).listSets(dataset.id).length,0);assert.equal(p.createTask({projectId:project.id,datasetId:dataset.id,displayName:name}).status,'draft');
  if(csv!==null)assert.equal(fs.readFileSync(path.join(folder,'ordinary.csv'),'utf8'),csv);
 }
});
