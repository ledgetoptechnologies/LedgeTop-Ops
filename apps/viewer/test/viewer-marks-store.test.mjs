import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import marksRepository from '../server/viewerMarkRepository.js';
import { createMarksStore } from '../viewer-marks-store.mjs';

// The store runs against the real Marks API so permission and revision rules
// are exercised end to end, without a browser.
const SHARING = { visibility: marksRepository.HELD_SHARING };
async function openServer(t, options) {
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model');`);
  database.exec(schema.VIEWER_MARKS_SQL + schema.VIEWER_MARK_SHARING_SQL);
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
  app.use('/api/v1/marks', api.createViewerMarkApi(repository, options));
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

test('as served: a client shares with staff view-only, nobody asks for audiences, and undo restores', async t => {
  const { request, scope } = await openServer(t);
  const paths = [];
  const recorded = (path, init) => { paths.push(path); return request(path, init); };
  const client = createMarksStore({ request: recorded }), staff = createMarksStore({ request: recorded });
  await client.setScope(scope('client', 'client-a'));
  await staff.setScope(scope('ops', 'staff-person'));
  const { maxRequestBytes } = client.state.capabilities;
  assert.deepEqual(client.state.capabilities, { write: true, staff: false, visibility: ['private', 'staff'], recoveryDays: 30, shared: false, maxRequestBytes });
  assert.deepEqual(staff.state.capabilities, { write: true, staff: true, visibility: ['private'], recoveryDays: 30, shared: true, maxRequestBytes });
  assert.equal((await client.create(pin('Mine'))).visibility, 'private');
  const shared = await client.create(pin('Shared', { visibility: 'staff' }));
  assert.equal((await staff.create(pin('Staff pin'))).visibility, 'private');
  assert.equal(await staff.create(pin('For a client', { visibility: 'client', shareAccount: 'direct_client_grant:grant-a' })), null);
  assert.match(staff.state.message, /not available/);
  await staff.refresh();
  assert.deepEqual(staff.state.marks.map(mark => mark.name).sort(), ['Shared', 'Staff pin']);
  const seen = staff.find(shared.id);
  assert.equal(staff.editable(seen), false);
  assert.equal(await staff.update(seen, { name: 'Changed' }), null);
  assert.match(staff.state.message, /only change your own/);
  assert.equal(await staff.remove(seen), false);

  await client.update(client.find(shared.id), { name: 'Moved', geometry: { type: 'Point', coordinates: [-87.0001, 43.0001] } });
  assert.equal(await client.undo(), true);
  assert.deepEqual([client.find(shared.id).name, client.find(shared.id).geometry.coordinates], ['Shared', [-87, 43]]);
  // Undoing a delete restores the same mark, with its id and sharing.
  assert.equal(await client.remove(client.find(shared.id)), true);
  await staff.refresh();
  assert.equal(staff.find(shared.id), null);
  assert.equal(await client.loadDeleted(), true);
  assert.deepEqual(client.state.deleted.map(mark => mark.id), [shared.id]);
  assert.equal(await client.undo(), true);
  assert.deepEqual([client.find(shared.id).name, client.find(shared.id).visibility, client.state.deleted.length], ['Shared', 'staff', 0]);
  // So does Restore, after undo has been used up; undoing that deletes it again.
  await client.remove(client.find(shared.id));
  client.state.undo = [];
  await client.loadDeleted();
  assert.equal(await client.restore({ id: randomUUID(), revision: 1 }), null, 'only what the list shows');
  assert.equal((await client.restore(client.state.deleted[0])).id, shared.id);
  assert.deepEqual(client.state.deleted, []);
  assert.equal(await client.undo(), true);
  assert.equal(client.find(shared.id), null);
  assert.ok(!paths.some(path => path.endsWith('/audiences')));
});

test('a change made in two tabs of one person is explained and reloaded', async t => {
  const { request, scope } = await openServer(t);
  const person = scope('client', 'client-a');
  const one = createMarksStore({ request }), two = createMarksStore({ request });
  await one.setScope(person);
  const mark = await one.create(pin('Original'));
  await two.setScope(person);
  await two.update(two.find(mark.id), { name: 'Second tab' });
  assert.equal(await one.update(one.find(mark.id), { name: 'Late edit' }), null);
  assert.match(one.state.message, /Someone else changed/);
  assert.equal(one.find(mark.id).name, 'Second tab');
});

test('a renewed session keeps marks, undo and the deleted list, and uses the new token', async t => {
  const { request, scope } = await openServer(t);
  const first = scope('client', 'client-a'), renewed = scope('client', 'client-a');
  let current = first;
  const sent = [];
  const store = createMarksStore({ request: (path, init) => { sent.push([path, init.headers.authorization]); return request(path, init); } });
  const context = () => ({ mode: 'session', key: 'same person and model', token: () => current.token() });
  await store.setScope(context());
  const mark = await store.create(pin('Kept'));
  const loads = sent.length;
  current = renewed;
  first.record.revoked = true;
  await store.setScope(context());
  assert.equal(sent.length, loads, 'nothing is reloaded');
  assert.deepEqual(store.state.marks.map(row => row.id), [mark.id]);
  assert.equal(store.state.undo.length, 1);
  assert.equal((await store.update(store.find(mark.id), { name: 'After renewal' })).name, 'After renewal');
  assert.equal(sent.at(-1)[1], 'Bearer ' + renewed.token());
});

test('losing the individual identity or the grant mid-session empties the store', async t => {
  for (const lose of [record => { record.permissions = { view: true, measure: true }; }, record => { record.revoked = true; }]) {
    const { request, scope } = await openServer(t);
    const person = scope('client', 'client-a');
    const store = createMarksStore({ request });
    await store.setScope(person);
    const mark = await store.create(pin('Mine'));
    await store.saveCategory({ name: 'Mine', color: '#1e88e5', icon: 'target' });
    await store.remove(mark);
    await store.loadDeleted();
    const second = await store.create(pin('Second'));
    lose(person.record);
    assert.equal(await store.update(second, { name: 'Changed' }), null);
    assert.deepEqual([store.state.marks, store.state.categories, store.state.deleted, store.state.undo], [[], [], [], []]);
    assert.equal(store.canWrite(), false);
  }
});

test('[held sharing] categories and GeoJSON import go through the API; company logins see no marks', async t => {
  const { request, scope } = await openServer(t, SHARING);
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
  assert.deepEqual(company.state.marks, []);
  assert.deepEqual(company.state.categories, []);
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

// A request the test settles by hand, so it can finish after the scope was replaced.
function heldRequests(request, isHeld) {
  const held = [];
  const wrapped = (path, init) => {
    const { signal, ...rest } = init;
    // Deliberately ignore the abort signal: the late answer must be harmless by itself.
    if (!isHeld(path, init)) return request(path, rest);
    return new Promise(resolve => held.push({ path, token: init.headers.authorization, settle: async () => resolve(await request(path, rest)) }));
  };
  return { held, request: wrapped };
}
const settled = () => new Promise(resolve => setTimeout(resolve, 20));
const visibleState = store => JSON.parse(JSON.stringify({ marks: store.state.marks, deleted: store.state.deleted, categories: store.state.categories, undo: store.state.undo,
  audiences: store.state.audiences, busy: store.state.busy, message: store.state.message, ready: store.state.ready }));

const category = name => ({ id: randomUUID(), name, color: '#43a047', icon: 'gate' });
const first = () => ({ ...pin('First person'), id: randomUUID() });
for (const [name, start, isHeld] of [
  ['create', store => store.create(first()), (path, init) => init.method === 'POST'],
  ['update', store => store.update(store.state.marks[0], { name: 'Late' }), (path, init) => init.method === 'PUT'],
  ['delete', store => store.remove(store.state.marks[0]), (path, init) => init.method === 'DELETE'],
  ['undo of a delete', async store => { await store.remove(store.state.marks[0]); return store.undo(); }, (path, init) => path.endsWith('/restore')],
  ['restore', async store => { await store.remove(store.state.marks[0]); await store.loadDeleted(); return store.restore(store.state.deleted[0]); }, path => path.endsWith('/restore')],
  ['deleted list', store => store.loadDeleted(), path => path.endsWith('/deleted')],
  ['new category', store => store.saveCategory({ name: 'Late', color: '#43a047', icon: 'gate' }), (path, init) => init.method === 'POST'],
  ['category edit', store => store.saveCategory({ ...store.state.categories[0], name: 'Late' }), (path, init) => init.method === 'PUT'],
  ['category delete', store => store.deleteCategory(store.state.categories[0]), (path, init) => init.method === 'DELETE'],
  ['import', store => store.importMarks({ categories: [category('Late')], marks: [first()] }), path => path.endsWith('/batch')],
  ['undo of an import', async store => { await store.importMarks({ marks: [first()] }); return store.undo(); }, path => path.endsWith('/batch/delete')],
  ['refresh', store => store.refresh(), (path, init) => init.method === 'GET'],
]) {
  for (const replacement of ['another person', 'a public link', 'no access']) {
    test(`${name} settling after the scope became ${replacement} changes nothing there`, async t => {
      const { request, scope } = await openServer(t);
      const owner = createMarksStore({ request });
      const one = scope('client', 'client-a'), two = scope('client', 'client-b');
      await owner.setScope(one);
      await owner.create(pin('Owned'));
      await owner.saveCategory({ name: 'Owned category', color: '#1e88e5', icon: 'target' });

      let armed = false;
      const held = heldRequests(request, (path, init) => armed && isHeld(path, init));
      const store = createMarksStore({ request: held.request });
      await store.setScope(one);
      armed = true;
      const pending = start(store);
      await settled();
      assert.equal(held.held.length, 1, 'the request is waiting');
      assert.equal(held.held[0].token, 'Bearer ' + one.token());
      armed = false;
      await store.setScope(replacement === 'another person' ? two : replacement === 'a public link' ? { mode: 'temporary', key: 'public' } : null);
      const before = visibleState(store);
      assert.deepEqual([before.marks, before.categories, before.undo], [[], [], []]);
      const requests = held.held.length;
      await held.held[0].settle();
      const result = await pending;
      await settled();
      assert.ok(!result, 'the caller is told it did not apply');
      assert.deepEqual(visibleState(store), before);
      assert.equal(held.held.length, requests, 'no further request');
      if (replacement === 'another person') {
        const mine = await store.create(pin('Second person'));
        assert.deepEqual(store.state.marks.map(mark => mark.name), ['Second person']);
        assert.deepEqual(store.state.undo.map(entry => entry.id), [mine.id]);
      }
    });
  }
}

test('reading shared marks stops between pages when the scope changes, and never uses the new token', async t => {
  const { request, scope } = await openServer(t);
  const client = createMarksStore({ request });
  await client.setScope(scope('client', 'client-a'));
  await client.create(pin('Shared', { visibility: 'staff' }));
  const staff = scope('ops', 'staff-person'), other = scope('client', 'client-b');
  for (const replacement of [other, { mode: 'temporary', key: 'public' }, null]) {
    const sent = [];
    const held = heldRequests(request, path => path.includes('/shared'));
    const store = createMarksStore({ request: (path, init) => { sent.push([path, init.headers.authorization]); return held.request(path, init); } });
    const loading = store.setScope(staff);
    await settled();
    assert.equal(held.held.length, 1);
    assert.equal(store.state.ready, true, 'own marks are already there');
    await store.setScope(replacement);
    const before = visibleState(store);
    sent.length = 0;
    await held.held[0].settle();
    await loading;
    await settled();
    assert.deepEqual(visibleState(store), before);
    assert.deepEqual(before.marks, []);
    assert.deepEqual(sent, []);
  }
});

test('work that waits before calling the store can tell its scope ended', async t => {
  const { request, scope } = await openServer(t);
  const store = createMarksStore({ request });
  assert.equal(store.hold().live(), false, 'no scope, nothing to hold');
  const one = scope('client', 'client-a');
  await store.setScope(one);
  const held = store.hold();
  await store.setScope(one);
  assert.equal(held.live(), true, 'the same scope again keeps it');
  await store.setScope(null);
  assert.equal(held.live(), false);
  await store.setScope(one);
  assert.equal(held.live(), false, 'returning to the same person does not revive it');
});

test('a mark that is no longer in this scope cannot be changed, deleted or undone', async t => {
  const { request, scope } = await openServer(t);
  const store = createMarksStore({ request });
  await store.setScope(scope('client', 'client-a'));
  const old = await store.create(pin('First person'));
  await store.setScope({ mode: 'temporary', key: 'public' });
  assert.equal(await store.update(old, { name: 'Moved' }), null);
  assert.equal(await store.remove(old), false);
  assert.deepEqual(store.state.undo, []);
});
