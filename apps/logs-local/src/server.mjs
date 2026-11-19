// The local Logs HTTP server. Every request is first authorised by machine-auth (an Access service-token
// JWT verified here, at the origin) and then routed by role:
//
//   device-proxy  /api/v1/device/*      the controller API, unchanged Logs code. Raw log uploads are streamed
//                                       straight to disk (never held in memory), with the SHA and the 100 MiB
//                                       limit enforced while streaming and a cap on concurrent uploads.
//   staff-proxy   /internal/v1/logs/*   the Ops flight-logs API (the 15 FlightLogsService methods), acting as the
//                                       staff actor Ops authorised. Sensitive writes recheck authority fresh.
//
// Anything else, or anything unauthorised, is the same 404. There is no public health route: health is on a
// separate listener bound to 127.0.0.1 inside the container (createHealthServer).
import http from 'node:http';
import { Readable } from 'node:stream';
import * as service from '../../logs/src/worker/service.mjs';
import * as device from '../../logs/src/worker/device.mjs';
import * as attribution from '../../logs/src/worker/attribution.mjs';
import { handleDeviceRequest } from '../../logs/src/worker/device-routes.mjs';
import { LogsError } from '../../logs/src/worker/errors.mjs';
import { ObjectStoreError } from './fs-r2.mjs';
import { IdempotencyError } from './idempotency.mjs';

export const SERVER_LIMITS = Object.freeze({
  rpcBodyBytes: 1024 * 1024,
  // importFlights carries a whole Ops batch: the Ops route accepts up to 8 MiB (FLIGHT_LOG_LIMITS.batchBytes)
  // plus the RPC envelope around it. Lowering this would break imports Ops already accepts.
  importBodyBytes: 8 * 1024 * 1024 + 64 * 1024,
  telemetryBodyBytes: service.LIMITS.telemetryBytes,
  rawLogBytes: device.DEVICE_LIMITS.rawLogBytes,
  headersTimeoutMs: 30_000,
  requestTimeoutMs: 15 * 60_000,
  idleSocketMs: 60_000,
  signInStartsPerMinute: 5,
  storageRetryAfterSeconds: 300,
  busyRetryAfterSeconds: 30,
});

const SHA = /^[0-9a-f]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UPLOAD = /^\/api\/v1\/device\/logs\/([0-9a-f]{64})$/;
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Staff RPC methods: how each is called, and which need a key and a fresh authority check. */
const RPC = Object.freeze({
  inventory: { fn: (env, a) => service.inventory(env, a) },
  listFlights: { fn: (env, a, [query]) => service.listFlights(env, a, query ?? {}) },
  getFlight: { fn: (env, a, [flightId]) => service.getFlight(env, a, flightId) },
  facets: { fn: (env, a) => service.facets(env, a) },
  overview: { fn: (env, a, [query]) => service.overview(env, a, query ?? {}) },
  pendingSignIns: { fn: (env, a) => device.pendingSignIns(env, a) },
  listDevices: { fn: (env, a, [input]) => device.listDevices(env, a, input ?? {}) },
  // Import writes are naturally idempotent (rows keyed by file hash, objects by content).
  importFlights: { fn: (env, a, [importId, batch]) => service.importFlights(env, a, importId, batch ?? {}), authority: 'import', bodyBytes: SERVER_LIMITS.importBodyBytes },
  completeImport: { fn: (env, a, [importId, input]) => service.completeImport(env, a, importId, input ?? {}), authority: 'import' },
  // Not naturally idempotent: an Idempotency-Key is required, and authority is rechecked fresh first.
  startImport: { fn: (env, a, [input]) => service.startImport(env, a, input ?? {}), authority: 'import', keyed: true, scope: () => 'import' },
  decideSignIn: { fn: (env, a, [input]) => device.decideSignIn(env, a, input ?? {}), authority: 'active', keyed: true, scope: ([input]) => `sign-in:${input?.signInId}` },
  clearPendingSignIns: { fn: (env, a) => device.clearPendingSignIns(env, a), authority: 'active', keyed: true, scope: () => 'sign-ins' },
  revokeDevice: { fn: (env, a, [deviceId]) => device.revokeDevice(env, a, deviceId), authority: 'active', keyed: true, scope: ([deviceId]) => `device:${deviceId}` },
  // Flight attribution review: administrators only (checked fresh with Ops on every call, reads included); every
  // change is audited in the same transaction. Writes need an Idempotency-Key.
  logsStatus: { fn: (env, a) => attribution.logsStatus(env, a), authority: 'administrator' },
  reviewQueue: { fn: (env, a, [input]) => attribution.reviewQueue(env, a, input ?? {}), authority: 'administrator' },
  assignDecodedLog: { fn: (env, a, [input]) => attribution.assignDecodedLog(env, a, input ?? {}), authority: 'administrator', keyed: true,
    scope: ([input]) => `attribution:raw:${input?.rawSha256}` },
  reassignFlight: { fn: (env, a, [input]) => attribution.reassignFlight(env, a, input ?? {}), authority: 'administrator', keyed: true,
    scope: ([input]) => `attribution:flight:${input?.flightId}` },
  resolveConflict: { fn: (env, a, [input]) => attribution.resolveConflict(env, a, input ?? {}), authority: 'administrator', keyed: true,
    scope: ([input]) => `attribution:raw:${input?.rawSha256}` },
});

const json = (res, status, body, headers = {}) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(text), ...headers });
  res.end(text);
};
const notFound = res => json(res, 404, { error: 'Not found' });
/** The FlightLogsService result envelope Ops already understands. */
const envelope = error => ({ ok: false, error: { code: error.code, status: error.status, message: error.message } });

/** Web-style headers from a Node request (single values; repeated headers joined like fetch does). */
function headersOf(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined || name === 'host' || name === 'connection' || name === 'transfer-encoding') continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}

/** Reads a request body into memory, refusing beyond `limit` while reading (small bodies only). */
async function readBody(req, limit) {
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new LogsError('body_too_large', 413, 'The request is too large.');
  const parts = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.byteLength;
    if (size > limit) throw new LogsError('body_too_large', 413, 'The request is too large.');
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

function drain(req) { req.resume(); req.on('error', () => {}); }

/** A small sliding-window limiter, per key (client address), in memory. */
function rateLimiter(perMinute, now) {
  const hits = new Map();
  return key => {
    const at = now(), recent = (hits.get(key) ?? []).filter(t => at - t < 60_000);
    if (recent.length >= perMinute) { hits.set(key, recent); return false; }
    recent.push(at);
    hits.set(key, recent);
    if (hits.size > 10_000) hits.delete(hits.keys().next().value);
    return true;
  };
}

/**
 * @param {object} deps
 * @param {object} deps.env { LOGS_DB, LOGS_BUCKET, OPS_DIRECTORY, KEYCHAIN_ENCRYPTION_KEY? }
 * @param {(request: Request) => Promise<object>} deps.authorize machine-auth authorizer
 * @param {Function} deps.idempotency createIdempotency(db)
 * @param {{ getStaffAuthority: Function }} deps.directory fresh staff authority (directory-client)
 * @param {number} [deps.uploadConcurrency]
 */
export function createLogsServer({ env, authorize, idempotency, directory, ingressHost, uploadConcurrency = 4, now = Date.now, log = () => {} }) {
  const expectedHost = String(ingressHost ?? '').toLowerCase();
  if (!/^[a-z0-9.-]+(:[0-9]{1,5})?$/.test(expectedHost)) throw new Error('logs_ingress_host_invalid');
  let uploads = 0;
  const allowSignIn = rateLimiter(SERVER_LIMITS.signInStartsPerMinute, now);
  const active = new Set();

  /**
   * Fresh, uncached Ops authority for a sensitive write. Returns the actor to act as: the permissions Ops
   * asserted, narrowed to what Ops says right now, so a permission removed since the session began (e.g. import,
   * which also lets a manager revoke another pilot's controller) cannot be used.
   */
  async function freshAuthority(actor, need) {
    let authority;
    try { authority = await directory.getStaffAuthority(actor.staffId); }
    catch { throw new LogsError('directory_unavailable', 503, 'Ledge Top could not confirm your access. Try again in a minute.'); }
    const allowed = authority.active && (need === 'active' || (need === 'import' && authority.canImport) || (need === 'administrator' && authority.administrator));
    if (!allowed) throw new LogsError('forbidden', 403, 'You do not have permission to do that.');
    const permissions = actor.permissions.filter(p => p !== 'flight_logs.import' || authority.canImport);
    // `administrator` is only ever the fresh Ops answer, never anything the caller asserted.
    return Object.freeze({ staffId: actor.staffId, permissions: Object.freeze(permissions), administrator: authority.administrator === true });
  }

  async function handleUpload(req, res, sha, url) {
    if (sha === EMPTY_SHA256 || Number(req.headers['content-length'] ?? 1) === 0) { drain(req); return json(res, 413, { error: 'This flight log is empty or too large.', code: 'raw_log_too_large' }); }
    if (Number(req.headers['content-length'] ?? 0) > SERVER_LIMITS.rawLogBytes) { drain(req); return json(res, 413, { error: 'This flight log is empty or too large.', code: 'raw_log_too_large' }); }
    const me = await device.deviceFor(env, { headers: headersOf(req) });
    const existing = await device.existingRawLog(env, sha);
    if (existing) { drain(req); return json(res, 200, existing); }
    if (uploads >= uploadConcurrency) {
      drain(req);
      return json(res, 503, { error: 'Ledge Top is busy. The log will be sent again shortly.', code: 'busy' }, { 'Retry-After': String(SERVER_LIMITS.busyRetryAfterSeconds) });
    }
    uploads++;
    try {
      let stored;
      try {
        stored = await env.LOGS_BUCKET.put(device.rawLogKey(sha), req, { ...device.RAW_LOG_OBJECT_OPTIONS(sha), sha256: sha });
      } catch (error) {
        if (!(error instanceof ObjectStoreError)) throw error;
        if (error.code === 'object_too_large') throw new LogsError('raw_log_too_large', 413, 'This flight log is too large.');
        if (error.code === 'checksum_mismatch') throw new LogsError('hash_mismatch', 422, 'The file changed or was damaged on the way. It will be sent again.');
        if (error.code === 'storage_full') {
          drain(req);
          return json(res, 503, { error: 'Ledge Top storage is nearly full. The log stays on the controller and will be sent later.', code: 'storage_full' },
            { 'Retry-After': String(SERVER_LIMITS.storageRetryAfterSeconds) });
        }
        throw error;
      }
      const result = await device.recordRawLog(env, me, sha, url.searchParams.get('name'), stored.size);
      return json(res, 201, result);
    } finally { uploads--; }
  }

  async function handleDevice(req, res, url) {
    const upload = req.method === 'PUT' ? UPLOAD.exec(url.pathname) : null;
    if (upload) return handleUpload(req, res, upload[1], url);
    if (req.method === 'POST' && url.pathname === '/api/v1/device/sign-in') {
      // The edge Worker passes the controller's address; it is trusted only because device-proxy is authenticated.
      const client = String(req.headers['x-ledge-top-client-ip'] ?? 'unknown').slice(0, 64);
      if (!allowSignIn(client)) { drain(req); return json(res, 429, { error: 'Too many sign-in attempts. Wait a minute and try again.', code: 'rate_limited' }, { 'Retry-After': '60' }); }
    }
    const init = { method: req.method, headers: headersOf(req) };
    if (req.method !== 'GET' && req.method !== 'HEAD') { init.body = Readable.toWeb(req); init.duplex = 'half'; }
    const response = await handleDeviceRequest(new Request(url, init), env);
    const body = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'Content-Length': body.byteLength });
    res.end(body);
  }

  async function handleStaff(req, res, url, auth) {
    const actor = auth.actor;
    const telemetryPut = /^\/internal\/v1\/logs\/imports\/([A-Za-z0-9_-]{1,128})\/flights\/([A-Za-z0-9_-]{1,128})\/telemetry$/.exec(url.pathname);
    if (telemetryPut && req.method === 'PUT') {
      const body = new Uint8Array(await readBody(req, SERVER_LIMITS.telemetryBodyBytes));
      const current = await freshAuthority(actor, 'import');
      return json(res, 200, { ok: true, value: await service.putTelemetry(env, current, telemetryPut[1], telemetryPut[2], body) });
    }
    const telemetryGet = /^\/internal\/v1\/logs\/flights\/([A-Za-z0-9_-]{1,128})\/telemetry$/.exec(url.pathname);
    if (telemetryGet && req.method === 'GET') {
      const bytes = await service.getTelemetry(env, actor, telemetryGet[1]);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': bytes.byteLength });
      return res.end(bytes);
    }
    const rpc = /^\/internal\/v1\/logs\/rpc\/([A-Za-z]{1,40})$/.exec(url.pathname);
    const method = rpc && req.method === 'POST' && Object.hasOwn(RPC, rpc[1]) ? RPC[rpc[1]] : null;
    if (!method) { drain(req); return notFound(res); }
    let args;
    try { args = JSON.parse((await readBody(req, method.bodyBytes ?? SERVER_LIMITS.rpcBodyBytes)).toString('utf8') || '{}').args ?? []; }
    catch (error) { if (error instanceof LogsError) throw error; throw new LogsError('bad_request', 400, 'The request body is not valid JSON.'); }
    if (!Array.isArray(args) || args.length > 4) throw new LogsError('bad_request', 400, 'args must be an array.');
    for (const id of args.filter(a => typeof a === 'string')) if (id.length > 4096) throw new LogsError('bad_request', 400, 'An argument is too long.');
    const effective = method.authority ? await freshAuthority(actor, method.authority) : actor;
    const run = () => method.fn(env, effective, args);
    if (!method.keyed) return json(res, 200, { ok: true, value: await run() });
    const key = req.headers['idempotency-key'];
    const value = await idempotency({ identity: auth.clientId, actorId: actor.staffId, operation: rpc[1], scope: method.scope(args), key, request: args }, run);
    return json(res, 200, { ok: true, value });
  }

  const server = http.createServer({ headersTimeout: SERVER_LIMITS.headersTimeoutMs, requestTimeout: SERVER_LIMITS.requestTimeoutMs, maxHeaderSize: 16 * 1024 }, (req, res) => {
    const done = (async () => {
      req.setTimeout(SERVER_LIMITS.idleSocketMs, () => req.destroy());
      let url;
      try { url = new URL(req.url, 'https://logs.internal'); } catch { drain(req); return notFound(res); }
      if (!req.url.startsWith('/')) { drain(req); return notFound(res); }
      // Only the one Tunnel hostname this backend serves; any other Host (direct IP, another name) is a 404.
      if (String(req.headers.host ?? '').toLowerCase() !== expectedHost) { drain(req); return notFound(res); }
      const auth = await authorize(new Request(url, { headers: headersOf(req) }));
      if (!auth.ok) { drain(req); return notFound(res); }
      try {
        if (auth.role === 'device-proxy') return await handleDevice(req, res, url);
        if (auth.role === 'staff-proxy') return await handleStaff(req, res, url, auth);
        drain(req);
        return notFound(res);
      } catch (error) {
        if (res.headersSent) { res.destroy(); return; }
        if (!req.readableEnded) drain(req);
        if (auth.role === 'device-proxy') {
          if (error instanceof LogsError) return json(res, error.status, { error: error.message, code: error.code });
          log('device-api', error?.code ?? 'internal_error');
          return json(res, 500, { error: 'Ledge Top Logs had a problem. Try again.', code: 'internal_error' });
        }
        if (error instanceof LogsError || error instanceof IdempotencyError) return json(res, 200, envelope(error));
        log('flight-logs', error?.code ?? 'internal_error');
        return json(res, 200, envelope({ code: 'internal_error', status: 500, message: 'Flight logs had a problem. Try again.' }));
      }
    })().catch(() => { if (!res.headersSent) json(res, 500, { error: 'Internal error' }); else res.destroy(); });
    active.add(done);
    done.finally(() => active.delete(done));
  });
  server.keepAliveTimeout = 5000;

  /** Stops accepting connections and waits (bounded) for requests in flight. */
  async function close(graceMs = 25_000) {
    await new Promise(resolve => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => { server.closeAllConnections(); resolve(); }, graceMs).unref();
    });
    await Promise.race([Promise.allSettled([...active]), new Promise(resolve => setTimeout(resolve, graceMs).unref())]);
  }

  return { server, close, get uploadsInFlight() { return uploads; } };
}

/** Container-internal health, on 127.0.0.1 only: never reachable through the Tunnel. */
export function createHealthServer(status) {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') return notFound(res);
    try { return json(res, 200, { ok: true, ...status() }); }
    catch { return json(res, 503, { ok: false }); }
  });
}
