'use strict';

// Control points vs checkpoints, and the NAVD88 height contract of gcp_list.txt.
// Every coordinate here is invented; no client data.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { GcpRepository } = require('../server/gcpRepository');
const { parseGcpInterchange } = require('../server/gcpImport');

const FT_US = 1200 / 3937;
const CS = 'NAD83(2011) / Synthetic Zone (ftUS) + NAVD88 height (ftUS)';
// Emlid Flow "CSV" export columns (subset that matters plus extras Emlid writes).
const EMLID = [
  'Name,Code,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,Origin,Easting RMS,Northing RMS,Elevation RMS,CS name',
  `GCP1,GCP,1000.000,2000.000,820.000,nail,-89.5000000,44.5000000,706.600,Global,0.03,0.03,0.05,${CS}`,
  `GCP2,,1100.000,2000.000,821.000,nail,-89.4996000,44.5000000,707.600,Global,0.03,0.03,0.05,${CS}`,
  `CHK1,CP,1050.000,2050.000,822.500,nail,-89.4998000,44.5001500,709.100,Global,0.03,0.03,0.05,${CS}`,
].join('\n') + '\n';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gcp-roles-'));
  const database = openDatabase(path.join(root, 'viewer.sqlite'));
  t.after(() => { database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { database, processing: new ProcessingRepository(database), gcp: new GcpRepository(database) };
}

function datasetWithPhotos(c, names) {
  const project = c.processing.createProject({ displayName: 'Survey' });
  const draft = c.processing.createDataset({ projectId: project.id, displayName: 'Flight', storageMode: 'managed', rootKey: 'datasets', relativePath: crypto.randomUUID() });
  const files = names.map((name, index) => ({ id: `img${index}`, relativePath: name, byteSize: 10, sha256: crypto.createHash('sha256').update(name).digest('hex'),
    contentType: 'image/jpeg', metadata: { width: 4000, height: 3000, gps: { latitude: 44.5, longitude: -89.5 } } }));
  c.processing.finalizeDataset(draft.id, files, 'a'.repeat(64));
  return { project, dataset: draft, files };
}

function importEmlid(c, datasetId) {
  const parsed = parseGcpInterchange({ format: 'emlid-all-columns-v1', content: EMLID });
  return c.gcp.importSet({ datasetId, displayName: 'Emlid', sourceFormat: 'emlid-all-columns-v1', sourceSha256: parsed.sourceSha256,
    sourceContent: EMLID, crs: parsed.crs, elevationUnits: parsed.elevationUnits, provenance: parsed.provenance, points: parsed.points });
}

test('schema 93 adds a control/checkpoint role that defaults to control', (t) => {
  const c = fixture(t);
  assert.equal(c.database.prepare('SELECT name FROM schema_migrations WHERE version=93').get()?.name, 'gcp_point_roles');
  const column = c.database.prepare('PRAGMA table_info(gcp_points)').all().find((row) => row.name === 'role');
  assert.equal(column?.notnull, 1);
  assert.equal(column?.dflt_value, "'control'");
  assert.ok(c.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='processing_attempt_gcp_checkpoints'").get());
});

test('Emlid Code column marks checkpoints; blank or other codes stay control', () => {
  const parsed = parseGcpInterchange({ format: 'emlid-all-columns-v1', content: EMLID });
  assert.deepEqual(parsed.points.map((point) => [point.externalId, point.role]), [['GCP1', 'control'], ['GCP2', 'control'], ['CHK1', 'checkpoint']]);
});

test('generic CSV accepts an optional role column and rejects unknown roles', () => {
  const base = 'point_id,label,latitude,longitude,elevation_m,role\n';
  const parsed = parseGcpInterchange({ format: 'generic-csv-v1', content: `${base}A,A,44.5,-89.5,250,control\nB,B,44.5,-89.4,251,checkpoint\nC,C,44.4,-89.5,252,\n` });
  assert.deepEqual(parsed.points.map((point) => point.role), ['control', 'checkpoint', 'control']);
  assert.throws(() => parseGcpInterchange({ format: 'generic-csv-v1', content: `${base}A,A,44.5,-89.5,250,maybe\n` }),
    (error) => error.code === 'invalid_gcp_input');
});

test('a point role can be changed and is returned with the point', (t) => {
  const c = fixture(t), { dataset } = datasetWithPhotos(c, ['a.jpg']);
  const set = importEmlid(c, dataset.id), point = set.points.find((row) => row.externalId === 'GCP2');
  assert.equal(point.role, 'control');
  assert.equal(c.gcp.updatePoint(point.id, { role: 'checkpoint' }).role, 'checkpoint');
  assert.throws(() => c.gcp.updatePoint(point.id, { role: 'other' }), (error) => error.code === 'invalid_gcp_point');
});

test('submit sends controls only, with labels and NAVD88 heights, and freezes checkpoints separately', (t) => {
  const c = fixture(t), { project, dataset } = datasetWithPhotos(c, ['DJI_0001.JPG', 'DJI_0002.JPG']);
  const set = importEmlid(c, dataset.id), byName = Object.fromEntries(set.points.map((point) => [point.externalId, point]));
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Model' });
  c.gcp.createCorrespondence({ taskId: task.id, pointId: byName.GCP1.id, imageFileId: 'img0', pixelX: 100, pixelY: 200 });
  c.gcp.createCorrespondence({ taskId: task.id, pointId: byName.GCP2.id, imageFileId: 'img1', pixelX: 300, pixelY: 400 });
  c.gcp.createCorrespondence({ taskId: task.id, pointId: byName.CHK1.id, imageFileId: 'img0', pixelX: 500, pixelY: 600 });
  const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = c.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: { 'use-exif': true, 'feature-quality': 'high' } });

  const list = c.processing.getAttemptGcpSnapshot(attempt.id);
  const lines = list.content.trimEnd().split('\n');
  assert.equal(lines[0], 'EPSG:4326');
  assert.equal(lines.length, 3, 'checkpoint CHK1 must not reach the solve');
  assert.ok(!list.content.includes('CHK1'));
  // Height contract: z is the Emlid Elevation (NAVD88) in metres, never the ellipsoidal height.
  // 820.000 ftUS = 249.936500 m; the ellipsoidal 706.600 ftUS (215.37 m) would sit ~34.6 m lower.
  const [x, y, z, px, py, image, label] = lines[1].split(' ');
  assert.deepEqual([x, y, px, py, image, label], ['-89.5', '44.5', '100', '200', 'DJI_0001.JPG', 'GCP1']);
  assert.ok(Math.abs(Number(z) - 820 * FT_US) < 1e-6, `z ${z} is NAVD88 metres`);
  assert.ok(Math.abs(Number(z) - 706.6 * FT_US) > 30);
  assert.equal(lines[2].split(' ')[6], 'GCP2');

  const checkpoints = c.processing.getAttemptGcpCheckpoints(attempt.id);
  assert.equal(checkpoints.content.verticalDatum, CS);
  assert.deepEqual(checkpoints.content.points.map((point) => point.externalId), ['CHK1']);
  const chk = checkpoints.content.points[0];
  assert.ok(Math.abs(chk.elevationM - 822.5 * FT_US) < 1e-6);
  assert.ok(Math.abs(chk.ellipsoidalHeightM - 709.1 * FT_US) < 1e-6);
  assert.deepEqual(chk.marks, [{ image: 'DJI_0001.JPG', pixelX: 500, pixelY: 600 }]);
  assert.throws(() => c.database.prepare('DELETE FROM processing_attempt_gcp_checkpoints WHERE attempt_id=?').run(attempt.id), /immutable/);

  // ODM ignores gcp_list.txt when use-exif is on, so a GCP attempt always turns it off.
  const stored = c.processing.getAttempt(attempt.id).options;
  assert.equal(stored['use-exif'], false);
  assert.equal(stored['feature-quality'], 'high');
});

test('an attempt with only checkpoint marks sends no gcp_list.txt but keeps the checkpoints', (t) => {
  const c = fixture(t), { project, dataset } = datasetWithPhotos(c, ['a.jpg']);
  const set = importEmlid(c, dataset.id), chk = set.points.find((point) => point.externalId === 'CHK1');
  const task = c.processing.createTask({ projectId: project.id, datasetId: dataset.id, displayName: 'Model' });
  c.gcp.createCorrespondence({ taskId: task.id, pointId: chk.id, imageFileId: 'img0', pixelX: 5, pixelY: 6 });
  const provider = c.processing.upsertProvider({ type: 'nodeodm', displayName: 'ODM', endpoint: 'http://127.0.0.1:3000', enabled: true });
  const attempt = c.processing.createAttempt({ taskId: task.id, providerId: provider.id, options: { 'use-exif': true } });
  assert.equal(c.processing.getAttemptGcpSnapshot(attempt.id), null);
  assert.equal(c.processing.getAttemptGcpCheckpoints(attempt.id).content.points.length, 1);
  assert.equal(c.processing.getAttempt(attempt.id).options['use-exif'], true);
});
