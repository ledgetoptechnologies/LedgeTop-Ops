'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('express');
const { openDatabase } = require('../server/database');
const { ViewerRepository } = require('../server/repository');
const { ProcessingRepository } = require('../server/processingRepository');
const { MeasurementRepository, validateMeasurement } = require('../server/measurementRepository');
const { createMeasurementApi, measurementAdmin } = require('../server/measurementApi');
const auth = require('../server/auth');

function document(overrides = {}) {
  return { id: crypto.randomUUID(), name: 'North side', collection: 'spatial3d', kind: 'polygon', vertices: [[400001.123456789,4500000,200],[400010,4500000,201],[400010,4500010,202]], coordinateReference: { crs: 'EPSG:32616', verticalUnit: 'm' }, visible: true, source: { kind: 'dsm' }, ...overrides };
}
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-measurements-'));
  const database = openDatabase(path.join(directory, 'viewer.sqlite'));
  const repository = new ViewerRepository(database), measurements = new MeasurementRepository(database), processing = new ProcessingRepository(database);
  const input = { provider: 'webodm', providerModelId: 'project', providerVersionId: 'version-1', displayName: 'Test', sourceLocator: {}, status: 'ready', assets: [] };
  const model = repository.upsertModelVersion(input);
  const principal = { modelId: model.id, modelVersionId: model.activeVersion.id, audience: 'client', subject: 'person-1' };
  function token(overrides = {}) {
    const value = crypto.randomBytes(32).toString('base64url');
    repository.createViewerSession({ tokenHash: auth.hashToken(value), ...principal, permissions: { view: true, measure: true, personalMeasurements: true }, expiresAt: new Date(Date.now() + 3600_000).toISOString(), ...overrides });
    return value;
  }
  const app = express(); app.use(express.json({ limit: '300kb' })); app.use('/api/v1/measurements', createMeasurementApi(repository));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  async function request(bearer, suffix = '', method = 'GET', body, headers = {}) {
    return fetch(`http://127.0.0.1:${server.address().port}/api/v1/measurements${suffix}`, { method, headers: { ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}), 'Content-Type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve)); database.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { database, repository, processing, measurements, principal, token, request, input };
}

test('private measurement CRUD persists precision, scopes persons and audience, and uses revisions', async (t) => {
  const f = await fixture(t), bearer = f.token(), doc = document();
  let response = await f.request(bearer, '', 'POST', doc);
  assert.equal(response.status, 201);
  const saved = (await response.json()).measurement;
  assert.equal(saved.vertices[0][0], doc.vertices[0][0]); assert.equal(saved.revision, 1);
  assert.equal((await f.request(bearer, '', 'POST', { ...doc, coordinateReference: { verticalUnit: 'm', crs: 'EPSG:32616' } })).status, 200);
  assert.equal((await f.request(bearer, '', 'POST', { ...doc, name: 'changed replay' })).status, 409);
  for (const other of [f.token({ subject: 'person-2' }), f.token({ audience: 'ops' })]) {
    assert.equal((await (await f.request(other)).json()).measurements.length, 0);
    assert.equal((await f.request(other, `/${doc.id}`)).status, 404);
    assert.equal((await f.request(other, `/${doc.id}`, 'PUT', { ...doc, revision: 1 })).status, 404);
    assert.equal((await f.request(other, `/${doc.id}`, 'DELETE', { revision: 1 })).status, 404);
  }
  response = await f.request(bearer, `/${doc.id}`, 'PUT', { ...doc, name: 'Panel A', revision: 1 });
  assert.equal(response.status, 200); assert.equal((await response.json()).measurement.revision, 2);
  assert.equal((await f.request(bearer, `/${doc.id}`, 'PUT', { ...doc, revision: 1 })).status, 409);
  assert.equal((await f.request(bearer, `/${doc.id}`, 'PUT', { ...doc, collection: 'map', revision: 2 })).status, 409);
  const renewed = f.token(); assert.equal((await (await f.request(renewed)).json()).measurements[0].name, 'Panel A');
  assert.equal((await f.request(bearer, `/${doc.id}`, 'DELETE', { revision: 1 })).status, 409);
  assert.equal((await f.request(bearer, `/${doc.id}`, 'DELETE', { revision: 2 })).status, 204);
  assert.equal((await f.request(bearer, `/${doc.id}`, 'DELETE', { revision: 2 })).status, 204);
  assert.equal((await f.request(bearer, '', 'POST', doc)).status, 409);
  assert.equal((await (await f.request(bearer)).json()).measurements.length, 0);
});

test('public, cookie-only, expired, revoked, and non-measure sessions cannot access persistence', async (t) => {
  const f = await fixture(t), live = f.token();
  // Public shares have their own capability table, not a personal viewer session.
  for (const bearer of [null, crypto.randomBytes(32).toString('base64url'), f.token({ expiresAt: new Date(0).toISOString() }), f.token({ permissions: { view: true, measure: false } }), f.token({ permissions: { view: false, measure: true } })]) {
    assert.equal((await f.request(bearer)).status, 403);
    assert.equal((await f.request(bearer, '', 'POST', document())).status, 403);
  }
  assert.equal((await f.request(null, '', 'GET', undefined, { Cookie: `ltds_viewer=${live}` })).status, 403);
  f.database.prepare('UPDATE viewer_sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(), auth.hashToken(live));
  assert.equal((await f.request(live)).status, 403);
});

test('version changes deny stale grants without transferring stored records', async (t) => {
  const f = await fixture(t), bearer = f.token(), doc = document();
  assert.equal((await f.request(bearer, '', 'POST', doc)).status, 201);
  const next = f.repository.upsertModelVersion({ ...f.input, providerVersionId: 'version-2' });
  assert.equal((await f.request(bearer)).status, 403);
  const current = f.token({ modelVersionId: next.activeVersion.id });
  assert.equal((await (await f.request(current)).json()).measurements.length, 0);
  assert.equal(f.measurements.get(f.principal, doc.id).id, doc.id);
});

test('validation rejects forged identity, oversized or nonfinite coordinates and marks browser results unverified', () => {
  for (const doc of [document({ subject: 'admin' }), document({ modelVersionId: 'forged' }), document({ vertices: [[1,2,3],[4,5,6],[NaN,2,3]] }), document({ coordinateReference: { crs: 'EPSG:32616', verticalUnit: 'ft' } }), document({ name: 'x'.repeat(201) }), document({ vertices: Array.from({ length: 2001 }, () => [1,2,3]) })]) assert.throws(() => validateMeasurement(doc), /invalid_measurement/);
  const result = validateMeasurement(document({ results: { volumeM3: 1.23456789, calculationOrigin: 'server', verified: true } }));
  assert.equal(result.results.volumeM3, 1.23456789); assert.equal(result.results.calculationOrigin, 'browser'); assert.equal(result.results.verified, false);
});

test('advanced-job authority needs a matching live workspace write permission, never ordinary signed-in access', async (t) => {
  const f = await fixture(t), principal = { ...f.principal, audience: 'ops' }, adminToken = crypto.randomBytes(32).toString('base64url');
  const req = { get: (header) => header === 'X-Viewer-Admin-Authorization' ? `Bearer ${adminToken}` : undefined };
  assert.equal(measurementAdmin(req, principal, f.database), null);
  f.processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: principal.subject, permissions: ['viewer.processing.read'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  assert.equal(measurementAdmin(req, principal, f.database), null);
  f.database.prepare('UPDATE admin_sessions SET permissions_json=? WHERE token_hash=?').run(JSON.stringify(['viewer.processing.write']), auth.hashToken(adminToken));
  assert.ok(measurementAdmin(req, principal, f.database));
  assert.equal(measurementAdmin(req, { ...principal, subject: 'other' }, f.database), null);
  assert.equal(measurementAdmin(req, { ...principal, audience: 'client' }, f.database), null);
  f.database.prepare('UPDATE admin_sessions SET revoked_at=? WHERE token_hash=?').run(new Date().toISOString(), auth.hashToken(adminToken));
  assert.equal(measurementAdmin(req, principal, f.database), null);
});

test('edits cancel obsolete jobs and delete clears saved result geometry', async (t) => {
  const f = await fixture(t), doc = document(), now = new Date().toISOString();
  f.measurements.create(f.principal, doc);
  f.database.prepare("INSERT INTO measurement_calculation_jobs(id,measurement_id,revision,request_json,status,created_at,updated_at) VALUES(?,?,1,'{}','running',?,?)").run('job',doc.id,now,now);
  f.measurements.update(f.principal, doc.id, { ...doc, revision: 1, name: 'New' });
  assert.equal(f.database.prepare('SELECT status FROM measurement_calculation_jobs WHERE id=?').get('job').status, 'cancelled');
  f.measurements.delete(f.principal, doc.id, 2);
  assert.equal(f.database.prepare('SELECT document_json FROM private_measurements WHERE id=?').get(doc.id).document_json, '{}');
});

test('a client cannot use a staff-token header to launch, inspect or cancel calculation jobs', async (t) => {
  const f = await fixture(t), doc = document(), bearer = f.token();
  await f.request(bearer, '', 'POST', doc);
  const adminToken = crypto.randomBytes(32).toString('base64url');
  f.processing.createAdminSession({ tokenHash: auth.hashToken(adminToken), subject: f.principal.subject, permissions: ['viewer.processing.write'], expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const headers = { 'X-Viewer-Admin-Authorization': `Bearer ${adminToken}` };
  assert.equal((await f.request(bearer, `/${doc.id}/calculations`, 'POST', { revision: 1, method: 'surface-cut-fill' }, headers)).status, 403);
  assert.equal((await f.request(bearer, `/${doc.id}/calculations/guessed`, 'GET', undefined, headers)).status, 403);
  assert.equal((await f.request(bearer, `/${doc.id}/calculations/guessed`, 'DELETE', {}, headers)).status, 403);
  assert.equal(f.database.prepare('SELECT count(*) n FROM measurement_calculation_jobs').get().n, 0);
});

test('legacy client identities receive temporary-only capabilities until service attests an individual', async (t) => {
  const f = await fixture(t), bearer = f.token({ permissions: { view: true, measure: true } }), doc = document();
  const response = await f.request(bearer);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).capabilities, { personalPersistence: false, serverCalculations: false });
  assert.equal((await f.request(bearer, '', 'POST', { ...doc, personalMeasurements: true })).status, 403);
  assert.equal((await f.request(bearer, `/${doc.id}`)).status, 403);
  const staff = f.token({ audience: 'ops', permissions: { view: true, measure: true } });
  assert.equal((await (await f.request(staff)).json()).capabilities.personalPersistence, true);
});
