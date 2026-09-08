import { readFileSync, readdirSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";
import { splitD1MigrationStatements } from "../../client/test/helpers/d1-migrations";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
import worker, { projectAlphaProjectionApiRequest } from "../src/worker/index";
import { csrfToken } from "../src/worker/request-security";
import { assertProjectAlphaConnectorStateTransition, registerProjectAlphaConnector } from "../src/worker/project-alpha-connectors";
import type { Env, StaffPrincipal } from "../src/worker/types";

const ROOT = "/api/admin/integrations/project-alpha/connectors";
const primary = "project-alpha:primary";
const secondary = "project-alpha:ltt";
const principal: StaffPrincipal = { id: "registry-route-admin", email: "registry-admin@example.test", displayName: "Registry administrator", accessSubject: "verified-admin-subject", projectAlphaUserId: null };
const executionCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const publicKey = (seed: number) => btoa(String.fromCharCode(...new Uint8Array(32).fill(seed))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
const revision = { credentialRef: "primary", snapshotBasePath: "/", accessIssuer: "https://access.example.test", accessAudience: "receiver-audience", accessSubject: "producer-service-token" };
let runtime: Miniflare, db: D1Database, env: Env;

async function send(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  const defaults: Record<string, string> = method === "GET" ? {} : { Origin: "https://ops.example", "Content-Type": "application/json", "X-CSRF-Token": await csrfToken(env, principal) };
  return worker.fetch(new Request(`https://ops.example${path}`, { method, headers: { ...defaults, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), env, executionCtx);
}

async function counts() {
  return {
    connectors: await db.prepare("SELECT count(*) total FROM pa_connectors").first<number>("total"),
    revisions: await db.prepare("SELECT count(*) total FROM pa_connector_revisions").first<number>("total"),
    audit: await db.prepare("SELECT count(*) total FROM pa_connector_audit").first<number>("total"),
  };
}

describe("Project Alpha deployment-owned connector administration boundary", { timeout: 60_000, concurrent: false }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22", script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as D1Database;
    const directory = new URL("../migrations/", import.meta.url);
    for (const name of readdirSync(directory).filter(name => /^\d{4}_.*\.sql$/.test(name) && name.slice(0, 4) <= "0046").sort())
      await db.batch(splitD1MigrationStatements(readFileSync(new URL(name, directory), "utf8")).map(sql => db.prepare(sql)));
    await db.batch([
      db.prepare("INSERT INTO staff_users(id,email,display_name,status) VALUES(?,?,?,'active')").bind(principal.id, principal.email, principal.displayName),
      db.prepare("INSERT INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('registry-route-admin-role',?,'role-admin','global','global')").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin','integrations.manage')"),
    ]);
    env = { OPS_DB: db, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example", PUBLIC_BASE_URL: "https://ops.example",
      OPERATIONS_SESSION_SECRET: "fixture-session-secret-at-least-32-characters", AUDIT_IP_SECRET: "fixture-audit-secret-at-least-32-characters", APPLICATION_KEY: "ltds_ops",
      PROJECT_ALPHA_BASE_URL: "https://primary.example.test", PROJECT_ALPHA_API_KEY: "private-primary-snapshot-key",
      PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY: publicKey(1), PROJECT_ALPHA_CONNECTOR_CREDENTIALS: JSON.stringify({ version: 1, sets: {
        primary: { snapshotApiKey: "private-primary-snapshot-key", eventCurrent: { keyId: "primary", algorithm: "ed25519", value: publicKey(1) } },
        ltt: { snapshotApiKey: "private-ltt-snapshot-key", eventCurrent: { keyId: "ltt", algorithm: "ed25519", value: publicKey(2) } },
      } }) } as unknown as Env;
    await registerProjectAlphaConnector(env, { sourceId: primary, producerBindingId: "primary-producer", snapshotOrigin: "https://primary.example.test",
      applicationKey: "ltds_ops", profile: "primary_legacy", displayName: "Primary", revision }, principal.id);
    await db.prepare("UPDATE pa_connectors SET state='active',version=version+1 WHERE source_id=?").bind(primary).run();
    await registerProjectAlphaConnector(env, { sourceId: secondary, producerBindingId: "ltt-producer", snapshotOrigin: "https://ltt.example.test",
      applicationKey: "ltds_ops", profile: "business_data", displayName: "LTT", revision: { ...revision, credentialRef: "ltt" } }, principal.id);
  });
  beforeEach(async () => {
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    await db.batch([
      db.prepare("DELETE FROM staff_permission_overrides WHERE staff_id=?").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO staff_role_assignments(id,staff_id,role_id,scope,scope_key) VALUES('registry-route-admin-role',?,'role-admin','global','global')").bind(principal.id),
      db.prepare("INSERT OR IGNORE INTO role_permissions(role_id,permission_key) VALUES('role-admin','integrations.manage')"),
    ]);
  });
  afterAll(async () => { await runtime?.dispose(); });

  it("keeps retired connector transitions terminal in the underlying deployment primitive", () => {
    expect(() => assertProjectAlphaConnectorStateTransition("retired", "active")).toThrow(/retired/i);
    expect(() => assertProjectAlphaConnectorStateTransition("retired", "suspended")).toThrow(/retired/i);
    expect(() => assertProjectAlphaConnectorStateTransition("retired", "pending")).toThrow(/retired/i);
    expect(() => assertProjectAlphaConnectorStateTransition("retired", "retired")).not.toThrow();
  });

  it("contains connector reconciliation to Project Alpha projection APIs", async () => {
    expect(projectAlphaProjectionApiRequest("/api/client-hub")).toBe(true);
    expect(projectAlphaProjectionApiRequest("/api/delivery/native-grants/audiences")).toBe(true);
    expect(projectAlphaProjectionApiRequest("/api/viewer/native-client-grants")).toBe(true);
    expect(projectAlphaProjectionApiRequest("/api/team/staff/member-1/assigned-work")).toBe(true);
    for (const path of ["/api/session", "/api/airspace/tfrs", "/api/delivery/folders", "/api/team/staff", "/api/admin/roles"])
      expect(projectAlphaProjectionApiRequest(path)).toBe(false);

    const priorManifest = env.PROJECT_ALPHA_CONNECTOR_SOURCES;
    const priorRequired = env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED;
    env.PROJECT_ALPHA_CONNECTOR_SOURCES = "{malformed";
    env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED = "true";
    try {
      expect((await send("/api/admin/roles")).status).toBe(200);
      expect((await send(ROOT)).status).toBe(503);
      expect((await send("/api/viewer/native-client-grants")).status).toBe(503);
    } finally {
      env.PROJECT_ALPHA_CONNECTOR_SOURCES = priorManifest;
      env.PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED = priorRequired;
    }
  });

  it("requires authenticated administrator authority for status", async () => {
    mocks.authenticateStaff.mockRejectedValue(new HTTPException(401, { message: "Authentication required" }));
    expect((await send(ROOT)).status).toBe(401);
    mocks.authenticateStaff.mockResolvedValue(principal);
    await db.prepare("DELETE FROM staff_role_assignments WHERE id='registry-route-admin-role'").run();
    expect((await send(ROOT)).status).toBe(403);
  });

  it("honors a global deny for status, sync, reviewed project routing, and portal-purpose actions", async () => {
    await db.prepare("INSERT INTO staff_permission_overrides(id,staff_id,permission_key,effect,scope,scope_key,created_by) VALUES('registry-deny',?,'integrations.manage','deny','global','global',?)").bind(principal.id, principal.id).run();
    expect((await send(ROOT)).status).toBe(403);
    expect((await send(`${ROOT}/${encodeURIComponent(primary)}/sync`, "POST", {})).status).toBe(403);
    expect((await send(`${ROOT}/${encodeURIComponent(primary)}/project-management`, "PUT", {})).status).toBe(403);
    expect((await send(`${ROOT}/${encodeURIComponent(secondary)}/portal`, "POST", {
      expectedVersion: 1, expectedPortalVersion: null, action: "configure",
    })).status).toBe(403);
    expect((await send(`${ROOT}/recover-portal-update`, "POST", { expectedVersion: 1 })).status).toBe(403);
  });

  it("does not expose browser source-registration, revision, or state mutations", async () => {
    const before = await counts();
    const removed: Array<[string, string, unknown]> = [
      [ROOT, "POST", {}], [`${ROOT}/primary-preflight`, "POST", {}], [`${ROOT}/${encodeURIComponent(primary)}`, "PATCH", {}],
      [`${ROOT}/${encodeURIComponent(primary)}/revisions`, "POST", {}],
    ];
    for (const [path, method, body] of removed) expect((await send(path, method, body)).status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("exposes only the strict portal-purpose action for a deployment-owned source", async () => {
    const path = `${ROOT}/${encodeURIComponent(secondary)}/portal`;
    // The fixture intentionally lacks the paired Delivery schema, so a valid
    // configure request must fail closed as unavailable—not as an unguarded
    // source-registration mutation or a route miss.
    expect((await send(path, "POST", {
      expectedVersion: 1, expectedPortalVersion: null, action: "configure",
    })).status).toBe(503);
    for (const body of [
      { expectedVersion: 1, expectedPortalVersion: null, action: "activate" },
      { expectedVersion: 1, expectedPortalVersion: null, action: "configure", credentialRef: "browser-secret" },
      { expectedVersion: 1, expectedPortalVersion: null, action: "configure", sourceId: "project-alpha:other" },
    ]) expect((await send(path, "POST", body)).status).toBe(400);
    expect((await send(`${ROOT}/${encodeURIComponent("project-alpha:unconfigured")}/portal`, "POST", {
      expectedVersion: 1, expectedPortalVersion: null, action: "configure",
    })).status).toBe(404);
    expect((await send(`${ROOT}/recover-portal-update`, "POST", { expectedVersion: 1, actorId: "spoofed" })).status).toBe(400);
  });

  it("returns a bounded no-store status summary without credentials", async () => {
    const response = await send(ROOT);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const text = await response.text();
    expect(text).toContain(primary);
    for (const privateValue of ["private-primary-snapshot-key", publicKey(1), "credentialRef", "accessSubject", "current_key_fingerprint"])
      expect(text).not.toContain(privateValue);
  });

  it("requires strict empty JSON for an explicit synchronization request", async () => {
    expect((await send(`${ROOT}/${encodeURIComponent(primary)}/sync`, "POST", { sourceId: "project-alpha:another" })).status).toBe(400);
  });

  it("keeps the reviewed HTTPS project-management route with optimistic idempotent revisions", async () => {
    const path = `${ROOT}/${encodeURIComponent(primary)}/project-management`;
    const request = { expectedConnectorVersion: 2, expectedVersion: null, idempotencyKey: "route-operation-key-0001", reviewedUrlTemplate: "https://alpha.example.test/clients/{recordId}/projects/new" };
    const created = await send(path, "PUT", request);
    expect(created.status).toBe(200);
    expect((await created.json() as { projectManagement: Record<string, unknown> }).projectManagement).toMatchObject({ sourceId: primary, version: 1, revision: 1, enabled: true, replayed: false });
    const replay = await send(path, "PUT", request);
    expect(replay.status).toBe(200);
    expect((await replay.json() as { projectManagement: { replayed: boolean } }).projectManagement.replayed).toBe(true);
    expect((await send(path, "PUT", { ...request, reviewedUrlTemplate: "https://other.example.test/projects" })).status).toBe(409);
  });

  it("rejects unsafe project destinations and browser-supplied source authority", async () => {
    const path = `${ROOT}/${encodeURIComponent(primary)}/project-management`;
    const base = { expectedConnectorVersion: 2, expectedVersion: 1, idempotencyKey: "route-operation-key-safe-base", reviewedUrlTemplate: "https://alpha.example.test/projects" };
    for (const reviewedUrlTemplate of ["http://alpha.example.test/projects", "https://user:secret@alpha.example.test/projects", "https://alpha.example.test/projects?token=secret", "https://alpha.example.test/projects#fragment", "https://alpha.example.test/clients/prefix-{recordId}/projects", "https://alpha.example.test/clients/{recordId}/{recordId}"])
      expect((await send(path, "PUT", { ...base, idempotencyKey: `unsafe-${crypto.randomUUID()}`, reviewedUrlTemplate })).status).toBe(400);
    expect((await send(path, "PUT", { ...base, credentialRef: "browser-secret" })).status).toBe(400);
  });
});
