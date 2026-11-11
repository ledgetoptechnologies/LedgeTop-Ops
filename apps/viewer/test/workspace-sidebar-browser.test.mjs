// Isolated browser check of the shipped workspace shell markup, CSS and sidebar module:
// collapse is remembered, collapsed names and platform status stay accessible, and the phone
// drawer reports its state, moves focus in and closes on Escape. No API or data.
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

function page() {
  const html = readFileSync(path.join(root, 'workspace.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  return html.replace('</body>', `<script type="module">
import { installWorkspaceSidebar, renderWorkspaceNav, setWorkspaceHealth } from '/workspace-sidebar.mjs';
const shell = document.querySelector('#workspace'), container = document.querySelector('#workspace-navigation');
let section = 'background';
const render = () => renderWorkspaceNav({ shell, container, collapseButton: document.querySelector('#nav-collapse'), section,
  onSelect: next => { section = next; shell.classList.remove('nav-open'); document.querySelector('#nav-toggle').setAttribute('aria-expanded', 'false'); render(); } });
installWorkspaceSidebar({ shell, toggle: document.querySelector('#nav-toggle'), collapseButton: document.querySelector('#nav-collapse'), container, rerender: render });
render();
setWorkspaceHealth({ dot: document.querySelector('#nav-health-dot'), label: document.querySelector('#nav-health-label'), foot: document.querySelector('.workspace-nav-foot') }, true);
document.body.dataset.ready = 'true';
</script></body>`);
}

test('workspace sidebar: remembered rail, accessible collapsed names and status, keyboard phone drawer', { timeout: 60000 }, async t => {
  const binary = executable();
  if (!binary) { t.skip('Chromium is required for the isolated workspace sidebar check.'); return; }
  const unlock = await acquireBrowserHarnessLock({ root });
  let browser, client, server, profile;
  try {
    server = createServer((req, res) => {
      const url = new URL(req.url, 'http://fixture.invalid');
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end(page()); return; }
      const allowed = new Set(['/workspace.css', '/workspace-management.css', '/workspace-transfers.css', '/workspace-sidebar.css', '/workspace-sidebar.mjs']);
      if (!allowed.has(url.pathname)) { res.statusCode = 404; res.end(); return; }
      res.setHeader('Content-Type', url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');
      res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-workspace-sidebar-'));
    browser = spawn(binary, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const port = await waitForDevToolsPort(path.join(profile, 'DevToolsActivePort'));
    const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    client = await Cdp.connect(tabs.find(tab => tab.type === 'page').webSocketDebuggerUrl);
    const size = (width, height, mobile = false) => client.command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    const load = async () => {
      await client.command('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` });
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline && !await client.evaluate("document.body?.dataset.ready === 'true'")) await delay(50);
      assert.equal(await client.evaluate("document.body?.dataset.ready === 'true'"), true);
    };
    const key = async name => {
      const code = name === 'Escape' ? { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 } : { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
      await client.command('Input.dispatchKeyEvent', { type: 'keyDown', ...code });
      await client.command('Input.dispatchKeyEvent', { type: 'keyUp', ...code });
    };
    await client.command('Page.enable');
    await size(1280, 760);
    await load();

    // Expanded: grouped sections, one current section.
    assert.deepEqual(await client.evaluate("[...document.querySelectorAll('.nav-group-label')].map(el => el.textContent)"), ['Workspace', 'System']);
    assert.deepEqual(await client.evaluate("[...document.querySelectorAll('[aria-current=page]')].map(el => el.dataset.section)"), ['background']);

    // Collapse: names and platform status remain available to assistive technology, with tooltips.
    await client.evaluate("document.querySelector('#nav-collapse').click()");
    await delay(400); // let the column transition finish
    const collapsed = await client.evaluate(`(() => {
      const links = [...document.querySelectorAll('.nav-link')], status = document.querySelector('#nav-health-label');
      return {
        collapsed: document.querySelector('#workspace').classList.contains('nav-collapsed'),
        stored: localStorage.getItem('ltds.viewer.sidebar.collapsed'),
        width: Math.round(document.querySelector('.workspace-nav').getBoundingClientRect().width),
        names: links.map(link => link.getAttribute('aria-label')),
        tooltips: links.every(link => link.title === link.getAttribute('aria-label')),
        labelsInTree: links.every(link => getComputedStyle(link.querySelector('.nav-label')).display !== 'none'),
        statusInTree: getComputedStyle(status).display !== 'none' && status.textContent,
        statusTooltip: document.querySelector('.workspace-nav-foot').title,
        toggleName: document.querySelector('#nav-collapse').getAttribute('aria-label'),
      };
    })()`);
    assert.deepEqual(collapsed, { collapsed: true, stored: 'true', width: 64,
      names: ['Projects', 'Processing', 'Providers & nodes', 'Background work', 'Recycle Bin', 'Diagnostics'], tooltips: true, labelsInTree: true,
      statusInTree: 'Platform ready', statusTooltip: 'Platform ready', toggleName: 'Expand sidebar' });

    // Remembered after a reload, and expands again.
    await load();
    assert.equal(await client.evaluate("document.querySelector('#workspace').classList.contains('nav-collapsed')"), true);
    await client.evaluate("document.querySelector('#nav-collapse').click()");
    assert.equal(await client.evaluate("document.querySelector('#workspace').classList.contains('nav-collapsed') || localStorage.getItem('ltds.viewer.sidebar.collapsed')"), 'false');

    // Phone: the rail toggle is hidden; the drawer reports its state, takes focus and closes on Escape.
    await size(390, 760, true);
    await load();
    assert.equal(await client.evaluate("getComputedStyle(document.querySelector('#nav-collapse')).display"), 'none');
    assert.equal(await client.evaluate("document.querySelector('#nav-toggle').getAttribute('aria-expanded')"), 'false');
    await client.evaluate("document.querySelector('#nav-toggle').focus(); document.querySelector('#nav-toggle').click()");
    assert.equal(await client.evaluate("document.querySelector('#nav-toggle').getAttribute('aria-expanded')"), 'true');
    assert.equal(await client.evaluate("document.activeElement?.dataset.section"), 'dashboard');
    await key('Tab');
    assert.equal(await client.evaluate("document.activeElement?.dataset.section"), 'providers');
    await key('Escape');
    assert.deepEqual(await client.evaluate("({ open: document.querySelector('#workspace').classList.contains('nav-open'), expanded: document.querySelector('#nav-toggle').getAttribute('aria-expanded'), focus: document.activeElement?.id })"),
      { open: false, expanded: 'false', focus: 'nav-toggle' });
    assert.equal(await client.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
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
      assert.ok(absolute.startsWith(path.resolve(tmpdir(), 'ltds-workspace-sidebar-')));
      try { rmSync(absolute, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
      catch (error) { if (process.platform !== 'win32' || !['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error.code)) throw error; t.diagnostic(`Browser kept a lock on its temporary profile: ${absolute}`); }
    }
  }
});
