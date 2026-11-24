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

test('a shared refresh checks all pages and clears withdrawn or refused rows quietly', async () => {
  let current = list([clientPin], [clientCategory]);
  const reads = [];
  const store = createMarksStore({ request: async (path, init) => {
    reads.push([path, init.method]);
    if (path === base) return Response.json(ownList);
    if (path.endsWith('?after=page-2')) return Response.json(current);
    if (current instanceof Error) throw current;
    if (current === 'denied') return Response.json({ code: 'marks_unavailable' }, { status: 403 });
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
  current = list([clientPin], [clientCategory]);
  await store.refreshShared();
  assert.ok(store.find(clientPin.id));
  current = 'denied';
  await store.refreshShared();
  assert.deepEqual(store.state.marks, [owned]);
  assert.deepEqual(store.state.categories, []);
  assert.equal(store.state.message, 'Existing outcome');
  assert.equal(store.state.undo, undo);
  assert.equal(store.state.recoveredChange, recovered);
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
