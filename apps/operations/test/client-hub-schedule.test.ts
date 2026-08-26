import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const reconcile = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/client-hub-index", () => ({ reconcileClientHubIndex: reconcile }));
import worker from "../src/worker/index";

afterEach(() => { vi.restoreAllMocks(); reconcile.mockReset(); });
describe("isolated Client Hub schedule", () => {
  const event = { cron: "2-57/5 * * * *", scheduledTime: 1787702520000, noRetry() {} };
  it("awaits only the directory job and preserves the existing notification schedules", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toContain('"crons": ["*/15 * * * *", "*/5 * * * *", "2-57/5 * * * *", "17 * * * *"]');
    const env = new Proxy({} as Env, { get() { throw new Error("Unrelated job touched an environment binding"); } });
    const waitUntil = vi.fn(() => { throw new Error("Unexpected shared background work"); });
    const ctx = { waitUntil, passThroughOnException() {} } as unknown as ExecutionContext;
    reconcile.mockResolvedValue({ status: "progress", pages: 6 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await worker.scheduled(event, env, ctx);
    expect(reconcile.mock.calls).toHaveLength(1);
    if (reconcile.mock.calls[0]?.[0] !== env) throw new Error("Directory received the wrong environment");
    expect(waitUntil).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "client_hub.index.tick", status: "progress", pages: 6 }));
  });
  it("reports failure without leaking SQL or contact data and does not disguise the run as success", async () => {
    reconcile.mockRejectedValue(new Error("SQL contains private@example.test and secret"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled(event, {} as Env, {} as ExecutionContext))
      .rejects.toThrow("Client Hub directory reconciliation failed");
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "client_hub.index.error" }));
  });
});
