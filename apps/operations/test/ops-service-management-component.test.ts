import { describe, expect, it } from "vitest";
import { createOpsServiceLoadGuard, currentOpsServiceState } from "../src/client/OpsServiceManagement";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

describe("Operations service management client binding", () => {
  it("ignores a late A response after switching to B", async () => {
    const guard = createOpsServiceLoadGuard(), a = deferred<string>(), b = deferred<string>();
    const rendered: string[] = [];
    const ticketA = guard.begin("client-a");
    const pendingA = a.promise.then(value => { if (guard.current(ticketA)) rendered.push(value); });
    const ticketB = guard.begin("client-b");
    expect(currentOpsServiceState({ customerRecordId: "client-a", definitions: [], enrollments: [] }, "client-b")).toBeNull();
    const pendingB = b.promise.then(value => { if (guard.current(ticketB)) rendered.push(value); });
    a.resolve("stale-a"); await pendingA;
    expect(rendered).toEqual([]);
    b.resolve("current-b"); await pendingB;
    expect(rendered).toEqual(["current-b"]);
  });

  it("keeps a denied or missing B empty and never restores A", async () => {
    const guard = createOpsServiceLoadGuard(), a = deferred<string>(), b = deferred<string>();
    const rendered: string[] = [];
    const ticketA = guard.begin("client-a");
    const pendingA = a.promise.then(value => { if (guard.current(ticketA)) rendered.push(value); });
    const ticketB = guard.begin("client-b");
    const pendingB = b.promise.catch(() => { if (guard.current(ticketB)) rendered.length = 0; });
    b.reject(Object.assign(new Error("denied"), { status: 404 })); await pendingB;
    a.resolve("stale-a"); await pendingA;
    expect(rendered).toEqual([]);
  });
});
