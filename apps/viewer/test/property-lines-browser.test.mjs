// Isolated browser check of the property lines toggle on a Leaflet map, using
// the shipped index.html panel, notice and CSS with a stubbed parcel response.
// No live service: the page's CSP allows only this test server.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnBrowser, stopBrowser } from './browser-launch.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as Cdp } from './bounded-test-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync) || null;

function block(html, startMarker, tag = 'div') {
  const start = html.indexOf(startMarker);
  assert.ok(start >= 0, startMarker);
  let depth = 0, index = start;
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g');
  re.lastIndex = start;
  for (let m; (m = re.exec(html));) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) { index = m.index + m[0].length; break; }
  }
  return html.slice(start, index);
}

function page() {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  const panel = block(html, '<div class="panel" id="panel-property-lines"');
  const notice = html.match(/<div id="property-lines-notice"[^>]*><\/div>/)[0];
  const floating = block(html, '<div id="floating-controls">');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css">${style}</head><body>
<div id="main" style="height:100vh"><aside id="sidebar"><div id="sidebar-custom">${panel}</div></aside>
<div id="viewer-wrap"><div id="leaflet-map" style="display:block"></div>${notice}${floating}</div></div>
<script type="module">
import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
import { createPropertyLinesController } from '/property-lines-layer.mjs';
import { createUtmProjection } from '/utm-conversion.mjs';
const projection = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
const map = L.map('leaflet-map', { zoomControl: true }).setView([43.0745, -89.401], 17);
const [e, n] = projection.latLonToUtm(43.0745, -89.401);
window.requests = [];
const controller = createPropertyLinesController({
  L, fetchImpl: (url, options) => { window.requests.push(url); return fetch(url, options); }, headers: () => ({ Authorization: 'Bearer test-session-token-xx' }),
  fetcherOptions: { debounceMs: 50 },
  dom: { panel: document.getElementById('panel-property-lines'), button: document.getElementById('layer-property-lines'),
    status: document.getElementById('property-lines-status'), notice: document.getElementById('property-lines-notice'),
    merge: document.getElementById('property-lines-merge'), mergeRow: document.getElementById('property-lines-merge-row') },
  projectId: () => 'model-1', getMode: () => window.viewMode || 'ortho', getCloudMode: () => window.cloudMode || 'none', getMap: () => map, getScene: () => null, getPotreeApi: () => null,
  georefVerified: () => true, getSceneExtentUtm: () => ({ minE: e - 120, minN: n - 90, maxE: e + 120, maxN: n + 90 }), getGroundGrid: async () => null,
  utmToLatLon: projection.utmToLatLon, latLonToUtm: projection.latLonToUtm, utmToWorld: () => null,
});
map.on('moveend', () => controller.refresh());
window.controller = controller; window.map = map;
controller.loadOffer().then(() => { document.body.dataset.ready = 'true'; });
</script></body></html>`;
}

// Two touching parcels of one (generic) owner, written with different case
// and spacing, so they draw as one outline with one label.
const PARCELS = { status: 'ok', parcels: [
  { id: 1, owner: 'SAMPLE FARMS LLC', rings: [[[-89.4020, 43.0740], [-89.4020, 43.0752], [-89.4005, 43.0752], [-89.4005, 43.0740], [-89.4020, 43.0740]]] },
  { id: 2, owner: 'Sample  Farms LLC', rings: [[[-89.4005, 43.0740], [-89.4005, 43.0752], [-89.3995, 43.0752], [-89.3995, 43.0740], [-89.4005, 43.0740]]] },
] };

test('property lines: shown by default with notice, states, Hide kept over reload and no foreign requests', { timeout: 90000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated property lines check.'); return; }
  if (!existsSync(path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet-src.esm.js'))) { t.skip('npm ci is required.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile, mode = 'ok', offered = true;
  const hits = [];
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      hits.push(url.pathname + url.search);
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page()); return; }
      if (url.pathname === '/api/v1/property-lines' && url.searchParams.get('model') === 'model-1') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ offered: offered && req.headers.authorization === 'Bearer test-session-token-xx', source: { id: 'wi-statewide-parcels', name: 'Wisconsin Statewide Parcel Map', release: 'V12 (2026)', credit: 'Credit line.', disclaimer: 'Property lines are approximate and for reference only. They are not a survey.',
          shortName: 'WI statewide', vintage: 'V12, 2025 tax roll', dataUpdated: '2026-06-30', owners: 'yes' } }));
        return;
      }
      if (url.pathname === '/api/v1/property-lines/parcels') {
        res.setHeader('Content-Type', 'application/json');
        if (mode === 'down') { res.statusCode = 502; res.end('{"status":"unavailable","parcels":[]}'); return; }
        res.end(JSON.stringify(mode === 'many' ? { status: 'too_many', parcels: [] } : mode === 'none' ? { status: 'none', parcels: [] } : PARCELS));
        return;
      }
      const allowed = new Set(['/property-lines.mjs', '/property-lines-layer.mjs', '/property-lines-owners.mjs', '/brand-colors.mjs', '/utm-conversion.mjs', '/node_modules/leaflet/dist/leaflet-src.esm.js', '/node_modules/leaflet/dist/leaflet.css']);
      if (!allowed.has(url.pathname)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-property-lines-'));
    browser = spawnBrowser(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Network.enable');
    const size = (width, height, mobile = false) => client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const waitFor = async (expression, label, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (await client.evaluate(expression)) return; await delay(50); }
      assert.fail(`timed out: ${label}; status ${await client.evaluate("document.getElementById('property-lines-status').textContent")}; size ${await client.evaluate('JSON.stringify([map.getSize(), map.getBounds().toBBoxString(), document.getElementById("viewer-wrap").getBoundingClientRect()])')}`);
    };
    const load = async () => {
      await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      await waitFor("document.body?.dataset.ready === 'true'", 'page ready');
    };
    const ui = () => client.evaluate(`(() => { const b = document.getElementById('layer-property-lines'), n = document.getElementById('property-lines-notice');
      return { panelHidden: document.getElementById('panel-property-lines').hidden, pressed: b.getAttribute('aria-pressed'), label: b.textContent,
        status: document.getElementById('property-lines-status').textContent, state: document.getElementById('property-lines-status').dataset.state,
        noticeHidden: n.hidden, notice: n.textContent, card: document.getElementById('panel-property-lines').innerText, canvas: !!document.querySelector('.leaflet-propertyLines-pane canvas') }; })()`);

    await size(1280, 760);
    await load();
    // Default on (changed deliberately): an authorized offer draws the lines with no click.
    await waitFor("document.getElementById('property-lines-status').dataset.state === 'ready'", 'parcels drawn by default');
    let state = await ui();
    assert.equal(state.panelHidden, false);
    assert.equal(state.pressed, 'true');
    assert.equal(state.label, 'Hide');
    assert.equal(state.status, '', 'no parcel count in the card');
    assert.equal(state.canvas, true, 'lines drawn in their own pane');
    assert.equal(state.noticeHidden, false);
    assert.match(state.notice, /approximate, not a survey.*Wisconsin Statewide Parcel Map V12/);
    // The card is its title and controls only: no count, disclaimer, source credit or data date.
    assert.equal(state.card.replace(/\s+/g, ' ').trim().toLowerCase(), 'property lines hide merge parcels by owner');
    assert.doesNotMatch(state.card, /parcels? shown|not a survey|Source|release|V12|tax roll|updated/i);
    const request = hits.find(h => h.startsWith('/api/v1/property-lines/parcels'));
    assert.match(request, /^\/api\/v1\/property-lines\/parcels\?tile=14%2F\d+%2F\d+&model=model-1$/);
    assert.equal(await client.evaluate('map.hasLayer && Object.values(map._layers).filter(l => l.options?.pane === "propertyLines" && typeof l.getLatLngs === "function").length'), 2);
    // Orange accent line over a dark halo.
    assert.deepEqual(await client.evaluate('Object.values(map._layers).filter(l => l.options?.pane === "propertyLines" && l.getLatLngs).map(l => l.options.color)'), ['#111111', '#ee5007']);
    // One owner: one merged outline and one label in the middle of it.
    const owners = () => client.evaluate(`(() => { const labels = [...document.querySelectorAll('.leaflet-propertyLineLabels-pane .property-line-label')];
      return { outlines: controller.state.outlines, labels: labels.map(l => l.textContent), merge: document.getElementById('property-lines-merge').checked,
        mergeShown: !document.getElementById('property-lines-merge-row').hidden,
        inside: labels.every(l => { const r = l.getBoundingClientRect(), m = map.getContainer().getBoundingClientRect(); return r.left >= m.left && r.right <= m.right && r.top >= m.top && r.bottom <= m.bottom; }) }; })()`);
    let own = await owners();
    assert.equal(own.outlines, 1, 'touching parcels of one owner draw as one outline');
    assert.deepEqual(own.labels, ['SAMPLE FARMS LLC']);
    assert.equal(own.inside, true);
    assert.deepEqual([own.merge, own.mergeShown], [true, true]);
    // Raw parcels on request, without fetching again; the choice is remembered.
    const beforeSplit = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    await client.evaluate("document.getElementById('property-lines-merge').click(); 0");
    await waitFor('controller.state.outlines === 2', 'unmerged');
    own = await owners();
    assert.equal(own.merge, false);
    assert.deepEqual(own.labels, ['SAMPLE FARMS LLC'], 'the narrower parcel is too small for its name at this zoom');
    await client.evaluate('map.setZoom(18, {animate:false}); 0');
    await waitFor("document.querySelectorAll('.leaflet-propertyLineLabels-pane .property-line-label').length === 2", 'one label per parcel when zoomed in');
    assert.deepEqual((await owners()).labels.sort(), ['SAMPLE FARMS LLC', 'Sample Farms LLC']);
    assert.equal(hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length, beforeSplit, 'redrawn from the parcels already fetched');
    assert.equal(await client.evaluate("localStorage.getItem('ltds-viewer:property-lines-merge')"), '0');
    await client.evaluate("document.getElementById('property-lines-merge').click(); 0");
    await waitFor('controller.state.outlines === 1', 'merged again');

    // Layout: the notice does not cover the zoom buttons or the floating controls.
    const overlaps = async () => client.evaluate(`(() => { const r = s => document.querySelector(s).getBoundingClientRect();
      const o = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const n = r('#property-lines-notice'), z = r('.leaflet-control-zoom'), f = r('#floating-controls'), a = r('.leaflet-control-attribution'), w = r('#viewer-wrap');
      return { zoom: o(n, z), floating: o(n, f), attribution: o(n, a), inside: n.left >= w.left && n.right <= w.right && n.top >= w.top, bottomGap: w.bottom - n.bottom, width: n.width }; })()`);
    let layout = await overlaps();
    assert.deepEqual([layout.zoom, layout.floating, layout.attribution, layout.inside], [false, false, false, true], JSON.stringify(layout));
    assert.ok(layout.bottomGap > 120, 'leaves the bottom-right compass area clear');

    // Pan and zoom: debounced, only the newest request matters, cache reused.
    const before = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    await client.evaluate('map.panBy([5, 0], {animate:false}); map.panBy([5, 0], {animate:false}); map.panBy([-10, 0], {animate:false}); 0');
    await delay(400);
    assert.ok(hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length - before <= 1, 'debounced');
    for (let i = 0; i < 6; i++) { await client.evaluate(`map.panBy([${i % 2 ? -40 : 40}, 0], {animate:false}); 0`); await delay(120); }
    await delay(400);
    assert.equal(await client.evaluate("document.querySelectorAll('.leaflet-propertyLines-pane canvas').length"), 1, 'one canvas after repeated pans');

    // Too many, none and service failure are reported.
    // Each state uses a different map tile, so it is not served from the tile cache.
    for (const [next, expected, zoom, lon] of [['many', /Too many parcels/, 19, -89.42], ['none', /No property lines found/, 20, -89.377], ['down', /service unavailable/, 20, -89.44]]) {
      mode = next;
      await client.evaluate(`map.setView([43.0745, ${lon}], ${zoom}, {animate:false}); 0`);
      await waitFor(`/${expected.source}/.test(document.getElementById('property-lines-status').textContent)`, next);
    }
    mode = 'ok';

    // Labels hide when zoomed far out and come back when zoomed in.
    const beforeWide = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    await client.evaluate('map.setView([43.0745, -89.401], 13, {animate:false}); 0');
    await waitFor(`document.getElementById('property-lines-status').dataset.state === 'ready' && controller.stats().tiles.requests > ${await client.evaluate('controller.stats().tiles.requests')} + 3`, 'zoomed out');
    assert.equal(await client.evaluate("document.querySelectorAll('.leaflet-propertyLineLabels-pane .property-line-label').length"), 0, 'no names at zoom 13');
    // Zoomed out, the lines cover the visible map around the model: several
    // tiles, none further than the coverage around the model.
    const tileHits = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).slice(beforeWide);
    assert.ok(tileHits.length >= 4, `tiles fetched for the wider view: ${tileHits.length}`);
    for (const hit of tileHits) {
      const tile = new URL(hit, 'http://x').searchParams.get('tile');
      assert.match(tile, /^1[4-6]\/\d+\/\d+$/, 'on-grid tile keys only');
      const [z, x, y] = tile.split('/').map(Number), n = 2 ** z;
      const lonAt = i => i / n * 360 - 180, latAt = j => Math.atan(Math.sinh(Math.PI * (1 - 2 * j / n))) * 180 / Math.PI;
      const [west, south, east, north] = [lonAt(x), latAt(y + 1), lonAt(x + 1), latAt(y)];
      assert.ok(west < -89.401 + 0.08 && east > -89.401 - 0.08 && south < 43.0745 + 0.06 && north > 43.0745 - 0.06, 'within the coverage around the model');
    }
    await client.evaluate('map.setView([43.0745, -89.401], 11, {animate:false}); 0');
    await waitFor("document.getElementById('property-lines-status').dataset.state === 'zoom_in'", 'zoom-in cutoff');
    assert.match(await client.evaluate("document.getElementById('property-lines-status').textContent"), /Zoom in to see property lines/);
    await client.evaluate('map.setView([43.0745, -89.401], 17, {animate:false}); 0');
    await waitFor("document.querySelectorAll('.leaflet-propertyLineLabels-pane .property-line-label').length === 1", 'label back when zoomed in');

    // Hide: lines and notice go away.
    await client.evaluate("document.getElementById('layer-property-lines').click()");
    state = await ui();
    assert.equal(state.pressed, 'false');
    assert.equal(state.noticeHidden, true);
    assert.equal(await client.evaluate('Object.values(map._layers).filter(l => l.options?.pane === "propertyLines" && typeof l.getLatLngs === "function").length'), 0);

    // Hide holds across view changes in the same project (map, 3D model, point cloud and back).
    const hiddenHits = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    for (const [view, cloud] of [['dsm', 'none'], ['model', 'potree'], ['cloud', 'potree'], ['dtm', 'none'], ['ortho', 'none']]) {
      await client.evaluate(`window.viewMode = '${view}'; window.cloudMode = '${cloud}'; controller.refresh(); 0`);
      await delay(50);
      state = await ui();
      assert.deepEqual([state.label, state.pressed, state.noticeHidden], ['Show', 'false', true], view);
    }
    assert.equal(hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length, hiddenHits, 'nothing fetched while hidden');

    // Phone width, after a reload: the Hide is remembered, nothing is fetched or drawn until Show.
    await size(375, 740, true);
    const parcelHits = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    await load();
    state = await ui();
    assert.equal(state.panelHidden, false);
    assert.equal(state.pressed, 'false', 'Hide survives the reload');
    assert.equal(state.noticeHidden, true);
    assert.equal(state.canvas, false);
    assert.equal(hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length, parcelHits, 'nothing fetched while hidden');
    await client.evaluate("document.getElementById('layer-property-lines').click()");
    await waitFor("document.getElementById('property-lines-status').dataset.state === 'ready'", 'phone ready');
    layout = await overlaps();
    assert.deepEqual([layout.zoom, layout.floating, layout.attribution, layout.inside], [false, false, false, true], JSON.stringify(layout));

    // Without an offer the card is absent and nothing is fetched or drawn.
    offered = false;
    await size(1280, 760);
    const hitsWithoutOffer = hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length;
    await load();
    state = await ui();
    assert.equal(state.panelHidden, true, 'no card without an offer');
    assert.equal(state.noticeHidden, true);
    assert.equal(state.canvas, false);
    assert.equal(hits.filter(h => h.startsWith('/api/v1/property-lines/parcels')).length, hitsWithoutOffer);

    assert.ok(hits.every(h => !/^https?:/.test(h)), 'only same-origin requests');
    assert.ok(hits.every(h => !/arcgis|services3/.test(h)), 'never the live service');
  } finally {
    client?.close();
    stopBrowser(browser);
    if (browser && browser.exitCode === null) { await new Promise(resolve => browser.once('exit', resolve)); }
    server?.close();
    if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ } }
    await unlock();
  }
});
