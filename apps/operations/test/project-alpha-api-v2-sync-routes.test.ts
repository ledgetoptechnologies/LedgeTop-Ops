import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, StaffPrincipal } from "../src/worker/types";
import { encodeProjectAlphaApiV2SyncCursor } from "../src/worker/project-alpha-api-v2-sync-cursor";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  run: vi.fn(),
  audit: vi.fn(),
  batch: vi.fn(),
}));

vi.mock("../src/worker/acl", () => ({ sqlScope: mocks.scope }));
vi.mock("../src/worker/project-alpha-v2-sync", () => ({
  runProjectAlphaApiV2SyncPage: mocks.run,
}));
vi.mock("../src/worker/request-security", () => ({ auditStatement: mocks.audit }));

import {
  PROJECT_ALPHA_API_V2_SYNC_ROUTE,
  registerProjectAlphaApiV2SyncRoutes,
} from "../src/worker/project-alpha-api-v2-sync-routes";

const principal: StaffPrincipal = {
  id: "admin", email: "admin@example.test", displayName: "Administrator",
  accessSubject: "access-subject", projectAlphaUserId: null,
};
const selectedSource = "project-alpha:primary";
const identity = { sourceInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", applicationId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  historyEpoch: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", authorizationGeneration: "7" };
const sessionSecret = "project-alpha-route-test-secret-at-least-32-characters";

function fixture(enabled = true, administrator = true) {
  const app = new Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>();
  app.use("*", async (c, next) => {
    c.set("principal", principal);
    c.set("administrator", administrator);
    await next();
  });
  registerProjectAlphaApiV2SyncRoutes(app);
  const env = {
    PROJECT_ALPHA_API_V2_SYNC_ENABLED: enabled ? "true" : "false",
    OPS_DB: { batch: mocks.batch },
    AUDIT_IP_SECRET: "audit-secret",
    OPERATIONS_SESSION_SECRET: sessionSecret,
    PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: { [selectedSource]: {
      sourceId: selectedSource, enabled: true, baseUrl: "https://pa.example.test", apiKey: "private-api-key",
      sourceInstanceId: identity.sourceInstanceId, applicationId: identity.applicationId, historyEpoch: identity.historyEpoch,
    } } }),
  } as unknown as Env;
  const send = (body: unknown = { sourceId: selectedSource }) => app.request(
    `https://ops.example.test${PROJECT_ALPHA_API_V2_SYNC_ROUTE}`,
    {
      method: "POST",
      headers: {
        Origin: "https://ops.example.test",
        "Content-Type": "application/json",
        "X-CSRF-Token": "middleware-tested",
      },
      body: JSON.stringify(body),
    },
    env,
  );
  return { send };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({ global: true, deniedGlobal: false });
  mocks.run.mockResolvedValue({
    status: "completed",
    directory: { status: "persisted", itemCount: 3, conflictCount: 0, nextCursor: "client:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", continuationIdentity: identity },
    projects: { status: "persisted", itemCount: 2, conflictCount: 0, nextCursor: "private-project-cursor", continuationIdentity: identity },
  });
  mocks.audit.mockResolvedValue({});
  mocks.batch.mockResolvedValue([]);
});

describe("Project Alpha API-v2 bounded sync route", () => {
  it("is default-off before invoking the synchronization runner", async () => {
    expect((await fixture(false).send()).status).toBe(404);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("requires administrator membership and deny-aware global integrations.manage", async () => {
    expect((await fixture(true, false).send()).status).toBe(403);
    mocks.scope.mockResolvedValueOnce({ global: true, deniedGlobal: true });
    expect((await fixture().send()).status).toBe(403);
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it("rejects legacy raw cursor input and accepts one actor/source-bound encrypted continuation", async () => {
    const rawCursor = "organization:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    expect((await fixture().send({ sourceId: selectedSource, directoryCursor: rawCursor, limit: 200 })).status).toBe(400);
    const token = await encodeProjectAlphaApiV2SyncCursor({ OPERATIONS_SESSION_SECRET: sessionSecret }, principal.id, {
      v: 1, sourceId: selectedSource, surface: "directory", limit: 200, ...identity,
      cursor: rawCursor, expires: Date.now() + 60_000,
    });
    const response = await fixture().send({
      sourceId: selectedSource,
      directoryContinuationToken: token,
      limit: 200,
    });
    expect(response.status).toBe(200);
    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      PROJECT_ALPHA_API_V2_SYNC_ENABLED: "true",
    }), {
      sourceId: selectedSource,
      continuation: expect.objectContaining({ surface: "directory", cursor: rawCursor, sourceId: selectedSource }),
      limit: 200,
    });
  });

  it.each([
    { sourceId: "primary" },
    { sourceId: selectedSource, limit: 0 },
    { sourceId: selectedSource, limit: 201 },
    { sourceId: selectedSource, limit: 1.5 },
    { sourceId: selectedSource, directoryContinuationToken: "not-a-token", limit: 100 },
    { sourceId: selectedSource, directoryContinuationToken: "a", projectContinuationToken: "b", limit: 100 },
    { sourceId: selectedSource, directoryContinuationToken: "a" },
    { sourceId: selectedSource, apiKey: "browser-secret" },
  ])("rejects invalid or additional input before synchronization: %j", async body => {
    expect((await fixture().send(body)).status).toBe(400);
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns encrypted continuation only and audits cursor presence without raw cursor or token", async () => {
    const response = await fixture().send({ sourceId: selectedSource });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: "completed",
      directory: { status: "persisted", itemCount: 3, conflictCount: 0, hasMore: true },
      projects: { status: "persisted", itemCount: 2, conflictCount: 0, hasMore: true } });
    const result = body as { directory: { continuationToken: string }; projects: { continuationToken: string } };
    expect(result.directory.continuationToken).not.toContain("client:aaaaaaaa");
    expect(result.projects.continuationToken).not.toContain("private-project-cursor");
    const serialized = JSON.stringify(body);
    for (const privateValue of ["client:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "private-project-cursor"])
      expect(serialized).not.toContain(privateValue);
    expect(mocks.audit.mock.calls[0]?.[7]).toMatchObject({ directory: { hasMore: true }, projects: { hasMore: true } });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), principal,
      "integration.project_alpha_api_v2_sync_page_completed",
      "project_alpha_api_v2_sync_page", "bounded_page", null, expect.any(Object),
    );
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("client:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("private-project-cursor");
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(result.directory.continuationToken);
    expect(mocks.batch).toHaveBeenCalledWith([{}]);
  });

  it("sanitizes partial, blocked, and conflicted outcomes without returning cursors", async () => {
    mocks.run.mockResolvedValueOnce({
      status: "partial",
      directory: { status: "conflicted", itemCount: 1, conflictCount: 2, nextCursor: null, continuationIdentity: identity },
      projects: { status: "blocked", reason: "binding_stale" },
    });
    expect(await (await fixture().send()).json()).toEqual({
      status: "partial",
      directory: { status: "conflicted", itemCount: 1, conflictCount: 2, hasMore: false },
      projects: { status: "blocked", reason: "binding_stale" },
    });

    mocks.run.mockResolvedValueOnce({ status: "blocked", reason: "connection" });
    expect(await (await fixture().send()).json()).toEqual({ status: "blocked", reason: "connection" });
  });

  it("is mounted after the normal authenticated mutation middleware", () => {
    const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
    const mutation = source.indexOf('app.use("/api/*"');
    const csrf = source.indexOf("await requireMutationSecurity", mutation);
    const route = source.indexOf("registerProjectAlphaApiV2SyncRoutes(app)");
    expect(mutation).toBeGreaterThanOrEqual(0);
    expect(csrf).toBeGreaterThan(mutation);
    expect(route).toBeGreaterThan(csrf);
  });
});
