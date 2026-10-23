// Explicit offline qualification using separately staged real build outputs.
// No provider namespace or browser acceptance is implied. A requested date is
// exercised only with the dependency directory's matching native runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import catalog from '../packages/shared/src/ui-release-catalog.generated.json' with { type: 'json' };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packetRoot = process.env.UI_RELEASE_PACKET_ROOT;
const compatibilityDate = process.env.UI_RELEASE_FIXTURE_COMPATIBILITY_DATE ?? '2026-08-06';
assert.match(compatibilityDate, /^\d{4}-\d{2}-\d{2}$/);
test('real private Worker serves every registered file with exact MIME and bytes', { skip: !packetRoot }, async t => {
  const dependencyRoot = process.env.UI_RELEASE_FIXTURE_DEPENDENCY_ROOT ?? path.join(root, 'apps/operations/node_modules');
  const requireDependency = createRequire(path.join(dependencyRoot, '__fixture.cjs'));
  assert.equal(process.env.MINIFLARE_WORKERD_PATH, undefined, 'Use the matching installed runtime, not a binary override');
  const { Miniflare, convertV4MiniflareOptions } = requireDependency('miniflare');
  const { build } = requireDependency('esbuild');
  const result = await build({ entryPoints: [path.join(root, 'apps/ui-release-assets/src/index.ts')],
    bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022' });
  const options = { workers: [{ name: 'private-ui-packet-proof', modules: true, script: result.outputFiles[0].text,
    compatibilityDate,
    assets: { directory: path.join(packetRoot, 'dist'), workerName: 'private-ui-packet-proof', binding: 'ASSETS',
      routerConfig: { has_user_worker: true, invoke_user_worker_ahead_of_assets: true },
      assetConfig: { html_handling: 'none', not_found_handling: 'none' } },
  }] };
  let runtimeOptions = options;
  if (typeof convertV4MiniflareOptions === 'function') {
    // This fixture has one private Worker only. V5 assigns its asset owner from
    // worker.name; its explicit converter rejects the V4 workerName override.
    delete runtimeOptions.workers[0].assets.workerName;
    runtimeOptions = convertV4MiniflareOptions(runtimeOptions);
    assert.equal(runtimeOptions.workers[0].config.compatibilityDate, compatibilityDate);
  }
  const runtime = new Miniflare(runtimeOptions);
  t.after(() => runtime.dispose());
  await runtime.ready;
  let checked = 0;
  for (const release of catalog.releases) {
    const prefix = `/_ui/${release.application}/${release.releaseId}`;
    for (const file of release.files) {
      const url = `https://ui-release.invalid${prefix}${file.path}`;
      const response = await runtime.dispatchFetch(url);
      assert.equal(response.status, 200, url);
      assert.equal(response.headers.get('content-type')?.split(';')[0], file.mime, url);
      // workerd may omit Content-Length when serializing a streamed response.
      // The stream itself must still carry the exact pinned bytes below.
      if (response.headers.has('content-length')) assert.equal(response.headers.get('content-length'), String(file.size), url);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, file.size, url);
      assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), file.sha256, url);
      assert.ok(bytes.equals(fs.readFileSync(path.join(packetRoot, 'dist', prefix.slice(1), file.path.slice(1)))), url);
      assert.equal(response.headers.get('cache-control'), file.path === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
      checked++;
    }
    const head = await runtime.dispatchFetch(`https://ui-release.invalid${prefix}/index.html`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    for (const suffix of ['/missing.js', '/.assetsignore', '/assets/', '/INDEX.html']) {
      assert.equal((await runtime.dispatchFetch(`https://ui-release.invalid${prefix}${suffix}`)).status, 404);
    }
    assert.equal((await runtime.dispatchFetch(`https://ui-release.invalid${prefix}/index.html`, { method: 'POST' })).status, 405);
    assert.equal((await runtime.dispatchFetch(`https://public.invalid${prefix}/index.html`)).status, 404);
    assert.equal((await runtime.dispatchFetch(`https://ui-release.invalid${prefix}/index.html?token=sentinel`)).status, 404);
    assert.equal((await runtime.dispatchFetch(`https://ui-release.invalid${prefix}/index.html`, { headers: { cookie: 'sentinel' } })).status, 404);
  }
  assert.equal(checked, 258);
  for (const suffix of [
    `/_ui/foreign/${catalog.releases[0].releaseId}/index.html`,
    `/_ui/operations/${'1'.repeat(40)}/index.html`, '/_ui',
    `/_ui/operations/${catalog.releases[0].releaseId}/assets/%2fmissing.js`,
  ]) assert.equal((await runtime.dispatchFetch(`https://ui-release.invalid${suffix}`)).status, 404);
});
