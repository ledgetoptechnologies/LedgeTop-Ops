import { describe, expect, it } from "vitest";
import { routeHandlerDrain } from "./browser/route-handler-drain";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("enrollment fixture handler teardown", () => {
  it("keeps routes installed through a delayed asset and work admitted during draining", async () => {
    const handlers = routeHandlerDrain(), first = deferred(), lateAsset = deferred();
    const tracked = handlers.track(first.promise);
    expect(tracked).toBe(first.promise);
    let admittedLate = false, routesRemoved = false;
    const admitLate = tracked.then(() => {
      admittedLate = true;
      handlers.track(lateAsset.promise);
    });
    const teardown = handlers.drain().then(() => { routesRemoved = true; });
    await Promise.resolve();
    expect(routesRemoved).toBe(false);
    first.resolve();
    await admitLate;
    await Promise.resolve();
    expect(admittedLate).toBe(true);
    expect(routesRemoved).toBe(false);
    lateAsset.resolve();
    await teardown;
    expect(routesRemoved).toBe(true);
  });

  it("returns the original rejected handler promise without swallowing its failure", async () => {
    const handlers = routeHandlerDrain(), failed = deferred(), error = new Error("fixture fulfillment failed");
    const tracked = handlers.track(failed.promise);
    expect(tracked).toBe(failed.promise);
    const observed = expect(tracked).rejects.toBe(error);
    const drained = handlers.drain();
    failed.reject(error);
    await observed;
    await drained;
  });

  it("finishes an empty drain and separately tracks requests admitted afterward", async () => {
    const handlers = routeHandlerDrain();
    await handlers.drain();
    const future = deferred();
    handlers.track(future.promise);
    let done = false;
    const nextDrain = handlers.drain().then(() => { done = true; });
    await Promise.resolve();
    expect(done).toBe(false);
    future.resolve();
    await nextDrain;
    expect(done).toBe(true);
  });
});
