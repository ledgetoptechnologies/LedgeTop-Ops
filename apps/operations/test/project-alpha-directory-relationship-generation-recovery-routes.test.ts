import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), review: vi.fn(), authorize: vi.fn(), status: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.authenticate }));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-service", () => ({
  createDirectoryRelationshipRecoveryReview: mocks.review,
  authorizeDirectoryRelationshipRecoveryReview: mocks.authorize,
}));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-status", () => ({
  readDirectoryRelationshipRecoveryStatus: mocks.status,
}));
import { registerDirectoryRelationshipGenerationRecoveryRoutes }
  from "../src/worker/project-alpha-directory-relationship-generation-recovery-routes";

const ids = { record: "client-root_42", review: "20000000-0000-4000-8000-000000000002",
  authorization: "30000000-0000-4000-8000-000000000003", successor: "40000000-0000-4000-8000-000000000004",
  predecessor: "50000000-0000-4000-8000-000000000005" };
const principal: StaffPrincipal = { id: "staff-1", email: "owner@example.test", displayName: "Owner",
  accessSubject: "subject-1", projectAlphaUserId: null };
const base = `/api/client-hub/directory/standalone-clients/${ids.record}/relationship-generation-recovery`;
const enabled = { NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "true",
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "true", TEAM_DOMAIN: "team.example.test",
  OPERATIONS_AUD: "operations", OPS_DB: {} as D1Database };

function app(environment: Partial<Env> = enabled, actor = principal, administrator = true) {
  const application = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  application.use("*", async (c, next) => { c.set("principal", actor); c.set("administrator", administrator); await next(); });
  registerDirectoryRelationshipGenerationRecoveryRoutes(application);
  return { application, environment: environment as Env };
}
function post(application: ReturnType<typeof app>["application"], environment: Env, path: string, value: unknown, headers: Record<string, string> = {}) {
  return application.request(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(value) }, environment);
}

describe("directory relationship generation recovery routes", () => {
  // Same-origin and CSRF enforcement belongs to index.ts's pre-route /api/*
  // mutation middleware. This focused app starts at the route adapter boundary;
  // index integration must retain registration behind requireMutationSecurity.
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockResolvedValue({ admissionVersion: 3, verifiedUntil: "2999-01-01T00:00:00.000Z",
      identity: { staffId: principal.id, email: principal.email, verifiedAccessSubject: principal.accessSubject, profileVersion: 4 } });
    mocks.review.mockResolvedValue({ status: "review", review: { reviewId: ids.review, recordId: ids.record,
      sourceId: "project-alpha:staging", predecessorCommandId: ids.predecessor, evidenceSha256: "a".repeat(64),
      clientRevision: "7", organizationRevision: "9", organizationRecordId: "org-1", remoteParentPublicId: null,
      observedAuthorizationGeneration: "12", expiresAt: "2026-10-10T01:00:00.000Z", privateToken: "never" } });
    mocks.authorize.mockResolvedValue({ status: "prepared", successorCommandId: ids.successor, generation: "12", replayed: false,
      privateEvidence: "never" });
    mocks.status.mockResolvedValue({ status: "prepared", sourceId: "project-alpha:staging", updatedAt: "2026-10-10T00:00:00.000Z" });
  });

  it("keeps both routes absent before authentication or database work while either gate is off", async () => {
    for (const environment of [{ ...enabled, NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED: "false" },
      { ...enabled, PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "false" }]) {
      const fixture = app(environment);
      const response = await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging" });
      expect(response.status).toBe(404);
    }
    expect(mocks.authenticate).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });

  it("creates a strict sanitized review with the exact path record and current native actor", async () => {
    const fixture = app();
    const response = await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging" });
    expect(response.status).toBe(200);
    const value = await response.json<Record<string, unknown>>();
    expect(value).toMatchObject({ status: "review", review: { reviewId: ids.review, recordId: ids.record,
      sourceId: "project-alpha:staging", remoteParentPublicId: null } });
    expect(JSON.stringify(value)).not.toContain("never");
    expect(mocks.review).toHaveBeenCalledWith(expect.anything(), { recordId: ids.record, sourceId: "project-alpha:staging" },
      { staffId: principal.id, accessSubject: principal.accessSubject, email: principal.email,
        admissionVersion: 3, profileVersion: 4, verifiedUntil: "2999-01-01T00:00:00.000Z" }, expect.any(Function));
  });

  it("requires a strict body, administrator, and exact native/principal identity", async () => {
    let fixture = app();
    expect((await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging", extra: true })).status).toBe(400);
    fixture = app(enabled, principal, false);
    expect((await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging" })).status).toBe(403);
    mocks.authenticate.mockResolvedValueOnce({ admissionVersion: 3, verifiedUntil: "2999-01-01T00:00:00.000Z",
      identity: { staffId: "other", email: principal.email, verifiedAccessSubject: principal.accessSubject, profileVersion: 4 } });
    fixture = app();
    expect((await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging" })).status).toBe(403);
  });

  it("authorizes only with an exact Idempotency-Key and returns sanitized preparation", async () => {
    const fixture = app(), request = { evidenceSha256: "a".repeat(64), authorizationId: ids.authorization,
      successorCommandId: ids.successor, reason: "Reviewed exact remote evidence" };
    expect((await post(fixture.application, fixture.environment, `${base}/reviews/${ids.review}/authorize`, request)).status).toBe(400);
    const response = await post(fixture.application, fixture.environment, `${base}/reviews/${ids.review}/authorize`, request,
      { "Idempotency-Key": ids.authorization });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "prepared", successorCommandId: ids.successor, generation: "12", replayed: false });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.anything(), { recordId: ids.record, reviewId: ids.review, ...request },
      expect.objectContaining({ staffId: principal.id, profileVersion: 4 }));
  });

  it.each([["blocked", 403], ["conflict", 409], ["uncertain", 503]] as const)("maps a sanitized %s service outcome", async (status, expected) => {
    mocks.review.mockResolvedValueOnce({ status, reason: "synthetic", privateEvidence: "never" });
    const fixture = app(), response = await post(fixture.application, fixture.environment, `${base}/reviews`, { sourceId: "project-alpha:staging" });
    expect(response.status).toBe(expected);
    expect(await response.json()).toEqual({ status, reason: "synthetic" });
  });

  it("reads sanitized server status without requiring a browser-held review ID", async () => {
    const fixture = app(), response = await fixture.application.request(`${base}/status`, {}, fixture.environment);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "prepared", sourceId: "project-alpha:staging", updatedAt: "2026-10-10T00:00:00.000Z" });
    expect(mocks.status).toHaveBeenCalledWith(expect.anything(), { recordId: ids.record }, expect.objectContaining({ staffId: principal.id }));
    expect(mocks.review).not.toHaveBeenCalled(); expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
