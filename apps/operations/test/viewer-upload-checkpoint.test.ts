import { afterEach, describe, expect, it } from "vitest";
import { clearUploadCheckpoint, parseUploadCheckpoint, readUploadCheckpoint, uploadManifestSignature, writeUploadCheckpoint } from "../src/client/upload-checkpoint";

const now = Date.parse("2026-08-16T12:00:00Z");
const valid = {
  version: 1 as const, signature: "a".repeat(64), projectId: "project-one", displayName: "Flight one",
  datasetId: "dataset-one", expiresAt: now + 60_000,
  files: [{ id: "file-one", relativePath: "flight/DCIM/IMG_0001.JPG", byteSize: 10, sha256: "b".repeat(64), contentType: "image/jpeg", processingRole: "image" as const }],
};

describe("Viewer upload resume checkpoint", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  afterEach(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
  it("accepts bounded non-secret metadata needed to reselect and resume", () => {
    expect(parseUploadCheckpoint(JSON.stringify(valid), now)).toEqual(valid);
  });

  it("binds an explicit processing role into the resumable manifest signature", async () => {
    const image = await uploadManifestSignature(valid.projectId, valid.displayName, valid.files);
    const providerInput = await uploadManifestSignature(valid.projectId, valid.displayName, [{ ...valid.files[0]!, processingRole: "provider_input" }]);
    expect(providerInput).not.toBe(image);
  });

  it("rejects expired, malformed, oversized, or credential-bearing state", () => {
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, expiresAt: now - 1 }), now)).toBeNull();
    expect(parseUploadCheckpoint("{", now)).toBeNull();
    expect(parseUploadCheckpoint("x".repeat(1024 * 1024 + 1), now)).toBeNull();
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, uploadToken: "secret" }), now)).toBeNull();
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, accessToken: "secret" }), now)).toBeNull();
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, projectId: "../project" }), now)).toBeNull();
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, files: [{ ...valid.files[0], processingRole: "provider-secret" }] }), now)).toBeNull();
    expect(parseUploadCheckpoint(JSON.stringify({ ...valid, files: [...valid.files, { ...valid.files[0], id: "file-two", relativePath: "FLIGHT/dcim/img_0001.jpg" }] }), now)).toBeNull();
  });

  it("gracefully disables durable resume when browser storage is denied or full", () => {
    const denied = {
      getItem() { throw new DOMException("denied", "SecurityError"); },
      removeItem() { throw new DOMException("denied", "SecurityError"); },
      setItem() { throw new DOMException("quota", "QuotaExceededError"); },
    } as unknown as Storage;
    expect(readUploadCheckpoint(denied)).toBeNull();
    expect(writeUploadCheckpoint(valid, denied)).toBe(false);
  });

  it("catches a throwing global localStorage getter during read, write, and clear", () => {
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() { throw new DOMException("blocked", "SecurityError"); },
    });
    expect(readUploadCheckpoint()).toBeNull();
    expect(writeUploadCheckpoint(valid)).toBe(false);
    expect(() => clearUploadCheckpoint()).not.toThrow();
  });
});
