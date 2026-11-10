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
      return await page.evaluate(async url => {
        const received = new Promise(resolve => {
          const timer = setTimeout(() => { window.removeEventListener('message', listener); resolve(false); }, 1000);
          function listener(event) { if (event.data?.type === 'ltds-cloud-authorization') { clearTimeout(timer); window.removeEventListener('message', listener); resolve(true); } }
          window.addEventListener('message', listener);
        });
        const popup = window.open(url, '_blank');
        const result = await received;
        popup?.close();
        return result;
      }, `${origin}${path}${query}`);
    }
    assert.equal(await run('/callback'), true, 'same-origin callback reaches opener');
    assert.equal(await run('/redirect'), false, 'cross-origin redirect breaks target-origin delivery');
  } finally {
    if (browser) await browser.close();
    await Promise.all([new Promise(resolve => source.close(resolve)), new Promise(resolve => target.close(resolve))]);
  }
});
