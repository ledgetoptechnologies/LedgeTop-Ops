import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Miniflare } from "miniflare";
import { HTTPException } from "hono/http-exception";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn(), status: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/delivery-change-recovery-status", () => ({ deliveryChangeRecoveryStatus: mocks.status }));

import worker from "../src/worker/index";
import type { Env, StaffPrincipal } from "../src/worker/types";

const principal: StaffPrincipal = {
  id: "recovery-status-admin", email: "admin@example.test", displayName: "Recovery status admin",
  accessSubject: "recovery-status-subject", projectAlphaUserId: null,
};
const execution = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
let runtime: Miniflare, db: D1Database, env: Env;

async function send() {
  return worker.fetch(new Request("https://ops.example/api/admin/delivery-change-recovery"), env, execution);
}

async function grantGlobal() {
  await db.batch([
    db.prepare("INSERT OR REPLACE INTO staff_users VALUES(?,?,'active')").bind(principal.id, principal.email),
    db.prepare("INSERT OR REPLACE INTO staff_role_assignments VALUES(?,?,'role-admin','global',NULL)").bind("recovery-admin-role", principal.id),
    db.prepare("INSERT OR IGNORE INTO role_permissions VALUES('role-admin','integrations.manage')"),
  ]);
}

describe("delivery-change recovery status route", { timeout: 60_000 }, () => {
  beforeAll(async () => {
    runtime = new Miniflare({ modules: true, compatibilityDate: "2026-07-22",
      script: "export default {fetch(){return new Response('ok')}}", d1Databases: ["OPS_DB"] });
    db = await runtime.getD1Database("OPS_DB") as unknown as D1Database;
    await db.exec(`
      CREATE TABLE staff_users(id TEXT PRIMARY KEY,email TEXT,status TEXT);
      CREATE TABLE staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE local_staff_role_assignments(id TEXT PRIMARY KEY,staff_id TEXT,role_id TEXT,scope TEXT,division_id TEXT);
      CREATE TABLE role_permissions(role_id TEXT,permission_key TEXT,PRIMARY KEY(role_id,permission_key));
      CREATE TABLE staff_permission_overrides(id TEXT PRIMARY KEY,staff_id TEXT,permission_key TEXT,effect TEXT,scope TEXT,division_id TEXT);
    `.replace(/\s*\n\s*/gu, " "));
    env = { OPS_DB: db, ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", PUBLIC_BASE_URL: "https://ops.example",
      INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_BASE_URL: "https://incoming.example",
      OPERATIONS_SESSION_SECRET: "recovery-status-session-secret-at-least-32-bytes" } as unknown as Env;
  });

  beforeEach(async () => {
    await db.batch(["staff_permission_overrides", "staff_role_assignments", "local_staff_role_assignments", "role_permissions", "staff_users"]
      .map(table => db.prepare(`DELETE FROM ${table}`)));
    mocks.authenticateStaff.mockReset().mockResolvedValue(principal);
    mocks.status.mockReset().mockResolvedValue({
      enabled: true, state: "attention", reason: null,
      counts: { pending: 1, processing: 0, completed: 0, failed: 1 },
      failures: [{ reason: "staging-failed", count: 1 }], oldestPendingAt: "2026-09-07T12:00:00.000Z", lastFailureAt: "2026-09-07T12:01:00.000Z",
    });
    await grantGlobal();
  });

  afterAll(async () => runtime?.dispose());

  it("returns the sanitized read-only aggregate only to a global administrator with integrations.manage", async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ enabled: true, state: "attention", counts: { failed: 1 } });
    expect(mocks.status).toHaveBeenCalledTimes(1);
    // Compare the binding by identity: deep inspection invokes Miniflare RPC.
    expect(mocks.status.mock.calls[0]?.[0]?.OPS_DB === db).toBe(true);
  });

  it("does not query delivery status for an unauthenticated or inactive caller", async () => {
    mocks.authenticateStaff.mockRejectedValueOnce(new HTTPException(401, { message: "Authentication required" }));
    expect((await send()).status).toBe(401);
    expect(mocks.status).not.toHaveBeenCalled();

    mocks.authenticateStaff.mockRejectedValueOnce(new HTTPException(403, { message: "Inactive staff account" }));
    expect((await send()).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });

  it("denies non-administrators, division-only grants, and explicit global deny before status lookup", async () => {
    await db.batch([
      db.prepare("DELETE FROM staff_role_assignments"),
      db.prepare("INSERT INTO staff_permission_overrides VALUES('global-allow',?,'integrations.manage','allow','global',NULL)").bind(principal.id),
    ]);
    expect((await send()).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();

    await db.prepare("DELETE FROM staff_permission_overrides").run();
    await grantGlobal();
    await db.batch([
      db.prepare("DELETE FROM role_permissions WHERE permission_key='integrations.manage'"),
      db.prepare("INSERT INTO staff_permission_overrides VALUES('division-allow',?,'integrations.manage','allow','division','division-one')").bind(principal.id),
    ]);
    expect((await send()).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();

    await grantGlobal();
    await db.prepare("INSERT INTO staff_permission_overrides VALUES('global-deny',?,'integrations.manage','deny','global',NULL)").bind(principal.id).run();
    expect((await send()).status).toBe(403);
    expect(mocks.status).not.toHaveBeenCalled();
  });
});
