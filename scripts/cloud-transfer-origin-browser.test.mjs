import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from '../apps/client/node_modules/playwright/index.mjs';
import { build } from '../apps/client/node_modules/esbuild/lib/main.js';

test('cloud-copy callback reaches its opener only when the original origin is retained', async () => {
  const bundle = await build({
    stdin: { contents: `import { notifyCloudTransferOpener } from './apps/client/src/client/cloud-transfer.ts';\nnotifyCloudTransferOpener(location.href);`, resolveDir: process.cwd(), loader: 'js' },
    bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent',
  });
  const callbackPage = `<!doctype html><title>Synthetic callback</title><script>${bundle.outputFiles[0].text}</script>`;
  const target = createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(callbackPage); });
  target.listen(0, '127.0.0.1'); await once(target, 'listening');
  const targetOrigin = `http://127.0.0.1:${target.address().port}`;
  const source = createServer((req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: `${targetOrigin}${req.url.replace('/redirect', '/callback')}` }); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(req.url.startsWith('/callback') ? callbackPage : '<!doctype html><title>Synthetic opener</title>');
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const origin = `http://127.0.0.1:${source.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.env.CANONICAL_DELIVERY_BROWSER_CHANNEL === 'msedge' ? { channel: 'msedge' } : {}) });
    const page = await browser.newPage();
    await page.goto(origin);
    const query = '?cloudTransferJob=synthetic-job&cloudTransferNonce=synthetic-nonce&cloudTransferProvider=dropbox';
    async function run(path) {
      await page.evaluate(() => {
        window.syntheticCallbackReceived = false;
        window.addEventListener('message', event => {
          if (event.data?.type === 'ltds-cloud-authorization') window.syntheticCallbackReceived = true;
        }, { once: true });
      });
      const popupPromise = page.waitForEvent('popup');
      await page.evaluate(url => { window.open(url, '_blank'); }, `${origin}${path}${query}`);
      const popup = await popupPromise;
      await popup.waitForURL(path === '/redirect' ? `${targetOrigin}/callback${query}` : `${origin}/callback${query}`);
      await popup.waitForLoadState('load');
      // Check only after the actual bundled callback has loaded and run.
      await page.waitForTimeout(200);
      const received = await page.evaluate(() => window.syntheticCallbackReceived);
      await popup.close();
      return received;
    }
    assert.equal(await run('/callback'), true, 'same-origin callback reaches opener');
    assert.equal(await run('/redirect'), false, 'cross-origin redirect breaks target-origin delivery');
  } finally {
    if (browser) await browser.close();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});
