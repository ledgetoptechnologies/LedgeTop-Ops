import { describe, expect, it } from "vitest";
import {
  INCOMING_PROMOTION_DRIVER_MAX_TRANSIENTS,
  runIncomingRclonePromotionDriver,
  type IncomingPromotionWorkflowStep,
} from "../src/worker/incoming-rclone-driver";
import type { IncomingPromotionStatus } from "../src/worker/incoming-rclone-promotion";

function status(state: IncomingPromotionStatus["state"], errorCode: string | null = null): IncomingPromotionStatus {
  return { uploadId: "upload-one", sourceKey: "quarantine/request-one/upload-one/object", destinationKey: "ready/request-one/upload-one/file.pdf",
    state, completedParts: 0, multipartUploadId: state === "copying" ? "multipart-one" : null, errorCode, publicationStartedAt: null, publishedAt: null,
    destinationEtag: null, destinationBytes: null, destinationVersion: null };
}

function workflowStep(): IncomingPromotionWorkflowStep & { names: string[]; sleeps: string[] } {
  const names: string[] = [], sleeps: string[] = [];
  return {
    names, sleeps,
    async do<T>(name: string, _config: unknown, callback: () => Promise<T>) { names.push(name); return callback(); },
    async sleep(name: string) { sleeps.push(name); },
  } as unknown as IncomingPromotionWorkflowStep & { names: string[]; sleeps: string[] };
}

describe("incoming rclone promotion workflow driver", () => {
  it("returns a bounded continuation instead of assuming a global workflow limit", async () => {
    const step = workflowStep();
    const result = await runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one", segment: 7, maxOperations: 2 }, step, {
      resume: async () => status("copying"),
    });
    expect(result).toMatchObject({ kind: "continue", continuation: { uploadId: "upload-one", segment: 8, reason: "operation_budget" } });
    expect(step.names).toEqual(["incoming-promotion-7-0", "incoming-promotion-7-1"]);
  });

  it("does not cache a transient copying error as a successful no-progress step", async () => {
    const step = workflowStep(); let calls = 0;
    const result = await runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one" }, step, {
      resume: async () => { calls += 1; return calls === 1 ? status("copying", "r2_timeout") : status("ready"); },
    });
    expect(result).toMatchObject({ kind: "terminal", status: { state: "ready" } });
    expect(calls).toBe(2);
    expect(step.sleeps).toEqual(["incoming-promotion-backoff-0-0"]);
  });

  it("throws a pending multipart-creation error rather than caching it as success", async () => {
    const step = workflowStep(); let calls = 0;
    const result = await runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one" }, step, {
      resume: async () => { calls += 1; return calls === 1 ? status("pending", "r2_create_timeout") : status("ready"); },
    });
    expect(result).toMatchObject({ kind: "terminal", status: { state: "ready" } });
    expect(calls).toBe(2);
    expect(step.sleeps).toEqual(["incoming-promotion-backoff-0-0"]);
  });

  it("bounds repeated transient failures and carries the uncertain status forward", async () => {
    const step = workflowStep();
    const result = await runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one" }, step, {
      resume: async () => status("copying", "r2_timeout"),
    });
    expect(result).toMatchObject({ kind: "continue", continuation: { reason: "transient_retry_exhausted", segment: 1 }, lastStatus: null });
    expect(step.names).toHaveLength(INCOMING_PROMOTION_DRIVER_MAX_TRANSIENTS);
    expect(step.sleeps).toHaveLength(INCOMING_PROMOTION_DRIVER_MAX_TRANSIENTS - 1);
  });

  it("preserves publishing uncertainty as an automatic terminal state", async () => {
    const step = workflowStep();
    const result = await runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one" }, step, {
      resume: async () => status("publishing", "complete_response_lost"),
    });
    expect(result).toMatchObject({ kind: "terminal", status: { state: "publishing", errorCode: "complete_response_lost" } });
    expect(step.names).toHaveLength(1);
  });

  it("rejects invalid continuation inputs before naming workflow steps", async () => {
    const step = workflowStep();
    await expect(runIncomingRclonePromotionDriver({} as never, { uploadId: "../bad" }, step)).rejects.toThrow("upload id");
    await expect(runIncomingRclonePromotionDriver({} as never, { uploadId: "upload-one", maxOperations: 17 }, step)).rejects.toThrow("operation budget");
  });
});
