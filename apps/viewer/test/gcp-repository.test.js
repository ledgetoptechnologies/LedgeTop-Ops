'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
  return { database, processing, gcp };
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
  assert.equal(evidence.schemaVersion,1);
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
