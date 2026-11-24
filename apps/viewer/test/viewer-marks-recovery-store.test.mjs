import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
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

for (const conflict of ['mark_category_name_taken', 'mark_category_id_conflict']) {
  test(`a definite ${conflict} only releases a frozen import after fresh readback`, async () => {
    const file = { type: 'Feature', properties: { name: 'North', category: 'Gate' },
      geometry: { type: 'Point', coordinates: [-87, 43] } };
    const original = geoJsonToMarks(file, { newId: randomUUID });
    const existing = { id: randomUUID(), name: 'Gate', color: '#43a047', icon: 'gate', mine: true };
    const rows = [], submissions = [];
    let categories = [], unavailable = '';
    const store = createMarksStore({ request: async (path, init) => {
      if (init.method === 'GET') {
        if (unavailable === path) {
          unavailable = '';
          throw new TypeError('Offline');
        }
        if (path === base) return list(rows, categories);
        assert.equal(path, base + '/deleted');
        return Response.json({ marks: [] });
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
      for (const category of payload.categories) {
        const reserved = conflict === 'mark_category_id_conflict' && category.id === original.categories[0].id;
        if (reserved || categories.some(row => row.name === category.name)) {
          if (submissions.length === 2) unavailable = base;
          if (submissions.length === 3) unavailable = base + '/deleted';
          return Response.json({ code: reserved ? 'mark_category_id_conflict' : 'mark_category_name_taken' }, { status: 409 });
        }
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
    for (let count = 2; count <= 4; count++) {
      assert.equal(await store.importMarks(retry()), 0);
      assert.equal(store.state.failure, conflict);
      assert.equal(submissions.length, count, 'no implicit repeat after any refusal');
      assert.deepEqual(submissions.at(-1), submissions[0], 'retry keeps the original IDs and payload');
      assert.deepEqual(rows, []);
    }
    const replacement = retry();
    assert.equal(await store.importMarks(replacement), 1);
    assert.deepEqual(rows.map(mark => mark.id), [replacement.marks[0].id]);
    assert.equal(submissions.length, 5);
    assert.equal(store.state.undo.at(-1).type, 'import');
  });
}
