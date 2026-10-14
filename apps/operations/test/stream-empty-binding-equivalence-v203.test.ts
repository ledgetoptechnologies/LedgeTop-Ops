import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const mocks = vi.hoisted(() => ({
  authenticateStaff: vi.fn(async () => ({ id: "synthetic-staff", email: "staff@example.test", displayName: "Synthetic staff", accessSubject: "synthetic-subject", projectAlphaUserId: null })),
  isAdministrator: vi.fn(async () => true),
  authorizeItem: vi.fn(async () => "synthetic/video.mp4"),
}));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/auth", () => ({ authenticateStaff: mocks.authenticateStaff }));
vi.mock("../src/worker/acl", async importOriginal => ({ ...await importOriginal<object>(), isAdministrator: mocks.isAdministrator }));
vi.mock("../src/worker/delivery", async importOriginal => ({ ...await importOriginal<object>(), authorizeItem: mocks.authorizeItem }));
vi.mock("../src/worker/request-security", async importOriginal => ({ ...await importOriginal<object>(), requireMutationSecurity: vi.fn() }));
import { refreshStreamStatuses } from "../src/worker/file-events";
import worker from "../src/worker/index";

afterEach(() => vi.unstubAllGlobals());
describe("current203 omission of exactly empty Stream bindings", () => {
  it.each([undefined, ""])("account %s disables polling before DB/network even with a configured token", async account => {
    const prepare = vi.fn(() => { throw new Error("must not read delivery DB"); });
    const send = vi.fn(() => { throw new Error("must not contact Stream"); });
    vi.stubGlobal("fetch", send);
    const env = { STREAM_API_TOKEN: "synthetic-token", DELIVERY_DB: { prepare } } as unknown as Env;
    if (account !== undefined) env.STREAM_ACCOUNT_ID = account;
    expect(await refreshStreamStatuses(env)).toBe(0);
    expect(prepare).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
  it.each([undefined, ""])("customer %s produces identical404 before token signing for an authorized ready video", async customer => {
    const video = vi.fn(() => { throw new Error("must not sign a Stream ticket"); });
    const send = vi.fn(() => { throw new Error("must not contact upstream"); });
    vi.stubGlobal("fetch", send);
    const first = vi.fn(async () => ({ stream_uid: "synthetic-ready-video", stream_status: "ready" }));
    const prepare = vi.fn(() => ({ bind: () => ({ first }) }));
    const env = { ENVIRONMENT: "staging", EXPECTED_HOST: "ops.example.test", PUBLIC_BASE_URL: "https://ops.example.test",
      DELIVERY_DB: { withSession: () => ({ prepare }) }, STREAM: { video } } as unknown as Env;
    if (customer !== undefined) env.STREAM_CUSTOMER_CODE = customer;
    const response = await worker.fetch(new Request("https://ops.example.test/api/delivery/items/synthetic-ref/stream-ticket", { method: "POST" }), env,
      { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(response.status).toBe(404);expect(await response.json()).toEqual({ error: "Video preview unavailable" });
    expect(first).toHaveBeenCalledOnce();expect(video).not.toHaveBeenCalled();expect(send).not.toHaveBeenCalled();
  });
});
