// Isolated browser checks of the Marks panel on a real Leaflet map, using the
// shared headless-browser harness.
//   1. Public link (temporary marks, no API).
//   2. Signed-in client against the real Marks API on an in-memory database:
//      map-click and typed decimal pins survive a reload, and a coordinate edit
//      is re-read at Save/Enter so stale or invalid text is never written.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnBrowser, stopBrowser } from './browser-launch.mjs';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import express from 'express';
import auth from '../server/auth.js';
import api from '../server/viewerMarkApi.js';
import schema from '../server/viewerMarkSchema.js';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as Cdp } from './bounded-test-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync) || null;
const MODULES = ['viewer-marks.mjs', 'viewer-marks-store.mjs', 'viewer-mark-map-layer.mjs', 'viewer-mark-icons.mjs', 'viewer-mark-style.mjs', 'viewer-mark-draft-recovery.mjs', 'viewer-mark-visibility.mjs',
  'viewer-mark-coordinates.mjs', 'viewer-mark-geojson.mjs', 'utm-conversion.mjs'];
const SESSION_TOKEN = 'synthetic-browser-session-token-0001';

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
const signedIn = new URLSearchParams(location.search).get('mode') === 'session';
const map = L.map('leaflet-map').setView([43.05, -87.0], 18);
const marks = mountViewerMarks({ panel: document.getElementById('panel-marks'), L, getMap: () => map,
  request: signedIn ? (url, init) => fetch(url, init) : () => { throw new Error('temporary marks must not reach an API'); },
  georef: () => ({ epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' }), units: () => 'imperial' });
map.on('click', e => marks.mapClick(e.latlng));
map.on('dblclick', e => { if (marks.mapDoubleClick()) L.DomEvent.stop(e); });
marks.setView({ map: true });
await marks.setScope(signedIn ? { mode: 'session', key: 'client', token: () => '${SESSION_TOKEN}' } : { mode: 'temporary', key: 'public' });
window.map = map; window.marks = marks;
document.body.dataset.ready = 'true';
</script></body></html>`;
}

// A signed-in client on a direct grant, against the real Marks API.
function marksApi() {
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model');");
  database.exec(schema.VIEWER_MARKS_SQL);
  const session = { audience: 'client', subject: 'client:synthetic-person', modelId: 'synthetic-model', modelVersionId: 'synthetic-v1',
    permissions: { view: true, measure: true, personalMeasurements: true },
    sourceAuthorization: { type: 'direct_client_grant', id: 'synthetic-grant', version: 1 } };
  const repository = {
    database,
    getViewerSessionByHash: hash => (hash === auth.hashToken(SESSION_TOKEN) ? session : null),
    viewerSessionLive: () => true,
    getModel: () => ({ status: 'ready', activeVersion: { id: 'synthetic-v1', status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marks', api.createViewerMarkApi(repository));
  return { app, database };
}

async function withBrowser(t, { app = null } = {}, run) {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated marks check.'); return; }
  if (!existsSync(path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet-src.esm.js'))) { t.skip('npm ci is required.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
      if (app && url.pathname.startsWith('/api/v1/marks')) { app(req, res); return; }
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page()); return; }
      const allowed = new Set([...MODULES.map(name => '/' + name), '/node_modules/leaflet/dist/leaflet-src.esm.js', '/node_modules/leaflet/dist/leaflet.css']);
      if (!allowed.has(url.pathname)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-marks-'));
    browser = spawnBrowser(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    const waitFor = async (expression, label, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (await client.evaluate(expression)) return; await delay(50); }
      assert.fail(`timed out: ${label}`);
    };
    const mouse = (type, x, y, extra = {}) => client.command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    const button = text => `[...document.querySelectorAll('#panel-marks button')].find(b => b.textContent === ${JSON.stringify(text)} && !b.closest('[hidden]'))`;
    const h = {
      client, waitFor, mouse,
      size: (width, height, mobile = false) => client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }),
      load: async (query = '') => {
        await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${query}` });
        await waitFor("document.body?.dataset.ready === 'true'", 'page ready');
      },
      click: async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); },
      mapPoint: (lat, lng) => client.evaluate(`(() => { const p = map.latLngToContainerPoint([${lat}, ${lng}]), r = map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; })()`),
      press: selector => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(), 0`),
      pressText: text => client.evaluate(`${button(text)}.click(), 0`),
      // Sets a field's text without firing input/change, like typing then pressing Enter at once.
      setQuietly: (selector, value) => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}, 0`),
      type: (selector, value) => client.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`),
      state: () => client.evaluate('JSON.parse(JSON.stringify(marks.store.state.marks))'),
      editorOpen: () => client.evaluate("!document.querySelector('.viewer-mark-form').hidden"),
      status: () => client.evaluate("document.querySelector('.viewer-mark-status').textContent"),
    };
    await h.size(1280, 760);
    await run(h);
  } finally {
    client?.close();
    stopBrowser(browser);
    if (browser && browser.exitCode === null) { await new Promise(resolve => browser.once('exit', resolve)); }
    server?.close();
    if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ } }
    await unlock();
  }
}

test('marks: place, type, drag, draw, label and undo on a Leaflet map', { timeout: 90000 }, t => withBrowser(t, {}, async h => {
  const { client, waitFor, mouse } = h;
  await h.load();
  assert.equal(await client.evaluate("document.getElementById('panel-marks').hidden"), false);

  // Click to place a pin, label it and save.
  await h.pressText('Pin');
  const [x, y] = await h.mapPoint(43.05, -87.0);
  await h.click(x, y);
  await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'editor open');
  await h.type('.viewer-mark-form [name=name]', 'North <b>gate</b>');
  await h.setQuietly('.viewer-mark-form [name=elevation]', '820.21');
  await h.pressText('Save');
  await waitFor('marks.store.state.marks.length === 1', 'pin saved');
  let saved = (await h.state())[0];
  assert.equal(saved.name, 'North <b>gate</b>');
  assert.ok(Math.abs(saved.elevationNavd88M - 250) < 0.01, 'NAVD88 elevation stored in metres');
  assert.ok(Math.abs(saved.geometry.coordinates[1] - 43.05) < 1e-5);
  assert.equal(await client.evaluate("document.querySelector('.viewer-mark-label')?.textContent"), 'North <b>gate</b>', 'labels are text');
  assert.equal(await client.evaluate("document.querySelector('.viewer-mark-label b')"), null);

  // A drag without Move pans the map and writes nothing.
  await mouse('mousePressed', x, y);
  for (let step = 1; step <= 5; step++) await mouse('mouseMoved', x + step * 4, y);
  await mouse('mouseReleased', x + 20, y);
  await delay(300);
  assert.equal(await client.evaluate('marks.store.state.marks[0].revision'), 1);

  // Move, drag and Save; undo puts it back.
  await client.evaluate('map.setView([43.05, -87.0], 18, { animate: false }), 0');
  if (await client.evaluate("document.querySelector('.viewer-mark-form').hidden")) await h.press('#viewer-marks-list .viewer-mark-list-item');
  await client.evaluate('map.setView([43.05, -87.0], 18, { animate: false }), 0');
  await h.pressText('Move');
  const placedLon = saved.geometry.coordinates[0];
  await mouse('mousePressed', x, y);
  for (let step = 1; step <= 5; step++) await mouse('mouseMoved', x + step * 12, y + step * 8);
  await mouse('mouseReleased', x + 60, y + 40);
  await h.pressText('Save');
  await waitFor('marks.store.state.marks[0].revision === 2', 'move saved');
  saved = (await h.state())[0];
  assert.ok(saved.geometry.coordinates[0] > placedLon, 'moved east');
  await h.pressText('Undo');
  await waitFor(`marks.store.state.marks[0].geometry.coordinates[0] === ${placedLon}`, 'undo move');

  // Typed DMS places a second pin.
  await h.type('[name=coordinates]', `43°03'01"N 87°00'02"W`);
  assert.match(await client.evaluate("document.querySelector('.viewer-mark-coords .hint').textContent"), /^DMS: 43\.0502/);
  await h.pressText('Place pin');
  await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'typed editor');
  await h.pressText('Save');
  await waitFor('marks.store.state.marks.length === 2', 'typed pin');

  // Draw an area by clicking corners, then finish.
  await h.pressText('Area');
  for (const [lat, lng] of [[43.0502, -87.0004], [43.0502, -86.9996], [43.0497, -86.9996]]) await h.click(...await h.mapPoint(lat, lng));
  await h.pressText('Finish');
  await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'area editor');
  await h.pressText('Save');
  await waitFor('marks.store.state.marks.length === 3', 'area saved');
  assert.equal((await h.state())[2].geometry.coordinates[0].length, 4);

  // Labels toggle and list zoom.
  await client.evaluate("document.querySelector('.viewer-mark-toggle input').click(), 0");
  // Leaflet fades tooltips out over 200 ms before removing them.
  await waitFor("document.querySelectorAll('.viewer-mark-label').length === 0", 'labels off');
  assert.equal(await client.evaluate("document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item').length"), 3);

  // Delete asks twice.
  await h.press('#viewer-marks-list .viewer-mark-list-item');
  await h.pressText('Delete');
  assert.equal((await h.state()).length, 3);
  await h.pressText('Tap again to delete');
  await waitFor('marks.store.state.marks.length === 2', 'deleted');

  // Phone width: the panel fits without horizontal scrolling.
  await h.size(375, 740, true);
  await delay(100);
  assert.equal(await client.evaluate("document.getElementById('panel-marks').scrollWidth <= document.getElementById('panel-marks').clientWidth + 1"), true);
}));

test('signed-in client: map-click and typed pins survive a reload at full precision; coordinate edits are re-read at Save and Enter', { timeout: 90000 }, async t => {
  const { app, database } = marksApi();
  t.after(() => database.close());
  const stored = () => database.prepare("SELECT id, visibility, revision, document_json FROM viewer_marks WHERE deleted_at IS NULL ORDER BY created_at, id").all()
    .map(row => ({ ...row, ...JSON.parse(row.document_json) }));
  await withBrowser(t, { app }, async h => {
    const { waitFor } = h;
    await h.load('?mode=session');
    await waitFor('marks.store.state.ready', 'marks loaded');

    // Map click with the default generic label.
    await h.pressText('Pin');
    await h.click(...await h.mapPoint(43.05, -87.0));
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'editor open');
    assert.equal(await h.client.evaluate("document.querySelector('.viewer-mark-form [name=name]').value"), 'Pin', 'labels stay generic');
    assert.equal(await h.client.evaluate("document.querySelector('.viewer-mark-form [name=visibility]').value"), 'private', 'Only me by default');
    await h.pressText('Save');
    await waitFor('marks.store.state.marks.length === 1', 'clicked pin saved');

    // Decimal coordinates (8 places) with a label the client chose.
    await h.type('[name=coordinates]', '43.05031234, -86.99971234');
    await h.pressText('Place pin');
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'typed editor');
    await h.type('.viewer-mark-form [name=name]', 'Tree stand');
    await h.pressText('Save');
    await waitFor('marks.store.state.marks.length === 2', 'typed pin saved');
    let rows = stored();
    assert.deepEqual(rows.map(row => [row.name, row.visibility]), [['Pin', 'private'], ['Tree stand', 'private']]);
    assert.deepEqual(rows[1].geometry.coordinates, [-86.99971234, 43.05031234], 'typed 8-decimal input is kept exactly');

    // Reload: both come back from the server.
    await h.load('?mode=session');
    await waitFor('marks.store.state.ready && marks.store.state.marks.length === 2', 'marks after reload');
    assert.deepEqual((await h.state()).map(mark => mark.name), ['Pin', 'Tree stand']);
    const treeStand = rows[1];

    const openTreeStand = async () => {
      await h.client.evaluate(`[...document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item')].find(b => b.textContent.includes('Tree stand')).click(), 0`);
      await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'edit open');
    };

    // Rename only: the geometry round-trips exactly (no 6-decimal rounding).
    await openTreeStand();
    assert.equal(await h.client.evaluate("document.querySelector('.viewer-mark-form [name=pointCoordinates]').value"), '43.05031234, -86.99971234');
    await h.type('.viewer-mark-form [name=name]', 'Tree stand north');
    await h.pressText('Save');
    await waitFor("document.querySelector('.viewer-mark-form').hidden", 'rename saved');
    rows = stored();
    assert.equal(rows[1].name, 'Tree stand north');
    assert.equal(rows[1].revision, 2);
    assert.deepEqual(rows[1].geometry.coordinates, [-86.99971234, 43.05031234], 'label-only save keeps exact geometry');
    await h.load('?mode=session');
    await waitFor('marks.store.state.ready && marks.store.state.marks.length === 2', 'marks after second reload');
    assert.deepEqual((await h.state())[1].geometry.coordinates, [-86.99971234, 43.05031234]);

    // Invalid text, Save without a change event: nothing is written and the editor stays open.
    await openTreeStand();
    await h.setQuietly('.viewer-mark-form [name=pointCoordinates]', 'not a place');
    await h.pressText('Save');
    await delay(200);
    assert.equal(await h.editorOpen(), true);
    assert.match(await h.status(), /latitude|letter|numbers/i);
    assert.equal(stored()[1].revision, 2, 'Save wrote nothing');
    // Same with Enter (implicit form submission).
    await h.client.evaluate("document.querySelector('.viewer-mark-form').requestSubmit(), 0");
    await delay(200);
    assert.equal(await h.editorOpen(), true);
    assert.equal(stored()[1].revision, 2, 'Enter wrote nothing');

    // Valid new text, Enter without a change event: the typed position is saved, not the old one.
    await h.setQuietly('.viewer-mark-form [name=pointCoordinates]', '43.05041234, -86.99961234');
    await h.client.evaluate("document.querySelector('.viewer-mark-form').requestSubmit(), 0");
    await waitFor("document.querySelector('.viewer-mark-form').hidden", 'editor closed after save');
    rows = stored();
    assert.equal(rows[1].id, treeStand.id);
    assert.equal(rows[1].revision, 3);
    assert.deepEqual(rows[1].geometry.coordinates, [-86.99961234, 43.05041234]);
    assert.equal(rows[1].visibility, 'private');
  });
});

// Keyboard and touch on real Leaflet markers.
test('marks: pins by keyboard and by touch', { timeout: 90000 }, async t => {
  await withBrowser(t, {}, async h => {
    const { client, waitFor } = h;
    const key = async (name, code) => {
      for (const type of ['keyDown', 'keyUp']) await client.command('Input.dispatchKeyEvent', { type, key: name, code: code || name, windowsVirtualKeyCode: { Enter: 13, ArrowRight: 39, ArrowLeft: 37, Tab: 9 }[name] });
    };
    const place = async (lat, lng, name) => {
      await h.type('[name=coordinates]', `${lat}, ${lng}`);
      await h.pressText('Place pin');
      await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'editor');
      await h.type('.viewer-mark-form [name=name]', name);
    };
    const stops = () => client.evaluate("[...document.querySelectorAll('.viewer-map-mark')].map(p => [p.getAttribute('aria-label').split(',')[0], p.getAttribute('tabindex')])");
    const centre = () => client.evaluate("map.setView([43.05, -87.0], 19, { animate: false }), [map.getCenter().lat, map.getCenter().lng]");
    const focused = () => client.evaluate("document.activeElement.getAttribute('aria-label')?.split(',')[0] || document.activeElement.name || null");
    await h.load();
    await place(43.05, -87.0002, 'West');
    await h.pressText('Save');
    await waitFor('marks.store.state.marks.length === 1', 'first');
    await place(43.05, -86.9998, 'East');
    await h.pressText('Save');
    await waitFor('marks.store.state.marks.length === 2', 'second');

    // One tab stop among the saved pins; the pin being placed is none.
    await place(43.0502, -87.0, 'New');
    const before = Object.fromEntries(await stops());
    assert.deepEqual([before.West, before.East].sort(), ['-1', '0']);
    assert.deepEqual(Object.values(before).filter(value => value === null).length, 1, JSON.stringify(before));
    await h.pressText('Close');
    const view = await centre();
    await client.evaluate("[...document.querySelectorAll('.viewer-map-mark')].find(p => p.getAttribute('aria-label').startsWith('West')).focus(), 0");
    assert.equal(await focused(), 'West');
    await key('ArrowRight');
    assert.equal(await focused(), 'East');
    await delay(400);
    assert.deepEqual(await client.evaluate('[map.getCenter().lat, map.getCenter().lng]'), view, 'the arrows move between pins, not the map');
    assert.deepEqual(await stops(), [['West', '-1'], ['East', '0']]);
    const element = "window.east = document.activeElement, 0";
    await client.evaluate(element);
    await key('Enter');
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'opened by Enter');
    assert.equal(await client.evaluate("document.querySelector('.viewer-mark-form [name=name]').value"), 'East');
    assert.equal(await client.evaluate('window.east.isConnected && document.activeElement === window.east'), true, 'the same pin, still focused');
    await h.pressText('Close');

    // Touch: 44 px around the pin, a tap opens, a swipe from a pin pans and moves nothing.
    await client.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await centre();
    const box = await client.evaluate("(() => { const r = [...document.querySelectorAll('.viewer-map-mark')].find(p => p.getAttribute('aria-label').startsWith('West')).getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()");
    for (const [dx, dy] of [[-20, -4], [20, -4], [0, -24], [0, 16]]) {
      assert.equal(await client.evaluate(`document.elementFromPoint(${box[0] + dx}, ${box[1] + dy}).closest('.viewer-map-mark')?.getAttribute('aria-label').split(',')[0]`), 'West', `${dx},${dy}`);
    }
    const touch = (type, points) => client.command('Input.dispatchTouchEvent', { type, touchPoints: points });
    await touch('touchStart', [{ x: box[0], y: box[1] }]);
    await touch('touchEnd', []);
    await waitFor("document.querySelector('.viewer-mark-form [name=name]').value === 'West' && !document.querySelector('.viewer-mark-form').hidden", 'opened by tap');
    await h.pressText('Close');
    await touch('touchStart', [{ x: box[0], y: box[1] }]);
    for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: box[0] + step * 12, y: box[1] }]);
    await touch('touchEnd', []);
    await delay(500);
    assert.deepEqual((await h.state()).map(mark => mark.revision), [1, 1], 'a swipe writes nothing');
    assert.equal(await h.editorOpen(), false);
  });
});
