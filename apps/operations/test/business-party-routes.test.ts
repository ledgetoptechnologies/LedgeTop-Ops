import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";
import { registerVisibleTestSource } from "./helpers/project-alpha-connectors";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
import worker from "../src/worker/index";
import { csrfToken } from "../src/worker/request-security";
import { createProjectAlphaSourceContext, prepareProjectAlphaSourceRecords } from "../src/worker/project-alpha-source";
import type { BusinessPartyOperation, BusinessPartyPreview } from "../src/worker/business-parties";
import type { Env, StaffPrincipal } from "../src/worker/types";

const ROOT = "/api/business-parties";
const primary = "project-alpha:primary", secondary = "project-alpha:secondary-party-http";
const principal: StaffPrincipal = { id: "party-route-admin", email: "party-admin@example.test", displayName: "Party administrator",
  accessSubject: "verified-party-admin", projectAlphaUserId: null };
// These routes do not use platform-only execution context members.
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare, db: D1Database, env: Env, sequence = 0;

async function send(path: string, options: { method?: string; body?: unknown; raw?: BodyInit; headers?: Record<string, string> } = {}) {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = method === "GET" ? {} : {
    Origin: "https://ops.example", "Content-Type": "application/json", "X-CSRF-Token": await csrfToken(env, principal),
  };
  const payload = options.raw ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return worker.fetch(new Request(`https://ops.example${path}`, { method, headers: { ...headers, ...options.headers },
    ...(payload === undefined ? {} : { body: payload }) }), env, execution);
}
async function counts() {
  const rows = await db.batch<{ count: number }>(["business_parties", "business_party_links", "business_party_events", "business_party_mutations"]
    .map(table => db.prepare(`SELECT count(*) count FROM ${table}`)));
  return rows.map(row => row.results[0]!.count);
}
async function operation(): Promise<Extract<BusinessPartyOperation, { action: "create" }>> {
  const externalId = `party-route-${++sequence}`;
  const roots = [];
  for (const sourceId of [primary, secondary]) {
    const mapping = await prepareProjectAlphaSourceRecords(db, createProjectAlphaSourceContext(sourceId), [{ kind: "organization", externalId }]);
    const id = mapping.get("organization", externalId);
    await db.prepare(`INSERT INTO pa_organizations(id,name,active,payload_json,last_sync_id,projection_source_id)
      VALUES(?,?,1,'{}','party-http-fixture',?)`).bind(id, `${sourceId === primary ? "Primary" : "Secondary"} organization ${sequence}`, sourceId).run();
    roots.push({ sourceId, kind: "organization" as const, recordId: id });
  }
  return { action: "create", displayName: `Explicit customer ${sequence}`, roots };
}
const mutation = (value: BusinessPartyOperation, context = "0".repeat(64)) => ({ operation: value, previewContextVersion: context,
  idempotencyKey: `party-http-${crypto.randomUUID()}` });
async function savedParty() {
  const value = await operation(), before = await counts();
  const response = await send(`${ROOT}/preview`, { method: "POST", body: value });
  expect(response.status).toBe(200);
  const { preview } = await response.json() as { preview: BusinessPartyPreview };
  expect(await counts()).toEqual(before);
  const input = mutation(value, preview.contextVersion);
  const written = await send(ROOT, { method: "POST", body: input });
  expect(written.status).toBe(200);
  const result = await written.json() as { partyId: string; version: number; status: string; replayed: boolean };
  return { value, preview, input, result };
}

describe("business-party Operations HTTP boundary", () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= "0036").sort()) {
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    }
    await db.batch(splitD1MigrationStatements(readFileSync(new URL("0048_business_party_lifecycle.sql", directory), "utf8"))
      .map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(principal.id, principal.email, principal.displayName),
      db.prepare("INSERT INTO divisions(id,name,code) VALUES('party-route-division','Party fixture division','party-route-division')"),
    ]);
    await registerVisibleTestSource(db, primary, "Primary company");
    await registerVisibleTestSource(db, secondary, "Second company");
    // Deliberately no Delivery, media, mail, connector credentials or queue
    // bindings: presentation linking must only use the Operations database.
    env = { OPS_DB: db, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example",
      PUBLIC_BASE_URL: "https://ops.example", OPERATIONS_SESSION_SECRET: "party-http-session-secret-at-least-32-bytes",
      AUDIT_IP_SECRET: "party-http-audit-secret-at-least-32-bytes" } as unknown as Env;
  }, 120_000);
  beforeEach(async () => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    await db.batch([
      db.prepare("UPDATE staff_users SET status='active' WHERE id=?").bind(principal.id),
      db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('party-route-role',?,'role-admin','global','global')").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin','team.view'),('role-admin','team.manage')"),
    ]);
  });
  afterAll(async () => { await runtime?.dispose(); });

  it("rejects unauthenticated reads, previews and writes without changing business links", async () => {
    const value = await operation(), before = await counts();
    mocks.authenticateStaff.mockRejectedValue(new HTTPException(401, { message: "Authentication required" }));
    expect((await send(`${ROOT}/unknown`)).status).toBe(401);
    expect((await send(`${ROOT}/preview`, { method: "POST", body: value })).status).toBe(401);
    expect((await send(ROOT, { method: "POST", body: mutation(value) })).status).toBe(401);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("requires administrator membership even when the actor has both global team permissions", async () => {
    const value = await operation(), before = await counts();
    await db.batch([
      db.prepare("DELETE FROM staff_role_assignments WHERE id='party-route-role'"),
      ...["team.view", "team.manage"].map(permission => db.prepare(`INSERT INTO staff_permission_overrides
        (id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES(?,?,?,'allow','global','global',?)`)
        .bind(`party-allow-${permission}`, principal.id, permission, principal.id)),
    ]);
    expect((await send(`${ROOT}/preview`, { method: "POST", body: value })).status).toBe(403);
    expect((await send(ROOT, { method: "POST", body: mutation(value) })).status).toBe(403);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it.each(["team.view", "team.manage"] as const)("honors a global %s deny on preview and save", async permission => {
    const saved = await savedParty(), value = await operation(), before = await counts();
    await db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by)
      VALUES('party-deny',?,?,'deny','global','global',?)`).bind(principal.id, permission, principal.id).run();
    expect((await send(`${ROOT}/preview`, { method: "POST", body: value })).status).toBe(403);
    expect((await send(ROOT, { method: "POST", body: mutation(value) })).status).toBe(403);
    const read = await send(`${ROOT}/${saved.result.partyId}`);
    expect(read.status).toBe(permission === "team.view" ? 403 : 200);
    if (permission === "team.manage") expect(await read.json()).toMatchObject({ party: { canManage: false } });
    expect(await counts()).toEqual(before);
  }, 30_000);

  it.each(["team.view", "team.manage"] as const)("does not promote division-scoped %s into global linking authority", async permission => {
    const value = await operation(), before = await counts();
    await db.batch([
      db.prepare("DELETE FROM role_permissions WHERE role_id='role-admin' AND permission_key=?").bind(permission),
      db.prepare(`INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,division_id,scope_key,created_by)
        VALUES('party-division',?,?,'allow','division','party-route-division','party-route-division',?)`).bind(principal.id, permission, principal.id),
    ]);
    expect((await send(`${ROOT}/preview`, { method: "POST", body: value })).status).toBe(403);
    expect((await send(ROOT, { method: "POST", body: mutation(value) })).status).toBe(403);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("rejects inactive staff even if the authentication adapter still returns the old principal", async () => {
    const value = await operation(), before = await counts();
    await db.prepare("UPDATE staff_users SET status='inactive' WHERE id=?").bind(principal.id).run();
    expect((await send(`${ROOT}/unknown`)).status).toBe(403);
    expect((await send(`${ROOT}/preview`, { method: "POST", body: value })).status).toBe(403);
    expect((await send(ROOT, { method: "POST", body: mutation(value) })).status).toBe(403);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it.each<Record<string, string>>([{ Origin: "https://untrusted.example" }, { "X-CSRF-Token": "" }])(
    "enforces real origin and CSRF checks for preview and mutation: %j", async headers => {
      const value = await operation(), before = await counts();
      expect((await send(`${ROOT}/preview`, { method: "POST", body: value, headers })).status).toBe(403);
      expect((await send(ROOT, { method: "POST", body: mutation(value), headers })).status).toBe(403);
      expect(await counts()).toEqual(before);
    }, 30_000);

  it("rejects malformed, missing, non-JSON and invalid UTF-8 request bodies", async () => {
    const before = await counts();
    for (const path of [`${ROOT}/preview`, ROOT]) {
      expect((await send(path, { method: "POST", raw: "{" })).status).toBe(400);
      expect((await send(path, { method: "POST" })).status).toBe(400);
      expect((await send(path, { method: "POST", raw: "{}", headers: { "Content-Type": "text/plain" } })).status).toBe(415);
      expect((await send(path, { method: "POST", raw: new Uint8Array([0xff, 0xfe]) })).status).toBe(400);
    }
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("bounds actual body bytes without trusting a smaller declared Content-Length", async () => {
    const before = await counts(), raw = JSON.stringify({ filler: "x".repeat(65 * 1024) });
    for (const path of [`${ROOT}/preview`, ROOT])
      expect((await send(path, { method: "POST", raw, headers: { "Content-Length": "2" } })).status).toBe(413);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("rejects actor spoofing and invalid operations at both strict JSON boundaries", async () => {
    const value = await operation(), input = mutation(value), before = await counts();
    for (const invalid of [{ ...value, actorId: "other-actor" }, { ...value, action: "merge" },
      { ...value, roots: [{ ...value.roots[0], sourceId: "delivery:local" }, value.roots[1]] }])
      expect((await send(`${ROOT}/preview`, { method: "POST", body: invalid })).status).toBe(400);
    for (const invalid of [{ ...input, actorId: "other-actor" }, { ...input, operation: { ...value, actorId: "other-actor" } },
      { ...input, operation: { ...value, action: "merge" } }, { operation: value }])
      expect((await send(ROOT, { method: "POST", body: invalid })).status).toBe(400);
    expect(await counts()).toEqual(before);
  }, 30_000);

  it("previews, saves and reads exact source records without any Delivery binding or authority union", async () => {
    const { value, preview, input, result } = await savedParty();
    expect("DELIVERY_DB" in env).toBe(false);
    expect(preview.members.map(member => member.root)).toEqual(value.roots);
    expect(result).toMatchObject({ version: 1, status: "active", replayed: false });
    const response = await send(`${ROOT}/${result.partyId}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const body = await response.json() as { party: { members: Array<{ root: unknown; detailPath: string }>; displayName: string; canManage: boolean } };
    expect(body.party).toMatchObject({ displayName: value.displayName, canManage: true });
    expect(body.party.members.map(member => member.root)).toEqual(value.roots);
    for (const [index, member] of body.party.members.entries()) expect(member.detailPath)
      .toBe(`/clients/sources/${encodeURIComponent(value.roots[index]!.sourceId)}/business/organizations/${encodeURIComponent(value.roots[index]!.recordId)}`);
    const before = await counts();
    const replay = await send(ROOT, { method: "POST", body: input });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ ...result, replayed: true });
    expect(await counts()).toEqual(before);
    expect(await db.prepare("SELECT actor_id,action FROM business_party_events WHERE party_id=?").bind(result.partyId).first())
      .toEqual({ actor_id: principal.id, action: "create" });
    expect(await db.prepare("SELECT created_by FROM business_parties WHERE id=?").bind(result.partyId).first("created_by")).toBe(principal.id);
    expect((await db.prepare("SELECT linked_by FROM business_party_links WHERE party_id=?").bind(result.partyId).all()).results)
      .toEqual([{ linked_by: principal.id }, { linked_by: principal.id }]);
  }, 30_000);
});
