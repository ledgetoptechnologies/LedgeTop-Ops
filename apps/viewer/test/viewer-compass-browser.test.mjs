import { waitForDevToolsPort } from './devtools-port.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

// Shipped Viewer CSS and markup (app shell + photo modal) with the real compass
// module in a fresh hidden browser. Views, map tiles and photos are fixtures:
// this checks placement, overlap, states and the text alternative, not real
// model rendering or real north on production data.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const app = source.slice(source.indexOf('<div id="app">'), source.indexOf('<div id="cam-tooltip">'));
const photo = source.slice(source.indexOf('<div id="photo-modal"'), source.indexOf('<div id="share-password-overlay">'));
assert.ok(css && app.includes('id="viewer-wrap"') && photo.includes('id="photo-imgwrap"'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const binary = () => [process.env.CHROME_PATH, process.env.EDGE_PATH, 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
class Cdp {
  constructor(socket) { this.socket = socket; this.sequence = 0; this.pending = new Map(); socket.addEventListener('message', event => { const m = JSON.parse(event.data), p = this.pending.get(m.id); if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); } }); }
  static async connect(url) { const socket = new WebSocket(url); await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }); return new Cdp(socket); }
  command(method, params = {}) { const id = ++this.sequence; return new Promise((resolve, reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000); this.pending.set(id, { resolve, reject, timer }); this.socket.send(JSON.stringify({ id, method, params })); }); }
  async evaluate(expression) { const value = await this.command('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (value.exceptionDetails) throw new Error(value.exceptionDetails.exception?.description || value.exceptionDetails.text); return value.result?.value; }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('Fixture closed')); } this.pending.clear(); this.socket.close(); }
}

function page() {
  return `<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/leaflet.css"><style>${css}</style>
${app.replace(/src="[^"]+"/g, 'src="data:,"')}
${photo}
<script type="module">
import { createCompass } from '/viewer-compass.mjs';
// Same installation as main.js installCompasses().
const view = createCompass({ className: 'viewer-compass-view' }); view.element.id = 'view-compass';
document.getElementById('viewer-wrap').appendChild(view.element);
const photo = createCompass({ className: 'viewer-compass-photo' }); photo.element.id = 'photo-compass';
document.getElementById('photo-imgwrap').appendChild(photo.element);
// A map-mode surface: Leaflet attribution in its real corner, DEM legend and hover readout shown.
const map = document.getElementById('leaflet-map'); map.style.display = 'block';
map.innerHTML = '<div class="leaflet-control-container"><div class="leaflet-bottom leaflet-right"><div class="leaflet-control-attribution leaflet-control">Leaflet | Imagery fixture attribution</div></div></div>';
document.getElementById('dem-legend').style.display = 'flex';
document.getElementById('dem-hover').style.display = 'block';
window.view = view; window.photo = photo;
window.rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
window.overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top && a.width > 0 && b.width > 0;
window.openPhoto = (presentation, width, height) => {
  const modal = document.getElementById('photo-modal'); modal.style.display = 'flex'; modal.className = presentation;
  const wrap = document.getElementById('photo-imgwrap');
  if (presentation === 'expanded') { wrap.style.width = innerWidth + 'px'; wrap.style.height = innerHeight + 'px'; }
  else { wrap.style.width = width + 'px'; wrap.style.height = height + 'px'; document.getElementById('photo-frame').style.width = (width + 22) + 'px'; }
  const img = document.getElementById('photo-img'); img.style.display = ''; img.style.width = wrap.style.width; img.style.height = wrap.style.height; img.style.opacity = '1';
  document.getElementById('photo-title').textContent = 'DJI_0001.JPG'; document.getElementById('photo-meta').textContent = '11/17/2026, 10:42:00 AM';
  photo.setVisible(true);
};
document.body.dataset.ready = 'true';
</script>`;
}

function serve(req, res) {
  const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
  if (pathname === '/viewer-compass.mjs') { res.setHeader('Content-Type', 'text/javascript; charset=utf-8'); res.end(readFileSync(path.join(root, 'viewer-compass.mjs'), 'utf8')); return; }
  if (pathname === '/leaflet.css') {
    const file = path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet.css');
    if (!existsSync(file)) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', 'text/css; charset=utf-8'); res.end(readFileSync(file, 'utf8')); return;
  }
  if (pathname !== '/') { res.writeHead(404).end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page());
}

test('shipped compass sits bottom right in every view and photo without covering controls', { timeout: 90000 }, async t => {
  const executable = binary(); if (!executable) { t.skip('Chromium-family browser required for isolated compass layout regression.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root }); let browser, client, profile, server;
  try {
    server = createServer(serve); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const origin = `http://127.0.0.1:${server.address().port}`;
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-compass-'));
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort')), tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl); await client.command('Runtime.enable'); await client.command('Page.enable');
    async function open(width, height) {
      await client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }); const url = `${origin}/?width=${width}`; await client.command('Page.navigate', { url }); const until = Date.now() + 8000; while (Date.now() < until) { if (await client.evaluate(`location.href===${JSON.stringify(url)}&&document.body?.dataset.ready==='true'`)) return; await delay(25); } throw new Error(`Fixture did not become ready: ${width}`);
    }
    for (const [width, height] of [[375, 740], [768, 1024], [1280, 912]]) await t.test(`${width}px viewer and photo compass`, async () => {
      await open(width, height);
      const out = await client.evaluate(`(()=>{
        view.update({heading: 90});
        const compass = rect('#view-compass'), wrap = rect('#viewer-wrap');
        const others = Object.fromEntries(['#floating-controls','#dem-legend','#dem-hover','#sidebar-toggle','.leaflet-control-attribution','#statusbar'].map(s => [s, overlaps(compass, rect(s))]));
        const center = document.elementFromPoint(compass.left + compass.width / 2, compass.top + compass.height / 2);
        const style = getComputedStyle(document.getElementById('view-compass'));
        return { compass, wrap, others, centerIsCompass: Boolean(center?.closest?.('.viewer-compass')),
          label: document.getElementById('view-compass').getAttribute('aria-label'), role: document.getElementById('view-compass').getAttribute('role'),
          transform: document.querySelector('#view-compass .viewer-compass-needle').getAttribute('transform'),
          unknownShown: getComputedStyle(document.querySelector('#view-compass .viewer-compass-unknown')).display !== 'none',
          position: style.position, pointerEvents: style.pointerEvents, docWidth: document.documentElement.scrollWidth };
      })()`);
      assert.equal(out.compass.width, 44); assert.equal(out.compass.height, 44);
      assert.equal(Math.round(out.wrap.right - out.compass.right), 14, JSON.stringify(out));
      assert.equal(Math.round(out.wrap.bottom - out.compass.bottom), 44, JSON.stringify(out));
      for (const [selector, overlap] of Object.entries(out.others)) assert.equal(overlap, false, `${width}px compass overlaps ${selector}`);
      assert.equal(out.centerIsCompass, false, 'display-only compass lets clicks reach the view');
      assert.equal(out.pointerEvents, 'none');
      assert.ok(out.docWidth <= width, 'no horizontal overflow');
      assert.equal(out.role, 'img'); assert.match(out.label, /heading 90° east/);
      assert.equal(out.transform, 'rotate(-90 24 24)'); assert.equal(out.unknownShown, false);

      const unknown = await client.evaluate(`(()=>{view.update({heading:null, unknownReason:'this model has no verified georeference'});return {state:document.getElementById('view-compass').dataset.state,needle:getComputedStyle(document.querySelector('#view-compass .viewer-compass-needle')).display,mark:getComputedStyle(document.querySelector('#view-compass .viewer-compass-unknown')).display,label:document.getElementById('view-compass').getAttribute('aria-label')};})()`);
      assert.deepEqual(unknown, { state: 'unknown', needle: 'none', mark: 'inline', label: 'Compass: view heading unknown, this model has no verified georeference.' });

      for (const presentation of ['docked', 'expanded']) {
        const result = await client.evaluate(`(()=>{
          openPhoto(${JSON.stringify(presentation)}, ${width <= 640 ? 220 : 380}, ${width <= 640 ? 165 : 285});
          photo.update({heading: 200, surface: 'photo'});
          const compass = rect('#photo-compass'), wrap = rect('#photo-imgwrap');
          const others = Object.fromEntries(['#photo-close','#photo-title','#photo-meta','#photo-download'].map(s => [s, overlaps(compass, rect(s))]));
          return { compass, wrap, others, label: document.getElementById('photo-compass').getAttribute('aria-label') };
        })()`);
        assert.equal(result.compass.width, 44, presentation); assert.equal(result.compass.height, 44, presentation);
        assert.ok(result.compass.right <= result.wrap.right && result.compass.bottom <= result.wrap.bottom
          && result.compass.left >= result.wrap.left && result.compass.top >= result.wrap.top, `${presentation} compass stays on the photo ${JSON.stringify(result)}`);
        assert.ok(result.wrap.right - result.compass.right < 20 && result.wrap.bottom - result.compass.bottom < 80, `${presentation} bottom right`);
        for (const [selector, overlap] of Object.entries(result.others)) assert.equal(overlap, false, `${width}px ${presentation} photo compass overlaps ${selector}`);
        assert.match(result.label, /photo heading 200° south/);
      }
    });
  } finally {
    client?.close(); if (browser) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await Promise.race([exited, delay(3000)]); } if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); } unlock();
    if (profile) { const absolute = path.resolve(profile); assert.ok(absolute.startsWith(path.resolve(tmpdir(), 'ltds-viewer-compass-'))); try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; t.diagnostic(`Browser retained isolated temporary profile lock: ${absolute}`); } }
  }
});
