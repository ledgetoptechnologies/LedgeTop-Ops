import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticateStaff: vi.fn(), authorizeItem: vi.fn(), isAdministrator: vi.fn(), search: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/acl")>(), isAdministrator: mocks.isAdministrator }));
vi.mock("../src/worker/delivery", async importOriginal => ({ ...await importOriginal<typeof import("../src/worker/delivery")>(), authorizeItem: mocks.authorizeItem }));
vi.mock("../src/worker/client-share-recipients", () => ({ searchClientShareRecipients: mocks.search }));

import worker from "../src/worker/index";
import type { Env as OperationsEnv } from "../src/worker/types";

const principal = { id: "staff-a", email: "staff@example.test", displayName: "Staff", accessSubject: "access-a", projectAlphaUserId: "pa-a" };
const context = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const env = { ENVIRONMENT: "development", EXPECTED_HOST: "ops.example", INCOMING_EXPECTED_HOST: "incoming.example", INCOMING_BASE_URL: "https://incoming.example",
  PUBLIC_BASE_URL: "https://ops.example", OPERATIONS_SESSION_SECRET: "share-route-test-secret-at-least-32-bytes" } as unknown as OperationsEnv;
const get = (query: string) => worker.fetch(new Request(`https://ops.example/api/delivery/client-share-recipients?${query}`), env, context);

describe("combined client share recipient route", () => {
  beforeEach(() => {
    Object.values(mocks).forEach(mock => mock.mockReset());
    mocks.authenticateStaff.mockResolvedValue(principal); mocks.isAdministrator.mockResolvedValue(false);
    mocks.authorizeItem.mockResolvedValue("Jobs/Clients/Harbor/");
    mocks.search.mockResolvedValue({ recipients: [], primary: "ready", native: "ready", truncated: false });
  });

  it("authorizes the folder before searching and never caches the answer", async () => {
    const response = await get("folderRef=folder-harbor&q=Harbor");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.authorizeItem).toHaveBeenCalledWith(env, principal, "folder-harbor");
    expect(mocks.search).toHaveBeenCalledWith(env, principal, "folder-harbor", "Jobs/Clients/Harbor/", "Harbor");
  });

  it("refuses an invalid folder reference and an unauthorized folder without searching", async () => {
    expect((await get("folderRef=..%2Fsecret&q=Harbor")).status).toBe(400);
    const { HTTPException } = await import("hono/http-exception");
    mocks.authorizeItem.mockRejectedValue(new HTTPException(403, { message: "Forbidden" }));
    expect((await get("folderRef=folder-other&q=Harbor")).status).toBe(403);
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("is read only", async () => {
    const response = await worker.fetch(new Request("https://ops.example/api/delivery/client-share-recipients?folderRef=folder-harbor&q=Harbor", { method: "POST" }), env, context);
    expect(response.status).not.toBe(200);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
