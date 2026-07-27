import { requestJson, type RequestError } from "./bulk-download";

export type CloudTransferProvider = "dropbox" | "google-drive";
export type CloudTransferScope =
  | { all: true }
  | { items: string[] };
export type CloudTransferConflictPolicy = "rename" | "skip";
export type CloudTransferJobStatus =
  | "authorization_required"
  | "queued"
  | "running"
  | "ready"
  | "completed"
  | "failed"
  | "cancelled";
export type CloudTransferItemStatus =
  | "waiting"
  | "copying"
  | "retrying"
  | "copied"
  | "skipped"
  | "failed"
  | "cancelled";

export interface CloudTransferItemResult {
  id: string;
  name: string;
  status: CloudTransferItemStatus;
  processedBytes?: number;
  totalBytes?: number;
  message?: string;
}

export interface CloudTransferJob {
  id: string;
  provider: CloudTransferProvider;
  status: CloudTransferJobStatus;
  authorizationUrl?: string;
  authorizationState?: string;
  destinationName?: string;
  processedFiles?: number;
  totalFiles?: number;
  processedBytes?: number;
  totalBytes?: number;
  items?: CloudTransferItemResult[];
  message?: string;
  error?: { code?: string; message?: string } | null;
}

export interface CreateCloudTransferRequest {
  selection: CloudTransferScope;
  conflictMode: CloudTransferConflictPolicy;
  destination?: string;
  callbackNonce: string;
}

export interface CloudAuthorizationResult {
  type: "ltds-cloud-authorization";
  nonce: string;
  jobId: string;
  provider: CloudTransferProvider;
  ok: boolean;
  error?: string;
}

export interface CloudTransferPollingOptions {
  requestStatus?: (url: string) => Promise<CloudTransferJob>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  deadlineMs?: number;
  onProgress?: (job: CloudTransferJob) => void;
}

const POLL_INTERVAL_MS = 2_000;
const POLL_MAX_RETRY_MS = 30_000;
const POLL_DEADLINE_MS = 24 * 60 * 60 * 1_000;

export function cloudTransferBaseUrl(publicId: string): string {
  return `/api/public/shares/${encodeURIComponent(publicId)}/cloud-transfers`;
}

export function startCloudTransferAuthorization(publicId: string, provider: CloudTransferProvider, request: CreateCloudTransferRequest): Promise<{ authorizationUrl: string }> {
  return requestJson<{ authorizationUrl: string }>(`${cloudTransferBaseUrl(publicId)}/oauth/${encodeURIComponent(provider)}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(request),
  });
}

export function cancelCloudTransfer(publicId: string, jobId: string): Promise<CloudTransferJob> {
  return requestJson<CloudTransferJob>(`${cloudTransferBaseUrl(publicId)}/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: { "Accept": "application/json" },
  });
}

export function retryCloudTransfer(publicId: string, jobId: string): Promise<CloudTransferJob> {
  return requestJson<CloudTransferJob>(`${cloudTransferBaseUrl(publicId)}/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: { "Accept": "application/json" },
  });
}

export function isCloudAuthorizationResult(value: unknown): value is CloudAuthorizationResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<CloudAuthorizationResult>;
  return result.type === "ltds-cloud-authorization"
    && typeof result.nonce === "string"
    && typeof result.jobId === "string"
    && (result.provider === "dropbox" || result.provider === "google-drive")
    && typeof result.ok === "boolean"
    && (result.error === undefined || typeof result.error === "string");
}

export function waitForCloudAuthorization(
  popup: Window,
  expected: { origin: string; nonce: string },
  options: {
    windowObject?: Window;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<CloudAuthorizationResult> {
  const host = options.windowObject || window;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1_000;
  const pollMs = options.pollMs ?? 500;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      host.removeEventListener("message", onMessage);
      host.clearInterval(closedTimer);
      host.clearTimeout(timeout);
      action();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expected.origin || event.source !== popup || !isCloudAuthorizationResult(event.data)) return;
      const result = event.data;
      if (result.nonce !== expected.nonce) return;
      finish(() => result.ok ? resolve(result) : reject(new Error(result.error || "Authorization was not completed.")));
    };
    const closedTimer = host.setInterval(() => {
      if (popup.closed) finish(() => reject(new Error("The authorization window was closed before completion.")));
    }, pollMs);
    const timeout = host.setTimeout(() => {
      try { popup.close(); } catch { /* Cross-origin windows may reject close checks. */ }
      finish(() => reject(new Error("Authorization timed out. Please try again.")));
    }, timeoutMs);
    host.addEventListener("message", onMessage);
  });
}

export function openCloudAuthorizationWindow(options: {
  windowObject?: Window;
  openWindow?: (url: string, target: string, features: string) => Window | null;
} = {}): Window {
  const host = options.windowObject || window;
  const openWindow = options.openWindow || ((url, target, features) => host.open(url, target, features));
  const popup = openWindow("about:blank", "ltds-cloud-authorization", "popup,width=620,height=720");
  if (!popup) throw new Error("Your browser blocked the authorization window. Allow pop-ups and try again.");
  return popup;
}

export function parseCloudTransferCallback(url: string): { jobId: string; nonce: string } | null {`n  const parsed = new URL(url);`n  const jobId = parsed.searchParams.get("cloudTransferJob") || "";`n  const nonce = parsed.searchParams.get("cloudTransferNonce") || "";`n  return jobId && nonce ? { jobId, nonce } : null;`n}

export function notifyCloudTransferOpener(url: string, options: { windowObject?: Window } = {}): boolean {
  const host = options.windowObject || window;
  const callback = parseCloudTransferCallback(url);
  if (!callback || !host.opener) return false;
  host.opener.postMessage({ type: "ltds-cloud-authorization", ...callback, ok: true } satisfies CloudAuthorizationResult, host.location.origin);
  return true;
}
function isTransientError(caught: unknown): caught is RequestError {
  const error = caught as RequestError;
  return error.status === undefined || error.status === 429 || error.status >= 500;
}

function terminalError(job: CloudTransferJob): Error | null {
  if (job.status === "failed") return new Error(job.error?.message || job.message || "The files could not be copied.");
  if (job.status === "cancelled") return new Error(job.message || "The remaining files were cancelled.");
  return null;
}

export async function pollCloudTransfer(
  initial: CloudTransferJob,
  statusUrl: string,
  options: CloudTransferPollingOptions = {},
): Promise<CloudTransferJob> {
  const requestStatus = options.requestStatus || (url => requestJson<CloudTransferJob>(url));
  const sleep = options.sleep || (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const now = options.now || Date.now;
  const deadline = now() + (options.deadlineMs ?? POLL_DEADLINE_MS);
  let result = initial;
  let delay = POLL_INTERVAL_MS;
  let failures = 0;

  while (now() < deadline) {
    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining));
    if (now() >= deadline) break;
    try {
      result = { ...result, ...await requestStatus(statusUrl) };
      failures = 0;
      delay = POLL_INTERVAL_MS;
      options.onProgress?.(result);
    } catch (caught) {
      if (!isTransientError(caught)) throw caught;
      failures += 1;
      delay = (caught as RequestError).retryAfterMs
        ?? Math.min(POLL_MAX_RETRY_MS, POLL_INTERVAL_MS * 2 ** (failures - 1));
      continue;
    }
    const error = terminalError(result);
    if (error) throw error;
    if (result.status === "completed") return result;
    if (result.status === "authorization_required") return result;
  }
  throw new Error("The copy is still running. You can safely close this window and check again later.");
}

export function cloudTransferPercent(job: CloudTransferJob): number | null {
  if (job.totalBytes && typeof job.processedBytes === "number") {
    return Math.min(100, Math.max(0, Math.round(job.processedBytes / job.totalBytes * 100)));
  }
  if (job.totalFiles && typeof job.processedFiles === "number") {
    return Math.min(100, Math.max(0, Math.round(job.processedFiles / job.totalFiles * 100)));
  }
  return job.status === "completed" ? 100 : null;
}

export function failedCloudTransferItems(job: CloudTransferJob): CloudTransferItemResult[] {
  return (job.items || []).filter(item => item.status === "failed");
}
