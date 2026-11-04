'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { GcpRepository, haversineMeters } = require('../server/gcpRepository');
const { trashTaskTree } = require('../server/containerLifecycle');
const GCP_SOURCE='point_id,label,latitude,longitude,elevation_m\nGCP-01,Target,44.5,-88.1,243.84\n';
const GCP_SOURCE_SHA=crypto.createHash('sha256').update(GCP_SOURCE).digest('hex');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gcp-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database);
  const gcp = new GcpRepository(database);
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, database, processing, gcp };
}

function datasetFixture(t) {
  const context = fixture(t);
  const project = context.processing.createProject({ displayName: 'Survey' });
  const dataset = context.processing.createDataset({
    projectId: project.id, displayName: 'Flight', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID(),
  });
  const empty = crypto.createHash('sha256').digest('hex');
  context.processing.finalizeDataset(dataset.id, [
    { id: 'near', relativePath: 'near.jpg', byteSize: 0, sha256: empty, contentType: 'image/jpeg', metadata: { width: 6000, height: 4000, capturedAt: '2026:01:01 01:02:03', gps: { latitude: 44.5001, longitude: -88.1001, altitudeM: 250 } } },
    { id: 'far', relativePath: 'far.jpg', byteSize: 0, sha256: empty, contentType: 'image/jpeg', metadata: { width: 6000, height: 4000, capturedAt: '2026:01:01 01:02:04', gps: { latitude: 44.6, longitude: -88.2, altitudeM: 251 } } },
    { id: 'gcp-file', relativePath: 'control.csv', byteSize: Buffer.byteLength(GCP_SOURCE), sha256: GCP_SOURCE_SHA, contentType: 'text/csv' },
  ], empty);
  return { ...context, project, dataset: context.processing.getDataset(dataset.id) };
}

test('GCP sets retain stable canonical points and source-file association', (t) => {
  const { gcp, dataset } = datasetFixture(t);
  const input = {
    datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceFileId: 'gcp-file',
    sourceFilename: 'control.csv', sourceSha256: GCP_SOURCE_SHA, sourceContent: GCP_SOURCE, crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:1',
    points: [{ externalId: 'GCP-01', label: 'Target 1', latitude: 44.5, longitude: -88.1, elevationM: 243.84, description: null }],
  };
  const created = gcp.importSet(input), originalId = created.points[0].id;
  assert.equal(created.datasetId, dataset.id);
  assert.equal(created.sourceFileId, 'gcp-file');
  assert.equal(created.crs, 'EPSG:4326');
  assert.equal(created.elevationUnits, 'm');
  const retained=gcp.database.prepare('SELECT source_content,source_byte_size FROM gcp_sets WHERE id=?').get(created.id);
  assert.equal(retained.source_content,GCP_SOURCE);
  assert.equal(retained.source_byte_size,Buffer.byteLength(GCP_SOURCE));
  const updated = gcp.updatePoint(originalId, { label: 'Painted target', elevationM: 244 });
  assert.equal(updated.id, originalId);
  assert.equal(updated.elevationM, 244);
});

test('retained raw GCP source blocks dataset, task, project trash and dataset purge', (t) => {
  const { database, processing, gcp, project, dataset } = datasetFixture(t);
  const set = gcp.importSet({
    datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceFileId: 'gcp-file',
    sourceFilename: 'control.csv', sourceSha256: GCP_SOURCE_SHA, sourceContent: GCP_SOURCE, crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:retention',
    points: [{ externalId: 'GCP-01', label: 'Target', latitude: 44.5, longitude: -88.1, elevationM: 243.84, description: null }],
  });
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Retained GCP task'});
  assert.ok(set.id);
  assert.equal(gcp.deleteSet(set.id),true);
  assert.equal(gcp.getSet(set.id),null);
  const retainedCsv=database.prepare('SELECT dataset_id,source_file_id,sha256,byte_size,source_content FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(dataset.id,GCP_SOURCE_SHA);
  assert.equal(retainedCsv.dataset_id,dataset.id);
  assert.equal(retainedCsv.source_file_id,'gcp-file');
  assert.equal(retainedCsv.sha256,GCP_SOURCE_SHA);
  assert.equal(retainedCsv.byte_size,Buffer.byteLength(GCP_SOURCE));
  assert.equal(retainedCsv.source_content,GCP_SOURCE,'original CSV remains in immutable custody after its editable GCP set is deleted');
  assert.throws(()=>database.prepare('UPDATE retained_gcp_sources SET source_content=? WHERE dataset_id=?').run('tampered',dataset.id),/immutable/);
  assert.throws(()=>database.prepare('DELETE FROM retained_gcp_sources WHERE dataset_id=?').run(dataset.id),/permanent/);
  const reimported=gcp.importSet({datasetId:dataset.id,displayName:'Control retry',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',
    sourceFilename:'control.csv',sourceSha256:GCP_SOURCE_SHA,sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:retention',
    points:[{externalId:'GCP-01',label:'Target',latitude:44.5,longitude:-88.1,elevationM:243.84,description:null}]});
  assert.ok(reimported.id,'reimport reuses matching permanent source records after editable GCP-set deletion');
  assert.equal(database.prepare('SELECT COUNT(*) count FROM retained_dataset_files WHERE dataset_file_id=?').get('gcp-file').count,1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(dataset.id,GCP_SOURCE_SHA).count,1);
  assert.equal(gcp.deleteSet(reimported.id),true);
  const retained=database.prepare('SELECT dataset_file_id,sha256,byte_size,retention_reason FROM retained_dataset_files WHERE dataset_file_id=?').get('gcp-file');
  assert.equal(retained.dataset_file_id,'gcp-file');
  assert.equal(retained.sha256,GCP_SOURCE_SHA);
  assert.equal(retained.byte_size,Buffer.byteLength(GCP_SOURCE));
  assert.equal(retained.retention_reason,'gcp_source');
  assert.throws(()=>database.prepare('INSERT OR REPLACE INTO retained_dataset_files SELECT * FROM retained_dataset_files WHERE dataset_file_id=?').run('gcp-file'),
    /never reusable or replaceable/);
  const failedAt=new Date().toISOString();
  database.prepare(`INSERT INTO storage_mutations
    (id,mutation_type,entity_type,entity_id,trash_id,source_root_key,source_relative_path,
     destination_root_key,destination_relative_path,status,actor,created_at,updated_at)
    VALUES (?,'trash','dataset',?,?,'datasets',?,'trash',?,'failed','ops:retention',?,?)`)
    .run(crypto.randomUUID(),dataset.id,crypto.randomUUID(),dataset.relativePath,'dataset/failed-trash',failedAt,failedAt);
  assert.throws(()=>gcp.importSet({
    datasetId:dataset.id,displayName:'Control retry',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',
    sourceFilename:'control.csv',sourceSha256:GCP_SOURCE_SHA,sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',
    createdBy:'ops:retention',points:[{externalId:'GCP-01',label:'Target',latitude:44.5,longitude:-88.1,elevationM:243.84,description:null}],
  }),{code:'dataset_not_available'});
  assert.equal(processing.beginTrashMutation(dataset.id,'ops:retention'),null);
  assert.equal(processing.trashProject(project.id,'ops:retention'),null);
  assert.throws(()=>trashTaskTree(processing,{},task.id,'ops:retention'),{code:'task_not_trashable'});
  assert.equal(processing.getTask(task.id).status,'draft');

  // Exercise recovery of a pre-existing trash record created before this guard existed.
  const trashId=crypto.randomUUID(),createdAt=new Date().toISOString();
  database.prepare("UPDATE datasets SET status='trashed',trashed_at=?,updated_at=? WHERE id=?").run(createdAt,createdAt,dataset.id);
  database.prepare("INSERT INTO storage_trash(id,entity_type,entity_id,root_key,relative_path,purge_after,created_at) VALUES (?,'dataset',?,'trash','dataset/retained',?,?)")
    .run(trashId,dataset.id,new Date(Date.now()+86400000).toISOString(),createdAt);
  assert.equal(processing.beginPurgeMutation(trashId,'ops:retention'),null);
});

test('source custody migration verifies legacy CSV bytes and holds corrupt historical evidence', (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ltds-gcp-backfill-')),file=path.join(root,'viewer.sqlite');
  let database=openDatabase(file);
  t.after(()=>{try{database.close();}catch{}fs.rmSync(root,{recursive:true,force:true});});
  const processing=new ProcessingRepository(database),gcp=new GcpRepository(database),project=processing.createProject({displayName:'Backfill'});
  const validDataset=processing.createDataset({projectId:project.id,displayName:'Valid CSV',storageMode:'managed',rootKey:'datasets',relativePath:'valid'});
  const badDataset=processing.createDataset({projectId:project.id,displayName:'Corrupt CSV',storageMode:'managed',rootKey:'datasets',relativePath:'corrupt'});
  const invalidUtf8Dataset=processing.createDataset({projectId:project.id,displayName:'Invalid UTF-8 CSV',storageMode:'managed',rootKey:'datasets',relativePath:'invalid-utf8'});
  const unicodeDataset=processing.createDataset({projectId:project.id,displayName:'Unicode CSV',storageMode:'managed',rootKey:'datasets',relativePath:'unicode'});
  const finalize=(dataset,id)=>processing.finalizeDataset(dataset.id,[{id,relativePath:'photo.jpg',byteSize:0,sha256:crypto.createHash('sha256').digest('hex'),contentType:'image/jpeg'}],crypto.createHash('sha256').digest('hex'));
  finalize(validDataset,'valid-image');finalize(badDataset,'bad-image');finalize(invalidUtf8Dataset,'invalid-utf8-image');finalize(unicodeDataset,'unicode-image');
  const importSource=(dataset,content,name,sourceFileId=null)=>gcp.importSet({datasetId:dataset.id,displayName:name,sourceFormat:'generic-csv-v1',sourceFileId,sourceFilename:sourceFileId?'control.csv':null,sourceSha256:crypto.createHash('sha256').update(content).digest('hex'),sourceContent:content,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:test',points:[{externalId:name,label:name,latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  const badSource='point_id,label,latitude,longitude,elevation_m\nBAD,Bad,44.5,-88.1,250\n',badSha=crypto.createHash('sha256').update(badSource).digest('hex');
  database.prepare('INSERT INTO dataset_files(id,dataset_id,relative_path,byte_size,sha256,content_type,created_at) VALUES (?,?,?,?,?,?,?)')
    .run('bad-csv',badDataset.id,'control.csv',Buffer.byteLength(badSource),badSha,'text/csv',new Date().toISOString());
  const good=importSource(validDataset,GCP_SOURCE,'Good'),bad=importSource(badDataset,badSource,'Bad','bad-csv');
  const invalidUtf8=importSource(invalidUtf8Dataset,GCP_SOURCE,'Invalid UTF-8');
  const unicodeSource='\uFEFFpoint_id,label,latitude,longitude\nUNICODE,Café,44.5,-88.1\n';
  importSource(unicodeDataset,unicodeSource,'Unicode');
  const replacementSha=crypto.createHash('sha256').update('\uFFFD').digest('hex');
  // This metadata matches the raw three-byte SQLite TEXT value while its hash
  // matches Node's replacement-decoded three-byte string. A string-based
  // migration would accept the wrong bytes under the claimed digest.
  database.prepare("UPDATE gcp_sets SET source_content=CAST(x'F09080' AS TEXT),source_byte_size=?,source_sha256=? WHERE id=?")
    .run(3,replacementSha,invalidUtf8.id);
  const largeCorruptSource='x'.repeat(2097153);
  database.prepare('UPDATE gcp_sets SET source_content=? WHERE id=?').run(largeCorruptSource,bad.id);
  database.exec(`DROP TRIGGER retained_gcp_sources_no_insert_replace; DROP TRIGGER retained_gcp_sources_no_update; DROP TRIGGER retained_gcp_sources_no_delete;
    DROP TRIGGER retained_gcp_source_issues_no_insert_replace; DROP TRIGGER retained_gcp_source_issues_no_update; DROP TRIGGER retained_gcp_source_issues_no_delete;
    DROP TRIGGER gcp_sets_source_issue_delete_guard;
    DROP INDEX retained_gcp_sources_dataset_sha_idx; DROP INDEX retained_gcp_source_issues_dataset_idx;
    DROP TABLE retained_gcp_sources; DROP TABLE retained_gcp_source_issues; DELETE FROM schema_migrations WHERE version=47;`);
  database.exec('PRAGMA foreign_keys=OFF');
  database.prepare('UPDATE gcp_sets SET id=NULL WHERE id=?').run(good.id);
  database.exec('PRAGMA foreign_keys=ON');
  assert.throws(()=>openDatabase(file),{code:'invalid_legacy_gcp_set_id'},'malformed legacy identity aborts the migration rather than losing its custody record');
  database.exec('PRAGMA foreign_keys=OFF');
  database.prepare('UPDATE gcp_sets SET id=? WHERE id IS NULL').run(good.id);
  database.exec('PRAGMA foreign_keys=ON');
  database.close();database=openDatabase(file);
  assert.equal(database.prepare('SELECT source_content FROM retained_gcp_sources WHERE dataset_id=?').get(validDataset.id).source_content,GCP_SOURCE);
  assert.equal(database.prepare('SELECT source_content FROM retained_gcp_sources WHERE dataset_id=?').get(unicodeDataset.id).source_content,unicodeSource,
    'valid UTF-8 including a BOM and multibyte text is retained byte-for-byte');
  assert.equal(database.prepare('SELECT issue_code FROM retained_gcp_source_issues WHERE gcp_set_id=?').get(bad.id).issue_code,'source_content_checksum_or_size_mismatch');
  assert.equal(database.prepare('SELECT observed_byte_size FROM retained_gcp_source_issues WHERE gcp_set_id=?').get(bad.id).observed_byte_size,2097153);
  const invalidUtf8Issue=database.prepare('SELECT issue_code,observed_byte_size,observed_sha256 FROM retained_gcp_source_issues WHERE gcp_set_id=?').get(invalidUtf8.id);
  assert.equal(invalidUtf8Issue.issue_code,'source_content_checksum_or_size_mismatch');
  assert.equal(invalidUtf8Issue.observed_byte_size,3);
  assert.equal(invalidUtf8Issue.observed_sha256,crypto.createHash('sha256').update(Buffer.from([0xf0,0x90,0x80])).digest('hex'));
  const recoveredProcessing=new ProcessingRepository(database);
  assert.equal(recoveredProcessing.hasDatasetRetentionHold(validDataset.id),true);
  assert.equal(recoveredProcessing.hasDatasetRetentionHold(badDataset.id),true,'unverified historical bytes remain held for review');
  assert.equal(recoveredProcessing.hasDatasetRetentionHold(invalidUtf8Dataset.id),true,'malformed UTF-8 remains held for review');
  assert.equal(recoveredProcessing.beginTrashMutation(badDataset.id,'ops:test'),null);
  assert.equal(recoveredProcessing.trashProject(project.id,'ops:test'),null);
  const recoveredGcp=new GcpRepository(database);
  assert.throws(()=>recoveredGcp.deleteSet(bad.id),{code:'gcp_source_requires_review'});
  assert.equal(recoveredGcp.database.prepare('SELECT length(CAST(source_content AS BLOB)) size FROM gcp_sets WHERE id=?').get(bad.id).size,2097153);
  const repaired=recoveredGcp.importSet({datasetId:badDataset.id,displayName:'Corrected source',sourceFormat:'generic-csv-v1',sourceFileId:'bad-csv',sourceFilename:'control.csv',sourceSha256:badSha,sourceContent:badSource,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:repair',points:[{externalId:'Corrected',label:'Corrected',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  assert.notEqual(repaired.id,bad.id,'reimport does not return a corrupt matching legacy set');
  assert.equal(recoveredGcp.database.prepare('SELECT source_content FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(badDataset.id,badSha).source_content,badSource);
  assert.ok(good.id);
});

test('two SQLite writers converge concurrent duplicate source imports on one immutable custody record',async(t)=>{
  const {root,database,processing,dataset}=datasetFixture(t),sourcePath=path.join(root,'viewer.sqlite'),payload={datasetId:dataset.id,displayName:'Concurrent control',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',sourceFilename:'control.csv',
    sourceSha256:GCP_SOURCE_SHA,sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:concurrency',
    points:[{externalId:'GCP-01',label:'Target',latitude:44.5,longitude:-88.1,elevationM:243.84,description:null}]};
  assert.ok(processing.getDataset(dataset.id));
  const childSource=`const {openDatabase}=require(process.argv[1]);const {GcpRepository}=require(process.argv[2]);const db=openDatabase(process.argv[3]);try{const set=new GcpRepository(db).importSet(JSON.parse(process.argv[4]));process.stdout.write(set.id);}finally{db.close();}`;
  const run=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['-e',childSource,path.resolve(__dirname,'../server/database.js'),path.resolve(__dirname,'../server/gcpRepository.js'),sourcePath,JSON.stringify(payload)],{stdio:['ignore','pipe','pipe']});const out=[],err=[];child.stdout.on('data',(chunk)=>out.push(chunk));child.stderr.on('data',(chunk)=>err.push(chunk));child.once('error',reject);child.once('close',(code)=>code===0?resolve(Buffer.concat(out).toString()):reject(new Error(Buffer.concat(err).toString()||`child exited ${code}`)));});
  const ids=await Promise.all([run(),run()]);
  assert.equal(ids[0],ids[1]);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM gcp_sets WHERE dataset_id=? AND source_file_id=? AND source_sha256=?').get(dataset.id,'gcp-file',GCP_SOURCE_SHA).count,1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM retained_gcp_sources WHERE dataset_id=? AND sha256=?').get(dataset.id,GCP_SOURCE_SHA).count,1);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM retained_dataset_files WHERE dataset_file_id=?').get('gcp-file').count,1);
});

test('first GCP import rejects a source-file byte size that differs from verified CSV bytes', (t) => {
  const {database,processing,dataset}=datasetFixture(t);
  database.prepare('UPDATE dataset_files SET byte_size=byte_size+1 WHERE id=?').run('gcp-file');
  const gcp=new GcpRepository(database);
  assert.throws(()=>gcp.importSet({datasetId:dataset.id,displayName:'Bad metadata',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',sourceFilename:'control.csv',
    sourceSha256:GCP_SOURCE_SHA,sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:test',
    points:[{externalId:'GCP-01',label:'Target',latitude:44.5,longitude:-88.1,elevationM:243.84,description:null}]}),{code:'invalid_source_file'});
  assert.equal(database.prepare('SELECT COUNT(*) count FROM gcp_sets WHERE dataset_id=?').get(dataset.id).count,0);
  assert.equal(database.prepare('SELECT COUNT(*) count FROM retained_gcp_sources WHERE dataset_id=?').get(dataset.id).count,0);
});

test('image suggestions reuse indexed EXIF GPS and rank distance without claiming visibility', (t) => {
  const { gcp, dataset } = datasetFixture(t);
  const set = gcp.importSet({
    datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceSha256: crypto.createHash('sha256').update('source').digest('hex'), sourceContent:'source',
    crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:1',
    points: [{ externalId: 'A', label: 'A', latitude: 44.5, longitude: -88.1, elevationM: 250, description: null }],
  });
  const ranked = gcp.listRankedImages(dataset.id, set.points[0].id, 10);
  assert.deepEqual(ranked.images.map((image) => image.id), ['near', 'far']);
  assert.ok(ranked.images[0].distanceM < ranked.images[1].distanceM);
  assert.deepEqual(gcp.listRankedImages(dataset.id,set.points[0].id,1,1).images.map((image)=>image.id),['far']);
  assert.ok(haversineMeters(44.5, -88.1, 44.5001, -88.1001) < 20);
});

test('manual image correspondences enforce one dataset and preserve stable IDs on edit', (t) => {
  const { processing, gcp, project, dataset } = datasetFixture(t);
  const set = gcp.importSet({
    datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceSha256: crypto.createHash('sha256').update('source').digest('hex'), sourceContent:'source',
    crs: 'EPSG:4326', elevationUnits: 'm', createdBy: 'ops:1',
    points: [{ externalId: 'A', label: 'A', latitude: 44.5, longitude: -88.1, elevationM: 250, description: null }],
  });
  const task = processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Model' });
  const created = gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'near', pixelX: 120.5, pixelY: 240.25, createdBy: 'ops:1' });
  const updated = gcp.updateCorrespondence(created.id, { pixelX: 121, pixelY: 241 });
  assert.equal(updated.id, created.id);
  assert.equal(updated.pixelX, 121);
  assert.throws(() => gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'near', pixelX: 1, pixelY: 1 }), (error) => error.code === 'correspondence_exists');
  assert.throws(() => gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'far', pixelX: 6000, pixelY: 1 }), (error) => error.code === 'gcp_pixel_out_of_bounds');
  assert.throws(() => gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'gcp-file', pixelX: 1, pixelY: 1 }), (error) => error.code === 'invalid_gcp_image');

  const otherProject = processing.createProject({ displayName: 'Other' });
  const otherDataset = processing.createDataset({ projectId: otherProject.id, displayName: 'Other', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  processing.finalizeDataset(otherDataset.id, [{ id: 'other-image', relativePath: 'other.jpg', byteSize: 0, sha256: empty, contentType: 'image/jpeg', metadata: { gps: { latitude: 44.5, longitude: -88.1 } } }], empty);
  assert.throws(() => gcp.createCorrespondence({ taskId: task.id, pointId: set.points[0].id, imageFileId: 'other-image', pixelX: 1, pixelY: 1 }), (error) => error.code === 'gcp_dataset_mismatch');
});

test('each processing attempt snapshots deterministic private ODM correspondences', (t) => {
  const { processing,gcp,project,dataset }=datasetFixture(t);
  const set=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',sourceFilename:'control.csv',sourceSha256:GCP_SOURCE_SHA,
    sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:1',
    points:[{externalId:'A',label:'A',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});
  const mark=gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:120.5,pixelY:240.25,createdBy:'ops:1'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const first=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),firstSnapshot=processing.getAttemptGcpSnapshot(first.id);
  assert.equal(firstSnapshot.correspondenceCount,1);
  assert.equal(firstSnapshot.content,'EPSG:4326\n-88.1 44.5 250 120.5 240.25 near.jpg\n');
  assert.equal(firstSnapshot.sha256,crypto.createHash('sha256').update(firstSnapshot.content).digest('hex'));
  const evidence=processing.getAttemptGcpEvidence(first.id);
  assert.equal(evidence.schemaVersion,2);
  assert.deepEqual(evidence.snapshot.sourceGcpDatasetFileIds,['gcp-file']);
  assert.deepEqual(evidence.snapshot.imageDatasetFileIds,['near']);
  assert.deepEqual(evidence.correspondences[0],{
    correspondenceId:mark.id,gcpPointId:set.points[0].id,gcpSetId:set.id,externalId:'A',label:'A',latitude:44.5,longitude:-88.1,elevationM:250,
    sourceGcpDatasetFileId:'gcp-file',sourceGcpSha256:GCP_SOURCE_SHA,sourceGcpRelativePath:'control.csv',imageDatasetFileId:'near',imageRelativePath:'near.jpg',
    imageWidth:6000,imageHeight:4000,pixelX:120.5,pixelY:240.25,
  });
  assert.throws(()=>processing.database.prepare('UPDATE processing_attempt_gcp_snapshots SET evidence_json=NULL WHERE attempt_id=?').run(first.id),/gcp_snapshot_immutable/);

  gcp.updateCorrespondence(mark.id,{pixelX:121,pixelY:241});
  assert.equal(processing.getAttemptGcpSnapshot(first.id).content,firstSnapshot.content);
  assert.equal(processing.getAttemptGcpEvidence(first.id).correspondences[0].pixelX,120.5);
  processing.cancelAttempt(first.id);
  const second=processing.retryAttempt(first.id,'ops:1'),secondSnapshot=processing.getAttemptGcpSnapshot(second.id);
  assert.match(secondSnapshot.content,/ 121 241 near\.jpg\n$/);
  assert.notEqual(secondSnapshot.sha256,firstSnapshot.sha256);
  gcp.deleteSet(set.id);
  assert.equal(processing.getAttemptGcpEvidence(second.id).correspondences[0].pixelX,121);
});

test('legacy v1 GCP evidence remains readable without being reinterpreted as v2', (t) => {
  const { processing,gcp,project,dataset }=datasetFixture(t);
  const set=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceFileId:'gcp-file',sourceFilename:'control.csv',sourceSha256:GCP_SOURCE_SHA,
    sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:1',
    points:[{externalId:'A',label:'A',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});
  gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:120.5,pixelY:240.25,createdBy:'ops:1'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  const legacy=JSON.parse(processing.database.prepare('SELECT evidence_json FROM processing_attempt_gcp_snapshots WHERE attempt_id=?').get(attempt.id).evidence_json);
  legacy.schemaVersion=1;
  delete legacy.coordinateContract;
  processing.database.exec('DROP TRIGGER processing_attempt_gcp_snapshot_no_update');
  processing.database.prepare('UPDATE processing_attempt_gcp_snapshots SET evidence_json=? WHERE attempt_id=?').run(JSON.stringify(legacy),attempt.id);
  const retained=processing.getAttemptGcpEvidence(attempt.id);
  assert.equal(retained.schemaVersion,1);
  assert.equal(Object.hasOwn(retained,'coordinateContract'),false);
});

test('GCP snapshots without an immutable raw source file are not trusted transfer evidence', (t) => {
  const { processing,gcp,project,dataset }=datasetFixture(t);
  const set=gcp.importSet({datasetId:dataset.id,displayName:'Unlinked Control',sourceFormat:'generic-csv-v1',sourceSha256:GCP_SOURCE_SHA,
    sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:1',
    points:[{externalId:'A',label:'Target',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});
  gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:120.5,pixelY:240.25,createdBy:'ops:1'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}});
  assert.equal(processing.getAttemptGcpEvidence(attempt.id),null);
});

test('Emlid survey requires explicit mapping and holds projected output pending evidence binding',t=>{
 const {processing,gcp,project,dataset}=datasetFixture(t), {parseGcpInterchange}=require('../server/gcpImport');
 const source='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1000,2000,100,41.434647213675284,-91.92188915701674,110,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n',parsed=parseGcpInterchange({format:'emlid-all-columns-v1',content:source});
 const set=gcp.importSet({datasetId:dataset.id,displayName:'Emlid',sourceFormat:'emlid-all-columns-v1',sourceSha256:parsed.sourceSha256,sourceContent:source,crs:parsed.crs,elevationUnits:'m',provenance:parsed.provenance,points:parsed.points,createdBy:'ops:1'});
 assert.equal(set.odmCrsCandidate.epsgCode,7600);assert.equal(set.odmCrsConfirmed,false);
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:120,pixelY:240,createdBy:'ops:1'});
 const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
 assert.throws(()=>processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),{code:'gcp_crs_confirmation_required'});
 assert.equal(gcp.confirmOdmCrs(set.id,'ops:1').odmCrsConfirmed,true);
 gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'far',pixelX:121,pixelY:241,createdBy:'ops:1'});
 const original=GcpRepository.prototype.getSet; let reads=0; GcpRepository.prototype.getSet=function(...args){reads++;return original.apply(this,args);};
 try { assert.throws(()=>processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),{code:'gcp_output_evidence_binding_required'}); } finally { GcpRepository.prototype.getSet=original; }
 assert.equal(reads,1); assert.equal(processing.listAttemptsPage(task.id).items.length,0);
});

test('legacy GCP set without provenance is never omitted from attempt snapshot', t=>{
 const {processing,gcp,project,dataset,database}=datasetFixture(t);
 const set=gcp.importSet({datasetId:dataset.id,displayName:'Legacy',sourceFormat:'generic-csv-v1',sourceSha256:GCP_SOURCE_SHA,sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',points:[{externalId:'A',label:'A',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
 const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:100,pixelY:200});
 database.prepare('DELETE FROM gcp_import_provenance WHERE set_id=?').run(set.id);
 const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
 const attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),snapshot=processing.getAttemptGcpSnapshot(attempt.id);
 assert.equal(snapshot.correspondenceCount,1);assert.match(snapshot.content,/-88\.1 44\.5 250 100 200 near\.jpg/);
});

test('verified survey mapping rejects geographic or wrong-unit EPSG',t=>{
 const {gcp,dataset}=datasetFixture(t),{parseGcpInterchange}=require('../server/gcpImport');
 const source='Name,Easting,Northing,Elevation,Latitude,Longitude,Ellipsoidal height,CS name\nA,1000,2000,100,41.434647213675284,-91.92188915701674,110,NAD83(2011) / WISCRS Dodge and Jefferson (ftUS) + NAVD88(GEOID18) height (ftUS)\n',parsed=parseGcpInterchange({format:'emlid-all-columns-v1',content:source});
 const set=gcp.importSet({datasetId:dataset.id,displayName:'Survey',sourceFormat:'emlid-all-columns-v1',sourceSha256:parsed.sourceSha256,sourceContent:source,crs:parsed.crs,elevationUnits:'m',provenance:parsed.provenance,points:parsed.points});
 for(const epsgCode of [4326,7541])assert.throws(()=>gcp.confirmOdmCrs(set.id,'ops:1',{epsgCode,horizontalUnit:'ftUS',verticalDatum:parsed.provenance.verticalDatum}),{code:'gcp_crs_unmapped'});
 assert.equal(gcp.confirmOdmCrs(set.id,'ops:1',{}).odmCrs.epsgCode,7600);
 const db=gcp.database;db.prepare('UPDATE gcp_points SET latitude=latitude+1 WHERE set_id=?').run(set.id);assert.equal(gcp.getSet(set.id).odmCrsConfirmed,false);
});
