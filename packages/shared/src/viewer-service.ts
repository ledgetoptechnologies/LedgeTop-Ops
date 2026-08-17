const encoder = new TextEncoder();

export type ViewerAudience = "ops" | "client";

export interface ViewerModelSummary {
  id: string;
  title: string;
  provider: string;
  status: string;
  available: boolean;
  activeVersion: {
    id: string;
    providerVersionId: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  updatedAt: string;
}

export interface ViewerSessionGrant {
  grant: string;
  grantExpiresAt: string;
  sessionTtlSeconds: number;
  redeemUrl: string;
  embedUrl: string;
}

export interface ViewerPublishedSessionSourceAuthorization {
  type: "model_association";
  id: string;
  version: number;
}

export interface ViewerPublishedSessionRevocation {
  sourceAuthorization: ViewerPublishedSessionSourceAuthorization;
  revokedGrants: number;
  revokedSessions: number;
}

export interface ViewerReviewSessionGrant extends ViewerSessionGrant {
  sessionMode: "review";
  attemptId: string;
  modelId: string;
  modelVersionId: string;
  assetKinds: Array<"glb" | "tiles" | "ept" | "ortho" | "dsm" | "dtm">;
}

export type ViewerDisplayUnits = "imperial" | "metric";

export type ViewerProcessingPermission =
  | "viewer.projects.read"
  | "viewer.projects.write"
  | "viewer.datasets.read"
  | "viewer.datasets.write"
  | "viewer.datasets.import"
  | "viewer.gcp.read"
  | "viewer.gcp.write"
  | "viewer.processing.read"
  | "viewer.processing.write"
  | "viewer.processing.publish"
  | "viewer.providers.read"
  | "viewer.providers.write"
  | "viewer.storage.purge";

export interface ViewerAdminSessionGrant {
  grant: string;
  grantExpiresAt: string;
  sessionTtlSeconds: number;
  redeemUrl: string;
}

export interface ViewerAdminSession {
  accessToken: string;
  session: {
    id: string;
    subject: string;
    permissions: ViewerProcessingPermission[];
    expiresAt: string;
  };
  units: { default: ViewerDisplayUnits; resolved: ViewerDisplayUnits };
}

export type ViewerAssetOwnership = "managed" | "adopted" | "external_reference";
export type ViewerDatasetState = "draft" | "uploading" | "finalizing" | "finalized" | "archived" | "trashed";
export interface ViewerProcessingProject {
  id: string;
  displayName: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
  tags: string[];
  defaultUnits: ViewerDisplayUnits;
  status: "active" | "archived";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface ViewerDatasetSummary {
  id: string;
  projectId: string;
  displayName: string;
  description: string | null;
  sourceType: string;
  storageMode: ViewerAssetOwnership;
  rootKey: string | null;
  relativePath: string | null;
  status: ViewerDatasetState;
  manifestSha256: string | null;
  fileCount: number;
  byteSize: number;
  metadata: Record<string, unknown>;
  tags: string[];
  createdBy: string;
  finalizedAt: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashedAt: string | null;
}
export interface ViewerProviderSummary {
  id: string;
  displayName: string;
  type: "nodeodm" | "clusterodm";
  endpoint: string;
  enabled: boolean;
  admissionLimit: number;
  activeAttempts: number;
  credential: {
    configured: boolean;
    updatedAt: string | null;
  };
  capabilities: ViewerProviderCapabilities | null;
  capabilityFingerprint: string | null;
  lastHealth: "healthy" | "degraded" | "unavailable" | "unknown" | null;
  lastHealthAt: string | null;
  runtimeHealth?: "healthy" | "degraded" | "unavailable" | "unknown" | null;
  runtimeHealthAt?: string | null;
  runtimeHealthError?: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ViewerProcessingPreset {
  id: string;
  displayName: string;
  description: string | null;
  builtIn: boolean;
  enabled: boolean;
  options: Record<string, unknown>;
  providerType: "nodeodm" | "clusterodm" | null;
  capabilityFingerprint: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface ViewerProviderCapabilityOption {
  name: string;
  type: "int" | "float" | "string" | "bool";
  domain: unknown;
  help: string;
  value: unknown;
}
export interface ViewerProviderCapabilities {
  apiVersion: string;
  engine: string;
  engineVersion: string;
  maxImages: number | null;
  maxParallelTasks: number | null;
  taskQueueCount: number | null;
  totalMemory: number | null;
  availableMemory: number | null;
  cpuCores: number | null;
  providerType: "nodeodm" | "clusterodm";
  testedBaseline: string;
  compatibilityWarning: string | null;
  options: ViewerProviderCapabilityOption[];
}
export type ViewerProcessingAttemptState =
  | "pending" | "admitted" | "initializing" | "uploading" | "committed"
  | "queued_upstream" | "running" | "ingesting" | "derivatives" | "ready_for_review"
  | "published" | "failed" | "cancelled";
export interface ViewerProcessingAttempt {
  id: string;
  taskId: string;
  datasetId: string;
  attemptNumber: number;
  providerId: string;
  providerTaskId: string | null;
  presetId: string | null;
  options: Record<string, unknown>;
  status: ViewerProcessingAttemptState;
  progress: number | null;
  providerOutputCursor: number | null;
  capabilityFingerprint: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultModelId: string | null;
  resultModelVersionId: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  upstreamCompletedAt: string | null;
  ingestedAt: string | null;
  completedAt: string | null;
  submissionPhase: string | null;
  uploadedFileCount: number;
}
export interface ViewerProcessingAttemptPage {
  attempts: ViewerProcessingAttempt[];
  nextCursor: string | null;
}
export interface ViewerProcessingTask {
  id: string;
  projectId: string;
  datasetId: string;
  displayName: string;
  status: "draft" | "queued" | "processing" | "ready_for_review" | "published" | "failed" | "cancelled" | "archived";
  activeAttemptId: string | null;
  latestAttempt: ViewerProcessingAttempt | null;
  publishedModelId: string | null;
  description: string | null;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}
export interface ViewerProcessingAttemptDetail {
  attempt: ViewerProcessingAttempt;
  logs: Array<{ level: string; message: string; created_at: string }>;
}
export interface ViewerStorageVolume {
  available: number;
  total: number;
  reserve: number;
  required: number;
  ok: boolean;
}
export interface ViewerTrashEntry {
  id: string;
  entityType: "dataset" | "output";
  entityId: string;
  rootKey: string;
  relativePath: string;
  byteSize: number;
  purgeAfter: string;
  createdBy: string;
  createdAt: string;
  permanentlyDeletedAt: string | null;
}
export interface ViewerOutputSummary {
  id: string;
  modelId: string;
  taskId: string;
  attemptId: string;
  projectId: string;
  displayName: string;
  status: "ready" | "published" | "archived" | "trashed";
  byteSize: number;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  trashedAt: string | null;
}
export interface ViewerTaskStorageUsage {
  taskId: string;
  projectId: string;
  datasetBytes: number;
  outputBytes: number;
  totalBytes: number;
}
export interface ViewerProjectStorageUsage {
  projectId: string;
  datasetBytes: number;
  outputBytes: number;
  totalBytes: number;
}
export interface ViewerProjectStorageResponse {
  project: ViewerProjectStorageUsage;
  tasks: ViewerTaskStorageUsage[];
  nextCursor: string | null;
}
export interface ViewerTaskStorageResponse {
  task: ViewerTaskStorageUsage;
  outputs: ViewerOutputSummary[];
  nextCursor: string | null;
}
export interface ViewerStorageSummary {
  storage: {
    datasets: ViewerStorageVolume;
    models: ViewerStorageVolume;
    cache: ViewerStorageVolume;
    trash: ViewerStorageVolume;
  };
  trash: {
    items: ViewerTrashEntry[];
    nextCursor: string | null;
    totalCount: number;
    totalBytes: number;
  };
}
export interface ViewerDatasetUploadGrant {
  upload: {
    id: string;
    datasetId: string;
    status: string;
    chunkSize: number;
    expiresAt: string;
    files: Array<{
      id: string;
      relativePath: string;
      byteSize: number;
      sha256: string;
      chunkCount: number;
      completedChunks: number[];
      missingChunks: number[];
    }>;
  };
  uploadToken: string;
}
export interface ViewerDatasetImportPreview {
  id: string;
  previewToken: string;
  expiresAt: string;
  preview: {
    rootKey: "dataset_import" | "terra_import" | "webodm";
    relativePath: string;
    fileCount: number;
    byteSize: number;
    treeFingerprint: string;
    files: Array<{ relativePath: string; byteSize: number; mtimeMs: number; ctimeMs: number }>;
    truncated: boolean;
    sameFilesystem: boolean;
    destinationSpace: {
      availableBytes: number;
      totalBytes: number;
      reserveBytes: number;
      requiredBytes: number;
      sufficient: boolean;
    };
  };
}

export type ViewerCatalogImportProvider = "webodm" | "terra";
export type ViewerCatalogImportCandidateState = "unmapped" | "mapped" | "stale";
export interface ViewerCatalogImportCandidate {
  id: string;
  provider: ViewerCatalogImportProvider;
  externalProjectId: string;
  externalTaskId: string;
  sourceRootKey: string;
  sourceRelativePath: string;
  sourceFingerprint: string;
  suggestedProjectName: string;
  suggestedTaskName: string;
  assetKinds: string[];
  state: ViewerCatalogImportCandidateState;
  staleReason: "source_changed" | "not_seen" | null;
  scanGeneration: number;
  lastSeenAt: string;
  mapping: null | {
    projectId: string;
    taskId: string;
    datasetId: string;
    attemptId: string;
    modelId: string;
    modelVersionId: string;
    mappedAt: string;
  };
}
export interface ViewerCatalogImportScanResult {
  scan: {
    id: string;
    provider: ViewerCatalogImportProvider;
    generation: number;
    candidateCount: number;
    seenAt: string;
  };
  candidatesSeen: number;
}
export interface ViewerCatalogImportMapResult {
  project: ViewerProcessingProject;
  task: ViewerProcessingTask;
  attempt: ViewerProcessingAttempt;
  model: ViewerModelSummary;
  candidate: ViewerCatalogImportCandidate;
}

export type ViewerDurableOperationType = "upload_finalize" | "import_preview" | "import_adopt" | "catalog_scan" | "catalog_map";
export type ViewerDurableOperationStatus = "queued" | "leased" | "succeeded" | "failed" | "cancelled";
export interface ViewerDurableOperation {
  id: string;
  type: ViewerDurableOperationType;
  subject: string;
  datasetId: string | null;
  uploadId: string | null;
  status: ViewerDurableOperationStatus;
  progress: number;
  result: { dataset: ViewerDatasetSummary } | ViewerDatasetImportPreview | ViewerCatalogImportScanResult | ViewerCatalogImportMapResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ViewerDurableOperationResponse {
  operation: ViewerDurableOperation;
}

export interface ViewerProcessingEventV1 {
  schemaVersion: 1;
  eventId: string;
  type: "processing.ready_for_review" | "processing.failed";
  occurredAt: string;
  projectId: string;
  projectDisplayName?: string;
  taskId: string;
  taskDisplayName?: string;
  attemptId: string;
  requestedBySubject: string;
  status: string;
  error?: { code: string; message: string };
  reviewUrl?: string;
}

export interface ViewerPublicSharePermissions {
  view: boolean;
  measure: boolean;
  cameras: boolean;
  download: boolean;
}

export interface ViewerPublicShareSummary {
  id: string;
  modelId: string;
  versionPolicy: "latest";
  modelVersionId: string | null;
  hasPassword: boolean;
  permissions: ViewerPublicSharePermissions;
  label: string | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
  accessCount: number;
  lastAccessedAt: string | null;
  displayUnits?: ViewerDisplayUnits | null;
  shareClass: "staff" | "client";
  sourceAuthorization: {
    type: "client_grant";
    id: string;
    version: number;
    subject: string;
    expiresAt: string | null;
  } | null;
}

export interface ViewerPublicShareCreation {
  share: ViewerPublicShareSummary;
  viewUrl: string;
  embedUrl: string;
}

export interface ViewerServiceConfiguration {
  baseUrl: string;
  keyId: string;
  secret: string;
}

export class ViewerServiceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_configured"
      | "invalid_configuration"
      | "unavailable"
      | "invalid_response"
      | "not_found"
      | "conflict",
    readonly status = 503,
  ) {
    super(message);
    this.name = "ViewerServiceError";
  }
}

function base64Url(bytes: ArrayBuffer): string {
  let binary = "";
  for (const value of new Uint8Array(bytes)) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Hex(value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...hash].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function viewerServiceOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function viewerServiceConfigured(configuration: Partial<ViewerServiceConfiguration>): boolean {
  return Boolean(
    viewerServiceOrigin(configuration.baseUrl || "") &&
    /^[A-Za-z0-9._-]{1,64}$/.test(configuration.keyId || "") &&
    (configuration.secret?.length || 0) >= 32,
  );
}

export async function signViewerServiceRequest(input: {
  secret: string;
  keyId: string;
  method: string;
  pathWithQuery: string;
  body: string;
  timestamp?: number;
  nonce?: string;
}): Promise<Record<string, string>> {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1000);
  const nonce = input.nonce ?? crypto.randomUUID();
  const bodyHash = await sha256Hex(input.body);
  const canonical = [
    "ltds-viewer-service-v1",
    input.method.toUpperCase(),
    input.pathWithQuery,
    String(timestamp),
    nonce,
    bodyHash,
  ].join("\n");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(canonical));
  return {
    "X-LTDS-Key-Id": input.keyId,
    "X-LTDS-Timestamp": String(timestamp),
    "X-LTDS-Nonce": nonce,
    "X-LTDS-Content-SHA256": bodyHash,
    "X-LTDS-Signature": base64Url(signature),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function model(value: unknown): ViewerModelSummary | null {
  const row = record(value), version = record(row?.activeVersion);
  if (!row || typeof row.id !== "string" || typeof row.title !== "string" ||
    typeof row.provider !== "string" || typeof row.status !== "string" ||
    typeof row.available !== "boolean" || typeof row.updatedAt !== "string") return null;
  let activeVersion: ViewerModelSummary["activeVersion"] = null;
  if (version) {
    if (typeof version.id !== "string" || typeof version.providerVersionId !== "string" ||
      typeof version.createdAt !== "string" || typeof version.updatedAt !== "string") return null;
    activeVersion = {
      id: version.id,
      providerVersionId: version.providerVersionId,
      createdAt: version.createdAt,
      updatedAt: version.updatedAt,
    };
  }
  return {
    id: row.id,
    title: row.title,
    provider: row.provider,
    status: row.status,
    available: row.available,
    activeVersion,
    updatedAt: row.updatedAt,
  };
}

function assertViewerUrl(value: unknown, origin: string, expectedPath: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.origin === origin && url.protocol === "https:" &&
      !url.username && !url.password && url.pathname === expectedPath && !url.search && !url.hash
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

const MAX_VIEWER_JSON_BYTES = 2 * 1024 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("Content-Length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_VIEWER_JSON_BYTES)
    throw new ViewerServiceError("3D Viewer returned an oversized response", "invalid_response");
  if (!response.body)
    throw new ViewerServiceError("3D Viewer returned an invalid response", "invalid_response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    total += result.value.byteLength;
    if (total > MAX_VIEWER_JSON_BYTES) {
      await reader.cancel();
      throw new ViewerServiceError("3D Viewer returned an oversized response", "invalid_response");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ViewerServiceError("3D Viewer returned an invalid response", "invalid_response");
  }
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function nullableDate(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && Number.isFinite(Date.parse(value)));
}

function publicShare(value: unknown): ViewerPublicShareSummary | null {
  const row = record(value), sharePermissions = record(row?.permissions);
  const sourceAuthorization = record(row?.sourceAuthorization);
  const shareClass = row?.shareClass === undefined ? "staff" : row?.shareClass;
  if (!row || !sharePermissions || typeof row.id !== "string" || typeof row.modelId !== "string" ||
    row.versionPolicy !== "latest" || !nullableString(row.modelVersionId) ||
    typeof row.hasPassword !== "boolean" || typeof row.createdBy !== "string" ||
    !nullableString(row.label) || !nullableString(row.revokedBy) || !nullableString(row.revokeReason) ||
    !nullableDate(row.expiresAt) || !nullableDate(row.revokedAt) || !nullableDate(row.lastAccessedAt) ||
    typeof row.createdAt !== "string" || !Number.isFinite(Date.parse(row.createdAt)) ||
    typeof row.updatedAt !== "string" || !Number.isFinite(Date.parse(row.updatedAt)) ||
    !Number.isSafeInteger(row.accessCount) || (row.accessCount as number) < 0 ||
    typeof sharePermissions.view !== "boolean" || typeof sharePermissions.measure !== "boolean" ||
    typeof sharePermissions.cameras !== "boolean" || typeof sharePermissions.download !== "boolean" ||
    (row.displayUnits !== undefined && row.displayUnits !== null && row.displayUnits !== "imperial" && row.displayUnits !== "metric") ||
    (shareClass !== "staff" && shareClass !== "client") ||
    (shareClass === "staff" && row.sourceAuthorization !== null && row.sourceAuthorization !== undefined) ||
    (shareClass === "client" && (!sourceAuthorization || sourceAuthorization.type !== "client_grant" ||
      typeof sourceAuthorization.id !== "string" || !Number.isSafeInteger(sourceAuthorization.version) ||
      (sourceAuthorization.version as number) < 1 || typeof sourceAuthorization.subject !== "string" ||
      !nullableDate(sourceAuthorization.expiresAt)))) return null;
  return {
    id: row.id,
    modelId: row.modelId,
    versionPolicy: "latest",
    modelVersionId: row.modelVersionId,
    hasPassword: row.hasPassword,
    permissions: {
      view: sharePermissions.view,
      measure: sharePermissions.measure,
      cameras: sharePermissions.cameras,
      download: sharePermissions.download,
    },
    label: row.label,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
    revokedBy: row.revokedBy,
    revokeReason: row.revokeReason,
    accessCount: row.accessCount as number,
    lastAccessedAt: row.lastAccessedAt,
    ...(row.displayUnits === "imperial" || row.displayUnits === "metric" ? { displayUnits: row.displayUnits } : {}),
    shareClass,
    sourceAuthorization: shareClass === "client" ? {
      type: "client_grant",
      id: sourceAuthorization!.id as string,
      version: sourceAuthorization!.version as number,
      subject: sourceAuthorization!.subject as string,
      expiresAt: sourceAuthorization!.expiresAt as string | null,
    } : null,
  };
}

export class ViewerServiceClient {
  private readonly origin: string;

  constructor(
    private readonly configuration: ViewerServiceConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const origin = viewerServiceOrigin(configuration.baseUrl);
    if (!origin || !/^[A-Za-z0-9._-]{1,64}$/.test(configuration.keyId) || configuration.secret.length < 32)
      throw new ViewerServiceError("3D Viewer integration is not configured", "invalid_configuration");
    this.origin = origin;
  }

  private async request(pathWithQuery: string, init: { method?: string; body?: string; idempotencyKey?: string } = {}): Promise<unknown> {
    const method = (init.method || "GET").toUpperCase(), body = init.body || "";
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const signed = await signViewerServiceRequest({
        ...this.configuration,
        method,
        pathWithQuery,
        body,
      });
      const response = await this.fetcher(`${this.origin}${pathWithQuery}`, {
        method,
        body: method === "GET" || method === "HEAD" ? undefined : body,
        headers: {
          ...signed,
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(init.idempotencyKey ? { "Idempotency-Key": init.idempotencyKey } : {}),
        },
        cache: "no-store",
        // Cloudflare Workers supports manual redirect handling but rejects the
        // Fetch-standard "error" mode. Manual keeps signed credentials from
        // following a Location; every 3xx then fails the non-ok check below.
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status === 404) throw new ViewerServiceError("3D model not found", "not_found", 404);
      if (response.status === 409)
        throw new ViewerServiceError("3D Viewer request conflicts with an earlier request", "conflict", 409);
      if (!response.ok) throw new ViewerServiceError("3D Viewer is temporarily unavailable", "unavailable", 503);
      return await boundedJson(response);
    } catch (error) {
      if (error instanceof ViewerServiceError) throw error;
      throw new ViewerServiceError("3D Viewer is temporarily unavailable", "unavailable", 503);
    } finally {
      clearTimeout(timeout);
    }
  }

  async listModels(): Promise<ViewerModelSummary[]> {
    const payload = record(await this.request("/api/v1/models"));
    if (!payload || !Array.isArray(payload.models))
      throw new ViewerServiceError("3D Viewer returned an invalid model catalog", "invalid_response");
    const models = payload.models.map(model);
    if (models.some(item => item === null))
      throw new ViewerServiceError("3D Viewer returned an invalid model catalog", "invalid_response");
    return models as ViewerModelSummary[];
  }

  async createSession(input: {
    modelId: string;
    modelVersionId: string;
    subject: string;
    audience: ViewerAudience;
    idempotencyKey: string;
    authorizationExpiresAt: string;
    displayUnits?: ViewerDisplayUnits;
    permissions?: { view: true; measure?: boolean; cameras?: boolean; download?: boolean };
    sourceAuthorization?: ViewerPublishedSessionSourceAuthorization;
  }): Promise<ViewerSessionGrant> {
    const path = `/api/v1/models/${encodeURIComponent(input.modelId)}/sessions`;
    const body = JSON.stringify({
      subject: input.subject,
      audience: input.audience,
      modelVersionId: input.modelVersionId,
      authorizationExpiresAt: input.authorizationExpiresAt,
      displayUnits: input.displayUnits || "imperial",
      permissions: input.permissions || { view: true, measure: true, cameras: true, download: false },
      ...(input.sourceAuthorization ? { sourceAuthorization: input.sourceAuthorization } : {}),
    });
    const payload = record(await this.request(path, { method: "POST", body, idempotencyKey: input.idempotencyKey }));
    const grant = typeof payload?.grant === "string" ? payload.grant : "";
    const redeemUrl = assertViewerUrl(payload?.redeemUrl, this.origin, "/api/v1/sessions/redeem");
    const embedUrl = assertViewerUrl(payload?.embedUrl, this.origin, `/session/${encodeURIComponent(grant)}`);
    if (!payload || typeof payload.grant !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(payload.grant) ||
      payload.modelVersionId !== input.modelVersionId ||
      typeof payload.grantExpiresAt !== "string" || !Number.isFinite(Date.parse(payload.grantExpiresAt)) ||
      typeof payload.sessionTtlSeconds !== "number" || !Number.isInteger(payload.sessionTtlSeconds) ||
      payload.sessionTtlSeconds < 60 || payload.sessionTtlSeconds > 3600 || !redeemUrl || !embedUrl)
      throw new ViewerServiceError("3D Viewer returned an invalid session grant", "invalid_response");
    return {
      grant: payload.grant,
      grantExpiresAt: payload.grantExpiresAt,
      sessionTtlSeconds: payload.sessionTtlSeconds,
      redeemUrl,
      embedUrl,
    };
  }

  async revokePublishedSessionSourceAuthorization(input: {
    sourceAuthorization: ViewerPublishedSessionSourceAuthorization;
    idempotencyKey: string;
  }): Promise<ViewerPublishedSessionRevocation> {
    const path = "/api/v1/published-sessions/source-authorization";
    const body = JSON.stringify({ sourceAuthorization: input.sourceAuthorization });
    const payload = record(await this.request(path, {
      method: "DELETE", body, idempotencyKey: input.idempotencyKey,
    }));
    const source = record(payload?.sourceAuthorization);
    if (!payload || !source || source.type !== "model_association" || source.id !== input.sourceAuthorization.id ||
      source.version !== input.sourceAuthorization.version ||
      !Number.isSafeInteger(payload?.revokedGrants) || (payload?.revokedGrants as number) < 0 ||
      !Number.isSafeInteger(payload?.revokedSessions) || (payload?.revokedSessions as number) < 0)
      throw new ViewerServiceError("3D Viewer returned an invalid session-revocation result", "invalid_response");
    return {
      sourceAuthorization: {
        type: "model_association", id: source.id as string, version: source.version as number,
      },
      revokedGrants: payload!.revokedGrants as number,
      revokedSessions: payload!.revokedSessions as number,
    };
  }

  async createAdminGrant(input: {
    subject: string;
    permissions: ViewerProcessingPermission[];
    authorizationExpiresAt: string;
    displayUnits: ViewerDisplayUnits;
    idempotencyKey: string;
  }): Promise<ViewerAdminSessionGrant> {
    const path = "/api/v1/admin-grants";
    const body = JSON.stringify({
      subject: input.subject,
      permissions: input.permissions,
      authorizationExpiresAt: input.authorizationExpiresAt,
      displayUnits: input.displayUnits,
    });
    const payload = record(await this.request(path, {
      method: "POST", body, idempotencyKey: input.idempotencyKey,
    }));
    const grant = typeof payload?.grant === "string" ? payload.grant : "";
    const redeemUrl = assertViewerUrl(
      payload?.redeemUrl,
      this.origin,
      "/api/v1/admin-sessions/redeem",
    );
    if (!payload || !/^[A-Za-z0-9_-]{20,512}$/.test(grant) || !redeemUrl ||
      typeof payload.grantExpiresAt !== "string" || !Number.isFinite(Date.parse(payload.grantExpiresAt)) ||
      typeof payload.sessionTtlSeconds !== "number" || !Number.isInteger(payload.sessionTtlSeconds) ||
      payload.sessionTtlSeconds < 60 || payload.sessionTtlSeconds > 3600)
      throw new ViewerServiceError("3D Viewer returned an invalid administrative grant", "invalid_response");
    return {
      grant,
      grantExpiresAt: payload.grantExpiresAt,
      sessionTtlSeconds: payload.sessionTtlSeconds,
      redeemUrl,
    };
  }


  async listPublicShares(modelId: string): Promise<ViewerPublicShareSummary[]> {
    const path = `/api/v1/models/${encodeURIComponent(modelId)}/shares`;
    const payload = record(await this.request(path));
    if (!payload || !Array.isArray(payload.shares))
      throw new ViewerServiceError("3D Viewer returned an invalid public-share list", "invalid_response");
    const shares = payload.shares.map(publicShare);
    if (shares.some(item => item === null))
      throw new ViewerServiceError("3D Viewer returned an invalid public-share list", "invalid_response");
    return shares as ViewerPublicShareSummary[];
  }

  async createPublicShare(input: {
    modelId: string;
    idempotencyKey: string;
    createdBy: string;
    label?: string | null;
    expiresAt?: string | null;
    displayUnits?: ViewerDisplayUnits;
    password?: string;
    permissions?: { view: true; measure?: boolean; cameras?: boolean; download?: boolean };
    shareClass?: "staff" | "client";
    sourceAuthorization?: {
      type: "client_grant";
      id: string;
      version: number;
      subject: string;
      expiresAt: string | null;
    };
  }): Promise<ViewerPublicShareCreation> {
    const path = `/api/v1/models/${encodeURIComponent(input.modelId)}/shares`;
    const body = JSON.stringify({
      versionPolicy: "latest",
      createdBy: input.createdBy,
      label: input.label || null,
      expiresAt: input.expiresAt || null,
      displayUnits: input.displayUnits || "imperial",
      ...(input.password ? { password: input.password } : {}),
      permissions: input.permissions || { view: true, measure: true, cameras: true, download: false },
      shareClass: input.shareClass || "staff",
      ...(input.sourceAuthorization ? { sourceAuthorization: input.sourceAuthorization } : {}),
    });
    const payload = record(await this.request(path, { method: "POST", body, idempotencyKey: input.idempotencyKey }));
    const share = publicShare(payload?.share);
    const token = typeof payload?.token === "string" ? payload.token : "";
    const viewUrl = assertViewerUrl(payload?.viewUrl, this.origin, `/view/${encodeURIComponent(token)}`);
    const embedUrl = assertViewerUrl(payload?.embedUrl, this.origin, `/embed/${encodeURIComponent(token)}`);
    const expectedPermissions = input.permissions || { view: true, measure: true, cameras: true, download: false };
    const expiryMatches = input.expiresAt
      ? share?.expiresAt !== null && Date.parse(share?.expiresAt || "") === Date.parse(input.expiresAt)
      : share?.expiresAt === null;
    if (!payload || !share || !viewUrl || !embedUrl || share.modelId !== input.modelId ||
      share.modelVersionId !== null || !expiryMatches || share.hasPassword !== Boolean(input.password) ||
      share.shareClass !== (input.shareClass || "staff") ||
      (input.sourceAuthorization && (share.sourceAuthorization?.id !== input.sourceAuthorization.id ||
        share.sourceAuthorization.version !== input.sourceAuthorization.version ||
        share.sourceAuthorization.subject !== input.sourceAuthorization.subject ||
        share.sourceAuthorization.expiresAt !== input.sourceAuthorization.expiresAt)) ||
      share.permissions.view !== true || share.permissions.measure !== (expectedPermissions.measure !== false) ||
      share.permissions.cameras !== (expectedPermissions.cameras !== false) ||
      share.permissions.download !== (expectedPermissions.download === true) ||
      token.length < 20 || token.length > 512 || !/^[A-Za-z0-9_-]+$/.test(token))
      throw new ViewerServiceError("3D Viewer returned an invalid public share", "invalid_response");
    return { share, viewUrl, embedUrl };
  }

  async revokePublicShare(input: {
    shareId: string;
    idempotencyKey: string;
    reason: string;
  }): Promise<ViewerPublicShareSummary> {
    const path = `/api/v1/shares/${encodeURIComponent(input.shareId)}`;
    const body = JSON.stringify({ reason: input.reason });
    const payload = record(await this.request(path, { method: "DELETE", body, idempotencyKey: input.idempotencyKey }));
    const share = publicShare(payload?.share);
    if (!share || share.id !== input.shareId || !share.revokedAt)
      throw new ViewerServiceError("3D Viewer returned an invalid revoked share", "invalid_response");
    return share;
  }
}
