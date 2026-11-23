import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CONTOUR_WORKER_UNAVAILABLE, VIEW_MAX_POINTS, createContourController, createContourWorkerClient, dtmVerticalScale } from '../contour-layer.mjs';
import { METERS_PER_FOOT } from '../contours.mjs';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));

function element(tag = 'div') {
  const listeners = {};
  return {
    tag, hidden: false, value: '', textContent: '', children: [], attributes: {},
    classList: { toggle() {} },
    setAttribute(k, v) { this.attributes[k] = String(v); },
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); },
    dispatch(type) { for (const fn of listeners[type] || []) fn(); },
    replaceChildren(...nodes) { this.children = nodes; },
  };
}

function fixture({ units = 'imperial', mode = 'ortho', dtm = true, verticalScale, compute } = {}) {
  const documentRef = { createElement: element };
  const dom = { panel: element(), button: element('button'), interval: element('select'), color: element('select'), status: element('p') };
  const reads = [], computes = [], layers = [];
  // 100 m x 100 m DTM at 0.5 m, a plane rising 0.2 m per metre east from 230 m.
  const image = (w) => ({
    getWidth: () => w, getHeight: () => w,
    async readRasters({ window, width, height }) {
      reads.push({ w, window, width, height });
      const out = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) out[y * width + x] = 230 + 0.2 * (window[0] + (x + 0.5) * (window[2] - window[0]) / width) * (100 / w);
      return [out];
    },
  });
  const ds = { minE: 0, maxE: 100, minN: 0, maxN: 100, nodata: -9999, min: 230, max: 250, images: [image(200), image(100), image(50)] };
  const map = {
    layers: new Set(),
    hasLayer(l) { return this.layers.has(l); }, removeLayer(l) { this.layers.delete(l); },
    getSize: () => ({ x: 800, y: 600 }),
    getBounds: () => ({ getNorthWest: () => ({ lat: 80, lng: 20 }), getNorthEast: () => ({ lat: 80, lng: 60 }), getSouthWest: () => ({ lat: 50, lng: 20 }), getSouthEast: () => ({ lat: 50, lng: 60 }) }),
  };
  class Layer {
    constructor() { layers.push(this); this.data = []; }
    setData(features, colors) { this.data = features; this.colors = colors; return this; }
    setColors(colors) { this.colors = colors; return this; }
    addTo(m) { m.layers.add(this); return this; }
  }
  const exportComputes = [];
  const result = (data) => [{ value: data.levels[0].value, label: data.levels[0].label, isIndex: data.levels[0].isIndex, coords: new Float64Array(4), latLng: new Float64Array(4) }];
  const worker = { compute: async (data) => { computes.push(data); if (compute) return compute(data); return result(data); } };
  const exportWorker = { compute: async (data) => { exportComputes.push(data); return result(data); } };
  const env = { units, mode, dtm };
  const controller = createContourController({
    L: {}, documentRef, dom, Layer, worker, exportWorker, debounceMs: 0, ...(verticalScale ? { verticalScale } : {}),
    getMap: () => map, isMapMode: () => ['ortho', 'dsm', 'dtm'].includes(env.mode), hasDtm: () => env.dtm,
    getDtm: async () => ds, units: () => env.units, projection: () => ({ zoneLon0Deg: -87, hemisphere: 'N' }),
    latLonToUtm: (lat, lng) => [lng, lat],
  });
  return { controller, dom, map, reads, computes, exportComputes, layers, env };
}

test('panel shows only in map modes with a DTM; Show traces the visible area, Hide removes the overlay', async () => {
  const f = fixture({ mode: 'model' });
  f.controller.refresh();
  assert.equal(f.dom.panel.hidden, true);
  f.env.mode = 'ortho'; f.controller.refresh();
  assert.equal(f.dom.panel.hidden, false);
  assert.equal(f.dom.button.textContent, 'Show');
  f.dom.button.dispatch('click'); await tick();
  assert.equal(f.dom.button.attributes['aria-pressed'], 'true');
  assert.equal(f.dom.button.textContent, 'Hide');
  assert.equal(f.computes.length, 1);
  const read = f.reads[0];
  // View 40 m wide on 800 px: 0.05 m/px, target 0.1 m: finest level (0.5 m cells).
  assert.equal(read.w, 200);
  assert.deepEqual(read.window, [20, 25, 140, 115], 'view plus a 25% margin each side, in 0.5 m cells');
  assert.ok(f.map.hasLayer(f.layers[0]));
  assert.equal(f.computes[0].projection.zoneLon0Deg, -87);
  f.dom.button.dispatch('click');
  assert.equal(f.map.hasLayer(f.layers[0]), false);
  f.env.dtm = false; f.controller.refresh();
  assert.equal(f.dom.panel.hidden, true);
});

test('interval chooser lists ft steps, switching interval re-traces with the new levels; panning inside the traced area does not', async () => {
  const f = fixture();
  f.controller.refresh();
  assert.deepEqual(f.dom.interval.children.map(o => o.textContent), ['Auto', '1 ft', '2 ft', '5 ft', '10 ft', '20 ft', '50 ft']);
  f.dom.button.dispatch('click'); await tick();
  // Auto: 20 m of relief is about 66 ft, so 2 ft.
  assert.equal(f.controller.state.traced.interval, 2);
  assert.equal(f.computes[0].levels[0].label, '756ft');
  f.controller.refresh(); await tick();
  assert.equal(f.computes.length, 1, 'cached trace reused');
  f.dom.interval.value = '10'; f.dom.interval.dispatch('change'); await tick();
  assert.equal(f.computes.length, 2);
  const levels = f.computes[1].levels;
  assert.deepEqual(levels.map(l => l.value), [760, 770, 780, 790, 800, 810, 820]);
  assert.deepEqual(levels.filter(l => l.isIndex).map(l => l.label), ['800ft']);
  assert.ok(Math.abs(levels[0].meters - 760 * METERS_PER_FOOT) < 1e-9);
  assert.equal(f.controller.state.traced.interval, 10);
});

test('metric tasks offer metre intervals and label in m; a too-fine interval explains instead of drawing', async () => {
  const f = fixture({ units: 'metric' });
  f.controller.refresh();
  assert.deepEqual(f.dom.interval.children.map(o => o.textContent), ['Auto', '0.5 m', '1 m', '2 m', '5 m', '10 m', '20 m']);
  f.dom.interval.value = '1'; f.dom.interval.dispatch('change');
  f.dom.button.dispatch('click'); await tick();
  assert.equal(f.computes.at(-1).levels[0].label, '230m');
  const g = fixture();
  g.controller.refresh();
  g.dom.button.dispatch('click'); await tick();
  const before = g.computes.length;
  await g.controller.computeForExtent({ minE: 0, maxE: 100, minN: 0, maxN: 100 }, 1);
  assert.equal(g.computes.length, before, 'export traces on its own worker client');
  assert.equal(g.exportComputes.length, 1);
  assert.equal(g.exportComputes[0].maxPoints, 2_000_000);
});

test('a DTM stored in feet is converted with its declared vertical units before tracing', async () => {
  // Same raster values, now declared as feet: 230..250 ft is about 70..76 m.
  const f = fixture({ verticalScale: async () => 0.3048 });
  f.controller.refresh();
  f.dom.interval.value = '1'; f.dom.interval.dispatch('change');
  f.dom.button.dispatch('click'); await tick();
  const sent = f.computes.at(-1);
  assert.equal(sent.valueScale, 0.3048);
  assert.equal(sent.levels[0].label, '230ft');
  assert.equal(sent.levels.at(-1).label, '250ft');
  assert.equal(sent.maxPoints, VIEW_MAX_POINTS);
  const scale = await dtmVerticalScale({ images: [{ getGeoKeys: () => ({ VerticalUnitsGeoKey: 9002 }), getSamplesPerPixel: () => 1 }] });
  assert.equal(scale, 0.3048);
  assert.equal(await dtmVerticalScale({ images: [{ getGeoKeys: () => ({}) }] }), 1, 'undeclared units read as metres');
  await assert.rejects(dtmVerticalScale({ images: [{ getGeoKeys: () => ({ VerticalUnitsGeoKey: 9999 }) }] }), { code: 'contour_vertical_units' });
  const bad = fixture({ verticalScale: async () => { throw Object.assign(new Error('x'), { code: 'contour_vertical_units' }); } });
  bad.controller.refresh(); bad.dom.button.dispatch('click'); await tick();
  assert.match(bad.controller.state.status, /elevation units/);
  assert.equal(bad.computes.length, 0);
});

test('a worker failure or too many points shows a status instead of tracing on the main thread', async () => {
  const dead = fixture({ compute: async () => { throw Object.assign(new Error('x'), { code: CONTOUR_WORKER_UNAVAILABLE }); } });
  dead.controller.refresh(); dead.dom.button.dispatch('click'); await tick();
  assert.equal(dead.controller.state.status, 'Contours are unavailable in this browser.');
  const dense = fixture({ compute: async () => { throw Object.assign(new Error('x'), { code: 'contours_too_dense' }); } });
  dense.controller.refresh(); dense.dom.interval.value = '1'; dense.dom.interval.dispatch('change');
  dense.dom.button.dispatch('click'); await tick();
  assert.equal(dense.controller.state.status, '1 ft is too fine here. Choose a larger interval.');
  assert.deepEqual(dense.layers[0].data, []);
  const noWorker = createContourWorkerClient({ WorkerClass: class { constructor() { throw new Error('blocked'); } } });
  await assert.rejects(noWorker.compute({ values: new Float32Array(4) }), { code: CONTOUR_WORKER_UNAVAILABLE });
});

test('inline tracing exists only when explicitly requested (tests)', async () => {
  const client = createContourWorkerClient({ inline: true });
  const features = await client.compute({ values: new Float32Array([0, 0, 2, 2]), width: 2, height: 2, levels: [{ meters: 1, value: 1, label: '1m', isIndex: false }], grid: { minE: 0, maxN: 2, cellE: 1, cellN: 1 }, smoothPasses: 0, minLengthCells: 0 });
  assert.equal(features.length, 1);
});

test('viewer wiring: Contours panel sits with the map layer panels; mode switches refresh it; print is permission-gated', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../main.js', import.meta.url), 'utf8');
  const contours = html.indexOf('id="panel-contours"'), ortho = html.indexOf('id="panel-ortho"'), measure = html.indexOf('id="panel-measure"');
  assert.ok(contours > measure && contours < ortho);
  assert.match(html, /id="layer-contours" aria-pressed="false" aria-label="Show contour lines">Show</);
  assert.match(html, /<select id="contour-interval">/);
  assert.match(html, /id="ortho-print-actions"[\s\S]*?id="btn-export-image">Export image</);
  // \s* also spans CRLF in Windows checkouts.
  assert.match(main, /installPropertyLines\(\);\s*installContours\(\);/);
  assert.match(main, /propertyLines\?\.refresh\(\);\s*contourLines\?\.refresh\(\);\s*return true;/);
  const sync = main.slice(main.indexOf('function syncMeasurementActionVisibility()'), main.indexOf('function sessionAccessLabel('));
  assert.match(sync, /setHidden\('ortho-print-actions', !measure\)/);
  assert.doesNotMatch(sync, /viewerAccessAvailable|orthoPrintPermissions|orthoPrintPolicy/, 'self-contained: other tests sandbox this function');
  assert.match(main, /download: SHARE_PERMISSIONS\.download === true/);
  const exporter = main.slice(main.indexOf('async function exportOrthoPrintFromViewer'), main.indexOf('function pcApi()'));
  assert.match(exporter, /^async function exportOrthoPrintFromViewer[^\n]*\s*(\/\/[^\n]*\s*)*assertOrthoPrintAllowed\(orthoPrintPermissions\(\), \{ area, format \}\);/, 'permission re-checked first');
  assert.match(exporter, /isMapMode\(state\.activeMode\)/, 'current view follows any map view');
  assert.match(exporter, /printLongEdge\(\{ area, requested: size, policy, viewPixels \}\)/, 'view exports capped without download');
  assert.match(exporter, /clampExtent\(extent, ortho\)/, 'cap measured on the view clipped to the orthophoto');
  assert.match(exporter, /limited by your access/);
  // Identity continuity: `current()` checks the subject/model/version and the policy after every await.
  assert.match(exporter, /const current = \(\) => \{\s*if \(orthoPrintIdentity\(\) !== job\.identity\) controller\.abort\(\);\s*if \(signal\.aborted\) throw [^\n]*\s*assertOrthoPrintAllowed\(orthoPrintPermissions\(\), \{ area, format \}\);\s*\};/, 'identity and policy checked together');
  assert.match(exporter, /await getDataset\([^\n]*\);\s*current\(\);/, 'checked after opening the orthophoto');
  assert.match(exporter, /checkpoint: current,/, 'checked after tracing, rendering and encoding');
  assert.match(exporter, /await exportOrthoPrint\([\s\S]*?\}\);\s*(\/\/[^\n]*\s*)*current\(\);(?:(?!await)[\s\S])*return result;\s*\} finally \{\s*orthoPrintExports\.delete\(job\);/, 'checked after rendering, with nothing awaited before the file is saved');
  const code = exporter.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  assert.equal(code.match(/\bawait /g).length, 2, 'every await is covered above');
  const access = main.slice(main.indexOf('function setSessionAccessState('), main.indexOf('function recordSessionAccessFailure('));
  assert.match(access, /cancelStaleOrthoPrintExports\(\);\s*\}\s*$/, 'every session state change cancels stale exports');
  assert.match(main, /v \* toMeters > -1000 && v \* toMeters < 10000/, 'DEM range checked in metres');
  assert.doesNotMatch(main, /#FFD60A/, 'property lines found by pane, not colour');
});
