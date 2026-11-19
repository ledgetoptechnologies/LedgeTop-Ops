// Administrator review logic: only 403 hides the panel, missing originals are never called stored, list pages merge
// without duplicates, stale answers are dropped, and each decision keeps one stable key across uncertain retries.
import { beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/client/api";
import { bannerSummary, createGenerations, failedItemText, mergeQueue, reviewAction, reviewErrorState, type ReviewItem, type ReviewStatus } from "../src/client/flight-logs/review-model";
import { isUncertain, operationKey, withOperationKey } from "../src/client/flight-logs/operation-keys";

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
}
beforeEach(() => { (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage(); });

const status = (patch: Partial<ReviewStatus["raw"]> = {}, withoutOriginal = 0): ReviewStatus => ({
  decoder: "waiting_for_key",
  raw: { retained: 10, waiting: 4, waitingReason: "waiting_for_key", decoding: 0, decoded: 3, failed: 3, failedByCode: { raw_missing: 2, corrupt_log: 1 }, lastUploadAt: null, ...patch },
  review: { unassigned: 1, conflict: 0, linked: 0, assigned: 0 },
  flights: { total: 960, withoutOriginal },
});
const item = (sha: string): ReviewItem => ({ rawSha256: sha, fileName: null, uploadedAt: "2026-11-01T00:00:00Z", parseStatus: "needs_parse", errorCode: null, attempts: 0,
  uploader: { pilotId: "p", pilotName: "P", deviceName: null, deviceModel: null }, summary: null, conflict: null });

describe("flight log review model", () => {
  it("only a 403 hides the panel; 503, 404, network errors and others are shown as unavailable", () => {
    expect(reviewErrorState(new ApiError("no", 403, {}))).toBe("forbidden");
    for (const error of [new ApiError("down", 503, {}), new ApiError("missing", 404, {}), new ApiError("boom", 500, {}), new TypeError("Failed to fetch"), undefined])
      expect(reviewErrorState(error)).toBe("unavailable");
  });

  it("missing originals are counted as received, never stored, and imported flights without originals are surfaced", () => {
    const banner = bannerSummary(status({}, 960));
    expect(banner).toMatchObject({ received: 10, stored: 8, missingOriginals: 2, waiting: 4, unreadableTotal: 1, flightsWithoutOriginal: 960 });
    expect(banner.waitingText).toContain("DJI key");
    expect(banner.unreadable).toEqual([{ code: "corrupt_log", count: 1, label: "unreadable log" }]);
    expect(failedItemText({ errorCode: "raw_missing" })).toBe("Original file missing on the Logs host");
    expect(failedItemText({ errorCode: "raw_missing" })).not.toContain("kept");
    expect(failedItemText({ errorCode: "corrupt_log" })).toContain("the original is kept");
    expect(bannerSummary(status({ waiting: 0 })).waitingText).toBe("");
    expect(bannerSummary(status({ waitingReason: "queued" })).waitingText).toBe("queued for decoding");
  });

  it("Show more appends without duplicates; a new list replaces", () => {
    const first = [item("a"), item("b")];
    expect(mergeQueue(first, [item("b"), item("c")], true).map(i => i.rawSha256)).toEqual(["a", "b", "c"]);
    expect(mergeQueue(first, [item("z")], false).map(i => i.rawSha256)).toEqual(["z"]);
  });

  it("an older request's answer is dropped once a newer request has started (out-of-order answers)", async () => {
    const generations = createGenerations();
    const applied: string[] = [];
    const request = (name: string, delay: number) => { const generation = generations.next();
      return new Promise<void>(resolve => setTimeout(() => { if (generations.isCurrent(generation)) applied.push(name); resolve(); }, delay)); };
    await Promise.all([request("old tab (slow)", 30), request("new tab (fast)", 1)]);
    expect(applied).toEqual(["new tab (fast)"]);
  });

  it("each decision has one stable key across uncertain retries; a different decision gets its own", async () => {
    const action = reviewAction.assign("a".repeat(64), "staff-1");
    expect(action).toBe(reviewAction.assign("a".repeat(64), "staff-1"));
    expect(reviewAction.assign("a".repeat(64), "staff-2")).not.toBe(action);
    expect(reviewAction.reassign("f1", "staff-1")).not.toBe(reviewAction.reassign("f1", "staff-2"));
    const keys: string[] = [];
    const lost = Object.assign(new Error("lost"), { status: 503 });
    await expect(withOperationKey("session", action, async key => { keys.push(key); throw lost; })).rejects.toThrow();
    expect(isUncertain("session", action)).toBe(true);
    await withOperationKey("session", action, async key => { keys.push(key); return "ok"; });
    expect(keys[0]).toBe(keys[1]);
    expect(operationKey("session", action)).not.toBe(keys[0]); // settled: a later, new decision gets a fresh key
  });
});
