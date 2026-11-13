import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { Hono } from "hono";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { FLIGHT_LOG_LIMITS, registerFlightLogsRoutes, type FlightLogsActor, type FlightLogsBinding } from "../src/worker/flight-logs-routes";

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
    pendingSignIns: actor => { calls.push(["pendingSignIns", actor]); return ok({ items: [{ id: "s1", code: "KXT-482" }] }); },
    decideSignIn: (actor, input) => { calls.push(["decideSignIn", actor, input]); return ok({ status: input.approve ? "approved" : "denied" }); },
    listDevices: (actor, input) => { calls.push(["listDevices", actor, input]); return ok({ items: [{ id: "d1", pilotId: "pilot" }] }); },
    revokeDevice: (actor, deviceId) => { calls.push(["revokeDevice", actor, deviceId]); return ok({ revoked: true }); },
    facets: actor => { calls.push(["facets", actor]); return ok({ aircraft: [], batteries: [], tags: [], pilots: [{ id: "pilot", flights: 2 }], ranges: {} }); },
    overview: (actor, query) => { calls.push(["overview", actor, query]); return ok({ totals: { flights: 0 } }); },
  };
}

function app(staffId: string, binding?: FlightLogsBinding, environment?: string) {
  const hono = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  hono.use("*", async (c, next) => { c.set("principal", principal(staffId)); c.set("administrator", staffId === "owner"); await next(); });
  hono.onError((error, c) => c.json({ error: error.message }, (error as { status?: number }).status as 400 ?? 500));
  registerFlightLogsRoutes(hono);
  const env = { OPS_DB: db, AUDIT_IP_SECRET: "test-audit-secret-0123456789abcdef0123456789abcdef", ...(environment ? { ENVIRONMENT: environment } : {}), ...(binding ? { FLIGHT_LOGS: binding } : {}) } as unknown as Env;
  return (path: string, init?: RequestInit) => hono.request(path, init, env);
}

function streamedTrack(chunks: Uint8Array[], headers: Record<string, string> = {}) {
  const state = { pulls: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.pulls++];
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  const init: RequestInit & { duplex: "half" } = { method: "PUT", headers, body, duplex: "half" };
  return { init, state, body };
}

beforeAll(async () => {
  runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default { fetch() { return new Response('ok') } }", d1Databases: { DB: "flight-logs-routes" } });
  db = await runtime.getD1Database("DB") as unknown as D1Database;
  await db.batch([
    db.prepare("CREATE TABLE staff_users(id TEXT PRIMARY KEY,display_name TEXT,status TEXT)"),
    db.prepare(`CREATE TABLE staff_usernames(staff_id TEXT PRIMARY KEY NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
      username TEXT NOT NULL UNIQUE CHECK (username = lower(username) AND length(username) BETWEEN 2 AND 32
        AND username NOT GLOB '*[^a-z0-9._-]*' AND substr(username, 1, 1) GLOB '[a-z0-9]'),
      set_by_staff_id TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`),
    db.prepare("CREATE TABLE audit_events(actor_type TEXT,actor_id TEXT,actor_email TEXT,actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,client_address_hash TEXT)"),
    db.prepare("CREATE TABLE staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("CREATE TABLE local_staff_role_assignments(staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT)"),
    db.prepare("CREATE TABLE staff_permission_overrides(staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT)"),
    db.prepare("INSERT INTO staff_users VALUES('owner','Beau','active'),('pilot','Kollin','active'),('viewer','Viewer','active'),('gone','Former','inactive')"),
    db.prepare("INSERT INTO staff_usernames(staff_id,username,set_by_staff_id) VALUES('owner','bkoltz','owner'),('pilot','kstirn','owner'),('gone','former','owner')"),
    db.prepare("INSERT INTO role_permissions VALUES('role-owner','flight_logs.view'),('role-owner','flight_logs.import'),('role-employee','flight_logs.view')"),
    db.prepare("INSERT INTO staff_role_assignments VALUES('owner','role-owner','global',NULL),('viewer','role-employee','global',NULL)"),
  ]);
});
afterAll(async () => { await runtime?.dispose(); });

describe("flight logs routes", () => {
  it("say the logs service isn't connected when the binding is absent", async () => {
    const response = await app("owner")("/api/flight-logs/flights");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Flight logs aren’t connected yet." });
  });

  it("blocks the staging Logs API before touching D1 or its service binding while the gate is off", async () => {
    const calls: unknown[][] = [];
    const response = await app("owner", fakeBinding(calls), "staging")("/api/flight-logs/flights");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Flight logs aren’t enabled for this staging deployment." });
    expect(calls).toEqual([]);
  });

  it("pass only flight-log permissions to the logs Worker; pilots without view-all get their own scope, inactive staff are refused", async () => {
    const calls: unknown[][] = [];
    expect((await app("owner", fakeBinding(calls))("/api/flight-logs/flights?limit=20&before=x")).status).toBe(200);
    expect(calls[0]).toEqual(["listFlights", { staffId: "owner", permissions: ["flight_logs.view", "flight_logs.import"] } satisfies FlightLogsActor, { limit: 20, before: "x" }]);
    const listed = await (await app("owner", fakeBinding([]))("/api/flight-logs/flights")).json() as { items: Array<{ pilotName: string | null }> };
    expect(listed.items.map(item => item.pilotName)).toEqual(["Kollin", null]);
    expect((await app("viewer", fakeBinding(calls))("/api/flight-logs/flights")).status).toBe(200);
    const denied = await app("viewer", fakeBinding(calls))("/api/admin/flight-logs/import/inventory");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "You don’t have permission to import flight logs." });
    // A pilot without flight_logs.view still reads, as themselves with no permissions: the logs Worker then
    // limits them to their own flights. Inactive staff are refused before any call.
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/flights")).status).toBe(200);
    expect(calls.at(-1)).toEqual(["listFlights", { staffId: "pilot", permissions: [] }, { limit: 50, before: undefined }]);
    const before = calls.length;
    expect((await app("gone", fakeBinding(calls))("/api/flight-logs/flights")).status).toBe(403);
    expect(calls.length).toBe(before);
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

  it("forward list and overview filters, drop unknown or oversized ones, and name pilots in facets", async () => {
    const calls: unknown[][] = [], request = app("owner", fakeBinding(calls));
    const query = "from=2026-01-01&to=2026-02-01&aircraft=a1&tag=Night%20Flight&minDuration=60&bogus=1&q=" + "x".repeat(101);
    expect((await request(`/api/flight-logs/flights?${query}`)).status).toBe(200);
    expect(calls.at(-1)).toEqual(["listFlights", expect.anything(), { from: "2026-01-01", to: "2026-02-01", aircraft: "a1", tag: "Night Flight", minDuration: "60", limit: 50, before: undefined }]);
    expect((await request(`/api/flight-logs/overview?${query}`)).status).toBe(200);
    expect(calls.at(-1)).toEqual(["overview", expect.anything(), { from: "2026-01-01", to: "2026-02-01", aircraft: "a1", tag: "Night Flight", minDuration: "60" }]);
    const facets = await (await request("/api/flight-logs/facets")).json() as { pilots: Array<{ pilotName: string | null }> };
    expect(facets.pilots.map(pilot => pilot.pilotName)).toEqual(["Kollin"]);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/overview")).status).toBe(200);
    expect(calls.at(-1)).toEqual(["overview", { staffId: "pilot", permissions: [] }, {}]);
  });

  it("approve controller sign-ins as yourself only, by authenticated staff id, with an active account", async () => {
    const calls: unknown[][] = [];
    const pending = await (await app("pilot", fakeBinding(calls))("/api/flight-logs/controller-sign-ins")).json() as { username: string | null; items: unknown[] };
    expect(pending.username).toBe("kstirn");
    expect(calls.at(-1)).toEqual(["pendingSignIns", expect.objectContaining({ staffId: "pilot" })]);
    // The decision carries only the signed-in staff id: never a username or email the client could choose.
    const approved = await app("pilot", fakeBinding(calls))("/api/flight-logs/controller-sign-ins/s1/approve", { method: "POST" });
    expect(approved.status).toBe(200);
    expect(calls.at(-1)).toEqual(["decideSignIn", expect.objectContaining({ staffId: "pilot" }), { signInId: "s1", approve: true }]);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/controller-sign-ins/s1/deny", { method: "POST" })).status).toBe(200);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/controller-sign-ins/s1/maybe", { method: "POST" })).status).toBe(404);
    expect((await app("gone", fakeBinding(calls))("/api/flight-logs/controller-sign-ins")).status).toBe(403);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/controllers")).status).toBe(200);
    expect(calls.at(-1)).toEqual(["listDevices", expect.objectContaining({ staffId: "pilot" }), { all: false }]);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/controllers?all=1")).status).toBe(200);
    // "all" needs flight_logs.import, which this pilot doesn't have.
    expect(calls.at(-1)).toEqual(["listDevices", expect.anything(), { all: false }]);
    expect((await app("pilot", fakeBinding(calls))("/api/flight-logs/controllers/d1/revoke", { method: "POST" })).status).toBe(200);
  });

  it("StaffDirectory resolves only an exact, active, unique username to a staff id", async () => {
    const { resolvePilotUsername, isActiveStaff } = await import("../src/worker/staff-directory-lookup");
    expect(await resolvePilotUsername(db, " BKoltz ")).toEqual({ staffId: "owner" });
    expect(await resolvePilotUsername(db, "former")).toBeNull();
    expect(await resolvePilotUsername(db, "nobody")).toBeNull();
    expect(await resolvePilotUsername(db, "owner@example.test")).toBeNull();
    expect(await resolvePilotUsername(db, 42)).toBeNull();
    expect(await isActiveStaff(db, "pilot")).toBe(true);
    expect(await isActiveStaff(db, "gone")).toBe(false);
    expect(await isActiveStaff(db, "missing")).toBe(false);
  });

  it("let only administrators set controller usernames, uniquely, with an audit record", async () => {
    const put = (as: string, staffId: string, username: unknown) => app(as)(`/api/admin/flight-logs/usernames/${staffId}`,
      { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username }) });
    expect((await app("pilot")("/api/admin/flight-logs/usernames")).status).toBe(403);
    expect((await put("pilot", "pilot", "kollin")).status).toBe(403);
    const list = await (await app("owner")("/api/admin/flight-logs/usernames")).json() as { items: Array<{ id: string; username: string | null }> };
    expect(list.items.map(item => [item.id, item.username])).toEqual([["owner", "bkoltz"], ["pilot", "kstirn"], ["viewer", null]]);
    expect((await put("owner", "viewer", "bkoltz")).status).toBe(409);
    expect((await put("owner", "viewer", "Has Space")).status).toBe(400);
    expect((await put("owner", "viewer", "v@x.test")).status).toBe(400);
    expect((await put("owner", "gone", "former2")).status).toBe(404);
    const set = await put("owner", "viewer", " Viewer1 ");
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ id: "viewer", username: "viewer1" });
    const { resolvePilotUsername } = await import("../src/worker/staff-directory-lookup");
    expect(await resolvePilotUsername(db, "viewer1")).toEqual({ staffId: "viewer" });
    expect((await put("owner", "viewer", null)).status).toBe(200);
    expect(await resolvePilotUsername(db, "viewer1")).toBeNull();
    const audit = await db.prepare("SELECT action, entity_id, details_json FROM audit_events WHERE action = 'flight_logs.username.set' ORDER BY rowid").all<{ entity_id: string; details_json: string }>();
    expect(audit.results.map(row => [row.entity_id, JSON.parse(row.details_json)])).toEqual([["viewer", { username: "viewer1", previous: null }], ["viewer", { username: null, previous: "viewer1" }]]);
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
    const missing = await request("/api/flight-logs/flights/abc");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "That flight was not found." });
    const track = await request("/api/flight-logs/flights/abc/track");
    expect(track.headers.get("Content-Encoding")).toBe("gzip");
    expect(track.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("bounds actual track stream bytes, cancels overflow and preserves importer authorization", async () => {
    const path = "/api/admin/flight-logs/imports/import-1/flights/flight-1/track";
    const calls: unknown[][] = [], request = app("owner", fakeBinding(calls));
    expect(FLIGHT_LOG_LIMITS.trackBytes).toBe(32 * 1024 * 1024);
    const original = FLIGHT_LOG_LIMITS.trackBytes;
    FLIGHT_LOG_LIMITS.trackBytes = 16;
    try {
      const headerCases: Array<Record<string, string>> = [{}, { "Content-Length": "1" }, { "Transfer-Encoding": "chunked" }];
      for (const headers of headerCases) {
        const stream = streamedTrack([new Uint8Array(8), new Uint8Array(9), new Uint8Array(1)], headers);
        const response = await request(path, stream.init);
        expect(response.status).toBe(413);
        expect(await response.json()).toEqual({ error: "This flight’s track is too large to store." });
        expect(stream.state).toEqual({ pulls: 2, cancelled: true });
      }
      expect(calls).toEqual([]);
      const denied = streamedTrack([new Uint8Array(17)]);
      expect((await app("viewer", fakeBinding(calls))(path, denied.init)).status).toBe(403);
      expect(denied.state.pulls).toBe(0);
      await denied.body.cancel();
      const early = streamedTrack([new Uint8Array(1)], { "Content-Length": "17" });
      expect((await request(path, early.init)).status).toBe(413);
      expect(early.state).toEqual({ pulls: 0, cancelled: true });
      const good = streamedTrack([new Uint8Array(8), new Uint8Array(8)]);
      expect((await request(path, good.init)).status).toBe(200);
      expect(good.state.cancelled).toBe(false);
      expect(calls).toEqual([["putTelemetry", expect.anything(), "import-1", "flight-1", 16]]);
    } finally { FLIGHT_LOG_LIMITS.trackBytes = original; }
  });
});
