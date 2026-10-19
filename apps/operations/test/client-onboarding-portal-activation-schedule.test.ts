import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const activate = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/client-onboarding-portal-activation", async importOriginal => ({
  ...await importOriginal<typeof import("../src/worker/client-onboarding-portal-activation")>(),
  processClientOnboardingPortalActivation: activate,
}));
import worker from "../src/worker/index";

afterEach(() => { vi.restoreAllMocks(); activate.mockReset(); });

describe("approved onboarding activation schedule", () => {
  const event = { cron: "13-58/15 * * * *", scheduledTime: 1787751840000, noRetry() {} };
  const context = () => ({ waitUntil: vi.fn(() => { throw Error("Detached task"); }), passThroughOnException() {} }) as unknown as ExecutionContext;

  it("awaits only activation and logs aggregate counts", async () => {
    const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
    expect(config.triggers.crons.filter((cron: string) => cron === event.cron)).toHaveLength(1);
    const env = new Proxy({} as Env, { get() { throw Error("Unrelated binding"); } });
    const ctx = context(), log = vi.spyOn(console, "log").mockImplementation(() => {});
    let finish!: (value: { processed: number; active: number }) => void, returned = false;
    activate.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const pending = worker.scheduled(event, env, ctx).then(() => { returned = true; });
    expect(activate).toHaveBeenCalledTimes(1);
    expect(activate.mock.calls[0]?.[0] === env).toBe(true);
    expect(returned).toBe(false);
    finish({ processed: 4, active: 1 });
    await pending;
    expect(returned).toBe(true);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "client_onboarding.portal_activation.tick", processed: 4, active: 1 }));
  });

  it("redacts failures and propagates a stable failure for scheduler visibility", async () => {
    activate.mockRejectedValue(Error("private client and remote key"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(worker.scheduled(event, {} as Env, context())).rejects.toThrow("Client onboarding portal activation failed");
    expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "client_onboarding.portal_activation.error" }));
  });

  it("leaves unrelated schedules alone", async () => {
    await worker.scheduled({ ...event, cron: "14-59/15 * * * *" }, {} as Env, context());
    expect(activate).not.toHaveBeenCalled();
  });
});
