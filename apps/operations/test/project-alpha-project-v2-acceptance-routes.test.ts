import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(), native: vi.fn(), resolve: vi.fn(), withEnabled: vi.fn(),
  plan: vi.fn(), dispatch: vi.fn(), settle: vi.fn(), activate: vi.fn(), audit: vi.fn(), batch: vi.fn(),
}));
vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.native }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  resolveProjectAlphaApiV2Connection: mocks.resolve,
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.withEnabled,
}));
vi.mock("../src/worker/project-alpha-project-v2-command-producer", () => ({ planProjectAlphaProjectV2Command: mocks.plan }));
vi.mock("../src/worker/project-alpha-project-v2-pending-dispatcher", () => ({ dispatchProjectAlphaProjectV2PendingCommand: mocks.dispatch }));
vi.mock("../src/worker/project-alpha-project-read-settlement-adapter", () => ({ settleProjectAlphaProjectV2Read: mocks.settle }));
vi.mock("../src/worker/project-alpha-project-canonical-activation-adapter", () => ({ activateProjectAlphaProjectV2Canonical: mocks.activate }));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import { PROJECT_ALPHA_PROJECT_V2_ACCEPTANCE_ROUTE, registerProjectAlphaProjectV2AcceptanceRoutes } from "../src/worker/project-alpha-project-v2-acceptance-routes";

const principal: StaffPrincipal = { id: "native-admin", email: "native-admin@example.test", displayName: "Native administrator",
  accessSubject: "native-admin-subject", projectAlphaUserId: null };
const appId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const commandId = "10000000-0000-4000-8000-000000000001";
const receiptId = "10000000-0000-4000-8000-000000000002";
const settlementId = "10000000-0000-4000-8000-000000000003";
const activationId = "10000000-0000-4000-8000-000000000004";
const sha = "a".repeat(64);
const selectedConnection = {
  baseUrl: "https://pa.example.test", apiKey: "server-only",
  expectedSourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", expectedApplicationId: appId,
  expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
} as const;
const requestBody = {
  sourceId: "project-alpha:staging", expectedApplicationId: appId, operation: "create", scopes: [],
  local: { expectedLocalVersion: 0, expectedLocalProjectionSha256: null },
  directory: { organizationRecordId: "organization-1", clientRecordId: null },
  command: { commandId, externalId: "ops/project-1", expectedAuthorizationGeneration: "0",
    project: { name: "Acceptance project", description: null, estimatedStart: null, estimatedEnd: null },
    organization: { externalId: "organization-1", expectedPublicId: "a".repeat(32), expectedRevision: "1", expectedProjectionSha256: sha },
    client: null },
} as const;
const updateRequestBody = {
  sourceId: requestBody.sourceId, expectedApplicationId: appId, operation: "update",
  scopes: [{ scopeKind: "business_area", businessAreaId: "drone", divisionId: null }],
  local: { expectedLocalVersion: 7, expectedLocalProjectionSha256: sha },
  command: {
    commandId: "20000000-0000-4000-8000-000000000001", externalId: "ops/project-update-1",
    expectedRevision: "7", expectedProjectionSha256: sha, expectedAuthorizationGeneration: "5",
    project: { name: "Acceptance project updated", description: "Joined update",
      estimatedStart: "2026-10-01", estimatedEnd: "2026-10-31" },
  },
} as const;
const bindRequestBody = {
  sourceId: requestBody.sourceId, expectedApplicationId: appId, operation: "bind",
  scopes: [{ scopeKind: "division", businessAreaId: "drone", divisionId: "survey" }],
  local: { expectedLocalVersion: 9, expectedLocalProjectionSha256: sha },
  command: {
    commandId: "30000000-0000-4000-8000-000000000001", externalId: "ops/project-bind-1",
    expectedPublicId: "b".repeat(32), expectedRevision: "9", expectedProjectionSha256: sha,
    expectedAuthorizationGeneration: "6",
  },
} as const;

function fixture(enabled = true, administrator = true, environment = "staging") {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => { c.set("principal", principal); c.set("administrator", administrator); await next(); });
  registerProjectAlphaProjectV2AcceptanceRoutes(app);
  const env = { ENVIRONMENT: environment, PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED: enabled ? "true" : "false",
    TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "operations-audience-value",
    AUDIT_IP_SECRET: "audit-secret",
    OPS_DB: { batch: mocks.batch } } as unknown as Env;
  const send = (body: unknown = requestBody, headers: Record<string, string> = {}) => app.request(
    `https://ops.example${PROJECT_ALPHA_PROJECT_V2_ACCEPTANCE_ROUTE}`,
    { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": commandId, ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body) }, env);
  return { app, env, send };
}

describe("Project-v2 administrator joined-acceptance route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
    mocks.native.mockResolvedValue({ admissionVersion: 1, verifiedUntil: "2999-01-01T00:00:00.000Z",
      identity: { kind: "native", staffId: principal.id, verifiedAccessSubject: principal.accessSubject,
        email: principal.email, displayName: principal.displayName, profileVersion: 1 } });
    mocks.resolve.mockReturnValue({ sourceId: requestBody.sourceId, enabled: true,
      connection: { baseUrl: "https://pa.example.test", expectedSourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        expectedApplicationId: appId, expectedHistoryEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" } });
    mocks.withEnabled.mockImplementation(async (_env, _source, callback) =>
      ({ status: "enabled", value: await callback(selectedConnection) }));
    mocks.plan.mockResolvedValue({ status: "queued", commandId, requestSha256: sha, replayed: false });
    mocks.dispatch.mockResolvedValue({ status: "acknowledged", receiptId, replayed: false });
    mocks.settle.mockResolvedValue({ status: "settled", settlementId, successReceiptId: receiptId, commandId, replayed: false });
    mocks.activate.mockResolvedValue({ status: "activated", activationId, settlementId, commandId,
      externalProjectId: requestBody.command.externalId, version: 1, replayed: false });
    mocks.audit.mockResolvedValue({}); mocks.batch.mockResolvedValue([]);
  });

  it("is hidden while default-off and does not authenticate, write, or dispatch", async () => {
    const response = await fixture(false).send();
    expect(response.status).toBe(404);
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("remains hidden in production even if its mutable flag drifts on", async () => {
    const response = await fixture(true, true, "production").send();
    expect(response.status).toBe(404);
    expect(mocks.native).not.toHaveBeenCalled(); expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.plan).not.toHaveBeenCalled(); expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("requires administrator, deny-aware integrations.manage, exact native identity, and exact application selection", async () => {
    expect((await fixture(true, false).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    mocks.resolve.mockReturnValueOnce({ ...mocks.resolve(), connection: { ...mocks.resolve().connection,
      expectedApplicationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" } });
    expect((await fixture().send()).status).toBe(409);
    mocks.native.mockResolvedValueOnce({ ...(await mocks.native()), identity: { ...(await mocks.native()).identity, staffId: "other" } });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("rejects duplicate JSON members, unknown fields, and a mismatched idempotency header before planning", async () => {
    const duplicate = JSON.stringify(requestBody).replace(`"sourceId":"${requestBody.sourceId}"`,
      `"sourceId":"${requestBody.sourceId}","sourceId":"project-alpha:other"`);
    expect((await fixture().send(duplicate)).status).toBe(400);
    expect((await fixture().send({ ...requestBody, apiKey: "browser-secret" })).status).toBe(400);
    expect((await fixture().send(requestBody, { "Idempotency-Key": activationId })).status).toBe(400);
    expect(mocks.plan).not.toHaveBeenCalled();
  });

  it("composes producer, dispatcher, read settlement, and activation and returns only bounded evidence", async () => {
    const response = await fixture().send();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ sourceId: requestBody.sourceId, expectedApplicationId: appId,
      stage: "activate", outcome: { status: "activated", activationId, settlementId, commandId,
        externalProjectId: requestBody.command.externalId, version: 1, replayed: false } });
    expect(mocks.plan).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sourceId: requestBody.sourceId,
      actor: { staffId: principal.id, accessSubject: principal.accessSubject,
        email: principal.email, admissionVersion: 1, profileVersion: 1,
        verifiedUntil: "2999-01-01T00:00:00.000Z", scopes: [] } }));
    expect(mocks.plan.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]!);
    expect(mocks.dispatch.mock.invocationCallOrder[0]).toBeLessThan(mocks.settle.mock.invocationCallOrder[0]!);
    expect(mocks.settle.mock.invocationCallOrder[0]).toBeLessThan(mocks.activate.mock.invocationCallOrder[0]!);
    expect(JSON.stringify(await (await fixture().send()).json())).not.toContain("server-only");
  });

  it.each([
    {
      operation: "update", body: updateRequestBody,
      receiptId: "20000000-0000-4000-8000-000000000002",
      settlementId: "20000000-0000-4000-8000-000000000003",
      activationId: "20000000-0000-4000-8000-000000000004",
    },
    {
      operation: "bind", body: bindRequestBody,
      receiptId: "30000000-0000-4000-8000-000000000002",
      settlementId: "30000000-0000-4000-8000-000000000003",
      activationId: "30000000-0000-4000-8000-000000000004",
    },
  ] as const)("composes the strict $operation envelope through activation without exposing private evidence",
    async ({ body, receiptId: operationReceiptId, settlementId: operationSettlementId,
      activationId: operationActivationId }) => {
      mocks.plan.mockResolvedValueOnce({ status: "queued", commandId: body.command.commandId,
        requestSha256: sha, replayed: false, requestId: "private-plan-request" });
      mocks.dispatch.mockResolvedValueOnce({ status: "acknowledged", receiptId: operationReceiptId,
        replayed: false, requestId: "private-dispatch-request" });
      mocks.settle.mockResolvedValueOnce({ status: "settled", settlementId: operationSettlementId,
        successReceiptId: operationReceiptId, commandId: body.command.commandId, replayed: false,
        apiKey: "private-settlement-key" });
      mocks.activate.mockResolvedValueOnce({ status: "activated", activationId: operationActivationId,
        settlementId: operationSettlementId, commandId: body.command.commandId,
        externalProjectId: body.command.externalId, version: 11, replayed: false,
        requestId: "private-activation-request" });
      const state = fixture();

      const routeResponse = await state.send(body, { "Idempotency-Key": body.command.commandId });

      expect(routeResponse.status).toBe(200);
      const json = await routeResponse.json();
      expect(json).toEqual({ sourceId: body.sourceId, expectedApplicationId: appId, stage: "activate",
        outcome: { status: "activated", activationId: operationActivationId,
          settlementId: operationSettlementId, commandId: body.command.commandId,
          externalProjectId: body.command.externalId, version: 11, replayed: false } });
      expect(mocks.plan).toHaveBeenCalledOnce();
      expect(mocks.plan).toHaveBeenCalledWith(state.env, {
        sourceId: body.sourceId,
        actor: { staffId: principal.id, accessSubject: principal.accessSubject,
          email: principal.email, admissionVersion: 1, profileVersion: 1,
          verifiedUntil: "2999-01-01T00:00:00.000Z", scopes: body.scopes },
        operation: body.operation, scopes: body.scopes, local: body.local, command: body.command,
      });
      expect(mocks.dispatch).toHaveBeenCalledOnce();
      expect(mocks.dispatch).toHaveBeenCalledWith(state.env, body.sourceId, body.command.commandId, fetch);
      expect(mocks.settle).toHaveBeenCalledOnce();
      expect(mocks.settle).toHaveBeenCalledWith(state.env, operationReceiptId, selectedConnection, fetch);
      expect(mocks.activate).toHaveBeenCalledOnce();
      expect(mocks.activate).toHaveBeenCalledWith(state.env, operationSettlementId);
      expect(JSON.stringify(json)).not.toContain("private-");
      expect(JSON.stringify(json)).not.toContain("server-only");
    });

  it("denies a stale update plan without dispatch, read settlement, or activation", async () => {
    mocks.plan.mockResolvedValueOnce({ status: "blocked", reason: "stale", requestId: "private-plan-request" });
    const state = fixture();

    const routeResponse = await state.send(updateRequestBody,
      { "Idempotency-Key": updateRequestBody.command.commandId });

    expect(routeResponse.status).toBe(200);
    await expect(routeResponse.json()).resolves.toEqual({ sourceId: updateRequestBody.sourceId,
      expectedApplicationId: appId, stage: "plan", outcome: { status: "blocked", reason: "stale" } });
    expect(mocks.plan).toHaveBeenCalledOnce();
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.withEnabled).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("stops at the first non-success stage and exact replay does not broaden the route surface", async () => {
    mocks.dispatch.mockResolvedValueOnce({ status: "uncertain", reason: "transport", requestId: "private-diagnostic" });
    const stopped = await fixture().send();
    await expect(stopped.json()).resolves.toEqual({ sourceId: requestBody.sourceId, expectedApplicationId: appId,
      stage: "dispatch", outcome: { status: "uncertain", reason: "transport" } });
    expect(mocks.settle).not.toHaveBeenCalled(); expect(mocks.activate).not.toHaveBeenCalled();

    mocks.plan.mockResolvedValueOnce({ status: "queued", commandId, requestSha256: sha, replayed: true });
    mocks.dispatch.mockResolvedValueOnce({ status: "acknowledged", receiptId, replayed: true });
    mocks.settle.mockResolvedValueOnce({ status: "settled", settlementId, successReceiptId: receiptId, commandId, replayed: true });
    mocks.activate.mockResolvedValueOnce({ status: "activated", activationId, settlementId, commandId,
      externalProjectId: requestBody.command.externalId, version: 1, replayed: true });
    const replay = await fixture().send();
    expect((await replay.json() as { outcome: { replayed: boolean } }).outcome.replayed).toBe(true);
    expect((await fixture().app.request(`https://ops.example${PROJECT_ALPHA_PROJECT_V2_ACCEPTANCE_ROUTE}`,
      { method: "GET" }, fixture().env)).status).toBe(404);
  });
});
