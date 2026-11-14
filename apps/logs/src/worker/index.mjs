// Ledge Top Logs Worker. Staff access is only through the FlightLogsService entrypoint, bound to the Ops
// Worker, which authenticates the staff member and passes { staffId, permissions }. The public fetch
// handler serves only a health check and the controller device API (/api/v1/device/*, see device-routes.mjs);
// every other path is 404. The local decoder never uses the public host: it reaches the parser-only DecoderService
// entrypoint below through a private service binding from the Ops machine bridge (see DECODER.md).
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as service from './service.mjs';
import * as device from './device.mjs';
import { handleDeviceRequest } from './device-routes.mjs';
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
 * Parser-only entrypoint for the local decoder, bound privately to the Ops machine bridge. Closed unless
 * DECODER_ENABLED is "true". It takes no staff actor, pilot, URL or storage key: only a claim request id or the
 * lease it handed out, and the decoded result for that lease.
 */
export class DecoderService extends WorkerEntrypoint {
  #open(fn) {
    if (!decoder.decoderEnabled(this.env)) return Promise.resolve({ ok: false, error: { code: 'decoder_disabled', status: 503, message: 'Decoding is not enabled.' } });
    return call(fn);
  }
  claim(input) { return this.#open(() => decode.claimRawLog(this.env, { requestId: input?.requestId })); }
  heartbeat(lease) { return this.#open(() => decode.heartbeatLease(this.env, lease)); }
  readRaw(lease) { return this.#open(() => decoder.readRaw(this.env, lease)); }
  complete(lease, result) { return this.#open(() => decoder.completeWithTrack(this.env, lease, result ?? {})); }
  defer(lease, input) { return this.#open(() => decode.deferDecode(this.env, lease, input?.errorCode, { retryAfterSeconds: input?.retryAfterSeconds })); }
  retry(lease, input) { return this.#open(() => decode.retryDecode(this.env, lease, input?.errorCode)); }
  fail(lease, input) { return this.#open(() => decode.failDecode(this.env, lease, input?.errorCode)); }
  reconcile(lease) { return this.#open(() => decode.reconcileDecode(this.env, lease)); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ service: 'ledge-top-logs', ok: true });
    const deviceResponse = await handleDeviceRequest(request, env);
    if (deviceResponse) return deviceResponse;
    return new Response('Not found', { status: 404 });
  },
};
