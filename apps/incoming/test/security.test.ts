import { describe, expect, it } from "vitest";
import { hasBlockedMagic, presignR2Part, validateIncomingFile } from "../src/security";

describe("incoming upload security", () => {
  it("rejects executable and active web content", () => {
    expect(() => validateIncomingFile("payload.exe", "application/octet-stream", 10)).toThrow();
    expect(() => validateIncomingFile("photo.svg", "image/svg+xml", 10)).toThrow();
    expect(() => validateIncomingFile("../photo.jpg", "image/jpeg", 10)).toThrow();
    expect(validateIncomingFile("ground photo.jpg", "image/jpeg", 200 * 1024 ** 2)).toBe("ground photo.jpg");
  });

  it("recognizes basic executable and active document signatures", () => {
    expect(hasBlockedMagic(new Uint8Array([0x4d, 0x5a, 0, 0]))).toBe(true);
    expect(hasBlockedMagic(new TextEncoder().encode("<!doctype html><title>x</title>"))).toBe(true);
    expect(hasBlockedMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });

  it("generates a bounded SigV4 multipart URL", async () => {
    const url = await presignR2Part({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "ltds-incoming",
      key: "quarantine/request/file/photo 1.jpg",
      uploadId: "upload+id",
      partNumber: 2,
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      now: new Date("2026-07-23T12:00:00Z"),
    });
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("partNumber=2");
    expect(url).toContain("uploadId=upload%2Bid");
    expect(url).toContain("photo%201.jpg");
    expect(url).toMatch(/X-Amz-Signature=[a-f0-9]{64}$/);
    const unsignedNames = new URL(url).search.slice(1).split("&").slice(0, -1).map(part => part.split("=")[0]);
    expect(unsignedNames).toEqual([...unsignedNames].sort());
  });
});
