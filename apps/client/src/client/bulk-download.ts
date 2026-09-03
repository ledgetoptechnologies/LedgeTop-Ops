export interface RequestErrorBody {
  error?: string | { code?: string; message?: string };
  code?: string;
  message?: string;
}

export type RequestError = Error & { status?: number; body?: RequestErrorBody; retryAfterMs?: number };

export interface BulkDownloadResponse {
  downloadUrl?: string;
  downloads?: Array<{ part: number; partCount: number; size?: number | null; downloadUrl: string }>;
  partCount?: number;
  ticket?: string;
  downloadTicket?: string;
  statusUrl?: string;
  progressUrl?: string;
  status?: "queued" | "processing" | "running" | "ready" | "failed" | "expired" | "cancelled" | "complete";
  progress?: number;
  percent?: number;
  message?: string;
  processedBytes?: number;
  totalBytes?: number;
  fileCount?: number;
  processedFiles?: number;
  archiveSize?: number | null;
  error?: { code?: string; message?: string } | null;
}

export interface BulkProgressView {
  status: string;
  percent: number | null;
  message?: string;
}

export function bulkDownloadProgress(response: BulkDownloadResponse): BulkProgressView {
  if (response.status === "ready" || response.status === "complete") {
    return { status: "Download ready", percent: 100, message: "ZIP preparation complete. Your browser will start the download." };
  }
  if (response.status === "queued") {
    return { status: "Download queued", percent: null, message: "Waiting to prepare your ZIP on the server." };
  }
  if (response.status === "failed" || response.status === "expired" || response.status === "cancelled") {
    return { status: `Download ${response.status}`, percent: null, message: response.error?.message || response.message || undefined };
  }

  const calculated = response.totalBytes && typeof response.processedBytes === "number"
    ? response.processedBytes / response.totalBytes * 100 : null;
  const value = typeof response.progress === "number" ? response.progress : typeof response.percent === "number" ? response.percent : calculated;
  // These bytes measure weighted preparation work, not bytes downloaded.
  const percent = value !== null && Number.isFinite(value) ? Math.min(99, Math.max(0, Math.round(value))) : null;
  const active = response.status === "running" || response.status === "processing";
  const checking = active && (response.archiveSize === null || (response.archiveSize === undefined && response.message === "Checking files"));
  const building = active && (typeof response.archiveSize === "number" || response.message === "Building ZIP");
  const hasCounts = Number.isInteger(response.fileCount) && response.fileCount! > 0 && Number.isInteger(response.processedFiles) && response.processedFiles! >= 0;
  const status = checking
    ? hasCounts ? `Checking files ${Math.min(response.processedFiles!, response.fileCount!).toLocaleString("en-US")} of ${response.fileCount!.toLocaleString("en-US")}` : "Checking files"
    : building ? "Building ZIP" : "Preparing download";
  const detail = checking
    ? "Verifying files before building the ZIP. Large files can take longer."
    : building ? "Assembling the ZIP on the server. The download starts when it is ready."
      : "Preparing your ZIP on the server. Large downloads can take several minutes.";
  return { status, percent, message: `${percent === null ? "" : `${percent}% prepared · `}${detail}` };
}

const CLIENT_WORKSPACE_STORAGE_KEY = "ltds.client.workspace.v2";

export function selectedClientWorkspaceId(): string | null {
  if (typeof window === "undefined" || !window.sessionStorage) return null;
  const value = window.sessionStorage.getItem(CLIENT_WORKSPACE_STORAGE_KEY);
  return value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value) ? value : null;
}

export function selectClientWorkspaceId(value: string | null): void {
  if (typeof window === "undefined" || !window.sessionStorage) return;
  if (value && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value))
    window.sessionStorage.setItem(CLIENT_WORKSPACE_STORAGE_KEY, value);
  else window.sessionStorage.removeItem(CLIENT_WORKSPACE_STORAGE_KEY);
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function requestErrorMessage(body: RequestErrorBody): string {
  if (typeof body.error === "string") return body.error;
  if (body.error?.message) return body.error.message;
  return body.message || "Request failed";
}

export type ClientRequestInit = RequestInit & { omitWorkspace?: boolean };

export async function requestJson<T>(url: string, init?: ClientRequestInit): Promise<T> {
  const { omitWorkspace, ...fetchInit } = init ?? {};
  const headers = new Headers(fetchInit.headers);
  if (omitWorkspace) headers.delete("X-LTDS-Workspace-Id");
  const workspaceId = !omitWorkspace && url.startsWith("/api/client/") && !url.startsWith("/api/client/v2/")
    ? selectedClientWorkspaceId()
    : null;
  if (workspaceId) headers.set("X-LTDS-Workspace-Id", workspaceId);
  const response = await fetch(url, { credentials: "same-origin", ...fetchInit, headers });
  const body = await response.json().catch(() => ({})) as RequestErrorBody & T;
  if (!response.ok) {
    throw Object.assign(new Error(requestErrorMessage(body)), {
      status: response.status,
      body,
      retryAfterMs: parseRetryAfter(response.headers.get("Retry-After")),
    });
  }
  return body;
}

const BULK_POLL_INTERVAL_MS = 2_000;
const BULK_POLL_DEADLINE_MS = 60 * 60 * 1_000;
const BULK_RETRY_MAX_MS = 30_000;

export interface BulkPollingOptions {
  requestStatus?: (url: string) => Promise<BulkDownloadResponse>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  onProgress?: (response: BulkDownloadResponse) => void;
}

function terminalBulkError(response: BulkDownloadResponse): Error | null {
  if (response.status === "failed") return new Error(response.error?.message || response.message || "The download could not be prepared.");
  if (response.status === "expired") return new Error(response.message || "This prepared download has expired. Please start a new download.");
  if (response.status === "cancelled") return new Error(response.message || "This download was cancelled. Please start it again.");
  return null;
}

function isTransientPollingError(caught: unknown): caught is RequestError {
  const value = caught as RequestError;
  return value.status === undefined || value.status === 429 || value.status >= 500;
}

export async function pollBulkDownload(
  initial: BulkDownloadResponse,
  statusUrl: string,
  options: BulkPollingOptions = {},
): Promise<BulkDownloadResponse> {
  const requestStatus = options.requestStatus || (url => requestJson<BulkDownloadResponse>(url));
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const deadline = now() + (options.deadlineMs ?? BULK_POLL_DEADLINE_MS);
  let response = initial;
  let delay = BULK_POLL_INTERVAL_MS;
  let transientFailures = 0;

  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    if (now() >= deadline) break;

    let status: BulkDownloadResponse;
    try {
      status = await requestStatus(statusUrl);
    } catch (caught) {
      if (!isTransientPollingError(caught)) throw caught;
      transientFailures += 1;
      const retryAfterMs = (caught as RequestError).retryAfterMs;
      delay = retryAfterMs ?? Math.min(BULK_RETRY_MAX_MS, BULK_POLL_INTERVAL_MS * 2 ** (transientFailures - 1));
      continue;
    }
    response = { ...response, ...status };
    transientFailures = 0;
    delay = BULK_POLL_INTERVAL_MS;
    options.onProgress?.(response);
    const terminalError = terminalBulkError(response);
    if (terminalError) throw terminalError;
    if (response.downloadUrl || response.downloads?.length || response.ticket || response.downloadTicket || response.status === "ready" || response.status === "complete") return response;
  }

  throw new Error("The download is still being prepared. Please try again in a few minutes.");
}
