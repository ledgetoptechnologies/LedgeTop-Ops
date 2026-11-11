// ltds-logs Worker. Staff access is only through the FlightLogsService entrypoint, bound to the Ops
// Worker, which authenticates the staff member and passes { staffId, permissions }. The public fetch
// handler serves a health check only; the controller device API is a later phase.
import { WorkerEntrypoint } from 'cloudflare:workers';
import * as service from './service.mjs';

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
  getTelemetry(actor, flightId) { return call(() => service.getTelemetry(this.env, actor, flightId)); }
}

export default {
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ service: 'ltds-logs', ok: true });
    return new Response('Not found', { status: 404 });
  },
};
