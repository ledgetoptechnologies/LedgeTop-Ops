'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {openDatabase}=require('../server/database');
const {ProcessingRepository}=require('../server/processingRepository');
const {GcpRepository}=require('../server/gcpRepository');
const {discoverDatasetGcp}=require('../server/gcpDiscovery');
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
test('discovery recognizes Emlid CSV, ignores unrelated data, preserves exact source and is repeatable',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-discovery-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'Control',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
 const valid='\uFEFFName,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1,2,100,44,-88,101,Test (ftUS) + height (ftUS)\n',bad='ordinary,table\n1,2\n';
 fs.mkdirSync(path.join(root,'source'));fs.writeFileSync(path.join(root,'source','control.csv'),valid);fs.writeFileSync(path.join(root,'source','other.csv'),bad);
 const records=[['control.csv',valid],['other.csv',bad]].map(([relativePath,body])=>({id:relativePath,relativePath,byteSize:Buffer.byteLength(body),sha256:digest(body)}));
 p.finalizeDataset(dataset.id,records,digest('manifest'));const storage={resolve:(_,r)=>path.join(root,...r.split('/'))};
 assert.equal(discoverDatasetGcp({processing:p,storage,datasetId:dataset.id,actorId:'ops:test'}).length,1);
 assert.equal(discoverDatasetGcp({processing:p,storage,datasetId:dataset.id,actorId:'ops:test'}).length,1);
 const sets=new GcpRepository(db).listSets(dataset.id);assert.equal(sets.length,1);assert.equal(sets[0].sourceSha256,digest(valid));assert.equal(db.prepare('SELECT source_content FROM gcp_sets').get().source_content,valid);
 assert.equal(p.datasetHasRetainedCsv(dataset.id),true);
 fs.writeFileSync(path.join(root,'source','other.csv'),'changed');assert.throws(()=>discoverDatasetGcp({processing:p,storage,datasetId:dataset.id}),{code:'dataset_source_changed'});
});
test('empty required coordinates are never interpreted as zero',()=>{const {parseGcpInterchange}=require('../server/gcpImport');assert.throws(()=>parseGcpInterchange({format:'generic-csv-v1',content:'point_id,label,latitude,longitude,elevation_m\nA,A,,1,2\n'}),/required/);});

test('CSV datasets are protected from direct and resumed purge',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-retain-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'CSV',storageMode:'managed',rootKey:'datasets',relativePath:'source'}),source='not a gcp',sha=digest(source);
 p.finalizeDataset(dataset.id,[{id:'csv',relativePath:'unrecognized.csv',byteSize:source.length,sha256:sha}],sha);
 db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(dataset.id);db.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_at) VALUES ('trash-csv','dataset',?,'datasets','source',?,'2020-01-01','2020-01-01')").run(dataset.id,source.length);
 assert.equal(p.beginPurgeMutation('trash-csv','ops:test'),null);
 const {applyStorageMutation}=require('../server/storageLifecycle');let removed=false;
 const mutation={id:'old',type:'purge',entityType:'dataset',entityId:dataset.id,status:'intent',sourceRootKey:'trash',sourceRelativePath:'source'};
 assert.throws(()=>applyStorageMutation(p,{pathExistsStrict:()=>true,removeExact:()=>{removed=true;}},mutation),{code:'retained_csv'});assert.equal(removed,false);
});

test('expired incomplete CSV uploads remain retained and resumable',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-upload-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'draft',storageMode:'managed',rootKey:'datasets',relativePath:'source'});
 const files=[{id:'file-0',relativePath:'control.csv',byteSize:2,sha256:digest('ab')}];
 const u=p.createUpload({datasetId:dataset.id,subject:'ops:test',files,chunkSize:2,expiresAt:'2020-01-01T00:00:00.000Z'}).upload;
 assert.equal(p.hasUnfinishedCsvUploads(dataset.id),true);assert.equal(p.expiredUploads(Date.now()).includes(u.id),false);
 assert.equal(p.resumeUpload(dataset.id,'ops:test',files,'2099-01-01T00:00:00.000Z').upload.id,u.id);
});

test('manual CRS mapping requires source units and original vertical datum',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-mapping-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:'source'});p.finalizeDataset(dataset.id,[],digest('empty'));
 const source='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1000,2000,100,43,-88.8,110,Local grid (m) + height (m)\n',parsed=require('../server/gcpImport').parseGcpInterchange({format:'emlid-all-columns-v1',content:source}),g=new GcpRepository(db);
 const set=g.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'emlid-all-columns-v1',sourceSha256:parsed.sourceSha256,sourceContent:source,crs:parsed.crs,elevationUnits:'m',provenance:parsed.provenance,points:parsed.points});
 assert.equal(set.odmCrsCandidate,null);assert.throws(()=>g.confirmOdmCrs(set.id,'ops:test'),{code:'gcp_crs_unmapped'});
 assert.throws(()=>g.confirmOdmCrs(set.id,'ops:test',{epsgCode:32616,horizontalUnit:'ftUS',verticalDatum:parsed.provenance.verticalDatum}),{code:'gcp_crs_unmapped'});
 assert.throws(()=>g.confirmOdmCrs(set.id,'ops:test',{epsgCode:32616,horizontalUnit:'m',verticalDatum:parsed.provenance.verticalDatum}),{code:'gcp_crs_unmapped'});
});

test('PROJ validates the declared projected CRS, units, every survey coordinate, and confirmation freshness',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-proj-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'Flight',storageMode:'managed',rootKey:'datasets',relativePath:'source'});p.finalizeDataset(dataset.id,[],digest('empty'));
 const source='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,500000,0,100,0,-87,110,UTM example (m) + height (m)\n',parsed=require('../server/gcpImport').parseGcpInterchange({format:'emlid-all-columns-v1',content:source}),g=new GcpRepository(db);
 const set=g.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'emlid-all-columns-v1',sourceSha256:parsed.sourceSha256,sourceContent:source,crs:parsed.crs,elevationUnits:'m',provenance:parsed.provenance,points:parsed.points});
 const input={epsgCode:32616,horizontalUnit:'m',verticalDatum:parsed.provenance.verticalDatum};
 for(const epsgCode of [4326,7600,32615])assert.throws(()=>g.confirmOdmCrs(set.id,'ops:test',{...input,epsgCode}),{code:'gcp_crs_unmapped'});
 assert.equal(g.confirmOdmCrs(set.id,'ops:test',input).odmCrsConfirmed,true);
 db.prepare('UPDATE gcp_odm_crs_confirmations SET epsg_code=32615 WHERE set_id=?').run(set.id);assert.equal(g.getSet(set.id).odmCrsConfirmed,false);
 assert.equal(g.confirmOdmCrs(set.id,'ops:test',input).odmCrsConfirmed,true);
 db.prepare('UPDATE gcp_points SET easting=easting+100 WHERE set_id=?').run(set.id);assert.equal(g.getSet(set.id).odmCrsConfirmed,false);
 assert.throws(()=>g.confirmOdmCrs(set.id,'ops:test',input),{code:'gcp_crs_unmapped'});
});
