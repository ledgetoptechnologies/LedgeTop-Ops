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
const ACCOUNT_B = { sourceAuthorization: { type: 'direct_client_grant', id: 'grant-b', version: 3 } };
// Production mints one association id per project model for every client account on it.
const SHARED_ASSOCIATION = { sourceAuthorization: { type: 'model_association', id: 'project-model-association', version: 2 } };
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
  // Client sessions carry the portal account they were issued under.
  const session = (audience, subject, changes = {}) => {
    const token = randomUUID().replaceAll('-', '');
    sessions.set(auth.hashToken(token), {
      audience, subject, modelId, modelVersionId: 'synthetic-v1',
      permissions: { view: true, measure: true, personalMeasurements: true },
      sourceAuthorization: audience === 'client' ? { type: 'direct_client_grant', id: 'grant-a', version: 1 } : null,
      ...changes,
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

const names = request => async token => (await request(token)).body.marks.map(mark => mark.name).sort();

test('client privacy: two clients on one model never read each other\'s marks', async t => {
  const { session, request } = await openApi(t);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const colleagueA = session('client', 'client-a2');
  const clientB = session('client', 'client-b', ACCOUNT_B);
  const otherModel = session('client', 'client-a', { modelId: 'other-model', modelVersionId: 'other-v1' });

  const mine = point({ name: 'A private', visibility: 'private' });
  const created = await request(clientA, 'POST', '', mine);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.equal(created.body.mark.color, '#88aa22');
  assert.equal((await request(clientA, 'POST', '', mine)).status, 200, 'same create replays');
  const withStaff = (await request(clientA, 'POST', '', point({ name: 'A with staff' }))).body.mark;
  assert.equal(withStaff.visibility, 'staff', 'a client mark defaults to shared with project staff');
  const fromB = (await request(clientB, 'POST', '', point({ name: 'B with staff', visibility: 'staff' }))).body.mark;
  for (const visibility of ['internal', 'client', 'shared', 'everyone']) {
    assert.ok([400, 403].includes((await request(clientA, 'POST', '', point({ visibility }))).status), visibility);
  }

  assert.deepEqual(await list(clientA), ['A private', 'A with staff']);
  assert.deepEqual(await list(clientB), ['B with staff']);
  assert.deepEqual(await list(colleagueA), [], 'not even a colleague on the same account');
  assert.deepEqual(await list(staff), ['A with staff', 'B with staff']);
  assert.deepEqual(await list(otherModel), []);
  for (const [token, id] of [[clientB, withStaff.id], [clientB, mine.id], [clientA, fromB.id], [colleagueA, withStaff.id], [staff, mine.id]]) {
    assert.equal((await request(token, 'GET', id)).status, 404);
    assert.equal((await request(token, 'DELETE', id, { revision: 1 })).status, 404);
  }
  const seenByStaff = (await request(staff, 'GET', withStaff.id)).body.mark;
  assert.equal(seenByStaff.owner, 'client-a');
  assert.equal(seenByStaff.ownerAccount, 'direct_client_grant:grant-a');
  assert.equal((await request(clientA, 'GET', withStaff.id)).body.mark.ownerAccount, undefined);
});

test('staff share a mark with one named client account only', async t => {
  const { session, request } = await openApi(t);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const companyA = session('client', 'company-login-a', { permissions: { view: true, measure: true } });
  const clientB = session('client', 'client-b', ACCOUNT_B);
  const unaccounted = session('client', 'legacy-client', { sourceAuthorization: null });
  await request(clientA);
  await request(clientB);

  assert.equal((await request(clientA, 'GET', 'audiences')).status, 403);
  const audiences = (await request(staff, 'GET', 'audiences')).body.audiences.map(row => row.account).sort();
  assert.deepEqual(audiences, ['direct_client_grant:grant-a', 'direct_client_grant:grant-b']);

  const internal = (await request(staff, 'POST', '', point({ name: 'Staff only' }))).body.mark;
  assert.equal(internal.visibility, 'internal', 'staff marks default to staff only');
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'client' }))).status, 400, 'a share needs a named account');
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'client', shareAccount: 'direct_client_grant:never-seen' }))).status, 400);
  assert.equal((await request(staff, 'POST', '', point({ visibility: 'staff' }))).status, 403);
  const toA = (await request(staff, 'POST', '', point({ name: 'For A', visibility: 'client', shareAccount: 'direct_client_grant:grant-a' }))).body.mark;
  assert.equal(toA.shareAccount, 'direct_client_grant:grant-a');

  assert.deepEqual(await list(clientA), ['For A']);
  assert.deepEqual(await list(companyA), ['For A'], 'a company login reads within its account');
  assert.deepEqual(await list(clientB), []);
  assert.deepEqual(await list(unaccounted), []);
  assert.equal((await request(clientB, 'GET', toA.id)).status, 404);
  assert.equal((await request(clientB, 'GET', internal.id)).status, 404);
  const seenByA = (await request(clientA, 'GET', toA.id)).body.mark;
  assert.equal(seenByA.editable, false);
  assert.equal(seenByA.shareAccount, undefined, 'clients do not see share targets');
  assert.equal((await request(clientA, 'PUT', toA.id, { ...point(), id: toA.id, revision: 1 })).status, 403);
  assert.equal((await request(companyA, 'POST', '', point())).status, 403, 'company logins stay read-only');
  assert.deepEqual((await request(companyA)).body.capabilities, { write: false, staff: false });

  // Moving the share to B takes it away from A.
  const moved = await request(staff, 'PUT', toA.id, { ...point({ name: 'For B' }), id: toA.id, revision: 1, visibility: 'client',
    shareAccount: 'direct_client_grant:grant-b' });
  assert.equal(moved.status, 200);
  assert.deepEqual(await list(clientA), []);
  assert.deepEqual(await list(clientB), ['For B']);
});

test('two accounts on one model under the SAME association id never see each other\'s shares', async t => {
  const { session, request } = await openApi(t);
  const list = names(request);
  const staff = session('ops', 'staff-person');
  const accountOne = session('client', 'client:identity-one', SHARED_ASSOCIATION);
  const accountTwo = session('client', 'client:identity-two', SHARED_ASSOCIATION);
  const companyOne = session('client', 'client:company-one', { ...SHARED_ASSOCIATION, permissions: { view: true, measure: true } });

  const own = (await request(accountOne, 'POST', '', point({ name: 'One only me', visibility: 'private' }))).body.mark;
  const toStaff = (await request(accountOne, 'POST', '', point({ name: 'One with staff' }))).body.mark;
  const categoryOne = { id: randomUUID(), name: 'One category', color: '#3366ff', icon: 'flag' };
  assert.equal((await request(accountOne, 'POST', 'categories', categoryOne)).status, 201);
  await request(accountTwo);
  await request(companyOne);

  // No recipient key exists for association sessions: nothing to pick, nothing to share to.
  assert.deepEqual((await request(staff, 'GET', 'audiences')).body.audiences, []);
  for (const shareAccount of ['model_association:project-model-association', 'direct_client_grant:never-seen']) {
    assert.equal((await request(staff, 'POST', '', point({ visibility: 'client', shareAccount }))).status, 400, shareAccount);
  }
  const staffCategory = { id: randomUUID(), name: 'Staff category', color: '#43a047', icon: 'gate' };
  await request(staff, 'POST', 'categories', staffCategory);
  await request(staff, 'POST', '', point({ name: 'Internal', categoryId: staffCategory.id }));

  assert.deepEqual(await list(accountOne), ['One only me', 'One with staff']);
  assert.deepEqual(await list(accountTwo), []);
  assert.deepEqual(await list(companyOne), []);
  assert.deepEqual(await list(staff), ['Internal', 'One with staff']);
  for (const id of [own.id, toStaff.id]) assert.equal((await request(accountTwo, 'GET', id)).status, 404);
  assert.deepEqual((await request(accountTwo)).body.categories, []);
  assert.deepEqual((await request(accountOne)).body.categories.map(row => row.name), ['One category']);
  assert.equal((await request(accountTwo, 'PUT', 'categories/' + categoryOne.id, { ...categoryOne, revision: 1 })).status, 404);
  assert.equal((await request(staff, 'GET', toStaff.id)).body.mark.ownerAccount, null, 'no account key is recorded for associations');
});

test('clients edit their own marks; staff edit marks they can read; only owners change visibility', async t => {
  const { session, request } = await openApi(t);
  const staff = session('ops', 'staff-person');
  const otherStaff = session('ops', 'staff-two');
  const client = session('client', 'client-a');
  const shared = (await request(client, 'POST', '', point({ visibility: 'staff' }))).body.mark;
  const body = (mark, changes) => ({ id: mark.id, geometry: mark.geometry, name: mark.name, color: mark.color, icon: mark.icon,
    note: mark.note, categoryId: mark.categoryId, elevationNavd88M: mark.elevationNavd88M, revision: mark.revision, ...changes });

  const moved = await request(staff, 'PUT', shared.id, body(shared, { geometry: { type: 'Point', coordinates: [-87.001, 43.051] } }));
  assert.equal(moved.status, 200);
  assert.equal(moved.body.mark.revision, 2);
  assert.equal((await request(staff, 'PUT', shared.id, body(moved.body.mark, { visibility: 'private' }))).status, 403);
  assert.equal((await request(client, 'PUT', shared.id, body(shared, { name: 'Stale' }))).status, 409);
  const renamed = await request(client, 'PUT', shared.id, body(moved.body.mark, { name: 'Renamed', elevationNavd88M: 251.25 }));
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.mark.elevationNavd88M, 251.25);
  assert.equal(renamed.body.mark.visibility, 'staff');
  const hidden = await request(client, 'PUT', shared.id, body(renamed.body.mark, { visibility: 'private' }));
  assert.equal(hidden.body.mark.visibility, 'private');
  assert.equal((await request(staff, 'GET', shared.id)).status, 404, 'a client can take a mark back');

  const staffMark = (await request(staff, 'POST', '', point())).body.mark;
  assert.equal((await request(otherStaff, 'PUT', staffMark.id, body(staffMark, { name: 'Team edit' }))).status, 200);
  assert.equal((await request(client, 'GET', staffMark.id)).status, 404);
  assert.equal((await request(otherStaff, 'DELETE', staffMark.id, { revision: 2 })).status, 204);
  assert.equal((await request(staff, 'GET', staffMark.id)).status, 404);
  assert.equal((await request(staff, 'POST', '', { ...point(), id: staffMark.id })).status, 409, 'deleted ids stay used');
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
    { elevationNavd88M: 'high' }, { elevationNavd88M: 99999 }, { visibility: 'everyone' }, { shareAccount: 'not an account' },
    { ownerSubject: 'spoofed' }, { categoryId: randomUUID() },
  ]) {
    assert.equal((await request(client, 'POST', '', point(change))).status, 400, JSON.stringify(change));
  }
});

test('categories stay with their owner; clients see staff categories only on marks shared with them', async t => {
  const { session, request } = await openApi(t);
  const staff = session('ops', 'staff-person');
  const clientA = session('client', 'client-a');
  const clientB = session('client', 'client-b', ACCOUNT_B);
  await request(clientA);
  const category = { id: randomUUID(), name: 'Survey point', color: '#3366ff', icon: 'flag' };
  assert.equal((await request(clientA, 'POST', 'categories', category)).status, 201);
  assert.equal((await request(clientA, 'POST', 'categories', { ...category, id: randomUUID(), name: 'survey POINT' })).status, 409);
  const categoryB = { ...category, id: randomUUID() };
  assert.equal((await request(clientB, 'POST', 'categories', categoryB)).status, 201, 'names are per owner, so nothing leaks');
  const mark = (await request(clientA, 'POST', '', point({ categoryId: category.id }))).body.mark;
  assert.equal(mark.categoryId, category.id);
  assert.equal((await request(clientB, 'POST', '', point({ categoryId: category.id }))).status, 400, 'no using another client\'s category');

  const categoryIds = async token => (await request(token)).body.categories.map(row => row.id).sort();
  assert.deepEqual(await categoryIds(clientB), [categoryB.id], 'only B\'s own category');
  assert.equal((await request(clientB, 'PUT', 'categories/' + category.id, { ...category, name: 'Mine', revision: 1 })).status, 404);
  assert.equal((await request(clientB, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 404);

  const staffCategory = { id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate' };
  const unusedStaff = { id: randomUUID(), name: 'Internal review', color: '#e53935', icon: 'warning' };
  await request(staff, 'POST', 'categories', staffCategory);
  await request(staff, 'POST', 'categories', unusedStaff);
  assert.equal((await request(staff, 'POST', '', point({ categoryId: category.id }))).status, 400, 'staff use staff categories');
  assert.deepEqual(await categoryIds(clientA), [category.id]);
  await request(staff, 'POST', '', point({ categoryId: staffCategory.id, visibility: 'client', shareAccount: 'direct_client_grant:grant-a' }));
  assert.deepEqual(await categoryIds(clientA), [category.id, staffCategory.id].sort(), 'a shared mark brings its category name');
  assert.deepEqual(await categoryIds(clientB), [categoryB.id]);
  assert.equal((await request(clientA)).body.categories.find(row => row.id === staffCategory.id).editable, false);
  assert.equal((await request(staff)).body.categories.length, 4);

  const renamed = await request(staff, 'PUT', 'categories/' + category.id, { ...category, name: 'Gate post', revision: 1 });
  assert.equal(renamed.status, 200);
  assert.equal((await request(clientA, 'DELETE', 'categories/' + category.id, { revision: 1 })).status, 409);
  assert.equal((await request(clientA, 'DELETE', 'categories/' + category.id, { revision: 2 })).status, 204);
  const after = (await request(clientA)).body;
  assert.equal(after.marks.find(row => row.id === mark.id).categoryId, null);
  assert.equal(after.marks.find(row => row.id === mark.id).color, '#88aa22');
  assert.equal((await request(clientA, 'POST', 'categories', { ...category, id: randomUUID() })).status, 201, 'a deleted name can be reused');
});

test('GeoJSON import lands as one batch or not at all', async t => {
  const { session, request } = await openApi(t);
  const client = session('client', 'client-a');
  const good = [point({ name: 'One' }), point({ name: 'Two', visibility: 'private' })];
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
    session('client', 'stale', { modelVersionId: 'synthetic-v2' }), 'not-a-real-token-value']) {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(token, 'POST', '', point())).status, 403);
    assert.equal((await request(token, 'GET', 'audiences')).status, 403);
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
    db.exec('DROP TABLE viewer_mark_accounts');
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
