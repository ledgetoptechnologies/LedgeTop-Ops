import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";
import type { Env } from "../src/worker/types";

const calls = vi.hoisted(() => ({ legacy: vi.fn(), native: vi.fn(), issue: vi.fn(), reveal: vi.fn(),
  review: vi.fn(), approve: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: calls.legacy }));
vi.mock("../src/worker/native-staff-auth", () => ({
  authenticateNativeStaffWithAdmissionVersion: calls.native,
}));
vi.mock("../src/worker/client-onboarding-handoff", () => ({
  snapshotClientOnboardingKeyring: (value: unknown) => value,
  issueClientOnboardingWithHandoff: calls.issue,
  revealClientOnboardingSecret: calls.reveal,
}));
vi.mock("../src/worker/client-onboarding-review", () => ({
  readClientOnboardingSubmissionForReview: calls.review,
}));
vi.mock("../src/worker/client-onboarding-approval", () => ({
  approveNewNativeOnlyClientOnboarding: calls.approve,
}));
import worker from "../src/worker/index";

const origin = "https://ops.example.test";
const keyring = { activeKeyId: "current", keys: { current: "ab".repeat(32) } };
const actor = { identity: { kind: "native" as const, staffId: "staff:onboarding",
  verifiedAccessSubject: "access|staff:onboarding", email: "staff@example.test",
  displayName: "Onboarding Staff", profileVersion: 1 }, admissionVersion: 2,
verifiedUntil: "2099-01-01T00:00:00.000Z" };
const unavailable = (): never => { throw Error("unexpected database use"); };
const database: D1Database = { prepare: unavailable, batch: unavailable, exec: unavailable,
  withSession: unavailable, dump: unavailable };
function env(enabled = "true"): Env {
  return { ENVIRONMENT: "production", EXPECTED_HOST: "ops.example.test", OPERATIONS_ORIGINS: origin,
    PUBLIC_BASE_URL: origin, INCOMING_EXPECTED_HOST: "incoming.example.test",
    INCOMING_BASE_URL: "https://incoming.example.test", OPS_DB: database,
    TEAM_DOMAIN: "https://synthetic-team.cloudflareaccess.com",
    OPERATIONS_AUD: "synthetic-staff-audience", CLIENT_ONBOARDING_ADMIN_ENABLED: enabled,
    CLIENT_ONBOARDING_ADMIN_ORIGIN: origin, CLIENT_ONBOARDING_HANDOFF_KEYRING: JSON.stringify(keyring),
    OPERATIONS_SESSION_SECRET: "synthetic-client-onboarding-csrf-secret-at-least-thirty-two-bytes" } as Env;
}
const context: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {},
  get exports(): Cloudflare.Exports { return unavailable(); }, get tracing(): Tracing { return unavailable(); } };
function send(path: string, method = "GET", body?: unknown, csrf?: string,
  environment = env(), requestOrigin = origin) {
  return worker.fetch(new Request(`${origin}${path}`, { method,
    headers: { "X-Native-Staff-Request": "1", "Sec-Fetch-Site": "same-origin",
      Origin: requestOrigin, "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), environment, context);
}
async function session(environment = env()): Promise<string> {
  const reply = await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, environment);
  expect(reply.status).toBe(200);
  return (await reply.json() as { csrfToken: string }).csrfToken;
}

beforeEach(() => {
  calls.legacy.mockReset().mockRejectedValue(new HTTPException(401, { message: "legacy denied" }));
  calls.native.mockReset().mockResolvedValue(actor);
  calls.issue.mockReset().mockResolvedValue({ invitationId: "11111111-1111-4111-8111-111111111111",
    expiresAt: "2099-01-01T00:00:00.000Z", requestSha256: "c".repeat(64), state: "pending" });
  calls.reveal.mockReset().mockResolvedValue({ commandId: "22222222-2222-4222-8222-222222222222",
    invitationId: "11111111-1111-4111-8111-111111111111", expiresAt: "2099-01-01T00:00:00.000Z",
    invitationSecret: "d".repeat(64) });
  calls.review.mockReset().mockResolvedValue({
    invitationId: "11111111-1111-4111-8111-111111111111",
    submissionId: "33333333-3333-4333-8333-333333333333", fieldsSha256: "e".repeat(64),
    submittedAt: "2098-01-01T00:00:00.000Z", targetClientRecordId: null,
    scopes: [{ businessAreaId: "area:onboarding", divisionId: null }],
    fields: { clientType: "consumer", name: "Client", email: "client@example.test", phone: "",
      organizationName: "", organizationEmail: "", organizationPhone: "", addressLine1: "1 Main",
      addressLine2: "", city: "Town", state: "TX", postalCode: "75001", country: "US" },
  });
  calls.approve.mockReset().mockResolvedValue({ status: "written", replayed: false,
    decisionId: "44444444-4444-4444-8444-444444444444",
    invitationId: "11111111-1111-4111-8111-111111111111",
    submissionId: "33333333-3333-4333-8333-333333333333",
    clientRecordId: "55555555-5555-4555-8555-555555555555",
    clientRecordVersion: 1, relationshipVersion: 1 });
});

describe("native client onboarding staff route", () => {
  it("is absent by default before either authentication stack", async () => {
    expect((await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, env("false"))).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("rejects wrong origin and invalid CSRF before issuing", async () => {
    expect((await send("/api/client-onboarding/staff/session", "GET", undefined, undefined, env(),
      "https://evil.example.test")).status).toBe(403);
    const command = { commandId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
      scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
    expect((await send("/api/client-onboarding/staff/create", "POST", command, "bad")).status).toBe(403);
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("creates metadata only and reveals separately through audited service", async () => {
    const csrf = await session();
    const command = { commandId: "22222222-2222-4222-8222-222222222222",
      expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
      scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
    const created = await send("/api/client-onboarding/staff/create", "POST", command, csrf);
    expect(created.status).toBe(200);
    const createText = await created.text();
    expect(createText).not.toContain("invitationSecret");
    expect(createText).not.toContain("d".repeat(64));
    expect(created.headers.get("Cache-Control")).toBe("no-store");
    const handoffActor = { identity: actor.identity, verifiedUntil: actor.verifiedUntil };
    expect(calls.issue).toHaveBeenCalledWith(database, { authenticatedNativeStaff: handoffActor,
      request: command }, keyring);
    const revealed = await send("/api/client-onboarding/staff/reveal", "POST",
      { commandId: command.commandId }, csrf);
    expect(revealed.status).toBe(200);
    expect(await revealed.json()).toMatchObject({ invitationSecret: "d".repeat(64) });
    expect(revealed.headers.get("Cache-Control")).toBe("no-store");
    expect(revealed.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls.reveal).toHaveBeenCalledWith(database, { authenticatedNativeStaff: handoffActor,
      commandId: command.commandId }, keyring);
    expect(calls.issue.mock.calls[0]?.[1].authenticatedNativeStaff).not.toHaveProperty("admissionVersion");
    expect(calls.reveal.mock.calls[0]?.[1].authenticatedNativeStaff).not.toHaveProperty("admissionVersion");
    expect(calls.legacy).not.toHaveBeenCalled();
  });

  it("fails closed when current grant authority is revoked", async () => {
    const csrf = await session();
    calls.issue.mockRejectedValueOnce(Error("client_onboarding_handoff_issue_denied"));
    const reply = await send("/api/client-onboarding/staff/create", "POST", {
      commandId: "22222222-2222-4222-8222-222222222222", expiresAt: "2099-01-01T00:00:00.000Z",
      targetClientRecordId: null, scopes: [{ businessAreaId: "area:onboarding", divisionId: null }],
    }, csrf);
    expect(reply.status).toBe(403);
    expect(await reply.json()).toEqual({ error: "client_onboarding_denied" });
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("returns committed create and reveal results when authentication expires during the service call", async () => {
    vi.useFakeTimers();
    try {
      const startedAt = new Date("2098-01-01T00:00:00.000Z");
      vi.setSystemTime(startedAt);
      calls.native.mockResolvedValue({ ...actor,
        verifiedUntil: new Date(startedAt.getTime() + 500).toISOString() });
      const csrf = await session();
      const command = { commandId: "22222222-2222-4222-8222-222222222222",
        expiresAt: "2099-01-01T00:00:00.000Z", targetClientRecordId: null,
        scopes: [{ businessAreaId: "area:onboarding", divisionId: null }] };
      calls.issue.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(startedAt.getTime() + 1_000));
        return { invitationId: "11111111-1111-4111-8111-111111111111",
          expiresAt: command.expiresAt, requestSha256: "c".repeat(64), state: "pending" };
      });
      expect((await send("/api/client-onboarding/staff/create", "POST", command, csrf)).status).toBe(200);

      vi.setSystemTime(startedAt);
      calls.reveal.mockImplementationOnce(async () => {
        vi.setSystemTime(new Date(startedAt.getTime() + 1_000));
        return { commandId: command.commandId, invitationId: "11111111-1111-4111-8111-111111111111",
          expiresAt: command.expiresAt, invitationSecret: "d".repeat(64) };
      });
      expect((await send("/api/client-onboarding/staff/reveal", "POST",
        { commandId: command.commandId }, csrf)).status).toBe(200);
    } finally { vi.useRealTimers(); }
  });

  it("returns only authorized immutable submission details with no-store", async () => {
    const csrf = await session();
    const submissionId = "33333333-3333-4333-8333-333333333333";
    const reply = await send("/api/client-onboarding/staff/review", "POST", { submissionId }, csrf);
    expect(reply.status).toBe(200);
    const text = await reply.text();
    expect(text).toContain(submissionId);
    expect(text).not.toContain("invitationSecret");
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
    expect(reply.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(calls.review).toHaveBeenCalledWith(database, actor, submissionId);
    expect(calls.issue).not.toHaveBeenCalled();
    expect(calls.reveal).not.toHaveBeenCalled();
  });

  it("requires CSRF and collapses out-of-scope review to denial", async () => {
    const submissionId = "33333333-3333-4333-8333-333333333333";
    expect((await send("/api/client-onboarding/staff/review", "POST", { submissionId }, "bad")).status).toBe(403);
    expect(calls.review).not.toHaveBeenCalled();
    const csrf = await session();
    calls.review.mockRejectedValueOnce(Error("client_onboarding_review_denied"));
    const denied = await send("/api/client-onboarding/staff/review", "POST", { submissionId }, csrf);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client_onboarding_denied" });
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
  });

  it("approves through the server-owned native-only command and returns no authority material", async () => {
    const csrf = await session(), submissionId = "33333333-3333-4333-8333-333333333333";
    const reply = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, csrf);
    expect(reply.status).toBe(200);
    expect(await reply.json()).toEqual({ decisionId: "44444444-4444-4444-8444-444444444444",
      submissionId, clientRecordId: "55555555-5555-4555-8555-555555555555",
      clientRecordVersion: 1, relationshipVersion: 1, replayed: false });
    expect(calls.approve).toHaveBeenCalledWith(database, actor, submissionId, "e".repeat(64));
    expect(reply.headers.get("Cache-Control")).toBe("no-store");
  });

  it("requires exact approval input, CSRF, and current server authority", async () => {
    const csrf = await session(), submissionId = "33333333-3333-4333-8333-333333333333";
    expect((await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, "bad")).status).toBe(403);
    expect(calls.approve).not.toHaveBeenCalled();
    expect((await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64), recordId: "caller-owned" }, csrf)).status).toBe(400);
    expect(calls.approve).not.toHaveBeenCalled();
    calls.approve.mockRejectedValueOnce(Error("client_onboarding_approval_denied"));
    const denied = await send("/api/client-onboarding/staff/approve", "POST",
      { submissionId, fieldsSha256: "e".repeat(64) }, csrf);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "client_onboarding_denied" });
  });

  it("reserves the exact namespace and leaves unrelated API paths to legacy auth", async () => {
    expect((await send("/api/client-onboarding/staff/create/extra", "POST", {}, "bad")).status).toBe(404);
    expect(calls.native).not.toHaveBeenCalled();
    expect(calls.legacy).not.toHaveBeenCalled();
    expect((await send("/api/session")).status).toBe(401);
    expect(calls.legacy).toHaveBeenCalledOnce();
  });
});
