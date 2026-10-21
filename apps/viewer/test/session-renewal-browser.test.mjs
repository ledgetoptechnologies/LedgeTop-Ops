import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';
import { acquireBrowserHarnessLock } from './browser-lock.mjs';
import { makeGlb } from './helpers/lod-fixture.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const channelId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const grant = '11111111-2222-4333-8444-555555555555';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const browserPath = () => [process.env.CHROME_PATH, process.env.EDGE_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean).find(existsSync);

// Same isolated CDP harness used by the other repository browser suites.
class CdpClient {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
      else pending.resolve(message.result || {});
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    return new CdpClient(socket);
  }
  command(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, 30_000);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { this.socket.close(); }
}

async function waitFor(client, expression, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await client.evaluate(expression);
    if (value) return value;
    await delay(100);
  }
  throw new Error(description);
}

async function startFixture({ proactive = false } = {}) {
  const vite = await createViteServer({ root, appType: 'spa', logLevel: 'silent', optimizeDeps: { force: true },
    server: { middlewareMode: true, hmr: false } });
  const base = '/session-assets/session-token/session-browser-fixture/derivatives';
  const model = {
    id: 'session-browser-fixture', title: 'Session renewal fixture', displayUnits: 'imperial', activeVersion: { id: 'version-one' },
    assets: { glb: `${base}/original.glb`, obj: null, tiles: `${base}/tileset.json`,
      shots: null, cameraPhotos: null, ortho: null, dsm: null, dtm: null, ept: null,
      pointCloud: null, pointCloudFormat: null },
    lodProvenance: { schemaVersion: 2, sourceAsset: 'original.glb', sourceSha256: 'a'.repeat(64),
      geometry: 'bounded-triangle-equivalence', textures: 'byte-identical-material-equivalence', leafGeometricError: 0,
      audit: { algorithm: 'ltds-glb-leaf-equivalence-v2', triangleCount: 1, equivalenceSha256: 'b'.repeat(64),
        coordinateTolerance: 0.0001, maxNumericDelta: 0, artifactCount: 2 } },
    georef: { rtc: { e: 367257, n: 4759982, z: 0 }, bboxCenter: { x: 0, y: 0, z: 0 }, utmZoneLon0Deg: -87 },
  };
  const box = { box: [0, 0, 0, 10, 0, 0, 0, 10, 0, 0, 0, 1] };
  const tileset = { asset: { version: '1.1' }, geometricError: 1000,
    root: { boundingVolume: box, geometricError: 1000, refine: 'REPLACE', content: { uri: 'root.glb' },
      children: [{ boundingVolume: box, geometricError: 100, refine: 'REPLACE', content: { uri: 'shell.glb' },
        children: ['leaf.glb', 'late.glb'].map(uri => ({ boundingVolume: box, geometricError: 0, content: { uri } })) }] } };
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXkAAAAASUVORK5CYII=', 'base64');
  const glb = makeGlb([[[-10, -10, 0], [10, -10, 0], [0, 10, 0]]], png, { unlit: true });
  const requests = [];
  let expired = false, unavailable = false, issued = false, redemptions = 0;
  let deferLate = false, lateDenial = null;
  let expiresAt = new Date(Date.now() + (proactive ? 5 * 60_000 + 15_000 : 10 * 60_000)).toISOString();
  const session = () => ({ model, sessionId: 'session-browser', sessionMode: 'published', subject: 'ops:fixture', audience: 'ops',
    accessToken: 'session-token', expiresAt, permissions: { view: true, measure: true, cameras: true },
    displayUnits: 'imperial', allowedEmbedOrigins: [] });
  const server = createServer(async (request, reply) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const send = (status, body, type = 'application/json') => {
      requests.push({ path: url.pathname, status });
      reply.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      reply.end(Buffer.isBuffer(body) || typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.pathname === '/controller.html') return send(200, `<!doctype html><script type="module">
      import { ReviewSessionController } from '/review-session-controller.mjs';
      window.controller = new ReviewSessionController({ origin: location.origin, storage: localStorage, issueGrant: async () => {
        const response = await fetch('/issue-grant', { method: 'POST' });
        if (!response.ok) throw Object.assign(new Error('grant unavailable'), { status: response.status });
        return response.json();
      } });
      const authentication = await fetch('/workspace-current').then(response => response.json());
      window.controller.setAuthenticatedSubject(authentication.subject);
      if (!new URL(location.href).searchParams.has('restore')) window.controller.track('${channelId}', { sessionMode:'published', outputId:'version-one',
        modelId:'session-browser-fixture', modelVersionId:'version-one', sessionTtlSeconds:1800 });
      window.controllerReady = true;
    </script>`, 'text/html');
    if (url.pathname === '/workspace-current') return send(200, { subject: 'ops:fixture' });
    if (url.pathname === '/api/v1/health') return send(200, { ok: true });
    if (url.pathname === '/api/v1/sessions/current') return send(200, session());
    if (url.pathname === '/issue-grant') {
      if (unavailable) return send(403, { error: 'authorization_required' });
      issued = true;
      return send(200, { grant, sessionMode: 'published', modelId: model.id,
        modelVersionId: 'version-one', sessionTtlSeconds: 1800 });
    }
    if (url.pathname === '/api/v1/sessions/redeem') {
      let body = ''; for await (const chunk of request) body += chunk;
      if (!issued || JSON.parse(body).grant !== grant || request.headers.authorization !== 'Bearer session-token') {
        return send(403, { error: 'invalid_grant' });
      }
      issued = false; expired = false; redemptions += 1;
      expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      return send(200, session());
    }
    if (url.pathname === `${base}/tileset.json`) return send(200, tileset);
    if (url.pathname.startsWith(`${base}/`) && url.pathname.endsWith('.glb')) {
      if (expired && url.pathname.endsWith('/late.glb')) {
        if (deferLate) { lateDenial = () => send(403, { error: 'old request denied' }); return; }
        return send(403, { error: 'not authorized' });
      }
      if (expired && url.pathname.endsWith('/leaf.glb')) return send(403, { error: 'not authorized' });
      return send(200, glb, 'model/gltf-binary');
    }
    vite.middlewares(request, reply);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { vite, server, origin: `http://127.0.0.1:${server.address().port}`, requests,
    expire: blocked => { expired = true; unavailable = blocked; deferLate = !blocked; },
    latePending: () => Boolean(lateDenial), releaseLate: () => { lateDenial?.(); lateDenial = null; },
    redemptions: () => redemptions };
}

for (const scenario of ['denied', 'proactive', 'restored']) {
const proactive = scenario === 'proactive';
test(`published session renews ${proactive ? 'proactively without denied tiles' : scenario === 'restored' ? 'after an expired viewer reconnects to a fresh workspace' : 'denied tiles'} over BroadcastChannel and retains the view when authorization ends`,
  { timeout: 180_000 }, async t => {
    const executable = browserPath();
    if (!executable) return t.skip('Chromium/Edge browser unavailable');
    const release = await acquireBrowserHarnessLock({ root });
    let fixture, browser, profile, viewer, controller;
    try {
      fixture = await startFixture({ proactive });
      profile = mkdtempSync(path.join(tmpdir(), 'ltds-session-renewal-browser-'));
      const portServer = createNetServer();
      await new Promise(resolve => portServer.listen(0, '127.0.0.1', resolve));
      const port = portServer.address().port;
      await new Promise(resolve => portServer.close(resolve));
      browser = spawn(executable, ['--headless=new', '--disable-gpu', '--disable-dev-shm-usage',
        '--no-first-run', '--no-default-browser-check', '--no-sandbox', '--remote-debugging-address=127.0.0.1',
        `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
      const devtools = `http://127.0.0.1:${port}`, deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try { if ((await fetch(`${devtools}/json/version`)).ok) break; } catch {}
        await delay(100);
      }
      const page = async url => {
        const target = await (await fetch(`${devtools}/json/new?about:blank`, { method: 'PUT' })).json();
        const client = await CdpClient.connect(target.webSocketDebuggerUrl);
        await client.command('Page.enable'); await client.command('Runtime.enable');
        await client.command('Page.addScriptToEvaluateOnNewDocument', { source:
          'window.clockAdvance = 0; const realNow = Date.now.bind(Date); Date.now = () => realNow() + window.clockAdvance;' });
        await client.command('Page.navigate', { url });
        return client;
      };
      controller = await page(`${fixture.origin}/controller.html`);
      await waitFor(controller, 'window.controllerReady === true', 'isolated published controller did not initialize');
      viewer = await page(`${fixture.origin}/session/active/session-browser?lodDistanceDemand=0#reviewController=${channelId}`);
      await waitFor(viewer, `window.__ltds?.tiles()?.root?.children?.[0]?.children?.[0]?.engineData?.scene
        && window.__ltds.tiles().root.children[0].children[1].engineData.scene
        && window.__ltds.tiles().visibleTiles.size > 0`, 'resident fixture tiles did not load');
      await viewer.evaluate(`window.originalRenderer = window.__ltds.tiles();
        window.originalCamera = window.__ltds.camera().position.toArray();
        window.originalShell = window.originalRenderer.root.children[0].engineData.scene; true;`);
      const denyLeaf = async advance => {
        await controller.evaluate(`window.clockAdvance = ${advance};`);
        await viewer.evaluate(`(() => { window.clockAdvance = ${advance};
          const renderer = window.__ltds.tiles();
          for (const leaf of renderer.root.children[0].children) {
            renderer.lruCache.remove(leaf); renderer.requestTileContents(leaf);
          } })()`);
      };
      if (scenario === 'restored') {
        // Match a workspace document going away: persist only routing hints,
        // close its real channel, and retain the already-open Viewer document.
        await controller.evaluate(`window.controller.suspend({ preserve: true }); true;`);
        const saved = await controller.evaluate(`JSON.parse(localStorage.getItem('ltds-viewer-model-controller-contexts-v1'))`);
        assert.equal(saved.subject, 'ops:fixture');
        assert.equal(saved.records.length, 1);
        assert.deepEqual(Object.keys(saved.records[0]).sort(), ['channelId', 'context', 'updatedAt']);
        assert.doesNotMatch(JSON.stringify(saved), /accessToken|Bearer|grant|permissions|embedUrl/);
        await controller.command('Page.navigate', { url: 'about:blank' });
        // Resume an overnight tab through its public lifecycle event. The real
        // unanswered-controller timeout must hide expired access before restore.
        await viewer.evaluate(`window.clockAdvance = 11 * 60_000; window.dispatchEvent(new Event('focus')); true;`);
        await waitFor(viewer, `window.__ltds.sessionDiagnostics().access === 'unavailable'
          && window.__ltds.sessionDiagnostics().expiresInSeconds < 0`, 'expired viewer did not hide access without its workspace', 45_000);
        assert.equal(fixture.redemptions(), 0);
        assert.equal(fixture.requests.some(item => item.path === '/issue-grant'), false);
        await controller.command('Page.addScriptToEvaluateOnNewDocument', { source: 'window.clockAdvance = 11 * 60_000;' });
        await controller.command('Page.navigate', { url: `${fixture.origin}/controller.html?restore=1` });
        await waitFor(controller, `window.controllerReady === true && window.controller.records.size === 1`, 'fresh authenticated workspace did not restore its saved channel');
        await waitFor(viewer, `window.__ltds.sessionDiagnostics().access === 'active'
          && window.__ltds.sessionDiagnostics().expiresInSeconds > 1000`, 'fresh workspace did not restore the expired viewer');
        assert.equal(fixture.redemptions(), 1);
        assert.equal(fixture.requests.filter(item => item.path === '/issue-grant').length, 1);
        assert.equal(fixture.requests.filter(item => item.path === '/workspace-current').length, 2);
        assert.equal(fixture.requests.some(item => item.status === 401 || item.status === 403), false,
          'workspace restoration must not require a denied asset request');
      } else if (proactive) {
        await waitFor(viewer, `window.__ltds.sessionDiagnostics().access === 'active'
          && window.__ltds.sessionDiagnostics().expiresInSeconds > 1000`, 'scheduled proactive renewal did not redeem a grant');
        assert.equal(fixture.redemptions(), 1);
        assert.equal(fixture.requests.filter(item => item.path === '/issue-grant').length, 1);
        assert.equal(fixture.requests.some(item => item.status === 401 || item.status === 403), false,
          'proactive renewal must not depend on an authorization failure');
      } else {
      fixture.expire(false);
      await denyLeaf(6 * 60_000);
      await waitFor(viewer, `window.__ltds.sessionDiagnostics().access === 'active'
        && window.__ltds.tiles().root.children[0].children[0].engineData.scene
        && window.__ltds.sessionDiagnostics().expiresInSeconds > 1000`, 'denied tile did not recover after fresh grant redemption');
      assert.equal(fixture.redemptions(), 1);
      assert.equal(fixture.latePending(), true, 'another old-access request is still in flight after redemption');
      fixture.releaseLate();
      await waitFor(viewer, '!!window.__ltds.tiles().root.children[0].children[1].engineData.scene', 'late old-access denial did not retry with renewed access');
      assert.equal(fixture.requests.filter(item => item.path === '/issue-grant').length, 1, 'late denial must not request another grant');
      assert.equal(await viewer.evaluate("window.__ltds.sessionDiagnostics().access"), 'active');
      assert.ok(fixture.requests.some(item => item.path.endsWith('/leaf.glb') && item.status === 403));
      }
      assert.ok(fixture.requests.some(item => item.path === '/api/v1/sessions/redeem' && item.status === 200));
      assert.equal(await viewer.evaluate('window.__ltds.tiles() === window.originalRenderer'), true);
      assert.equal(await viewer.evaluate('window.__ltds.tiles().root.children[0].engineData.scene === window.originalShell'), true);
      assert.deepEqual(await viewer.evaluate('window.__ltds.camera().position.toArray()'), await viewer.evaluate('window.originalCamera'));

      fixture.expire(true);
      await denyLeaf(26 * 60_000);
      await waitFor(viewer, `window.__ltds.sessionDiagnostics().renewalBlocked === true
        && document.querySelector('#lod-status').textContent.includes('access unavailable')`, 'terminal controller failure was not shown');
      await delay(1_000); // several ordinary quality updates must not erase the access status
      assert.match(await viewer.evaluate("document.querySelector('#lod-status').textContent"), /reopen this model/);
      assert.equal(await viewer.evaluate('window.__ltds.tiles() === window.originalRenderer'), true);
      assert.equal(await viewer.evaluate('window.__ltds.tiles().root.children[0].engineData.scene === window.originalShell'), true);
      assert.ok(await viewer.evaluate('window.__ltds.tiles().visibleTiles.size > 0'));
      assert.deepEqual(await viewer.evaluate('window.__ltds.camera().position.toArray()'), await viewer.evaluate('window.originalCamera'));
      assert.equal(fixture.redemptions(), 1, 'terminal failure must not redeem another grant');
    } catch (error) {
      t.diagnostic(JSON.stringify({ requests: fixture?.requests,
        session: await viewer?.evaluate('window.__ltds?.sessionDiagnostics()').catch(() => null),
        tile: await viewer?.evaluate(`(() => { const tile=window.__ltds?.tiles()?.root?.children?.[0]?.children?.[0];
          return { loaded:!!tile?.engineData?.scene, state:tile?.internal?.loadingState,
            status:document.querySelector('#lod-status')?.textContent,
            fallback:[...window.__ltds.tiles().lodFallbackTiles||[]].map(t=>({uri:t.content?.uri,state:t.internal.loadingState,visible:t.traversal.visible,active:t.traversal.active})),
            chain:[tile,tile?.parent,tile?.parent?.parent].map(t=>({uri:t?.content?.uri,state:t?.internal.loadingState,traversal:t?.traversal})) }; })()`).catch(() => null),
        controller: await controller?.evaluate(`Array.from(window.controller?.records?.values()||[]).map(record=>({
          expiresAt:record.expiresAt,pending:record.pending,awaitingRenewed:record.awaitingRenewed,activeRequestId:record.activeRequestId
        }))`).catch(() => null) }));
      throw error;
    } finally {
      if (viewer) { try { await viewer.command('Browser.close'); } catch {} }
      viewer?.close(); controller?.close(); browser?.kill();
      fixture?.server.closeAllConnections?.();
      if (fixture?.server) await new Promise(resolve => fixture.server.close(resolve));
      await fixture?.vite.close();
      if (profile) {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(100); }
        }
      }
      release();
    }
  });
}
