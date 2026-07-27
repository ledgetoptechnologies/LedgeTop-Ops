import { describe, expect, it } from "vitest";
import {
  createIncomingSession,
  hasBlockedIncomingMagic,
  incomingMultipartPartSize,
  presignIncomingPart,
  validateIncomingFile,
  verifyIncomingSession,
} from "../src/worker/incoming-security";

describe("incoming upload security", () => {
  it("rejects executable, active, traversal, and oversized content", () => {
    expect(() => validateIncomingFile("payload.exe", "application/octet-stream", 10)).toThrow();
    expect(() => validateIncomingFile("photo.svg", "image/svg+xml", 10)).toThrow();
    expect(() => validateIncomingFile("../photo.jpg", "image/jpeg", 10)).toThrow();
    expect(validateIncomingFile("ground photo.jpg", "image/jpeg", 200 * 1024 ** 2)).toBe("ground photo.jpg");
  });

  it("recognizes blocked file signatures", () => {
    expect(hasBlockedIncomingMagic(new Uint8Array([0x4d, 0x5a, 0, 0]))).toBe(true);
    expect(hasBlockedIncomingMagic(new TextEncoder().encode("<!doctype html><title>x</title>"))).toBe(true);
    expect(hasBlockedIncomingMagic(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe(false);
  });

  it("generates a bounded SigV4 multipart URL", async () => {
    const url = await presignIncomingPart({
      accountId: "0123456789abcdef0123456789abcdef",
      bucket: "ltds-incoming",
      key: "quarantine/request/file/object",
      uploadId: "upload+id",
      partNumber: 2,
      accessKeyId: "access-key",
      secretAccessKey: "secret-key",
      now: new Date("2026-07-23T12:00:00Z"),
    });
    expect(url).toContain("X-Amz-Expires=300");
    expect(url).toContain("partNumber=2");
    expect(url).toContain("uploadId=upload%2Bid");
    expect(url).toMatch(/X-Amz-Signature=[a-f0-9]{64}$/);
  });

  it("keeps even a two TiB upload below the multipart part ceiling", () => {
    const size = 2 * 1024 ** 4;
    const partSize = incomingMultipartPartSize(size);
    expect(Math.ceil(size / partSize)).toBeLessThanOrEqual(10_000);
    expect(partSize % (5 * 1024 ** 2)).toBe(0);
  });

  it("invalidates contributor sessions when the request version changes", async () => {
    const secret = "a".repeat(64);
    const expiresAt = Date.now() + 60_000;
    const setCookie = await createIncomingSession(secret, "request", "contributor", 3, expiresAt);
    const cookie = setCookie.split(";")[0]!;
    await expect(verifyIncomingSession(secret, cookie, "request", 3)).resolves.toMatchObject({ contributorId: "contributor" });
    await expect(verifyIncomingSession(secret, cookie, "request", 4)).rejects.toThrow();
  });
});
