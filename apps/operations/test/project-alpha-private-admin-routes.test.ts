import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(), acquire: vi.fn(), activate: vi.fn(), reserve: vi.fn(), bind: vi.fn(), first: vi.fn(),
  produce: vi.fn(),
  bindingStatus: vi.fn(), bindingRefresh: vi.fn(),
  reconciliationList: vi.fn(), reconciliationAcquire: vi.fn(),
  reconciliationRecords: vi.fn(),
  reconciliationContext: vi.fn(),
}));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/project-alpha-existing-directory-acquisition-coordinator", () => ({
  acquireProjectAlphaExistingDirectoryBinding: mocks.acquire,
}));
vi.mock("../src/worker/project-alpha-existing-directory-binding-review-consumer", () => ({
  activateProjectAlphaExistingDirectoryBinding: mocks.activate,
}));
vi.mock("../src/worker/project-alpha-directory-reconciliation-review", () => ({
  listProjectAlphaDirectoryReconciliationFindings: mocks.reconciliationList,
  listProjectAlphaDirectoryReconciliationRecords: mocks.reconciliationRecords,
  readProjectAlphaDirectoryReconciliationFindingContext: mocks.reconciliationContext,
  acquireProjectAlphaDirectoryReconciliationFinding: mocks.reconciliationAcquire,
}));
vi.mock("../src/worker/project-alpha-project-adoption-review-consumer", () => ({
  reserveProjectAlphaProjectAdoptionReview: mocks.reserve,
}));
vi.mock("../src/worker/project-alpha-project-adoption-bind-consumer", () => ({
  planProjectAlphaProjectAdoptionBind: mocks.bind,
}));
vi.mock("../src/worker/project-alpha-project-adoption-review-producer", () => ({
  produceProjectAlphaProjectAdoptionReview: mocks.produce,
}));
vi.mock("../src/worker/project-alpha-project-binding-status-api-v2", () => ({
  readConfiguredProjectAlphaProjectBindingStatus: mocks.bindingStatus,
}));
vi.mock("../src/worker/project-alpha-project-binding-revision-refresh-api-v2", () => ({
  sendConfiguredProjectAlphaProjectBindingRevisionRefreshCommand: mocks.bindingRefresh,
}));

import {
  PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE,
  registerProjectAlphaPrivateAdminRoutes,
} from "../src/worker/project-alpha-private-admin-routes";

const principal: StaffPrincipal = {
  id: "staff-admin", email: "admin@example.test", displayName: "Admin",
  accessSubject: "admin-subject", projectAlphaUserId: null,
};
const reviewId = "10000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000002";
const key = "10000000-0000-4000-8000-000000000003";
const reservationId = "10000000-0000-4000-8000-000000000004";
const publicId = "a".repeat(32);

function fixture(options: { enabled?: boolean; adoptionReviewEnabled?: boolean; projectBindingRefreshEnabled?: boolean; administrator?: boolean; global?: boolean; denied?: boolean; directoryView?: boolean } = {}) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("/api/*", async (c, next) => {
    c.set("principal", principal);
    c.set("administrator", options.administrator ?? true);
    await requireMutationSecurity(c.req.raw, c.env, principal);
    await next();
  });
  registerProjectAlphaPrivateAdminRoutes(app);
  const env = {
    PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED: options.enabled === false ? "false" : "true",
    PROJECT_ALPHA_PROJECT_ADOPTION_REVIEW_ENABLED: options.adoptionReviewEnabled === true ? "true" : "false",
    PROJECT_ALPHA_PROJECT_BINDING_REVISION_REFRESH_ENABLED: options.projectBindingRefreshEnabled === true ? "true" : "false",
    OPERATIONS_SESSION_SECRET: "operations-session-secret-0123456789abcdef",
    AUDIT_IP_SECRET: "audit-ip-secret-0123456789abcdef",
    ENVIRONMENT: "staging",
    EXPECTED_HOST: "ops.example.test",
    OPERATIONS_ORIGINS: "https://ops.example.test",
    OPS_DB: { prepare: vi.fn((sql: string) => ({ bind: vi.fn(() => ({
      first: sql.includes("FROM native_directory_grants allowed")
        ? vi.fn().mockResolvedValue(options.directoryView === false ? null : { ok: 1 }) : mocks.first,
    })) })), batch: vi.fn().mockResolvedValue([]) },
  } as unknown as Env;
  mocks.first.mockResolvedValue({ admissionVersion: 3, profileVersion: 4, grantGeneration: 5 });
  mocks.scope.mockResolvedValue({ global: options.global ?? true, deniedGlobal: options.denied ?? false });
  const send = async (path: string, value: unknown, idempotencyKey: string, headers: Record<string, string> = {}) => {
    const origin = "https://ops.example.test";
    const csrf = await csrfToken(env, principal);
    return app.request(`${origin}${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin, "X-CSRF-Token": csrf,
        "Idempotency-Key": idempotencyKey, ...headers },
      body: JSON.stringify(value),
    }, env);
  };
  const get = async (path: string) => app.request(`https://ops.example.test${PROJECT_ALPHA_PRIVATE_ADMIN_ROUTE}${path}`,
    { headers: { Origin: "https://ops.example.test", "X-CSRF-Token": await csrfToken(env, principal) } }, env);
  return { send, get, env };
}

describe("private Project Alpha administrator transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.first.mockResolvedValue({ admissionVersion: 3, profileVersion: 4, grantGeneration: 5 });
    mocks.acquire.mockResolvedValue({ status: "acquired", reviewReceiptId: reviewId, commandId, acquiredReceiptId: key, replayed: false });
    mocks.activate.mockResolvedValue({ status: "activated", activationId: key, reviewItemId: reviewId, idempotencyKey: key, replayed: false });
    mocks.reserve.mockResolvedValue({ status: "reserved", reservationId, reviewItemId: reviewId, idempotencyKey: key, replayed: false });
    mocks.bind.mockResolvedValue({ status: "planned", bridgeId: key, reservationId, commandId, requestSha256: "b".repeat(64), replayed: false });
    mocks.produce.mockResolvedValue({ status: "reviewed", reviewItemId: reviewId, requestSha256: "c".repeat(64), replayed: false });
    mocks.bindingStatus.mockResolvedValue({ status: "binding_stale", httpStatus: 409, response: {
      apiVersion: "2", sourceInstanceId: "00000000-0000-4000-8000-000000000001",
      applicationId: "00000000-0000-4000-8000-000000000002", historyEpoch: "00000000-0000-4000-8000-000000000003",
      requestId: "00000000-0000-4000-8000-000000000004", error: { code: "binding_stale" }, authorizationGeneration: "7",
      binding: { externalId: "pa-project-1", publicId, revision: "2" },
      resource: { revision: "10", projectionSha256: "d".repeat(64) },
    } });
    mocks.bindingRefresh.mockResolvedValue({ status: "acknowledged", httpStatus: 200, response: {
      replayed: false, result: { resource: { revision: "10" } },
    } });
    mocks.reconciliationList.mockResolvedValue({ items: [], nextCursor: null });
    mocks.reconciliationRecords.mockResolvedValue({ items: [], nextCursor: null });
    mocks.reconciliationContext.mockResolvedValue({ findingId: reviewId, resourceType: "organization",
      displayName: "Example Organization", contactEmail: "contact@example.test", organizationPublicId: null });
    mocks.reconciliationAcquire.mockResolvedValue({ status: "acquired", actionId: key,
      findingId: reviewId, acquiredReceiptId: reservationId, replayed: false });
  });

  it("is default-off before parsing or invoking a consumer", async () => {
    const { send, get } = fixture({ enabled: false });
    expect((await send("/directory/acquire", {}, commandId)).status).toBe(404);
    expect((await get("/directory/reconciliation/findings?sourceId=project-alpha:primary")).status).toBe(404);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(mocks.reconciliationList).not.toHaveBeenCalled();
  });

  it("requires administrator and deny-aware global integrations.manage", async () => {
    expect((await fixture({ administrator: false }).send("/projects/adoption/reserve", {}, key)).status).toBe(403);
    expect((await fixture({ global: false }).send("/projects/adoption/reserve", {}, key)).status).toBe(403);
    expect((await fixture({ denied: true }).send("/projects/adoption/reserve", {}, key)).status).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("enforces same-origin and CSRF through the existing mutation middleware", async () => {
    const { send } = fixture();
    expect((await send("/projects/adoption/reserve", { reviewItemId: reviewId, idempotencyKey: key }, key,
      { Origin: "https://evil.example.test" })).status).toBe(403);
    expect((await send("/projects/adoption/reserve", { reviewItemId: reviewId, idempotencyKey: key }, key,
      { "X-CSRF-Token": "wrong" })).status).toBe(403);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("rejects actor identity and oversized/unknown input, and binds idempotency to the action", async () => {
    const { send } = fixture();
    const valid = { reviewItemId: reviewId, idempotencyKey: key };
    expect((await send("/projects/adoption/reserve", { ...valid, actor: { staffId: "attacker" } }, key)).status).toBe(400);
    expect((await send("/projects/adoption/reserve", valid, commandId)).status).toBe(400);
    expect((await send("/directory/acquire", {
      reviewId, commandId, sourceId: "project-alpha:primary", recordId: "record-1", resourceType: "organization",
      projectAlphaPublicId: publicId, expectedProjectAlphaRevision: "3", expectedAuthorizationGeneration: "7",
      localRecordVersion: 1,
    }, commandId, { "Content-Length": String(33 * 1024) })).status).toBe(413);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("derives actor and authority versions from the authenticated principal, never JSON", async () => {
    const { send } = fixture();
    const input = {
      reviewId, commandId, sourceId: "project-alpha:primary", recordId: "record-1", resourceType: "organization",
      projectAlphaPublicId: publicId, expectedProjectAlphaRevision: "3", expectedAuthorizationGeneration: "7",
      localRecordVersion: 1,
    };
    expect((await send("/directory/acquire", input, commandId)).status).toBe(200);
    expect(mocks.acquire).toHaveBeenCalledWith(expect.anything(), {
      ...input,
      reviewer: { staffId: principal.id, accessSubject: principal.accessSubject, admissionVersion: 3, profileVersion: 4, grantGeneration: 5 },
    }, fetch);
    expect((await send("/projects/adoption/reserve", { reviewItemId: reviewId, idempotencyKey: key }, key)).status).toBe(200);
    expect(mocks.reserve).toHaveBeenCalledWith(expect.anything(), { staffId: principal.id, accessSubject: principal.accessSubject },
      { reviewItemId: reviewId, idempotencyKey: key });
  });

  it("routes activation and bind actions with replay-safe identifiers", async () => {
    const { send } = fixture();
    await send("/directory/activate", { reviewItemId: reviewId, idempotencyKey: key }, key);
    await send("/projects/adoption/bind", { reservationId }, reservationId);
    expect(mocks.activate).toHaveBeenCalledWith(expect.anything(), { reviewItemId: reviewId, idempotencyKey: key },
      { staffId: principal.id, accessSubject: principal.accessSubject }, fetch);
    expect(mocks.bind).toHaveBeenCalledWith(expect.anything(), { staffId: principal.id, accessSubject: principal.accessSubject },
      { reservationId });
  });

  it("keeps the PA-origin project review entry default-off and staging-only", async () => {
    const { send } = fixture();
    const body = { sourceId: "project-alpha:primary", externalProjectId: "pa-project-1", projectAlphaPublicId: publicId };
    expect((await send("/projects/adoption/review", body, key)).status).toBe(404);
    expect(mocks.produce).not.toHaveBeenCalled();
    const enabled = fixture({ adoptionReviewEnabled: true });
    (enabled.env as unknown as { ENVIRONMENT: string }).ENVIRONMENT = "production";
    expect((await enabled.send("/projects/adoption/review", body, key)).status).toBe(404);
    expect(mocks.produce).not.toHaveBeenCalled();
  });

  it("requires a strict PA project selection and header idempotency key, then records only a sanitized outcome", async () => {
    const body = { sourceId: "project-alpha:primary", externalProjectId: "pa-project-1", projectAlphaPublicId: publicId };
    const { send, env } = fixture({ adoptionReviewEnabled: true });
    expect((await send("/projects/adoption/review", { ...body, secret: "nope" }, key)).status).toBe(400);
    expect((await send("/projects/adoption/review", body, "not-a-uuid")).status).toBe(400);
    expect(mocks.produce).not.toHaveBeenCalled();

    const response = await send("/projects/adoption/review", body, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: {
      status: "reviewed", reviewItemId: reviewId, requestSha256: "c".repeat(64), replayed: false,
    } });
    expect(mocks.produce).toHaveBeenCalledWith(expect.anything(),
      { staffId: principal.id, accessSubject: principal.accessSubject },
      { ...body, idempotencyKey: key }, fetch);
    expect(env.OPS_DB.batch).toHaveBeenCalledTimes(1);
  });

  it("does not expose producer internals when the PA review is blocked", async () => {
    mocks.produce.mockResolvedValue({ status: "blocked", reason: "authority", internalToken: "secret" });
    const { send } = fixture({ adoptionReviewEnabled: true });
    const response = await send("/projects/adoption/review", {
      sourceId: "project-alpha:primary", externalProjectId: "pa-project-1", projectAlphaPublicId: publicId,
    }, key);
    expect(await response.json()).toEqual({ outcome: { status: "blocked", reason: "authority" } });
  });

  it("keeps PA binding revision refresh staging-only and builds CAS fields only from fresh PA status", async () => {
    const body = { sourceId: "project-alpha:primary", externalProjectId: "pa-project-1" };
    expect((await fixture().send("/projects/bindings/refresh", body, key)).status).toBe(404);
    const production = fixture({ projectBindingRefreshEnabled: true });
    (production.env as unknown as { ENVIRONMENT: string }).ENVIRONMENT = "production";
    expect((await production.send("/projects/bindings/refresh", body, key)).status).toBe(404);
    expect(mocks.bindingStatus).not.toHaveBeenCalled();

    const { send, env } = fixture({ projectBindingRefreshEnabled: true });
    expect((await send("/projects/bindings/refresh", { ...body, expectedRevision: "999" }, key)).status).toBe(400);
    expect((await send("/projects/bindings/refresh", body, "invalid")).status).toBe(400);
    const response = await send("/projects/bindings/refresh", body, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: { status: "refreshed", revision: "10", replayed: false } });
    expect(mocks.bindingStatus).toHaveBeenCalledWith(expect.anything(), body.sourceId, body.externalProjectId);
    expect(mocks.bindingRefresh).toHaveBeenCalledWith(expect.anything(), body.sourceId, {
      commandId: key, externalId: "pa-project-1", expectedPublicId: publicId, expectedPriorRevision: "2",
      expectedRevision: "10", expectedProjectionSha256: "d".repeat(64), expectedAuthorizationGeneration: "7",
    });
    expect(env.OPS_DB.batch).toHaveBeenCalledTimes(1);
  });

  it("does not refresh when the just-read binding is current", async () => {
    mocks.bindingStatus.mockResolvedValue({ status: "observed", httpStatus: 200, response: {
      binding: { externalId: "pa-project-1", publicId, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" },
      resource: { revision: "10" },
    } });
    const response = await fixture({ projectBindingRefreshEnabled: true }).send(
      "/projects/bindings/refresh", { sourceId: "project-alpha:primary", externalProjectId: "pa-project-1" }, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: { status: "current", revision: "10" } });
    expect(mocks.bindingRefresh).not.toHaveBeenCalled();
  });

  it("returns only the typed staging preflight reason when PA lacks a binding-status route", async () => {
    mocks.bindingStatus.mockResolvedValue({ status: "blocked", reason: "preflight", preflight: {
      status: "incompatible", reason: "missing_endpoint", httpStatus: 200,
    } });
    const response = await fixture({ projectBindingRefreshEnabled: true }).send(
      "/projects/bindings/refresh", { sourceId: "project-alpha:staging", externalProjectId: "synthetic-stale-project" }, key);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ outcome: { status: "not_refreshed", reason: "preflight_missing_endpoint" } });
    expect(mocks.bindingRefresh).not.toHaveBeenCalled();
  });

  it("guards and bounds the sanitized reconciliation finding feed", async () => {
    expect((await fixture({ administrator: false }).get(
      "/directory/reconciliation/findings?sourceId=project-alpha:primary")).status).toBe(403);
    const { get } = fixture();
    expect((await get("/directory/reconciliation/findings?sourceId=project-alpha:primary&sourceId=project-alpha:secondary&limit=47&cursor=opaque"))
      .status).toBe(200);
    expect(mocks.reconciliationList).toHaveBeenCalledWith(expect.anything(), {
      sourceIds: ["project-alpha:primary", "project-alpha:secondary"], limit: 47, cursor: "opaque",
    });
    expect((await get("/directory/reconciliation/findings?sourceId=project-alpha:primary&limit=99")).status).toBe(400);
    expect((await get("/directory/reconciliation/findings?sourceId=project-alpha:primary&secret=x")).status).toBe(400);
  });

  it("guards and bounds the exact native-record selector without accepting search terms", async () => {
    expect((await fixture({ enabled: false }).get(
      "/directory/reconciliation/records?resourceType=organization")).status).toBe(404);
    expect((await fixture({ administrator: false }).get(
      "/directory/reconciliation/records?resourceType=organization")).status).toBe(403);
    expect((await fixture({ global: false }).get(
      "/directory/reconciliation/records?resourceType=organization")).status).toBe(403);
    const { get } = fixture();
    expect((await get("/directory/reconciliation/records?resourceType=client&limit=47&cursor=opaque")).status).toBe(200);
    expect(mocks.reconciliationRecords).toHaveBeenCalledWith(expect.anything(), {
      resourceType: "client", reviewerStaffId: principal.id, limit: 47, cursor: "opaque",
    });
    expect((await get("/directory/reconciliation/records?resourceType=organization&limit=99")).status).toBe(400);
    expect((await get("/directory/reconciliation/records?resourceType=user")).status).toBe(400);
    expect((await get("/directory/reconciliation/records?resourceType=client&search=email")).status).toBe(400);
  });

  it("requires global native profile-view authority for minimal current PA context", async () => {
    expect((await fixture({ directoryView: false }).get(
      `/directory/reconciliation/findings/${reviewId}/context`)).status).toBe(403);
    expect(mocks.reconciliationContext).not.toHaveBeenCalled();
    const response = await fixture().get(`/directory/reconciliation/findings/${reviewId}/context`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ findingId: reviewId, resourceType: "organization",
      displayName: "Example Organization", contactEmail: "contact@example.test", organizationPublicId: null });
    expect(mocks.reconciliationContext).toHaveBeenCalledWith(expect.anything(), reviewId, fetch);
    expect((await fixture().get("/directory/reconciliation/findings/not-a-uuid/context")).status).toBe(404);
  });

  it("accepts only finding/native-version selection and derives acquisition identities server-side", async () => {
    const { send } = fixture();
    const selected = { findingId: reviewId, recordId: "record-1", expectedRecordVersion: 7, idempotencyKey: key };
    expect((await send("/directory/reconciliation/acquire", { ...selected, projectAlphaPublicId: publicId }, key)).status).toBe(400);
    expect((await send("/directory/reconciliation/acquire", selected, key)).status).toBe(200);
    expect(mocks.reconciliationAcquire).toHaveBeenCalledWith(expect.anything(), selected, {
      staffId: principal.id, accessSubject: principal.accessSubject, admissionVersion: 3, profileVersion: 4, grantGeneration: 5,
    });
  });
});
