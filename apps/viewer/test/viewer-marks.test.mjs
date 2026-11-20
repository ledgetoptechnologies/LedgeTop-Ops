import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import { projectViewerMark } from '../viewer-mark-position.mjs';

const modelId = 'synthetic-model';
const modelVersionId = 'synthetic-v1';
const privateMark = () => ({
  id: randomUUID(), kind: 'treeStand', name: 'Synthetic stand', color: '#88AA22',
  note: 'Test only', latitude: 43.05, longitude: -87,
});

async function openApi(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE models(id TEXT PRIMARY KEY);
    CREATE TABLE model_versions(id TEXT PRIMARY KEY);
    INSERT INTO models VALUES ('synthetic-model');
    INSERT INTO model_versions VALUES ('synthetic-v1'), ('synthetic-v2');`);
  database.exec(schema.VIEWER_MARKS_SQL);
  const sessions = new Map();
  const session = (audience, subject, changes = {}) => {
    const token = randomUUID().replaceAll('-', '');
    sessions.set(auth.hashToken(token), {
      audience, subject, modelId, modelVersionId,
      permissions: { view: true, measure: true, personalMeasurements: true },
      ...changes,
    });
    return token;
  };
  const repository = {
    database,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: () => ({ status: 'ready', activeVersion: { id: modelVersionId, status: 'ready' } }),
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
    database.close();
  });
  const request = (token, method = 'GET', id = '', body) => fetch(
    'http://127.0.0.1:' + server.address().port + '/marks' + (id ? '/' + id : ''),
    { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }
  );
  return { session, request, sessions };
}

test('private Marks CRUD is scoped to live audience, individual and exact model version', async t => {
  const { session, request, sessions } = await openApi(t);
  const staff = session('ops', 'same-subject');
  const client = session('client', 'same-subject');
  const otherClient = session('client', 'another-client');
  const otherVersion = session('ops', 'same-subject', { sessionMode: 'review', modelVersionId: 'synthetic-v2' });
  const mark = privateMark();

  const created = await request(client, 'POST', '', mark);
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('cache-control'), 'no-store');
  const saved = (await created.json()).mark;
  assert.equal(saved.color, '#88aa22');
  assert.equal(saved.revision, 1);
  assert.equal((await request(client, 'POST', '', mark)).status, 200);
  const renewal = session('client', 'same-subject');
  assert.deepEqual((await (await request(renewal)).json()).marks, [saved]);

  for (const token of [staff, otherClient, otherVersion]) {
    assert.deepEqual((await (await request(token)).json()).marks, []);
    assert.equal((await request(token, 'GET', mark.id)).status, 404);
    assert.equal((await request(token, 'PUT', mark.id, { ...mark, revision: 1 })).status, 404);
    assert.equal((await request(token, 'DELETE', mark.id, { revision: 1 })).status, 404);
  }
  // A caller cannot use a chosen UUID to learn that a different owner used it.
  const staffMark = { ...privateMark(), id: mark.id };
  assert.equal((await request(staff, 'POST', '', staffMark)).status, 201);
  assert.deepEqual((await (await request(otherVersion)).json()).marks, []);
  assert.equal((await request(otherVersion, 'GET', staffMark.id)).status, 404);

  const updated = await request(client, 'PUT', mark.id, { ...mark, name: 'Updated synthetic stand', revision: 1 });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).mark.revision, 2);
  assert.equal((await request(client, 'DELETE', mark.id, { revision: 1 })).status, 409);
  assert.equal((await request(client, 'DELETE', mark.id, { revision: 2 })).status, 204);
  assert.equal((await request(client, 'GET', mark.id)).status, 404);
  assert.equal((await request(client, 'POST', '', mark)).status, 409);
  sessions.get(auth.hashToken(renewal)).revoked = true;
  assert.equal((await request(renewal)).status, 403);
});

test('public, unverifiable and stale sessions cannot persist Marks and typed points are validated', async t => {
  const { session, request } = await openApi(t);
  const eligible = session('client', 'verified-person');
  const mark = privateMark();
  for (const token of [
    session('public', 'recipient'),
    session('client', 'shared-company', { permissions: { view: true, measure: true } }),
    session('client', 'stale-person', { modelVersionId: 'synthetic-v2' }),
  ]) {
    assert.equal((await request(token)).status, 403);
    assert.equal((await request(token, 'POST', '', mark)).status, 403);
  }
  for (const change of [{ latitude: 91 }, { longitude: -181 }, { latitude: '43.05' }, { name: ' ' },
    { color: 'orange' }, { note: 'a'.repeat(1001) }, { ownerSubject: 'spoofed' }, { modelVersionId: 'synthetic-v2' }]) {
    assert.equal((await request(eligible, 'POST', '', { ...mark, ...change })).status, 400);
  }
});

test('WGS84 mark placement shares map position and verifies the projected horizontal frame', () => {
  const mark = { latitude: 43.05, longitude: -87 };
  const wgs = { epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' };
  const position = projectViewerMark(mark, wgs);
  assert.equal(position.latitude, mark.latitude);
  assert.equal(position.longitude, mark.longitude);
  assert.equal(position.utm.easting, 500000);
  assert.ok(position.utm.northing > 4_700_000);
  assert.deepEqual(projectViewerMark(mark, { ...wgs, epsg: 26916 }), { ...mark, utm: null });
  assert.deepEqual(projectViewerMark(mark, { ...wgs, hemisphere: 'S' }), { ...mark, utm: null });
  assert.deepEqual(projectViewerMark(mark, {}), { ...mark, utm: null });
  assert.equal(projectViewerMark({ ...mark, latitude: Infinity }, wgs), null);
});
