// Public HTTP routes for controllers (logs.ledgetop.app/api/v1/device/*). Staff never use these; staff
// actions go through the FlightLogsService binding from Ops. Every response is uncached JSON.
import { LogsError } from './errors.mjs';
import * as device from './device.mjs';

const HAVE_BODY_LIMIT = 1024 * 1024;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

async function readJson(request, limit) {
  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > limit) throw new LogsError('too_large', 413, 'Request too large.');
  const raw = await request.arrayBuffer();
  if (raw.byteLength > limit) throw new LogsError('too_large', 413, 'Request too large.');
  try { return raw.byteLength ? JSON.parse(new TextDecoder().decode(raw)) : {}; } catch { throw new LogsError('invalid_json', 400, 'The request was not valid JSON.'); }
}

/** Returns a Response for /api/v1/device/* paths, or null for anything else. */
export async function handleDeviceRequest(request, env) {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/v1/device/')) return null;
  try {
    const route = `${request.method} ${path}`;
    if (route === 'POST /api/v1/device/sign-in') return json(await device.startSignIn(env, await readJson(request, 4096)), 201);
    const poll = /^GET \/api\/v1\/device\/sign-in\/([0-9a-f-]{36})$/.exec(route);
    // The poll token travels in a header, never the URL, so it stays out of request logs.
    if (poll) return json(await device.pollSignIn(env, poll[1], request.headers.get('X-Poll-Token')));

    const me = await device.deviceFor(env, request);
    if (route === 'GET /api/v1/device/me') return json({ device: { id: me.id, model: me.model, name: me.name, signedInAt: me.created_at }, pilot: { id: me.pilot_id } });
    if (route === 'POST /api/v1/device/have') return json(await device.missingRawLogs(env, (await readJson(request, HAVE_BODY_LIMIT)).files));
    const upload = /^PUT \/api\/v1\/device\/logs\/([0-9a-f]{64})$/.exec(route);
    if (upload) {
      const length = Number(request.headers.get('Content-Length') ?? 0);
      if (length > device.DEVICE_LIMITS.rawLogBytes) throw new LogsError('raw_log_too_large', 413, 'This flight log is too large.');
      const result = await device.putRawLog(env, me, upload[1], url.searchParams.get('name'), new Uint8Array(await request.arrayBuffer()));
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
