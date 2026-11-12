import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { handleRetiredRequest, validateRetirePolicy } from './legacy-staging-retirement/retire-core.mjs';
import { buildFacadeSource, buildReceipt, completeReceipt, validateSpec } from './legacy-staging-retirement/generate.mjs';

const hex = bytes => createHash('sha256').update(bytes).digest('hex');
const JS = Buffer.from('console.log("old chunk")'), CSS = Buffer.from('body{color:#000}'), UI = Buffer.from('ui release file');
const VERSION = '3c4de3e4-c70f-4288-8eb6-59c7f288b89d';
const files = [
  { path: '/assets/app-1a2b.js', size: JS.length, sha256: hex(JS), mime: 'text/javascript', binding: 'ASSETS' },
  { path: '/assets/app-3c4d.css', size: CSS.length, sha256: hex(CSS), mime: 'text/css', binding: 'ASSETS' },
  { path: '/ui/release/app-9f.js', size: UI.length, sha256: hex(UI), mime: 'text/javascript', binding: 'UI_RELEASE_ASSETS' },
];
const spec = { worker: 'ledgetop-clients-staging', installedVersionId: VERSION, bindings: ['ASSETS', 'UI_RELEASE_ASSETS'], files,
  exports: [{ name: 'BulkDownloadWorkflow', kind: 'workflow' }, { name: 'ThumbnailRendererContainer', kind: 'durable_object' },
    { name: 'SharedProfilePortalAuthorityReader', kind: 'entrypoint' }] };

/** A fake binding that records every call and serves the given bytes (or an HTML SPA fallback for anything else). */
function fakeBinding(store, calls, override = {}) {
  return { async fetch(request) {
    calls.push(new URL(request.url).pathname);
    if (override.status) return new Response('x', { status: override.status });
    const bytes = store.get(new URL(request.url).pathname);
    if (!bytes) return new Response('<!doctype html><title>SPA</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
    return new Response(override.bytes ?? bytes, { status: 200, headers: { 'Content-Type': override.mime ?? (request.url.endsWith('.css') ? 'text/css' : 'text/javascript; charset=utf-8'), 'Cache-Control': 'public, max-age=31536000, immutable' } });
  } };
}
const map = () => new Map(files.map(f => [f.path, f]));
const envFor = (calls, override) => ({
  ASSETS: fakeBinding(new Map([['/assets/app-1a2b.js', JS], ['/assets/app-3c4d.css', CSS]]), calls, override),
  UI_RELEASE_ASSETS: fakeBinding(new Map([['/ui/release/app-9f.js', UI]]), calls, override),
});
const get = (p, init) => new Request(`https://ops-staging.example${p}`, init);

test('only exact allowlisted static paths are served, byte-verified, from their own binding', async () => {
  const calls = [];
  const js = await handleRetiredRequest(get('/assets/app-1a2b.js'), envFor(calls), map());
  assert.equal(js.status, 200);
  assert.deepEqual(Buffer.from(await js.arrayBuffer()), JS);
  assert.equal(js.headers.get('Content-Type'), 'text/javascript');
  assert.equal(js.headers.get('ETag'), `"${hex(JS)}"`);
  const ui = await handleRetiredRequest(get('/ui/release/app-9f.js'), envFor(calls), map());
  assert.deepEqual(Buffer.from(await ui.arrayBuffer()), UI, 'a Client UI release file comes through UI_RELEASE_ASSETS');
  const head = await handleRetiredRequest(get('/assets/app-3c4d.css', { method: 'HEAD' }), envFor(calls), map());
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('Content-Length'), String(CSS.length));
  assert.equal(await head.text(), '');
  assert.deepEqual(calls, ['/assets/app-1a2b.js', '/ui/release/app-9f.js', '/assets/app-3c4d.css']);
});

test('HTML, the SPA shell, API, unknown paths, queries and other methods are 410 and never reach a binding', async () => {
  const calls = [];
  for (const [url, init] of [['/'], ['/index.html'], ['/portal'], ['/api/session'], ['/assets/unknown.js'], ['/assets/app-1a2b.js?v=1'],
    ['/assets/app-1a2b.js', { method: 'POST', body: 'x' }], ['/assets/app-1a2b.js', { method: 'DELETE' }], ['/assets/../index.html'],
    ['/ASSETS/app-1a2b.js'], ['/assets/app-1a2b.js/']]) {
    const response = await handleRetiredRequest(get(url, init), envFor(calls), map());
    assert.equal(response.status, 410, url);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.deepEqual(calls, [], 'no binding was called for a refused request');
});

test('an upstream that is not exactly the pinned bytes is refused (502), never passed through', async () => {
  for (const override of [{ status: 404 }, { mime: 'text/html' }, { mime: 'text/plain' }, { bytes: Buffer.from('changed bytes!!!!!!!!!!!') },
    { bytes: Buffer.from('console.log("old chunX")') }]) {
    const response = await handleRetiredRequest(get('/assets/app-1a2b.js'), envFor([], override), map());
    assert.equal(response.status, 502, JSON.stringify(override));
    assert.equal(await response.text(), 'Unavailable');
  }
  assert.equal((await handleRetiredRequest(get('/assets/app-1a2b.js'), {}, map())).status, 502, 'missing binding');
});

test('policies refuse HTML, shell paths, unsafe paths, unknown bindings, duplicates and bad shapes', () => {
  const base = { worker: 'ledgetop-ops-staging', installedVersionId: VERSION, bindings: ['ASSETS'] };
  const one = file => ({ ...base, files: [{ path: '/assets/a.js', size: 1, sha256: 'a'.repeat(64), mime: 'text/javascript', binding: 'ASSETS', ...file }] });
  assert.ok(validateRetirePolicy(one({})));
  for (const [why, file] of [['html mime', { mime: 'text/html' }], ['xhtml', { mime: 'application/xhtml+xml' }], ['root', { path: '/' }],
    ['index', { path: '/index.html' }], ['html file', { path: '/assets/page.htm' }], ['dir', { path: '/assets/' }], ['dotdot', { path: '/assets/../x.js' }],
    ['encoded', { path: '/assets/%2e%2e/x.js' }], ['unknown binding', { binding: 'OTHER' }], ['bad hash', { sha256: 'xyz' }], ['too big', { size: 33 * 1024 * 1024 }]])
    assert.throws(() => validateRetirePolicy(one(file)), /retire_policy_invalid/u, why);
  assert.throws(() => validateRetirePolicy({ ...base, files: [one({}).files[0], one({}).files[0]] }), /duplicate/u);
  assert.throws(() => validateRetirePolicy({ ...one({}), files: [{ ...one({}).files[0], extra: 1 }] }), /file shape/u);
});

test('the generated facade runs, keeps exact inert exports, and has no scheduled, queue or email handler', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retire-facade-'));
  try {
    const shim = path.join(dir, 'cloudflare-workers-shim.mjs');
    fs.writeFileSync(shim, 'export class DurableObject { constructor(state, env) { this.ctx = state; this.env = env; } }\n'
      + 'export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n'
      + 'export class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }\n');
    const source = buildFacadeSource(spec);
    assert.match(source, /^import \{ DurableObject, WorkflowEntrypoint, WorkerEntrypoint \} from 'cloudflare:workers';$/mu);
    assert.equal((source.match(/^import /gmu) ?? []).length, 1, 'no other imports');
    const file = path.join(dir, 'index.mjs');
    fs.writeFileSync(file, source.replace("'cloudflare:workers'", JSON.stringify(pathToFileURL(shim).href)));
    const facade = await import(pathToFileURL(file).href);
    assert.deepEqual(Object.keys(facade.default).sort(), ['fetch']);
    assert.deepEqual(Object.keys(facade).sort(), ['BulkDownloadWorkflow', 'SharedProfilePortalAuthorityReader', 'ThumbnailRendererContainer', 'default']);
    const calls = [];
    assert.equal((await facade.default.fetch(get('/assets/app-1a2b.js'), envFor(calls))).status, 200);
    assert.equal((await facade.default.fetch(get('/'), envFor(calls))).status, 410);
    assert.equal(calls.length, 1);
    assert.equal((await new facade.ThumbnailRendererContainer({}, {}).fetch(get('/x'))).status, 410);
    await new facade.ThumbnailRendererContainer({}, {}).alarm();
    await assert.rejects(new facade.BulkDownloadWorkflow({}, {}).run({}, {}), /worker_retired/u);
    assert.equal((await new facade.SharedProfilePortalAuthorityReader({}, {}).fetch(get('/x'))).status, 410);
    assert.equal(typeof new facade.SharedProfilePortalAuthorityReader({}, {}).readProfile, 'undefined', 'no RPC methods survive');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('specs refuse reserved or duplicate export names and unknown kinds; the receipt pins hashes and +48 h pruning', () => {
  for (const exports of [[{ name: 'default', kind: 'entrypoint' }], [{ name: 'FILES', kind: 'entrypoint' }], [{ name: 'X', kind: 'container' }],
    [{ name: 'X', kind: 'workflow' }, { name: 'X', kind: 'entrypoint' }], [{ name: 'not-an-identifier', kind: 'workflow' }]])
    assert.throws(() => validateSpec({ ...spec, exports }), /retire_spec_invalid/u, JSON.stringify(exports));
  assert.throws(() => validateSpec({ ...spec, extra: 1 }), /top-level/u);
  const source = buildFacadeSource(spec), receipt = buildReceipt(spec, source);
  assert.equal(receipt.facadeSha256, hex(source));
  assert.equal(receipt.retainedFiles, 3);
  assert.deepEqual(receipt.upload, { keep_assets: true, assetsConfig: { run_worker_first: true }, handlers: ['fetch'] });
  assert.equal(receipt.cutoffAt, null);
  const done = completeReceipt(receipt, '2026-11-12T20:00:00.000Z');
  assert.equal(done.earliestPruningAt, '2026-11-14T20:00:00.000Z');
  assert.throws(() => completeReceipt(receipt, 'tomorrow'), /retire_cutoff_invalid/u);
  assert.equal(buildFacadeSource(spec), source, 'generation is deterministic');
  assert.ok(fileURLToPath(import.meta.url));
});
