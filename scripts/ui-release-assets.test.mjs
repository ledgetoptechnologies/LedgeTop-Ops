import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateUiReleaseManifest, uiReleasePrefix, resolveUiReleaseAsset,
  fetchUiReleaseAsset, fetchUiReleaseShell, servePrivateUiReleaseAsset } from '../packages/shared/src/ui-release-assets.ts';

const releaseId = 'a'.repeat(40);
const payloads = { '/index.html': '<script src="/_ui/client/' + releaseId + '/assets/main.js"></script>',
  '/assets/main.js': 'export default 7;', '/assets/main.css': '.x{color:red}' };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const manifest = { schemaVersion: 1, application: 'client', releaseId,
  files: Object.entries(payloads).map(([path, body]) => ({ path, size: Buffer.byteLength(body), sha256: hash(body),
    mime: path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html' })) };
const prefix = '/_ui/client/' + releaseId;
const incoming = (path = prefix + '/assets/main.js', init) => new Request('https://client.example' + path, init);
const file = manifest.files.find(f => f.path.endsWith('.js'));
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('operation blocked on upstream cleanup')), 200);
    })]);
  } finally { clearTimeout(timer); }
}
function assetResponse(body = payloads[file.path], init = {}) {
  return new Response(body, { headers: { 'Content-Type': file.mime }, ...init });
}
function chain(input = manifest) {
  const privateCalls = [], assetCalls = [];
  const assets = { async fetch(request) {
    assetCalls.push(request);
    const entry = input.files.find(f => f.path === new URL(request.url).pathname);
    if (!entry) return new Response('SPA fallback', { headers: { 'Content-Type': 'text/html' } });
    return new Response(request.method === 'HEAD' ? null : payloads[entry.path], {
      headers: { 'Content-Type': entry.mime, 'Content-Length': String(entry.size),
        ETag: '"upstream-metadata"', 'Set-Cookie': 'private=secret', Location: 'https://elsewhere.example',
        'Access-Control-Allow-Origin': '*', 'X-Private': 'internal' },
    });
  } };
  const binding = { async fetch(request) {
    privateCalls.push(request); return servePrivateUiReleaseAsset(request, assets, input);
  } };
  return { privateCalls, assetCalls, binding };
}

test('validates strict bounded manifest and returns an immutable copy', () => {
  const parsed = validateUiReleaseManifest(manifest);
  assert.equal(uiReleasePrefix(parsed), prefix);
  assert.ok(Object.isFrozen(parsed) && Object.isFrozen(parsed.files) && Object.isFrozen(parsed.files[0]));
  assert.notEqual(parsed.files, manifest.files);
  assert.deepEqual(resolveUiReleaseAsset(incoming().url, parsed), file);
  for (const patch of [{ schemaVersion: 2 }, { application: 'ops' }, { releaseId: 'A'.repeat(40) },
    { extra: true }, { files: [] }, { files: Array(20_001).fill(file) }]) {
    assert.throws(() => validateUiReleaseManifest({ ...manifest, ...patch }));
  }
  for (const patch of [{ path: '/../escape.js' }, { path: '/assets//a.js' }, { path: '/assets/%2f.js' },
    { path: '/assets/a\\b.js' }, { path: '/assets/é.js' }, { path: '/assets/./a.js' }, { path: 'assets/a.js' },
    { path: '/assets/a.js/' }, { size: -1 }, { size: 32 * 1024 * 1024 + 1 }, { size: 1.5 },
    { sha256: 'x'.repeat(64) }, { mime: 'text/html' }, { mime: 'text/javascript; charset=utf-8' }, { extra: 1 }]) {
    assert.throws(() => validateUiReleaseManifest({ ...manifest, files: [manifest.files[0], { ...file, ...patch }] }));
  }
  assert.throws(() => validateUiReleaseManifest({ ...manifest, files: [manifest.files[0], file, { ...file, path: '/ASSETS/main.js' }] }));
  assert.throws(() => validateUiReleaseManifest({ ...manifest, files: [file] }));
});

test('real proxy/private chain strips incoming authority and capabilities at both hops', async () => {
  const c = chain();
  const response = await fetchUiReleaseAsset(incoming(undefined, { headers: { Cookie: 'session=secret',
    Authorization: 'Bearer secret', 'Cf-Access-Jwt-Assertion': 'secret', Referer: 'https://client.example/private',
    Range: 'bytes=0-1', 'If-None-Match': 'secret', 'Accept-Encoding': 'gzip', 'X-Capability': 'secret' } }), c.binding, manifest);
  assert.equal(response.status, 200); assert.equal(await response.text(), payloads[file.path]);
  assert.equal(c.privateCalls.length, 1); assert.equal(c.assetCalls.length, 1);
  assert.equal(c.privateCalls[0].url, 'https://ui-release.invalid' + prefix + file.path);
  assert.equal(c.assetCalls[0].url, 'https://ui-release.invalid' + file.path);
  for (const request of [...c.privateCalls, ...c.assetCalls]) {
    assert.deepEqual([...request.headers], []); assert.equal(request.redirect, 'manual');
    assert.equal(request.referrer, 'about:client'); assert.equal(request.body, null);
  }
  for (const name of ['set-cookie', 'location', 'access-control-allow-origin', 'x-private']) assert.equal(response.headers.get(name), null);
  assert.equal(response.headers.get('etag'), '"upstream-metadata"');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('cache-control'), /immutable/);
});

test('query stripping preserves exact pinned path without forwarding capabilities', async () => {
  const c = chain();
  const response = await fetchUiReleaseAsset(incoming(prefix + file.path + '?cap=secret&file=/other.js'), c.binding, manifest);
  assert.equal(await response.text(), payloads[file.path]);
  assert.equal(new URL(c.privateCalls[0].url).search, ''); assert.equal(new URL(c.assetCalls[0].url).search, '');
});

test('legacy, wrong application/release, ambiguous and absent paths are misses without binding calls', async () => {
  const c = chain();
  for (const path of ['/assets/main.js', '/api/viewer/session', '/index.html', prefix, prefix + '/',
    prefix.replace('/client/', '/operations/') + file.path, prefix.replace(releaseId, 'b'.repeat(40)) + file.path,
    prefix + '/assets/MAIN.js', prefix + '/assets/no.js', prefix + '/assets//main.js',
    prefix + '/assets/%6dain.js', prefix + '/assets/%2fmain.js', prefix + '/assets/%5cmain.js',
    prefix + '/assets/..%2fmain.js', prefix + '/assets/%2e%2e/%2e%2e/index.html']) {
    for (const handler of [fetchUiReleaseAsset, servePrivateUiReleaseAsset]) {
      assert.equal((await handler(incoming(path), c.binding, manifest)).status, 404, path);
    }
  }
  assert.equal(c.privateCalls.length, 0);
  assert.equal(resolveUiReleaseAsset('https://client.example' + prefix + '/assets/%2e%2e/index.html', manifest), null);
  assert.equal(resolveUiReleaseAsset('https://client.example' + prefix + '/assets/../index.html', manifest), null);
});

test('Request normalization cannot be reversed, but only the resulting pinned listed path is admitted', async () => {
  const request = incoming(prefix + '/assets/%2e%2e/index.html');
  assert.equal(new URL(request.url).pathname, prefix + '/index.html');
  const c = chain(), response = await fetchUiReleaseAsset(request, c.binding, manifest);
  assert.equal(await response.text(), payloads['/index.html']);
  assert.equal(c.assetCalls[0].url, 'https://ui-release.invalid/index.html');
});

test('all helpers reject non-GET/HEAD and invalid manifests before fetching', async () => {
  let calls = 0; const binding = { async fetch() { calls++; throw new Error('must not fetch'); } };
  for (const handler of [fetchUiReleaseAsset, fetchUiReleaseShell, servePrivateUiReleaseAsset]) {
    const response = await handler(incoming(undefined, { method: 'POST', body: 'secret' }), binding, manifest);
    assert.equal(response.status, 405); assert.equal(response.headers.get('allow'), 'GET, HEAD');
    assert.equal((await handler(incoming(), binding, { ...manifest, extra: 1 })).status, 503);
  }
  assert.equal(calls, 0);
});

test('shell selects pinned index only, is no-store, and strips original deep route/query', async () => {
  const c = chain();
  const response = await fetchUiReleaseShell(incoming('/projects/secret?cap=private'), c.binding, manifest);
  assert.equal(response.status, 200); assert.equal(await response.text(), payloads['/index.html']);
  assert.equal(c.privateCalls[0].url, 'https://ui-release.invalid' + prefix + '/index.html');
  assert.equal(c.assetCalls[0].url, 'https://ui-release.invalid/index.html');
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('HEAD is bodyless through both hops and shell cache remains no-store', async () => {
  const c = chain(), request = incoming(undefined, { method: 'HEAD' });
  const response = await fetchUiReleaseAsset(request, c.binding, manifest);
  assert.equal(response.status, 200); assert.equal(response.body, null); assert.equal(await response.text(), '');
  assert.equal(response.headers.get('content-length'), String(file.size));
  const shell = await fetchUiReleaseShell(request, c.binding, manifest);
  assert.equal(shell.body, null); assert.equal(shell.headers.get('cache-control'), 'no-store');
  assert.ok(c.assetCalls.every(req => req.method === 'HEAD'));
});

test('bad statuses, redirects, wrong MIME/SPA fallback and ambiguous encoded size fail closed', async () => {
  const responses = [() => new Response('missing', { status: 404 }),
    () => new Response(null, { status: 302, headers: { Location: 'https://external.example' } }),
    () => new Response('SPA fallback', { headers: { 'Content-Type': 'text/html' } }),
    () => new Response(payloads[file.path], { headers: { 'Content-Type': file.mime, 'Content-Length': '999' } }),
    () => new Response(payloads[file.path], { headers: { 'Content-Type': file.mime, 'Content-Encoding': 'gzip' } }),
    () => new Response(null, { headers: { 'Content-Type': file.mime } })];
  for (const make of responses) {
    let calls = 0;
    const binding = { async fetch(req) { calls++; assert.equal(req.redirect, 'manual'); return make(); } };
    assert.equal((await fetchUiReleaseAsset(incoming(), binding, manifest)).status, 502);
    assert.equal(calls, 1);
  }
  assert.equal((await fetchUiReleaseAsset(incoming(), { async fetch() { throw new Error('offline'); } }, manifest)).status, 502);
});

test('private handler rejects actual ASSETS HTML fallback for a manifest-listed missing JS file', async () => {
  let calls = 0;
  const binding = { fetch: request => servePrivateUiReleaseAsset(request, { async fetch() {
    calls++; return new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } });
  } }, manifest) };
  assert.equal((await fetchUiReleaseAsset(incoming(), binding, manifest)).status, 502); assert.equal(calls, 1);
});

test('invalid upstream headers/status return promptly even when body cancellation never settles', async () => {
  for (const init of [ { headers: { 'Content-Type': 'text/html' } },
    { status: 404, headers: { 'Content-Type': file.mime } },
    { headers: { 'Content-Type': file.mime, 'Content-Length': '999' } } ]) {
    let cancelled = false;
    const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
    const response = await bounded(fetchUiReleaseAsset(incoming(), { async fetch() {
      return new Response(body, init);
    } }, manifest, { timeoutMs: 10 }));
    assert.equal(response.status, 502); assert.equal(cancelled, true);
    assert.equal(response.body, null);
  }
});

test('HEAD returns promptly and strips an upstream body whose cancellation hangs', async () => {
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; return new Promise(() => {}); } });
  const response = await bounded(fetchUiReleaseAsset(incoming(undefined, { method: 'HEAD' }), { async fetch() {
    return assetResponse(body);
  } }, manifest, { timeoutMs: 10 }));
  assert.equal(response.status, 200); assert.equal(response.body, null); assert.equal(cancelled, true);
  assert.equal(response.headers.get('Content-Length'), String(file.size));
});

test('consumer cancellation and overflow errors do not await a hanging upstream cancel', async () => {
  for (const overflow of [false, true]) {
    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { if (overflow) controller.enqueue(new Uint8Array(file.size + 1)); },
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const response = await fetchUiReleaseAsset(incoming(), { async fetch() { return assetResponse(body); } }, manifest);
    if (overflow) await bounded(assert.rejects(response.text(), /exceeded declared size/));
    else await bounded(response.body.cancel());
    assert.equal(cancelled, true);
  }
});

test('streaming detects short and overlong bodies and cancels the upstream reader', async () => {
  for (const body of ['short', payloads[file.path] + 'overlong']) {
    let cancelled = false;
    const oversized = body.length > file.size;
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(body)); if (!oversized) controller.close();
    },
      cancel() { cancelled = true; } });
    const response = await fetchUiReleaseAsset(incoming(), { async fetch() { return assetResponse(stream); } }, manifest);
    assert.equal(response.status, 200);
    await assert.rejects(response.text(), /declared size/);
    // EOF already closed the short stream; overflow must cancel the open one.
    assert.equal(cancelled, oversized);
  }
});

test('consumer cancellation propagates to ASSETS through the actual private/proxy chain', async () => {
  let cancelled = false;
  const binding = { fetch: request => servePrivateUiReleaseAsset(request, { async fetch() {
    return assetResponse(new ReadableStream({ cancel() { cancelled = true; } }));
  } }, manifest) };
  const response = await fetchUiReleaseAsset(incoming(), binding, manifest);
  await response.body.cancel(); assert.equal(cancelled, true);
});

test('header timeout returns 504, aborts binding signal, never retries or falls back', async () => {
  let calls = 0, signal;
  const response = await fetchUiReleaseAsset(incoming(), { fetch(request) {
    calls++; signal = request.signal; return new Promise(() => {});
  } }, manifest, { timeoutMs: 10 });
  assert.equal(response.status, 504); assert.equal(signal.aborted, true); assert.equal(calls, 1);
});

test('late responses after the header deadline are discarded, not leaked', async () => {
  let finish, cancelled = false;
  const response = await fetchUiReleaseAsset(incoming(), { fetch() {
    return new Promise(resolve => { finish = resolve; });
  } }, manifest, { timeoutMs: 10 });
  assert.equal(response.status, 504);
  finish(assetResponse(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cancelled, true);
});

test('incoming cancellation aborts and cancels an unconsumed upstream body', async () => {
  const abort = new AbortController(); let cancelled = false, upstreamSignal;
  const response = await fetchUiReleaseAsset(incoming(undefined, { signal: abort.signal }), { async fetch(request) {
    upstreamSignal = request.signal;
    return assetResponse(new ReadableStream({ cancel() { cancelled = true; } }));
  } }, manifest);
  abort.abort();
  assert.equal(cancelled, true); assert.equal(upstreamSignal.aborted, true);
  await assert.rejects(response.text(), /cancelled/);
});

test('body timeout fails the stream and cancels even without incoming body consumption', async () => {
  let cancelled = false;
  const response = await fetchUiReleaseAsset(incoming(), { async fetch() {
    return assetResponse(new ReadableStream({ cancel() { cancelled = true; } }));
  } }, manifest, { timeoutMs: 10 });
  await new Promise(resolve => setTimeout(resolve, 30));
  await assert.rejects(response.text()); assert.equal(cancelled, true);
});

test('manifest SHA256 is local policy, not runtime hashing or proof of live generation', async () => {
  const differentSameLength = 'x'.repeat(file.size);
  const response = await fetchUiReleaseAsset(incoming(), { async fetch() { return assetResponse(differentSameLength); } }, manifest);
  assert.equal(await response.text(), differentSameLength);
  assert.notEqual(hash(differentSameLength), file.sha256);
  assert.equal(response.headers.get('digest'), null);
  assert.equal(response.headers.get('x-content-sha256'), null);
});
