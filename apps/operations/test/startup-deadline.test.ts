import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartupTimeout, withStartupDeadline } from "../src/client/startup-deadline";

describe("startup deadline", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("settles at the deadline even when the read ignores its abort, and drops a late answer", async () => {
    const outer = new AbortController();
    let finish!: (value: string) => void, seen!: AbortSignal;
    const result = withStartupDeadline(signal => { seen = signal; return new Promise<string>(resolve => { finish = resolve; }); }, outer.signal, 1000);
    const outcome = result.then(value => ({ value }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(999);
    expect(seen.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await outcome as { error: unknown }).error).toBeInstanceOf(StartupTimeout);
    expect(seen.aborted).toBe(true);
    // The caller's own signal stays live, so its "still mounted" check lets the failure render.
    expect(outer.signal.aborted).toBe(false);
    finish("late");
    await expect(result).rejects.toBeInstanceOf(StartupTimeout);
  });

  it("passes an answer through and clears its timer", async () => {
    const result = withStartupDeadline(() => Promise.resolve("ok"), new AbortController().signal, 1000);
    await expect(result).resolves.toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes a failure through unchanged", async () => {
    const failure = Object.assign(new Error("denied"), { status: 401 });
    await expect(withStartupDeadline(() => Promise.reject(failure), new AbortController().signal, 1000)).rejects.toBe(failure);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops on unmount without waiting for the deadline", async () => {
    const outer = new AbortController();
    let seen!: AbortSignal;
    const result = withStartupDeadline(signal => { seen = signal; return new Promise<never>(() => undefined); }, outer.signal, 1000);
    outer.abort();
    await expect(result).rejects.toBe(outer.signal.reason);
    expect(seen.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never starts a read for a caller that has already gone", async () => {
    const outer = new AbortController();
    outer.abort();
    const read = vi.fn(() => Promise.resolve("ok"));
    await expect(withStartupDeadline(read, outer.signal, 1000)).rejects.toBe(outer.signal.reason);
    expect(read).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
