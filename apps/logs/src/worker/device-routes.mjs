// Public HTTP routes for controllers (logs.ledgetop.app/api/v1/device/*). Staff never use these; staff
// actions go through the FlightLogsService binding from Ops. Every response is uncached JSON.
import { LogsError } from './errors.mjs';
import * as device from './device.mjs';

const HAVE_BODY_LIMIT = 1024 * 1024;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// Count actual bytes before handing them to the runtime's body accumulator.
// Do not retain a JS chunk list and then allocate a second full-size copy:
// legitimate raw logs may be 100 MiB. Runtime peak memory still needs qualification.
async function readBytes(request, limit, tooLarge) {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > limit) {
    await request.body?.cancel('request_body_too_large').catch(() => {});
    throw tooLarge();
  }
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  let size = 0;
  const bounded = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); return; }
        if (value.byteLength > limit - size) {
          await reader.cancel('request_body_too_large').catch(() => {});
          throw tooLarge();
        }
        size += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Uint8Array(await new Response(bounded).arrayBuffer());
}

async function readJson(request, limit) {
  const raw = await readBytes(request, limit, () => new LogsError('too_large', 413, 'Request too large.'));
  try { return raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {}; } catch { throw new LogsError('invalid_json', 400, 'The request was not valid JSON.'); }
}

// The complete public device contract. Anything else under the prefix is 404 before any authentication,
// body read, database access or (local mode) forwarding, so unknown paths and methods reveal nothing about tokens.
const DEVICE_ROUTES = [
  /^POST \/api\/v1\/device\/sign-in$/,
  /^GET \/api\/v1\/device\/sign-in\/[0-9a-f-]{36}$/,
  /^GET \/api\/v1\/device\/me$/,
  /^POST \/api\/v1\/device\/have$/,
  /^PUT \/api\/v1\/device\/logs\/[0-9a-f]{64}$/,
  /^POST \/api\/v1\/device\/sign-out$/,
];
export const DEVICE_PREFIX = '/api/v1/device/';
/** True only for the exact method + path pairs of the controller API. */
export function isDeviceRoute(method, path) { return DEVICE_ROUTES.some(pattern => pattern.test(`${method} ${path}`)); }
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

/**
 * The whole public surface of the logs host: GET /health and the device API. Everything else is 404.
 * `deviceHandler` serves the device routes (the in-Worker handler by default, the NAS proxy in local mode).
 */
export async function handlePublicRequest(request, env, deviceHandler = handleDeviceRequest) {
  const path = new URL(request.url).pathname;
  if (path === '/health') {
    if (request.method !== 'GET') { await request.body?.cancel().catch(() => {}); return notFound(); }
    return Response.json({ service: 'ledge-top-logs', ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  const deviceResponse = await deviceHandler(request, env);
  if (deviceResponse) return deviceResponse;
  await request.body?.cancel().catch(() => {});
  return notFound();
}

/** Returns a Response for /api/v1/device/* paths, or null for anything else. */
export async function handleDeviceRequest(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith(DEVICE_PREFIX)) return null;
  const route = `${request.method} ${path}`;
  if (!isDeviceRoute(request.method, path)) {
    await request.body?.cancel().catch(() => {});
    return json({ error: 'Not found' }, 404);
  }
  try {
    if (route === 'POST /api/v1/device/sign-in') return json(await device.startSignIn(env, await readJson(request, 4096)), 201);
    const poll = /^GET \/api\/v1\/device\/sign-in\/([0-9a-f-]{36})$/.exec(route);
    // The poll token travels in a header, never the URL, so it stays out of request logs.
    if (poll) return json(await device.pollSignIn(env, poll[1], request.headers.get('X-Poll-Token')));

    const me = await device.deviceFor(env, request);
    if (route === 'GET /api/v1/device/me') return json({ device: { id: me.id, model: me.model, name: me.name, signedInAt: me.created_at }, pilot: { id: me.pilot_id } });
    if (route === 'POST /api/v1/device/have') return json(await device.missingRawLogs(env, (await readJson(request, HAVE_BODY_LIMIT)).files));
    const upload = /^PUT \/api\/v1\/device\/logs\/([0-9a-f]{64})$/.exec(route);
    if (upload) {
      const bytes = await readBytes(request, device.DEVICE_LIMITS.rawLogBytes,
        () => new LogsError('raw_log_too_large', 413, 'This flight log is too large.'));
      const result = await device.putRawLog(env, me, upload[1], url.searchParams.get('name'), bytes);
      return json(result, result.duplicate ? 200 : 201);
    }
    if (route === 'POST /api/v1/device/sign-out') return json(await device.signOutDevice(env, me));
    return json({ error: 'Not found' }, 404);
  } catch (error) {
    if (error instanceof LogsError) return json({ error: error.message, code: error.code }, error.status);
    console.error('device-api', error?.message);
    return json({ error: 'Ledge Top Logs had a problem. Try again.', code: 'internal_error' }, 500);
  }
}
