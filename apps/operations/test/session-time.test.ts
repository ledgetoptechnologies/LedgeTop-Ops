import { describe, expect, it } from "vitest";
import { readSessionTiming, formatSessionRemaining } from "../src/client/session-time";
import { staffSessionStatus } from "../src/worker/session-status";

describe("verified session time", () => {
  const now = Date.parse("2026-10-18T04:00:00Z");
  const expiry = now / 1000 + 3661;

  it("reports only the authenticated principal's expiry with server time, not credentials", () => {
    const status = staffSessionStatus({ id: "staff-1", accessExpiresAt: expiry }, now);
    expect(status).toEqual({ userId: "staff-1", expiresAt: "2026-10-18T05:01:01.000Z", serverTime: "2026-10-18T04:00:00.000Z" });
    const timing = readSessionTiming(status, "staff-1");
    // No dependency on the browser wall clock, which may be in another zone or wrong.
    expect(formatSessionRemaining(timing.expiresAt! - timing.serverTime)).toBe("1h 1m 1s");
  });

  it.each([undefined, NaN, Infinity, -1, 0, 1.5, Number.MAX_SAFE_INTEGER])(
    "does not invent a session lifetime for invalid or missing expiry %s", (accessExpiresAt) => {
      expect(staffSessionStatus({ id: "staff-1", accessExpiresAt }, now).expiresAt).toBeNull();
    });

  it("preserves expired deadlines and clamps the countdown at zero", () => {
    const timing = readSessionTiming(staffSessionStatus({ id: "staff-1", accessExpiresAt: now / 1000 - 1 }, now), "staff-1");
    expect(timing.expiresAt).toBeLessThan(timing.serverTime);
    expect(formatSessionRemaining(-1000)).toBe("0m 0s");
    expect(formatSessionRemaining(1)).toBe("0m 1s");
    expect(formatSessionRemaining(60_000)).toBe("1m 0s");
  });

  it("rejects another identity, missing status and malformed times", () => {
    const status = staffSessionStatus({ id: "staff-1", accessExpiresAt: expiry }, now);
    for (const value of [null, {}, { ...status, userId: "other" }, { ...status, expiresAt: "invalid" },
      { ...status, serverTime: "invalid" }, { ...status, expiresAt: undefined }])
      expect(() => readSessionTiming(value, "staff-1")).toThrow("Invalid session status");
  });
});
