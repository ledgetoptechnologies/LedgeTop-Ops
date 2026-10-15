import { decodeProjectAlphaFinancialPage, isFinancialSelector, type FinancialDocument, type FinancialSelector } from "./project-alpha-financial-boundary";
import { withEnabledConfiguredProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";

const MAX_PAGE_BYTES = 128 * 1024;
const PAGE_LIMIT = 100;
const MAX_DOCUMENTS = 10_000;
const MAX_PAGES = Math.ceil(MAX_DOCUMENTS / PAGE_LIMIT);
/** One portal read budget, including every page and every response body. */
export const FINANCIAL_COLLECTION_TIMEOUT_MS = 10_000;
const trustedSelector = Symbol("trusted-financial-selector");

export type TrustedFinancialMapping = Readonly<FinancialSelector & { sourceId: string }>;
export type TrustedFinancialSelector = Readonly<FinancialSelector & { [trustedSelector]: true }>;

export type FinancialCollection = Readonly<{
  selector: FinancialSelector;
  snapshotSha256: string;
  documents: readonly FinancialDocument[];
}>;

export type FinancialTransportResult =
  | { status: "ok"; value: FinancialCollection }
  | { status: "disabled" | "misconfigured" | "unavailable" | "unauthorized" | "incompatible" };

/** The mapping must come from a server-owned current projection. This helper
 * deliberately accepts the complete pinned tuple; HTTP/browser inputs never
 * become a selector merely by supplying an external ID. */
export function selectorFromTrustedFinancialMapping(mapping: TrustedFinancialMapping): TrustedFinancialSelector | null {
  const candidate = { kind: mapping.kind, externalId: mapping.externalId, publicId: mapping.publicId,
    revision: mapping.revision, projectionSha256: mapping.projectionSha256,
    authorizationGeneration: mapping.authorizationGeneration } as FinancialSelector;
  if (!isFinancialSelector(candidate) || !/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/.test(mapping.sourceId)) return null;
  return Object.freeze(Object.defineProperty(candidate, trustedSelector, { value: true })) as TrustedFinancialSelector;
}

function withinDeadline<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => { signal.removeEventListener("abort", aborted); reject(new Error("deadline")); };
    if (signal.aborted) { reject(new Error("deadline")); return; }
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then(value => {
      signal.removeEventListener("abort", aborted); resolve(value);
    }, error => {
      signal.removeEventListener("abort", aborted); reject(error);
    });
  });
}

// Cancellation is best-effort cleanup, never another unbounded upstream wait.
function cancelBody(body: ReadableStream<Uint8Array> | null) {
  if (body && !body.locked) void body.cancel().catch(() => undefined);
}

async function boundedBytes(response: Response, signal: AbortSignal): Promise<Uint8Array | null> {
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_PAGE_BYTES)) {
    cancelBody(response.body); return null;
  }
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const part = await withinDeadline(reader.read(), signal);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_PAGE_BYTES) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(part.value);
    }
  } catch { void reader.cancel().catch(() => undefined); return null; }
  finally { reader.releaseLock(); }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

export async function readConfiguredProjectAlphaFinancialDocuments(
  env: ProjectAlphaApiV2ConnectionEnvironment,
  mapping: TrustedFinancialMapping,
  selector: TrustedFinancialSelector,
  send: typeof fetch = fetch,
): Promise<FinancialTransportResult> {
  const expectedSelector = selectorFromTrustedFinancialMapping(mapping);
  if (!expectedSelector || selector[trustedSelector] !== true
    || JSON.stringify(selector) !== JSON.stringify(expectedSelector)) return { status: "misconfigured" };
  const wireSelector: FinancialSelector = Object.freeze({ kind: selector.kind, externalId: selector.externalId,
    publicId: selector.publicId, revision: selector.revision, projectionSha256: selector.projectionSha256,
    authorizationGeneration: selector.authorizationGeneration });
  const configured = await withEnabledConfiguredProjectAlphaApiV2Connection(env, mapping.sourceId, async connection => {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), FINANCIAL_COLLECTION_TIMEOUT_MS);
    const documents: FinancialDocument[] = [], identities = new Set<string>(), cursors = new Set<string>();
    let cursor: string | null = null, snapshotSha256: string | undefined, expectedCount: number | undefined;
    try { for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
      const url = new URL("/api/v2/financial-documents", connection.baseUrl);
      url.searchParams.set("selectorType", selector.kind); url.searchParams.set("externalId", selector.externalId);
      url.searchParams.set("limit", String(PAGE_LIMIT)); if (cursor !== null) url.searchParams.set("cursor", cursor);
      const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${connection.apiKey}`,
        "X-PA-Source-Instance-ID": connection.expectedSourceInstanceId,
        "X-PA-Application-ID": connection.expectedApplicationId,
        "X-PA-History-Epoch": connection.expectedHistoryEpoch ?? "" });
      if (connection.accessClientId && connection.accessClientSecret) {
        headers.set("CF-Access-Client-Id", connection.accessClientId);
        headers.set("CF-Access-Client-Secret", connection.accessClientSecret);
      }
      let response: Response;
      try {
        const pending = send(url, { method: "GET", headers, redirect: "manual", credentials: "omit", cache: "no-store", signal: controller.signal });
        void pending.then(value => { if (controller.signal.aborted) cancelBody(value.body); }, () => undefined);
        response = await withinDeadline(pending, controller.signal);
      }
      catch { return { status: "unavailable" as const }; }
      const responseRequestId = response.headers.get("X-Request-ID");
      if (response.redirected || response.status >= 300 && response.status < 400 || response.headers.has("Location")
        || response.headers.has("Set-Cookie") || !/^application\/json(?:\s*;|$)/i.test(response.headers.get("Content-Type") ?? "")
        || !(response.headers.get("Cache-Control") ?? "").split(",").some(value => value.trim().toLowerCase() === "no-store")) {
        cancelBody(response.body); return { status: "incompatible" as const };
      }
      if (response.status === 401 || response.status === 403) { cancelBody(response.body); return { status: "unauthorized" as const }; }
      if (response.status !== 200 || !responseRequestId) { cancelBody(response.body); return { status: response.status >= 500 ? "unavailable" as const : "incompatible" as const }; }
      const bytes = await boundedBytes(response, controller.signal);
      if (!bytes) return { status: controller.signal.aborted ? "unavailable" as const : "incompatible" as const };
      const page = decodeProjectAlphaFinancialPage(bytes, { sourceInstanceId: connection.expectedSourceInstanceId,
        applicationId: connection.expectedApplicationId, historyEpoch: connection.expectedHistoryEpoch ?? "",
        requestId: responseRequestId, paOrigin: connection.baseUrl, selector: wireSelector, ...(snapshotSha256 ? { snapshotSha256 } : {}) });
      if (!page) return { status: "incompatible" as const };
      snapshotSha256 ??= page.snapshot.sha256; expectedCount ??= page.snapshot.documentCount;
      if (page.snapshot.documentCount !== expectedCount) return { status: "incompatible" as const };
      for (const document of page.documents) {
        const identity = `${document.kind}:${document.publicId}`;
        if (identities.has(identity)) return { status: "incompatible" as const };
        identities.add(identity); documents.push(document);
      }
      if (documents.length > expectedCount || documents.length > MAX_DOCUMENTS) return { status: "incompatible" as const };
      if (page.nextCursor === null) {
        if (documents.length !== expectedCount) return { status: "incompatible" as const };
        return { status: "ok" as const, value: Object.freeze({ selector: wireSelector, snapshotSha256, documents: Object.freeze(documents) }) };
      }
      if (cursors.has(page.nextCursor)) return { status: "incompatible" as const };
      cursors.add(page.nextCursor); cursor = page.nextCursor;
    }
    return { status: "incompatible" as const };
    } finally { clearTimeout(timer); controller.abort(); }
  });
  if (configured.status === "enabled") return configured.value;
  return { status: configured.status };
}
