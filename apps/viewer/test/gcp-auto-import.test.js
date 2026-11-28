'use strict';

// Finding the Emlid file among a dataset's uploaded files and importing it without a re-upload.
// Synthetic files only.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { openDatabase } = require('../server/database');
const { ProcessingRepository } = require('../server/processingRepository');
const { mountGcpRoutes } = require('../server/gcpApi');

const CS = 'NAD83(2011) / Synthetic Zone (ftUS) + NAVD88 height (ftUS)';
const EMLID = [
  'Name,Code,Easting,Northing,Elevation,Description,Longitude,Latitude,Ellipsoidal height,CS name',
  `GCP1,GCP,1000,2000,820,nail,-89.5,44.5,706.6,${CS}`,
  `GCP2,,1100,2000,821,nail,-89.4996,44.5,707.6,${CS}`,
  `CHK1,CP,1050,2050,822.5,nail,-89.4998,44.50015,709.1,${CS}`,
].join('\r\n') + '\r\n';
const NO_UNITS = EMLID.split(CS).join('Local grid');
const NOT_GCP = 'flight,battery\n1,98\n';

async function fixture(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ltds-gcp-auto-')), database = openDatabase(path.join(root, 'viewer.sqlite'));
  const processing = new ProcessingRepository(database), project = processing.createProject({ displayName: 'Survey' }), relativePath = crypto.randomUUID();
  const dataset = processing.createDataset({ projectId: project.id, displayName: 'Flight', storageMode: 'managed', rootKey: 'datasets', relativePath });
  const manifest = [];
  for (const [id, name, content, contentType] of files) {
    const bytes = Buffer.from(content), file = path.join(root, 'datasets', relativePath, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes);
    manifest.push({ id, relativePath: name, byteSize: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), contentType });
  }
  processing.finalizeDataset(dataset.id, manifest, 'a'.repeat(64));
  const app = express(); app.use(express.json({ limit: '3mb' })); const router = express.Router();
  const respond = (res, status, code, message = code) => res.status(status).json({ code, error: message });
  const authorize = () => (req, res, next) => { if (req.get('authorization') !== 'Bearer admin') return respond(res, 401, 'unauthorized'); req.actorId = 'ops:1'; next(); };
  const mutate = (req, res, next) => req.get('idempotency-key') ? next() : respond(res, 400, 'idempotency_key_required');
  mountGcpRoutes(router, { repository: { audit() {} }, processing,
    storage: { resolve(_rootKey, relative) { return path.join(root, 'datasets', ...relative.split('/')); } }, authorize, mutate, error: respond });
  app.use(router);
  const server = await new Promise((resolve) => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); database.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`, auth = { authorization: 'Bearer admin' };
  const post = (fileId, key = crypto.randomUUID()) => fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sets/import-source`,
    { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify({ fileId }) });
  const sources = async () => (await (await fetch(`${base}/api/v1/datasets/${dataset.id}/gcp-sources`, { headers: auth })).json()).sources;
  return { base, dataset, root, relativePath, auth, post, sources };
}

test('the Emlid file uploaded with the photos is found, described and ready to import', async (t) => {
  const c = await fixture(t, [['photo', 'DJI_0001.JPG', 'jpeg', 'image/jpeg'], ['emlid', 'survey/points.csv', EMLID, 'text/csv'], ['other', 'flight.csv', NOT_GCP, 'text/csv']]);
  assert.equal((await fetch(`${c.base}/api/v1/datasets/${c.dataset.id}/gcp-sources`)).status, 401);
  const sources = await c.sources();
  assert.deepEqual(sources.map((source) => source.fileId).sort(), ['emlid', 'other']);
  const emlid = sources.find((source) => source.fileId === 'emlid'), other = sources.find((source) => source.fileId === 'other');
  assert.equal(emlid.name, 'survey/points.csv');
  assert.equal(emlid.format, 'emlid-all-columns-v1');
  assert.equal(emlid.pointCount, 3);
  assert.equal(emlid.checkpointCount, 1);
  assert.equal(emlid.linearUnit, 'ftUS');
  assert.equal(emlid.importable, true);
  assert.equal(emlid.importedSetId, null);
  assert.equal(other.format, null);
  assert.equal(other.importable, false);
});

test('importing the found file creates one set from the stored bytes, once', async (t) => {
  const c = await fixture(t, [['emlid', 'points.csv', EMLID, 'text/csv']]);
  const first = await c.post('emlid');
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.set.sourceFileId, 'emlid');
  assert.equal(created.set.displayName, 'points.csv');
  assert.deepEqual(created.points.map((point) => [point.externalId, point.role]).sort(), [['CHK1', 'checkpoint'], ['GCP1', 'control'], ['GCP2', 'control']]);
  assert.ok(Math.abs(created.points.find((point) => point.externalId === 'GCP1').elevationM - 820 * 1200 / 3937) < 1e-9);
  const again = await c.post('emlid');
  assert.equal(again.status, 200);
  assert.equal((await again.json()).set.id, created.set.id);
  assert.equal((await c.sources())[0].importedSetId, created.set.id);
});

test('a file changed after upload, one without units, or an unknown file is refused', async (t) => {
  const c = await fixture(t, [['emlid', 'points.csv', EMLID, 'text/csv'], ['local', 'local.csv', NO_UNITS, 'text/csv']]);
  const local = (await c.sources()).find((source) => source.fileId === 'local');
  assert.equal(local.format, 'emlid-all-columns-v1');
  assert.equal(local.importable, false);
  assert.match(local.error, /units/i);
  assert.equal((await c.post('local')).status, 400);
  fs.writeFileSync(path.join(c.root, 'datasets', c.relativePath, 'points.csv'), EMLID.replace('820', '830'));
  const changed = await c.post('emlid');
  assert.equal(changed.status, 409);
  assert.equal((await changed.json()).code, 'gcp_source_changed');
  assert.equal((await c.post('missing')).status, 404);
});
