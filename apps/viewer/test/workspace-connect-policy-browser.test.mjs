import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { workspaceConnectSources } from '../server/workspaceConnectPolicy.js';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const browserPath = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real browser permits background auth fetch only from workspace and blocks a foreign authority', { timeout: 45_000 }, async t => {
  const executable = browserPath();
  if (!executable) return t.skip('Chromium/Edge browser unavailable');
  const release = await acquireBrowserHarnessLock({ root: path.resolve('.') });
  const profile = mkdtempSync(path.join(tmpdir(), 'ltds-workspace-csp-'));
  let viewerOrigin, authRequests = 0, foreignRequests = 0;
  const auth = createServer((req, res) => {
    authRequests++;
    res.setHeader('Access-Control-Allow-Origin', viewerOrigin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Content-Type', 'application/json');
    res.end('{"authenticated":true}');
  });
  const foreign = createServer((_req, res) => { foreignRequests++; res.end('unexpected'); });
  const authOrigin = await listen(auth), foreignOrigin = await listen(foreign);
  const viewer = createServer((req, res) => {
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'unsafe-inline'; connect-src ${workspaceConnectSources(req.url, authOrigin)}`);
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><body>pending<script>
      (async () => {
        const allowed = await fetch(${JSON.stringify(authOrigin + '/challenge')}, {credentials:'include'}).then(r=>r.json()).then(r=>r.authenticated).catch(()=>false);
        const forbidden = await fetch(${JSON.stringify(foreignOrigin + '/challenge')}).then(()=>false).catch(()=>true);
        document.body.setAttribute('data-result', JSON.stringify({allowed,forbidden}));
      })();
    </script>`);
  });
  viewerOrigin = await listen(viewer);
  let browser;
  try {
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 15_000, portFile = path.join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(portFile), 'browser DevTools endpoint must start');
    const devtools = `http://127.0.0.1:${readFileSync(portFile, 'utf8').split(/\r?\n/)[0]}`;
    for (const route of ['/workspace', '/view/token']) {
      const target = await (await fetch(`${devtools}/json/new?${encodeURIComponent(viewerOrigin + route)}`, { method: 'PUT' })).json();
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      let id = 0;
      const evaluate = expression => new Promise((resolve, reject) => {
        const requestId = ++id, timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('CSP result timed out')); }, 5000);
        function receive(event) { const message = JSON.parse(event.data); if (message.id !== requestId) return; clearTimeout(timer); socket.removeEventListener('message', receive); resolve(message.result?.result?.value); }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      let result;
      for (let attempts = 0; attempts < 100 && !result; attempts++) { result = await evaluate('document.body?.getAttribute("data-result")'); if (!result) await delay(50); }
      socket.close();
      assert.deepEqual(JSON.parse(result), { allowed: route === '/workspace', forbidden: true });
    }
    assert.equal(authRequests, 1, 'only the workspace may contact the auth fixture');
    assert.equal(foreignRequests, 0, 'CSP blocks foreign fetch before a network request');
  } finally {
    if (browser && browser.exitCode === null) { const closed = new Promise(resolve => browser.once('close', resolve)); browser.kill(); await closed; }
    await Promise.all([viewer, auth, foreign].map(server => new Promise(resolve => server.close(resolve))));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { t.diagnostic(`Browser profile cleanup unavailable: ${error.code}`); }
    await release();
  }
});
