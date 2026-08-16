import { afterEach, describe, expect, it } from "vitest";
import { readClientViewerUnits, writeClientViewerUnits } from "../src/client/viewer-units-preference";

describe("client Viewer unit preference", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  it("defaults closed to imperial for missing or unrecognized values", () => {
    expect(readClientViewerUnits({ getItem: () => null })).toBe("imperial");
    expect(readClientViewerUnits({ getItem: () => "feet" })).toBe("imperial");
    expect(readClientViewerUnits({ getItem: () => "metric" })).toBe("metric");
  });

  it("does not crash the portal when browser storage is denied or full", () => {
    expect(readClientViewerUnits({ getItem() { throw new DOMException("denied", "SecurityError"); } })).toBe("imperial");
    expect(writeClientViewerUnits("metric", { setItem() { throw new DOMException("full", "QuotaExceededError"); } })).toBe(false);
  });

  it("catches a throwing global localStorage getter before any storage method is called", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new DOMException("blocked", "SecurityError"); },
    });
    expect(readClientViewerUnits()).toBe("imperial");
    expect(writeClientViewerUnits("metric")).toBe(false);
  });
});
