import type {
  ViewerCatalogImportCandidate,
  ViewerDurableOperation,
  ViewerDurableOperationResponse,
  ViewerDurableOperationType,
} from "@ltds/shared";
import { ViewerAdminClient, ViewerAdminRequestError } from "./viewer-admin-client";

export interface ViewerOperationCheckpoint {
  version: 1;
  operationId: string;
  type: ViewerDurableOperationType;
  datasetId: string | null;
  uploadId: string | null;
  createdAt: string;
}

export interface ViewerPendingOperationRequest {
  version: 1;
  key: string;
  method: "POST";
  path: string;
  type: ViewerDurableOperationType;
  datasetId: string | null;
  uploadId: string | null;
  createdAt: string;
}

export interface ViewerPendingRecoveryResult {
  recovered: ViewerOperationCheckpoint[];
  unknown: number;
  stillPending: number;
}

export const OPERATION_CHECKPOINT_KEY = "ltds.viewer.processing-operations.v1";
export const PENDING_OPERATION_REQUEST_KEY = "ltds.viewer.pending-operation-requests.v1";
const MAX_CHECKPOINT_BYTES = 32 * 1024;
const MAX_CHECKPOINTS = 20;
const MAX_CHECKPOINT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

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
        !["upload_finalize", "import_preview", "import_adopt", "catalog_scan", "catalog_map"].includes(String(item.type)) ||
        !(item.datasetId === null || typeof item.datasetId === "string" && UUID.test(item.datasetId)) ||
        !(item.uploadId === null || typeof item.uploadId === "string" && UUID.test(item.uploadId)) ||
        !Number.isFinite(created) || created > now + 5 * 60_000 || now - created > MAX_CHECKPOINT_AGE_MS ||
        "accessToken" in item || "uploadToken" in item || "previewToken" in item || "grant" in item ||
        seen.has(item.operationId)) return [];
      if (item.type === "upload_finalize" && item.uploadId === null) return [];
      if (item.type === "upload_finalize" && item.datasetId === null) return [];
      if (item.type === "import_adopt" && (item.datasetId === null || item.uploadId !== null)) return [];
      if (item.type === "import_preview" && (item.datasetId !== null || item.uploadId !== null)) return [];
      if ((item.type === "catalog_scan" || item.type === "catalog_map") && (item.datasetId !== null || item.uploadId !== null)) return [];
      seen.add(item.operationId);
      checkpoints.push(item as unknown as ViewerOperationCheckpoint);
    }
    return checkpoints;
  } catch { return []; }
}

export function parseViewerPendingOperationRequests(raw: string | null, now = Date.now()): ViewerPendingOperationRequest[] {
  try {
    if (!raw || raw.length > MAX_CHECKPOINT_BYTES) return [];
    const values = JSON.parse(raw) as unknown;
    if (!Array.isArray(values) || values.length > MAX_CHECKPOINTS) return [];
    const seen = new Set<string>();
    const pending: ViewerPendingOperationRequest[] = [];
    for (const value of values) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const created = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : Number.NaN;
      if (item.version !== 1 || typeof item.key !== "string" || !IDEMPOTENCY_KEY.test(item.key) || item.method !== "POST" ||
        typeof item.path !== "string" || item.path.length > 512 || !item.path.startsWith("/api/v1/") || item.path.includes("..") ||
        !["upload_finalize", "import_preview", "import_adopt", "catalog_scan", "catalog_map"].includes(String(item.type)) ||
        !(item.datasetId === null || typeof item.datasetId === "string" && UUID.test(item.datasetId)) ||
        !(item.uploadId === null || typeof item.uploadId === "string" && UUID.test(item.uploadId)) ||
        !Number.isFinite(created) || created > now + 5 * 60_000 || now - created > MAX_CHECKPOINT_AGE_MS ||
        ["accessToken", "uploadToken", "previewToken", "grant", "body", "requestHash", "headers"].some(key => key in item) ||
        seen.has(item.key)) return [];
      if (item.type === "upload_finalize" && (item.datasetId === null || item.uploadId === null)) return [];
      if (item.type === "import_adopt" && (item.datasetId !== null || item.uploadId !== null)) return [];
      if (item.type === "import_preview" && (item.datasetId !== null || item.uploadId !== null)) return [];
      if ((item.type === "catalog_scan" || item.type === "catalog_map") && (item.datasetId !== null || item.uploadId !== null)) return [];
      seen.add(item.key);
      pending.push(item as unknown as ViewerPendingOperationRequest);
    }
    return pending;
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

export function readViewerPendingOperationRequests(storage?: Storage): ViewerPendingOperationRequest[] {
  const target = browserStorage(storage);
  if (!target) return [];
  try {
    const raw = target.getItem(PENDING_OPERATION_REQUEST_KEY);
    const parsed = parseViewerPendingOperationRequests(raw);
    if (raw && !parsed.length) target.removeItem(PENDING_OPERATION_REQUEST_KEY);
    return parsed;
  } catch { return []; }
}

function persist(checkpoints: ViewerOperationCheckpoint[], storage: Storage): boolean {
  try { storage.setItem(OPERATION_CHECKPOINT_KEY, JSON.stringify(checkpoints)); return true; }
  catch { return false; }
}

function persistPending(pending: ViewerPendingOperationRequest[], storage: Storage): boolean {
  try { storage.setItem(PENDING_OPERATION_REQUEST_KEY, JSON.stringify(pending)); return true; }
  catch { return false; }
}

export function writeViewerPendingOperationRequest(request: ViewerPendingOperationRequest, storage?: Storage): boolean {
  const validated = parseViewerPendingOperationRequests(JSON.stringify([request]));
  if (!validated.length) throw new Error("Viewer operation recovery request is invalid");
  const target = browserStorage(storage);
  if (!target) return false;
  const existing = readViewerPendingOperationRequests(target).filter(item => item.key !== request.key);
  return persistPending([...existing, request].slice(-MAX_CHECKPOINTS), target);
}

export function removeViewerPendingOperationRequest(key: string, storage?: Storage): void {
  const target = browserStorage(storage);
  if (!target) return;
  try {
    const remaining = readViewerPendingOperationRequests(target).filter(item => item.key !== key);
    if (remaining.length) target.setItem(PENDING_OPERATION_REQUEST_KEY, JSON.stringify(remaining));
    else target.removeItem(PENDING_OPERATION_REQUEST_KEY);
  } catch { /* credential-free recovery storage was unavailable already */ }
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
    Array.isArray(dataset.tags) && dataset.tags.every(tag => typeof tag === "string") &&
    typeof dataset.createdBy === "string" && typeof dataset.createdAt === "string" && Number.isFinite(Date.parse(dataset.createdAt)) &&
    typeof dataset.updatedAt === "string" && Number.isFinite(Date.parse(dataset.updatedAt)) &&
    typeof dataset.finalizedAt === "string" && Number.isFinite(Date.parse(dataset.finalizedAt)) &&
    dataset.archivedAt === null && dataset.trashedAt === null;
}

function validImportPreview(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const preview = response.preview as Record<string, unknown> | null;
  const space = preview?.destinationSpace as Record<string, unknown> | null;
  const files = preview?.files;
  return typeof response.id === "string" && UUID.test(response.id) &&
    typeof response.previewToken === "string" && response.previewToken.length >= 16 && response.previewToken.length <= 512 &&
    typeof response.expiresAt === "string" && Number.isFinite(Date.parse(response.expiresAt)) &&
    Boolean(preview) && ["dataset_import", "terra_import", "webodm"].includes(String(preview?.rootKey)) &&
    typeof preview?.relativePath === "string" && Number.isSafeInteger(preview.fileCount) && (preview.fileCount as number) >= 0 &&
    Number.isSafeInteger(preview.byteSize) && (preview.byteSize as number) >= 0 &&
    typeof preview.treeFingerprint === "string" && /^[a-f0-9]{64}$/.test(preview.treeFingerprint) &&
    Array.isArray(files) && files.length <= 1000 && files.every(file => {
      if (!file || typeof file !== "object" || Array.isArray(file)) return false;
      const item = file as Record<string, unknown>;
      return typeof item.relativePath === "string" && Number.isSafeInteger(item.byteSize) && (item.byteSize as number) >= 0 &&
        Number.isSafeInteger(item.mtimeMs) && Number.isSafeInteger(item.ctimeMs);
    }) && typeof preview.truncated === "boolean" && typeof preview.sameFilesystem === "boolean" && Boolean(space) &&
    ["availableBytes", "totalBytes", "reserveBytes", "requiredBytes"].every(key =>
      Number.isSafeInteger(space?.[key]) && (space?.[key] as number) >= 0) && typeof space?.sufficient === "boolean";
}

function validCatalogCandidate(value: unknown): value is ViewerCatalogImportCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const mapping = candidate.mapping;
  return typeof candidate.id === "string" && ["webodm", "terra"].includes(String(candidate.provider)) &&
    ["externalProjectId", "externalTaskId", "sourceRootKey", "sourceRelativePath", "sourceFingerprint", "suggestedProjectName", "suggestedTaskName", "lastSeenAt"]
      .every(key => typeof candidate[key] === "string") &&
    Array.isArray(candidate.assetKinds) && candidate.assetKinds.every(kind => typeof kind === "string") &&
    ["unmapped", "mapped", "stale"].includes(String(candidate.state)) && [null, "source_changed", "not_seen"].includes(candidate.staleReason as null | string) && Number.isSafeInteger(candidate.scanGeneration) &&
    Number.isFinite(Date.parse(String(candidate.lastSeenAt))) && (mapping === null || Boolean(mapping && typeof mapping === "object" && !Array.isArray(mapping) &&
      ["projectId", "taskId", "datasetId", "attemptId", "modelId", "modelVersionId", "mappedAt"].every(key => typeof (mapping as Record<string, unknown>)[key] === "string")));
}

function validCatalogScanResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>, scan = result.scan;
  if (!scan || typeof scan !== "object" || Array.isArray(scan)) return false;
  const row = scan as Record<string, unknown>;
  return typeof row.id === "string" && ["webodm", "terra"].includes(String(row.provider)) &&
    Number.isSafeInteger(row.generation) && Number.isSafeInteger(row.candidateCount) && (row.candidateCount as number) >= 0 &&
    typeof row.seenAt === "string" && Number.isFinite(Date.parse(row.seenAt)) &&
    Number.isSafeInteger(result.candidatesSeen) && (result.candidatesSeen as number) >= 0;
}

function validCatalogMapResult(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return Boolean(validCatalogCandidate(result.candidate) && result.project && typeof result.project === "object" &&
    result.task && typeof result.task === "object" && result.attempt && typeof result.attempt === "object" &&
    result.model && typeof result.model === "object");
}

export function assertViewerOperation(value: ViewerDurableOperation, expected?: Pick<ViewerOperationCheckpoint, "operationId" | "type" | "datasetId" | "uploadId">): ViewerDurableOperation {
  if (!value || !UUID.test(value.id) || (expected && value.id !== expected.operationId) ||
    !["upload_finalize", "import_preview", "import_adopt", "catalog_scan", "catalog_map"].includes(value.type) || (expected && value.type !== expected.type) ||
    typeof value.subject !== "string" || !value.subject.startsWith("ops:") ||
    !(value.datasetId === null || UUID.test(value.datasetId)) ||
    !(value.uploadId === null || UUID.test(value.uploadId)) || !["queued", "leased", "succeeded", "failed", "cancelled"].includes(value.status) ||
    !Number.isFinite(value.progress) || value.progress < 0 || value.progress > 1 ||
    !(value.errorCode === null || typeof value.errorCode === "string") ||
    !(value.errorMessage === null || typeof value.errorMessage === "string") ||
    !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !(value.completedAt === null || Number.isFinite(Date.parse(value.completedAt))))
    throw new ViewerOperationContractError("3D Viewer returned an invalid durable operation");
  if (expected && (value.datasetId !== expected.datasetId || value.uploadId !== expected.uploadId))
    throw new ViewerOperationContractError("3D Viewer returned a mismatched durable operation");
  if (value.type === "upload_finalize" && (value.datasetId === null || value.uploadId === null)) throw new ViewerOperationContractError("3D Viewer returned an invalid finalize operation");
  if (value.type === "import_adopt" && (value.datasetId === null || value.uploadId !== null)) throw new ViewerOperationContractError("3D Viewer returned an invalid import operation");
  if (value.type === "import_preview" && (value.datasetId !== null || value.uploadId !== null)) throw new ViewerOperationContractError("3D Viewer returned an invalid import preview operation");
  if ((value.type === "catalog_scan" || value.type === "catalog_map") && (value.datasetId !== null || value.uploadId !== null))
    throw new ViewerOperationContractError("3D Viewer returned an invalid catalog import operation");
  if (value.status === "succeeded" && value.type === "import_preview" && !validImportPreview(value.result))
    throw new ViewerOperationContractError("3D Viewer returned an invalid import preview result");
  if (value.status === "succeeded" && value.type === "catalog_scan" && !validCatalogScanResult(value.result))
    throw new ViewerOperationContractError("3D Viewer returned an invalid catalog scan result");
  if (value.status === "succeeded" && value.type === "catalog_map" && !validCatalogMapResult(value.result))
    throw new ViewerOperationContractError("3D Viewer returned an invalid catalog mapping result");
  if (value.status === "succeeded" && !["import_preview", "catalog_scan", "catalog_map"].includes(value.type) &&
    (value.datasetId === null || !validFinalizedDataset((value.result as { dataset?: unknown } | null)?.dataset, value.datasetId)))
    throw new ViewerOperationContractError("3D Viewer returned an invalid operation result");
  if (value.status !== "succeeded" && value.result !== null)
    throw new ViewerOperationContractError("3D Viewer returned a premature operation result");
  return value;
}

function checkpointFor(operation: ViewerDurableOperation): ViewerOperationCheckpoint {
  return {
    version: 1,
    operationId: operation.id,
    type: operation.type,
    datasetId: operation.datasetId,
    uploadId: operation.uploadId,
    createdAt: operation.createdAt,
  };
}

async function recoverViewerOperationReceipt(
  client: ViewerAdminClient,
  pending: ViewerPendingOperationRequest,
  storage?: Storage,
): Promise<{ operation: ViewerDurableOperation; checkpoint: ViewerOperationCheckpoint; checkpointStored: boolean } | null> {
  const payload = await client.request<unknown>(`/api/v1/operation-receipts/${encodeURIComponent(pending.key)}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    throw new ViewerOperationContractError("3D Viewer returned an invalid operation receipt");
  const value = payload as Record<string, unknown>;
  const receipt = value.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
    throw new ViewerOperationContractError("3D Viewer returned an invalid operation receipt");
  const row = receipt as Record<string, unknown>;
  if (typeof row.subject !== "string" || !row.subject.startsWith("ops:") || row.key !== pending.key ||
    row.method !== "POST" || row.path !== pending.path || typeof row.requestHash !== "string" || !SHA256.test(row.requestHash) ||
    !(row.responseStatus === null || row.responseStatus === 202) ||
    !(row.operationId === null || typeof row.operationId === "string" && UUID.test(row.operationId)) ||
    typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)))
    throw new ViewerOperationContractError("3D Viewer returned a mismatched operation receipt");
  if (value.operation === null) {
    if (row.operationId !== null) throw new ViewerOperationContractError("3D Viewer returned an incomplete operation receipt");
    return null;
  }
  const operation = assertViewerOperation(value.operation as ViewerDurableOperation);
  if (row.operationId !== operation.id || operation.type !== pending.type ||
    (pending.datasetId !== null && operation.datasetId !== pending.datasetId) ||
    (pending.uploadId !== null && operation.uploadId !== pending.uploadId))
    throw new ViewerOperationContractError("3D Viewer returned an operation for a different request");
  const checkpoint = checkpointFor(operation);
  const checkpointStored = writeViewerOperationCheckpoint(checkpoint, storage);
  removeViewerPendingOperationRequest(pending.key, storage);
  return { operation, checkpoint, checkpointStored };
}

export async function recoverViewerPendingOperations(
  client: ViewerAdminClient,
  storage?: Storage,
): Promise<ViewerPendingRecoveryResult> {
  const recovered: ViewerOperationCheckpoint[] = [];
  let unknown = 0, stillPending = 0;
  for (const pending of readViewerPendingOperationRequests(storage)) {
    try {
      const result = await recoverViewerOperationReceipt(client, pending, storage);
      if (result) {
        recovered.push(result.checkpoint);
      } else stillPending += 1;
    } catch (error) {
      if (error instanceof ViewerAdminRequestError && error.status === 404) {
        removeViewerPendingOperationRequest(pending.key, storage);
        unknown += 1;
        continue;
      }
      throw error;
    }
  }
  return { recovered, unknown, stillPending };
}

export async function startViewerOperation(
  client: ViewerAdminClient,
  path: string,
  init: RequestInit,
  expectedType: ViewerDurableOperationType,
  expectedIdentity: { datasetId?: string | null; uploadId?: string | null } = {},
): Promise<{ operation: ViewerDurableOperation; checkpoint: ViewerOperationCheckpoint; checkpointStored: boolean }> {
  const headers = new Headers(init.headers);
  const key = headers.get("Idempotency-Key");
  if (!key || !IDEMPOTENCY_KEY.test(key)) throw new Error("Durable Viewer operations require a valid idempotency key");
  const pending: ViewerPendingOperationRequest = {
    version: 1,
    key,
    method: "POST",
    path,
    type: expectedType,
    datasetId: expectedIdentity.datasetId ?? null,
    uploadId: expectedIdentity.uploadId ?? null,
    createdAt: new Date().toISOString(),
  };
  // This credential-free receipt locator is durable before the first byte is
  // sent. Secret request bodies (upload/preview tokens) are never persisted.
  writeViewerPendingOperationRequest(pending);
  let started: { payload: ViewerDurableOperationResponse; status: number; location: string | null; retryAfterSeconds: number | null } | null = null;
  let lastError: unknown;
  // Reuse the exact request and key after an ambiguous network failure. Viewer
  // replays the same 202 body and Location; a conflicting body fails with 409.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { started = await client.requestWithMetadata<ViewerDurableOperationResponse>(path, { ...init, headers }); break; }
    catch (error) { lastError = error; if (attempt < 2) await abortableDelay(500 * 2 ** attempt, init.signal || undefined); }
  }
  if (!started) {
    try {
      const recovered = await recoverViewerOperationReceipt(client, pending);
      if (recovered) {
        return recovered;
      }
    } catch (error) {
      if (error instanceof ViewerAdminRequestError && error.status === 404)
        removeViewerPendingOperationRequest(key);
      else if (!(error instanceof ViewerAdminRequestError)) throw error;
    }
    throw lastError;
  }
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
  const checkpoint = checkpointFor(operation);
  const checkpointStored = writeViewerOperationCheckpoint(checkpoint);
  removeViewerPendingOperationRequest(key);
  return { operation, checkpoint, checkpointStored };
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
