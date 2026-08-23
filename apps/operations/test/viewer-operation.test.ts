import { describe, expect, it, vi } from "vitest";
import type { ViewerDurableOperation, ViewerDurableOperationResponse } from "@ltds/shared";
import { ViewerAdminClient, ViewerAdminRequestError } from "../src/client/viewer-admin-client";
import {
  PENDING_OPERATION_REQUEST_KEY,
  parseViewerOperationCheckpoints,
  parseViewerPendingOperationRequests,
  pollViewerOperation,
  readViewerOperationCheckpoints,
  readViewerPendingOperationRequests,
  recoverViewerPendingOperations,
  startViewerOperation,
  writeViewerOperationCheckpoint,
  writeViewerPendingOperationRequest,
  type ViewerOperationCheckpoint,
  type ViewerPendingOperationRequest,
} from "../src/client/viewer-operation";

const TEST_NOW = Date.now();
const TEST_CREATED_AT = new Date(TEST_NOW - 60_000).toISOString();
const TEST_UPDATED_AT = new Date(TEST_NOW).toISOString();
const TEST_COMPLETED_AT = new Date(TEST_NOW + 60_000).toISOString();

const dataset = {
  id: "22222222-2222-4222-8222-222222222222", projectId: "66666666-6666-4666-8666-666666666666",
  displayName: "Flight", description: null, sourceType: "upload", storageMode: "managed" as const,
  rootKey: "datasets", relativePath: "flight", status: "finalized" as const, manifestSha256: "a".repeat(64),
  fileCount: 1, byteSize: 1, metadata: {}, tags: [], createdBy: "ops:staff-one", finalizedAt: "2026-08-16T12:02:00.000Z",
  createdAt: "2026-08-16T12:00:00.000Z", updatedAt: "2026-08-16T12:02:00.000Z", archivedAt: null, trashedAt: null,
};
const queued: ViewerDurableOperation = {
  id: "11111111-1111-4111-8111-111111111111", type: "upload_finalize", subject: "ops:staff-one",
  datasetId: dataset.id, uploadId: "33333333-3333-4333-8333-333333333333", status: "queued", progress: 0,
  result: null, errorCode: null, errorMessage: null, createdAt: TEST_CREATED_AT,
  updatedAt: TEST_UPDATED_AT, completedAt: null,
};
const checkpoint: ViewerOperationCheckpoint = {
  version: 1, operationId: queued.id, type: queued.type, datasetId: queued.datasetId,
  uploadId: queued.uploadId, createdAt: queued.createdAt,
};
const previewResult = {
  id: "77777777-7777-4777-8777-777777777777", previewToken: "p".repeat(43), expiresAt: TEST_COMPLETED_AT,
  preview: {
    rootKey: "dataset_import" as const, relativePath: "north/flight", fileCount: 1, byteSize: 12,
    treeFingerprint: "c".repeat(64),
    files: [{ relativePath: "photo.jpg", byteSize: 12, mtimeMs: 1_799_999_000_000, ctimeMs: 1_799_999_000_000 }],
    truncated: false, sameFilesystem: true,
    destinationSpace: { availableBytes: 1000, totalBytes: 2000, reserveBytes: 100, requiredBytes: 12, sufficient: true },
  },
};
const previewQueued: ViewerDurableOperation = {
  id: "88888888-8888-4888-8888-888888888888", type: "import_preview", subject: "ops:staff-one",
  datasetId: null, uploadId: null, status: "queued", progress: 0, result: null, errorCode: null, errorMessage: null,
  createdAt: TEST_CREATED_AT, updatedAt: TEST_UPDATED_AT, completedAt: null,
};
const previewCheckpoint: ViewerOperationCheckpoint = {
  version: 1, operationId: previewQueued.id, type: previewQueued.type, datasetId: null, uploadId: null,
  createdAt: previewQueued.createdAt,
};

const pending: ViewerPendingOperationRequest = {
  version: 1,
  key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  method: "POST",
  path: "/api/v1/admin/uploads/33333333-3333-4333-8333-333333333333/finalize",
  type: "upload_finalize",
  datasetId: dataset.id,
  uploadId: queued.uploadId,
  createdAt: TEST_CREATED_AT,
};

function receipt(operation: ViewerDurableOperation | null = queued) {
  return {
    receipt: {
      subject: "ops:staff-one", key: pending.key, method: "POST", path: pending.path,
      requestHash: "d".repeat(64), responseStatus: operation ? 202 : null,
      response: null, operationId: operation?.id ?? null,
      createdAt: TEST_CREATED_AT, updatedAt: TEST_UPDATED_AT,
    },
    operation,
  };
}

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear() { values.clear(); },
    getItem(key) { return values.get(key) ?? null; },
    key(index) { return [...values.keys()][index] ?? null; },
    removeItem(key) { values.delete(key); },
    setItem(key, value) { values.set(key, value); },
  };
}

describe("Viewer durable operations", () => {
  it("stores only bounded credential-free operation identity and fails closed on storage errors", () => {
    expect(parseViewerOperationCheckpoints(JSON.stringify([checkpoint]), TEST_NOW)).toEqual([checkpoint]);
    expect(parseViewerOperationCheckpoints(JSON.stringify([{ ...checkpoint, uploadToken: "secret" }]), TEST_NOW)).toEqual([]);
    const denied = { getItem() { throw new DOMException("denied", "SecurityError"); }, removeItem() {}, setItem() { throw new DOMException("full", "QuotaExceededError"); } } as unknown as Storage;
    expect(readViewerOperationCheckpoints(denied)).toEqual([]);
    expect(writeViewerOperationCheckpoint(checkpoint, denied)).toBe(false);
    expect(parseViewerOperationCheckpoints(JSON.stringify([previewCheckpoint]), TEST_NOW)).toEqual([previewCheckpoint]);
    expect(parseViewerOperationCheckpoints(JSON.stringify([{ ...previewCheckpoint, previewToken: "secret" }]), TEST_NOW)).toEqual([]);
    expect(parseViewerPendingOperationRequests(JSON.stringify([pending]), TEST_NOW)).toEqual([pending]);
    for (const forbidden of ["accessToken", "uploadToken", "previewToken", "grant", "body", "requestHash", "headers"])
      expect(parseViewerPendingOperationRequests(JSON.stringify([{ ...pending, [forbidden]: "secret" }]), TEST_NOW)).toEqual([]);
  });

  it("replays an ambiguous start with the same idempotency key and validates canonical 202 Location", async () => {
    const requestWithMetadata = vi.fn()
      .mockRejectedValueOnce(new TypeError("network reset"))
      .mockResolvedValue({ payload: { operation: queued }, status: 202, location: `/api/v1/operations/${queued.id}`, retryAfterSeconds: 2 });
    const client = { requestWithMetadata } as unknown as ViewerAdminClient;
    const storage = globalThis.localStorage;
    const result = await startViewerOperation(client, "/api/v1/admin/uploads/upload/finalize", {
      method: "POST", headers: { "Idempotency-Key": "stable-key" }, body: "{}",
    }, "upload_finalize", { datasetId: dataset.id, uploadId: queued.uploadId });
    expect(result.operation).toEqual(queued);
    expect(requestWithMetadata).toHaveBeenCalledTimes(2);
    expect(new Headers(requestWithMetadata.mock.calls[0]![1].headers).get("Idempotency-Key")).toBe("stable-key");
    expect(new Headers(requestWithMetadata.mock.calls[1]![1].headers).get("Idempotency-Key")).toBe("stable-key");
    if (storage) storage.removeItem("ltds.viewer.processing-operations.v1");
    storage?.removeItem(PENDING_OPERATION_REQUEST_KEY);
  });

  it("persists a credential-free receipt locator before the first POST byte", async () => {
    const storage = memoryStorage();
    const requestWithMetadata = vi.fn().mockImplementation(async () => {
      const saved = readViewerPendingOperationRequests(storage);
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ path: pending.path, type: "upload_finalize", datasetId: dataset.id, uploadId: queued.uploadId });
      expect(storage.getItem(PENDING_OPERATION_REQUEST_KEY)).not.toContain("upload-secret");
      return { payload: { operation: queued }, status: 202, location: `/api/v1/operations/${queued.id}`, retryAfterSeconds: 2 };
    });
    const client = { requestWithMetadata } as unknown as ViewerAdminClient;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    try {
      await startViewerOperation(client, pending.path, {
        method: "POST", headers: { "Idempotency-Key": pending.key }, body: JSON.stringify({ uploadToken: "upload-secret" }),
      }, "upload_finalize", { datasetId: dataset.id, uploadId: queued.uploadId });
      expect(readViewerPendingOperationRequests(storage)).toEqual([]);
    } finally {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });

  it("recovers an accepted operation after every POST response is lost", async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    const client = {
      requestWithMetadata: vi.fn().mockRejectedValue(new TypeError("response lost")),
      request: vi.fn().mockResolvedValue(receipt()),
    } as unknown as ViewerAdminClient;
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
    try {
      const promise = startViewerOperation(client, pending.path, {
        method: "POST", headers: { "Idempotency-Key": pending.key }, body: JSON.stringify({ uploadToken: "upload-secret" }),
      }, "upload_finalize", { datasetId: dataset.id, uploadId: queued.uploadId });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toMatchObject({ operation: queued, checkpoint });
      expect(client.requestWithMetadata).toHaveBeenCalledTimes(3);
      expect(client.request).toHaveBeenCalledWith(`/api/v1/operation-receipts/${pending.key}`);
      expect(readViewerPendingOperationRequests(storage)).toEqual([]);
      expect(readViewerOperationCheckpoints(storage)).toEqual([checkpoint]);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original });
    }
  });

  it("recovers after reload and session renewal without replaying a secret request body", async () => {
    const storage = memoryStorage();
    writeViewerPendingOperationRequest(pending, storage);
    const client = { request: vi.fn().mockResolvedValue(receipt()) } as unknown as ViewerAdminClient;
    await expect(recoverViewerPendingOperations(client, storage)).resolves.toEqual({ recovered: [checkpoint], unknown: 0, stillPending: 0 });
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(`/api/v1/operation-receipts/${pending.key}`);
    expect(readViewerPendingOperationRequests(storage)).toEqual([]);
    expect(readViewerOperationCheckpoints(storage)).toEqual([checkpoint]);
  });

  it("removes an authoritative unknown receipt but fails closed on receipt identity mismatch", async () => {
    const unknownStorage = memoryStorage();
    writeViewerPendingOperationRequest(pending, unknownStorage);
    const unknownClient = { request: vi.fn().mockRejectedValue(new ViewerAdminRequestError("not found", 404)) } as unknown as ViewerAdminClient;
    await expect(recoverViewerPendingOperations(unknownClient, unknownStorage)).resolves.toEqual({ recovered: [], unknown: 1, stillPending: 0 });
    expect(readViewerPendingOperationRequests(unknownStorage)).toEqual([]);

    const mismatchStorage = memoryStorage();
    writeViewerPendingOperationRequest(pending, mismatchStorage);
    const mismatch = receipt(); mismatch.receipt.path = "/api/v1/different";
    const mismatchClient = { request: vi.fn().mockResolvedValue(mismatch) } as unknown as ViewerAdminClient;
    await expect(recoverViewerPendingOperations(mismatchClient, mismatchStorage)).rejects.toThrow("mismatched operation receipt");
    expect(readViewerPendingOperationRequests(mismatchStorage)).toEqual([pending]);
  });

  it("accepts only the matching subject-bound operation and terminal dataset", async () => {
    const succeeded: ViewerDurableOperationResponse = { operation: {
      ...queued, status: "succeeded", progress: 1, result: { dataset },
      updatedAt: TEST_COMPLETED_AT, completedAt: TEST_COMPLETED_AT,
    } };
    const client = { request: vi.fn().mockResolvedValue(succeeded) } as unknown as ViewerAdminClient;
    const progress = vi.fn();
    await expect(pollViewerOperation(client, checkpoint, progress)).resolves.toEqual(succeeded.operation);
    expect(progress).toHaveBeenCalledWith(succeeded.operation);
    expect(client.request).toHaveBeenCalledWith(`/api/v1/operations/${queued.id}`, { signal: undefined });
  });

  it("starts and polls a durable import preview without persisting its terminal token", async () => {
    const requestWithMetadata = vi.fn().mockResolvedValue({
      payload: { operation: previewQueued }, status: 202,
      location: `/api/v1/operations/${previewQueued.id}`, retryAfterSeconds: 2,
    });
    const startClient = { requestWithMetadata } as unknown as ViewerAdminClient;
    const started = await startViewerOperation(startClient, "/api/v1/dataset-imports/preview", {
      method: "POST", headers: { "Idempotency-Key": "preview-key" },
      body: JSON.stringify({ rootKey: "dataset_import", relativePath: "north/flight" }),
    }, "import_preview", { datasetId: null, uploadId: null });
    expect(started.checkpoint).toEqual(previewCheckpoint);

    const succeeded: ViewerDurableOperationResponse = { operation: {
      ...previewQueued, status: "succeeded", progress: 1, result: previewResult,
      updatedAt: TEST_COMPLETED_AT, completedAt: TEST_COMPLETED_AT,
    } };
    const pollClient = { request: vi.fn().mockResolvedValue(succeeded) } as unknown as ViewerAdminClient;
    await expect(pollViewerOperation(pollClient, previewCheckpoint, vi.fn())).resolves.toEqual(succeeded.operation);
    expect(JSON.stringify(started.checkpoint)).not.toContain(previewResult.previewToken);
    globalThis.localStorage?.removeItem("ltds.viewer.processing-operations.v1");
  });

  it("rejects a preview terminal result with noncanonical identity fields", async () => {
    const invalid: ViewerDurableOperationResponse = { operation: {
      ...previewQueued, datasetId: dataset.id, status: "succeeded", progress: 1, result: previewResult,
      updatedAt: "2026-08-16T12:02:00.000Z", completedAt: "2026-08-16T12:02:00.000Z",
    } };
    const client = { request: vi.fn().mockResolvedValue(invalid) } as unknown as ViewerAdminClient;
    await expect(pollViewerOperation(client, previewCheckpoint, vi.fn())).rejects.toThrow("mismatched durable operation");
  });

  it("rejects a non-canonical Location before checkpointing", async () => {
    const client = { requestWithMetadata: vi.fn().mockResolvedValue({
      payload: { operation: queued }, status: 202, location: `https://evil.example/api/v1/operations/${queued.id}`, retryAfterSeconds: 2,
    }) } as unknown as ViewerAdminClient;
    await expect(startViewerOperation(client, "/api/v1/finalize", { method: "POST", headers: { "Idempotency-Key": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }, body: "{}" }, "upload_finalize", { datasetId: dataset.id, uploadId: queued.uploadId }))
      .rejects.toThrow("non-canonical");
  });
});
