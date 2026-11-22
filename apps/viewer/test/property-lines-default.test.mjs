// Property lines are shown by default on eligible maps. Synthetic controller
// checks with stubbed offers, parcels, map, 3D scene and Potree bridge: default
// visibility on every supported view, the per-project Hide (across views,
// reloads and projects), the safe states, and results from an older project,
// model version or access lifecycle being dropped.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { createUtmProjection } from '../utm-conversion.mjs';
import { createParcelFetcher } from '../property-lines.mjs';
import { PROPERTY_LINES_HIDDEN_KEY, createPropertyLinesController, createPropertyLinesPreferences } from '../property-lines-layer.mjs';

const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
const [E0, N0] = projection.latLonToUtm(43.0745, -89.401);
const PARCELS = { status: 'ok', parcels: [{ id: 1, rings: [[[-89.4012, 43.0742], [-89.4008, 43.0742], [-89.4008, 43.0746], [-89.4012, 43.0742]]] }] };
const OTHER_PARCELS = { status: 'ok', parcels: [{ id: 2, rings: [[[-89.4011, 43.0743], [-89.4009, 43.0743], [-89.4009, 43.0745]]] }] };
const OFFER = { offered: true, source: { name: 'Wisconsin Statewide Parcel Map', release: 'V12', credit: 'C', disclaimer: 'Not a survey.' } };
const VIEWS = [['ortho', 'none', 'map'], ['dsm', 'none', 'map'], ['dtm', 'none', 'map'], ['model', 'potree', 'three'], ['cloud', 'direct', 'three'], ['cloud', 'potree', 'potree']];

const flush = async (rounds = 8) => { for (let i = 0; i < rounds; i++) await new Promise(resolve => setImmediate(resolve)); };
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), removeItem: key => data.delete(key) };
}

function el() {
  const node = { textContent: '', dataset: {}, disabled: false, attrs: {}, writes: 0, _hidden: false, listeners: [],
    classList: { toggle() {} }, setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(type, fn) { this.listeners.push(fn); },
    click() { for (const fn of this.listeners) fn(); }, querySelector: () => ({ textContent: '' }) };
  Object.defineProperty(node, 'hidden', { get() { return this._hidden; }, set(value) { this.writes++; this._hidden = value; } });
  return node;
}

// One Viewer page. `offer(project, version)` and `parcels(project, url)` return a reply or a promise of one.
function page({ project = 'model-a', version = 'v1', mode = 'ortho', cloudMode = 'none', storage = memoryStorage(), georef = true,
  offer = () => reply(OFFER), parcels = () => reply(PARCELS), potreeReady = true, sceneReady = true } = {}) {
  const ctx = { project, version, mode, cloudMode, georef, potreeReady, sceneReady, offer, parcels, requests: [], offers: [], potreeCalls: 0 };
  const layers = new Set(), panes = {};
  ctx.map = {
    getBounds: () => ({ getWest: () => -89.4015, getSouth: () => 43.0741, getEast: () => -89.4005, getNorth: () => 43.0749 }),
    getPane: name => panes[name], createPane: name => (panes[name] = { style: {} }),
    hasLayer: layer => layers.has(layer), removeLayer: layer => layers.delete(layer),
  };
  const L = { canvas: () => ({}), polyline: (rings, options) => ({ rings, options, addTo(target) { layers.add(this); return this; } }) };
  ctx.scene = new THREE.Scene();
  ctx.potree = { lines: null, visible: false,
    setParcelLines(lines) { this.lines = lines; return lines.length; }, setParcelVisibility(value) { this.visible = Boolean(value); } };
  ctx.dom = { panel: el(), button: el(), status: el(), about: el(), notice: el() };
  ctx.dom.panel._hidden = true; ctx.dom.notice._hidden = true; ctx.dom.about._hidden = true;
  ctx.storage = storage;
  ctx.fetchImpl = async url => {
    if (url.startsWith('/api/v1/property-lines/parcels')) { ctx.requests.push({ project: ctx.project, url }); return ctx.parcels(ctx.project, url); }
    ctx.offers.push(ctx.project);
    return ctx.offer(ctx.project, ctx.version);
  };
  ctx.controller = createPropertyLinesController({
    L, THREE, LineSegments2, LineSegmentsGeometry, LineMaterial, fetchImpl: (...args) => ctx.fetchImpl(...args), headers: () => ({}),
    fetcherOptions: { debounceMs: 0 }, storage, dom: ctx.dom,
    projectId: () => ctx.project, projectVersion: () => ctx.version, getMode: () => ctx.mode, getCloudMode: () => ctx.cloudMode,
    getMap: () => ctx.map, getScene: () => ctx.scene, getPotreeApi: () => { ctx.potreeCalls++; return ctx.potreeReady ? ctx.potree : null; },
    georefVerified: () => ctx.georef,
    getSceneExtentUtm: () => (!ctx.sceneReady ? null : ['ortho', 'dsm', 'dtm'].includes(ctx.mode)
      ? { minE: E0 - 100, minN: N0 - 80, maxE: E0 + 100, maxN: N0 + 80 }
      : { minE: E0 - 100, minN: N0 - 80, maxE: E0 + 100, maxN: N0 + 80, minAlt: 250, maxAlt: 280 }),
    getGroundGrid: async () => null,
    utmToLatLon: projection.utmToLatLon, latLonToUtm: projection.latLonToUtm,
    utmToWorld: (e, n, alt) => new THREE.Vector3(e - E0, alt, -(n - N0)),
  });
  ctx.layers = layers;
  ctx.view = async (nextMode, nextCloud = ctx.cloudMode) => { ctx.mode = nextMode; ctx.cloudMode = nextCloud; await ctx.controller.refresh(); await flush(); };
  ctx.drawn = () => {
    const group = ctx.scene.getObjectByName('property-lines');
    return { map: layers.size, three: Boolean(group?.visible), potree: ctx.potree.visible && Array.isArray(ctx.potree.lines) && ctx.potree.lines.length > 0 };
  };
  ctx.nothingDrawn = () => assert.deepEqual(ctx.drawn(), { map: 0, three: false, potree: false });
  return ctx;
}

async function open(ctx) { await ctx.controller.loadOffer(); await flush(); return ctx; }

function assertShownOn(ctx, surface) {
  const drawn = ctx.drawn();
  assert.equal(ctx.controller.state.status, 'ready', `${ctx.mode}/${ctx.cloudMode} ready`);
  if (surface === 'map') assert.equal(drawn.map, 2, 'halo and line on the map');
  else assert.equal(drawn.map, 0);
  assert.equal(drawn.three, surface === 'three');
  assert.equal(drawn.potree, surface === 'potree');
  assert.equal(ctx.dom.panel.hidden, false);
  assert.equal(ctx.dom.notice.hidden, false, 'notice shown with drawn lines');
  assert.equal(ctx.dom.button.attrs['aria-pressed'], 'true');
  assert.equal(ctx.dom.button.textContent, 'Hide');
}

function assertQuiet(ctx) {
  ctx.nothingDrawn();
  assert.equal(ctx.dom.notice.hidden, true, 'no notice');
  assert.equal(ctx.dom.about.hidden, true, 'no source note');
}

test('default on: an authorized offer shows the lines on every supported view without a click', async () => {
  for (const [mode, cloudMode, surface] of VIEWS) {
    const ctx = await open(page({ mode, cloudMode }));
    assertShownOn(ctx, surface);
    assert.equal(ctx.controller.state.hidden, false);
  }
});

test('default on: one page moving through every view keeps the lines without refetching the offer', async () => {
  const ctx = await open(page());
  for (const [mode, cloudMode, surface] of [...VIEWS, ...VIEWS.slice().reverse()]) {
    await ctx.view(mode, cloudMode);
    assertShownOn(ctx, surface);
  }
  assert.deepEqual(ctx.offers, ['model-a'], 'view changes never ask for access again');
});

test('hide persists across view changes in the same project', async () => {
  const ctx = await open(page());
  ctx.dom.button.click();
  await flush();
  assertQuiet(ctx);
  assert.equal(ctx.dom.button.textContent, 'Show');
  const parcelRequests = ctx.requests.length;
  for (const [mode, cloudMode] of VIEWS) {
    await ctx.view(mode, cloudMode);
    assertQuiet(ctx);
    assert.equal(ctx.controller.state.hidden, true, `${mode}/${cloudMode} stays hidden`);
    assert.equal(ctx.dom.button.attrs['aria-pressed'], 'false');
  }
  assert.equal(ctx.requests.length, parcelRequests, 'nothing fetched while hidden');
  assert.deepEqual(ctx.offers, ['model-a']);
  ctx.dom.button.click();
  await flush();
  assertShownOn(ctx, 'potree');
});

test('hide survives a reload through the preference store; a blocked store still keeps it for the page', async () => {
  const storage = memoryStorage();
  const first = await open(page({ storage }));
  first.dom.button.click();
  await flush();
  assert.equal(storage.getItem(PROPERTY_LINES_HIDDEN_KEY), JSON.stringify(['model-a']));

  const reloaded = await open(page({ storage, mode: 'model', cloudMode: 'potree' }));
  assert.equal(reloaded.controller.state.hidden, true);
  assertQuiet(reloaded);
  assert.equal(reloaded.dom.panel.hidden, false, 'the toggle is still there');
  assert.equal(reloaded.dom.button.textContent, 'Show');
  assert.equal(reloaded.requests.length, 0, 'no parcels fetched for a hidden layer');

  reloaded.dom.button.click();
  await flush();
  assert.equal(storage.getItem(PROPERTY_LINES_HIDDEN_KEY), null, 'Show clears the remembered Hide');
  assertShownOn(reloaded, 'three');

  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } };
  const ctx = await open(page({ storage: blocked }));
  assertShownOn(ctx, 'map');
  ctx.dom.button.click();
  await ctx.view('model', 'potree');
  assert.equal(ctx.controller.state.hidden, true);
  assertQuiet(ctx);

  const prefs = createPropertyLinesPreferences(memoryStorage({ [PROPERTY_LINES_HIDDEN_KEY]: '{not json' }));
  assert.equal(prefs.hidden('model-a'), false, 'a damaged value reads as no preference');
});

test('a project change resets to that project default and never carries a Hide across', async () => {
  const storage = memoryStorage();
  const ctx = await open(page({ storage }));
  ctx.dom.button.click();
  await flush();
  assertQuiet(ctx);

  ctx.project = 'model-b';
  await ctx.controller.loadOffer();
  await flush();
  assert.equal(ctx.controller.state.hidden, false, 'B starts at its default');
  assertShownOn(ctx, 'map');
  assert.ok(ctx.requests.at(-1).url.endsWith('&model=model-b'));
  assert.deepEqual(JSON.parse(storage.getItem(PROPERTY_LINES_HIDDEN_KEY)), ['model-a'], 'B never stored');

  // A project change seen first by a view refresh asks for the new project's offer itself.
  ctx.project = 'model-c';
  await ctx.view('model', 'potree');
  await flush();
  assert.deepEqual(ctx.offers, ['model-a', 'model-b', 'model-c']);
  assertShownOn(ctx, 'three');

  // A fresh page on B after A was hidden: B is visible.
  const other = await open(page({ storage, project: 'model-b' }));
  assertShownOn(other, 'map');
});

test('no offer, unauthorized, unverified, unsupported view or load errors: nothing appears and nothing throws', async () => {
  const cases = {
    'not offered': page({ offer: () => reply({ offered: false }) }),
    'offer 403': page({ offer: () => reply({ error: 'forbidden' }, 403) }),
    'offer network failure': page({ offer: async () => { throw new TypeError('network'); } }),
    'offer bad json': page({ offer: () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad'); } }) }),
    'unverified georeference': page({ georef: false }),
  };
  for (const [label, ctx] of Object.entries(cases)) {
    await open(ctx);
    assert.equal(ctx.dom.panel.hidden, true, `${label}: panel stays hidden`);
    assertQuiet(ctx);
    assert.equal(ctx.requests.length, 0, `${label}: no parcels fetched`);
    for (const [mode, cloudMode] of VIEWS) await ctx.view(mode, cloudMode);
    assertQuiet(ctx);
    assert.equal(ctx.requests.length, 0);
  }
  assert.equal(cases['unverified georeference'].offers.length, 0, 'no offer request without a verified georeference');

  for (const [label, parcels, state] of [['parcels 403', () => reply({}, 403), 'forbidden'], ['parcels 502', () => reply({}, 502), 'unavailable'], ['parcels throw', async () => { throw new TypeError('network'); }, 'unavailable']]) {
    const ctx = await open(page({ parcels }));
    assert.equal(ctx.controller.state.status, state, label);
    assertQuiet(ctx);
  }

  for (const [mode, cloudMode] of [['cloud', 'none'], [null, 'none'], ['unknown', 'potree']]) {
    const ctx = await open(page({ mode, cloudMode }));
    assert.equal(ctx.controller.state.status, 'idle', `${mode}/${cloudMode}`);
    assertQuiet(ctx);
    assert.equal(ctx.dom.status.textContent, '', 'no message on a view without a drawing surface');
    assert.equal(ctx.requests.length, 0);
    assert.equal(ctx.controller.state.retries, 0, 'no retry loop on an unsupported view');
  }
});

test('a late offer for project A after the switch to B and B denial shows nothing for B', async () => {
  const lateA = deferred();
  const ctx = page({ offer: project => (project === 'model-a' ? lateA.promise : reply({ offered: false })) });
  const pendingA = ctx.controller.loadOffer();
  await flush();
  ctx.project = 'model-b';
  await ctx.controller.loadOffer();
  await flush();
  assert.equal(ctx.dom.panel.hidden, true, 'B denied');
  const writes = { panel: ctx.dom.panel.writes, notice: ctx.dom.notice.writes, status: ctx.dom.status.textContent, button: { ...ctx.dom.button.attrs } };

  lateA.resolve(reply(OFFER));
  await pendingA;
  await flush();
  assert.equal(ctx.controller.state.offered, false, 'A offer dropped');
  assert.equal(ctx.dom.panel.hidden, true);
  assertQuiet(ctx);
  assert.deepEqual({ panel: ctx.dom.panel.writes, notice: ctx.dom.notice.writes, status: ctx.dom.status.textContent, button: ctx.dom.button.attrs },
    writes, 'no render at all for the stale answer');
  assert.equal(ctx.requests.length, 0, 'no parcels fetched for A or B');
  for (const [mode, cloudMode] of VIEWS) await ctx.view(mode, cloudMode);
  assertQuiet(ctx);
  assert.equal(ctx.requests.length, 0);
});

test('late parcels for project A are never drawn on project B', async () => {
  const lateA = deferred();
  const ctx = page({ parcels: project => (project === 'model-a' ? lateA.promise : reply(OTHER_PARCELS)) });
  void ctx.controller.loadOffer();
  await flush();
  assert.equal(ctx.controller.state.status, 'loading');
  ctx.project = 'model-b';
  await ctx.controller.loadOffer();
  await flush();
  assertShownOn(ctx, 'map');
  lateA.resolve(reply(PARCELS));
  await flush();
  const [halo] = ctx.layers;
  assert.deepEqual(halo.rings, [OTHER_PARCELS.parcels[0].rings[0].map(([lon, lat]) => [lat, lon])], 'B keeps its own parcels');
  assert.equal(ctx.controller.state.count, 1);
});

test('access revoked and restored: lines drop with no notice, then return; Hide is kept', async () => {
  const ctx = await open(page({ mode: 'cloud', cloudMode: 'potree' }));
  assertShownOn(ctx, 'potree');
  ctx.controller.suspend();
  assert.equal(ctx.dom.panel.hidden, true);
  assertQuiet(ctx);
  for (const [mode, cloudMode] of VIEWS) await ctx.view(mode, cloudMode);
  await ctx.controller.wake();
  assertQuiet(ctx);
  assert.equal(ctx.dom.panel.hidden, true, 'readiness never wakes a revoked layer');

  await ctx.controller.resume();
  await flush();
  assert.deepEqual(ctx.offers, ['model-a', 'model-a'], 'offer asked again under the restored access');
  assertShownOn(ctx, 'potree');

  ctx.dom.button.click();
  ctx.controller.suspend();
  await ctx.controller.resume();
  await flush();
  assert.equal(ctx.controller.state.hidden, true, 'Hide survives revocation and recovery');
  assertQuiet(ctx);
  assert.equal(ctx.dom.panel.hidden, false);

  // Recovery that is denied keeps everything hidden.
  const denied = await open(page());
  denied.offer = () => reply({ error: 'forbidden' }, 403);
  denied.controller.suspend();
  await denied.controller.resume();
  await flush();
  assert.equal(denied.dom.panel.hidden, true);
  assertQuiet(denied);
});

test('an offer that was in flight when access was revoked is dropped', async () => {
  const late = deferred();
  const ctx = page({ offer: () => late.promise });
  const pending = ctx.controller.loadOffer();
  await flush();
  ctx.controller.suspend();
  late.resolve(reply(OFFER));
  await pending;
  await flush();
  assert.equal(ctx.controller.state.offered, false);
  assert.equal(ctx.dom.panel.hidden, true);
  assertQuiet(ctx);
  assert.equal(ctx.requests.length, 0);
});

test('same project, new model version: offer and parcels are fetched again; Hide is kept', async () => {
  const ctx = await open(page());
  assertShownOn(ctx, 'map');
  const firstUrl = ctx.requests[0].url;
  ctx.version = 'v2';
  await ctx.controller.refresh();
  await flush();
  assert.deepEqual(ctx.offers, ['model-a', 'model-a'], 'a new version asks for its own offer');
  assertShownOn(ctx, 'map');
  assert.equal(ctx.requests.length, 2, 'cache from the old version not reused');
  assert.equal(ctx.requests[1].url, firstUrl, 'same box, fetched again');

  ctx.dom.button.click();
  ctx.version = 'v3';
  await ctx.controller.refresh();
  await flush();
  assert.equal(ctx.controller.state.hidden, true, 'Hide follows the project, not the version');
  assertQuiet(ctx);

  // The new version is denied: nothing from the old version stays drawn.
  const denied = await open(page({ mode: 'model', cloudMode: 'potree' }));
  assertShownOn(denied, 'three');
  denied.offer = () => reply({ offered: false });
  denied.version = 'v2';
  await denied.controller.refresh();
  await flush();
  assert.equal(denied.dom.panel.hidden, true);
  assertQuiet(denied);
});

test('authority reset with the same model and box: the old body is neither drawn nor cached', async () => {
  const old = deferred();
  let phase = 'old';
  const ctx = page({ parcels: () => (phase === 'old' ? old.promise : phase === 'denied' ? reply({}, 403) : reply({ status: 'none', parcels: [] })) });
  void ctx.controller.loadOffer();
  await flush();
  assert.equal(ctx.requests.length, 1);
  ctx.controller.suspend();
  phase = 'denied';
  await ctx.controller.resume();
  await flush();
  assert.equal(ctx.requests.length, 2, 'the new context makes its own request');
  assert.equal(ctx.requests[1].url, ctx.requests[0].url, 'same model and box');
  assert.equal(ctx.controller.state.status, 'forbidden');
  old.resolve(reply(PARCELS));
  await flush();
  assertQuiet(ctx);
  assert.equal(ctx.controller.state.status, 'forbidden');

  phase = 'none';
  ctx.controller.suspend();
  await ctx.controller.resume();
  await flush();
  assert.equal(ctx.requests.length, 3, 'the old body was never cached');
  assert.equal(ctx.controller.state.status, 'none');
  assertQuiet(ctx);
});

test('fetcher: clear() keeps an in-flight response out of the cache and out of the result', async () => {
  const late = deferred();
  const calls = [];
  const fetcher = createParcelFetcher({ fetchImpl: async url => { calls.push(url); return calls.length === 1 ? late.promise : reply(OTHER_PARCELS); }, model: () => 'model-a', debounceMs: 0 });
  const bounds = { west: -89.402, south: 43.074, east: -89.400, north: 43.075 };
  const first = fetcher.request(bounds);
  await flush();
  fetcher.clear();
  late.resolve(reply(PARCELS));
  assert.equal((await first).status, 'aborted');
  assert.equal(fetcher.stats().cached, 0, 'stale body not admitted');
  const next = await fetcher.request(bounds);
  assert.equal(next.parcels[0].id, 2, 'fresh response for the new context');
  assert.equal(calls.length, 2);
  assert.equal(fetcher.stats().cached, 1);
});

test('pending retries stay bounded across refreshes; real readiness wakes the layer without touching Hide', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const ctx = page({ mode: 'cloud', cloudMode: 'potree', potreeReady: false });
  await open(ctx);
  assert.equal(ctx.controller.state.status, 'pending');
  for (let i = 0; i < 120; i++) { mock.timers.tick(1500); await flush(2); }
  const attempts = ctx.potreeCalls;
  assert.ok(attempts <= 42, `bounded: ${attempts} attempts`);
  assert.equal(ctx.controller.state.retries, 40);
  // Map moves or other plain refreshes do not refill the budget.
  for (let i = 0; i < 5; i++) await ctx.controller.refresh();
  for (let i = 0; i < 20; i++) { mock.timers.tick(1500); await flush(2); }
  assert.equal(ctx.potreeCalls, attempts + 5, 'no timer-driven retries after exhaustion');
  assertQuiet(ctx);

  ctx.potreeReady = true;
  await ctx.controller.wake();
  await flush();
  assertShownOn(ctx, 'potree');

  // Readiness after a Hide stays hidden.
  ctx.dom.button.click();
  await ctx.controller.wake();
  await flush();
  assert.equal(ctx.controller.state.hidden, true);
  assertQuiet(ctx);
});

test('3D scene not ready: bounded wait, then the mesh or cloud readiness signal draws it', async t => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const ctx = page({ mode: 'model', cloudMode: 'potree', sceneReady: false });
  await open(ctx);
  assert.equal(ctx.controller.state.status, 'pending');
  assertQuiet(ctx);
  for (let i = 0; i < 60; i++) { mock.timers.tick(1500); await flush(2); }
  assert.equal(ctx.controller.state.retries, 40);
  ctx.sceneReady = true;
  await ctx.controller.wake();
  await flush();
  assertShownOn(ctx, 'three');
});
