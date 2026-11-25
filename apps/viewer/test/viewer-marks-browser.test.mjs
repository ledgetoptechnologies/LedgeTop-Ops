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
const MODULES = ['viewer-marks.mjs', 'viewer-marks-store.mjs', 'viewer-mark-map-layer.mjs', 'viewer-mark-icons.mjs', 'viewer-mark-style.mjs', 'viewer-mark-draft-recovery.mjs', 'viewer-mark-dom.mjs', 'viewer-mark-picker.mjs', 'viewer-mark-visibility.mjs',
  'viewer-mark-coordinates.mjs', 'viewer-mark-geojson.mjs', 'utm-conversion.mjs', 'server/viewerMarkGeometry.mjs'];
const SESSION_TOKEN = 'synthetic-browser-session-token-0001';
const STAFF_TOKEN = 'synthetic-browser-staff-session-0001';

function page() {
  const html = readFileSync(path.join(root, 'index.html'), 'utf8');
  const style = html.match(/<style>[\s\S]*?<\/style>/)[0];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/node_modules/leaflet/dist/leaflet.css">${style}</head><body>
<div id="main" style="height:100vh;display:flex"><aside id="sidebar" style="overflow:auto"><div id="sidebar-custom">
<div class="panel" id="panel-marks" hidden><h3>Marks</h3><div data-marks-root></div></div></div></aside>
<div id="viewer-wrap" style="flex:1"><div id="leaflet-map" style="display:block;height:100%"></div><div id="viewer-marks-ui"></div></div></div>
<script type="module">
import * as L from '/node_modules/leaflet/dist/leaflet-src.esm.js';
import { mountViewerMarks } from '/viewer-marks.mjs';
const mode = new URLSearchParams(location.search).get('mode');
const signedIn = mode === 'session' || mode === 'staff';
const map = L.map('leaflet-map').setView([43.05, -87.0], 18);
let lostMethod;
window.dropMarkAnswer = method => { lostMethod = method; };
async function request(url, init) {
  const response = await fetch(url, init);
  if (response.ok && init.method === lostMethod) {
    lostMethod = undefined;
    throw new TypeError('Fixture dropped a committed answer');
  }
  return response;
}
const marks = mountViewerMarks({ panel: document.getElementById('panel-marks'), overlay: document.getElementById('viewer-marks-ui'), L, getMap: () => map,
  request: signedIn ? request : () => { throw new Error('temporary marks must not reach an API'); },
  georef: () => ({ epsg: 32616, utmZoneLon0Deg: -87, hemisphere: 'N' }), units: () => 'imperial' });
map.on('click', e => marks.mapClick(e.latlng));
map.on('contextmenu', e => { if (marks.mapContextMenu(e.latlng)) L.DomEvent.stop(e); });
map.on('dblclick', e => { if (marks.mapDoubleClick()) L.DomEvent.stop(e); });
marks.setView({ map: true });
await marks.setScope(signedIn ? { mode: 'session', key: mode, token: () => mode === 'staff' ? '${STAFF_TOKEN}' : '${SESSION_TOKEN}' }
  : { mode: 'temporary', key: 'public' });
window.map = map; window.marks = marks;
document.body.dataset.ready = 'true';
</script></body></html>`;
}

// A signed-in client on a direct grant, against the real Marks API.
function marksApi() {
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE models(id TEXT PRIMARY KEY); INSERT INTO models VALUES ('synthetic-model');");
  database.exec(schema.VIEWER_MARKS_SQL + schema.VIEWER_MARK_SHARING_SQL);
  const session = { audience: 'client', subject: 'client:synthetic-person', modelId: 'synthetic-model', modelVersionId: 'synthetic-v1',
    permissions: { view: true, measure: true, personalMeasurements: true },
    sourceAuthorization: { type: 'direct_client_grant', id: 'synthetic-grant', version: 1 } };
  const sessions = new Map([
    [auth.hashToken(SESSION_TOKEN), session],
    [auth.hashToken(STAFF_TOKEN), { ...session, audience: 'ops', subject: 'ops:synthetic-staff', sourceAuthorization: null }],
  ]);
  const repository = {
    database,
    getViewerSessionByHash: hash => sessions.get(hash),
    viewerSessionLive: () => true,
    getModel: () => ({ status: 'ready', activeVersion: { id: 'synthetic-v1', status: 'ready' } }),
    rateLimited: () => false,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1/marks', api.createViewerMarkApi(repository));
  return { app, database };
}

// What the page and the server saw since the last navigation, for a check that timed
// out: console, errors, dialogs and requests. Paths and statuses only, no headers or bodies.
function recordPage(client, served) {
  let from = 0, navigated = '';
  const short = (value, max = 300) => String(value ?? '').replace(/http:\/\/127\.0\.0\.1:\d+/g, '').slice(0, max);
  return {
    start(query) { from = client.events.length; served.length = 0; navigated = query; },
    committed: loaderId => client.events.slice(from).some(({ method, params }) => method === 'Page.frameNavigated' && !params.frame.parentId && params.frame.loaderId === loaderId),
    async report() {
      const lines = [`navigated to /${navigated}`], requests = new Map();
      for (const { method, params } of client.events.slice(from)) {
        if (method === 'Runtime.consoleAPICalled') lines.push(`console.${params.type}: ${short(params.args.map(arg => arg.value ?? arg.description).join(' '))}`);
        if (method === 'Runtime.exceptionThrown') lines.push(`exception: ${short(params.exceptionDetails.exception?.description || params.exceptionDetails.text, 800)}`);
        if (method === 'Log.entryAdded') lines.push(`log ${params.entry.level}: ${short(params.entry.text)} ${short(params.entry.url)}`);
        if (method === 'Page.javascriptDialogOpening') lines.push(`dialog ${params.type}: ${short(params.message)}`);
        if (method === 'Page.frameNavigated') lines.push(`frame: ${short(params.frame.url)} ${short(params.frame.unreachableUrl)}`);
        if (method === 'Network.requestWillBeSent') requests.set(params.requestId, { what: `${params.request.method} ${short(params.request.url)}`, how: 'no answer' });
        const request = requests.get(params?.requestId);
        if (request && method === 'Network.responseReceived') request.how = `${params.response.status}, body unfinished`;
        if (request && method === 'Network.loadingFinished') request.how = request.how.replace(', body unfinished', ' done');
        if (request && method === 'Network.loadingFailed') request.how = `failed ${params.errorText}${params.canceled ? ' (canceled)' : ''}`;
      }
      for (const { what, how } of requests.values()) lines.push(`request ${what}: ${how}`);
      for (const { what, how } of served) lines.push(`server ${what}: ${how}`);
      const page = `(() => { const state = window.marks?.store.state; return JSON.stringify({ at: location.pathname + location.search, readyState: document.readyState,
        body: Boolean(document.body), ready: document.body?.dataset.ready, old: Boolean(document.leftByTest), map: typeof window.map, marks: state && { ready: state.ready, loading: state.loading, busy: state.busy, message: state.message, count: state.marks.length },
        kept: Object.keys(sessionStorage), form: document.querySelector('.viewer-mark-form')?.hidden }); })()`;
      lines.push(`page: ${await client.evaluate(page).catch(error => 'not readable: ' + short(error.message))}`);
      return lines.join('\n  ');
    },
  };
}

// The browser can answer before it has a page to drive.
async function pageTab(port, ms = 8000) {
  const deadline = Date.now() + ms;
  let last = 'no page tab';
  while (Date.now() < deadline) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json();
      const url = tabs.find(tab => tab.type === 'page')?.webSocketDebuggerUrl;
      if (url) return url;
      last = `no page tab among ${tabs.length}`;
    } catch (error) { last = error.message; }
    await delay(50);
  }
  assert.fail(`timed out: browser page tab (${last})`);
}

async function withBrowser(t, { app = null } = {}, run) {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated marks check.'); return; }
  if (!existsSync(path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet-src.esm.js'))) { t.skip('npm ci is required.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  const served = [];
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      const entry = { what: `${req.method} ${url.pathname}`, how: 'not answered' };
      served.push(entry);
      res.on('finish', () => { entry.how = `${res.statusCode} sent`; });
      res.on('close', () => { if (!res.writableFinished) entry.how = 'connection closed first'; });
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
    browser = spawnBrowser(binary, ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    client = await Cdp.connect(await pageTab(port));
    for (const domain of ['Page', 'Runtime', 'Log', 'Network']) await client.command(domain + '.enable');
    const recorded = recordPage(client, served);
    const waitFor = async (expression, label, ms = 8000) => {
      const deadline = Date.now() + ms;
      const met = typeof expression === 'function' ? expression : () => client.evaluate(expression);
      while (Date.now() < deadline) { if (await met()) return; await delay(50); }
      assert.fail(`timed out: ${label}\n  ${await recorded.report()}`);
    };
    const mouse = (type, x, y, extra = {}) => client.command('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1, ...extra });
    const button = text => `[...document.querySelectorAll('#panel-marks button, #viewer-marks-ui button')].find(b => b.textContent === ${JSON.stringify(text)} && !b.closest('[hidden]:not(.viewer-mark-box)'))`; // the Marks pop-up may be closed
    const h = {
      client, waitFor, mouse,
      // What the Marks API was asked since the last load.
      asked: () => served.map(entry => entry.what).filter(what => what.includes('/api/')).map(what => what.replace(/[0-9a-f-]{36}/, ':id')),
      size: (width, height, mobile = false) => client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile }),
      load: async (query = '') => {
        // Only the new document counts: the one being left is ready too, and may still answer.
        await client.evaluate('document.leftByTest = true, 0');
        recorded.start(query);
        const { errorText, loaderId } = await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${query}` });
        if (errorText || !loaderId) assert.fail(`navigation failed: ${errorText || 'no new document'}\n  ${await recorded.report()}`);
        await waitFor(() => recorded.committed(loaderId), 'new page committed');
        await waitFor(() => client.evaluate("!document.leftByTest && document.body?.dataset.ready === 'true'")
          // The old document's context can go away under the question.
          .catch(error => { if (/execution context|find .*context|navigated/i.test(error.message)) return false; throw error; }), 'page ready');
      },
      click: async (x, y) => { await mouse('mousePressed', x, y); await mouse('mouseReleased', x, y); },
      mapPoint: (lat, lng) => client.evaluate(`(() => { const p = map.latLngToContainerPoint([${lat}, ${lng}]), r = map.getContainer().getBoundingClientRect(); return [r.left + p.x, r.top + p.y]; })()`),
      press: selector => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(), 0`),
      pressText: text => client.evaluate(`${button(text)}.click(), 0`),
      // Sets a field's text without firing input/change, like typing then pressing Enter at once.
      setQuietly: (selector, value) => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).value = ${JSON.stringify(value)}, 0`),
      type: (selector, value) => client.evaluate(`(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input')); })()`),
      labels: mode => client.evaluate(`(() => { const s = document.querySelector('[name=labels]'); s.value = '${mode}'; s.dispatchEvent(new Event('change')); })()`),
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

  // Click to place a pin, label it and save. Only the selected mark has a label unless they are on.
  await h.labels('on');
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
  // Names are put on the map once it has settled.
  await waitFor("[...document.querySelectorAll('.viewer-mark-label')].some(label => label.textContent === 'North <b>gate</b>')", 'labels are text');
  assert.equal(await client.evaluate("document.querySelector('.viewer-mark-label b')"), null);

  // A drag without Move pans the map and writes nothing.
  await mouse('mousePressed', x, y);
  for (let step = 1; step <= 5; step++) await mouse('mouseMoved', x + step * 4, y);
  await mouse('mouseReleased', x + 20, y);
  await delay(300);
  assert.equal(await client.evaluate('marks.store.state.marks[0].revision'), 1);

  // Move, drag and Save; undo puts it back.
  await client.evaluate('map.setView([43.05, -87.0], 18, { animate: false }), 0');
  await client.evaluate('map.setView([43.05, -87.0], 18, { animate: false }), 0');
  await h.press('#viewer-marks-list .viewer-mark-list-item');
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
  await h.labels('off');
  // Leaflet fades tooltips out over 200 ms before removing them.
  await waitFor("document.querySelectorAll('.viewer-mark-label').length === 0", 'labels off');
  assert.equal(await client.evaluate("document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item').length"), 3);

  // Delete is at once, and the bar takes it back.
  await h.press('#viewer-marks-list .viewer-mark-list-item');
  await h.pressText('Delete');
  await waitFor('marks.store.state.marks.length === 2', 'deleted once');
  await client.evaluate("document.querySelector('.viewer-mark-undo button').click(), 0");
  await waitFor('marks.store.state.marks.length === 3', 'taken back');
  await h.press('#viewer-marks-list .viewer-mark-list-item');
  await h.pressText('Delete');
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
      await h.pressText('Edit');
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

    // Opening and editing a mark asks the server nothing; a save is one request.
    assert.deepEqual(h.asked(), ['GET /api/v1/marks', 'GET /api/v1/marks/shared']);
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
    assert.deepEqual(h.asked(), ['GET /api/v1/marks', 'GET /api/v1/marks/shared', 'PUT /api/v1/marks/:id']);
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
      for (const type of ['keyDown', 'keyUp']) await client.command('Input.dispatchKeyEvent', { type, key: name, code: code || name, windowsVirtualKeyCode: { Enter: 13, ArrowRight: 39, ArrowLeft: 37, Tab: 9, Escape: 27 }[name] });
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
    await h.pressText('Cancel');
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
    await waitFor("!document.querySelector('.viewer-mark-view').hidden", 'opened by Enter');
    assert.equal(await client.evaluate("document.querySelector('.viewer-mark-view h4').textContent"), 'East');
    assert.equal(await client.evaluate('document.activeElement.textContent'), 'Edit');
    await key('Escape');
    await waitFor("document.querySelector('.viewer-mark-card').hidden", 'closed by Escape');
    assert.equal(await client.evaluate('window.east.isConnected && document.activeElement === window.east'), true, 'the same pin, focused again');

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
    await waitFor("document.querySelector('.viewer-mark-view h4').textContent === 'West'", 'opened by tap');
    await h.press('[aria-label=Close]');
    await touch('touchStart', [{ x: box[0], y: box[1] }]);
    for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: box[0] + step * 12, y: box[1] }]);
    await touch('touchEnd', []);
    await delay(500);
    assert.deepEqual((await h.state()).map(mark => mark.revision), [1, 1], 'a swipe writes nothing');
    assert.equal(await h.editorOpen(), false);
    // Holding a finger on the map opens a draft (the browser's own contextmenu) and saves nothing.
    await client.evaluate("map.getContainer().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 700, clientY: 300 })), 0");
    await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'draft from a hold');
    await h.pressText('Cancel');
    assert.equal((await h.state()).length, 2);
  });
});

// The list comes from the authorized store, not the viewport or map layers.
// These responses are a local UI fixture, not a change to server authorization.
for (const writable of [true, false]) {
  test(`marks list: all supplied model marks, phone navigation and ${writable ? 'staff' : 'view-only'} actions`, { timeout: 90000 }, async t => {
    const category = { id: 'synthetic-category', name: 'Synthetic survey', color: '#1565c0', icon: 'target', mine: true, editable: writable };
    const base = { color: '#1565c0', icon: 'target', categoryId: category.id, note: '', revision: 1,
      visibility: 'private', mine: true, editable: writable, author: 'staff', elevationNavd88M: null };
    const supplied = [
      { ...base, id: 'near', name: 'Near pin', geometry: { type: 'Point', coordinates: [-87, 43.05] } },
      { ...base, id: 'far', name: 'Offscreen_' + 'long_name_'.repeat(8), geometry: { type: 'Point', coordinates: [-88, 44] } },
      { ...base, id: 'line', name: 'Survey line', geometry: { type: 'LineString', coordinates: [[-89, 44], [-89.001, 44.001]] } },
      { ...base, id: 'area', name: 'Survey area', mine: false, editable: false,
        geometry: { type: 'Polygon', coordinates: [[[-90, 44], [-90.001, 44], [-90.001, 44.001], [-90, 44]]] } },
    ];
    const app = express(), asked = [];
    app.use('/api/v1/marks', (req, res) => {
      asked.push([req.method, req.path]);
      if (req.method !== 'GET' || req.path !== '/') return res.sendStatus(405);
      res.json({ marks: supplied, categories: [category], capabilities: { write: writable, staff: writable, visibility: ['private'] } });
    });
    await withBrowser(t, { app }, async h => {
      const { client, waitFor } = h;
      await h.load('?mode=staff');
      assert.equal(await client.evaluate('map.getBounds().contains([44, -88])'), false, 'far pin starts outside the map');
      await h.press('.viewer-mark-layers');
      assert.equal(await client.evaluate("document.querySelector('[data-tab=list]').getAttribute('aria-selected')"), 'true', 'List is the default');
      const rows = () => client.evaluate(`Array.from(document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item'), row => ({
        name: row.querySelector('.viewer-mark-list-name > span').textContent,
        category: row.querySelector('small').textContent,
        icon: Boolean(row.querySelector('.viewer-mark-list-icon svg'))
      }))`);
      const listed = await rows();
      assert.deepEqual(listed.map(row => row.name), supplied.map(mark => mark.name), 'pins, line and area are listed even off screen');
      assert.ok(listed.every(row => row.category.includes(category.name) && row.icon), 'every row has its category and icon');

      // Search and category visibility are convenience filters over the same store.
      await h.type('[name=markSearch]', 'Offscreen_');
      assert.deepEqual((await rows()).map(row => row.name), [supplied[1].name]);
      await h.type('[name=markSearch]', '');
      await h.press('[data-tab=categories]');
      await h.press('[data-eye="synthetic-category"]');
      await h.press('[data-tab=list]');
      assert.deepEqual(await rows(), []);
      assert.deepEqual(await h.state(), supplied, 'hiding a category does not remove authorized store marks');
      await h.press('[data-tab=categories]');
      await h.pressText('Show all');
      await h.press('[data-tab=list]');
      assert.equal((await rows()).length, supplied.length);

      for (const width of [320, 375]) {
        await h.size(width, 740, true);
        await client.evaluate('map.invalidateSize({ animate: false }), 0');
        await waitFor("document.querySelector('.viewer-mark-box').classList.contains('sheet')", 'phone sheet');
        const fits = await client.evaluate(`(() => {
          const box = document.querySelector('.viewer-mark-box'), list = document.querySelector('#viewer-marks-list .viewer-mark-list');
          const r = box.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1
            && box.scrollWidth <= box.clientWidth + 1 && list.scrollWidth <= list.clientWidth + 1;
        })()`);
        assert.equal(fits, true, `list and long name fit ${width}px without horizontal scrolling`);
      }
      const [x, y] = await client.evaluate(`(() => {
        const row = Array.from(document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item')).find(row => row.textContent.includes('Offscreen_'));
        row.scrollIntoView({ block: 'nearest' });
        const r = row.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2];
      })()`);
      await h.click(x, y);
      await waitFor("!document.querySelector('.viewer-mark-card').hidden && map.getBounds().contains([44, -88])", 'list navigates to the off-screen pin');
      assert.equal(await client.evaluate("document.querySelector('.viewer-mark-card h4').textContent"), supplied[1].name);
      const actions = () => client.evaluate(`Array.from(document.querySelectorAll('.viewer-mark-view button')).filter(button => !button.closest('[hidden]')).map(button => button.textContent)`);
      assert.deepEqual((await actions()).filter(text => ['Edit', 'Move', 'Delete'].includes(text)), writable ? ['Edit', 'Move', 'Delete'] : []);
      assert.equal(await client.evaluate("document.querySelector('.viewer-mark-add').hidden"), !writable);
      assert.equal(await client.evaluate("document.querySelector('[data-tab=deleted]').hidden"), !writable);
      // Staff still get no edit actions on a supplied, non-editable mark.
      await h.press('.viewer-mark-card .viewer-mark-close');
      await h.press('.viewer-mark-layers');
      await client.evaluate(`Array.from(document.querySelectorAll('#viewer-marks-list .viewer-mark-list-item')).find(row => row.textContent.includes('Survey area')).click(), 0`);
      assert.deepEqual((await actions()).filter(text => ['Edit', 'Move', 'Delete'].includes(text)), []);
      assert.deepEqual(await h.state(), supplied, 'listing and navigation never change mark geometry or content');
      assert.deepEqual(asked, [['GET', '/']], 'list interactions make no writes or additional data requests');
    });
  });
}

// Grouping, the list for one spot, and the Marks pop-up on real Leaflet.
test('marks: several on one spot and the Marks pop-up', { timeout: 90000 }, async t => {
  await withBrowser(t, {}, async h => {
    const { client, waitFor } = h;
    await h.load();
    for (const [lng, name] of [[-87, 'One'], [-87.00001, 'Two'], [-86.999, 'Apart']]) {
      await h.type('[name=coordinates]', `43.05, ${lng}`);
      await h.pressText('Place pin');
      await waitFor("!document.querySelector('.viewer-mark-form').hidden", 'editor');
      await h.type('.viewer-mark-form [name=name]', name);
      await h.pressText('Save');
      await waitFor("document.querySelector('.viewer-mark-form').hidden", 'saved');
    }
    await client.evaluate('map.setView([43.05, -86.9995], 18, { animate: false }), 0');
    await waitFor("document.querySelectorAll('.viewer-map-group').length === 1", 'grouped');
    assert.equal(await client.evaluate("document.querySelector('.viewer-map-group b').textContent"), '2');
    assert.equal(await client.evaluate("document.querySelectorAll('.viewer-map-mark').length"), 1);
    const [x, y] = await client.evaluate("(() => { const r = document.querySelector('.viewer-map-group').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; })()");
    await h.click(x, y);
    await waitFor("!document.querySelector('.viewer-mark-pick').hidden", 'list');
    assert.deepEqual(await client.evaluate("[...document.querySelectorAll('.viewer-mark-pick .viewer-mark-list-item')].map(b => b.textContent).sort()"), ['One', 'Two']);
    await h.pressText('Zoom in');
    await waitFor("document.querySelectorAll('.viewer-map-group').length === 0 && document.querySelectorAll('.viewer-map-mark').length >= 2", 'apart after zooming in');
    // Labels never cover a pin.
    await h.labels('on');
    await delay(300);
    assert.equal(await client.evaluate("(() => { const boxes = s => [...document.querySelectorAll(s)].map(e => e.getBoundingClientRect()); const hit = (a, b) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom; return boxes('.viewer-mark-label').some((l, i) => boxes('.viewer-mark-label').some((m, j) => i !== j && hit(l, m))); })()"), false);
    // The pop-up, on a computer and on a phone.
    await h.press('.viewer-mark-layers');
    await waitFor("!document.querySelector('.viewer-mark-box').hidden", 'pop-up');
    await h.size(375, 740, true);
    await delay(200);
    const fits = await client.evaluate("(() => { const r = document.querySelector('.viewer-mark-box').getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })()");
    assert.equal(fits, true);
  });
});

test('marks: recovered changes show their own result and an expired Restore returns focus', { timeout: 90000 }, async t => {
  const { app, database } = marksApi();
  t.after(() => database.close());
  await withBrowser(t, { app }, async h => {
    const { client, waitFor } = h;
    await h.load('?mode=session');
    const name = 'Survey mark ' + 'x'.repeat(85);
    const id = await client.evaluate(`(async () => (await marks.store.create({
      name: ${JSON.stringify(name)}, color: '#1565c0', geometry: { type: 'Point', coordinates: [-87, 43.05] }
    })).id)()`);
    const remove = () => client.evaluate(`marks.store.remove(marks.store.find(${JSON.stringify(id)}))`);
    const notice = '.viewer-mark-undo';
    await client.evaluate("dropMarkAnswer('DELETE'), 0");
    assert.equal(await remove(), true, await h.status());
    await waitFor(`document.querySelector('${notice} [role=status]').textContent.endsWith('is in Recently deleted.')`, 'recovered delete');
    assert.equal(await client.evaluate(`document.querySelector('${notice} button').hidden`), true);
    assert.equal(await client.evaluate('marks.store.state.undo.length'), 1, 'older Undo stays in history');

    await h.size(375, 740, true);
    await h.press('.viewer-mark-layers');
    await h.press('[data-tab=deleted]');
    const restore = '[data-restore-mark]';
    await waitFor(`Boolean(document.querySelector('${restore}')) && !marks.store.state.busy`, 'recently deleted list');
    await client.evaluate("dropMarkAnswer('POST'), 0");
    await client.evaluate(`document.querySelector('${restore}').focus(), document.activeElement.click(), 0`);
    await waitFor(`document.querySelector('${notice} [role=status]').textContent.endsWith('is back in Marks.')`, 'recovered restore');
    assert.equal(await client.evaluate(`document.querySelector('${notice} button').hidden`), true);
    assert.equal(await client.evaluate("document.activeElement.dataset.tab"), 'deleted');
    assert.equal(await client.evaluate(`(() => {
      const rect = document.querySelector('${notice}').getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth + 1;
    })()`), true);

    assert.equal(await remove(), true);
    await h.press('[data-tab=deleted]');
    await waitFor(`Boolean(document.querySelector('${restore}')) && !marks.store.state.busy`, 'restorable mark');
    const expired = '2020-01-01T00:00:00.000Z';
    database.prepare('UPDATE viewer_marks SET deleted_at=? WHERE id=?').run(expired, id);
    await client.evaluate(`document.querySelector('${restore}').focus(), document.activeElement.click(), 0`);
    await waitFor(`!document.querySelector('${restore}') && !marks.store.state.busy`, 'expired row removed');
    assert.equal(await client.evaluate("document.activeElement.dataset.tab"), 'deleted');
    assert.match(await h.status(), /no longer available to restore/);
  });
});

test('marks: a client can withdraw a shared pin from an open staff map', { timeout: 90000 }, async t => {
  const { app, database } = marksApi();
  t.after(() => database.close());
  await withBrowser(t, { app }, async h => {
    const { client, waitFor } = h;
    await h.load('?mode=staff');
    const write = (method, path, body) => client.evaluate(`(async () => {
      const response = await fetch(${JSON.stringify('/api/v1/marks' + path)}, {
        method: ${JSON.stringify(method)},
        headers: { authorization: 'Bearer ${SESSION_TOKEN}', 'content-type': 'application/json' },
        body: ${JSON.stringify(JSON.stringify(body))}
      });
      return { status: response.status, ...(await response.json()) };
    })()`);
    const pin = { id: '6dbd8e24-b4d3-4bd5-af34-23ac6ca14521', name: 'Client pin', color: '#1565c0',
      geometry: { type: 'Point', coordinates: [-87, 43.05] }, visibility: 'staff' };
    assert.equal((await write('POST', '', pin)).status, 201);
    const focus = () => client.evaluate("window.dispatchEvent(new Event('focus')), 0");
    await focus();
    await waitFor("document.querySelector('.viewer-map-mark')?.getAttribute('aria-label')?.startsWith('Client pin')", 'shared pin visible');

    await client.evaluate('marks.mapContextMenu({ lat: 43.0503, lng: -87.0003 }), 0');
    await h.type('.viewer-mark-form [name=name]', 'Unsaved staff pin');
    assert.equal((await write('PUT', '/' + pin.id, { ...pin, revision: 1, visibility: 'private' })).status, 200);
    await focus();
    await waitFor("![...document.querySelectorAll('.viewer-map-mark')].some(pin => pin.getAttribute('aria-label')?.startsWith('Client pin'))",
      'withdrawn pin removed');
    assert.equal(await client.evaluate("document.querySelector('.viewer-mark-form [name=name]').value"), 'Unsaved staff pin');
  });
});

test('marks: expired Restore keeps an open staff draft and respects a change of focus', { timeout: 90000 }, async t => {
  const { app, database } = marksApi();
  t.after(() => database.close());
  let delayRestore = false, resume;
  const route = (request, response) => {
    if (delayRestore && request.method === 'POST' && request.url.endsWith('/restore')) {
      delayRestore = false;
      resume = () => { resume = undefined; app(request, response); };
    } else app(request, response);
  };
  await withBrowser(t, { app: route }, async h => {
    const { client, waitFor } = h;
    try {
      await h.load('?mode=staff');
      const ids = await client.evaluate(`(async () => {
        const ids = [];
        for (const name of ['First pin', 'Second pin']) {
          const pin = await marks.store.create({ name, color: '#1565c0', geometry: { type: 'Point', coordinates: [-87, 43.05] } });
          await marks.store.remove(pin);
          ids.push(pin.id);
        }
        return ids;
      })()`);
      await h.press('.viewer-mark-layers');
      await h.press('[data-tab=deleted]');
      await waitFor("document.querySelectorAll('[data-restore-mark]').length === 2 && !marks.store.state.busy", 'deleted marks loaded');
      await client.evaluate('marks.mapContextMenu({ lat: 43.0503, lng: -87.0003 }), 0');
      await h.type('.viewer-mark-form [name=name]', 'Unsaved staff pin');
      const beginExpiredRestore = id => {
        database.prepare('UPDATE viewer_marks SET deleted_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z', id);
        return client.evaluate(`(() => {
          const button = document.querySelector('[data-restore-mark="${id}"]');
          button.focus();
          button.click();
        })()`);
      };
      const finished = id => waitFor(`!document.querySelector('[data-restore-mark="${id}"]') && !marks.store.state.busy`, 'expired row removed');
      await beginExpiredRestore(ids[0]);
      await finished(ids[0]);
      assert.equal(await client.evaluate('document.activeElement.dataset.tab'), 'deleted');

      delayRestore = true;
      await beginExpiredRestore(ids[1]);
      await waitFor(() => Promise.resolve(Boolean(resume)), 'Restore request held');
      await client.evaluate("document.querySelector('[data-tab=categories]').focus(), 0");
      resume();
      await finished(ids[1]);
      assert.equal(await client.evaluate('document.activeElement.dataset.tab'), 'categories');
      assert.equal(await client.evaluate("document.querySelector('.viewer-mark-form [name=name]').value"), 'Unsaved staff pin');
      assert.equal(await h.editorOpen(), true);
    } finally {
      resume?.();
    }
  });
});
