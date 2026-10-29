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
