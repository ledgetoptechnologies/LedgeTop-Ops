// Device proxy: the public controller hostname forwards the device API to the local (NAS) Logs host through the
// Tunnel. Default off (LOGS_DEVICE_UPSTREAM_MODE=local enables it); controllers and the APK keep the same URL.
//
// Only /api/v1/device/* is forwarded (health stays local; everything else is 404 as before). Each request carries
// this Worker's OWN Access service token for the private host (a device-proxy identity, never the Ops staff one) and
// the controller's address. Only an allowlist of request headers is forwarded: never cookies, never a staff actor
// header. Bodies stream through unchanged; the 100 MiB upload limit is checked up front from Content-Length and again
// by the Logs host while streaming. If the private host cannot answer (down, 5xx from the edge, an Access redirect,
// a timeout), the controller gets 503 with Retry-After and keeps the log in its queue.
const DEVICE_PREFIX = '/api/v1/device/';
const RAW_LOG_LIMIT = 100 * 1024 * 1024;
const FORWARD_REQUEST = ['authorization', 'content-type', 'content-length', 'x-poll-token'];
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'cache-control'];
const RETRY_AFTER_SECONDS = 300;
const TIMEOUT_MS = 15 * 60_000;

export function deviceProxyEnabled(env) { return env?.LOGS_DEVICE_UPSTREAM_MODE === 'local'; }

const json = (body, status, headers = {}) => new Response(JSON.stringify(body), { status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });
const unavailable = () => json({ error: 'Ledge Top Logs is unavailable right now. Logs stay on the controller and will be sent later.', code: 'logs_unavailable' },
  503, { 'Retry-After': String(RETRY_AFTER_SECONDS) });

function upstream(env) {
  let url;
  try { url = new URL(env.LOGS_DEVICE_UPSTREAM_URL ?? ''); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') return null;
  if (!/^[A-Za-z0-9._-]{8,256}$/.test(env.LOGS_DEVICE_ACCESS_CLIENT_ID ?? '')) return null;
  if (typeof env.LOGS_DEVICE_ACCESS_CLIENT_SECRET !== 'string' || env.LOGS_DEVICE_ACCESS_CLIENT_SECRET.length < 16) return null;
  return url;
}

/** Returns a Response for device routes when the proxy is enabled, or null to let the Worker handle the request. */
export async function proxyDeviceRequest(request, env, { fetchImpl = fetch } = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(DEVICE_PREFIX)) return null;
  const origin = upstream(env);
  // Enabled but incomplete configuration: never fall back to anything, never forward without credentials.
  if (!origin) return unavailable();
  if (Number(request.headers.get('Content-Length') ?? 0) > RAW_LOG_LIMIT) {
    await request.body?.cancel().catch(() => {});
    return json({ error: 'This flight log is empty or too large.', code: 'raw_log_too_large' }, 413);
  }
  const headers = new Headers();
  for (const name of FORWARD_REQUEST) { const value = request.headers.get(name); if (value !== null) headers.set(name, value); }
  headers.set('CF-Access-Client-Id', env.LOGS_DEVICE_ACCESS_CLIENT_ID);
  headers.set('CF-Access-Client-Secret', env.LOGS_DEVICE_ACCESS_CLIENT_SECRET);
  const client = request.headers.get('CF-Connecting-IP');
  if (client) headers.set('X-Ledge-Top-Client-IP', client.slice(0, 64));
  const init = { method: request.method, headers, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) { init.body = request.body; init.duplex = 'half'; }
  let response;
  try { response = await fetchImpl(new URL(url.pathname + url.search, origin), init); }
  catch { return unavailable(); }
  // An Access login redirect, an edge/origin failure or a Tunnel error page means the Logs host did not answer.
  if (response.status >= 300 && response.status < 400 || [502, 503, 504, 520, 521, 522, 523, 524, 530].includes(response.status)) {
    await response.body?.cancel().catch(() => {});
    return unavailable();
  }
  const out = new Headers();
  for (const name of FORWARD_RESPONSE) { const value = response.headers.get(name); if (value !== null) out.set(name, value); }
  return new Response(response.body, { status: response.status, headers: out });
}
