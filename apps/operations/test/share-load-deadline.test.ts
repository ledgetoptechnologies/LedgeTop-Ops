import { afterEach, describe, expect, it, vi } from "vitest";
import { activeShareLoadError, createShareLoadDeadline } from "../src/client/share-load-deadline";

describe("Operations active-share loading deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("aborts a stalled lookup and reports that no share was changed", () => {
    vi.useFakeTimers();
    const deadline = createShareLoadDeadline(250);
    expect(deadline.signal.aborted).toBe(false);
    vi.advanceTimersByTime(250);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.didTimeOut()).toBe(true);
    expect(activeShareLoadError(new DOMException("Aborted", "AbortError"), deadline.didTimeOut()))
      .toBe("The share status check took too long. No link was created or changed.");
  });

  it("distinguishes dialog cleanup from a real timeout", () => {
    vi.useFakeTimers();
    const deadline = createShareLoadDeadline(250);
    deadline.cancel();
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.didTimeOut()).toBe(false);
    expect(activeShareLoadError(new Error("Service unavailable"), false)).toBe("Service unavailable No link was created or changed.");
  });
});
