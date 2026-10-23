/** Unwired local byte policy for an additive UI release. Manifest labels and
 * configuration hashes prove neither live namespace nor content identity.
 * Streaming checks MIME and byte count, NOT runtime SHA256. Exact upload/probe
 * acceptance and caller host/auth admission are separate activation duties. */
export type UiReleaseFile = Readonly<{ path: string; size: number; sha256: string; mime: string }>;
export type UiReleaseManifest = Readonly<{
  schemaVersion: 1; application: 'operations' | 'client'; releaseId: string;
  files: readonly UiReleaseFile[];
}>;
// Structural subset of current Workers Fetcher; no Env or active bindings.
export type UiAssetFetcher = { fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> };
export type UiAssetOptions = Readonly<{ timeoutMs?: number }>;

const MAX_FILE_BYTES = 32 * 1024 * 1024;
function fail(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}
function canonicalPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 1024 && /^\/[A-Za-z0-9._/-]+$/.test(value)
    && value.slice(1).split('/').every(part => part && part !== '.' && part !== '..');
}
export function validateUiReleaseManifest(value: unknown): UiReleaseManifest {
  fail(record(value, ['schemaVersion', 'application', 'releaseId', 'files']), 'Invalid UI manifest shape');
  fail(value.schemaVersion === 1 && (value.application === 'operations' || value.application === 'client')
    && typeof value.releaseId === 'string' && /^[a-f0-9]{40}$/.test(value.releaseId), 'Invalid UI release identity');
  fail(Array.isArray(value.files) && value.files.length > 0 && value.files.length <= 20_000, 'Invalid UI file count');
  const seen = new Set<string>();
  const files = value.files.map((file: unknown): UiReleaseFile => {
    fail(record(file, ['path', 'size', 'sha256', 'mime']) && canonicalPath(file.path), 'Invalid UI asset path/shape');
    fail(!seen.has(file.path.toLowerCase()), 'Duplicate or case-colliding UI asset'); seen.add(file.path.toLowerCase());
    fail(typeof file.size === 'number' && Number.isSafeInteger(file.size) && file.size >= 0 && file.size <= MAX_FILE_BYTES,
      'Invalid UI asset size');
    fail(typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256), 'Invalid UI asset digest');
    fail(typeof file.mime === 'string' && /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(file.mime)
      && file.mime.length <= 100, 'Invalid UI asset MIME');
    const ext = file.path.split('.').at(-1)?.toLowerCase();
    const critical: Record<string, readonly string[]> = { js: ['text/javascript', 'application/javascript'],
      mjs: ['text/javascript', 'application/javascript'], css: ['text/css'], html: ['text/html'] };
    const allowedMimes = critical[ext ?? ''];
    fail(!allowedMimes || allowedMimes.includes(file.mime), 'UI extension/MIME mismatch');
    return Object.freeze({ path: file.path, size: file.size, sha256: file.sha256, mime: file.mime });
  });
  fail(files.some(file => file.path === '/index.html' && file.mime === 'text/html'), 'UI shell is required');
  return Object.freeze({ schemaVersion: 1, application: value.application, releaseId: value.releaseId, files: Object.freeze(files) });
}
export function uiReleasePrefix(manifest: UiReleaseManifest): string {
  return `/_ui/${manifest.application}/${manifest.releaseId}`;
}
export function resolveUiReleaseAsset(url: string | URL, manifest: UiReleaseManifest): UiReleaseFile | null {
  let pathname: string;
  // A Request/URL may already have normalized literal or encoded dot segments.
  // When original URL text is supplied, reject those before URL parsing.
  if (typeof url === 'string') {
    const rawPath = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/i.exec(url)?.[1];
    if (!rawPath || !canonicalPath(rawPath)) return null;
  }
  try { pathname = new URL(url).pathname; } catch { return null; }
  if (!canonicalPath(pathname)) return null;
  const prefix = uiReleasePrefix(manifest) + '/';
  if (!pathname.startsWith(prefix)) return null;
  const relative = pathname.slice(prefix.length - 1);
  return manifest.files.find(file => file.path === relative) ?? null;
}
function failure(status: number): Response {
  return new Response(null, { status, headers: { 'Cache-Control': 'no-store',
    ...(status === 405 ? { Allow: 'GET, HEAD' } : {}) } });
}
function discard(response: Response): void {
  // A Fetcher can supply a stream whose cancellation never settles. Initiate
  // cleanup without making the response/deadline depend on its cooperation.
  try { void response.body?.cancel().catch(() => {}); } catch { /* locked stream */ }
}

async function transfer(request: Request, binding: UiAssetFetcher, file: UiReleaseFile,
  targetPath: string, options: UiAssetOptions): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return failure(503);
  const abort = new AbortController();
  let timedOut = false, finished = false;
  let cancelBody = () => {};
  let timeoutReject: (reason: Error) => void = () => {};
  const timeout = new Promise<never>((_, reject) => { timeoutReject = reject; });
  // A caller may not consume the returned stream before the deadline.
  void timeout.catch(() => {});
  const timer = setTimeout(() => {
    timedOut = true; abort.abort(); timeoutReject(new Error('UI asset timeout')); cancelBody();
  }, timeoutMs);
  const clientAbort = () => { abort.abort(); cancelBody(); };
  request.signal.addEventListener('abort', clientAbort, { once: true });
  if (request.signal.aborted) abort.abort();
  const cleanup = () => {
    finished = true; clearTimeout(timer); request.signal.removeEventListener('abort', clientAbort);
  };
  try {
    // Build afresh: no incoming headers, credentials, query, referrer or body.
    const sanitized = new Request(`https://ui-release.invalid${targetPath}`, {
      method: request.method, redirect: 'manual', signal: abort.signal,
    });
    const fetching = binding.fetch(sanitized).then(response => {
      if (finished || timedOut) { discard(response); throw new Error('Late UI asset response'); }
      return response;
    });
    const response = await Promise.race([fetching, timeout]);
    const mime = response.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase();
    const encoding = response.headers.get('Content-Encoding');
    const length = response.headers.get('Content-Length');
    if (response.status !== 200 || mime !== file.mime || (encoding && encoding.toLowerCase() !== 'identity')
      || (length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size))
      || (request.method === 'GET' && !response.body && file.size !== 0)) {
      cleanup(); discard(response); return failure(502);
    }
    const headers = new Headers();
    // ETag is upstream metadata only, never an assertion of manifest SHA256.
    for (const name of ['Content-Type', 'ETag', 'Last-Modified']) {
      const value = response.headers.get(name); if (value !== null) headers.set(name, value);
    }
    headers.set('Content-Length', String(file.size));
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Cache-Control', file.path === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable');
    if (request.method === 'HEAD' || !response.body) {
      cleanup(); discard(response); return new Response(null, { status: 200, headers });
    }
    const reader = response.body.getReader();
    cancelBody = () => { void reader.cancel('UI asset timeout').catch(() => {}); };
    let count = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const result = await Promise.race([reader.read(), timeout]);
          if (abort.signal.aborted) throw new Error('UI asset request cancelled');
          if (result.done) {
            if (count !== file.size) throw new Error('UI asset ended before declared size');
            cleanup(); controller.close(); return;
          }
          if (!(result.value instanceof Uint8Array)) throw new Error('Invalid UI asset stream chunk');
          count += result.value.byteLength;
          if (count > file.size) throw new Error('UI asset exceeded declared size');
          controller.enqueue(result.value);
        } catch (error) {
          cleanup(); abort.abort(); controller.error(error); void reader.cancel(error).catch(() => {});
        }
      },
      cancel(reason) { cleanup(); abort.abort(); void reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(stream, { status: 200, headers });
  } catch {
    cleanup(); abort.abort(); return failure(timedOut ? 504 : 502);
  }
}

/** Caller must first admit the host and presentation route. Legacy paths are
 * deliberately a miss; this helper never falls back to the primary Worker. */
export async function fetchUiReleaseAsset(request: Request, binding: UiAssetFetcher,
  input: unknown, options: UiAssetOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
  let manifest: UiReleaseManifest;
  try { manifest = validateUiReleaseManifest(input); } catch { return failure(503); }
  const file = resolveUiReleaseAsset(request.url, manifest);
  return file ? transfer(request, binding, file, uiReleasePrefix(manifest) + file.path, options) : failure(404);
}
/** Only for an already-admitted presentation caller, never API/auth routes. */
export async function fetchUiReleaseShell(request: Request, binding: UiAssetFetcher,
  input: unknown, options: UiAssetOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
  let manifest: UiReleaseManifest;
  try { manifest = validateUiReleaseManifest(input); } catch { return failure(503); }
  const file = manifest.files.find(entry => entry.path === '/index.html')!;
  return transfer(request, binding, file, uiReleasePrefix(manifest) + file.path, options);
}
/** Private release Worker handler. ASSETS sees only the manifest-admitted path,
 * never its SPA fallback for missing/unknown paths. MIME validation also rejects
 * a fallback HTML response for a JS/CSS asset that is absent upstream. */
export async function servePrivateUiReleaseAsset(request: Request, assetsBinding: UiAssetFetcher,
  input: unknown, options: UiAssetOptions = {}): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return failure(405);
  let manifest: UiReleaseManifest;
  try { manifest = validateUiReleaseManifest(input); } catch { return failure(503); }
  const file = resolveUiReleaseAsset(request.url, manifest);
  return file ? transfer(request, assetsBinding, file, file.path, options) : failure(404);
}
