import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import type { IncomingEnv } from "../src/worker/incoming";
import type { IncomingPromotionSegment } from "../src/worker/incoming-rclone-dispatch";

const mocks = vi.hoisted(() => ({ drive: vi.fn(), dispatch: vi.fn(), enqueue: vi.fn(), exhausted: vi.fn() }));
vi.mock("cloudflare:workers", () => ({ WorkflowEntrypoint: class {
  constructor(_ctx: unknown, protected env: unknown) {}
} }));
vi.mock("../src/worker/incoming-rclone-driver", () => ({ runIncomingRclonePromotionDriver: mocks.drive }));
vi.mock("../src/worker/incoming-rclone-promotion", () => ({ markIncomingRclonePromotionExhausted: mocks.exhausted }));
vi.mock("../src/worker/incoming-rclone-outbox", () => ({
  enqueueIncomingRcloneSegment: mocks.enqueue,
  drainIncomingRcloneOutbox: mocks.dispatch,
}));
import { IncomingRclonePromotionWorkflow } from "../src/worker/incoming-rclone-workflow";

function fixture(enabled = "true", consecutiveFailures = 0) {
  const env = { INCOMING_RCLONE_PROMOTION_ENABLED: enabled, INCOMING_RCLONE_PROMOTION_WORKFLOW: {} } as IncomingEnv;
  const workflow = new IncomingRclonePromotionWorkflow({} as ExecutionContext, env);
  const sleep = vi.fn().mockResolvedValue(undefined);
  const step = { do: async (_name: string, configOrCallback: unknown, callback?: () => Promise<unknown>) => {
    return callback ? callback() : (configOrCallback as () => Promise<unknown>)();
  }, sleep, sleepUntil: vi.fn(), waitForEvent: vi.fn() } as WorkflowStep;
  const event: WorkflowEvent<IncomingPromotionSegment> = { payload: { uploadId: "upload-123", segment: 0, consecutiveFailures },
    instanceId: "test-instance", workflowName: "test-workflow", timestamp: new Date() };
  return { workflow, step, event, sleep, env };
}

describe("incoming promotion workflow orchestration", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.enqueue.mockResolvedValue({ enqueued: true }); mocks.dispatch.mockResolvedValue({ dispatched: 1, retrying: 0, attention: 0 }); });
  it("does no publication work while the release gate is disabled", async () => {
    const f = fixture("false");
    expect(await f.workflow.run(f.event, f.step)).toEqual({ state: "disabled" });
    expect(mocks.drive).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it.each(["ready", "publishing", "unavailable"])("does not schedule more work for %s", async state => {
    mocks.drive.mockResolvedValue({ kind: "terminal", status: { state } });
    const f = fixture();
    expect(await f.workflow.run(f.event, f.step)).toEqual({ state, uploadId: "upload-123" });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("hands off a bounded successful segment and clears the prior failure streak", async () => {
    mocks.drive.mockResolvedValue({ kind: "continue", continuation: { segment: 1, reason: "operation_budget" } });
    const f = fixture("true", 1);
    await f.workflow.run(f.event, f.step);
    expect(mocks.enqueue).toHaveBeenCalledWith(f.env,
      { uploadId: "upload-123", segment: 1, consecutiveFailures: 0 });
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]!);
  });
  it("backs off transient failures before creating the next segment", async () => {
    mocks.drive.mockResolvedValue({ kind: "continue", continuation: { segment: 1, reason: "transient_retry_exhausted" } });
    const f = fixture();
    await f.workflow.run(f.event, f.step);
    expect(f.sleep).toHaveBeenCalledWith("between-segment-retry", "5 minutes");
    expect(mocks.enqueue).toHaveBeenCalledWith(f.env,
      { uploadId: "upload-123", segment: 1, consecutiveFailures: 1 });
  });
  it("stops repeated failed segments through the pre-publication-only exhaustion helper", async () => {
    mocks.drive.mockResolvedValue({ kind: "continue", continuation: { segment: 1, reason: "transient_retry_exhausted" } });
    const f = fixture("true", 2);
    expect(await f.workflow.run(f.event, f.step)).toEqual({ state: "needs_attention", uploadId: "upload-123" });
    expect(mocks.exhausted).toHaveBeenCalledWith(f.env, "upload-123");
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
  it("persists continuation before a dispatcher outage so scheduled recovery can find it", async () => {
    mocks.drive.mockResolvedValue({ kind: "continue", continuation: { segment: 1, reason: "operation_budget" } });
    mocks.dispatch.mockRejectedValueOnce(new Error("temporary-database-outage"));
    const f = fixture();
    await expect(f.workflow.run(f.event, f.step)).rejects.toThrow("temporary-database-outage");
    expect(mocks.enqueue).toHaveBeenCalledWith(f.env, { uploadId: "upload-123", segment: 1, consecutiveFailures: 0 });
    expect(mocks.enqueue.mock.invocationCallOrder[0]).toBeLessThan(mocks.dispatch.mock.invocationCallOrder[0]!);
  });
});
