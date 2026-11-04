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
  const set=gcp.importSet({datasetId:dataset.id,displayName:'Control',sourceFormat:'generic-csv-v1',sourceSha256:GCP_SOURCE_SHA,
    sourceContent:GCP_SOURCE,crs:'EPSG:4326',elevationUnits:'m',createdBy:'ops:1',
    points:[{externalId:'A',label:'A',latitude:44.5,longitude:-88.1,elevationM:250,description:null}]});
  const task=processing.createTask({projectId:project.id,datasetId:dataset.id,displayName:'Model'});
  const mark=gcp.createCorrespondence({taskId:task.id,pointId:set.points[0].id,imageFileId:'near',pixelX:120.5,pixelY:240.25,createdBy:'ops:1'});
  const provider=processing.upsertProvider({type:'nodeodm',displayName:'ODM',endpoint:'http://127.0.0.1:3000',enabled:true});
  const first=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}),firstSnapshot=processing.getAttemptGcpSnapshot(first.id);
  assert.equal(firstSnapshot.correspondenceCount,1);
  assert.equal(firstSnapshot.content,'EPSG:4326\n-88.1 44.5 250 120.5 240.25 near.jpg\n');
  assert.equal(firstSnapshot.sha256,crypto.createHash('sha256').update(firstSnapshot.content).digest('hex'));

  gcp.updateCorrespondence(mark.id,{pixelX:121,pixelY:241});
  assert.equal(processing.getAttemptGcpSnapshot(first.id).content,firstSnapshot.content);
  processing.cancelAttempt(first.id);
  const second=processing.retryAttempt(first.id,'ops:1'),secondSnapshot=processing.getAttemptGcpSnapshot(second.id);
  assert.match(secondSnapshot.content,/ 121 241 near\.jpg\n$/);
  assert.notEqual(secondSnapshot.sha256,firstSnapshot.sha256);
});

test('Emlid survey requires explicit mapping confirmation and snapshots metric projected XYZ',t=>{
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
 let attempt; try { attempt=processing.createAttempt({taskId:task.id,providerId:provider.id,options:{}}); } finally { GcpRepository.prototype.getSet=original; }
 assert.equal(reads,1);const content=processing.getAttemptGcpSnapshot(attempt.id).content;
 assert.match(content,/^EPSG:7600\n1000 2000 30\.48006096 121 241 far\.jpg\n1000 2000 30\.48006096 120 240 near\.jpg\n$/);
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

test('large photo dataset returns every nearby image across bounded pages', t => {
  const { processing, gcp } = fixture(t);
  const project = processing.createProject({ displayName: 'Large synthetic survey' });
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Flight', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const empty = crypto.createHash('sha256').digest('hex');
  const files = Array.from({ length: 16832 }, (_, i) => ({ id: `photo-${i}`, relativePath: `${i}.jpg`, byteSize: 0, sha256: empty, contentType: 'image/jpeg', metadata: { gps: { latitude: 44.5 + (i < 1001 ? 0.00001 : 0.01), longitude: -88.1 } } }));
  files.push({ id: 'control', relativePath: 'control.csv', byteSize: Buffer.byteLength(GCP_SOURCE), sha256: GCP_SOURCE_SHA, contentType: 'text/csv' });
  processing.finalizeDataset(dataset.id, files, empty);
  const set = gcp.importSet({ datasetId: dataset.id, displayName: 'Control', sourceFormat: 'generic-csv-v1', sourceFileId: 'control', sourceFilename: 'control.csv', sourceSha256: GCP_SOURCE_SHA, sourceContent: GCP_SOURCE, crs: 'EPSG:4326', elevationUnits: 'm', points: [{ externalId: 'GCP-01', label: 'Target', latitude: 44.5, longitude: -88.1, elevationM: 243.84, description: null }] });
  const seen = new Set();
  for (let offset = 0; offset < 1001; offset += 200) {
    const page = gcp.listRadiusImages(dataset.id, set.points[0].id, 15.24, 200, offset);
    assert.equal(page.total, 1001);
    for (const image of page.images) { assert.ok(!seen.has(image.id), 'photo must not appear on multiple pages'); seen.add(image.id); }
  }
  assert.equal(seen.size, 1001);
});
