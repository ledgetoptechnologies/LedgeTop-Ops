import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
import worker from "../src/worker/index";
import { listAdminAuditEvents } from "../src/worker/admin-audit";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = { id: "audit-admin", email: "admin@example.test", displayName: "Audit Admin",
  accessSubject: "audit-subject", projectAlphaUserId: null };
const other: StaffPrincipal = { ...principal, id: "other-admin", email: "other@example.test", accessSubject: "other-subject" };
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare, database: D1Database, env: Env;

async function send(path = "/api/admin/audit") {
  return worker.fetch(new Request(`https://ops.example${path}`), env, execution);
}

async function grant(actor = principal, assignment = `admin-${actor.id}`) {
  await database.batch([
    database.prepare("INSERT OR REPLACE INTO staff_users VALUES(?,?,'active')").bind(actor.id, actor.email),
    database.prepare("INSERT OR REPLACE INTO staff_role_assignments VALUES(?,?,'role-admin','global',NULL)").bind(assignment, actor.id),
    database.prepare("INSERT OR IGNORE INTO role_permissions VALUES('role-admin','audit.view')"),
  ]);
}

async function audit(input: Partial<Record<"actorType"|"actorId"|"email"|"name"|"action"|"entityType"|"entityId"|"division"|"details"|"address"|"createdAt", string | null>> = {}) {
  await database.prepare(`INSERT INTO audit_events(actor_type,actor_id,actor_email,actor_display_name,action,entity_type,
    entity_id,division_id,details_json,client_address_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).bind(
    input.actorType ?? "staff", input.actorId ?? "alice-id", input.email ?? "alice@example.test", input.name ?? "Alice Operator",
    input.action ?? "delivery.share.created", input.entityType ?? "folder", input.entityId ?? "folder-one", input.division ?? "division-one",
    input.details ?? '{"secret":"never-return"}', input.address ?? "private-address-hash", input.createdAt ?? "2026-08-20T12:00:00.000Z").run();
}

describe("bounded global Operations audit route", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-08-06",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    database = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await database.exec(`
      CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,status TEXT);
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT,PRIMARY KEY(role_id,permission_key));
      CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT,actor_type TEXT,actor_id TEXT,actor_email TEXT,
        actor_display_name TEXT,action TEXT,entity_type TEXT,entity_id TEXT,division_id TEXT,details_json TEXT,
        client_address_hash TEXT,created_at TEXT);
    `.replace(/\s*\n\s*/gu, " "));
    env = { OPS_DB: database, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", PUBLIC_BASE_URL: "https://ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_BASE_URL: "https://incoming.example",
      OPERATIONS_SESSION_SECRET: "admin-audit-session-secret-at-least-32-bytes" } as unknown as Env;
  });

  beforeEach(async () => {
    await database.batch(["audit_events", "staff_permission_overrides", "staff_role_assignments", "local_staff_role_assignments",
      "role_permissions", "staff_users"].map(table => database.prepare(`DELETE FROM ${table}`)));
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    await grant();
  });

  afterAll(async () => { await runtime?.dispose(); });

  it("requires administrator membership and a current global audit.view grant, honoring explicit deny", async () => {
    await database.prepare("DELETE FROM staff_role_assignments").run();
    await database.prepare("INSERT INTO staff_permission_overrides VALUES('allow',?,'audit.view','allow','global',NULL)").bind(principal.id).run();
    expect((await send()).status).toBe(403);
    await grant();
    await database.prepare("INSERT INTO staff_permission_overrides VALUES('deny',?,'audit.view','deny','global',NULL)").bind(principal.id).run();
    const denied = await send();
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "Global audit.view permission required" });
  });

  it("filters populated D1 rows before LIMIT and only returns the redacted allowlist", async () => {
    for (let index = 0; index < 8; index++) await audit({ action: "role.updated", entityType: "role", entityId: `newer-${index}`,
      createdAt: `2026-08-2${index}T13:00:00.000Z` });
    await audit({ actorId: "alice-private-id", email: "alice@example.test", name: "Alice Operator", action: "delivery.share.created",
      entityType: "folder", entityId: "customer-folder", division: "division-one", details: '{"token":"super-secret"}',
      address: "secret-address", createdAt: "2026-08-15T12:00:00.000Z" });
    await audit({ actorId: "bob", email: "bob@example.test", action: "delivery.share.failed", entityId: "customer-folder",
      division: "division-two", createdAt: "2026-08-14T12:00:00.000Z" });
    const response = await send("/api/admin/audit?actor=alice&category=delivery&entity=customer&division=division-one&result=succeeded&from=2026-08-01&to=2026-08-20&limit=1");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.events).toEqual([expect.objectContaining({ action: "delivery.share.created", category: "delivery",
      resource: { type: "folder", id: "customer-folder" }, divisionId: "division-one", result: "succeeded" })]);
    expect(JSON.stringify(body)).not.toMatch(/super-secret|secret-address|details_json|client_address_hash|token/i);
    const exactAction = await (await send("/api/admin/audit?action=delivery.share.failed&result=failed&division=division-two")).json() as any;
    expect(exactAction.events.map((item: any) => item.actor.email)).toEqual(["bob@example.test"]);
  });

  it("paginates deterministically inside an immutable high-water snapshot", async () => {
    for (const [index, time] of ["12", "11", "10"].entries()) await audit({ entityId: `original-${index}`,
      createdAt: `2026-08-20T${time}:00:00.000Z` });
    const firstResponse = await send("/api/admin/audit?limit=2");
    const first = await firstResponse.json() as any;
    expect(first.events.map((item: any) => item.resource.id)).toEqual(["original-0", "original-1"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    await audit({ entityId: "arrived-later", createdAt: "2026-08-21T15:00:00.000Z" });
    const secondResponse = await send(`/api/admin/audit?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`);
    const second = await secondResponse.json() as any;
    expect(second.highWaterId).toBe(first.highWaterId);
    expect(second.events.map((item: any) => item.resource.id)).toEqual(["original-2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("excludes explicitly denied divisions on initial and cursor pages and invalidates a cursor when denies change", async () => {
    await database.prepare("INSERT INTO staff_permission_overrides VALUES('deny-secret',?,'audit.view','deny','division','division-secret')").bind(principal.id).run();
    await audit({ entityId: "visible-new", division: "division-one", createdAt: "2026-08-20T14:00:00.000Z" });
    await audit({ entityId: "secret-new", division: "division-secret", createdAt: "2026-08-20T13:00:00.000Z" });
    await audit({ entityId: "unscoped", division: null, createdAt: "2026-08-20T12:00:00.000Z" });
    await audit({ entityId: "secret-old", division: "division-secret", createdAt: "2026-08-20T11:00:00.000Z" });
    await audit({ entityId: "visible-old", division: "division-two", createdAt: "2026-08-20T10:00:00.000Z" });
    const first = await (await send("/api/admin/audit?limit=2")).json() as any;
    expect(first.events.map((item: any) => item.resource.id)).toEqual(["visible-new", "unscoped"]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await (await send(`/api/admin/audit?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).json() as any;
    expect(second.events.map((item: any) => item.resource.id)).toEqual(["visible-old"]);
    expect(second.nextCursor).toBeNull();
    expect((await (await send("/api/admin/audit?division=division-secret")).json() as any).events).toEqual([]);

    await database.prepare("INSERT INTO staff_permission_overrides VALUES('deny-two',?,'audit.view','deny','division','division-two')").bind(principal.id).run();
    expect((await send(`/api/admin/audit?limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
  });

  it("binds cursors to actor, exact filters, page size, and current permission proof", async () => {
    for (let index = 0; index < 3; index++) await audit({ entityId: `cursor-${index}`, createdAt: `2026-08-20T1${index}:00:00.000Z` });
    const first = await (await send("/api/admin/audit?category=delivery&limit=1")).json() as any;
    expect((await send(`/api/admin/audit?category=role&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
    expect((await send(`/api/admin/audit?category=delivery&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
    await grant(other);
    mocks.authenticateStaff.mockResolvedValue(other);
    expect((await send(`/api/admin/audit?category=delivery&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(400);
    mocks.authenticateStaff.mockResolvedValue(principal);
    await database.prepare("INSERT INTO staff_permission_overrides VALUES('division-extra',?,'audit.view','allow','division','division-extra')").bind(principal.id).run();
    expect((await send(`/api/admin/audit?category=delivery&limit=1&cursor=${encodeURIComponent(first.nextCursor)}`)).status).toBe(409);
  });

  it("rejects malformed cursors and filters, skips malformed rows, and handles an empty result", async () => {
    expect((await send("/api/admin/audit?cursor=not-a-cursor")).status).toBe(400);
    expect((await send("/api/admin/audit?limit=101")).status).toBe(400);
    expect((await send("/api/admin/audit?from=2026-09-01&to=2026-08-01")).status).toBe(400);
    expect((await send("/api/admin/audit?from=2026-02-30")).status).toBe(400);
    expect((await send("/api/admin/audit?result=maybe")).status).toBe(400);
    expect((await send("/api/admin/audit?action=no.matches")).status).toBe(200);
    expect(await (await send("/api/admin/audit?action=no.matches")).json()).toMatchObject({ events: [], nextCursor: null });
    await audit({ action: "x".repeat(300), createdAt: "2026-08-20T14:00:00.000Z" });
    await audit({ action: "delivery.share.created", createdAt: "2026-08-20T13:00:00.000Z" });
    const result = await (await send("/api/admin/audit?limit=2")).json() as any;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].action).toBe("delivery.share.created");
  });

  it("does not turn a storage failure into a successful empty response", async () => {
    const broken = { ...env, OPS_DB: { withSession: () => ({ prepare: () => { throw new Error("audit store unavailable"); } }) } } as unknown as Env;
    await expect(listAdminAuditEvents(broken, principal)).rejects.toThrow("audit store unavailable");
  });
});
