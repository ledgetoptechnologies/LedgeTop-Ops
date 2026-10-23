// Local workerd/native-service-binding + private-ASSETS proof only. The locked
// Miniflare has a shared assets:storage disk service across Workers, so legacy
// primary responses are synthetic here. This does NOT qualify dual live asset
// collections, application admission, provider preservation, or deployment.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dependencyRoot = process.env.UI_RELEASE_FIXTURE_DEPENDENCY_ROOT
  ?? path.join(root, 'apps/operations/node_modules');
const requireDependency = createRequire(path.join(dependencyRoot, '__fixture.cjs'));
const { Miniflare } = requireDependency('miniflare');
const { build } = requireDependency('esbuild');
const releaseId = 'cfcf5cf992084f7b3658763cdf362fbc37101665';
// The locked local workerd supports dates through this day. This fixture proves
// the service-binding contract at that date, not a future deployment config.
// A new production Worker's intended date still requires separate qualification.
const fixtureCompatibilityDate = '2026-08-06';
const prefix = `/_ui/operations/${releaseId}`;
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

async function bundle(contents) {
  const result = await build({ stdin: { contents, resolveDir: root, sourcefile: 'ui-release-fixture.ts' },
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  return result.outputFiles[0].text;
}

test('native service binding restricts private assets and leaves synthetic legacy routes alone', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'viewer-ui-binding-proof-'));
  const legacy = path.join(directory, 'legacy'), candidate = path.join(directory, 'candidate');
  fs.mkdirSync(path.join(legacy, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(candidate, 'assets'), { recursive: true });
  const legacyHtml = '<!doctype html><title>Retained shell</title>';
  const legacyJs = 'globalThis.retainedClient=true;';
  fs.writeFileSync(path.join(legacy, 'index.html'), legacyHtml);
  fs.writeFileSync(path.join(legacy, 'assets/legacy.js'), legacyJs);
  const files = [
    ['/index.html', `<!doctype html><title>New shell</title><script type="module" src="${prefix}/assets/modern.js"></script><link rel="stylesheet" href="${prefix}/assets/modern.css">`],
    ['/assets/modern.js', 'globalThis.newClient=true;'],
    ['/assets/modern.css', 'body{color:navy}'],
  ];
  const manifest = { schemaVersion: 1, application: 'operations', releaseId,
    files: files.map(([name, content]) => {
      const bytes = Buffer.from(content);
      fs.writeFileSync(path.join(candidate, name.slice(1)), bytes);
      return { path: name, size: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'), mime: mime[path.extname(name)] };
    }) };
  const primaryCode = await bundle(`
    import { fetchUiReleaseAsset, fetchUiReleaseShell } from './packages/shared/src/ui-release-assets.ts';
    const manifest = ${JSON.stringify(manifest)};
    export default { async fetch(request, env) {
      const url = new URL(request.url);
      if (url.pathname === '/viewer') return fetchUiReleaseShell(request, env.NEW_UI, manifest);
      if (url.pathname === '/viewer-old') return new Response(${JSON.stringify(legacyHtml)}, { headers: { 'Content-Type': 'text/html' } });
      if (url.pathname.startsWith('/_ui/')) return fetchUiReleaseAsset(request, env.NEW_UI, manifest);
      if (url.pathname === '/assets/legacy.js') return new Response(${JSON.stringify(legacyJs)}, { headers: { 'Content-Type': 'text/javascript' } });
      return new Response(null, { status: 404 });
    }};
  `);
  const privateCode = await bundle(`
    import { servePrivateUiReleaseAsset } from './packages/shared/src/ui-release-assets.ts';
    const manifest = ${JSON.stringify(manifest)};
    export default { fetch(request, env) {
      const forbidden = ['cookie','authorization','cf-access-jwt-assertion','referer','x-private-probe'];
      if (new URL(request.url).search || forbidden.some(name => request.headers.has(name)))
        return new Response('Credential forwarding detected', { status: 500 });
      return servePrivateUiReleaseAsset(request, env.ASSETS, manifest);
    }};
  `);
  const assetOptions = (directory, workerName) => ({ directory, workerName, binding: 'ASSETS',
    routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
    assetConfig: { html_handling: 'none', not_found_handling: 'none' } });
  let runtime;
  t.after(async () => {
    if (runtime) await runtime.dispose();
    // Only delete the exact test-created directory under the OS temporary root.
    const resolved = path.resolve(directory), temporary = path.resolve(os.tmpdir()) + path.sep;
    assert.ok(resolved.startsWith(temporary) && path.basename(resolved).startsWith('viewer-ui-binding-proof-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  runtime = new Miniflare({ workers: [
    { name: 'primary-ui-fixture', modules: true, script: primaryCode,
      compatibilityDate: fixtureCompatibilityDate, serviceBindings: { NEW_UI: 'private-ui-fixture' } },
    { name: 'private-ui-fixture', modules: true, script: privateCode,
      compatibilityDate: fixtureCompatibilityDate, assets: assetOptions(candidate, 'private-ui-fixture') },
  ] });
  await runtime.ready;
  const sensitiveHeaders = { cookie: 'test-session=sentinel', authorization: 'Bearer test-sentinel',
    'cf-access-jwt-assertion': 'test-sentinel', referer: 'https://ops.invalid/private?capability=sentinel',
    'x-private-probe': 'test-sentinel' };
  const shell = await runtime.dispatchFetch('https://ops.invalid/viewer?capability=test-sentinel', { headers: sensitiveHeaders });
  assert.equal(shell.status, 200);
  assert.equal(shell.headers.get('cache-control'), 'no-store');
  const html = await shell.text();
  assert.equal(html, files[0][1]);
  assert.ok(html.includes(`${prefix}/assets/modern.js`));
  assert.ok(!html.includes('<base'));
  const modern = await runtime.dispatchFetch(`https://ops.invalid${prefix}/assets/modern.js?capability=test-sentinel`, { headers: sensitiveHeaders });
  assert.equal(modern.status, 200);
  assert.equal(await modern.text(), 'globalThis.newClient=true;');
  assert.match(modern.headers.get('cache-control'), /immutable/);
  assert.equal(modern.headers.get('set-cookie'), null);
  const head = await runtime.dispatchFetch(`https://ops.invalid${prefix}/assets/modern.css`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  for (const target of [
    `${prefix}/assets/missing.js`,
    `${prefix}/assets/MODERN.js`,
    `/_ui/client/${releaseId}/assets/modern.js`,
    `/_ui/operations/${'1'.repeat(40)}/assets/modern.js`,
  ]) {
    const response = await runtime.dispatchFetch(`https://ops.invalid${target}`);
    assert.equal(response.status, 404, target);
  }
  const disallowed = await runtime.dispatchFetch(`https://ops.invalid${prefix}/assets/modern.js`, { method: 'POST' });
  assert.equal(disallowed.status, 405);
  const retained = await runtime.dispatchFetch('https://ops.invalid/assets/legacy.js');
  assert.equal(retained.status, 200);
  assert.equal(await retained.text(), legacyJs);
  const rollback = await runtime.dispatchFetch('https://ops.invalid/viewer-old');
  assert.equal(await rollback.text(), legacyHtml);
  const oldNewTab = await runtime.dispatchFetch(`https://ops.invalid${prefix}/assets/modern.js`);
  assert.equal(await oldNewTab.text(), 'globalThis.newClient=true;');
});
