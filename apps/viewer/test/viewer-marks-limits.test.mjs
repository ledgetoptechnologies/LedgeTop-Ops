import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import marksRepository from '../server/viewerMarkRepository.js';
import { createMarksStore } from '../viewer-marks-store.mjs';
import { openMarksPanel } from './helpers/marks-panel.mjs';

const { LIMITS } = marksRepository;
const NOW = '2026-11-20T00:00:00.000Z';
const document = (id, changes = {}) => ({ id, geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Mark', note: '', categoryId: null, color: '#1565c0',
  icon: 'pin', elevationNavd88M: null, ...changes });
const bigNote = 'a'.repeat(2000);
const bigLine = { type: 'LineString', coordinates: Array.from({ length: 500 }, (_, i) => [-87.12345678 - i / 1e6, 43.12345678]) };

// Rows as many people would leave them, without thousands of requests.
function seeder(database) {
  const marks = database.prepare(`INSERT INTO viewer_marks(id, model_id, owner_audience, owner_subject, visibility, document_json, creation_hash, revision,
    created_at, updated_at, updated_by_audience, updated_by_subject, deleted_at) VALUES (?, 'synthetic-model', ?, ?, ?, ?, 'x', 1, ?, ?, ?, ?, ?)`);
  const categories = database.prepare(`INSERT INTO viewer_mark_categories(id, model_id, owner_audience, owner_subject, name, document_json, revision, created_at, updated_at)
    VALUES (?, 'synthetic-model', ?, ?, ?, ?, 1, ?, ?)`);
  return {
    mark(subject, { audience = 'client', visibility = 'staff', changes = {}, deletedAt = null, createdAt = NOW } = {}) {
      const id = randomUUID();
      marks.run(id, audience, subject, visibility, JSON.stringify(document(id, changes)), createdAt, NOW, audience, subject, deletedAt);
      return id;
    },
    category(subject, name, audience = 'client') {
      const id = randomUUID();
      categories.run(id, audience, subject, name, JSON.stringify({ id, name, color: '#1565c0', icon: 'flag' }), NOW, NOW);
      return id;
    },
  };
}
async function open(t, options) {
  const setup = await openMarksPanel(t, options);
  const store = async scope => { const made = createMarksStore({ request: setup.request }); await made.setScope(scope); return made; };
  return { ...setup, store, seed: seeder(setup.database) };
}
const pin = (name, changes = {}) => ({ geometry: { type: 'Point', coordinates: [-87, 43] }, name, color: '#1565c0', icon: 'pin', note: '', ...changes });

test('a person\'s own categories are never crowded out, and a category the page does not know is never cleared', async t => {
  const { store, scope, seed, database } = await open(t);
  const own = seed.category('staff-person', 'Zed', 'ops');
  const mine = seed.mark('staff-person', { audience: 'ops', visibility: 'private', changes: { name: 'Mine', categoryId: own } });
  for (const subject of ['client-a', 'client-b']) {
    for (let i = 0; i < 100; i += 1) seed.mark(subject, { changes: { categoryId: seed.category(subject, `A ${i}`) } });
  }
  const staff = await store(scope('ops', 'staff-person'));
  assert.ok(staff.state.categories.some(category => category.id === own));
  assert.equal(staff.state.categories.length, 201, 'and every category a shared mark uses is there');
  await staff.update(staff.find(mine), { name: 'Renamed' });
  assert.equal(JSON.parse(database.prepare('SELECT document_json d FROM viewer_marks WHERE id=?').get(mine).d).categoryId, own);
  // Even if the list is stale or short, the mark keeps what it has.
  staff.state.categories = [];
  await staff.update(staff.find(mine), { name: 'Again' });
  assert.equal(JSON.parse(database.prepare('SELECT document_json d FROM viewer_marks WHERE id=?').get(mine).d).categoryId, own);
  // A category deleted elsewhere is said, not silently dropped.
  const client = await store(scope('client', 'client-c'));
  const category = await client.saveCategory({ name: 'Gone', color: '#1565c0', icon: 'flag' });
  const other = await store(scope('client', 'client-c'));
  await other.deleteCategory(other.state.categories[0]);
  assert.equal(await client.create(pin('New', { categoryId: category.id })), null);
  assert.match(client.state.message, /category is gone/);
  assert.deepEqual([client.state.categories, client.state.marks], [[], []]);
});

test('undoing an edit works after its category was deleted here', async t => {
  const { store, scope } = await open(t);
  const client = await store(scope('client', 'client-a'));
  const category = await client.saveCategory({ name: 'Stands', color: '#1565c0', icon: 'flag' });
  const mark = await client.create(pin('One', { categoryId: category.id }));
  await client.update(client.find(mark.id), { name: 'Two', categoryId: null });
  await client.deleteCategory(category);
  assert.equal(await client.undo(), true);
  assert.deepEqual([client.find(mark.id).name, client.find(mark.id).categoryId], ['One', null]);
});

const importFile = (panel, file) => {
  const input = panel.panel.querySelectorAll('input').find(node => node.getAttribute('type') === 'file');
  const text = typeof file === 'string' ? file : JSON.stringify(file);
  input.files = [{ size: text.length, text: async () => text }];
  return input.fire('change');
};
const feature = (name, category) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [-87, 43] }, properties: { name, category } });

test('an import matches only the person\'s own categories', async t => {
  for (const owns of [true, false]) {
    for (const first of ['client', 'own']) {
      const { mount, scope, seed, database } = await open(t);
      const ids = {};
      const make = { client: () => { ids.client = seed.category('client-a', 'Gates'); }, own: () => { if (owns) ids.own = seed.category('staff-person', 'Gates', 'ops'); } };
      for (const who of first === 'client' ? ['client', 'own'] : ['own', 'client']) make[who]();
      seed.mark('client-a', { changes: { categoryId: ids.client } });
      const panel = mount();
      await panel.marks.setScope(scope('ops', 'staff-person'));
      await importFile(panel, feature('Imported', 'gates'));
      const imported = panel.store.state.marks.find(mark => mark.name === 'Imported');
      const category = panel.store.state.categories.find(row => row.id === imported.categoryId);
      assert.equal(category.mine, true);
      if (owns) assert.equal(category.id, ids.own);
      assert.equal(database.prepare("SELECT count(*) n FROM viewer_mark_categories WHERE owner_audience='ops'").get().n, 1);
    }
  }
});

test('many shared marks: small answers, all of them in pages, and nobody else\'s marks use up one\'s own limit', async t => {
  const { store, scope, seed, requests, request } = await open(t);
  const clients = ['client-a', 'client-b', 'client-c', 'client-d', 'client-e'];
  for (const subject of clients) for (let i = 0; i < LIMITS.perOwner; i += 1) seed.mark(subject, { changes: i < 150 ? { geometry: bigLine, note: bigNote } : {} });
  const staffScope = scope('ops', 'staff-person');
  const answers = [];
  const measured = async (path, init) => {
    const response = await request(path, init);
    answers.push([path, (await response.clone().text()).length]);
    return response;
  };
  const staff = createMarksStore({ request: measured });
  await staff.setScope(staffScope);
  const total = clients.length * LIMITS.perOwner;
  assert.equal(staff.state.marks.length, total);
  assert.equal(new Set(staff.state.marks.map(mark => mark.id)).size, total, 'none twice, none missed');
  for (const [path, size] of answers) assert.ok(size < 1_600_000, `${path} ${size}`);
  assert.ok(await staff.create(pin('Mine')), staff.state.message);
  assert.equal(staff.state.marks.length, total + 1);
  // Reloading keeps what is there until everything new has arrived.
  requests.length = 0;
  await staff.refresh();
  assert.equal(staff.state.marks.length, total + 1);
  // Someone else's page is never more than theirs to read.
  const client = await store(scope('client', 'client-a'));
  assert.equal(client.state.marks.length, LIMITS.perOwner);
  assert.ok(!requests.some(([, path]) => path.includes('/shared') && path.includes('client')));
});

test('paging holds when marks change between pages, and the page asks for nothing it cannot read', async t => {
  const { scope, seed, request, database } = await open(t);
  // The same time on every mark: the id decides.
  const ids = Array.from({ length: LIMITS.pageRows + 5 }, () => seed.mark('client-a')).sort();
  seed.mark('client-a', { visibility: 'private' });
  const staff = scope('ops', 'staff-person');
  const get = async (path, token = staff.token()) => {
    const response = await request('/api/v1/marks' + path, { method: 'GET', headers: { authorization: 'Bearer ' + token } });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const first = (await get('/shared')).body;
  assert.equal(first.marks.length, LIMITS.pageRows);
  database.prepare('UPDATE viewer_marks SET deleted_at=? WHERE id=?').run(NOW, first.marks.at(-1).id);
  const second = (await get('/shared?after=' + encodeURIComponent(first.next))).body;
  assert.deepEqual([...first.marks, ...second.marks].map(mark => mark.id), ids, 'the last id of a page may be gone; the rest still follow');
  assert.equal(second.next, null);
  for (const bad of ['x', '~', NOW, NOW + '~not-an-id', "' OR 1=1~" + ids[0], NOW + '~' + ids[0] + '~', 'a'.repeat(500)]) {
    assert.equal((await get('/shared?after=' + encodeURIComponent(bad))).status, 400, bad);
  }
  assert.equal((await get('/shared?after=a&after=b')).status, 400);
  assert.deepEqual((await get('/shared', scope('client', 'client-b').token())).body, { marks: [], categories: [], next: null });
  assert.equal((await get('/shared', scope('client', 'x', { permissions: { view: true, measure: true } }).token())).status, 403);
});

test('a page that fails leaves the person\'s own marks and what had arrived, and says so', async t => {
  const { store, scope, seed, request } = await open(t);
  const own = seed.mark('staff-person', { audience: 'ops', visibility: 'private', changes: { name: 'Mine' } });
  for (let i = 0; i < LIMITS.pageRows + 10; i += 1) seed.mark('client-a');
  for (const fail of [() => new Response(JSON.stringify({ code: 'mark_rate_limited' }), { status: 429 }), () => new Response('x', { status: 500 })]) {
    const staff = createMarksStore({ request: (path, init) => (path.includes('after=') ? Promise.resolve(fail()) : request(path, init)) });
    await staff.setScope(scope('ops', 'staff-person'));
    assert.equal(staff.state.ready, true);
    assert.ok(staff.find(own));
    assert.equal(staff.state.marks.length, LIMITS.pageRows + 1);
    assert.match(staff.state.message, /Some shared marks/);
    const works = await staff.create(pin('Works'));
    assert.ok(works);
    await staff.remove(works);
  }
  assert.ok(store);
});

test('reads are rate limited per person', async t => {
  const buckets = [];
  let limited = false;
  const { scope, request } = await open(t, { rateLimited: (bucket, max, windowMs) => { buckets.push([bucket, max, windowMs]); return limited; } });
  const token = scope('ops', 'staff-person').token();
  const get = path => request('/api/v1/marks' + path, { method: 'GET', headers: { authorization: 'Bearer ' + token } });
  assert.equal((await get('')).status, 200);
  assert.deepEqual(buckets, [['viewer-mark-read:ops:staff-person', 240, 60_000]]);
  limited = true;
  for (const path of ['', '/shared', '/deleted', '/' + randomUUID()]) assert.equal((await get(path)).status, 429, path);
});

test('a person\'s own marks have a size limit, for adding, importing, growing and restoring', async t => {
  const { database, seed } = await open(t);
  const repository = new marksRepository.ViewerMarkRepository(database);
  const person = { modelId: 'synthetic-model', modelVersionId: 'synthetic-v1', audience: 'client', subject: 'client-a', session: {}, personalPersistence: true };
  const big = () => ({ id: randomUUID(), geometry: bigLine, name: 'Big', color: '#1565c0', note: bigNote });
  const small = repository.create(person, { ...big(), geometry: { type: 'Point', coordinates: [-87, 43] }, note: '' }).mark;
  let made = 0;
  assert.throws(() => { for (;;) { repository.create(person, big()); made += 1; } }, { code: 'mark_storage_limit', status: 429 });
  assert.ok(made > 100 && made < LIMITS.perOwner, String(made));
  const bytes = () => database.prepare("SELECT sum(length(CAST(document_json AS BLOB))) n FROM viewer_marks WHERE owner_subject='client-a' AND deleted_at IS NULL").get().n;
  assert.ok(bytes() <= LIMITS.ownerBytes);
  const before = bytes();
  assert.throws(() => repository.createMany(person, { marks: [big(), big()] }), { code: 'mark_storage_limit' });
  assert.throws(() => repository.update(person, small.id, { ...big(), id: small.id, revision: 1 }), { code: 'mark_storage_limit' });
  assert.equal(bytes(), before);
  // Shrinking is always possible.
  const [large] = repository.list(person).filter(row => row.geometry.type === 'LineString');
  assert.ok(repository.update(person, large.id, { id: large.id, geometry: { type: 'Point', coordinates: [-87, 43] }, name: 'Small', color: '#1565c0', revision: 1 }));
  const gone = seed.mark('client-a', { visibility: 'private', deletedAt: new Date().toISOString(), changes: { geometry: bigLine, note: bigNote } });
  assert.throws(() => { for (;;) repository.create(person, big()); }, { code: 'mark_storage_limit' });
  assert.throws(() => repository.restore(person, gone, 1), { code: 'mark_storage_limit' });
});

test('when Recently deleted is full, a delete asks first and then deletes only that mark for good', async t => {
  const { mount, scope, seed, database } = await open(t);
  const deletedAt = new Date(Date.now() - 60_000).toISOString();
  for (let i = 0; i < LIMITS.deleted; i += 1) seed.mark('client-a', { visibility: 'private', deletedAt });
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  const mark = await panel.store.create(pin('One more')), kept = await panel.store.create(pin('Kept'));
  const content = () => database.prepare("SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NOT NULL AND document_json<>'{}'").get().n;
  const button = text => panel.q('.viewer-mark-form').querySelectorAll('button').find(node => node.textContent === text);
  await panel.open('One more');
  await button('Delete').click();
  await button('Tap again to delete').click();
  assert.ok(panel.store.find(mark.id), 'refused, nothing happened');
  assert.equal(content(), LIMITS.deleted, 'and nothing older was destroyed');
  assert.match(panel.text(), /Recently deleted is full/);
  const undo = panel.store.state.undo.length;
  await button('Delete for good').click();
  assert.equal(panel.store.find(mark.id), null);
  assert.equal(content(), LIMITS.deleted);
  assert.equal(database.prepare('SELECT document_json d FROM viewer_marks WHERE id=?').get(mark.id).d, '{}');
  assert.equal(panel.store.state.undo.length, undo, 'it offers no undo it cannot do');
  // The offer does not carry to another mark.
  await panel.open('Kept');
  assert.equal(button('Delete for good'), undefined);
  assert.ok(panel.store.find(kept.id));
});

test('deleting a category says it cannot be undone, and keeps nothing of it', async t => {
  const { mount, scope, database } = await open(t);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  const category = await panel.store.saveCategory({ name: 'Private name', color: '#1565c0', icon: 'flag' });
  const mark = await panel.store.create(pin('One', { categoryId: category.id }));
  const remove = () => panel.q('[aria-label="Delete Private name"]');
  await remove().click();
  assert.match(panel.text(), /Deleting a category can't be undone/);
  assert.equal(remove().textContent, 'Delete for good');
  assert.equal(panel.store.state.categories.length, 1);
  await remove().click();
  assert.equal(panel.store.state.categories.length, 0);
  assert.equal(panel.store.find(mark.id).categoryId, null);
  const row = database.prepare('SELECT * FROM viewer_mark_categories WHERE id=?').get(category.id);
  assert.deepEqual([row.name, row.document_json, Boolean(row.deleted_at)], ['', '{}', true]);
  await panel.store.saveCategory({ name: 'Private name', color: '#1565c0', icon: 'flag' });
  assert.equal(panel.store.state.categories.length, 1, 'the name can be used again');
});

test('undoing a large import is one request, and a failed undo can be tried again', async t => {
  const { scope, request, database } = await open(t);
  let fail = null;
  const sent = [];
  const store = createMarksStore({ request: (path, init) => {
    sent.push([init.method, path]);
    if (fail && init.method !== 'GET') { const response = fail; fail = null; return response(); }
    return request(path, init);
  } });
  await store.setScope(scope('client', 'client-a'));
  const marks = Array.from({ length: 400 }, (_, i) => ({ ...pin('m' + i), id: randomUUID() }));
  assert.equal(await store.importMarks({ marks }), 400);
  const live = () => database.prepare('SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NULL').get().n;
  sent.length = 0;
  for (const response of [() => Promise.resolve(new Response(JSON.stringify({ code: 'mark_rate_limited' }), { status: 429 })), () => Promise.reject(new TypeError('offline')),
    () => Promise.resolve(new Response('x', { status: 500 }))]) {
    fail = response;
    assert.equal(await store.undo(), false);
    assert.equal(store.state.undo.length, 1, 'still there');
    assert.equal(live(), 400);
  }
  sent.length = 0;
  assert.equal(await store.undo(), true, store.state.message);
  assert.deepEqual(sent, [['POST', '/api/v1/marks/batch/delete']]);
  assert.deepEqual([live(), store.state.marks, store.state.undo], [0, [], []]);
  // One that cannot be done any more goes away instead of blocking the ones before it.
  const only = await store.create(pin('Only'));
  await store.update(store.find(only.id), { name: 'Two' });
  database.prepare('UPDATE viewer_marks SET revision=9 WHERE id=?').run(only.id);
  assert.equal(await store.undo(), false);
  assert.equal(store.state.undo.length, 1);
});

test('undo of an import is exactly what was imported, or nothing', async t => {
  for (const where of ['session', 'public link']) {
    for (const change of ['edited here', 'edited elsewhere', 'deleted here', 'deleted elsewhere']) {
      if (where === 'public link' && change.endsWith('elsewhere')) continue;
      const { store: open_, scope, database, request } = await open(t);
      const sent = [];
      const store = createMarksStore({ request: (path, init) => { sent.push([init.method, path, init.body && JSON.parse(init.body)]); return request(path, init); } });
      await store.setScope(where === 'session' ? scope('client', 'client-a') : { mode: 'temporary', key: 'public' });
      const before = await store.create(pin('Before'));
      const marks = ['a', 'b', 'c'].map(name => ({ ...pin(name), id: randomUUID() }));
      await store.importMarks({ marks });
      const imported = marks.map(mark => ({ id: mark.id, revision: store.find(mark.id).revision }));
      const other = change.endsWith('elsewhere') ? await open_(scope('client', 'client-a')) : store;
      if (change.startsWith('edited')) await other.update(other.find(marks[1].id), { name: 'Edited' });
      else await other.remove(other.find(marks[1].id));
      // The page may know about it or not; either way the import is not undone in part.
      if (change === 'edited elsewhere') await store.refresh();
      store.state.undo = store.state.undo.filter(entry => entry.type !== 'update' && entry.type !== 'delete');
      sent.length = 0;
      assert.equal(await store.undo(), false, `${where} ${change}`);
      if (where === 'session') {
        assert.deepEqual(sent[0], ['POST', '/api/v1/marks/batch/delete', { marks: imported }], 'the ids and revisions the import returned');
        assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NULL').get().n, change.startsWith('edited') ? 4 : 3, 'rolled back whole');
      }
      assert.deepEqual(store.state.marks.map(mark => mark.name).sort(), change.startsWith('edited') ? ['Before', 'Edited', 'a', 'c'] : ['Before', 'a', 'c']);
      assert.match(store.state.message, /changed since/);
      // It cannot be done any more, so it does not block the one before it.
      assert.deepEqual(store.state.undo.map(entry => entry.id), [before.id]);
      assert.equal(await store.undo(), true);
    }
  }
});

test('a refresh that fails part way never brings back what its owner withdrew', async t => {
  for (const withdraw of ['made private', 'deleted']) {
    const { store: open_, scope, seed, request } = await open(t);
    const own = seed.mark('staff-person', { audience: 'ops', visibility: 'private', changes: { name: 'Own' } });
    const client = await open_(scope('client', 'client-a'));
    const category = await client.saveCategory({ name: 'Withdrawn category', color: '#1565c0', icon: 'flag' });
    const mark = await client.create(pin('Withdrawn', { visibility: 'staff', categoryId: category.id }));
    // Later than the withdrawn one, so it would be on the first page and these on the second.
    for (let i = 0; i < LIMITS.pageRows + 5; i += 1) seed.mark('client-b', { createdAt: '2027-01-01T00:00:00.000Z' });
    let fail = false;
    const staff = createMarksStore({ request: (path, init) => (fail && path.includes('after=') ? Promise.resolve(new Response('x', { status: 500 })) : request(path, init)) });
    await staff.setScope(scope('ops', 'staff-person'));
    assert.ok(staff.find(mark.id));
    const total = staff.state.marks.length;
    if (withdraw === 'deleted') await client.remove(client.find(mark.id));
    else await client.update(client.find(mark.id), { visibility: 'private' });
    fail = true;
    await staff.refresh();
    assert.equal(staff.find(mark.id), null, withdraw);
    assert.ok(!staff.state.categories.some(row => row.name === 'Withdrawn category'));
    assert.ok(staff.find(own), 'own marks stay');
    assert.equal(staff.state.marks.length, LIMITS.pageRows + 1, 'own marks and the page that was read, nothing older');
    assert.match(staff.state.message, /Some shared marks/);
    fail = false;
    await staff.refresh();
    assert.equal(staff.state.marks.length, total - 1);
  }
});

test('batch delete is all or nothing and the owner\'s only', async t => {
  const { scope, request, seed, database } = await open(t);
  const ids = [seed.mark('client-a', { visibility: 'private' }), seed.mark('client-a')];
  const send = async (token, body) => (await request('/api/v1/marks/batch/delete', { method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) })).status;
  const owner = scope('client', 'client-a').token(), staff = scope('ops', 'staff-person').token();
  const all = ids.map(id => ({ id, revision: 1 }));
  assert.equal(await send(staff, { marks: [all[1]] }), 403);
  assert.equal(await send(scope('client', 'client-b').token(), { marks: all }), 404);
  for (const [body, status] of [[{ marks: [all[0], { id: ids[1], revision: 2 }] }, 409], [{ marks: [...all, { id: randomUUID(), revision: 1 }] }, 404],
    [{ marks: [] }, 400], [{ marks: Array.from({ length: 501 }, () => all[0]) }, 400], [{ marks: [{ id: ids[0] }] }, 428], [{ marks: [{ ...all[0], permanent: true }] }, 400], [{}, 400]]) {
    assert.equal(await send(owner, body), status, JSON.stringify(body).slice(0, 80));
  }
  assert.equal(database.prepare('SELECT count(*) n FROM viewer_marks WHERE deleted_at IS NOT NULL').get().n, 0);
  assert.equal(await send(owner, { marks: all }), 204);
});

test('an import is one request that leaves nothing behind when it fails, and says when it is too large', async t => {
  const { mount, scope, database, requests, seed } = await open(t, { maxRequestBytes: 60_000 });
  const counts = () => ['viewer_marks', 'viewer_mark_categories'].map(name => database.prepare(`SELECT count(*) n FROM ${name}`).get().n);
  const panel = mount();
  await panel.marks.setScope(scope('client', 'client-a'));
  // Too large for the server: nothing is sent.
  requests.length = 0;
  await importFile(panel, { type: 'FeatureCollection', features: Array.from({ length: 400 }, (_, i) => feature('m' + i, 'Large')) });
  assert.match(panel.text(), /too large/);
  assert.deepEqual([requests, counts()], [[], [0, 0]]);
  // Refused by the server after its categories: rolled back together.
  for (let i = 0; i < LIMITS.perOwner - 1; i += 1) seed.mark('client-a', { visibility: 'private' });
  const before = counts();
  await importFile(panel, { type: 'FeatureCollection', features: [feature('a', 'New one'), feature('b', 'New two')] });
  assert.match(panel.text(), /limit/);
  assert.deepEqual(counts(), before);
  assert.deepEqual(panel.store.state.categories, []);
  database.prepare('DELETE FROM viewer_marks').run();
  await panel.store.refresh();
  requests.length = 0;
  await importFile(panel, { type: 'FeatureCollection', features: [feature('a', 'New one'), feature('b', 'New two')] });
  assert.deepEqual(requests, [['POST', '/api/v1/marks/batch']]);
  assert.deepEqual([counts(), panel.store.state.categories.map(category => category.name)], [[2, 2], ['New one', 'New two']]);
  // A name that was taken meanwhile on another device stops it whole.
  const other = mount();
  await other.marks.setScope(scope('client', 'client-a'));
  await other.store.saveCategory({ name: 'Race', color: '#1565c0', icon: 'flag' });
  await importFile(panel, { type: 'FeatureCollection', features: [feature('c', 'Race'), feature('d', 'Also')] });
  assert.deepEqual(counts(), [2, 3]);
  assert.ok(panel.store.state.categories.some(category => category.name === 'Race'), 'the list was read again');
});

test('the request size the page uses is the server\'s own', async t => {
  const { scope, request } = await open(t);
  const response = await request('/api/v1/marks', { method: 'GET', headers: { authorization: 'Bearer ' + scope('client', 'client-a').token() } });
  const { capabilities } = await response.json();
  assert.ok(Number.isSafeInteger(capabilities.maxRequestBytes) && capabilities.maxRequestBytes >= 100_000);
});
