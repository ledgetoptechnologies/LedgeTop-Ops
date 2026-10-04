import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ scope: vi.fn(), native: vi.fn(), audit: vi.fn(), batch: vi.fn(), first: vi.fn() }));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.native }));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import { registerStagingDirectoryOwnerViewGrantRoute, STAGING_DIRECTORY_OWNER_VIEW_GRANT_ROUTE } from "../src/worker/staging-directory-owner-view-grant";

const owner: StaffPrincipal = { id: "staff-beau-koltz", email: "owner@example.test", displayName: "Owner", accessSubject: "verified-subject", projectAlphaUserId: null };
const commandId = "11111111-1111-4111-8111-111111111111";
function fixture(options: { staging?: boolean; enabled?: boolean; admin?: boolean; actor?: StaffPrincipal } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", options.actor ?? owner); c.set("administrator", options.admin ?? true); await next(); });
  registerStagingDirectoryOwnerViewGrantRoute(app);
  const env = { ENVIRONMENT: options.staging === false ? "production" : "staging",
    STAGING_DIRECTORY_PROFILE_VIEW_GRANT_ENABLED: options.enabled === false ? "false" : "true",
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "0123456789abcdef", EXPECTED_HOST: "ops-staging.ledgetopdroneservices.com",
    OPS_DB: { prepare: vi.fn((query: string) => ({ sql: query, bind: vi.fn((...values: unknown[]) => ({ sql: query, values, first: () => mocks.first(query) })) })), batch: mocks.batch } } as unknown as Env;
  const send = () => app.request(`https://ops-staging.ledgetopdroneservices.com${STAGING_DIRECTORY_OWNER_VIEW_GRANT_ROUTE}`, {
    method: "POST", headers: { Origin: "https://ops-staging.ledgetopdroneservices.com", "Content-Type": "application/json", "X-CSRF-Token": "middleware-tested", "Idempotency-Key": commandId },
    body: JSON.stringify({ confirm: true }),
  }, env);
  return { send, env };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.native.mockResolvedValue({ identity: { staffId: owner.id, email: owner.email, verifiedAccessSubject: owner.accessSubject, profileVersion: 1 }, admissionVersion: 19, verifiedUntil: "2099-01-01T00:00:00.000Z" });
  mocks.audit.mockResolvedValue({ kind: "audit statement" });
  mocks.first.mockImplementation(async (query: string) => query.includes("staff_role_assignments") ? { ok: 1 } : null);
  mocks.batch.mockResolvedValue([{ meta: { changes: 1 } }, { meta: { changes: 1 } }]);
});

describe("staging protected-owner Directory profile-view grant", () => {
  it("is staging-only and default-off", async () => {
    expect((await fixture({ enabled: false }).send()).status).toBe(404);
    expect((await fixture({ staging: false }).send()).status).toBe(404);
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("requires the exact protected owner, administrator, native identity and non-denied management scope", async () => {
    expect((await fixture({ admin: false }).send()).status).toBe(403);
    expect((await fixture({ actor: { ...owner, id: "other-admin" } }).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    mocks.native.mockResolvedValueOnce({ identity: { staffId: owner.id, email: owner.email, verifiedAccessSubject: "forged" }, admissionVersion: 19 });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.batch).not.toHaveBeenCalled();
  });
  it("creates exactly global profile-view authority and atomically audits the grant", async () => {
    const response = await fixture().send();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "granted", permission: "directory.profile.view", scope: "global" });
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    const [grant, audit] = mocks.batch.mock.calls[0]![0] as Array<{ sql?: string; values?: unknown[] }>;
    expect(grant?.sql).toContain("directory.profile.view");
    expect(grant?.sql).toContain("'allow','global',1");
    expect(grant?.sql).toContain("role-owner");
    expect(grant?.sql).toContain("native_staff_admissions");
    expect(JSON.stringify(grant?.values)).toContain(owner.id);
    expect(audit).toEqual({ kind: "audit statement" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.anything(), owner,
      "staging.directory_owner_profile_view_grant_command", "native_directory_grant_command", commandId, null,
      { permission: "directory.profile.view", effect: "allow", scope: "global", operation: "ensure" });
  });
  it("does not create a grant when a deny exists and safely handles retry after success", async () => {
    mocks.first.mockImplementation(async (query: string) => query.includes("staff_role_assignments") ? { ok: 1 }
      : query.includes("effect='deny'") ? { ok: 1 } : null);
    expect((await fixture().send()).status).toBe(409);
    expect(mocks.batch).not.toHaveBeenCalled();
    mocks.first.mockImplementation(async (query: string) => query.includes("staff_role_assignments") ? { ok: 1 }
      : query.includes("SELECT id FROM native_directory_grants") ? { id: "existing" } : null);
    const response = await fixture().send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "already_granted", permission: "directory.profile.view", scope: "global" });
    expect(mocks.batch).not.toHaveBeenCalled();
  });
});
