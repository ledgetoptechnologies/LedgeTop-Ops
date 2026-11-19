// Ledge Top Logs Worker. Staff access is only through the FlightLogsService entrypoint, bound to the Ops
// Worker, which authenticates the staff member and passes { staffId, permissions }. The public fetch
// handler serves a health check and the controller device API (/api/v1/device/*, see device-routes.mjs).
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as service from './service.mjs';
import * as device from './device.mjs';
import { handlePublicRequest } from './device-routes.mjs';
import { deviceHostAllowed, deviceProxyEnabled, proxyDeviceRequest } from './device-proxy.mjs';
import * as decode from './decode-contract.mjs';
import * as decoder from './decoder-service.mjs';

const call = async fn => {
  try { return { ok: true, value: await fn() }; }
  catch (error) {
    if (error instanceof service.LogsError) return { ok: false, error: { code: error.code, status: error.status, message: error.message } };
    console.error('flight-logs', error?.message);
    return { ok: false, error: { code: 'internal_error', status: 500, message: 'Flight logs had a problem. Try again.' } };
  }
};

export class FlightLogsService extends WorkerEntrypoint {
  inventory(actor) { return call(() => service.inventory(this.env, actor)); }
  startImport(actor, input) { return call(() => service.startImport(this.env, actor, input ?? {})); }
  importFlights(actor, importId, batch) { return call(() => service.importFlights(this.env, actor, importId, batch ?? {})); }
  putTelemetry(actor, importId, flightId, body) { return call(() => service.putTelemetry(this.env, actor, importId, flightId, body)); }
  completeImport(actor, importId, input) { return call(() => service.completeImport(this.env, actor, importId, input ?? {})); }
  listFlights(actor, query) { return call(() => service.listFlights(this.env, actor, query ?? {})); }
  getFlight(actor, flightId) { return call(() => service.getFlight(this.env, actor, flightId)); }
  facets(actor) { return call(() => service.facets(this.env, actor)); }
  overview(actor, query) { return call(() => service.overview(this.env, actor, query ?? {})); }
  getTelemetry(actor, flightId) { return call(() => service.getTelemetry(this.env, actor, flightId)); }
  // Controller sign-in and management. Ops passes only the authenticated, active staff id.
  pendingSignIns(actor) { return call(() => device.pendingSignIns(this.env, actor)); }
  decideSignIn(actor, input) { return call(() => device.decideSignIn(this.env, actor, input ?? {})); }
  clearPendingSignIns(actor) { return call(() => device.clearPendingSignIns(this.env, actor)); }
  listDevices(actor, input) { return call(() => device.listDevices(this.env, actor, input ?? {})); }
  revokeDevice(actor, deviceId) { return call(() => device.revokeDevice(this.env, actor, deviceId)); }
}

/**
 * Parser-only entrypoint for the Docker decoder, bound privately to the decoder machine bridge (the alternative to the
 * in-process decoder on the local Logs host; see DECODER.md). Closed unless DECODER_ENABLED is "true". It takes no
 * staff actor, pilot, URL or storage key: only the bridge-configured runner id with a claim request id, or the lease
 * it handed out, and the decoded result for that lease.
 */
export class DecoderService extends WorkerEntrypoint {
  // Closed codes only. Unexpected exceptions are logged as a fixed category, never their text: messages from
  // bindings, D1 or R2 can carry keys, SQL bindings or object names.
  async #open(operation, fn) {
    if (!decoder.decoderEnabled(this.env)) return { ok: false, error: { code: 'decoder_disabled', status: 503 } };
    try { return { ok: true, value: await fn() }; }
    catch (error) {
      if (error instanceof service.LogsError) return { ok: false, error: { code: error.code, status: error.status } };
      console.error(JSON.stringify({ event: 'logs.decoder.unexpected', operation }));
      return { ok: false, error: { code: 'internal_error', status: 500 } };
    }
  }
  claim(input) { return this.#open('claim', () => decode.claimRawLog(this.env, { runnerId: input?.runnerId, requestId: input?.requestId })); }
  heartbeat(lease) { return this.#open('heartbeat', () => decode.heartbeatLease(this.env, lease)); }
  readRaw(lease) { return this.#open('readRaw', () => decoder.readRaw(this.env, lease)); }
  complete(lease, result) { return this.#open('complete', () => decoder.completeWithTrack(this.env, lease, result ?? {})); }
  defer(lease, input) { return this.#open('defer', () => decode.deferDecode(this.env, lease, input?.errorCode, { retryAfterSeconds: input?.retryAfterSeconds })); }
  retry(lease, input) { return this.#open('retry', () => decode.retryDecode(this.env, lease, input?.errorCode)); }
  suspend(lease, input) { return this.#open('suspend', () => decode.suspendDecode(this.env, lease, input?.errorCode)); }
  fail(lease, input) { return this.#open('fail', () => decode.failDecode(this.env, lease, input?.errorCode)); }
  reconcile(lease) { return this.#open('reconcile', () => decode.reconcileDecode(this.env, lease)); }
}

export default {
  fetch(request, env) {
    if (!deviceProxyEnabled(env)) return handlePublicRequest(request, env);
    // Local mode: answer only on the exact public device hostnames (health included); the device API is served by the
    // NAS Logs host through the Tunnel. Nothing else is forwarded.
    if (!deviceHostAllowed(request, env)) return new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    return handlePublicRequest(request, env, (r, e) => proxyDeviceRequest(r, e));
  },
};
