import assert from 'node:assert/strict';
import test from 'node:test';

import { createUtmProjection } from '../utm-conversion.mjs';
import {
  boundsKey,
  createParcelFetcher,
  expandLonLatBounds,
  groundHeightsConsistent,
  intersectLonLatBounds,
  lonLatToWebMercator,
  normalizeParcelResponse,
  parcelsToUtmPolylines,
  propertyLinesAvailability,
  propertyLinesMessage,
  propertyLinesRequestBounds,
  sampleGrid,
  snapLonLatBounds,
  utmExtentToLonLatBounds,
  verifiedUtmGeoref,
  webMercatorToLonLat,
  wisconsinCoverage,
} from '../property-lines.mjs';
import { createPropertyLinesController, drapePolylines, propertyLinesModeKind } from '../property-lines-layer.mjs';

const near = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
const box = (lon, lat, d = 0.004) => ({ west: lon - d, south: lat - d, east: lon + d, north: lat + d });

test('Web Mercator converts known coordinates both ways', () => {
  const [x0, y0] = lonLatToWebMercator(0, 0);
  near(x0, 0, 1e-9, 'origin x'); near(y0, 0, 1e-9, 'origin y');
  const [x180] = lonLatToWebMercator(180, 0);
  near(x180, 20037508.342789244, 1e-6, 'antimeridian');
  const [, y45] = lonLatToWebMercator(0, 45);
  near(y45, 5621521.486192066, 1e-6, '45 degrees north');
  // The state's parcel service extent (EPSG:3857) as published.
  const [west, south] = webMercatorToLonLat(-10340314.5255, 5234954.183799997);
  const [east, north] = webMercatorToLonLat(-9658524.2818, 5955260.2126);
  near(west, -92.8886258, 1e-6, 'west'); near(south, 42.4919220, 1e-6, 'south');
  near(east, -86.7639998, 1e-6, 'east'); near(north, 47.0807238, 1e-6, 'north');
  for (const [lon, lat] of [[-89.4012, 43.0731], [-87.9065, 43.0389], [-92.1, 46.72]]) {
    const [rlon, rlat] = webMercatorToLonLat(...lonLatToWebMercator(lon, lat));
    near(rlon, lon, 1e-10, 'round trip lon'); near(rlat, lat, 1e-10, 'round trip lat');
  }
});

test('parcel corners land on known UTM coordinates in the model zone', () => {
  const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  // On the zone 16 central meridian at 45 N: E 500000, N 4982950.40 (standard).
  const { lines } = parcelsToUtmPolylines([{ id: 1, rings: [[[-87, 45], [-87, 45.0001]]] }], projection.latLonToUtm, { densifyMeters: 0 });
  near(lines[0][0][0], 500000, 1e-6, 'easting'); near(lines[0][0][1], 4982950.40, 0.01, 'northing');
  near(lines[0][1][1] - lines[0][0][1], 11.11, 0.05, '0.0001 degree of latitude');
  // Densified edges keep their end points and add evenly spaced samples.
  const dense = parcelsToUtmPolylines([{ id: 1, rings: [[[-87, 45], [-87, 45.0001]]] }], projection.latLonToUtm, { densifyMeters: 2 });
  assert.equal(dense.lines[0].length, 6);
  near(dense.lines[0][5][1], lines[0][1][1], 1e-6, 'end kept');
  // Back to geographic through the model frame's inverse.
  const [lat, lon] = projection.utmToLatLon(500000, 4982950.40);
  near(lat, 45, 1e-7, 'lat'); near(lon, -87, 1e-9, 'lon');
});

test('UTM model extent becomes enclosing geographic bounds', () => {
  const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  const [e, n] = projection.latLonToUtm(43.0731, -89.4012);
  const bounds = utmExtentToLonLatBounds({ minE: e - 200, minN: n - 150, maxE: e + 200, maxN: n + 150 }, projection.utmToLatLon);
  assert.ok(bounds.west < -89.4012 && bounds.east > -89.4012 && bounds.south < 43.0731 && bounds.north > 43.0731);
  // 300 m of northing plus the rotation of a 400 m wide box (grid convergence).
  assert.ok(bounds.north - bounds.south > 300 / 111100 && bounds.north - bounds.south < 320 / 111000, `height ${bounds.north - bounds.south}`);
  assert.equal(utmExtentToLonLatBounds({ minE: 1, minN: 1, maxE: 1, maxN: 2 }, projection.utmToLatLon), null);
});

test('bounding boxes expand, intersect and snap outward', () => {
  const site = box(-89.4, 43.07, 0.002);
  const grown = expandLonLatBounds(site, 60);
  near(grown.north - site.north, 60 / 111320, 1e-9, 'north margin');
  near(site.west - grown.west, 60 / (111320 * Math.cos(43.07 * Math.PI / 180)), 1e-9, 'west margin');
  assert.equal(intersectLonLatBounds(box(-89.4, 43.07, 0.001), box(-88, 43, 0.001)), null);
  const snapped = snapLonLatBounds({ west: -89.40123, south: 43.07011, east: -89.39001, north: 43.07733 }, 50);
  assert.ok(snapped.west <= -89.40123 && snapped.south <= 43.07011 && snapped.east >= -89.39001 && snapped.north >= 43.07733);
  const [x] = lonLatToWebMercator(snapped.west, snapped.south);
  near(x / 50, Math.round(x / 50), 1e-3, 'on the 50 m grid');
  assert.equal(boundsKey(snapped).split(',').length, 4);
  // Small pans inside one grid cell reuse the same request.
  assert.equal(boundsKey(snapLonLatBounds(box(-89.40001, 43.07, 0.001))), boundsKey(snapLonLatBounds(box(-89.40002, 43.07, 0.001))));
});

test('requests cover the view clipped to the site, never more than the size limit', () => {
  const site = box(-89.4, 43.07, 0.003);
  const whole = propertyLinesRequestBounds({ modelBounds: site });
  assert.equal(whole.status, 'ok');
  assert.ok(whole.bounds.west < site.west && whole.bounds.east > site.east, 'margin included');
  const view = { west: -89.4005, south: 43.0695, east: -89.3995, north: 43.0705 };
  const clipped = propertyLinesRequestBounds({ modelBounds: site, viewBounds: view });
  assert.ok(clipped.bounds.east - clipped.bounds.west < whole.bounds.east - whole.bounds.west);
  const zoomedOut = propertyLinesRequestBounds({ modelBounds: site, viewBounds: box(-89.4, 43.07, 2) });
  assert.equal(boundsKey(zoomedOut.bounds), boundsKey(whole.bounds), 'whole-state view is still bounded by the site');
  assert.equal(propertyLinesRequestBounds({ modelBounds: site, viewBounds: box(-88, 44, 0.01) }).status, 'out_of_view');
  assert.equal(propertyLinesRequestBounds({ modelBounds: box(-89.4, 43.07, 0.05) }).status, 'too_many');
  assert.equal(propertyLinesRequestBounds({ modelBounds: null }).status, 'unknown');
});

test('Wisconsin bounds check offers in-state sites and refuses others', () => {
  for (const [lon, lat] of [[-89.40, 43.07], [-87.91, 43.04], [-92.10, 46.72], [-91.24, 43.81], [-92.76, 44.97], [-88.02, 44.51], [-90.19, 46.45], [-87.82, 42.58], [-91.14, 43.05]])
    assert.equal(wisconsinCoverage(box(lon, lat)), 'inside', `${lon},${lat}`);
  for (const [lon, lat] of [[-93.27, 44.98], [-87.63, 41.88], [-93.6, 41.6], [-87.40, 46.55], [-105, 40], [151.2, -33.9]])
    assert.equal(wisconsinCoverage(box(lon, lat)), 'outside', `${lon},${lat}`);
  assert.equal(wisconsinCoverage(null), 'unknown');
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: true, modelBounds: box(-93.27, 44.98) }), { available: false, reason: 'outside' });
  assert.equal(propertyLinesMessage('outside'), 'Not available for this location (Wisconsin only).');
});

test('only a verified, complete UTM georeference enables the layer', () => {
  const georef = { utmZoneLon0Deg: -87, hemisphere: 'N', rtc: { e: 300000, n: 4770000, z: 0 }, bboxCenter: { x: 1, y: 2, z: 3 } };
  const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  assert.equal(verifiedUtmGeoref(georef, projection), true);
  assert.equal(verifiedUtmGeoref({ ...georef, utmZoneLon0Deg: undefined }, projection), false);
  assert.equal(verifiedUtmGeoref({ ...georef, hemisphere: undefined }, projection), false);
  assert.equal(verifiedUtmGeoref({ ...georef, utmZoneLon0Deg: -88 }, null), false, 'not a zone meridian');
  assert.equal(verifiedUtmGeoref({ ...georef, rtc: undefined }, projection), false);
  assert.equal(verifiedUtmGeoref({ ...georef, bboxCenter: undefined }, projection), false);
  assert.equal(verifiedUtmGeoref(georef, createUtmProjection({ zoneLon0Deg: -93, hemisphere: 'N' })), false, 'projection must match');
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: false, modelBounds: null }), { available: false, reason: 'unverified' });
  assert.deepEqual(propertyLinesAvailability({ offered: false, georefVerified: true, modelBounds: box(-89.4, 43.07) }), { available: false, reason: 'not_offered' });
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: true, modelBounds: null }), { available: true, reason: 'pending' });
});

function fakeClock() {
  let now = 0, id = 0;
  const timers = new Map();
  return {
    setTimer(fn, ms) { const t = ++id; timers.set(t, { at: now + ms, fn }); return t; },
    clearTimer(t) { timers.delete(t); },
    async advance(ms) {
      now += ms;
      for (const [t, timer] of [...timers]) if (timer.at <= now) { timers.delete(t); timer.fn(); }
      await new Promise(resolve => setImmediate(resolve));
    },
    pending: () => timers.size,
  };
}

test('fetcher debounces, cancels stale requests and caches results', async () => {
  const clock = fakeClock();
  const calls = [];
  const fetchImpl = (url, options) => new Promise((resolve, reject) => {
    calls.push({ url, options });
    options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    calls.at(-1).resolve = body => resolve({ ok: true, status: 200, json: async () => body });
  });
  const fetcher = createParcelFetcher({ fetchImpl, debounceMs: 300, setTimer: clock.setTimer, clearTimer: clock.clearTimer, headers: () => ({ Authorization: 'Bearer test' }) });
  const a = box(-89.4, 43.07, 0.001), b = box(-89.39, 43.07, 0.001);
  // Rapid view changes: only the last one is requested.
  const first = fetcher.request(a), second = fetcher.request(b);
  await clock.advance(299);
  assert.equal(calls.length, 0, 'still debouncing');
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal((await first).status, 'aborted');
  assert.match(calls[0].url, /^\/api\/v1\/property-lines\/parcels\?bbox=-89\.391000%2C43\.069000%2C-89\.389000%2C43\.071000&model=$/);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test');
  // A newer request aborts the one in flight.
  const third = fetcher.request(a, { immediate: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true, 'stale network request cancelled');
  assert.equal((await second).status, 'aborted');
  calls[1].resolve({ status: 'ok', parcels: [{ id: 7, rings: [[[-89.4, 43.07], [-89.401, 43.07], [-89.401, 43.071]]] }] });
  const result = await third;
  assert.equal(result.status, 'ok');
  assert.equal(result.parcels.length, 1);
  // Same box again: served from memory, no request.
  const again = await fetcher.request(a, { immediate: true });
  assert.equal(again.parcels[0].id, 7);
  assert.equal(calls.length, 2);
  assert.equal(fetcher.stats().cacheHits, 1);
  fetcher.cancel();
  assert.equal(clock.pending(), 0);
});

test('fetcher reports unavailable, forbidden and too-many states and bounds its cache', async () => {
  const responses = [{ ok: false, status: 502 }, { ok: false, status: 403 }, { ok: true, status: 200, json: async () => ({ status: 'too_many', parcels: [] }) }];
  const fetcher = createParcelFetcher({ fetchImpl: async () => responses.shift(), debounceMs: 0, cacheEntries: 2 });
  assert.equal((await fetcher.request(box(-89.4, 43.07, 0.001))).status, 'unavailable');
  assert.equal((await fetcher.request(box(-89.3, 43.07, 0.001))).status, 'forbidden');
  assert.equal((await fetcher.request(box(-89.2, 43.07, 0.001))).status, 'too_many');
  const failing = createParcelFetcher({ fetchImpl: async () => { throw new TypeError('network'); }, debounceMs: 0 });
  assert.equal((await failing.request(box(-89.4, 43.07, 0.001))).status, 'unavailable');
  let n = 0;
  const counting = createParcelFetcher({ fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ status: 'none', parcels: [] }) }), debounceMs: 0, cacheEntries: 2 });
  for (const lon of [-89.1, -89.2, -89.3]) { await counting.request(box(lon, 43, 0.001)); n++; }
  assert.equal(counting.stats().cached, 2);
  assert.equal(n, 3);
});

test('parcel responses keep geometry only', () => {
  const result = normalizeParcelResponse({ status: 'ok', parcels: [
    { id: 1, rings: [[[-89.4, 43.07], [-89.41, 43.07], ['x', 1]]], OWNERNME1: 'someone', SITEADRESS: '1 Main St' },
    { id: 'bad', rings: [[[-89.4, 43.07]]] },
  ], owner: 'x' });
  assert.deepEqual(result, { status: 'ok', parcels: [{ id: 1, rings: [[[-89.4, 43.07], [-89.41, 43.07]]] }] });
  assert.deepEqual(normalizeParcelResponse({ status: 'weird' }), { status: 'unavailable', parcels: [] });
  assert.deepEqual(normalizeParcelResponse({ status: 'ok', parcels: [] }), { status: 'none', parcels: [] });
});

test('ground heights are sampled bilinearly and used only when they match the scene', () => {
  const grid = { values: Float32Array.from([100, 102, 104, 106]), width: 2, height: 2, minE: 0, maxN: 2, cellE: 1, cellN: 1, nodata: -9999 };
  near(sampleGrid(grid, 1, 1), 103, 1e-9, 'centre');
  near(sampleGrid(grid, 0.5, 1.5), 100, 1e-9, 'pixel centre');
  assert.ok(Number.isNaN(sampleGrid(grid, 5, 5)));
  assert.equal(groundHeightsConsistent([100, 101, 102], { minAlt: 95, maxAlt: 140 }), true);
  assert.equal(groundHeightsConsistent([100, 101, 102], { minAlt: 133, maxAlt: 170 }), false, 'about a geoid offset apart');
  assert.equal(groundHeightsConsistent([NaN, NaN, 100], { minAlt: 95, maxAlt: 140 }), false);
  const lines = [[[0.5, 1.5], [1, 1], [1.5, 0.5]]];
  const draped = drapePolylines(lines, { grid, minAlt: 99, maxAlt: 120, lift: 0 });
  assert.equal(draped.draped, true);
  assert.deepEqual(draped.lines[0].map(p => p[2]), [100, 103, 106]);
  const flat = drapePolylines(lines, { grid, minAlt: 300, maxAlt: 320, lift: 0 });
  assert.equal(flat.draped, false);
  assert.deepEqual(flat.lines[0].map(p => p[2]), [300, 300, 300]);
  assert.match(flat.note, /flat/);
  assert.match(drapePolylines(lines, { grid: null, minAlt: 10, maxAlt: 20 }).note, /No ground model/);
});

test('views map to the right drawing surface', () => {
  assert.equal(propertyLinesModeKind('ortho', 'potree'), 'map');
  assert.equal(propertyLinesModeKind('dtm', 'none'), 'map');
  assert.equal(propertyLinesModeKind('model', 'potree'), 'three');
  assert.equal(propertyLinesModeKind('cloud', 'direct'), 'three');
  assert.equal(propertyLinesModeKind('cloud', 'potree'), 'potree');
  assert.equal(propertyLinesModeKind(null, 'none'), null);
});

test('map redraws reuse one canvas renderer and never pile up layers', async () => {
  const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
  const [e, n] = projection.latLonToUtm(43.0745, -89.401);
  const layers = new Set(), panes = {};
  let view = { west: -89.4015, south: 43.0741, east: -89.4005, north: 43.0749 };
  const map = {
    getBounds: () => ({ getWest: () => view.west, getSouth: () => view.south, getEast: () => view.east, getNorth: () => view.north }),
    getPane: name => panes[name], createPane: name => (panes[name] = { style: {} }),
    hasLayer: layer => layers.has(layer), removeLayer: layer => { layers.delete(layer); layer.renderer && layer.renderer.attached--; },
  };
  let renderers = 0;
  const L = {
    canvas: () => { renderers++; return { attached: 0 }; },
    polyline: (rings, options) => ({ rings, options, renderer: options.renderer, addTo(target) { layers.add(this); this.renderer.attached++; return this; } }),
  };
  const fetchImpl = async url => ({ ok: true, status: 200, json: async () => url.includes('/parcels')
    ? { status: 'ok', parcels: [{ id: 1, rings: [[[-89.4012, 43.0742], [-89.4008, 43.0742], [-89.4008, 43.0746]]] }] }
    : { offered: true, source: { name: 'S', release: 'V', credit: 'C', disclaimer: 'D', datumNote: 'N' } } });
  const el = () => ({ hidden: false, textContent: '', dataset: {}, classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, querySelector: () => ({ textContent: '' }) });
  const controller = createPropertyLinesController({
    L, fetchImpl, headers: () => ({}), fetcherOptions: { debounceMs: 0 },
    dom: { panel: el(), button: el(), status: el(), about: el(), notice: el() },
    projectId: () => 'model-a', getMode: () => 'ortho', getCloudMode: () => 'none', getMap: () => map, getScene: () => null, getPotreeApi: () => null,
    georefVerified: () => true, getSceneExtentUtm: () => ({ minE: e - 100, minN: n - 80, maxE: e + 100, maxN: n + 80 }), getGroundGrid: async () => null,
    utmToLatLon: projection.utmToLatLon, latLonToUtm: projection.latLonToUtm, utmToWorld: () => null,
  });
  await controller.loadOffer();
  controller.toggle();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(controller.state.status, 'ready');
  const views = [view, { ...view }, { west: -89.4013, south: 43.0742, east: -89.4003, north: 43.0750 }, view, { west: -89.4020, south: 43.0738, east: -89.3995, north: 43.0752 }];
  for (let i = 0; i < 12; i++) {
    view = views[i % views.length];
    await controller.refresh();
  }
  assert.equal(renderers, 1, 'one canvas renderer for the map');
  assert.equal(layers.size, 2, 'outline and line only');
  assert.equal([...layers][0].renderer.attached, 2);
  controller.toggle();
  assert.equal(layers.size, 0);
});

test('an uploaded boundary is not limited to Wisconsin coverage', async () => {
  const { propertyLinesAvailability } = await import('../property-lines.mjs');
  const denver = { west: -104.992, south: 39.738, east: -104.989, north: 39.740 };
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: true, modelBounds: denver }), { available: false, reason: 'outside' });
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: true, modelBounds: denver, regionLimited: false }), { available: true, reason: null });
  assert.deepEqual(propertyLinesAvailability({ offered: true, georefVerified: false, modelBounds: denver, regionLimited: false }), { available: false, reason: 'unverified' });
});
