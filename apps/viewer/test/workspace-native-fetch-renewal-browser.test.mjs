import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
import { acquireBrowserHarnessLock } from './browser-lock.mjs';

const browserPath = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('workspace renewal redeems a grant with default native browser fetch and retains stable identity', { timeout: 45_000 }, async t => {
  const executable = browserPath();
  if (!executable) return t.skip('Chromium/Edge browser unavailable');
  const release = await acquireBrowserHarnessLock({ root: path.resolve('.') });
  const profile = mkdtempSync(path.join(tmpdir(), 'ltds-workspace-native-fetch-'));
  let redemptions = 0, received;
  const token = 't'.repeat(40), grant = 'g'.repeat(40), ops = 'https://ops.example.test';
  const id = 'workspace_session_0000000000000001', subject = 'ops:fixture';
  const originalExpiry = new Date(Date.now() + 120000).toISOString();
  const nextExpiry = new Date(Date.now() + 1800000).toISOString();
  const viewer = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture.test');
    if (url.pathname === '/api/v1/admin-sessions/redeem') {
      redemptions++;
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      received = { method: req.method, authorization: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) };
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify({accessToken:token, controllerOrigin:ops, session:{id,subject,expiresAt:nextExpiry}}));
    }
    if (['/workspace-renewal.mjs', '/workspace-renewal-transport.mjs'].includes(url.pathname)) {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end(readFileSync(path.join(root, url.pathname.slice(1))));
    }
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'self'");
    res.setHeader('Content-Type', 'text/html');
    if(url.pathname==='/resume')return res.end(`<!doctype html><body><textarea id="draft">Unsaved processing draft</textarea><script type="module">
      import {WorkspaceSessionRenewal} from '/workspace-renewal.mjs';
      const envelope=${JSON.stringify({accessToken:token,controllerOrigin:ops,session:{id,subject,expiresAt:originalExpiry}})};
      let clock=Date.now(),available=false,opens=0,paused=0,resumed=0;const timers=[];
      window.open=()=>{opens++;throw new Error('No automatic popups');};
      const controller={closed:false,postMessage(message){if(available&&message.type==='ltds-viewer:workspace-session-expiring')queueMicrotask(()=>renewal.redeemGrant(${JSON.stringify(grant)},message.requestId,'opener'));}};
      const renewal=new WorkspaceSessionRenewal({controllerWindow:controller,envelope,accessToken:envelope.accessToken,now:()=>clock,
        setTimer:(handler,delay)=>{const timer={handler,delay};timers.push(timer);return timer;},clearTimer:timer=>{timer.cleared=true;},
        onPaused:()=>paused++,onResumed:()=>resumed++,onExpired:()=>{throw new Error('Transient expiry must remain recoverable');}});
      renewal.start();clock=Date.parse(envelope.session.expiresAt)+1;renewal.retryAttempt=5;renewal.requestRenewal('expired-offline');
      const restored=renewal.waitForRenewal({whileExpired:true});window.dispatchEvent(new Event('focus'));
      timers.findLast(timer=>timer.delay===10000&&!timer.cleared).handler();
      available=true;window.dispatchEvent(new Event('online'));await restored;
      document.body.setAttribute('data-result',JSON.stringify({id:renewal.session.id,token:renewal.accessToken,paused,resumed,opens,draft:document.querySelector('#draft').value,dialogs:document.querySelectorAll('dialog').length}));renewal.dispose();
    </script>`);
    res.end(`<!doctype html><body>pending<script type="module">
      import {WorkspaceSessionRenewal} from '/workspace-renewal.mjs';
      const envelope = ${JSON.stringify({accessToken:token,controllerOrigin:ops,session:{id,subject,expiresAt:originalExpiry}})};
      let installed = null;
      const renewal = new WorkspaceSessionRenewal({
        controllerWindow:{closed:false,postMessage(){}}, envelope, accessToken:envelope.accessToken,
        onSession:value=>{installed=value}, onExpired:()=>{throw new Error('unexpected expiry')}
      });
      renewal.pendingRequestId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
      await renewal.redeemGrant(${JSON.stringify(grant)}, renewal.pendingRequestId, 'opener');
      renewal.dispose();
      document.body.setAttribute('data-result', JSON.stringify(installed));
    </script>`);
  });
  const viewerOrigin = await listen(viewer);
  let browser;
  try {
    browser = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--no-sandbox',
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
    { windowsHide: true, stdio: 'ignore' });
    const deadline = Date.now() + 15_000, portFile = path.join(profile, 'DevToolsActivePort');
    while (!existsSync(portFile) && Date.now() < deadline) await delay(50);
    assert.ok(existsSync(portFile), 'browser DevTools endpoint must start');
    const devtools = `http://127.0.0.1:${readFileSync(portFile, 'utf8').split(/\r?\n/)[0]}`;
    for (const route of ['/workspace','/resume']) {
      const target = await (await fetch(`${devtools}/json/new?${encodeURIComponent(viewerOrigin + route)}`, { method: 'PUT' })).json();
      const socket = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
      let commandId = 0;
      const evaluate = expression => new Promise((resolve, reject) => {
        const requestId = ++commandId, timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Native fetch renewal result timed out')); }, 5000);
        function receive(event) { const message = JSON.parse(event.data); if (message.id !== requestId) return; clearTimeout(timer); socket.removeEventListener('message', receive); resolve(message.result?.result?.value); }
        socket.addEventListener('message', receive);
        socket.send(JSON.stringify({ id: requestId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
      });
      let result;
      for (let attempts = 0; attempts < 100 && !result; attempts++) { result = await evaluate('document.body?.getAttribute("data-result")'); if (!result) await delay(50); }
      socket.close();
      assert.deepEqual(JSON.parse(result),route==='/workspace'?{accessToken:token,controllerOrigin:ops,session:{id,subject,expiresAt:nextExpiry}}:{id,token,paused:1,resumed:1,opens:0,draft:'Unsaved processing draft',dialogs:0});
    }
    assert.equal(redemptions, 2, 'each browser workspace redeems exactly one fresh grant');
    assert.deepEqual(received, {method:'POST',authorization:'Bearer '+token,body:{grant}});
  } finally {
    if (browser && browser.exitCode === null) { const closed = new Promise(resolve => browser.once('close', resolve)); browser.kill(); await closed; }
    await Promise.all([viewer].map(server => new Promise(resolve => server.close(resolve))));
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { t.diagnostic(`Browser profile cleanup unavailable: ${error.code}`); }
    await release();
  }
});
