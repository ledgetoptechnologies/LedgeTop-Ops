import type {
  ViewerDurableOperation,
  ViewerDurableOperationResponse,
  ViewerDurableOperationType,
} from "@ltds/shared";
import { ViewerAdminClient } from "./viewer-admin-client";

export interface ViewerOperationCheckpoint {
  version: 1;
  operationId: string;
  type: ViewerDurableOperationType;
  datasetId: string;
  uploadId: string | null;
  createdAt: string;
}

export const OPERATION_CHECKPOINT_KEY = "ltds.viewer.processing-operations.v1";
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_CHECKPOINTS = 20;
const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

class ViewerOperationContractError extends Error {}

export function parseViewerOperationCheckpoints(raw: string | null, now = Date.now()): ViewerOperationCheckpoint[] {
  try {
    if (!raw || raw.length > MAX_CHECKPOINT_BYTES) return [];
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values) || values.length > MAX_CHECKPOINTS) return [];
    const seen = new Set<string>();
    const checkpoints: ViewerOperationCheckpoint[] = [];
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const created = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
      if (item.version !== 1 || typeof item.operationId !== "string" || !UUID.test(item.operationId) ||
        (item.type !== "upload_finalize" && item.type !== "import_adopt") ||
        typeof item.datasetId !== "string" || !UUID.test(item.datasetId) ||
        !(item.uploadId === null || typeof item.uploadId === "string" && UUID.test(item.uploadId)) ||
        !Number.isFinite(created) || created > now + 5 * 60_000 || now - created > MAX_CHECKPOINT_AGE_MS ||
        "accessToken" in item || "uploadToken" in item || "previewToken" in item || "grant" in item ||
        seen.has(item.operationId)) return [];
      if (item.type === "upload_finalize" && item.uploadId === null) return [];
      if (item.type === "import_adopt" && item.uploadId !== null) return [];
      seen.add(item.operationId);
      checkpoints.push(item as unknown as ViewerOperationCheckpoint);
    }
    return checkpoints;
  } catch { return []; }
}

function browserStorage(storage?: Storage): Storage | null {
  if (storage) return storage;
  try { return typeof localStorage === "undefined" ? null : localStorage; }
  catch { return null; }
}

export function readViewerOperationCheckpoints(storage?: Storage): ViewerOperationCheckpoint[] {
  const target = browserStorage(storage);
  if (!target) return [];
  try {
    const raw = target.getItem(OPERATION_CHECKPOINT_KEY);
    const parsed = parseViewerOperationCheckpoints(raw);
    if (raw && !parsed.length) target.removeItem(OPERATION_CHECKPOINT_KEY);
    return parsed;
  } catch { return []; }
}

function persist(checkpoints: ViewerOperationCheckpoint[], storage: Storage): boolean {
  try { storage.setItem(OPERATION_CHECKPOINT_KEY, JSON.stringify(checkpoints)); return true; }
  catch { return false; }
}

export function writeViewerOperationCheckpoint(checkpoint: ViewerOperationCheckpoint, storage?: Storage): boolean {
  const validated = parseViewerOperationCheckpoints(JSON.stringify([checkpoint]));
  if (!validated.length) throw new Error("Viewer returned an invalid durable operation checkpoint");
  const target = browserStorage(storage);
  if (!target) return false;
  const existing = readViewerOperationCheckpoints(target).filter(item => item.operationId !== checkpoint.operationId);
  return persist([...existing, checkpoint].slice(-MAX_CHECKPOINTS), target);
}

export function removeViewerOperationCheckpoint(operationId: string, storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    const remaining = readViewerOperationCheckpoints(target).filter(item => item.operationId !== operationId);
    if (remaining.length) target.setItem(OPERATION_CHECKPOINT_KEY, JSON.stringify(remaining));
    else target.removeItem(OPERATION_CHECKPOINT_KEY);
  } catch { /* durable recovery was unavailable already */ }
}

function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException("Stopped watching; the Viewer operation continues safely", "AbortError"));
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(new DOMException("Stopped watching; the Viewer operation continues safely", "AbortError"));
    }, { once: true });
  });
}

function validFinalizedDataset(value: unknown, datasetId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dataset = value as Record<string, unknown>;
  return dataset.id === datasetId && typeof dataset.projectId === "string" && typeof dataset.displayName === "string" &&
    (dataset.description === null || typeof dataset.description === "string") && typeof dataset.sourceType === "string" &&
    ["managed", "adopted", "external_reference"].includes(String(dataset.storageMode)) &&
    (dataset.rootKey === null || typeof dataset.rootKey === "string") &&
    (dataset.relativePath === null || typeof dataset.relativePath === "string") && dataset.status === "finalized" &&
    (dataset.manifestSha256 === null || typeof dataset.manifestSha256 === "string" && /^[a-f0-9]{64}$/.test(dataset.manifestSha256)) &&
    Number.isSafeInteger(dataset.fileCount) && (dataset.fileCount as number) >= 0 &&
    Number.isSafeInteger(dataset.byteSize) && (dataset.byteSize as number) >= 0 &&
    Boolean(dataset.metadata && typeof dataset.metadata === "object" && !Array.isArray(dataset.metadata)) &&
    typeof dataset.createdBy === "string" && typeof dataset.createdAt === "string" && Number.isFinite(Date.parse(dataset.createdAt)) &&
    typeof dataset.updatedAt === "string" && Number.isFinite(Date.parse(dataset.updatedAt)) &&
    typeof dataset.finalizedAt === "string" && Number.isFinite(Date.parse(dataset.finalizedAt)) &&
    dataset.archivedAt === null && dataset.trashedAt === null;
}

export function assertViewerOperation(value: ViewerDurableOperation, expected?: Pick<ViewerOperationCheckpoint, "operationId" | "type" | "datasetId" | "uploadId">): ViewerDurableOperation {
  if (!value || !UUID.test(value.id) || (expected && value.id !== expected.operationId) ||
    (value.type !== "upload_finalize" && value.type !== "import_adopt") || (expected && value.type !== expected.type) ||
    typeof value.subject !== "string" || !value.subject.startsWith("ops:") || !UUID.test(value.datasetId) ||
    !(value.uploadId === null || UUID.test(value.uploadId)) || !["queued", "leased", "succeeded", "failed", "cancelled"].includes(value.status) ||
    !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1 ||
    !(value.errorCode === null || typeof value.errorCode === "string") ||
    !(value.errorMessage === null || typeof value.errorMessage === "string") ||
    !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !(value.completedAt === null || Number.isFinite(Date.parse(value.completedAt))))
    throw new ViewerOperationContractError("3D Viewer returned an invalid durable operation");
  if (expected && (value.datasetId !== expected.datasetId || value.uploadId !== expected.uploadId))
    throw new ViewerOperationContractError("3D Viewer returned a mismatched durable operation");
  if (value.type === "upload_finalize" && value.uploadId === null) throw new ViewerOperationContractError("3D Viewer returned an invalid finalize operation");
  if (value.type === "import_adopt" && value.uploadId !== null) throw new ViewerOperationContractError("3D Viewer returned an invalid import operation");
  if (value.status === "succeeded" && !validFinalizedDataset(value.result?.dataset, value.datasetId))
    throw new ViewerOperationContractError("3D Viewer returned an invalid operation result");
  if (value.status !== "succeeded" && value.result !== null)
    throw new ViewerOperationContractError("3D Viewer returned a premature operation result");
  return value;
}

export async function startViewerOperation(
  client: ViewerAdminClient,
  path: string,
  init: RequestInit,
  expectedType: ViewerDurableOperationType,
  expectedIdentity: { datasetId?: string; uploadId?: string | null } = {},
): Promise<{ operation: ViewerDurableOperation; checkpoint: ViewerOperationCheckpoint; checkpointStored: boolean }> {
  const headers = new Headers(init.headers);
  if (!headers.get("Idempotency-Key")) throw new Error("Durable Viewer operations require an idempotency key");
  let started: { payload: ViewerDurableOperationResponse; status: number; location: string | null; retryAfterSeconds: number | null } | null = null;
  let lastError: unknown;
  // Reuse the exact request and key after an ambiguous network failure. Viewer
  // replays the same 202 body and Location; a conflicting body fails with 409.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { started = await client.requestWithMetadata<ViewerDurableOperationResponse>(path, { ...init, headers }); break; }
    catch (error) { lastError = error; if (attempt < 2) await abortableDelay(500 * 2 ** attempt, init.signal || undefined); }
  }
  if (!started) throw lastError;
  if (started.status !== 202) throw new Error(`3D Viewer operation returned HTTP ${started.status}; expected 202`);
  if (started.retryAfterSeconds !== 2) throw new Error("3D Viewer returned an invalid operation Retry-After");
  const operation = assertViewerOperation(started.payload.operation);
  if (operation.type !== expectedType) throw new Error("3D Viewer returned the wrong durable operation type");
  if (expectedIdentity.datasetId !== undefined && operation.datasetId !== expectedIdentity.datasetId)
    throw new Error("3D Viewer returned an operation for the wrong dataset");
  if (expectedIdentity.uploadId !== undefined && operation.uploadId !== expectedIdentity.uploadId)
    throw new Error("3D Viewer returned an operation for the wrong upload");
  const expectedPath = `/api/v1/operations/${encodeURIComponent(operation.id)}`;
  if (started.location !== expectedPath) throw new Error("3D Viewer returned a non-canonical operation Location");
  const checkpoint: ViewerOperationCheckpoint = {
    version: 1, operationId: operation.id, type: operation.type, datasetId: operation.datasetId,
    uploadId: operation.uploadId, createdAt: operation.createdAt,
  };
  return { operation, checkpoint, checkpointStored: writeViewerOperationCheckpoint(checkpoint) };
}

export async function pollViewerOperation(
  client: ViewerAdminClient,
  checkpoint: ViewerOperationCheckpoint,
  onProgress: (operation: ViewerDurableOperation) => void,
  signal?: AbortSignal,
): Promise<ViewerDurableOperation> {
  let consecutiveErrors = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("Stopped watching; the Viewer operation continues safely", "AbortError");
    try {
      const payload = await client.request<ViewerDurableOperationResponse>(`/api/v1/operations/${encodeURIComponent(checkpoint.operationId)}`, { signal });
      const operation = assertViewerOperation(payload.operation, checkpoint);
      onProgress(operation);
      consecutiveErrors = 0;
      if (["succeeded", "failed", "cancelled"].includes(operation.status)) return operation;
      await abortableDelay(2_000, signal);
    } catch (error) {
      if (signal?.aborted || (error as Error).name === "AbortError") throw error;
      if (error instanceof ViewerOperationContractError) throw error;
      consecutiveErrors += 1;
      if (consecutiveErrors >= 6) throw new Error("Viewer operation is still saved, but status checks are temporarily unavailable. Reopen this section to resume watching.");
      await abortableDelay(Math.min(10_000, 1_000 * 2 ** consecutiveErrors), signal);
    }
  }
}
