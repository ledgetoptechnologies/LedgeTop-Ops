import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import database from '../server/database.js';
import { projectViewerMark } from '../viewer-mark-position.mjs';

const modelId = 'synthetic-model';
const point = (changes = {}) => ({
  id: randomUUID(), geometry: { type: 'Point', coordinates: [-87, 43.05] }, name: 'Synthetic pin',
  color: '#88AA22', icon: 'pin', note: 'Test only', ...changes,
});

async function openApi(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE models(id TEXT PRIMARY KEY);
    INSERT INTO models VALUES ('synthetic-model'), ('other-model');`);
  db.exec(schema.VIEWER_MARKS_SQL);
  assert.equal(schema.verifyViewerMarksSchema(db), true);
  const sessions = new Map();
  const session = (audience, subject, changes = {}) => {
    const token = randomUUID().replaceAll('-', '');
    sessions.set(auth.hashToken(token), {
      audience, subject, modelId, modelVersionId: 'synthetic-v1',
      permissions: { view: true, measure: true, personalMeasurements: true }, ...changes,
    });
    return token;
  };
  const repository = {
    database: db,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: id => ({ status: 'ready', activeVersion: { id: id === modelId ? 'synthetic-v1' : 'other-v1', status: 'ready' } }),
    getModelVersion: (_id, version) => ({ status: 'ready', activeVersion: { id: version, status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/marks', api.createViewerMarkApi(repository));
  const server = createServer(app);
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });
  const request = async (token, method = 'GET', route = '', body) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/marks' + (route ? '/' + route : ''),
      { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, headers: response.headers };
  };
  return { session, request, sessions };
}

test('visibility: private stays with its owner, shared reaches the model, internal stays with staff', async t => {
  const { session, request } = await openApi(t);
  const staff = session('ops', 'staff-person');
  const client = session('client', 'client-a');
  const otherClient = session('client', 'client-b');
  const companyLogin = session('client', 'shared-company', { permissions: { view: true, measure: true } });
  const otherModel = session('client', 'client-a', { modelId: 'other-model', modelVersionId: 'other-v1' });

  const mine = point({ name: 'Private pin' });
  const created = await request(client, 'POST', '', mine);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.body.mark.visibility, 'private');
  assert.equal(created.body.mark.color, '#88aa22');
  assert.equal((await request(client, 'POST', '', mine)).status, 200, 'same create replays');
  const shared = (await request(client, 'POST', '', point({ name: 'Shared pin', visibility: 'shared' }))).body.mark;
  const internal = (await request(staff, 'POST', '', point({ name: 'Internal pin', visibility: 'internal' }))).body.mark;
  assert.equal((await request(client, 'POST', '', point({ visibility: 'internal' }))).status, 403);

  const names = async token => (await request(token)).body.marks.map(mark => mark.name).sort();
  assert.deepEqual(await names(client), ['Private pin', 'Shared pin']);
  assert.deepEqual(await names(otherClient), ['Shared pin']);
  assert.deepEqual(await names(companyLogin), ['Shared pin']);
  assert.deepEqual(await names(staff), ['Internal pin', 'Shared pin']);
  assert.deepEqual(await names(otherModel), []);
  assert.equal((await request(otherClient, 'GET', internal.id)).status, 404);
  assert.equal((await request(staff, 'GET', mine.id)).status, 404);

  const seenByOther = (await request(otherClient, 'GET', shared.id)).body.mark;
  assert.equal(seenByOther.mine, false);
  assert.equal(seenByOther.editable, false);
  assert.equal(seenByOther.author, 'client');
  assert.equal(seenByOther.owner, undefined, 'clients never see who else made a mark');
  assert.equal((await request(staff, 'GET', shared.id)).body.mark.owner, 'client-a');

  const read = await request(companyLogin);
  assert.deepEqual(read.body.capabilities, { write: false, staff: false });
  assert.equal((await request(companyLogin, 'POST', '', point())).status, 403);
});

test('clients edit their own marks; staff edit every mark they can read; only owners change visibility', async t => {
  const { session, request } = await openApi(t);
  const staff = session('ops', 'staff-person');
  const client = session('client', 'client-a');
  const otherClient = session('client', 'client-b');
  const shared = (await request(client, 'POST', '', point({ visibility: 'shared' }))).body.mark;
  const body = (mark, changes) => ({ id: mark.id, geometry: mark.geometry, name: mark.name, color: mark.color, icon: mark.icon,
    note: mark.note, categoryId: mark.categoryId, elevationNavd88M: mark.elevationNavd88M, revision: mark.revision, ...changes });

  assert.equal((await request(otherClient, 'PUT', shared.id, body(shared, { name: 'Hijack' }))).status, 403);
  assert.equal((await request(otherClient, 'DELETE', shared.id, { revision: 1 })).status, 403);
  const moved = await request(staff, 'PUT', shared.id, body(shared, { geometry: { type: 'Point', coordinates: [-87.001, 43.051] } }));
  assert.equal(moved.status, 200);
  assert.equal(moved.body.mark.revision, 2);
  assert.equal((await request(staff, 'PUT', shared.id, body(moved.body.mark, { visibility: 'private' }))).status, 403);
  assert.equal((await request(staff, 'PUT', shared.id, body(moved.body.mark, { visibility: 'internal' }))).status, 403);
  assert.equal((await request(client, 'PUT', shared.id, body(shared, { name: 'Stale' }))).status, 409);
  const renamed = await request(client, 'PUT', shared.id, body(moved.body.mark, { name: 'Renamed', elevationNavd88M: 251.25 }));
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.mark.elevationNavd88M, 251.25);
  assert.equal(renamed.body.mark.visibility, 'shared');

  const staffMark = (await request(staff, 'POST', '', point({ visibility: 'internal' }))).body.mark;
  const shared2 = await request(staff, 'PUT', staffMark.id, body(staffMark, { visibility: 'shared' }));
  assert.equal(shared2.body.mark.visibility, 'shared');
  assert.equal((await request(client, 'PUT', staffMark.id, body(shared2.body.mark, { name: 'No' }))).status, 403);

  assert.equal((await request(staff, 'DELETE', shared.id, { revision: 3 })).status, 204);
  assert.equal((await request(client, 'GET', shared.id)).status, 404);
  assert.equal((await request(client, 'POST', '', { ...point(), id: shared.id })).status, 409, 'deleted ids stay used');
});

test('lines, areas and typed values are validated', async t => {
  const { session, request } = await openApi(t);
  const client = session('client', 'client-a');
  const line = await request(client, 'POST', '', point({ geometry: { type: 'LineString', coordinates: [[-87, 43], [-87.001, 43.001, 250]] } }));
  assert.equal(line.status, 201);
  assert.deepEqual(line.body.mark.geometry.coordinates[1], [-87.001, 43.001], 'third GeoJSON value is not kept as a height');
  const area = await request(client, 'POST', '', point({ geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.001, 43], [-87.001, 43.001]]] } }));
  assert.equal(area.status, 201);
  assert.equal(area.body.mark.geometry.coordinates[0].length, 4, 'area rings are closed');
  for (const change of [
    { geometry: { type: 'Point', coordinates: [-181, 43] } }, { geometry: { type: 'Point', coordinates: [-87, 91] } },
    { geometry: { type: 'Point', coordinates: ['-87', 43] } }, { geometry: { type: 'LineString', coordinates: [[-87, 43]] } },
    { geometry: { type: 'Polygon', coordinates: [[[-87, 43], [-87.1, 43]]] } }, { geometry: { type: 'Circle', coordinates: [0, 0] } },
    { name: ' ' }, { name: 'a\u0007b' }, { color: 'orange' }, { note: 'a'.repeat(2001) }, { icon: '../x' },
    { elevationNavd88M: 'high' }, { elevationNavd88M: 99999 }, { visibility: 'everyone' }, { ownerSubject: 'spoofed' },
    { categoryId: randomUUID() },
  ]) {
    assert.equal((await request(client, 'POST', '', point(change))).status, 400, JSON.stringify(change));
  }
});

test('categories are per model, user-defined, and deleting one leaves marks intact', async t => {
  const { session, request } = await openApi(t);
  const staff = session('ops', 'staff-person');
  const client = session('client', 'client-a');
  const otherClient = session('client', 'client-b');
  const category = { id: randomUUID(), name: 'Survey point', color: '#3366ff', icon: 'flag' };
  assert.equal((await request(client, 'POST', 'categories', category)).status, 201);
  assert.equal((await request(otherClient, 'POST', 'categories', { ...category, id: randomUUID(), name: 'survey POINT' })).status, 409);
  const mark = (await request(client, 'POST', '', point({ categoryId: category.id, visibility: 'shared' }))).body.mark;
  assert.equal(mark.categoryId, category.id);

  const listed = (await request(otherClient)).body;
  assert.equal(listed.categories[0].name, 'Survey point');
  assert.equal(listed.categories[0].editable, false);
  assert.equal((await request(otherClient, 'PUT', 'categories/' + category.id, { ...category, name: 'Mine', revision: 1 })).status, 403);
  const renamed = await request(staff, 'PUT', 'categories/' + category.id, { ...category, name: 'Gate', revision: 1 });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.category.name, 'Gate');
  assert.equal((await request(client, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 409);
  assert.equal((await request(client, 'DELETE', 'categories/' + category.id, { revision: 2 })).status, 204);
  const after = (await request(client)).body;
  assert.deepEqual(after.categories, []);
  assert.equal(after.marks[0].categoryId, null);
  assert.equal(after.marks[0].color, '#88aa22');
  assert.equal((await request(client, 'POST', 'categories', { ...category, id: randomUUID() })).status, 201, 'a deleted name can be reused');
});

test('GeoJSON import lands as one batch or not at all', async t => {
  const { session, request } = await openApi(t);
  const client = session('client', 'client-a');
  const good = [point({ name: 'One' }), point({ name: 'Two', visibility: 'shared' })];
  const saved = await request(client, 'POST', 'batch', { marks: good });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.marks.length, 2);
  const failed = await request(client, 'POST', 'batch', { marks: [point({ name: 'Three' }), point({ color: 'bad' })] });
  assert.equal(failed.status, 400);
  assert.deepEqual((await request(client)).body.marks.map(mark => mark.name).sort(), ['One', 'Two']);
  assert.equal((await request(client, 'POST', 'batch', { marks: [] })).status, 400);
});

test('revoked, public and unverifiable sessions cannot read or write Marks', async t => {
  const { session, request, sessions } = await openApi(t);
  const revoked = session('client', 'client-a');
  sessions.get(auth.hashToken(revoked)).revoked = true;
  for (const token of [revoked, session('public', 'recipient'), session('client', 'no-measure', { permissions: { view: true } }),
    session('client', 'stale', { modelVersionId: 'synthetic-v2' })]) {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(token, 'POST', '', point())).status, 403);
  }
});

test('schema 84 migrates in the ledger and a stamped database without the tables is refused', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-marks-84-'));
  const filename = path.join(dir, 'viewer.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = database.openDatabase(filename);
  try {
    assert.equal(db.prepare('SELECT name FROM schema_migrations WHERE version=84').get().name, 'viewer_coordinate_marks');
    assert.equal(schema.verifyViewerMarksSchema(db), true);
    db.exec('DROP TABLE viewer_mark_categories');
  } finally { db.close(); }
  assert.throws(() => database.openDatabase(filename), { code: 'viewer_migration_history_conflict' });
});

test('WGS84 mark placement shares map position and verifies the projected horizontal frame', () => {
  const mark = { latitude: 43.05, longitude: -87 };
  const wgs = { epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' };
  const position = projectViewerMark(mark, wgs);
  assert.equal(position.utm.easting, 500000);
  assert.ok(position.utm.northing > 4_700_000);
  assert.deepEqual(projectViewerMark(mark, { ...wgs, epsg: 26916 }), { ...mark, utm: null });
});
