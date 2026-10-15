import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ native: vi.fn(), write: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.native }));
vi.mock("../src/worker/native-directory-profile-writer", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/worker/native-directory-profile-writer")>();
  return { ...actual, writeStagingEmptyEnrollmentOrganizationFixture: mocks.write };
});
import {
  NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ROUTE,
  registerNativeDirectoryStagingEmptyEnrollmentFixtureRoutes,
} from "../src/worker/native-directory-staging-empty-enrollment-fixture-routes";
import { STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID } from "../src/worker/native-directory-profile-writer";

const principal: StaffPrincipal = { id: "native-owner", email: "owner@example.test", displayName: "Owner",
  accessSubject: "owner-subject", projectAlphaUserId: null };

function database(admission: "missing" | "exact" | "consumed" | "conflict" = "missing") {
  let state = admission;
  const statement = (sql: string) => ({
    bind: (..._values: unknown[]) => statement(sql),
    first: async <T>(_column?: string): Promise<T | null> => {
      if (sql.includes("SELECT grant.id")) return { id: sql.includes("directory.enrollment.manage") ? "enrollment-grant" : "profile-grant" } as T;
      if (sql.includes("native_business_areas")) return { ok: 1 } as T;
      if (sql.includes("native_directory_create_admissions")) return (state === "exact" || state === "consumed") ? { ok: 1 } as T : null;
      return null;
    },
    run: async () => { if (sql.includes("INSERT INTO native_directory_create_admissions") && state === "missing") state = "exact"; return {}; },
  });
  return { prepare: statement, withSession: () => ({ prepare: statement }) } as unknown as D1Database;
}
function fixture(options: { enabled?: boolean; environment?: string; administrator?: boolean; admission?: "missing" | "exact" | "consumed" | "conflict" } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", options.administrator ?? true); await next(); });
  registerNativeDirectoryStagingEmptyEnrollmentFixtureRoutes(app);
  const env = { ENVIRONMENT: options.environment ?? "staging",
    NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED: options.enabled === false ? "false" : "true",
    NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID: "fixture-area", TEAM_DOMAIN: "https://team.example",
    OPERATIONS_AUD: "operations", OPS_DB: database(options.admission) } as unknown as Env;
  const send = (body: unknown = {}, headers: Record<string, string> = {}) => app.request(
    `https://ops.example${NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ROUTE}`, {
      method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID, ...headers },
      body: JSON.stringify(body),
    }, env);
  return { send };
}

describe("native staging empty-enrollment fixture route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.native.mockResolvedValue({ admissionVersion: 7, identity: { staffId: principal.id, email: principal.email,
      verifiedAccessSubject: principal.accessSubject, profileVersion: 3 } });
    mocks.write.mockResolvedValue({ status: "written", replayed: false, mutationId: STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
      recordId: "staging-native-empty-enrollment-organization-v1", kind: "organization", version: 1, commandIds: [] });
  });

  it("is hidden unless the dedicated staging flag is enabled, before native authentication", async () => {
    expect((await fixture({ enabled: false }).send()).status).toBe(404);
    expect((await fixture({ environment: "production" }).send()).status).toBe(404);
    expect(mocks.native).not.toHaveBeenCalled();
  });
  it("requires the owner, exact fixed request, and current native authority", async () => {
    expect((await fixture({ administrator: false }).send()).status).toBe(403);
    expect((await fixture().send({}, { "Idempotency-Key": "other" })).status).toBe(400);
    expect((await fixture().send({ sourceId: "project-alpha:forbidden" })).status).toBe(400);
    mocks.native.mockRejectedValueOnce(new Error("expired"));
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("creates or replays only the hard-pinned source-less organization through the dedicated writer", async () => {
    const response = await fixture().send();
    expect(response.status).toBe(200);
    expect(mocks.write).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      operation: "create", mutationId: STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID, destinations: [],
      scopes: [{ businessAreaId: "fixture-area", divisionId: null }],
    }));
    mocks.write.mockResolvedValueOnce({ status: "written", replayed: true, mutationId: STAGING_EMPTY_ENROLLMENT_FIXTURE_MUTATION_ID,
      recordId: "staging-native-empty-enrollment-organization-v1", kind: "organization", version: 1, commandIds: [] });
    await expect((await fixture({ admission: "consumed" }).send()).json()).resolves.toMatchObject({ status: "written", replayed: true, commandIds: [] });
  });
  it("reports an incompatible durable admission as a conflict without invoking the writer", async () => {
    expect((await fixture({ admission: "conflict" }).send()).status).toBe(409);
    expect(mocks.write).not.toHaveBeenCalled();
  });
  it("is mounted behind the shared /api mutation middleware, which enforces origin and CSRF", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    expect(source.indexOf("app.use(NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ROUTE")).toBeLessThan(source.indexOf("app.use(\"/api/*\""));
    expect(source.indexOf("app.use(\"/api/*\"")).toBeLessThan(source.indexOf("registerNativeDirectoryStagingEmptyEnrollmentFixtureRoutes(app)"));
    expect(source).toContain("await requireMutationSecurity(c.req.raw, c.env, principal)");
  });
});
