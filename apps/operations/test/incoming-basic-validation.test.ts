import { describe, expect, it } from "vitest";
import { validateIncomingBasicSample } from "../src/worker/incoming-basic-validation";

function input(bytes = 8192) {
  const identity = { objectEtag: "a".repeat(32), objectBytes: bytes, objectVersion: "version-1" };
  return { originalName: "photos.zip", contentType: "application/zip", declaredBytes: bytes,
    expected: { ...identity }, observed: { ...identity }, sample: new Uint8Array(Math.min(bytes, 4096)) };
}

describe("incoming bounded basic validation", () => {
  it("records a format check without claiming antivirus or pickup", () => {
    const value = input();
    value.sample.set([0x50, 0x4b, 3, 4]);
    expect(validateIncomingBasicSample(value)).toEqual({ ...value.expected, checkVersion: "basic-v1" });
  });
  it("requires only a bounded prefix even for the maximum supported upload", () => {
    expect(validateIncomingBasicSample(input(2 * 1024 ** 4)).objectBytes).toBe(2 * 1024 ** 4);
  });
  it("accepts complete short objects but rejects empty, short and oversized samples", () => {
    expect(validateIncomingBasicSample(input(3)).objectBytes).toBe(3);
    for (const size of [0, 4095, 4097]) {
      expect(() => validateIncomingBasicSample({ ...input(), sample: new Uint8Array(size) })).toThrow("sample_incomplete");
    }
  });
  it("rejects changed content, versions, sizes and missing identity", () => {
    for (const patch of [{ objectEtag: "b".repeat(32) }, { objectVersion: "version-2" }, { objectBytes: 1 }]) {
      const value = input();
      expect(() => validateIncomingBasicSample({ ...value, observed: { ...value.observed, ...patch } })).toThrow("object_changed");
    }
    const value = input();
    expect(() => validateIncomingBasicSample({ ...value, declaredBytes: 8193 })).toThrow("object_changed");
    expect(() => validateIncomingBasicSample({ ...value, expected: { ...value.expected, objectVersion: "" } })).toThrow("object_changed");
  });
  it("retains existing filename and executable-signature rejection", () => {
    expect(() => validateIncomingBasicSample({ ...input(), originalName: "payload.exe" })).toThrow();
    expect(() => validateIncomingBasicSample({ ...input(), originalName: "../photos.zip" })).toThrow();
    const value = input();
    value.sample.set([0x4d, 0x5a]);
    expect(() => validateIncomingBasicSample(value)).toThrow("signature_rejected");
  });
});
