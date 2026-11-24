import assert from 'node:assert/strict';
import test from 'node:test';
import { createMarksStore } from '../viewer-marks-store.mjs';
import { mountViewerMarks } from '../viewer-marks.mjs';
import { createMiniDocument } from './helpers/mini-dom.mjs';
import { createMiniLeaflet } from './helpers/mini-leaflet.mjs';

const base = '/api/v1/marks';
const scope = key => ({ mode: 'session', key, token: () => key });
const mark = (id, mine = false) => ({
  id, name: id, mine, editable: mine, color: '#1565c0', visibility: mine ? 'private' : 'staff',
  geometry: { type: 'Point', coordinates: [-87, 43] }, revision: 1,
});
const owned = mark('owned', true), clientPin = { ...mark('client-pin'), categoryId: 'client-category' };
const clientCategory = { id: 'client-category', name: 'Client category', mine: false };
const ownList = {
  marks: [owned], categories: [], capabilities: { write: true, staff: true, visibility: ['private'], shared: true },
};
const list = (marks = [], categories = [], next = null) => ({ marks, categories, next });

test('a shared refresh checks all pages and quietly clears withdrawn rows', async () => {
  let current = list([clientPin], [clientCategory]);
  const reads = [];
  const store = createMarksStore({ request: async (path, init) => {
    reads.push([path, init.method]);
    if (path === base) return Response.json(ownList);
    if (path.endsWith('?after=page-2')) return Response.json(current);
    if (current instanceof Error) throw current;
    return Response.json(list([], [], 'page-2'));
  } });
  await store.setScope(scope('staff'));
  assert.ok(store.find(clientPin.id));
  store.state.message = 'Existing outcome';
  const undo = store.state.undo;
  const recovered = store.state.recoveredChange = { at: 1, done: 'Existing recovery' };
  current = new Error('temporary network failure');
  await store.refreshShared();
  assert.ok(store.find(clientPin.id));
  current = list();
  reads.length = 0;
  await store.refreshShared();
  assert.deepEqual(reads, [[base + '/shared', 'GET'], [base + '/shared?after=page-2', 'GET']]);
  assert.deepEqual(store.state.marks, [owned]);
  assert.deepEqual(store.state.categories, []);
  assert.equal(store.state.message, 'Existing outcome');
  assert.equal(store.state.undo, undo);
  assert.equal(store.state.recoveredChange, recovered);
});

test('a later shared page failure keeps only the newly confirmed prefix and the owned list', async () => {
  const nextPin = mark('new-client-pin');
  let next = false;
  const store = createMarksStore({ request: async path => {
    if (path === base) return Response.json(ownList);
    if (!next) return Response.json(list([clientPin], [clientCategory]));
    if (path.endsWith('?after=page-2')) return Response.json({ code: 'retry_later' }, { status: 503 });
    return Response.json(list([nextPin], [], 'page-2'));
  } });
  await store.setScope(scope('staff'));
  next = true;
  await store.refreshShared();
  assert.deepEqual(store.state.marks, [owned, nextPin]);
  assert.deepEqual(store.state.categories, []);
  assert.match(store.state.message, /Some shared marks could not be loaded/);
  assert.equal(store.canWrite(), true);
});

test('a timeout on a later shared page keeps the confirmed prefix', async () => {
  const nextPin = mark('confirmed-before-timeout');
  let next = false, expire, pending;
  const store = createMarksStore({
    later: work => { expire = work; return () => {}; },
    request: async path => {
      if (path === base) return Response.json(ownList);
      if (!next) return Response.json(list([clientPin], [clientCategory]));
      if (path.endsWith('?after=page-2')) {
        pending();
        return new Promise(() => {});
      }
      return Response.json(list([nextPin], [], 'page-2'));
    },
  });
  await store.setScope(scope('staff'));
  next = true;
  const reachedLaterPage = new Promise(resolve => { pending = resolve; });
  const refreshing = store.refreshShared();
  await reachedLaterPage;
  expire();
  await refreshing;
  assert.deepEqual(store.state.marks, [owned, nextPin]);
  assert.match(store.state.message, /Some shared marks could not be loaded/);
});

test('explicit access or identity refusal clears owned controls and every row, including an earlier shared page', async () => {
  for (const code of ['marks_unavailable', 'mark_identity_required']) {
    let refused = false, lost = 0;
    const capabilities = { ...ownList.capabilities, visibility: ['private', 'client'] };
    const store = createMarksStore({ onViewerAccessLost: () => {
      assert.equal(store.state.ready, false);
      lost++;
    }, request: async (path, init) => {
      if (path === base && init.method === 'GET') return Response.json({ ...ownList, capabilities });
      if (path === base && init.method === 'POST') return Response.json({ mark: mark('new-owned', true) }, { status: 201 });
      if (path === base + '/audiences') return Response.json({ audiences: [{ id: 'client' }] });
      if (path === base + '/deleted') return Response.json({ marks: [mark('deleted-owned', true)] });
      if (path.endsWith('?after=page-2')) return Response.json({ code }, { status: 403 });
      return Response.json(list([clientPin], [clientCategory], refused ? 'page-2' : null));
    } });
    await store.setScope(scope('staff'));
    await store.create({ ...owned, id: 'new-owned' });
    await store.loadDeleted();
    assert.equal(store.state.audiences.length, 1);
    assert.equal(store.state.deleted.length, 1);
    assert.equal(store.state.undo.length, 1);
    refused = true;
    await store.refreshShared();
    const { ready, marks, categories, audiences, deleted, undo, recoveredChange, message, failure } = store.state;
    assert.deepEqual({ ready, marks, categories, audiences, deleted, undo, recoveredChange, failure },
      { ready: false, marks: [], categories: [], audiences: [], deleted: [], undo: [], recoveredChange: null, failure: code });
    assert.match(message, /hidden until access is restored/);
    assert.equal(store.canWrite(), false);
    assert.equal(lost, code === 'marks_unavailable' ? 1 : 0);
    refused = false;
    await store.setScope(scope('staff'));
    assert.deepEqual(store.state.marks, [owned, clientPin]);
    assert.equal(store.canWrite(), true);
  }
});

test('Viewer access loss is reported even when the initial Marks list was never available', async () => {
  let lost = 0;
  const store = createMarksStore({ onViewerAccessLost: () => { lost++; },
    request: async () => Response.json({ code: 'marks_unavailable' }, { status: 403 }) });
  await store.setScope(scope('staff'));
  assert.equal(store.state.ready, false);
  assert.match(store.state.message, /unavailable for this session/);
  assert.equal(lost, 1);
});

test('a shared read cannot overwrite a write or reappear after a scope change', async () => {
  let held, signal, holdNext = false;
  const store = createMarksStore({ request: async (path, init) => {
    if (path === base) {
      if (init.method !== 'POST') return Response.json(ownList);
      return Response.json({ mark: mark(JSON.parse(init.body).id, true) }, { status: 201 });
    }
    if (holdNext) {
      holdNext = false;
      signal = init.signal;
      return new Promise(resolve => { held = resolve; });
    }
    return Response.json(list([clientPin], [clientCategory]));
  } });
  await store.setScope(scope('staff'));
  // The delayed transport intentionally ignores abort after it has accepted the first page.
  holdNext = true;
  const reading = store.refreshShared();
  const settle = held;
  await store.create({ ...owned, id: 'independent-write' });
  assert.equal(signal.aborted, true);
  settle(Response.json(list([mark('stale-row')])));
  await reading;
  assert.ok(store.find('independent-write'));
  assert.equal(store.find('stale-row'), null);

  holdNext = true;
  const priorScope = store.refreshShared();
  const settlePrior = held;
  await store.setScope({ mode: 'temporary', key: 'public' });
  assert.equal(signal.aborted, true);
  settlePrior(Response.json(list([mark('stale-scope-row')])));
  await priorScope;
  await store.refreshShared();
  assert.deepEqual(store.state.marks, []);
});

test('Marks rechecks on a foreground timer and focus, skipping hidden and public views', async () => {
  const { document, window } = createMiniDocument();
  const leaflet = createMiniLeaflet(document);
  const panel = document.createElement('div');
  const timers = new Map();
  let nextTimer = 0, shared = [clientPin], requests = 0;
  document.visibilityState = 'visible';
  window.setTimeout = (fire, ms) => { timers.set(++nextTimer, { fire, ms }); return nextTimer; };
  window.clearTimeout = id => timers.delete(id);
  const marks = mountViewerMarks({
    panel, L: leaflet.L, getMap: () => leaflet.map,
    request: async path => {
      requests++;
      return Response.json(path === base ? ownList : list(shared));
    },
  });
  try {
    marks.setView({ map: true });
    await marks.setScope(scope('staff'));
    assert.ok(marks.store.find(clientPin.id));
    assert.equal(timers.size, 1);
    const [[id, { fire, ms }]] = timers;
    assert.equal(ms, 30_000);
    shared = [];
    timers.delete(id);
    fire();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(marks.store.find(clientPin.id), null);

    document.visibilityState = 'hidden';
    await document.fire('visibilitychange');
    const previously = requests;
    await window.fire('focus');
    assert.equal(requests, previously);
    assert.equal(timers.size, 0);
    shared = [clientPin];
    document.visibilityState = 'visible';
    await window.fire('focus');
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(marks.store.find(clientPin.id));

    await marks.setScope({ mode: 'temporary', key: 'public' });
    await window.fire('focus');
    assert.equal(requests, previously + 1);
    assert.equal(timers.size, 0);
  } finally {
    marks.dispose();
  }
});
