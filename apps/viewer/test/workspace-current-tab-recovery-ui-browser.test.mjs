import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { describeDiscardedWork } from '../workspace-current-tab-recovery-ui.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('discarded-work copy names exactly what a same-tab navigation loses', () => {
  assert.deepEqual(describeDiscardedWork({}), []);
  assert.deepEqual(describeDiscardedWork({ pendingUpload: false, selectedFileCount: 0, unsavedTaskDraft: false }), []);
  const all = describeDiscardedWork({ pendingUpload: true, selectedFileCount: 3, unsavedTaskDraft: true });
  assert.equal(all.length, 3);
  assert.match(all[0], /upload in progress.*Check its status/);
  assert.match(all[1], /^3 selected files not uploaded yet\. You'll need to select them again\.$/);
  assert.match(all[2], /new task form/);
  assert.match(describeDiscardedWork({ selectedFileCount: 1 })[0], /^1 selected file not uploaded yet\. You'll need to select it again\.$/);
  assert.deepEqual(describeDiscardedWork({ unsavedGcpMark: true }), ["The GCP mark you placed but haven't saved."]);
  const saving = describeDiscardedWork({ unsavedGcpMark: true, pendingGcpSave: true });
  assert.equal(saving.length, 1, 'a mark being saved is described once, as pending');
  assert.match(saving[0], /^The GCP mark being saved\. Check the saved marks after renewing/);
  assert.deepEqual(describeDiscardedWork({ selectedFileCount: -2 }), []);
});

function browserPath() {
  return [process.env.CHROME_PATH, process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].filter(Boolean).find(existsSync) || null;
}

async function waitForDevTools(profile) {
  const file = path.join(profile, 'DevToolsActivePort'), deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (existsSync(file)) { const port = readFileSync(file, 'utf8').split(/\r?\n/, 1)[0]; if (port) return `http://127.0.0.1:${port}`; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Browser did not expose a DevTools endpoint');
}

class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.events = [];
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id) { const p = this.pending.get(message.id); if (!p) return; this.pending.delete(message.id); message.error ? p.reject(new Error(`${p.method}: ${message.error.message}`)) : p.resolve(message.result || {}); }
      else this.events.push(message);
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new Cdp(socket);
  }
  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject, method }); this.socket.send(JSON.stringify({ id, method, params })); });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function until(check, message, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error.message; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`${message} (last: ${JSON.stringify(last)})`);
}

const HARNESS = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<dialog class="workspace-recovery" open><h2>Sign in to continue</h2></dialog>
<script type="module">
import { renderCurrentTabRecoveryOffer } from '/workspace-current-tab-recovery-ui.mjs';
const params = new URLSearchParams(location.search);
window.__calls = 0;
// Mirrors the workspace's pending-upload guard: recovery must never remove it.
if (params.get('busy') === '1') addEventListener('beforeunload', event => { event.preventDefault(); event.returnValue = ''; });
renderCurrentTabRecoveryOffer({
  container: document.querySelector('dialog'),
  navigationState: JSON.parse(params.get('state') || '{}'),
  continueInCurrentTab: () => { window.__calls += 1; if (params.get('throw') === '1') throw new Error('invalid'); location.assign('/next.html'); },
  resetDelayMs: 400,
});
window.__ready = true;
</script></body></html>`;

async function startServer() {
  const moduleSource = readFileSync(path.join(root, 'workspace-current-tab-recovery-ui.mjs'));
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/workspace-current-tab-recovery-ui.mjs') { response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' }); response.end(moduleSource); return; }
    if (url.pathname === '/harness.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end(HARNESS); return; }
    if (url.pathname === '/next.html') { response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>next</title><p>Operations sign-in</p>'); return; }
    response.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

// A trusted click. The release does not complete while a beforeunload prompt it
// triggered is open, so callers that expect a prompt answer it before awaiting.
async function clickReal(client, selector) {
  const box = await client.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await client.command('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  const released = client.command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
  released.catch(() => {});
  return { released };
}

async function open(client, origin, query) {
  await client.command('Page.navigate', { url: `${origin}/harness.html?${query}` });
  await until(() => client.evaluate('window.__ready === true && location.pathname === "/harness.html"'), 'harness did not load');
}

const dialogEvents = (client, since) => client.events.slice(since).filter(event => event.method === 'Page.javascriptDialogOpening');

test('"Renew in this tab" gates on discarded work and honours the real beforeunload Cancel/Confirm prompt', { timeout: 90_000 }, async t => {
  const executable = browserPath();
  if (!executable) { t.skip('Chrome or Edge is required for beforeunload browser coverage.'); return; }
  const release = await acquireBrowserHarnessLock({ root });
  let server, origin, profile, browser, client;
  try {
    ({ server, origin } = await startServer());
    profile = mkdtempSync(path.join(tmpdir(), 'ltds-viewer-browser-'));
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
    const devTools = await waitForDevTools(profile);
    const pages = await until(async () => (await (await fetch(`${devTools}/json/list`)).json()).filter(item => item.type === 'page'), 'no page target');
    client = await Cdp.connect(pages[0].webSocketDebuggerUrl);
    await client.command('Page.enable');
    await client.command('Runtime.enable');

    await t.test('pending work: warning lists losses, button needs explicit acknowledgement, Cancel keeps everything, Confirm navigates', async () => {
      await open(client, origin, `busy=1&state=${encodeURIComponent(JSON.stringify({ pendingUpload: true, selectedFileCount: 3, unsavedTaskDraft: true }))}`);
      const view = await client.evaluate(`(() => { const s = document.querySelector('.recovery-current-tab'); return {
        title: s.querySelector('h3').textContent, items: [...s.querySelectorAll('.recovery-current-tab-loss li')].map(li => li.textContent),
        alert: Boolean(s.querySelector('[role="alert"]')), disabled: s.querySelector('button').disabled, text: s.textContent }; })()`);
      assert.doesNotMatch(view.text, /pop-up|popup/i, 'the fallback offers an action, not advice to allow pop-ups');
      assert.equal(view.title, 'Renew in this tab instead');
      assert.equal(view.items.length, 3);
      assert.ok(view.alert);
      assert.equal(view.disabled, true, 'button must stay disabled until the loss is acknowledged');
      await clickReal(client, '.recovery-current-tab button');
      assert.equal(await client.evaluate('window.__calls'), 0, 'a disabled button must not start navigation');

      await clickReal(client, '.recovery-current-tab-loss input');
      assert.equal(await client.evaluate(`document.querySelector('.recovery-current-tab button').disabled`), false);

      let since = client.events.length;
      let click = await clickReal(client, '.recovery-current-tab button');
      const cancelPrompt = await until(() => dialogEvents(client, since).find(event => event.params.type === 'beforeunload'), 'beforeunload prompt did not open');
      assert.ok(cancelPrompt);
      await client.command('Page.handleJavaScriptDialog', { accept: false });
      await click.released;
      await until(() => client.evaluate(`document.querySelector('.recovery-current-tab button').textContent === 'Renew in this tab'`), 'button did not reset after Cancel');
      const afterCancel = await client.evaluate(`({ path: location.pathname, calls: window.__calls,
        disabled: document.querySelector('.recovery-current-tab button').disabled,
        acknowledged: document.querySelector('.recovery-current-tab-loss input').checked,
        status: document.querySelector('.recovery-current-tab-status').textContent })`);
      assert.deepEqual(afterCancel, { path: '/harness.html', calls: 1, disabled: false, acknowledged: true,
        status: 'Still on this page? You can try again or return to Operations.' }, 'Cancel must leave the page, acknowledgement and guard intact with no automatic reissue');
      await new Promise(resolve => setTimeout(resolve, 600));
      assert.equal(await client.evaluate('window.__calls'), 1, 'no automatic retry after Cancel');

      since = client.events.length;
      click = await clickReal(client, '.recovery-current-tab button');
      await until(() => dialogEvents(client, since).find(event => event.params.type === 'beforeunload'), 'beforeunload prompt did not reopen');
      await client.command('Page.handleJavaScriptDialog', { accept: true });
      await click.released;
      await until(() => client.evaluate('location.pathname === "/next.html"'), 'Confirm did not navigate');
    });

    await t.test('no pending work: no warning or acknowledgement, and the button navigates without a prompt', async () => {
      await open(client, origin, `state=${encodeURIComponent(JSON.stringify({ pendingUpload: false, selectedFileCount: 0, unsavedTaskDraft: false }))}`);
      const view = await client.evaluate(`({ loss: Boolean(document.querySelector('.recovery-current-tab-loss')), disabled: document.querySelector('.recovery-current-tab button').disabled })`);
      assert.deepEqual(view, { loss: false, disabled: false });
      const since = client.events.length;
      await clickReal(client, '.recovery-current-tab button');
      await until(() => client.evaluate('location.pathname === "/next.html"'), 'did not navigate');
      assert.equal(dialogEvents(client, since).length, 0, 'no leave-page prompt without a registered guard');
    });

    await t.test('a recovery start failure is reported and the page stays usable', async () => {
      await open(client, origin, 'throw=1');
      await clickReal(client, '.recovery-current-tab button');
      const state = await until(() => client.evaluate(`(() => { const s = document.querySelector('.recovery-current-tab-status').textContent; return s ? { s, path: location.pathname, disabled: document.querySelector('.recovery-current-tab button').disabled } : null; })()`), 'no failure status');
      assert.deepEqual(state, { s: 'This tab could not start renewal. Open Viewer from Operations again.', path: '/harness.html', disabled: false });
    });
  } finally {
    try { client?.close(); } catch {}
    try {
      if (browser) { const exited = new Promise(resolve => browser.once('exit', resolve)); browser.kill(); await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]); }
    } finally { release(); }
    if (server) await new Promise(resolve => server.close(resolve));
    if (profile) { try { rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
});
