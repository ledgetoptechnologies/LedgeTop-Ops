import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import repository from '../server/viewerMarkRepository.js';
import schema from '../server/viewerMarkSchema.js';
import { geoJsonToMarks } from '../viewer-mark-geojson.mjs';
import { createMarksStore } from '../viewer-marks-store.mjs';

const base = '/api/v1/marks';
const scope = { mode: 'session', key: 'marks-test', token: () => 'marks-test' };
const list = (marks = [], categories = []) => Response.json({ marks, categories,
  capabilities: { write: true, staff: false, visibility: ['private'] } });
const record = (mark, revision = 1) => ({ ...mark, revision, mine: true, editable: true });
const point = (name, id = randomUUID()) => ({
  id, name, geometry: { type: 'Point', coordinates: [-87, 43] }, visibility: 'private', color: '#1565c0', icon: 'pin',
});

test('Undo asks again instead of applying a stale action when a newer import is recovered', async () => {
  const older = point('Older mark'), imported = point('Imported mark');
  const rows = [], writes = [];
  let offline = false;
  const store = createMarksStore({ request: async (path, init) => {
    if (init.method === 'GET') {
      if (offline) throw new TypeError('Offline');
      assert.equal(path, base);
      return list(rows);
    }
    writes.push([init.method, path]);
    if (path === base) {
      const mark = record(JSON.parse(init.body));
      rows.push(mark);
      return Response.json({ mark }, { status: 201 });
    }
    if (path === base + '/batch') {
      rows.push(...JSON.parse(init.body).marks.map(mark => record(mark)));
      offline = true;
      throw new TypeError('Response lost');
    }
    assert.equal(path, base + '/batch/delete');
    assert.deepEqual(JSON.parse(init.body), { marks: [{ id: imported.id, revision: 1 }] });
    return new Response(null, { status: 204 });
  } });
  await store.setScope(scope);
  await store.create(older);
  assert.equal(await store.importMarks({ marks: [imported] }), 0);
  assert.deepEqual(store.state.undo.map(item => item.type), ['create']);

  offline = false;
  const before = writes.length;
  assert.equal(await store.undo(), false);
  assert.equal(store.state.failure, 'undo_target_changed');
  assert.equal(writes.length, before, 'the old Undo made no write');
  assert.deepEqual(store.state.undo.map(item => item.type), ['create', 'import']);
  assert.ok(await store.undo(), 'another explicit choice undoes the now-visible import');
  assert.deepEqual(store.state.marks.map(mark => mark.id), [older.id]);
});

test('Undo asks again when recovering category deletion rewrites the same history entry', async () => {
  const category = { id: randomUUID(), name: 'Gate', color: '#1565c0', icon: 'gate', mine: true, revision: 1 };
  const original = { ...point('Original'), categoryId: category.id };
  let row, removedCategory = false, offline = false;
  const writes = [];
  const store = createMarksStore({ request: async (path, init) => {
    if (init.method === 'GET') {
      if (offline) throw new TypeError('Offline');
      return list(row ? [row] : [], removedCategory ? [] : [category]);
    }
    const payload = JSON.parse(init.body);
    writes.push([init.method, path, payload]);
    if (init.method === 'DELETE') {
      assert.equal(path, base + '/categories/' + category.id);
      removedCategory = offline = true;
      row = { ...row, categoryId: null };
      throw new TypeError('Response lost');
    }
    row = record(payload, payload.revision ? payload.revision + 1 : 1);
    return Response.json({ mark: row });
  } });
  await store.setScope(scope);
  const made = await store.create(original);
  await store.update(made, { name: 'Edited' });
  assert.equal(await store.deleteCategory(category), false);
  const old = store.state.undo.at(-1);

  offline = false;
  const before = writes.length;
  assert.equal(await store.undo(), false);
  assert.equal(store.state.failure, 'undo_target_changed');
  assert.equal(writes.length, before);
  assert.equal(store.state.undo.at(-1).at, old.at);
  assert.equal(store.state.undo.at(-1).before.categoryId, null);
  assert.ok(await store.undo());
  assert.equal(writes.at(-1)[2].categoryId, null);
  assert.equal(store.find(made.id).name, 'Original');
});

test('a definite Restore refusal removes its expired row without claiming stale evidence', async () => {
  const old = record(point('Expired'), 2), deleted = { ...old, deletedAt: '2026-01-01T00:00:00.000Z' };
  // Model a previous live snapshot where this ID had been restored, then
  // deleted again elsewhere. Both attempts to get current evidence now fail.
  const cached = { ...old, revision: 3 };
  let offline = false;
  const store = createMarksStore({ request: async (path, init) => {
    if (init.method === 'GET') {
      if (offline) throw new TypeError('Offline');
      return path === base ? list([cached]) : Response.json({ marks: [deleted] });
    }
    assert.equal(path, base + '/' + old.id + '/restore');
    return Response.json({ code: 'mark_not_found' }, { status: 404 });
  } });
  await store.setScope(scope);
  await store.loadDeleted();
  offline = true;
  assert.equal(await store.restore(deleted), null);
  assert.equal(store.state.failure, 'restore_unavailable');
  assert.match(store.state.message, /no longer available to restore/);
  assert.deepEqual(store.state.deleted, []);
  assert.equal(store.state.recoveredChange, null);
  assert.deepEqual(store.state.undo, []);
});

test('Restore can recognize a fresh, newer revision after the other session has already restored it', async () => {
  const old = record(point('Restored elsewhere'), 2), deleted = { ...old, deletedAt: '2026-01-01T00:00:00.000Z' };
  const fresh = { ...old, revision: 3 };
  let restored = false;
  const store = createMarksStore({ request: async (path, init) => {
    if (init.method === 'GET') {
      return path === base ? list(restored ? [fresh] : []) : Response.json({ marks: restored ? [] : [deleted] });
    }
    restored = true;
    return Response.json({ code: 'mark_not_found' }, { status: 404 });
  } });
  await store.setScope(scope);
  await store.loadDeleted();
  assert.deepEqual(await store.restore(deleted), fresh);
  assert.deepEqual(store.state.deleted, []);
  assert.match(store.state.recoveredChange.done, /is back in Marks/);
  assert.deepEqual(store.state.undo, [], 'cannot Undo a restore that may have been performed elsewhere');
});

test('a GeoJSON retry reuses the frozen payload even after category resolution has changed', async () => {
  const file = { type: 'Feature', properties: { name: 'North', category: 'Gate' },
    geometry: { type: 'Point', coordinates: [-87, 43] } };
  for (const landed of [true, false]) {
    const submissions = [];
    let offline = false;
    const store = createMarksStore({ request: async (path, init) => {
      if (init.method === 'GET') {
        if (offline) throw new TypeError('Offline');
        assert.equal(path, base);
        return list(landed ? submissions.at(-1)?.marks.map(mark => record(mark)) : [],
          landed ? submissions.at(-1)?.categories : []);
      }
      assert.equal(path, base + '/batch');
      const payload = JSON.parse(init.body);
      submissions.push(payload);
      if (submissions.length === 1) {
        offline = true;
        throw new TypeError('Response lost');
      }
      return Response.json({ marks: payload.marks.map(mark => record(mark)), categories: payload.categories }, { status: 201 });
    } });
    await store.setScope(scope);
    const before = geoJsonToMarks(file, { newId: randomUUID });
    assert.equal(await store.importMarks(before), 0);
    offline = false;

    const after = geoJsonToMarks(file, { newId: randomUUID,
      categories: [{ id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate' }] });
    assert.equal(after.categories.length, 0);
    assert.notEqual(after.marks[0].color, before.marks[0].color);
    let shown;
    assert.equal(await store.importMarks(after, { onImported: rows => { shown = rows; } }), 1);
    assert.equal(shown[0].id, before.marks[0].id);
    assert.equal(shown[0].categoryId, before.marks[0].categoryId);
    assert.equal(submissions.length, landed ? 1 : 2);
    if (!landed) assert.deepEqual(submissions[1], submissions[0]);
    assert.equal(store.state.undo.at(-1).type, 'import');
  }
});

test('unrelated imports leave every unresolved payload intact', async () => {
  const plans = ['North', 'South'].map(name => ({ marks: [point(name)] }));
  const rows = [], submissions = new Map();
  const store = createMarksStore({ request: async (path, init) => {
    if (init.method === 'GET') return list(rows);
    assert.equal(path, base + '/batch');
    const payload = JSON.parse(init.body);
    const name = payload.marks[0].name;
    const prior = submissions.get(name);
    if (!prior) {
      submissions.set(name, payload);
      throw new TypeError('No response');
    }
    assert.deepEqual(payload, prior);
    const marks = payload.marks.map(mark => record(mark));
    rows.push(...marks);
    return Response.json({ marks, categories: [] }, { status: 201 });
  } });
  await store.setScope(scope);
  for (const plan of plans) assert.equal(await store.importMarks(plan), 0);
  for (const plan of plans) {
    const [mark] = plan.marks;
    assert.equal(await store.importMarks({ marks: [{ ...mark, id: randomUUID() }] }), 1);
  }
  assert.deepEqual(rows.map(row => row.id), plans.map(plan => plan.marks[0].id));
});

for (const conflict of ['mark_category_name_taken', 'mark_category_id_conflict', 'mark_category_not_found']) {
  test(`a definite ${conflict} only releases a frozen import after fresh readback`, async () => {
    const file = { type: 'Feature', properties: { name: 'North', category: 'Gate' },
      geometry: { type: 'Point', coordinates: [-87, 43] } };
    const existing = { id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate', mine: true };
    const previous = conflict === 'mark_category_not_found' ? [{ ...existing, id: randomUUID() }] : [];
    const original = geoJsonToMarks(file, { newId: randomUUID, categories: previous });
    const rows = [], submissions = [];
    let categories = previous, unavailable = '';
    const store = createMarksStore({ request: async (path, init) => {
      if (unavailable === path) {
        unavailable = '';
        throw new TypeError('Offline');
      }
      if (init.method === 'GET') {
        assert.equal(path, base);
        return list(rows, categories);
      }
      if (path === base + '/batch/status') {
        assert.deepEqual(JSON.parse(init.body), { ids: [original.marks[0].id] });
        const reservedIds = submissions.length === 4 ? [original.marks[0].id] : [];
        return Response.json({ reservedIds });
      }
      assert.equal(path, base + '/batch');
      const payload = JSON.parse(init.body);
      submissions.push(payload);
      if (submissions.length === 1) {
        unavailable = base;
        throw new TypeError('No response');
      }
      // Like createMany, reject the conflicting category before inserting any
      // marks. An ID can remain reserved even after its category is deleted.
      const reserved = payload.categories.some(category => conflict === 'mark_category_id_conflict' && category.id === original.categories[0].id);
      const sameName = payload.categories.some(category => categories.some(row => row.name === category.name));
      const deletedReference = conflict === 'mark_category_not_found' && payload.marks[0].categoryId === previous[0].id;
      if (reserved || sameName || deletedReference) {
        if (submissions.length === 2) unavailable = base;
        if (submissions.length === 3) unavailable = base + '/batch/status';
        return Response.json({ code: conflict }, { status: deletedReference ? 400 : 409 });
      }
      assert.deepEqual(payload.categories, []);
      assert.equal(payload.marks[0].categoryId, existing.id);
      rows.push(...payload.marks.map(mark => record(mark)));
      return Response.json({ marks: rows, categories: [] }, { status: 201 });
    } });
    await store.setScope(scope);
    assert.equal(await store.importMarks(original), 0);
    categories = [existing];

    const retry = () => geoJsonToMarks(file, { newId: randomUUID, categories });
    for (let count = 2; count <= 5; count++) {
      assert.equal(await store.importMarks(retry()), 0);
      assert.equal(store.state.failure, conflict);
      assert.equal(submissions.length, count, 'no implicit repeat after any refusal');
      assert.deepEqual(submissions.at(-1), submissions[0], 'retry keeps the original IDs and payload');
      assert.deepEqual(rows, []);
    }
    const replacement = retry();
    assert.equal(await store.importMarks(replacement), 1);
    assert.deepEqual(rows.map(mark => mark.id), [replacement.marks[0].id]);
    assert.equal(submissions.length, 6);
    assert.equal(store.state.undo.at(-1).type, 'import');
  });
}

test('one owned mark snapshot includes live rows and retained deletion IDs', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('one'), ('two');");
  db.exec(schema.VIEWER_MARKS_SQL + schema.VIEWER_MARK_SHARING_SQL);
  const marks = new repository.ViewerMarkRepository(db);
  const owner = { modelId: 'one', audience: 'ops', subject: 'owner' };
  const person = { ...owner, subject: 'other' };
  const live = point('Live'), deleted = point('Deleted'), forgotten = point('Discarded');
  const otherPerson = point('Other owner'), otherModel = point('Other model'), otherAudience = point('Other audience');
  for (const row of [live, deleted, forgotten]) marks.create(owner, row);
  marks.delete(owner, deleted.id, 1);
  marks.delete(owner, forgotten.id, 1, { permanent: true });
  marks.create(person, otherPerson);
  marks.create({ ...owner, modelId: 'two' }, otherModel);
  marks.create({ ...owner, audience: 'client' }, otherAudience);
  assert.deepEqual(new Set(marks.reservedImportIds(owner,
    [live.id.toUpperCase(), deleted.id, forgotten.id, otherPerson.id, otherModel.id, otherAudience.id, randomUUID()])),
  new Set([live.id, deleted.id, forgotten.id]));
  assert.throws(() => marks.reservedImportIds(owner, ['bad']), { code: 'invalid_mark_batch' });
  assert.throws(() => marks.reservedImportIds(owner, Array(501).fill(live.id)), { code: 'invalid_mark_batch' });
});
