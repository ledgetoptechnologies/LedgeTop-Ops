// Isolated browser check of the Marks panel on a real Leaflet map, using the
// shared headless-browser harness. Public-link (temporary) scope, so no API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
const MODULES = ['viewer-marks.mjs', 'viewer-marks-store.mjs', 'viewer-mark-map-layer.mjs', 'viewer-mark-icons.mjs',
  'viewer-mark-coordinates.mjs', 'viewer-mark-geojson.mjs', 'utm-conversion.mjs'];

function page() {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css">${style}</head><body>
<div id="main" style="height:100vh;display:flex"><aside id="sidebar" style="overflow:auto"><div id="sidebar-custom">
<div class="panel" id="panel-marks" hidden><h3>Marks</h3><div data-marks-root></div></div></div></aside>
<div id="viewer-wrap" style="flex:1"><div id="leaflet-map" style="display:block;height:100%"></div></div></div>
<script type="module">
import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
import { mountViewerMarks } from '/viewer-marks.mjs';
const map = L.map('leaflet-map').setView([43.05, -87.0], 18);
const marks = mountViewerMarks({ panel: document.getElementById('panel-marks'), L, getMap: () => map,
  request: () => { throw new Error('temporary marks must not reach an API'); },
  georef: () => ({ epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' }), units: () => 'imperial' });
map.on('click', e => marks.mapClick(e.latlng));
map.on('dblclick', e => { if (marks.mapDoubleClick()) L.DomEvent.stop(e); });
marks.setView({ map: true });
await marks.setScope({ mode: 'temporary', key: 'public' });
window.map = map; window.marks = marks;
document.body.dataset.ready = 'true';
</script></body></html>`;
}

test('marks: place, type, drag, draw, label and undo on a Leaflet map', { timeout: 90000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated marks check.'); return; }
  if (!existsSync(path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet-src.esm.js'))) { t.skip('npm ci is required.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page()); return; }
      const allowed = new Set([...MODULES.map(name => '/' + name), '/node_modules/leaflet/dist/leaflet-src.esm.js', '/node_modules/leaflet/dist/leaflet.css']);
      if (!allowed.has(url.pathname)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-marks-'));
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    const size = (width, height, mobile = false) => client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const waitFor = async (expression, label, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (await client.evaluate(expression)) return; await delay(50); }
      assert.fail(`timed out: ${label}`);
    };
    const mouse = (type, x, y, extra = {}) => client.command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    const click = async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); };
    const mapPoint = async (lat, lng) => client.evaluate(`(() => { const p = map.latLngToContainerPoint([${lat}, ${lng}]), r = map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; })()`);
    const press = selector => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(), 0`);
    const button = text => `[...document.querySelectorAll('#panel-marks button')].find(b => b.textContent === ${JSON.stringify(text)} && !b.closest('[hidden]'))`;
    const pressText = text => client.evaluate(`${button(text)}.click(), 0`);
    const state = () => client.evaluate('JSON.parse(JSON.stringify(marks.store.state.marks))');

    await size(1280, 760);
    await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
    await waitFor("document.body?.dataset.ready === 'true'", 'page ready');
    assert.equal(await client.evaluate("document.getElementById('panel-marks').hidden"), false);

    // Click to place a pin, label it and save.
    await pressText('Pin');
    const [x, y] = await mapPoint(43.05, -87.0);
    await click(x, y);
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'editor open');
    await client.evaluate(`(() => { const i = document.querySelector('.viewer-mark-form [name=name]'); i.value = 'North <b>gate</b>'; i.dispatchEvent(new Event('input')); })()`);
    await client.evaluate(`document.querySelector('.viewer-mark-form [name=elevation]').value = '820.21'`);
    await pressText('Save');
    await waitFor('marks.store.state.marks.length === 1', 'pin saved');
    let saved = (await state())[0];
    assert.equal(saved.name, 'North <b>gate</b>');
    assert.ok(Math.abs(saved.elevationNavd88M - 250) < 0.01, 'NAVD88 elevation stored in metres');
    assert.ok(Math.abs(saved.geometry.coordinates[1] - 43.05) < 1e-5);
    assert.equal(await client.evaluate("document.querySelector('.viewer-mark-label')?.textContent"), 'North <b>gate</b>', 'labels are text');
    assert.equal(await client.evaluate("document.querySelector('.viewer-mark-label b')"), null);

    // Drag the pin; undo puts it back.
    const placedLon = saved.geometry.coordinates[0];
    await mouse('mousePressed', x, y);
    for (let step = 1; step <= 5; step++) await mouse('mouseMoved', x + step * 12, y + step * 8);
    await mouse('mouseReleased', x + 60, y + 40);
    await waitFor('marks.store.state.marks[0].revision === 2', 'drag saved');
    saved = (await state())[0];
    assert.ok(saved.geometry.coordinates[0] > placedLon, 'moved east');
    await pressText('Undo');
    await waitFor(`marks.store.state.marks[0].geometry.coordinates[0] === ${placedLon}`, 'undo move');

    // Typed DMS places a second pin.
    await client.evaluate(`(() => { const i = document.querySelector('[name=coordinates]'); i.value = \`43°03'01"N 87°00'02"W\`; i.dispatchEvent(new Event('input')); })()`);
    assert.match(await client.evaluate("document.querySelector('.viewer-mark-coords .hint').textContent"), /^DMS: 43\.0502/);
    await pressText('Place pin');
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'typed editor');
    await pressText('Save');
    await waitFor('marks.store.state.marks.length === 2', 'typed pin');

    // Draw an area by clicking corners, then finish.
    await pressText('Area');
    for (const [lat, lng] of [[43.0502, -87.0004], [43.0502, -86.9996], [43.0497, -86.9996]]) await click(...await mapPoint(lat, lng));
    await pressText('Finish');
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'area editor');
    await pressText('Save');
    await waitFor('marks.store.state.marks.length === 3', 'area saved');
    assert.equal((await state())[2].geometry.coordinates[0].length, 4);

    // Labels toggle and list zoom.
    await client.evaluate("(() => { const c = document.querySelector('.viewer-mark-toggle input'); c.click(); })()");
    // Leaflet fades tooltips out over 200 ms before removing them.
    await waitFor("document.querySelectorAll('.viewer-mark-label').length === 0", 'labels off');
    assert.equal(await client.evaluate("document.querySelectorAll('.viewer-mark-list-item').length"), 3);

    // Delete asks twice.
    await press('.viewer-mark-list-item');
    await pressText('Delete');
    assert.equal((await state()).length, 3);
    await pressText('Tap again to delete');
    await waitFor('marks.store.state.marks.length === 2', 'deleted');

    // Phone width: the panel fits without horizontal scrolling.
    await size(375, 740, true);
    await delay(100);
    assert.equal(await client.evaluate("document.getElementById('panel-marks').scrollWidth <= document.getElementById('panel-marks').clientWidth + 1"), true);
  } finally {
    client?.close();
    if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
    server?.close();
    if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ } }
    await unlock();
  }
});
