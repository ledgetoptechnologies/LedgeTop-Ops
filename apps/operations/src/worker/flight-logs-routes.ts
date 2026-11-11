// Fleet & flight logs: Ops staff routes in front of the ltds-logs Worker (FlightLogsService entrypoint).
// Ops authenticates the staff member and resolves permissions; the logs Worker re-checks them.
// Flight logs are staff-only and never reach the Client Portal.
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { permissionKeys } from "./acl";
import { readBoundedJson } from "./bounded-json";
import type { Env, StaffPrincipal } from "./types";

type Bindings = { Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } };
type FlightLogsPermission = "flight_logs.view" | "flight_logs.import";
export interface FlightLogsActor { staffId: string; permissions: FlightLogsPermission[] }
type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; status: number; message: string } };

/** RPC surface of the ltds-logs FlightLogsService entrypoint. */
export interface FlightLogsBinding {
  inventory(actor: FlightLogsActor): Promise<Result<unknown>>;
  startImport(actor: FlightLogsActor, input: { sourceSystem: "opendronelog"; pilotId: string; expectedFlights: number }): Promise<Result<{ importId: string }>>;
  importFlights(actor: FlightLogsActor, importId: string, batch: unknown): Promise<Result<unknown>>;
  putTelemetry(actor: FlightLogsActor, importId: string, flightId: string, body: Uint8Array): Promise<Result<unknown>>;
  completeImport(actor: FlightLogsActor, importId: string, input: { tracksExpected: number }): Promise<Result<unknown>>;
  listFlights(actor: FlightLogsActor, query: FlightLogsQuery): Promise<Result<unknown>>;
  facets(actor: FlightLogsActor): Promise<Result<unknown>>;
  overview(actor: FlightLogsActor, query: FlightLogsQuery): Promise<Result<unknown>>;
  getFlight(actor: FlightLogsActor, flightId: string): Promise<Result<unknown>>;
  getTelemetry(actor: FlightLogsActor, flightId: string): Promise<Result<Uint8Array>>;
}

/** Filters shared by the flight list and the overview. The logs service validates every value again. */
export type FlightLogsQuery = Partial<Record<(typeof FILTER_KEYS)[number], string>> & { limit?: number; before?: string };
const FILTER_KEYS = ["from", "to", "aircraft", "battery", "pilot", "tag", "q", "minDuration", "maxDuration", "minAltitude", "maxAltitude", "minDistance", "maxDistance"] as const;
function filtersFrom(query: (name: string) => string | undefined): FlightLogsQuery {
  const filters: FlightLogsQuery = {};
  for (const key of FILTER_KEYS) {
    const value = query(key);
    if (typeof value === "string" && value.length > 0 && value.length <= 100) filters[key] = value;
  }
  return filters;
}

export const FLIGHT_LOG_LIMITS = { batchBytes: 8 * 1024 * 1024, trackBytes: 32 * 1024 * 1024 };
const ID = /^[A-Za-z0-9-]{1,80}$/;

function binding(env: Env): FlightLogsBinding {
  const service = (env as Env & { FLIGHT_LOGS?: FlightLogsBinding }).FLIGHT_LOGS;
  if (!service) throw new HTTPException(503, { message: "Flight logs aren’t connected yet." });
  return service;
}

async function actorFor(env: Env, principal: StaffPrincipal, need: FlightLogsPermission): Promise<FlightLogsActor> {
  const granted = (await permissionKeys(env, principal)).filter((key): key is FlightLogsPermission => key === "flight_logs.view" || key === "flight_logs.import");
  if (!granted.includes(need)) throw new HTTPException(403, { message: need === "flight_logs.import" ? "You don’t have permission to import flight logs." : "You don’t have permission to view flight logs." });
  return { staffId: principal.id, permissions: granted };
}

function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  const status = [400, 401, 403, 404, 409, 413, 503].includes(result.error.status) ? result.error.status : 502;
  throw new HTTPException(status as 400, { message: result.error.message });
}

function id(value: string | undefined, label: string): string {
  if (!value || !ID.test(value)) throw new HTTPException(400, { message: `${label} is not valid` });
  return value;
}

async function readTrack(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > FLIGHT_LOG_LIMITS.trackBytes) throw new HTTPException(413, { message: "This flight’s track is too large to store." });
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > FLIGHT_LOG_LIMITS.trackBytes) throw new HTTPException(413, { message: "This flight’s track is too large to store." });
  return bytes;
}

async function withPilotNames<T extends { pilotId: string }>(env: Env, items: T[]): Promise<Array<T & { pilotName: string | null }>> {
  const ids = [...new Set(items.map(item => item.pilotId))].slice(0, 100), names = new Map<string, string>();
  if (ids.length) {
    const rows = await env.OPS_DB.prepare(`SELECT id, display_name FROM staff_users WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids).all<{ id: string; display_name: string }>();
    for (const row of rows.results) names.set(row.id, row.display_name);
  }
  return items.map(item => ({ ...item, pilotName: names.get(item.pilotId) ?? null }));
}

export function registerFlightLogsRoutes(app: Hono<Bindings>): void {
  const noStore = { "Cache-Control": "private, no-store" };

  app.get("/api/admin/flight-logs/flights", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.view");
    const limit = Number(c.req.query("limit") ?? 50), before = c.req.query("before") ?? undefined;
    const page = unwrap(await binding(c.env).listFlights(actor, { ...filtersFrom(name => c.req.query(name)), limit, before })) as { items: Array<{ pilotId: string }>; next: string | null; total: number };
    return c.json({ ...page, items: await withPilotNames(c.env, page.items) }, 200, noStore);
  });

  app.get("/api/admin/flight-logs/facets", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.view");
    const facets = unwrap(await binding(c.env).facets(actor)) as { pilots: Array<{ id: string; flights: number }> } & Record<string, unknown>;
    return c.json({ ...facets, pilots: await withPilotNames(c.env, facets.pilots.map(pilot => ({ ...pilot, pilotId: pilot.id }))) }, 200, noStore);
  });

  app.get("/api/admin/flight-logs/overview", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.view");
    return c.json(unwrap(await binding(c.env).overview(actor, filtersFrom(name => c.req.query(name)))), 200, noStore);
  });

  app.get("/api/admin/flight-logs/flights/:id", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.view");
    const flight = unwrap(await binding(c.env).getFlight(actor, id(c.req.param("id"), "Flight"))) as { pilotId: string };
    return c.json((await withPilotNames(c.env, [flight]))[0], 200, noStore);
  });

  app.get("/api/admin/flight-logs/flights/:id/track", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.view");
    const bytes = unwrap(await binding(c.env).getTelemetry(actor, id(c.req.param("id"), "Flight")));
    return new Response(new Uint8Array(bytes).buffer as ArrayBuffer, { headers: { ...noStore, "Content-Type": "application/json", "Content-Encoding": "gzip", "X-Content-Type-Options": "nosniff" } });
  });

  // Import: the browser parses the OpenDroneLog backup locally, shows a dry run, then sends batches.
  app.get("/api/admin/flight-logs/import/inventory", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.import");
    return c.json(unwrap(await binding(c.env).inventory(actor)), 200, noStore);
  });

  app.get("/api/admin/flight-logs/import/pilots", async c => {
    await actorFor(c.env, c.get("principal"), "flight_logs.import");
    const rows = await c.env.OPS_DB.prepare("SELECT id, display_name FROM staff_users WHERE status='active' ORDER BY display_name COLLATE NOCASE").all<{ id: string; display_name: string }>();
    return c.json({ items: rows.results.map(row => ({ id: row.id, displayName: row.display_name })) }, 200, noStore);
  });

  app.post("/api/admin/flight-logs/imports", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.import");
    const body = await readBoundedJson(c.req.raw, 4096, "Import") as { pilotId?: unknown; expectedFlights?: unknown };
    const pilotId = typeof body?.pilotId === "string" ? body.pilotId : "";
    const pilot = pilotId ? await c.env.OPS_DB.prepare("SELECT id FROM staff_users WHERE id=? AND status='active'").bind(pilotId).first() : null;
    if (!pilot) throw new HTTPException(400, { message: "Choose an active staff member as the pilot." });
    const expectedFlights = Number(body.expectedFlights);
    return c.json(unwrap(await binding(c.env).startImport(actor, { sourceSystem: "opendronelog", pilotId, expectedFlights })), 201, noStore);
  });

  app.post("/api/admin/flight-logs/imports/:importId/flights", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.import");
    const batch = await readBoundedJson(c.req.raw, FLIGHT_LOG_LIMITS.batchBytes, "Flight batch");
    return c.json(unwrap(await binding(c.env).importFlights(actor, id(c.req.param("importId"), "Import"), batch)), 200, noStore);
  });

  app.put("/api/admin/flight-logs/imports/:importId/flights/:flightId/track", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.import");
    const body = await readTrack(c.req.raw);
    return c.json(unwrap(await binding(c.env).putTelemetry(actor, id(c.req.param("importId"), "Import"), id(c.req.param("flightId"), "Flight"), body)), 200, noStore);
  });

  app.post("/api/admin/flight-logs/imports/:importId/complete", async c => {
    const actor = await actorFor(c.env, c.get("principal"), "flight_logs.import");
    const importId = id(c.req.param("importId"), "Import");
    const body = await readBoundedJson(c.req.raw, 1024, "Import completion") as { tracksExpected?: unknown };
    return c.json(unwrap(await binding(c.env).completeImport(actor, importId, { tracksExpected: Number(body?.tracksExpected) })), 200, noStore);
  });
}
