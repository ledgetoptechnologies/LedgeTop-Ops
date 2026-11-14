// Ledge Top Logs Worker. Staff access is only through the FlightLogsService entrypoint, bound to the Ops
// Worker, which authenticates the staff member and passes { staffId, permissions }. The public fetch
// handler serves a health check and the controller device API (/api/v1/device/*, see device-routes.mjs).
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as service from './service.mjs';
import * as device from './device.mjs';
import { handlePublicRequest } from './device-routes.mjs';
import { deviceHostAllowed, deviceProxyEnabled, proxyDeviceRequest } from './device-proxy.mjs';

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
  createPairing(actor) { return call(() => device.createPairing(this.env, actor)); }
  cancelPairing(actor, pairingId) { return call(() => device.cancelPairing(this.env, actor, pairingId)); }
  listDevices(actor, input) { return call(() => device.listDevices(this.env, actor, input ?? {})); }
  revokeDevice(actor, deviceId) { return call(() => device.revokeDevice(this.env, actor, deviceId)); }
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
