// Isolated browser check of the model-page rail: shipped index.html CSS and rail markup with the
// real viewer-rail.mjs. The sidebar toggle mirrors main.js's handler; no model, API or session.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { waitForDevToolsPort } from './devtools-port.mjs';
import { BoundedTestCdp as Cdp } from './bounded-test-cdp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(root, 'index.html'), 'utf8');
const css = source.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const rail = source.match(/<nav id="viewer-rail"[\s\S]*?<\/nav>/)?.[0];
assert.ok(css && rail);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const executable = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync) || null;

function page() {
  return `<!doctype html><meta name="viewport" content="width=device-width"><style>${css}</style>
<div id="app"><header id="topbar"><div id="brand"><div id="brand-info"><span class="company">Ledge Top</span></div></div></header>
<div id="main">${rail}
<aside id="sidebar"><div id="sidebar-custom"><div class="panel" id="panel-measure"><h3>Measure</h3><div class="tool-grid"><button class="tool-btn" data-tool="distance">Distance</button></div></div></div></aside>
<button id="sidebar-toggle" aria-label="Toggle tools" aria-controls="sidebar" aria-expanded="true">T</button>
<div id="viewport" style="flex:1;min-width:0;background:#222"><button class="icon-btn" id="btn-measure-float" style="display:flex">M</button></div></div></div>
<script type="module">
import { installViewerRail } from '/viewer-rail.mjs';
const sidebar = document.getElementById('sidebar'), toggle = document.getElementById('sidebar-toggle');
// Same responsive start-up rule and handler as main.js bindUI().
if (matchMedia('(max-width: 1024px)').matches) { sidebar.classList.add('collapsed'); toggle.setAttribute('aria-expanded', 'false'); }
toggle.addEventListener('click', () => { const collapsed = sidebar.classList.toggle('collapsed'); toggle.setAttribute('aria-expanded', String(!collapsed)); });
installViewerRail();
window.tools = [];
for (const button of document.querySelectorAll('[data-tool]')) button.onclick = () => tools.push(button.dataset.tool);
// Same per-button update as main.js switchMode().
window.mode = mode => { for (const button of document.querySelectorAll('.tab-btn')) { button.classList.toggle('active', button.dataset.mode === mode); button.setAttribute('aria-pressed', String(button.dataset.mode === mode)); } };
for (const button of document.querySelectorAll('.tab-btn')) button.addEventListener('click', () => mode(button.dataset.mode));
mode('ortho');
if (new URL(location.href).searchParams.has('embed')) document.body.classList.add('embed-mode'); // main.js adds VIEW_MODE + '-mode'
const permitted = new URL(location.href).searchParams.get('measure') !== 'false';
document.getElementById('rail-measure').hidden = !permitted; // main.js: syncMeasurementActionVisibility()
document.body.dataset.ready = 'true';
</script>`;
}

test('model rail: one set of view modes, Tools and permitted Measure, keyboard and phone layout', { timeout: 60000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated rail check.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page()); return; }
      if (url.pathname !== '/viewer-rail.mjs') { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', 'text/javascript'); res.end(readFileSync(path.join(root, 'viewer-rail.mjs')));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-rail-'));
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    await client.command('Page.enable');
    const open = async (width, query = '') => {
      await client.command('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: width <= 640 });
      await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/${query}` });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !await client.evaluate("document.body?.dataset.ready === 'true'")) await delay(50);
      assert.equal(await client.evaluate("document.body?.dataset.ready === 'true'"), true);
    };
    const shot = async name => {
      if (!process.env.VIEWER_RAIL_SCREENSHOT_DIR) return;
      const directory = path.resolve(process.env.VIEWER_RAIL_SCREENSHOT_DIR); mkdirSync(directory, { recursive: true });
      const image = await client.command('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(directory, `${name}.png`), Buffer.from(image.data, 'base64'));
    };
    const tab = async () => {
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    };

    for (const width of [1440, 1024]) {
      await open(width);
      const layout = await client.evaluate(`(() => {
        const r = e => e.getBoundingClientRect(), rail = r(document.querySelector('#viewer-rail')), header = r(document.querySelector('#topbar'));
        const modes = [...document.querySelectorAll('[data-mode]')];
        return {
          modes: modes.map(b => b.dataset.mode), inRail: modes.every(b => b.closest('#view-tabs') && b.closest('#viewer-rail')),
          names: modes.map(b => b.getAttribute('aria-label')), pressed: modes.map(b => b.getAttribute('aria-pressed')),
          railLeft: rail.left, railBelowHeader: rail.top >= header.bottom - 1, railWidth: Math.round(rail.width),
          smallest: Math.min(...[...document.querySelectorAll('#viewer-rail button:not([hidden])')].map(b => Math.min(r(b).width, r(b).height))),
          fits: document.documentElement.scrollWidth <= innerWidth,
          floatingToggle: getComputedStyle(document.querySelector('#sidebar-toggle')).display,
          tools: document.querySelector('#rail-tools').getAttribute('aria-expanded'),
        };
      })()`);
      assert.deepEqual(layout.modes, ['model', 'cloud', 'ortho', 'dsm', 'dtm'], 'exactly one control per view mode');
      assert.equal(layout.inRail, true);
      assert.deepEqual(layout.names, ['3D Model', 'Point Cloud', 'Orthophoto', 'DSM', 'DTM']);
      assert.deepEqual(layout.pressed, ['false', 'false', 'true', 'false', 'false'], 'ortho-first selection is reflected');
      assert.equal(layout.railLeft, 0); assert.equal(layout.railBelowHeader, true); assert.equal(layout.railWidth, 76);
      assert.ok(layout.smallest >= 44, `rail targets are at least 44px (${layout.smallest})`);
      assert.equal(layout.fits, true); assert.equal(layout.floatingToggle, 'none', 'the rail replaces the floating tool toggle');
      assert.equal(layout.tools, width > 1024 ? 'true' : 'false', 'Tools reports the start-up panel state');
      await shot(`rail-${width}`);
    }

    // Keyboard: modes and Tools are reachable in order; Tools toggles the existing panel.
    await open(1440);
    await client.evaluate("document.querySelector('#tab-model').focus()");
    const order = [];
    for (let i = 0; i < 6; i += 1) { order.push(await client.evaluate('document.activeElement.id')); await tab(); }
    assert.deepEqual(order, ['tab-model', 'tab-cloud', 'tab-ortho', 'tab-dsm', 'tab-dtm', 'rail-tools']);
    await client.evaluate("document.querySelector('#tab-cloud').click()");
    assert.deepEqual(await client.evaluate("[...document.querySelectorAll('.tab-btn[aria-pressed=true]')].map(b => b.id)"), ['tab-cloud']);
    await client.evaluate("document.querySelector('#rail-tools').click()");
    assert.deepEqual(await client.evaluate("({ collapsed: document.querySelector('#sidebar').classList.contains('collapsed'), tools: document.querySelector('#rail-tools').getAttribute('aria-expanded'), toggle: document.querySelector('#sidebar-toggle').getAttribute('aria-expanded') })"),
      { collapsed: true, tools: 'false', toggle: 'false' });

    // Measure opens the existing panel and moves focus there without starting a tool.
    await client.evaluate("document.querySelector('#rail-measure').click()");
    assert.deepEqual(await client.evaluate("({ collapsed: document.querySelector('#sidebar').classList.contains('collapsed'), focus: document.activeElement?.dataset.tool, tools })"),
      { collapsed: false, focus: 'distance', tools: [] });

    // Not permitted: no Measure shortcut.
    await open(1440, '?measure=false');
    assert.equal(await client.evaluate("getComputedStyle(document.querySelector('#rail-measure')).display"), 'none');

    // Embeds: unchanged from main, where embed mode already hid the topbar (with the mode tabs), the tool
    // panel and its toggle. The rail is hidden the same way; the embed-only floating measure button stays.
    await open(1440, '?embed=1');
    assert.deepEqual(await client.evaluate(`({ rail: getComputedStyle(document.querySelector('#viewer-rail')).display,
      tabs: document.querySelector('#view-tabs').getBoundingClientRect().width, topbar: getComputedStyle(document.querySelector('#topbar')).display,
      sidebar: getComputedStyle(document.querySelector('#sidebar')).display, floatingMeasure: getComputedStyle(document.querySelector('#btn-measure-float')).display })`),
      { rail: 'none', tabs: 0, topbar: 'none', sidebar: 'none', floatingMeasure: 'flex' });

    // Phone: a bottom bar with the same single set of modes, no horizontal scroll, panel above it.
    await open(390);
    const phone = await client.evaluate(`(() => {
      const r = e => e.getBoundingClientRect(), rail = r(document.querySelector('#viewer-rail'));
      const bar = document.querySelector('#viewer-rail'), last = r([...document.querySelectorAll('#viewer-rail button:not([hidden])')].at(-1));
      return { allVisible: bar.scrollWidth <= bar.clientWidth && last.right <= innerWidth, bottom: Math.round(rail.bottom), height: Math.round(rail.height), width: Math.round(rail.width), modes: document.querySelectorAll('[data-mode]').length,
        fits: document.documentElement.scrollWidth <= innerWidth,
        smallest: Math.min(...[...document.querySelectorAll('#viewer-rail button:not([hidden])')].map(b => Math.min(r(b).width, r(b).height))) };
    })()`);
    assert.equal(phone.bottom, 800); assert.equal(phone.height, 60); assert.equal(phone.width, 390); assert.equal(phone.modes, 5);
    assert.equal(phone.fits, true); assert.equal(phone.allVisible, true, 'every rail button fits without scrolling'); assert.ok(phone.smallest >= 44, `phone targets are at least 44px (${phone.smallest})`);
    await shot('rail-390');
  } finally {
    client?.close();
    // Wait for the browser this test started to exit (force it if needed) before releasing the lock.
    if (browser && browser.exitCode === null && browser.signalCode === null) {
      const exited = new Promise(resolve => browser.once('exit', resolve));
      browser.kill();
      if (await Promise.race([exited.then(() => true), delay(5000).then(() => false)]) === false) { browser.kill('SIGKILL'); await Promise.race([exited, delay(5000)]); }
      assert.ok(browser.exitCode !== null || browser.signalCode !== null, 'isolated browser exited');
    }
    if (server) { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); }
    await unlock();
    // Remove only this test's own temporary profile.
    if (profile) {
      const absolute = path.resolve(profile);
      assert.ok(absolute.startsWith(path.resolve(tmpdir(), 'ltds-viewer-rail-')));
      try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; t.diagnostic(`Browser kept a lock on its temporary profile: ${absolute}`); }
    }
  }
});
