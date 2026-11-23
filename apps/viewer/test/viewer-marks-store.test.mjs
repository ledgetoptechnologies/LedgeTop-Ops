import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import { createMarksStore } from '../viewer-marks-store.mjs';

// The store runs against the real Marks API so permission and revision rules
// are exercised end to end, without a browser.
async function openServer(t) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model');`);
  database.exec(schema.VIEWER_MARKS_SQL);
  const sessions = new Map();
  const repository = {
    database,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: record => !record.revoked,
    getModel: () => ({ status: 'ready', activeVersion: { id: 'synthetic-v1', status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marks', api.createViewerMarkApi(repository));
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); database.close(); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const request = (path, init) => fetch(base + path, { ...init, redirect: 'follow' });
  const scope = (audience, subject, permissions = { view: true, measure: true, personalMeasurements: true }) => {
    const token = randomUUID().replaceAll('-', '');
    const record = { audience, subject, modelId: 'synthetic-model', modelVersionId: 'synthetic-v1', permissions,
      sourceAuthorization: audience === 'client' ? { type: 'direct_client_grant', id: 'grant-a', version: 1 } : null };
    sessions.set(auth.hashToken(token), record);
    return { mode: 'session', key: audience + subject, token: () => token, record };
  };
  return { request, scope };
}

const pin = (name, changes = {}) => ({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#ee5007', icon: 'pin', note: '', ...changes });

test('a client shares with staff, staff share back to the client account, and each undoes their own change', async t => {
  const { request, scope } = await openServer(t);
  const client = createMarksStore({ request });
  const staff = createMarksStore({ request });
  await client.setScope(scope('client', 'client-a'));
  await staff.setScope(scope('ops', 'staff-person'));
  assert.equal(client.canWrite(), true);
  assert.equal(staff.state.capabilities.staff, true);

  const privateByDefault = await client.create(pin('Mine only'));
  assert.equal(privateByDefault.visibility, 'private', 'client marks default to Only me');
  const created = await client.create(pin('Shared stand', { visibility: 'staff' }));
  assert.equal(created.mine, true);
  assert.equal(created.visibility, 'staff');
  const moved = await client.update(created, { geometry: { type: 'Point', coordinates: [-87.0001, 43.0001] } });
  assert.equal(moved.revision, 2);
  assert.deepEqual(client.state.undo.map(entry => entry.type), ['create', 'create', 'update']);
  assert.equal(await client.undo(), true);
  assert.deepEqual(client.find(created.id).geometry.coordinates, [-87, 43], 'undo restores the old position');

  await staff.refresh();
  const seen = staff.find(created.id);
  assert.equal(seen.editable, true);
  await staff.update(seen, { name: 'Checked by staff' });
  // The client still holds an older revision: the save fails, explains and reloads.
  assert.equal(await client.update(client.find(created.id), { name: 'Late edit' }), null);
  assert.match(client.state.message, /Someone else changed/);
  assert.equal(client.find(created.id).name, 'Checked by staff');

  const internal = await staff.create(pin('Staff note'));
  assert.equal(internal.visibility, 'internal');
  await client.refresh();
  assert.equal(client.find(internal.id), null);
  await staff.refresh();
  assert.deepEqual(staff.state.audiences.map(row => row.account), ['direct_client_grant:grant-a']);
  const forClient = await staff.create(pin('For the client', { visibility: 'client', shareAccount: staff.state.audiences[0].account }));
  await client.refresh();
  assert.equal(client.find(forClient.id).editable, false);
  assert.equal(client.find(forClient.id).shareAccount, undefined);
  assert.equal(await staff.remove(staff.find(internal.id)), true);
  assert.equal(await staff.undo(), true, 'undo delete brings back a copy');
  assert.equal(staff.state.marks.filter(mark => mark.name === 'Staff note').length, 1);
  assert.notEqual(staff.state.marks.find(mark => mark.name === 'Staff note').id, internal.id);
});

test('categories and GeoJSON import go through the API; company logins only read', async t => {
  const { request, scope } = await openServer(t);
  const client = createMarksStore({ request });
  await client.setScope(scope('client', 'client-a'));
  const category = await client.saveCategory({ name: 'Survey point', color: '#1e88e5', icon: 'target' });
  assert.equal(category.name, 'Survey point');
  assert.equal(await client.saveCategory({ name: 'survey point', color: '#1e88e5', icon: 'target' }), null);
  assert.match(client.state.message, /already exists/);
  const newCategory = { id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate' };
  const count = await client.importMarks({ categories: [newCategory], marks: [
    { ...pin('One'), id: randomUUID(), categoryId: newCategory.id }, { ...pin('Two'), id: randomUUID(), categoryId: category.id },
  ] });
  assert.equal(count, 2);
  assert.deepEqual(client.state.categories.map(row => row.name).sort(), ['Gate', 'Survey point']);
  assert.equal(await client.deleteCategory(client.state.categories.find(row => row.name === 'Gate')), true);
  assert.equal(client.state.marks.find(mark => mark.name === 'One').categoryId, null);
  assert.equal(await client.undo(), true, 'undo removes the whole import');
  assert.equal(client.state.marks.length, 0);

  await client.create(pin('Only for staff', { visibility: 'staff' }));
  const staff = createMarksStore({ request });
  await staff.setScope(scope('ops', 'staff-person'));
  await staff.create(pin('Visible', { visibility: 'client', shareAccount: 'direct_client_grant:grant-a' }));
  const company = createMarksStore({ request });
  await company.setScope(scope('client', 'company-login', { view: true, measure: true }));
  assert.equal(company.canWrite(), false);
  assert.deepEqual(company.state.marks.map(mark => mark.name), ['Visible']);
});

test('temporary marks on public links never touch the network and guard scope changes', async () => {
  const store = createMarksStore({ request: () => assert.fail('temporary marks must not reach an API'), newId: () => randomUUID() });
  await store.setScope({ mode: 'temporary', key: 'public A' });
  const created = await store.create(pin('Typed pin'));
  assert.equal(created.visibility, 'private');
  await store.update(created, { name: 'Renamed' });
  await store.saveCategory({ name: 'Feeder', color: '#ffffff', icon: 'feed' });
  assert.equal(store.hasTemporaryMarks(), true);
  assert.equal(await store.setScope({ mode: 'temporary', key: 'public B' }), false, 'unsaved temporary marks block a silent switch');
  assert.equal(store.state.blocked, true);
  assert.equal(await store.setScope({ mode: 'temporary', key: 'public A' }), true);
  assert.equal(store.state.blocked, false);
  store.discardTemporaryMarks();
  assert.equal(store.hasTemporaryMarks(), false);
  assert.equal(await store.setScope({ mode: 'temporary', key: 'public B' }), true);
});

test('losing access hides marks', async () => {
  const store = createMarksStore({ request: async () => new Response(JSON.stringify({ code: 'marks_unavailable' }), { status: 403 }) });
  await store.setScope({ mode: 'session', key: 'k', token: () => 'token' });
  assert.equal(store.state.ready, false);
  assert.match(store.state.message, /unavailable/);
});
