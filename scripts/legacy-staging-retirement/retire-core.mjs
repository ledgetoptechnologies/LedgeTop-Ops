// Asset-only retirement facade for the old ledgetop-*-staging Workers in the production account.
// It serves ONLY an exact, pinned allowlist of retained static files (GET/HEAD), byte-verified against the
// pinned size and SHA-256, from the Worker's existing assets binding. Everything else (HTML, the SPA shell,
// API, RPC, unknown paths, query strings, other methods) gets a fixed 410 with no body detail. It never calls
// the assets binding for a request that is not allowlisted, so the old SPA fallback can't serve new HTML.
// This file is inlined verbatim into each generated facade (see generate.mjs); keep it dependency-free.

export const RETIRE_LIMITS = Object.freeze({ maxFileBytes: 32 * 1024 * 1024, maxFiles: 20_000 });
const SHELL_PATHS = new Set(['/', '/index.html']);
const SAFE_PATH = /^\/[A-Za-z0-9._~/-]+$/u;

/** Validates one pinned policy; refuses HTML, shell paths, unsafe paths, duplicates and oversize entries. */
export function validateRetirePolicy(policy) {
  const fail = message => { throw new Error(`retire_policy_invalid: ${message}`); };
  if (!policy || typeof policy !== 'object') fail('shape');
  const { worker, installedVersionId, bindings, files } = policy;
  if (typeof worker !== 'string' || !/^[a-z0-9-]{1,63}$/u.test(worker)) fail('worker');
  if (typeof installedVersionId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(installedVersionId)) fail('installedVersionId');
  // The bindings a retained file may come from: the native ASSETS binding and, for the old Client, the
  // UI_RELEASE_ASSETS service binding (delegated UI release files). Each file names its own.
  if (!Array.isArray(bindings) || !bindings.length || bindings.length > 4
    || bindings.some(name => typeof name !== 'string' || !/^[A-Z][A-Z0-9_]{0,63}$/u.test(name)) || new Set(bindings).size !== bindings.length) fail('bindings');
  if (!Array.isArray(files) || files.length > RETIRE_LIMITS.maxFiles) fail('files');
  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Object.keys(file).sort().join(',') !== 'binding,mime,path,sha256,size') fail('file shape');
    const { path, size, sha256, mime, binding } = file;
    if (!bindings.includes(binding)) fail(`binding ${binding} for ${path}`);
    if (typeof path !== 'string' || !SAFE_PATH.test(path) || path.length > 1024
      || path.split('/').slice(1).some(part => !part || part === '.' || part === '..')) fail(`path ${JSON.stringify(path)}`);
    if (SHELL_PATHS.has(path) || path.endsWith('/') || /\.html?$/iu.test(path)) fail(`shell or html path ${path}`);
    if (typeof mime !== 'string' || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(mime) || mime === 'text/html' || mime === 'application/xhtml+xml') fail(`mime ${mime}`);
    if (!Number.isSafeInteger(size) || size < 0 || size > RETIRE_LIMITS.maxFileBytes) fail(`size ${path}`);
    if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(sha256)) fail(`sha256 ${path}`);
    if (seen.has(path)) fail(`duplicate ${path}`);
    seen.add(path);
  }
  return policy;
}

const gone = () => new Response('Gone', { status: 410, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const unavailable = () => new Response('Unavailable', { status: 502, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Handles one request. `files` is a Map path -> pinned entry. The entry's own binding is asked only for an
 * allowlisted path, with a clean GET (no caller headers), and the response is served only if its SHA-256 and length
 * equal the pinned bytes (status/MIME/length alone are not accepted as proof).
 */
export async function handleRetiredRequest(request, env, files) {
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') return gone();
  let url;
  try { url = new URL(request.url); } catch { return gone(); }
  if (url.search || url.username || url.password) return gone();
  const entry = files.get(url.pathname);
  if (!entry) return gone();
  const binding = env?.[entry.binding];
  if (!binding || typeof binding.fetch !== 'function') return unavailable();
  let upstream;
  try { upstream = await binding.fetch(new Request(new URL(entry.path, url.origin).href, { method: 'GET', redirect: 'manual' })); }
  catch { return unavailable(); }
  if (upstream.status !== 200) { upstream.body?.cancel?.(); return unavailable(); }
  const type = (upstream.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  if (type === 'text/html' || type !== entry.mime) { upstream.body?.cancel?.(); return unavailable(); }
  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.byteLength !== entry.size || await sha256Hex(bytes) !== entry.sha256) return unavailable();
  const headers = new Headers({ 'Content-Type': entry.mime, 'Content-Length': String(entry.size), 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': upstream.headers.get('Cache-Control') ?? 'public, max-age=3600', 'ETag': `"${entry.sha256}"` });
  return new Response(method === 'HEAD' ? null : bytes, { status: 200, headers });
}
