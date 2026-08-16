import { describe, expect, it, vi } from "vitest";
import type { ViewerDurableOperation, ViewerDurableOperationResponse } from "@ltds/shared";
import { ViewerAdminClient } from "../src/client/viewer-admin-client";
import {
  parseViewerOperationCheckpoints,
  pollViewerOperation,
  readViewerOperationCheckpoints,
  startViewerOperation,
  writeViewerOperationCheckpoint,
  type ViewerOperationCheckpoint,
} from "../src/client/viewer-operation";

const dataset = {
  id: "22222222-2222-4222-8222-222222222222", projectId: "66666666-6666-4666-8666-666666666666",
  displayName: "Flight", description: null, sourceType: "upload", storageMode: "managed" as const,
  rootKey: "datasets", relativePath: "flight", status: "finalized" as const, manifestSha256: "a".repeat(64),
  fileCount: 1, byteSize: 1, metadata: {}, createdBy: "ops:staff-one", finalizedAt: "2026-08-16T12:02:00.000Z",
  createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:02:00.000Z", archivedAt: null, trashedAt: null,
};
const queued: ViewerDurableOperation = {
  id: "11111111-1111-4111-8111-111111111111", type: "upload_finalize", subject: "ops:staff-one",
  datasetId: dataset.id, uploadId: "33333333-3333-4333-8333-333333333333", status: "queued", progress: 0,
  result: null, errorCode: null, errorMessage: null, createdAt: "2026-08-16T12:00:00.000Z",
  updatedAt: "2026-08-16T12:00:00.000Z", completedAt: null,
};
const checkpoint: ViewerOperationCheckpoint = {
  version: 1, operationId: queued.id, type: queued.type, datasetId: queued.datasetId,
  uploadId: queued.uploadId, createdAt: queued.createdAt,
};

describe("Viewer durable operations", () => {
  it("stores only bounded credential-free operation identity and fails closed on storage errors", () => {
    expect(parseViewerOperationCheckpoints(JSON.stringify([checkpoint]), Date.parse("2026-08-16T12:01:00.000Z"))).toEqual([checkpoint]);
    expect(parseViewerOperationCheckpoints(JSON.stringify([{ ...checkpoint, uploadToken: "secret" }]), Date.parse("2026-08-16T12:01:00.000Z"))).toEqual([]);
    const denied = { getItem() { throw new DOMException("denied", "SecurityError"); }, removeItem() {}, setItem() { throw new DOMException("full", "QuotaExceededError"); } } as unknown as Storage;
    expect(readViewerOperationCheckpoints(denied)).toEqual([]);
    expect(writeViewerOperationCheckpoint(checkpoint, denied)).toBe(false);
  });

  it("replays an ambiguous start with the same idempotency key and validates canonical 202 Location", async () => {
    const requestWithMetadata = vi.fn()
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValue({ payload: { operation: queued }, status: 202, location: `/api/v1/operations/${queued.id}`, retryAfterSeconds: 2 });
    const client = { requestWithMetadata } as unknown as ViewerAdminClient;
    const storage = globalThis.localStorage;
    const result = await startViewerOperation(client, "/api/v1/admin/uploads/upload/finalize", {
      method: "POST", headers: { "Idempotency-Key": "stable-key" }, body: "{}",
    }, "upload_finalize");
    expect(result.operation).toEqual(queued);
    expect(requestWithMetadata).toHaveBeenCalledTimes(2);
    expect(new Headers(requestWithMetadata.mock.calls[0]![1].headers).get("Idempotency-Key")).toBe("stable-key");
    expect(new Headers(requestWithMetadata.mock.calls[1]![1].headers).get("Idempotency-Key")).toBe("stable-key");
    if (storage) storage.removeItem("ltds.viewer.processing-operations.v1");
  });

  it("accepts only the matching subject-bound operation and terminal dataset", async () => {
    const succeeded: ViewerDurableOperationResponse = { operation: {
      ...queued, status: "succeeded", progress: 1, result: { dataset },
      updatedAt: "2026-08-16T12:02:00.000Z", completedAt: "2026-08-16T12:02:00.000Z",
    } };
    const client = { request: vi.fn().mockResolvedValue(succeeded) } as unknown as ViewerAdminClient;
    const progress = vi.fn();
    await expect(pollViewerOperation(client, checkpoint, progress)).resolves.toEqual(succeeded.operation);
    expect(progress).toHaveBeenCalledWith(succeeded.operation);
    expect(client.request).toHaveBeenCalledWith(`/api/v1/operations/${queued.id}`, { signal: undefined });
  });

  it("rejects a non-canonical Location before checkpointing", async () => {
    const client = { requestWithMetadata: vi.fn().mockResolvedValue({
      payload: { operation: queued }, status: 202, location: `https://evil.example/api/v1/operations/${queued.id}`, retryAfterSeconds: 2,
    }) } as unknown as ViewerAdminClient;
    await expect(startViewerOperation(client, "/api/v1/finalize", { method: "POST", headers: { "Idempotency-Key": "key" }, body: "{}" }, "upload_finalize"))
      .rejects.toThrow("non-canonical");
  });
});
