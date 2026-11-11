import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { registerFlightLogsRoutes, type FlightLogsActor, type FlightLogsBinding } from "../src/worker/flight-logs-routes";

const principal = (id: string): StaffPrincipal => ({ id, email: `${id}@example.test`, displayName: id, accessSubject: id, projectAlphaUserId: null });
let runtime: Miniflare, db: D1Database;

function fakeBinding(calls: unknown[][]): FlightLogsBinding {
  const ok = <T>(value: T) => Promise.resolve({ ok: true as const, value });
  return {
    inventory: actor => { calls.push(["inventory", actor]); return ok({ fileHashes: [] }); },
    startImport: (actor, input) => { calls.push(["startImport", actor, input]); return ok({ importId: "import-1" }); },
    importFlights: (actor, importId, batch) => { calls.push(["importFlights", actor, importId, batch]); return ok({ created: [], existing: [] }); },
    putTelemetry: (actor, importId, flightId, body) => { calls.push(["putTelemetry", actor, importId, flightId, body.byteLength]); return ok({ stored: true }); },
    completeImport: (actor, importId, input) => { calls.push(["completeImport", actor, importId, input]); return ok({ importId }); },
    listFlights: (actor, query) => { calls.push(["listFlights", actor, query]); return ok({ items: [{ id: "f1", pilotId: "pilot" }, { id: "f2", pilotId: "removed" }], next: null }); },
    getFlight: (actor, flightId) => { calls.push(["getFlight", actor, flightId]); return Promise.resolve({ ok: false as const, error: { code: "flight_not_found", status: 404, message: "That flight was not found." } }); },
    getTelemetry: (actor, flightId) => { calls.push(["getTelemetry", actor, flightId]); return ok(new Uint8Array([0x1f, 0x8b, 1])); },
  };
}

function app(staffId: string, binding?: FlightLogsBinding) {
  const hono = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  hono.use("*", async (c, next) => { c.set("principal", principal(staffId)); c.set("administrator", false); await next(); });
  hono.onError((error, c) => c.json({ error: error.message }, (error as { status?: number }).status as 400 ?? 500));
  registerFlightLogsRoutes(hono);
  const env = { OPS_DB: db, ...(binding ? { FLIGHT_LOGS: binding } : {}) } as unknown as Env;
  return (path: string, init?: RequestInit) => hono.request(path, init, env);
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "flight-logs-routes" } });
  db = await runtime.getD1Database("DB") as unknown as D1Database;
  await db.batch([
    db.prepare("CREATE TABLE staff_users(id TEXT PRIMARY KEY,display_name TEXT,status TEXT)"),
    db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)"),
    db.prepare("CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("INSERT INTO staff_users VALUES('owner','Beau','active'),('pilot','Kollin','active'),('viewer','Viewer','active'),('gone','Former','inactive')"),
    db.prepare("INSERT INTO role_permissions VALUES('role-owner','flight_logs.view'),('role-owner','flight_logs.import'),('role-employee','flight_logs.view')"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global',NULL),('viewer','role-employee','global',NULL)"),
  ]);
});
afterAll(async () => { await runtime?.dispose(); });

describe("flight logs routes", () => {
  it("say the logs service isn't connected when the binding is absent", async () => {
    const response = await app("owner")("/api/admin/flight-logs/flights");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Flight logs aren’t connected yet." });
  });

  it("pass only flight-log permissions to the logs Worker and refuse staff without them", async () => {
    const calls: unknown[][] = [];
    expect((await app("owner", fakeBinding(calls))("/api/admin/flight-logs/flights?limit=20&before=x")).status).toBe(200);
    expect(calls[0]).toEqual(["listFlights", { staffId: "owner", permissions: ["flight_logs.view", "flight_logs.import"] } satisfies FlightLogsActor, { limit: 20, before: "x" }]);
    const listed = await (await app("owner", fakeBinding([]))("/api/admin/flight-logs/flights")).json() as { items: Array<{ pilotName: string | null }> };
    expect(listed.items.map(item => item.pilotName)).toEqual(["Kollin", null]);
    expect((await app("viewer", fakeBinding(calls))("/api/admin/flight-logs/flights")).status).toBe(200);
    const denied = await app("viewer", fakeBinding(calls))("/api/admin/flight-logs/import/inventory");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "You don’t have permission to import flight logs." });
    expect((await app("pilot", fakeBinding(calls))("/api/admin/flight-logs/flights")).status).toBe(403);
  });

  it("list only active staff as pilots and refuse an inactive or unknown pilot", async () => {
    const calls: unknown[][] = [], request = app("owner", fakeBinding(calls));
    expect(await (await request("/api/admin/flight-logs/import/pilots")).json()).toEqual({ items: [{ id: "owner", displayName: "Beau" }, { id: "pilot", displayName: "Kollin" }, { id: "viewer", displayName: "Viewer" }] });
    for (const pilotId of ["gone", "nobody", ""]) {
      const response = await request("/api/admin/flight-logs/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pilotId, expectedFlights: 3 }) });
      expect(response.status).toBe(400);
    }
    const started = await request("/api/admin/flight-logs/imports", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pilotId: "pilot", expectedFlights: 43 }) });
    expect(started.status).toBe(201);
    expect(calls.at(-1)).toEqual(["startImport", expect.objectContaining({ staffId: "owner" }), { sourceSystem: "opendronelog", pilotId: "pilot", expectedFlights: 43 }]);
  });

  it("forward batches and tracks with validated ids and size limits", async () => {
    const calls: unknown[][] = [], request = app("owner", fakeBinding(calls));
    expect((await request("/api/admin/flight-logs/imports/import-1/flights", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flights: [] }) })).status).toBe(200);
    expect((await request("/api/admin/flight-logs/imports/import-1/flights/flight-1/track", { method: "PUT", body: new Uint8Array([0x1f, 0x8b, 9]) })).status).toBe(200);
    expect(calls.at(-1)).toEqual(["putTelemetry", expect.anything(), "import-1", "flight-1", 3]);
    expect((await request("/api/admin/flight-logs/imports/bad%20id/complete", { method: "POST" })).status).toBe(400);
    expect((await request("/api/admin/flight-logs/imports/import-1/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracksExpected: 2 }) })).status).toBe(200);
    expect(calls.at(-1)).toEqual(["completeImport", expect.anything(), "import-1", { tracksExpected: 2 }]);
    expect((await request("/api/admin/flight-logs/imports/import-1/flights/flight-1/track", { method: "PUT", headers: { "Content-Length": String(33 * 1024 * 1024) }, body: new Uint8Array(1) })).status).toBe(413);
  });

  it("map logs-service errors to HTTP and stream tracks as gzip without caching", async () => {
    const request = app("owner", fakeBinding([]));
    const missing = await request("/api/admin/flight-logs/flights/abc");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "That flight was not found." });
    const track = await request("/api/admin/flight-logs/flights/abc/track");
    expect(track.headers.get("Content-Encoding")).toBe("gzip");
    expect(track.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
