import { parseDuplicateFreeJson } from "./bounded-json";
import { decimal, exact, externalId, hash, plain, publicId, uuid } from "./project-alpha-project-transport";

/** Unrouted protocol boundary only. A valid PA response is NOT recipient authority.
 * Callers must independently recheck the current recipient billing allowlist and
 * exact customer/project grants before disclosing any document or bearer URL. */
export type FinancialSelector = Readonly<{
  kind: "organization" | "client" | "project";
  externalId: string;
  publicId: string;
  revision: string;
  projectionSha256: string;
  authorizationGeneration: string;
}>;
export type FinancialDocument = Readonly<{
  publicId: string;
  kind: "invoice" | "contract" | "project_invoice";
  status: string;
  currency: string;
  total: string;
  amountPaid: string | null;
  balanceDue: string | null;
  documentUrl: string | null;
  actionUrl: string | null;
}>;
export type FinancialPage = Readonly<{
  apiVersion: "2";
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  selector: FinancialSelector;
  snapshot: Readonly<{ sha256: string; documentCount: number }>;
  documents: readonly FinancialDocument[];
  nextCursor: string | null;
}>;
export type FinancialExpectation = Readonly<{
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  requestId: string;
  paOrigin: string;
  selector: FinancialSelector;
  /** Required when consuming a continuation, from the first validated page. */
  snapshotSha256?: string;
}>;
const SELECTOR_KEYS = ["kind", "externalId", "publicId", "revision", "projectionSha256", "authorizationGeneration"] as const;
const MONEY = /^(?:0|[1-9][0-9]{0,17})\.[0-9]{2}$/;
const MAX_BYTES = 128 * 1024;

function selector(value: unknown): value is FinancialSelector {
  return plain(value) && exact(value, SELECTOR_KEYS)
    && ["organization", "client", "project"].includes(String(value.kind))
    && externalId(value.externalId) && publicId(value.publicId)
    && decimal(value.revision, true) && hash(value.projectionSha256) && decimal(value.authorizationGeneration);
}
function cents(value: string): bigint { return BigInt(value.replace(".", "")); }
function sameSelector(left: FinancialSelector, right: FinancialSelector): boolean {
  return SELECTOR_KEYS.every(key => left[key] === right[key]);
}
function origin(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value && !url.username && !url.password
      && !url.search && !url.hash && url.pathname === "/" ? value : null;
  } catch { return null; }
}
function link(value: unknown, expectedOrigin: string, page: "public-doc" | "stripe-checkout"): boolean {
  if (value === null) return true;
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    const keys = [...url.searchParams.keys()];
    // Require canonical serialization: no encoded paths, dot segments,
    // whitespace trimming, duplicate parameters, fragments or userinfo.
    return url.href === value && url.origin === expectedOrigin && url.pathname === "/"
      && !url.username && !url.password && !url.hash
      && keys.length === 2 && keys.filter(key => key === "page").length === 1
      && keys.filter(key => key === "token").length === 1 && url.searchParams.get("page") === page
      && /^[A-Za-z0-9_-]{16,64}$/.test(url.searchParams.get("token") ?? "");
  } catch { return false; }
}
function document(value: unknown, expectedOrigin: string): value is FinancialDocument {
  if (!plain(value) || !exact(value, ["publicId", "kind", "status", "currency", "total", "amountPaid", "balanceDue", "documentUrl", "actionUrl"])
    || !publicId(value.publicId) || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)
    || typeof value.total !== "string" || !MONEY.test(value.total)
    || !link(value.documentUrl, expectedOrigin, "public-doc")) return false;
  if (value.kind === "contract") return ["pending", "active", "paused", "completed"].includes(String(value.status))
    && value.amountPaid === null && value.balanceDue === null
    && link(value.actionUrl, expectedOrigin, "public-doc")
    && (value.status === "pending" || value.documentUrl === null && value.actionUrl === null)
    && (value.actionUrl === null || value.status === "pending" && value.actionUrl === value.documentUrl);
  if (value.kind !== "invoice" && value.kind !== "project_invoice") return false;
  const statuses = ["sent", "unpaid", "partial", "paid", "overdue"];
  if (!statuses.includes(String(value.status)) || typeof value.amountPaid !== "string" || !MONEY.test(value.amountPaid)
    || typeof value.balanceDue !== "string" || !MONEY.test(value.balanceDue)
    || !link(value.actionUrl, expectedOrigin, "stripe-checkout")) return false;
  // Do not use floating point for financial comparisons. PA may represent
  // credits/overpayments, so do not invent total = paid + due as a contract.
  return (value.status !== "paid" || cents(value.balanceDue) === 0n && value.documentUrl === null && value.actionUrl === null)
    && (value.actionUrl === null || value.status !== "paid" && cents(value.balanceDue) > 0n && typeof value.actionUrl === "string" && typeof value.documentUrl === "string"
      && new URL(value.actionUrl).searchParams.get("token") === new URL(value.documentUrl).searchParams.get("token"));
}

/** Decodes already-bounded transport bytes. Never logs or returns invalid
 * payloads: they may contain private data or bearer capabilities. */
export function decodeProjectAlphaFinancialPage(bytes: Uint8Array, expected: FinancialExpectation): FinancialPage | null {
  if (bytes.byteLength > MAX_BYTES || !origin(expected.paOrigin) || !selector(expected.selector)
    || ![expected.sourceInstanceId, expected.applicationId, expected.historyEpoch, expected.requestId].every(uuid)
    || expected.snapshotSha256 !== undefined && !hash(expected.snapshotSha256)) return null;
  try {
    const value = parseDuplicateFreeJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!plain(value) || !exact(value, ["apiVersion", "sourceInstanceId", "applicationId", "historyEpoch", "requestId", "selector", "snapshot", "documents", "nextCursor"])
      || value.apiVersion !== "2" || value.sourceInstanceId !== expected.sourceInstanceId || value.applicationId !== expected.applicationId
      || value.historyEpoch !== expected.historyEpoch || value.requestId !== expected.requestId || !selector(value.selector)
      || !sameSelector(value.selector, expected.selector)
      || !plain(value.snapshot) || !exact(value.snapshot, ["sha256", "documentCount"]) || !hash(value.snapshot.sha256)
      || expected.snapshotSha256 !== undefined && value.snapshot.sha256 !== expected.snapshotSha256
      || typeof value.snapshot.documentCount !== "number" || !Number.isSafeInteger(value.snapshot.documentCount)
      || value.snapshot.documentCount < 0 || value.snapshot.documentCount > 10000
      || !Array.isArray(value.documents) || value.documents.length > 100 || value.documents.length > value.snapshot.documentCount
      || value.documents.some(item => !document(item, expected.paOrigin))
      || value.nextCursor !== null && (typeof value.nextCursor !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value.nextCursor))
      || value.nextCursor !== null && (value.documents.length === 0 || value.documents.length >= value.snapshot.documentCount)) return null;
    const ids = new Set<string>();
    for (const item of value.documents) {
      const identity = `${item.kind}:${item.publicId}`;
      if (ids.has(identity)) return null;
      ids.add(identity);
      Object.freeze(item);
    }
    Object.freeze(value.selector); Object.freeze(value.snapshot); Object.freeze(value.documents);
    return Object.freeze(value) as FinancialPage;
  } catch { return null; }
}
