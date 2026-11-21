// Bounded real-app boot of the model page through Vite (shipped index.html + main.js, no stubs of mode or
// permission logic). The server mocks only the Viewer API: a staff or client session, or a public share,
// for an ortho-only model backed by a tiny synthetic GeoTIFF. One browser; it and its profile are
// removed before the test ends.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { writeArrayBuffer } from 'geotiff';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as Cdp } from './bounded-test-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync) || null;

const ORTHO = '/fixtures/orthophoto.tif';
const model = () => ({
  id: 'rail-boot-fixture', title: 'Rail boot fixture', displayUnits: 'imperial',
  assets: { glb: null, obj: null, tiles: null, shots: null, cameraPhotos: null, ortho: ORTHO, dsm: null, dtm: null, ept: null, pointCloud: null, pointCloudFormat: null },
  georef: { rtc: { e: 367257, n: 4759982, z: 0 }, bboxCenter: { x: 0, y: 0, z: 0 }, utmZoneLon0Deg: -87 },
});
const orthophoto = Buffer.from(writeArrayBuffer(new Uint8Array([238, 80, 7, 255, 150, 48, 34, 97, 74, 109, 190, 140]),
  { width: 2, height: 2, SamplesPerPixel: 3, BitsPerSample: [8, 8, 8], PhotometricInterpretation: 2, PlanarConfiguration: 1,
    ModelPixelScale: [20, 20, 0], ModelTiepoint: [0, 0, 0, 367240, 4760000, 0], ProjectedCSTypeGeoKey: 32616 }));

test('real model page boot: rail follows audience, permissions and ortho-only availability', { timeout: 120000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the bounded app-boot check.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let vite, server, browser, client, profile;
  // What the mocked Viewer API answers for the next page load.
  const scenario = { session: null, share: null };
  try {
    vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', server: { middlewareMode: true, hmr: false } });
    server = createServer((request, reply) => {
      const url = new URL(request.url || '/', 'http://127.0.0.1');
      const json = (body, status = 200) => { reply.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); reply.end(JSON.stringify(body)); };
      if (url.pathname === '/api/v1/health') { reply.writeHead(200, { 'Content-Type': 'application/json', 'X-LTDS-Viewer-Revision': 'a'.repeat(40) }); reply.end('{"ok":true}'); return; }
      if (url.pathname === '/api/v1/sessions/current') return scenario.session ? json(scenario.session) : json({ error: 'No session' }, 401);
      if (url.pathname.startsWith('/api/share/')) return scenario.share ? json(scenario.share) : json({ error: 'Not found' }, 404);
      if (url.pathname === ORTHO) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range || '');
        const start = range ? Number(range[1]) : 0, end = range && range[2] ? Math.min(Number(range[2]), orthophoto.length - 1) : orthophoto.length - 1;
        if (start > end) { reply.writeHead(416, { 'Content-Range': `bytes */${orthophoto.length}` }); reply.end(); return; }
        reply.writeHead(range ? 206 : 200, { 'Content-Type': 'image/tiff', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${orthophoto.length}` } : {}) });
        reply.end(orthophoto.subarray(start, end + 1));
        return;
      }
      vite.middlewares(request, reply);
    });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-rail-boot-'));
    browser = spawn(binary, ['--headless=new', '--enable-unsafe-swiftshader', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

    const boot = async (pathname, label) => {
      await client.command('Page.navigate', { url: `${origin}${pathname}` });
      const deadline = Date.now() + 30000;
      const ready = "document.querySelector('#tab-ortho')?.classList.contains('active') && document.querySelector('#tab-ortho')?.getAttribute('aria-pressed') === 'true'";
      while (Date.now() < deadline && !await client.evaluate(`Boolean(${ready})`).catch(() => false)) await delay(100);
      assert.equal(await client.evaluate(`Boolean(${ready})`), true, `${label}: ortho-first view did not start`);
      return client.evaluate(`(() => {
        const visible = el => Boolean(el) && !el.hidden && getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0;
        const modes = [...document.querySelectorAll('#view-tabs [data-mode]')];
        return {
          modeCount: modes.length,
          visibleModes: modes.filter(visible).map(b => b.dataset.mode),
          pressed: modes.filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.mode),
          staff: visible(document.querySelector('#staff-navigation')) ? { dashboard: document.querySelector('#staff-dashboard').getAttribute('href'), models: document.querySelector('#staff-models').getAttribute('href') } : null,
          portal: visible(document.querySelector('#client-navigation')) ? document.querySelector('#client-portal').getAttribute('href') : null,
          measure: visible(document.querySelector('#rail-measure')),
          tools: document.querySelector('#rail-tools').getAttribute('aria-expanded'),
          inert: document.querySelector('#sidebar').inert,
        };
      })()`);
    };
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const session = (audience, permissions) => ({ model: model(), permissions, sessionId: `rail-${audience}`, accessToken: 'rail-session-token',
      expiresAt, allowedEmbedOrigins: [], audience, subject: `${audience}:fixture`,
      ...(audience === 'ops' ? { operationsOrigin: origin } : { clientPortalOrigin: origin }) });

    // Staff: Operations return links, Measure permitted; only the ortho mode is available.
    scenario.session = session('ops', { view: true, measure: true, cameras: true });
    const staff = await boot('/session/active/rail-ops', 'staff');
    assert.deepEqual(staff, { modeCount: 5, visibleModes: ['ortho'], pressed: ['ortho'], staff: { dashboard: `${origin}/`, models: `${origin}/viewer` },
      portal: null, measure: true, tools: 'true', inert: false });
    // Tools and Measure on the real page: closing makes the panel inert; Measure reopens it and focuses inside.
    await client.evaluate("document.querySelector('#rail-tools').click()");
    assert.deepEqual(await client.evaluate("({ inert: document.querySelector('#sidebar').inert, tools: document.querySelector('#rail-tools').getAttribute('aria-expanded') })"), { inert: true, tools: 'false' });
    await client.evaluate("document.querySelector('#rail-measure').click()");
    assert.deepEqual(await client.evaluate("({ inert: document.querySelector('#sidebar').inert, inPanel: Boolean(document.activeElement?.closest('#panel-measure')) })"), { inert: false, inPanel: true });

    // Staff without measure permission: no Measure shortcut, links unchanged.
    scenario.session = session('ops', { view: true, measure: false, cameras: true });
    const staffNoMeasure = await boot('/session/active/rail-ops-view', 'staff without measure');
    assert.equal(staffNoMeasure.measure, false); assert.ok(staffNoMeasure.staff);

    // Client: Client Portal link only.
    scenario.session = session('client', { view: true, measure: true, cameras: true });
    const clientView = await boot('/session/active/rail-client', 'client');
    assert.deepEqual({ staff: clientView.staff, portal: clientView.portal, measure: clientView.measure, visibleModes: clientView.visibleModes },
      { staff: null, portal: `${origin}/portal`, measure: true, visibleModes: ['ortho'] });

    // Public link: no return links; Measure follows the share's permission.
    scenario.session = null;
    scenario.share = { ...model(), permissions: { measure: true, cameras: false } };
    const publicView = await boot('/view/rail-public-token', 'public');
    assert.deepEqual({ staff: publicView.staff, portal: publicView.portal, measure: publicView.measure, pressed: publicView.pressed },
      { staff: null, portal: null, measure: true, pressed: ['ortho'] });
    scenario.share = { ...model(), permissions: { measure: false, cameras: false } };
    const publicNoMeasure = await boot('/view/rail-public-view-only', 'public without measure');
    assert.equal(publicNoMeasure.measure, false);
  } finally {
    client?.close();
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)]) === false) { browser.kill('SIGKILL'); await Promise.race([exited, delay(5000)]); }
      assert.ok(browser.exitCode !== null || browser.signalCode !== null, 'isolated browser exited');
    }
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    await vite?.close();
    await unlock();
    if (profile) {
      const absolute = path.resolve(profile);
      assert.ok(absolute.startsWith(path.resolve(tmpdir(), 'ltds-viewer-rail-boot-')));
      try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; t.diagnostic(`Browser kept a lock on its temporary profile: ${absolute}`); }
    }
  }
});
