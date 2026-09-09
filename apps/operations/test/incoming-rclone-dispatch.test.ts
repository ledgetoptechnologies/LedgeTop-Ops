import { describe, expect, it, vi } from "vitest";
import { dispatchIncomingRcloneSegment, incomingPromotionInstanceId } from "../src/worker/incoming-rclone-dispatch";

const input = { uploadId: "upload-123", segment: 0, consecutiveFailures: 0 };

describe("incoming promotion dispatch", () => {
  it("uses stable bounded source-specific IDs", async () => {
    const id = await incomingPromotionInstanceId(input);
    expect(id.length).toBeLessThanOrEqual(100);
    expect(await incomingPromotionInstanceId(input)).toBe(id);
    expect(await incomingPromotionInstanceId({ ...input, segment: 1 })).not.toBe(id);
    expect(await incomingPromotionInstanceId({ ...input, uploadId: "upload-456" })).not.toBe(id);
  });
  it.each([{ segment: -1 }, { segment: 2001 }, { consecutiveFailures: 4 }, { uploadId: "../oops" }])("rejects invalid input %j", async patch => {
    await expect(incomingPromotionInstanceId({ ...input, ...patch })).rejects.toThrow("invalid_segment");
  });
  it("creates one job without looking up unrelated jobs", async () => {
    const create = vi.fn().mockResolvedValue({});
    const get = vi.fn();
    const result = await dispatchIncomingRcloneSegment({ create, get }, input);
    expect(result.reused).toBe(false);
    expect(create).toHaveBeenCalledWith({ id: result.id, params: input });
    expect(get).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "waiting", "complete"])("confirms a lost create response using exact %s instance", async status => {
    const get = vi.fn().mockResolvedValue({ status: async () => ({ status }) });
    const result = await dispatchIncomingRcloneSegment({ create: vi.fn().mockRejectedValue(new Error("lost")), get }, input);
    expect(result.reused).toBe(true);
    expect(get).toHaveBeenCalledWith(result.id);
  });
  it.each(["errored", "terminated", "paused", "unknown"])("does not hide %s dispatch state", async status => {
    await expect(dispatchIncomingRcloneSegment({ create: vi.fn().mockRejectedValue(new Error("lost")),
      get: vi.fn().mockResolvedValue({ status: async () => ({ status }) }) }, input)).rejects.toThrow("dispatch_unconfirmed");
  });
  it("does not interpret an observation failure as successful dispatch", async () => {
    await expect(dispatchIncomingRcloneSegment({ create: vi.fn().mockRejectedValue(new Error("lost")),
      get: vi.fn().mockRejectedValue(new Error("unreachable")) }, input)).rejects.toThrow("dispatch_unconfirmed");
  });
});
