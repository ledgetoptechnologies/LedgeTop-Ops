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


test('external referenced source cannot delete the retained database copy',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-external-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),dataset=p.createDataset({projectId:project.id,displayName:'Reference',storageMode:'external_reference',rootKey:'datasets',relativePath:'source'}),source='point_id,label,latitude,longitude,elevation_m\nA,A,1,2,3\n';
 p.finalizeDataset(dataset.id,[{id:'external-csv',relativePath:'control.csv',byteSize:Buffer.byteLength(source),sha256:digest(source)}],digest(source));
 const parsed=require('../server/gcpImport').parseGcpInterchange({format:'generic-csv-v1',content:source}),g=new GcpRepository(db),set=g.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceFileId:'external-csv',sourceFilename:'control.csv',sourceSha256:parsed.sourceSha256,sourceContent:source,crs:parsed.crs,elevationUnits:'m',provenance:parsed.provenance,points:parsed.points});
 assert.throws(()=>g.deleteSet(set.id),{code:'retained_csv'});assert.equal(db.prepare('SELECT source_content FROM gcp_sets WHERE id=?').get(set.id).source_content,source);
});

test('retained datasets and containers do not starve later expired trash',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-batch-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),insert=db.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_at) VALUES (?,?,?,'datasets','source',0,'2020-01-01','2020-01-01')");
 const protectedIds=[];
 for(let i=0;i<21;i++){const d=p.createDataset({projectId:project.id,displayName:`Retain ${i}`,storageMode:'managed',rootKey:'datasets',relativePath:`source${i}`});p.finalizeDataset(d.id,[{id:`csv${i}`,relativePath:'raw.CSV',byteSize:1,sha256:digest('x')}],digest('m'));db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(d.id);insert.run(`protected-${i}`,'dataset',d.id);protectedIds.push(`protected-${i}`);}
 const eligible=p.createDataset({projectId:project.id,displayName:'Eligible',storageMode:'external_reference',rootKey:'datasets',relativePath:'external'});db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(eligible.id);insert.run('eligible','dataset',eligible.id);
 assert.equal(p.expiredTrash().slice(0,20).every(item=>protectedIds.includes(item.id)),true);
 const {purgeExpiredTrash}=require('../server/storageLifecycle');const result=purgeExpiredTrash(p,{},{});assert.equal(result.find(item=>item.trashId==='eligible')?.status,'complete');assert.ok(p.getTrash('eligible').permanentlyDeletedAt);for(const id of protectedIds)assert.equal(p.getTrash(id).permanentlyDeletedAt,null);
});

test('failed raw-copy manifest protects partial CSV from dataset, container and replay purge',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-partial-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),d=p.createDataset({projectId:project.id,displayName:'Partial',storageMode:'managed',rootKey:'datasets',relativePath:'source'}),timestamp='2020-01-01T00:00:00.000Z';
 const manifest={rawPhotoCopy:true,files:[{sourcePath:'survey/raw.csv',relativePath:'raw.csv'}]};
 db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,available_at,created_at,updated_at) VALUES ('copy','import_adopt','test',?,?,'failed',?,?,?)").run(d.id,JSON.stringify(manifest),timestamp,timestamp,timestamp);
 db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(d.id);const insert=db.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_at) VALUES (?,?,?,'datasets','source',0,?,?)");insert.run('partial','dataset',d.id,timestamp,timestamp);insert.run('container','project',project.id,timestamp,timestamp);db.prepare("INSERT INTO container_trash_members(container_trash_id,member_trash_id,entity_type,entity_id,created_at) VALUES ('container','partial','dataset',?,?)").run(d.id,timestamp);
 const partialPath=path.join(root,'raw.csv'),raw='partial copy of survey data';fs.writeFileSync(partialPath,raw);
 assert.equal(p.datasetHasRetainedCsv(d.id),true);assert.equal(p.beginPurgeMutation('partial','test'),null);
 const {applyStorageMutation,purgeExpiredTrash}=require('../server/storageLifecycle');let removed=false;const storage={pathExistsStrict:()=>true,removeExact:()=>{removed=true;fs.unlinkSync(partialPath)}};const mutation={id:'prior',type:'purge',entityType:'dataset',entityId:d.id,status:'intent',sourceRootKey:'trash',sourceRelativePath:'source'};assert.throws(()=>applyStorageMutation(p,storage,mutation),{code:'retained_csv'});assert.deepEqual(purgeExpiredTrash(p,storage),[]);assert.equal(removed,false);assert.equal(fs.readFileSync(partialPath,'utf8'),raw);assert.equal(p.getTrash('partial').permanentlyDeletedAt,null);assert.equal(p.getTrash('container').permanentlyDeletedAt,null);
});

test('failed generic adoption retains a moved CSV before indexing, without protecting finalized non-CSV imports',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-adopt-retain-'));for(const name of ['datasets','models','cache','trash','imports'])fs.mkdirSync(path.join(root,name));
 const db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const p=new ProcessingRepository(db),{StorageManager}=require('../server/storageManager'),{processOneDatasetOperation}=require('../server/datasetOperationWorker'),{applyStorageMutation,purgeExpiredTrash}=require('../server/storageLifecycle');
 const storage=new StorageManager({datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0});storage.initialize();
 const project=p.createProject({displayName:'Survey'}),body='original CSV bytes',subject='ops:test';
 async function enqueue(name,withCsv){const source=path.join(root,'imports',name);fs.mkdirSync(source);fs.writeFileSync(path.join(source,'photo.jpg'),'synthetic image');if(withCsv)fs.writeFileSync(path.join(source,'raw.csv'),body);const request={rootKey:'dataset_import',relativePath:name},preview=await storage.previewImport(request.rootKey,request.relativePath),record=p.createImportPreview({request,preview,createdBy:subject,createdSessionId:'session',expiresAt:'2099-01-01T00:00:00.000Z'});return p.createImportAdoptOperation({previewToken:record.token,sessionId:'session',subject,projectId:project.id,displayName:name,storageMode:'adopted'});}
 const operation=await enqueue('with-csv',true),finalize=p.finalizeDataset.bind(p);p.finalizeDataset=()=>{throw Object.assign(new Error('injected after adoption'),{code:'fault_injected'})};
 try{await processOneDatasetOperation({processing:p,storage,config:{}},'fixture-worker')}finally{p.finalizeDataset=finalize}
 assert.equal(p.getDatasetOperation(operation.id).status,'failed');const dataset=p.getDataset(operation.datasetId,true);assert.equal(dataset.files.length,0);assert.equal(dataset.manifestSha256,null);
 assert.equal(fs.existsSync(path.join(root,'imports','with-csv')),false);assert.equal(fs.readFileSync(path.join(root,'datasets',dataset.relativePath,'raw.csv'),'utf8'),body);
 const trashMutation=p.beginTrashMutation(dataset.id,subject);assert.ok(trashMutation);applyStorageMutation(p,storage,trashMutation);const trash=p.getTrash(trashMutation.trashId);
 assert.equal(p.datasetHasRetainedCsv(dataset.id),true);assert.equal(p.beginPurgeMutation(trash.id,subject),null);
 assert.throws(()=>applyStorageMutation(p,storage,{id:'prior',type:'purge',entityType:'dataset',entityId:dataset.id,status:'intent',sourceRootKey:'trash',sourceRelativePath:trash.relativePath}),{code:'retained_csv'});
 const plain=await enqueue('no-csv',false);await processOneDatasetOperation({processing:p,storage,config:{}},'fixture-worker');assert.equal(p.getDatasetOperation(plain.id).status,'succeeded');assert.equal(p.datasetHasRetainedCsv(plain.datasetId),false);
 const originalPayload=db.prepare('SELECT payload_json FROM dataset_operations WHERE id=?').get(plain.id).payload_json;db.prepare("UPDATE dataset_operations SET payload_json='{}' WHERE id=?").run(plain.id);assert.equal(p.datasetHasRetainedCsv(plain.datasetId),true);db.prepare('UPDATE dataset_operations SET payload_json=? WHERE id=?').run(originalPayload,plain.id);
 const plainMutation=p.beginTrashMutation(plain.datasetId,subject);applyStorageMutation(p,storage,plainMutation);db.prepare("UPDATE storage_trash SET purge_after='2020-01-01T00:00:00.000Z' WHERE id IN (?,?)").run(trash.id,plainMutation.trashId);
 const purged=purgeExpiredTrash(p,storage);assert.ok(purged.some(item=>item.trashId===plainMutation.trashId));assert.equal(p.getTrash(trash.id).permanentlyDeletedAt,null);assert.equal(fs.readFileSync(path.join(root,'trash',trash.relativePath,'raw.csv'),'utf8'),body);
});

test('failed cross-device adoption and refused external CSV reference retain their sources',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-adopt-modes-'));for(const name of ['datasets','models','cache','trash','imports'])fs.mkdirSync(path.join(root,name));
 const db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true})});
 const p=new ProcessingRepository(db),{StorageManager}=require('../server/storageManager'),{processOneDatasetOperation}=require('../server/datasetOperationWorker');
 const storage=new StorageManager({datasetsMount:path.join(root,'datasets'),modelsMount:path.join(root,'models'),cacheMount:path.join(root,'cache'),trashMount:path.join(root,'trash'),datasetImportMount:path.join(root,'imports'),storageReserveBytes:0,storageReservePercent:0});storage.initialize();
 const project=p.createProject({displayName:'Survey'}),body='original CSV bytes',subject='ops:test';
 async function enqueue(name,storageMode){const source=path.join(root,'imports',name);fs.mkdirSync(source);fs.writeFileSync(path.join(source,'raw.csv'),body);const request={rootKey:'dataset_import',relativePath:name},preview=await storage.previewImport(request.rootKey,request.relativePath),record=p.createImportPreview({request,preview,createdBy:subject,createdSessionId:'session',expiresAt:'2099-01-01T00:00:00.000Z'});return {source,operation:p.createImportAdoptOperation({previewToken:record.token,sessionId:'session',subject,projectId:project.id,displayName:name,storageMode})};}
 const copied=await enqueue('copied','adopted'),stat=fs.statSync,finalize=p.finalizeDataset.bind(p);p.finalizeDataset=()=>{throw Object.assign(new Error('injected after copy'),{code:'fault_injected'})};
 fs.statSync=(target,...args)=>{const actual=stat(target,...args);return String(target)===copied.source?new Proxy(actual,{get(value,key){return key==='dev'?actual.dev+1:Reflect.get(value,key)}}):actual};
 try{await processOneDatasetOperation({processing:p,storage,config:{}},'fixture-worker')}finally{fs.statSync=stat;p.finalizeDataset=finalize}
 assert.equal(p.getDatasetOperation(copied.operation.id).status,'failed');assert.equal(p.datasetHasRetainedCsv(copied.operation.datasetId),true);assert.equal(fs.readFileSync(path.join(copied.source,'raw.csv'),'utf8'),body);assert.equal(fs.readFileSync(path.join(root,'datasets',copied.operation.datasetId,'raw.csv'),'utf8'),body);
 const external=await enqueue('external','external_reference');await processOneDatasetOperation({processing:p,storage,config:{}},'fixture-worker');assert.equal(p.getDatasetOperation(external.operation.id).status,'failed');assert.equal(p.datasetHasRetainedCsv(external.operation.datasetId),true);assert.equal(fs.readFileSync(path.join(external.source,'raw.csv'),'utf8'),body);
});

test('expired trash scan rotates in bounded pages past a large retained prefix',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-pages-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),insert=db.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,byte_size,purge_after,created_at) VALUES (?,?,?,'datasets','source',0,'2020-01-01','2020-01-01')");
 const early=p.createDataset({projectId:project.id,displayName:'Early',storageMode:'external_reference',rootKey:'datasets',relativePath:'early'});db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(early.id);insert.run('early','dataset',early.id);db.prepare("UPDATE storage_trash SET purge_after='2999-01-01' WHERE id='early'").run();
 for(let i=0;i<205;i++){const d=p.createDataset({projectId:project.id,displayName:`Retained ${i}`,storageMode:'managed',rootKey:'datasets',relativePath:`s${i}`});p.finalizeDataset(d.id,[{id:`csv${i}`,relativePath:'raw.csv',byteSize:1,sha256:digest('x')}],digest('m'));db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(d.id);insert.run(`retained-${i}`,'dataset',d.id);}
 const d=p.createDataset({projectId:project.id,displayName:'Eligible',storageMode:'external_reference',rootKey:'datasets',relativePath:'external'});db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(d.id);insert.run('later','dataset',d.id);
 const {purgeExpiredTrash}=require('../server/storageLifecycle'),counts=[];const restart=()=>{const instance=new ProcessingRepository(db),page=instance.expiredTrashPage.bind(instance);instance.expiredTrashPage=(...args)=>{const result=page(...args);counts.push(result.length);return result};return instance};
 assert.deepEqual(purgeExpiredTrash(restart(),{}),[]);db.prepare("UPDATE storage_trash SET purge_after='2020-01-01' WHERE id='early'").run();for(let i=0;i<3;i++){const extra=p.createDataset({projectId:project.id,displayName:`New ${i}`,storageMode:'external_reference',rootKey:'datasets',relativePath:`new${i}`});db.prepare("UPDATE datasets SET status='trashed' WHERE id=?").run(extra.id);insert.run(`new-${i}`,'dataset',extra.id);}
 assert.deepEqual(purgeExpiredTrash(restart(),{}),[]);assert.equal(purgeExpiredTrash(restart(),{})[0]?.trashId,'later');assert.deepEqual(counts,[100,100,6]);assert.equal(purgeExpiredTrash(restart(),{})[0]?.trashId,'early');assert.ok(p.getTrash('early').permanentlyDeletedAt);assert.ok(p.getTrash('later').permanentlyDeletedAt);assert.equal(p.getTrash('retained-0').permanentlyDeletedAt,null);
});

test('trash scan lease prevents stale workers from overwriting progress and recovers after expiry',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-lease-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const a=new ProcessingRepository(db),b=new ProcessingRepository(db),now=Date.now();assert.equal(a.acquireTrashScanLease('worker-a',now,1000),true);assert.equal(b.acquireTrashScanLease('worker-b',now+1,1000),false);a.saveTrashScanCursor('worker-a',{after:0,highWater:3});assert.equal(b.acquireTrashScanLease('worker-b',now+1001,900000),true);assert.throws(()=>a.saveTrashScanCursor('worker-a',{after:3,highWater:3}),{code:'trash_scan_lease_lost'});a.releaseTrashScanLease('worker-a');assert.throws(()=>a.renewTrashScanLease('worker-a'),{code:'trash_scan_lease_lost'});b.saveTrashScanCursor('worker-b',{after:2,highWater:3});assert.deepEqual(new ProcessingRepository(db).trashScanCursor(),{after:2,highWater:3});b.releaseTrashScanLease('worker-b');assert.equal(a.acquireTrashScanLease('worker-c'),true);a.releaseTrashScanLease('worker-c');
});

test('malformed raw-copy and upload manifest paths fail closed',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'gcp-malformed-')),db=openDatabase(path.join(root,'db.sqlite'));t.after(()=>{db.close();fs.rmSync(root,{recursive:true,force:true});});
 const p=new ProcessingRepository(db),project=p.createProject({displayName:'Survey'}),d=p.createDataset({projectId:project.id,displayName:'Malformed',storageMode:'managed',rootKey:'datasets',relativePath:'source'}),timestamp='2020-01-01T00:00:00.000Z';
 db.prepare("INSERT INTO dataset_operations(id,operation_type,subject,dataset_id,payload_json,status,available_at,created_at,updated_at) VALUES ('bad','import_adopt','test',?,?,'failed',?,?,?)").run(d.id,JSON.stringify({rawPhotoCopy:true,files:[{relativePath:null}]}),timestamp,timestamp,timestamp);assert.equal(p.datasetHasRetainedCsv(d.id),true);
 for(const payload of ['{}','[]','not-json']){db.prepare("UPDATE dataset_operations SET payload_json=? WHERE id='bad'").run(payload);assert.equal(p.datasetHasRetainedCsv(d.id),true);}
 db.prepare("DELETE FROM dataset_operations WHERE id='bad'").run();const u=p.createUpload({datasetId:d.id,subject:'test',files:[{relativePath:42}],chunkSize:2,expiresAt:timestamp});assert.equal(p.datasetHasRetainedCsv(d.id),true);assert.ok(u.upload.id);
});
