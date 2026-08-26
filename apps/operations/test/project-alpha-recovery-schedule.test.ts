import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const recover = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/project-alpha-snapshot-recovery", () => ({ runProjectAlphaSnapshotRecovery: recover, getProjectAlphaSnapshotRecoveryStatus: vi.fn() }));
import worker from "../src/worker/index";

afterEach(() => { vi.restoreAllMocks(); recover.mockReset(); });

describe("isolated secondary Alpha recovery schedule", () => {
  const event = { cron: "17 * * * *", scheduledTime: 1787703420000, noRetry() {} };
  const context = () => ({ waitUntil: vi.fn(() => { throw new Error("Unexpected detached work"); }), passThroughOnException() {} }) as unknown as ExecutionContext;

  it("preserves all other crons and awaits only the recovery job", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
    expect(config).toContain('"crons": ["*/15 * * * *", "*/5 * * * *", "2-57/5 * * * *", "17 * * * *", "4-59/15 * * * *"]');
    const env = new Proxy({} as Env, { get() { throw new Error("Unrelated job touched an environment binding"); } });
    const ctx = context();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    let finish!: (value: object) => void;
    recover.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    let returned = false;
    const pending = worker.scheduled(event, env, ctx).then(() => { returned = true; });
    expect(returned).toBe(false);
    expect(recover.mock.calls).toHaveLength(1);
    if (recover.mock.calls[0]?.[0] !== env) throw new Error("Recovery received the wrong environment");
    expect(recover.mock.calls[0]?.[1]).toBe(event.scheduledTime);
    const result = { status: "completed", attempted: 2, succeeded: 1, failed: 1, deferred: 0 };
    finish(result);
    await pending;
    expect(returned).toBe(true);
    expect(ctx.waitUntil).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "project_alpha.recovery.tick", ...result }));
  });

  it("reports a failed invocation without exposing connector SQL or secrets", async () => {
    recover.mockRejectedValue(new Error("private@example.test SELECT secret FROM credentials"));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = context();
    await expect(worker.scheduled(event, {} as Env, ctx)).rejects.toThrow("Project Alpha snapshot recovery failed");
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "project_alpha.recovery.error" }));
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });

  it("ignores unrelated schedule expressions without touching bindings", async () => {
    const env = new Proxy({} as Env, { get() { throw new Error("Unexpected environment access"); } });
    await worker.scheduled({ ...event, cron: "18 * * * *" }, env, context());
    expect(recover).not.toHaveBeenCalled();
  });
});
