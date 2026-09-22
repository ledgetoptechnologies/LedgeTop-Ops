import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { csrfToken, requireMutationSecurity } from "../src/worker/request-security";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(), acquire: vi.fn(), activate: vi.fn(), reserve: vi.fn(), bind: vi.fn(), first: vi.fn(),
}));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/project-alpha-existing-directory-acquisition-coordinator", () => ({
  acquireProjectAlphaExistingDirectoryBinding: mocks.acquire,
}));
vi.mock("../src/worker/project-alpha-existing-directory-binding-review-consumer", () => ({
  activateProjectAlphaExistingDirectoryBinding: mocks.activate,
}));
vi.mock("../src/worker/project-alpha-project-adoption-review-consumer", () => ({
  reserveProjectAlphaProjectAdoptionReview: mocks.reserve,
}));
vi.mock("../src/worker/project-alpha-project-adoption-bind-consumer", () => ({
  planProjectAlphaProjectAdoptionBind: mocks.bind,
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

function fixture(options: { enabled?: boolean; administrator?: boolean; global?: boolean; denied?: boolean } = {}) {
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
    OPERATIONS_SESSION_SECRET: "operations-session-secret-0123456789abcdef",
    OPERATIONS_ORIGINS: "https://ops.example.test",
    OPS_DB: { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first: mocks.first })) })) },
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
  return { send, env };
}

describe("private Project Alpha administrator transport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.first.mockResolvedValue({ admissionVersion: 3, profileVersion: 4, grantGeneration: 5 });
    mocks.acquire.mockResolvedValue({ status: "acquired", reviewReceiptId: reviewId, commandId, acquiredReceiptId: key, replayed: false });
    mocks.activate.mockResolvedValue({ status: "activated", activationId: key, reviewItemId: reviewId, idempotencyKey: key, replayed: false });
    mocks.reserve.mockResolvedValue({ status: "reserved", reservationId, reviewItemId: reviewId, idempotencyKey: key, replayed: false });
    mocks.bind.mockResolvedValue({ status: "planned", bridgeId: key, reservationId, commandId, requestSha256: "b".repeat(64), replayed: false });
  });

  it("is default-off before parsing or invoking a consumer", async () => {
    const { send } = fixture({ enabled: false });
    expect((await send("/directory/acquire", {}, commandId)).status).toBe(404);
    expect(mocks.acquire).not.toHaveBeenCalled();
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
      projectAlphaPublicId: publicId, localRecordVersion: 1,
    }, commandId, { "Content-Length": String(33 * 1024) })).status).toBe(413);
    expect(mocks.reserve).not.toHaveBeenCalled();
  });

  it("derives actor and authority versions from the authenticated principal, never JSON", async () => {
    const { send } = fixture();
    const input = {
      reviewId, commandId, sourceId: "project-alpha:primary", recordId: "record-1", resourceType: "organization",
      projectAlphaPublicId: publicId, localRecordVersion: 1,
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
});
