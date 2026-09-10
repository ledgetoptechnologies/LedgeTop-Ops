import { describe, expect, it } from "vitest";
import {
  INCOMING_MAX_BYTES,
  R2_MULTIPART_MAX_PARTS,
  R2_MULTIPART_MIN_PART_BYTES,
  buildIncomingRcloneReadyPlan,
  planIncomingMultipartCopy,
  sanitizeIncomingReadyBasename,
} from "../src/worker/incoming-rclone-plan";

const requestId = "request_123";
const uploadId = "upload_456";

describe("incoming rclone ready planning", () => {
  it("keeps display input separate while creating a stable opaque ready key", () => {
    const input = { requestId, uploadId, originalName: "  client / report?.pdf. ", sourceBytes: 10, transferMode: "copy" as const };
    const first = buildIncomingRcloneReadyPlan(input);
    const second = buildIncomingRcloneReadyPlan(input);
    expect(first).toEqual(second);
    expect(first.sourceKey).toBe("quarantine/request_123/upload_456/object");
    expect(first.readyKey).toBe("ready/request_123/upload_456/client _ report_.pdf");
    expect(first.destinationPath).toBe("request_123/upload_456/client _ report_.pdf");
    expect(first.transferMode).toBe("copy");
  });

  it("uses the opaque upload id to prevent same-name collisions", () => {
    const left = buildIncomingRcloneReadyPlan({ requestId, uploadId: "upload_456", originalName: "photo.jpg", sourceBytes: 10, transferMode: "move" });
    const right = buildIncomingRcloneReadyPlan({ requestId, uploadId: "upload_789", originalName: "photo.jpg", sourceBytes: 10, transferMode: "move" });
    expect(left.safeBasename).toBe(right.safeBasename);
    expect(left.readyKey).not.toBe(right.readyKey);
    expect(right.transferMode).toBe("move");
  });

  it("makes Unicode and Windows-hostile names safe without inventing tenant names", () => {
    expect(sanitizeIncomingReadyBasename("e\u0301vidence\u202E.txt")).toBe("évidence_.txt");
    expect(sanitizeIncomingReadyBasename("CON.txt")).toBe("_CON.txt");
    expect(sanitizeIncomingReadyBasename("COM¹.txt")).toBe("_COM¹.txt");
    expect(sanitizeIncomingReadyBasename("LPT³")).toBe("_LPT³");
    expect(sanitizeIncomingReadyBasename("CONIN$.log")).toBe("_CONIN$.log");
    expect(sanitizeIncomingReadyBasename("CONOUT$")).toBe("_CONOUT$");
    expect(sanitizeIncomingReadyBasename("..\\AUX ")).toBe(".._AUX");
    expect(sanitizeIncomingReadyBasename("\u0000 / ")).toBe("_ _");
    expect(sanitizeIncomingReadyBasename(". ")).toBe("upload");
    const emoji = sanitizeIncomingReadyBasename("📷".repeat(100));
    expect(new TextEncoder().encode(emoji).byteLength).toBeLessThanOrEqual(255);
    const longPdf = sanitizeIncomingReadyBasename(`${"é".repeat(200)}.pdf`);
    expect(longPdf).toMatch(/\.pdf$/);
    expect(new TextEncoder().encode(longPdf).byteLength).toBeLessThanOrEqual(255);
  });

  it("rejects unsafe opaque identifiers", () => {
    expect(() => buildIncomingRcloneReadyPlan({ requestId: "../request", uploadId, originalName: "photo.jpg", sourceBytes: 10, transferMode: "copy" })).toThrow("request id");
    expect(() => buildIncomingRcloneReadyPlan({ requestId, uploadId: "short", originalName: "photo.jpg", sourceBytes: 10, transferMode: "copy" })).toThrow("upload id");
    expect(() => buildIncomingRcloneReadyPlan({ requestId, uploadId, originalName: "photo.jpg", sourceBytes: 10, transferMode: "link" as never })).toThrow("transfer mode");
  });

  it("plans bounded multipart copy for the current maximum incoming object", () => {
    const plan = planIncomingMultipartCopy(INCOMING_MAX_BYTES);
    expect(plan.partBytes).toBeGreaterThanOrEqual(R2_MULTIPART_MIN_PART_BYTES);
    expect(plan.partCount).toBeLessThanOrEqual(R2_MULTIPART_MAX_PARTS);
    expect(plan.lastPartBytes).toBeGreaterThan(0);
    expect(plan.partBytes * (plan.partCount - 1) + plan.lastPartBytes).toBe(INCOMING_MAX_BYTES);
    expect(() => planIncomingMultipartCopy(INCOMING_MAX_BYTES + 1)).toThrow();
    expect(() => planIncomingMultipartCopy(0)).toThrow();
    expect(() => planIncomingMultipartCopy(1.5)).toThrow();
    expect(() => planIncomingMultipartCopy(Number.NaN)).toThrow();
  });

  it("uses a minimum part at and around the exact boundary", () => {
    const exact = planIncomingMultipartCopy(R2_MULTIPART_MIN_PART_BYTES);
    const next = planIncomingMultipartCopy(R2_MULTIPART_MIN_PART_BYTES + 1);
    expect(exact).toMatchObject({ partBytes: R2_MULTIPART_MIN_PART_BYTES, partCount: 1, lastPartBytes: R2_MULTIPART_MIN_PART_BYTES });
    expect(next).toMatchObject({ partBytes: R2_MULTIPART_MIN_PART_BYTES, partCount: 2, lastPartBytes: 1 });
  });
});
