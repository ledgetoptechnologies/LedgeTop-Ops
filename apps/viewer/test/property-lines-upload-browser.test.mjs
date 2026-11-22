// Isolated browser check of the uploaded-boundary source: the workspace card
// (staff choose the source, upload, remove; read-only staff see no upload
// control; nothing from the server is rendered as HTML) and the Viewer layer
// drawing an uploaded boundary outside Wisconsin. Stubbed API, no live service.
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

const XSS = '<img src=x onerror="window.pwned=1">';

function workspacePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body>
<div id="writer"></div><div id="reader"></div><div id="toast"></div>
<script type="module">
import { mountPropertyLinesSource } from '/workspace-property-lines.mjs';
window.toasts = [];
const request = async (path, { method = 'GET', body, raw } = {}) => {
  const headers = { Authorization: 'Bearer staff-session-token', Accept: 'application/json' };
  if (method !== 'GET') headers['Idempotency-Key'] = crypto.randomUUID();
  let payload;
  if (raw !== undefined) { headers['Content-Type'] = 'application/octet-stream'; payload = raw; }
  else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const response = await fetch(path, { method, headers, body: payload });
  const json = await response.json();
  if (!response.ok) throw new Error(json.message || json.code);
  return json;
};
const writer = mountPropertyLinesSource({ container: document.getElementById('writer'), projectId: 'project-1', request, toast: m => window.toasts.push(m), confirm: async () => true });
const reader = mountPropertyLinesSource({ container: document.getElementById('reader'), projectId: 'project-1', request, canWrite: false });
Promise.all([writer.ready, reader.ready]).then(() => { document.body.dataset.ready = 'true'; });
window.pick = (text, name) => { const input = document.querySelector('#writer [data-pl="file"]'); const dt = new DataTransfer(); dt.items.add(new File([text], name)); input.files = dt.files; };
</script></body></html>`;
}

function viewerPage() {
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
const projection = createUtmProjection({ zoneLon0Deg: -105, hemisphere: 'N' });
const map = L.map('leaflet-map').setView([39.7392, -104.9903], 17);
const [e, n] = projection.latLonToUtm(39.7392, -104.9903);
const controller = createPropertyLinesController({
  L, fetchImpl: (url, options) => fetch(url, options), headers: () => ({ Authorization: 'Bearer viewer-session-token' }), fetcherOptions: { debounceMs: 50 },
  dom: { panel: document.getElementById('panel-property-lines'), button: document.getElementById('layer-property-lines'),
    status: document.getElementById('property-lines-status'), about: document.getElementById('property-lines-about'), notice: document.getElementById('property-lines-notice') },
  projectId: () => 'model-co', getMode: () => 'ortho', getCloudMode: () => 'none', getMap: () => map, getScene: () => null, getPotreeApi: () => null,
  georefVerified: () => true, modelDatum: () => 'NAD83', getSceneExtentUtm: () => ({ minE: e - 120, minN: n - 90, maxE: e + 120, maxN: n + 90 }), getGroundGrid: async () => null,
  utmToLatLon: projection.utmToLatLon, latLonToUtm: projection.latLonToUtm, utmToWorld: () => null,
});
map.on('moveend', () => controller.refresh());
window.map = map;
controller.loadOffer().then(() => { document.body.dataset.ready = 'true'; });
</script></body></html>`;
}

test('uploaded boundary: workspace card and Viewer layer', { timeout: 90000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated check.'); return; }
  if (!existsSync(path.join(root, 'node_modules', 'leaflet', 'dist', 'leaflet-src.esm.js'))) { t.skip('npm ci is required.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  let stored = null, source = 'state', failNext = false;
  const writes = [];
  try {
    server = createServer(async (req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
      const json = (status, value) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
      const chunks = []; for await (const c of req) chunks.push(c);
      const body = Buffer.concat(chunks);
      if (url.pathname === '/workspace') { res.setHeader('Content-Type', 'text/html'); res.end(workspacePage()); return; }
      if (url.pathname === '/viewer') { res.setHeader('Content-Type', 'text/html'); res.end(viewerPage()); return; }
      const base = '/api/v1/projects/project-1/property-lines';
      const state = () => ({ source, upload: stored });
      if (url.pathname === base || url.pathname === `${base}/boundary`) {
        if (req.headers.authorization !== 'Bearer staff-session-token') return json(401, { code: 'authentication_required' });
        if (req.method !== 'GET') writes.push({ method: req.method, path: url.pathname, type: req.headers['content-type'], key: req.headers['idempotency-key'], bytes: body.length });
        if (req.method === 'GET') return json(200, state());
        if (req.method === 'PUT') {
          if (failNext) { failNext = false; return json(400, { code: 'unsupported_format', message: `Bad file ${XSS}` }); }
          stored = { source: 'upload', format: 'kml', featureCount: 2, vertexCount: 10, droppedCount: 1, uploadedAt: '2026-11-19T10:00:00.000Z' }; source = 'upload';
          return json(201, state());
        }
        if (req.method === 'PATCH') { const patch = JSON.parse(body.toString()); if (patch.source) source = patch.source; if (typeof patch.publicVisible === 'boolean') stored = { ...stored, publicVisible: patch.publicVisible }; return json(200, state()); }
        if (req.method === 'DELETE') { stored = null; source = 'state'; return json(200, state()); }
      }
      if (url.pathname === '/api/v1/property-lines' && url.searchParams.get('model') === 'model-co') {
        return json(200, { offered: true, source: { id: 'project-upload', kind: 'upload', name: `Uploaded boundary file ${XSS}`, release: 'uploaded 2026-11-19', credit: 'Supplied by project staff.', disclaimer: 'Not a survey.', datumNote: 'Coordinates are drawn exactly as supplied, with no datum shift.', datum: 'as-supplied', region: null, extra: XSS } });
      }
      if (url.pathname === '/api/v1/property-lines/parcels') {
        return json(200, { status: 'ok', parcels: [{ id: 1, rings: [[[-104.9910, 39.7388], [-104.9896, 39.7388], [-104.9896, 39.7396], [-104.9910, 39.7396], [-104.9910, 39.7388]]] }] });
      }
      const allowed = new Set(['/workspace-property-lines.mjs', '/property-lines.mjs', '/property-lines-layer.mjs', '/utm-conversion.mjs', '/node_modules/leaflet/dist/leaflet-src.esm.js', '/node_modules/leaflet/dist/leaflet.css']);
      if (!allowed.has(url.pathname)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'parcel3-browser-'));
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    const waitFor = async (expression, label, ms = 8000) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) { if (await client.evaluate(expression)) return; await delay(50); }
      assert.fail(`timed out: ${label}`);
    };
    const open = async (page) => {
      await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${page}` });
      await waitFor("document.body?.dataset.ready === 'true'", `${page} ready`);
    };
    const card = (id) => client.evaluate(`(() => { const c = document.getElementById('${id}'), q = s => c.querySelector(s);
      return { status: q('[data-pl="upload-status"]').textContent, error: q('[data-pl="upload-error"]').hidden ? '' : q('[data-pl="upload-error"]').textContent,
        state: q('[data-pl="source-state"]').checked, upload: q('[data-pl="source-upload"]').checked, uploadDisabled: q('[data-pl="source-upload"]').disabled,
        file: !!q('[data-pl="file"]'), remove: q('[data-pl="remove"]')?.disabled ?? null }; })()`);

    // Workspace card.
    await open('workspace');
    let writer = await card('writer');
    assert.deepEqual([writer.state, writer.upload, writer.uploadDisabled, writer.file, writer.remove], [true, false, true, true, true]);
    assert.equal(writer.status, 'No boundary file uploaded.');
    assert.equal((await card('reader')).file, false, 'read-only staff get no upload control');

    failNext = true;
    await client.evaluate(`window.pick('<kml/>', 'evil.kml'); document.querySelector('#writer [data-pl="upload"]').click(); 0`);
    await waitFor(`!document.querySelector('#writer [data-pl="upload-error"]').hidden`, 'error shown');
    writer = await card('writer');
    assert.equal(writer.error, `Bad file ${XSS}`, 'server text shown as text');
    assert.equal(await client.evaluate('document.querySelectorAll("img").length'), 0);

    await client.evaluate(`document.querySelector('#writer [data-pl="upload"]').click(); 0`);
    await waitFor(`document.querySelector('#writer [data-pl="source-upload"]').checked`, 'uploaded');
    writer = await card('writer');
    assert.equal(writer.status, 'KML: 2 features, 10 vertices, 1 unsupported item skipped, uploaded 2026-11-19.');
    assert.equal(await client.evaluate("document.querySelector('#writer [data-pl=\"upload-datum\"]').textContent"), 'WGS84 lon/lat, no datum shift; expect about 1 to 1.5 m offset on a NAD83 model.');
    assert.equal(await client.evaluate("document.querySelector('#writer [data-pl=\"public\"]').checked"), false, 'hidden from public links by default');
    await client.evaluate("document.querySelector('#writer [data-pl=\"public\"]').click(); 0");
    await waitFor("document.querySelector('#writer [data-pl=\"public\"]').checked && !document.querySelector('#writer [data-pl=\"public\"]').disabled", 'public link setting saved');
    assert.equal(stored.publicVisible, true);
    const put = writes.find(w => w.method === 'PUT' && w.bytes === 6);
    assert.equal(put.type, 'application/octet-stream');
    assert.match(put.key, /^[0-9a-f-]{36}$/);

    await client.evaluate(`document.querySelector('#writer [data-pl="source-state"]').click(); 0`);
    await waitFor(`document.querySelector('#writer [data-pl="source-state"]').checked && !document.querySelector('#writer [data-pl="source-state"]').disabled`, 'state chosen');
    assert.equal(source, 'state');
    await client.evaluate(`document.querySelector('#writer [data-pl="remove"]').click(); 0`);
    await waitFor(`document.querySelector('#writer [data-pl="upload-status"]').textContent === 'No boundary file uploaded.'`, 'removed');
    assert.deepEqual(writes.map(w => w.method), ['PUT', 'PUT', 'PATCH', 'PATCH', 'DELETE']);
    assert.ok(writes.every(w => w.key), 'every write carries an Idempotency-Key');

    // Viewer layer: uploaded source outside Wisconsin is offered and drawn.
    await open('viewer');
    assert.equal(await client.evaluate("document.getElementById('layer-property-lines').disabled"), false, 'not limited to Wisconsin');
    // Shown by default: no click needed.
    await waitFor("document.getElementById('property-lines-status').dataset.state === 'ready'", 'drawn');
    assert.equal(await client.evaluate('Object.values(map._layers).filter(l => l.options?.pane === "propertyLines" && typeof l.getLatLngs === "function").length'), 2, 'halo and line');
    const about = await client.evaluate("document.getElementById('property-lines-about').textContent");
    assert.ok(about.includes(`Uploaded boundary file ${XSS}, uploaded 2026-11-19.`), about);
    assert.match(about, /no datum shift/);
    assert.equal(await client.evaluate('document.querySelectorAll("img:not(.leaflet-tile)").length'), 0);
    assert.equal(await client.evaluate('window.pwned'), undefined);
  } finally {
    client?.close();
    if (browser && browser.exitCode === null) { browser.kill(); await new Promise(resolve => browser.once('exit', resolve)); }
    server?.close();
    if (profile) { try { rmSync(profile, { recursive: true, force: true }); } catch { /* browser may still hold files */ } }
    await unlock();
  }
});
