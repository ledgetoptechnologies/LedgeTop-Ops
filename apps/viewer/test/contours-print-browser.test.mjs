import { waitForDevToolsPort } from './devtools-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { launchBrowser, stopBrowser } from './browser-launch.mjs';

// Real-canvas checks for the contour overlay: the print export burns index
// and minor contours, ft labels, property lines and a legend into the
// orthophoto pixels, and the Leaflet layer draws worker-traced lines.
// Set LTDS_CONTOUR_SAMPLE=<file.png> to also save a synthetic-terrain sample.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = () => [process.env.CHROME_PATH, process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].filter(Boolean).find(existsSync);
const SERVED = new Map([
  ['/contours.mjs', 'contours.mjs'], ['/contour-layer.mjs', 'contour-layer.mjs'], ['/contour-worker.mjs', 'contour-worker.mjs'],
  ['/utm-conversion.mjs', 'utm-conversion.mjs'], ['/raster-vertical-units.mjs', 'raster-vertical-units.mjs'], ['/ortho-print-export.mjs', 'ortho-print-export.mjs'], ['/orthophoto-mask.mjs', 'orthophoto-mask.mjs'], ['/brand-colors.mjs', 'brand-colors.mjs'],
  ['/leaflet.js', 'node_modules/leaflet/dist/leaflet-src.esm.js'], ['/leaflet.css', 'node_modules/leaflet/dist/leaflet.css'],
]);

async function readPng(client, length) {
  let base64 = '';
  for (let i = 0; i * 1e6 < length; i++) base64 += await client.evaluate(`pngSlice(${i})`);
  return Buffer.from(base64, 'base64');
}

class Cdp {
  constructor(socket) { this.socket = socket; this.id = 0; this.pending = new Map(); this.errors = []; socket.addEventListener('message', event => { const message = JSON.parse(event.data), entry = this.pending.get(message.id); if (message.method === 'Runtime.exceptionThrown') this.errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text); if (entry) { clearTimeout(entry.timer); this.pending.delete(message.id); message.error ? entry.reject(new Error(message.error.message)) : entry.resolve(message.result); } }); }
  static async connect(url) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); return new Cdp(socket); }
  command(method, params = {}, timeoutMs = 30000) { const id = ++this.id; return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`CDP timeout: ${method} ${params.expression?.slice(0, 40) || ''}`)), timeoutMs); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression, timeoutMs) { const result = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs); if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text); return result.result?.value; }
  close() { for (const entry of this.pending.values()) clearTimeout(entry.timer); this.socket.close(); }
}

const PAGE = `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/leaflet.css">
<style>body{margin:0;background:#222}#map{width:800px;height:600px}</style><div id="map"></div>
<button id="layer-contours">Show</button><select id="contour-interval"></select><select id="contour-color"><option value="brown">Brown</option></select><p id="contours-status"></p><div id="panel-contours"></div>
<script type="module">
import * as L from '/leaflet.js';
import { buildContours, contourLevels, CONTOUR_COLORS } from '/contours.mjs';
import { renderOrthoPrint } from '/ortho-print-export.mjs';
import { createContourController } from '/contour-layer.mjs';
import { createUtmProjection } from '/utm-conversion.mjs';
const range = v => { let a = Infinity, b = -Infinity; for (const x of v) { if (x < a) a = x; if (x > b) b = x; } return [a, b]; };
const FT = 0.3048, E0 = 500000, N0 = 4760000, W = 400, H = 300;
// Terrain in metres over a 400 x 300 m site.
const terrains = {
  cone: (e, n) => (900 - Math.hypot(e - 200, n - 150)) * FT,
  hills: (e, n) => (760 + 38 * Math.exp(-((e - 120) ** 2 + (n - 190) ** 2) / 9000) + 26 * Math.exp(-((e - 300) ** 2 + (n - 90) ** 2) / 6000)
    + 0.09 * e - 0.05 * n + 3 * Math.sin(e / 23) * Math.cos(n / 31) - 14 * Math.exp(-((e - 230) ** 2) / 900 - ((n - 210) ** 2) / 20000)) * FT,
};
function dem(kind, cell) {
  const w = Math.round(W / cell) + 1, h = Math.round(H / cell) + 1, values = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) values[y * w + x] = terrains[kind](x * cell, H - y * cell);
  return { values, width: w, height: h, grid: { minE: E0 - cell / 2, maxN: N0 + H + cell / 2, cellE: cell, cellN: cell } };
}
// Synthetic orthophoto: flat grey for the cone (easy pixel checks), shaded fields for the sample.
function ortho(kind) {
  const image = (w, h) => ({ getWidth: () => w, getHeight: () => h, async readRasters({ window }) {
    const [x0, y0, x1, y1] = window, ww = x1 - x0, wh = y1 - y0, bands = [0, 1, 2].map(() => new Uint8Array(ww * wh));
    for (let y = 0; y < wh; y++) for (let x = 0; x < ww; x++) {
      const e = (x0 + x + 0.5) * W / w, n = H - (y0 + y + 0.5) * H / h, i = y * ww + x;
      if (kind === 'cone') { bands[0][i] = 150; bands[1][i] = 160; bands[2][i] = 150; continue; }
      const z = terrains.hills(e, n), dzx = terrains.hills(e + 1, n) - z, dzy = terrains.hills(e, n + 1) - z;
      const shade = Math.max(0.55, Math.min(1.25, 0.95 - 1.6 * dzx + 1.2 * dzy));
      const field = (Math.floor(e / 37) + Math.floor(n / 53)) % 3, noise = (Math.sin(e * 12.9898 + n * 78.233) * 43758.5453) % 1;
      const base = field === 0 ? [96, 122, 64] : field === 1 ? [128, 140, 82] : [74, 98, 52];
      const tree = Math.sin(e / 5.3) * Math.cos(n / 4.1) > 0.82 ? 0.6 : 1;
      for (let b = 0; b < 3; b++) bands[b][i] = Math.max(0, Math.min(255, base[b] * shade * tree + noise * 18));
    }
    return bands;
  } });
  return { minE: E0, maxE: E0 + W, minN: N0, maxN: N0 + H, nodata: NaN, images: [image(2000, 1500), image(1000, 750)] };
}
window.renderPrint = async (kind, longEdge, interval) => {
  const d = dem(kind, 1), { levels } = contourLevels(...range(d.values), interval, 'imperial');
  const features = buildContours({ ...d, levels });
  const square = [[E0 + 40, N0 + 40], [E0 + 360, N0 + 40], [E0 + 360, N0 + 260], [E0 + 40, N0 + 260], [E0 + 40, N0 + 40]];
  const result = await renderOrthoPrint({ ortho: ortho(kind), extent: { minE: E0, maxE: E0 + W, minN: N0, maxN: N0 + H }, longEdge,
    contours: { features, interval, units: 'imperial' }, colors: CONTOUR_COLORS.brown, propertyLines: [square], propertyAttribution: 'Source: Synthetic parcels R1. Credit line.', createCanvas: () => document.createElement('canvas') });
  window.print = result;
  window.printData = result.ctx.getImageData(0, 0, result.width, result.height).data;
  window.printPng = result.canvas.toDataURL('image/png').split(',')[1];
  return { width: result.width, height: result.height, contours: result.contours, pngLength: window.printPng.length };
};
// Large strings stall a single CDP message; read the PNG in slices.
window.pngSlice = i => window.printPng.slice(i * 1e6, (i + 1) * 1e6);
window.pixel = (x, y) => { const i = (y * window.print.width + x) * 4; return Array.from(window.printData.slice(i, i + 4)); };
window.radial = (cx, cy, angle, r0, r1, gsd) => { const out = []; for (let r = r0; r <= r1; r += gsd / 4) { const x = Math.round(cx + r / gsd * Math.cos(angle)), y = Math.round(cy - r / gsd * Math.sin(angle)); out.push([r, ...window.pixel(x, y)]); } return out; };
// Leaflet map with the real controller and module worker.
const utm = createUtmProjection({ zoneLon0Deg: -87, hemisphere: 'N' });
const map = L.map('map', { zoomControl: false, attributionControl: false });
const [lat, lng] = utm.utmToLatLon(E0 + 200, N0 + 150); map.setView([lat, lng], 18);
const coneGrid = dem('cone', 0.5);
const image = (w, h) => ({ getWidth: () => w, getHeight: () => h, async readRasters({ window: win, width, height }) {
  const out = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const e = (win[0] + (x + 0.5) * (win[2] - win[0]) / width) * W / w, n = H - (win[1] + (y + 0.5) * (win[3] - win[1]) / height) * H / h; out[y * width + x] = terrains.cone(e, n); }
  return [out];
} });
const ds = { minE: E0, maxE: E0 + W, minN: N0, maxN: N0 + H, nodata: -9999, min: range(coneGrid.values)[0], max: range(coneGrid.values)[1], images: [image(800, 600), image(400, 300)] };
window.controller = createContourController({ L, dom: { panel: document.getElementById('panel-contours'), button: document.getElementById('layer-contours'), interval: document.getElementById('contour-interval'), color: document.getElementById('contour-color'), status: document.getElementById('contours-status') },
  getMap: () => map, isMapMode: () => true, hasDtm: () => true, getDtm: async () => ds, units: () => 'imperial',
  projection: () => ({ zoneLon0Deg: -87, hemisphere: 'N' }), latLonToUtm: (a, b) => utm.latLonToUtm(a, b), debounceMs: 0 });
window.controller.refresh();
window.mapInk = () => { const c = document.querySelector('.ltds-contour-canvas'); if (!c) return 0; const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 100) n++; return n; };
document.body.dataset.ready = 'true';
</script>`;

test('print export burns contours, ft labels, property lines and legend into real pixels; map layer draws worker-traced lines', { timeout: 240000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the contour canvas test.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server;
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(PAGE); return; }
      const relative = SERVED.get(url.pathname), file = relative && path.resolve(root, relative);
      if (!file || !existsSync(file)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', file.endsWith('.css') ? 'text/css' : 'application/javascript');
      res.end(readFileSync(file));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let profile;
    ({ child: browser, profile } = launchBrowser(binary, dir => ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${dir}`, 'about:blank'], { prefix: 'ltds-contours-browser-' }));
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'), { timeoutMs: 30_000 });
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable'); await client.command('Runtime.enable');
    await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    const ready = Date.now() + 15000;
    while (Date.now() < ready && !await client.evaluate("document.body?.dataset.ready==='true'")) await delay(50);
    assert.equal(await client.evaluate("document.body?.dataset.ready==='true'"), true, client.errors.join(' | ') || 'fixture page did not load');

    // Cone: 900 ft at the centre, 1 ft per metre; 2 ft interval, index every 10 ft.
    const print = await client.evaluate("renderPrint('cone', 2048, 2)");
    assert.deepEqual([print.width, print.height], [2048, 1536]);
    assert.ok(print.contours.minor > 0 && print.contours.index > 0 && print.contours.labels >= 4, JSON.stringify(print.contours));
    const output = path.join(tmpdir(), 'ltds-contours-print-test.png');
    writeFileSync(output, await readPng(client, print.pngLength));
    t.diagnostic(`Print test image: ${output}`);
    const gsd = 400 / 2048, cx = 1024, cy = 768;
    const isLine = p => p[1] < 125 && p[2] < 105 && p[3] < 90 && p[1] > p[3];
    // The 800 ft index ring is 100 m from the peak; the 802 ft minor ring 98 m.
    let indexHits = 0, widthIndex = 0, widthMinor = 0;
    for (let k = 0; k < 16; k++) {
      const angle = (k + 0.25) * Math.PI / 8;
      const samples = await client.evaluate(`radial(${cx},${cy},${angle},96.5,101.5,${gsd})`);
      const run = (lo, hi) => samples.filter(p => p[0] >= lo && p[0] <= hi && isLine(p)).length;
      if (run(99.4, 100.6) > 0) indexHits++;
      widthIndex += run(99.2, 100.8); widthMinor += run(97.2, 98.8);
    }
    assert.ok(indexHits >= 13, `800 ft index ring found in ${indexHits}/16 directions`);
    assert.ok(widthIndex > widthMinor * 1.4 && widthMinor > 0, `index lines thicker than minor (${widthIndex} vs ${widthMinor})`);
    assert.deepEqual(await client.evaluate('pixel(600, 300)'), [150, 160, 150, 255], 'imagery untouched between lines');
    const line = await client.evaluate(`pixel(${Math.round(200 / gsd)}, ${Math.round((300 - 260) / gsd)})`);
    assert.ok(line[0] > 200 && line[1] < 130 && line[2] < 70, `property line pixel (brand orange) ${line}`);
    // The note band across the bottom: opaque white, with real text in it.
    const band = await client.evaluate("(() => { const edge = pixel(2044, 1533); let ink = 0; for (let y = 1501; y < 1536; y++) for (let x = 0; x < 1000; x++) { const p = pixel(x, y); if (p[0] < 110 && p[1] < 110 && p[2] < 110) ink++; } return { edge, ink }; })()");
    assert.deepEqual(band.edge, [255, 255, 255, 255]);
    assert.ok(band.ink > 300, `note text pixels ${band.ink}`);
    const legend = await client.evaluate('pixel(24, 1474)');
    assert.ok(legend.slice(0, 3).every(v => v > 225), `legend box pixel ${legend}`);
    // Labels: light halo pixels appear on the imagery away from the legend.
    const halo = await client.evaluate("(() => { let n = 0; for (let y = 0; y < 1300; y++) for (let x = 300; x < 2048; x++) { const p = pixel(x, y); if (p[0] > 235 && p[1] > 230 && p[2] > 215) n++; } return n; })()");
    assert.ok(halo > 200, `label halo pixels ${halo}`);

    // Map overlay: Show traces in the module worker and paints the canvas.
    await client.evaluate("document.getElementById('layer-contours').click()");
    const drawn = Date.now() + 20000;
    while (Date.now() < drawn && !(await client.evaluate('controller.state.traced?.features > 0'))) await delay(200);
    const state = await client.evaluate('controller.state');
    assert.equal(state.on, true);
    assert.ok(state.traced?.features > 0, JSON.stringify(state));
    assert.ok(await client.evaluate('mapInk()') > 500, 'contour canvas has ink');
    const shot = await client.command('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 } });
    const mapShot = path.join(tmpdir(), 'ltds-contours-map-test.png');
    writeFileSync(mapShot, Buffer.from(shot.data, 'base64'));
    t.diagnostic(`Map layer screenshot: ${mapShot}`);

    if (process.env.LTDS_CONTOUR_SAMPLE) {
      const sample = await client.evaluate("renderPrint('hills', 3000, 2)", 60000);
      writeFileSync(process.env.LTDS_CONTOUR_SAMPLE, await readPng(client, sample.pngLength));
      t.diagnostic(`Sample: ${process.env.LTDS_CONTOUR_SAMPLE}`);
    }
  } finally {
    client?.close(); stopBrowser(browser);
    if (server) await new Promise(resolve => server.close(resolve));
    await unlock();
  }
});
