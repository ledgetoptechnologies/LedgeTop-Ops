import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/types";

const runMonitor = vi.hoisted(() => vi.fn());
const selectRevision = vi.hoisted(() => vi.fn());
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {}, WorkerEntrypoint: class {}, DurableObject: class {} }));
vi.mock("../src/worker/project-alpha-api-v2-monitor-cycle", () => ({ runProjectAlphaApiV2MonitorCycle: runMonitor }));
vi.mock("../src/worker/project-alpha-api-v2-monitor-scheduler-selection", () => ({
  selectProjectAlphaApiV2MonitorSchedulerRevision: selectRevision }));

import worker, { PROJECT_ALPHA_API_V2_MONITOR_CRON } from "../src/worker/index";

const event = { cron: PROJECT_ALPHA_API_V2_MONITOR_CRON, scheduledTime: 1787751840000, noRetry() {} };
const waitUntil = vi.fn(() => { throw Error("unexpected detached work"); });
const context = new Proxy({} as ExecutionContext, { get(_target,key) {
  if (key === "waitUntil") return waitUntil;
  if (key === "passThroughOnException") return () => {};
  throw Error("unexpected context access");
} });

afterEach(() => { vi.restoreAllMocks(); runMonitor.mockReset(); selectRevision.mockReset(); waitUntil.mockClear(); });

function env(overrides: Record<string, unknown> = {}): Env {
  return { PROJECT_ALPHA_API_V2_MONITOR_ENABLED: "true", PROJECT_ALPHA_API_V2_MONITOR_REVISION: "3",
    PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT: "owner@example.test",
    PROJECT_ALPHA_API_V2_CONNECTIONS: "opaque-deployment-secret", OPS_DB: {} as D1Database,
    ...overrides } as unknown as Env;
}

describe("isolated Project Alpha API v2 monitor schedule", () => {
  it("registers a distinct default-off cron and does not touch bindings when disabled", async () => {
    const config = readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8");
    expect(config.match(/"3-58\/5 \* \* \* \*"/g)).toHaveLength(1);
    expect(config).toMatch(/"PROJECT_ALPHA_API_V2_MONITOR_ENABLED"\s*:\s*"false"/);
    expect(config).toMatch(/"PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT"\s*:\s*""/);
    const disabled = new Proxy({ PROJECT_ALPHA_API_V2_MONITOR_ENABLED: "false" } as Env,
      { get(target, key) { if (key === "PROJECT_ALPHA_API_V2_MONITOR_ENABLED")
        return target.PROJECT_ALPHA_API_V2_MONITOR_ENABLED; throw Error("unexpected binding access"); } });
    const log = vi.spyOn(console,"log").mockImplementation(() => {});
    await worker.scheduled(event,disabled,context);
    expect(runMonitor).not.toHaveBeenCalled();
    expect(selectRevision).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "project_alpha_api_v2.monitor.tick", status: "disabled" }));
  });

  it("passes the current audited revision and recipient, awaits only its own bounded cycle", async () => {
    const selected = env();
    selectRevision.mockResolvedValue({ status: "selected", revision: 7 });
    const result = { health: { status: "checked", verified: 1, unhealthy: 0,
      storageErrors: 0, contended: 0 }, alerts: { not_due: 1 } };
    let finish!: (value: typeof result) => void;
    runMonitor.mockImplementation(() => new Promise<typeof result>(resolve => { finish = resolve; }));
    const log = vi.spyOn(console,"log").mockImplementation(() => {});
    let returned = false;
    const pending = worker.scheduled(event,selected,context).then(() => { returned = true; });
    await vi.waitFor(() => expect(runMonitor).toHaveBeenCalledExactlyOnceWith(selected.OPS_DB,selected,{
      enabled: "true", connections: "opaque-deployment-secret",
      expectedMonitorRevision: 7, recipient: "owner@example.test" }));
    expect(returned).toBe(false);
    expect(waitUntil).not.toHaveBeenCalled();
    finish(result);
    await pending;
    expect(returned).toBe(true);
    expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      event: "project_alpha_api_v2.monitor.tick", status: "checked",
      health: result.health, alerts: result.alerts }));
  });

  it("uses the same deployment snapshot for selection and cycle after an await", async () => {
    const selected = env();
    let connectionReads = 0, recipientReads = 0;
    Object.defineProperty(selected,"PROJECT_ALPHA_API_V2_CONNECTIONS", { configurable: true,
      get: () => ++connectionReads === 1 ? "first-config" : "changed-config" });
    Object.defineProperty(selected,"PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT", { configurable: true,
      get: () => ++recipientReads === 1 ? "first@example.test" : "changed@example.test" });
    selectRevision.mockResolvedValue({ status: "selected", revision: 9 });
    runMonitor.mockResolvedValue({ health: { status: "checked", verified: 0, unhealthy: 0,
      storageErrors: 0, contended: 0 }, alerts: {} });
    vi.spyOn(console,"log").mockImplementation(() => {});
    await worker.scheduled(event,selected,context);
    // Inspect reads before matchers: deep comparison of the environment would
    // itself invoke these deliberately observable getters.
    expect(connectionReads).toBe(1);
    expect(recipientReads).toBe(1);
    expect(selectRevision).toHaveBeenCalledExactlyOnceWith(selected.OPS_DB,
      { enabled: "true", connections: "first-config" });
    expect(runMonitor).toHaveBeenCalledOnce();
    const call = runMonitor.mock.calls[0];
    if (!call) throw new Error("monitor cycle was not called");
    expect(call[0]).toBe(selected.OPS_DB);
    expect(call[1]).toBe(selected);
    expect(call[2]).toEqual(
      { enabled: "true", connections: "first-config", expectedMonitorRevision: 9,
        recipient: "first@example.test" });
  });

  it("skips an attributed disabled head without recipient or cycle I/O", async () => {
    selectRevision.mockResolvedValue({ status: "disabled" });
    const log = vi.spyOn(console,"log").mockImplementation(() => {});
    await worker.scheduled(event,env({ PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT: "" }),context);
    expect(runMonitor).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "project_alpha_api_v2.monitor.tick", status: "disabled" }));
  });

  it("rejects an absent recipient without probing or emailing", async () => {
    selectRevision.mockResolvedValue({ status: "selected", revision: 3 });
    const error = vi.spyOn(console,"error").mockImplementation(() => {});
    await expect(worker.scheduled(event,env({ PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT: "" }),context))
      .rejects.toThrow("Project Alpha API v2 monitoring failed");
    expect(runMonitor).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "project_alpha_api_v2.monitor.error" }));
  });

  it("sanitizes cycle failures and ignores unrelated crons", async () => {
    selectRevision.mockResolvedValue({ status: "selected", revision: 3 });
    const error = vi.spyOn(console,"error").mockImplementation(() => {});
    runMonitor.mockRejectedValueOnce(Error("private api key owner@example.test"));
    await expect(worker.scheduled(event,env(),context))
      .rejects.toThrow("Project Alpha API v2 monitoring failed");
    expect(error).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: "project_alpha_api_v2.monitor.error" }));
    runMonitor.mockClear();
    const untouched = new Proxy({} as Env, { get() { throw Error("unexpected binding access"); } });
    await worker.scheduled({ ...event, cron: "3 17 * * *" },untouched,context);
    expect(runMonitor).not.toHaveBeenCalled();
  });
});
