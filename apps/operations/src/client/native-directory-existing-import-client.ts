import { api } from "./api";

export const EXISTING_IMPORT_ENDPOINT = "/api/client-hub/directory/existing-import";
export type ExistingImportRequest = typeof api;
export type ImportCandidate = { sourceId: string; kind: "organization" | "client"; recordId: string;
  publicId: string; name: string; parentRecordId: string | null; parentPublicId: string | null; businessAreaId: string };
export type ImportReference = Pick<ImportCandidate, "sourceId" | "kind" | "recordId" | "businessAreaId"> & {
  idempotencyKey: string; importId?: string };
export type ImportReview = ImportCandidate & { importId: string; batchId: string; nativeRecordId: string;
  parentNativeRecordId: string | null; profile: Record<string, string>; expiresAt: string };
export type ImportState = "reviewed" | "activated" | "pending" | "blocked" | "conflict";
export type ImportStatus = { status: ImportState; review: ImportReview; reason?: string; renewable?: boolean; expiryReason?: string };
export type ImportJob = { version: 1; batchId: string; records: ImportReference[] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PUBLIC_ID = /^[0-9a-f]{32}$/;
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max = 191): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}
function reference(value: unknown): value is ImportReference {
  return object(value) && typeof value.sourceId === "string" && SOURCE.test(value.sourceId)
    && (value.kind === "organization" || value.kind === "client") && text(value.recordId)
    && text(value.businessAreaId) && typeof value.idempotencyKey === "string" && UUID.test(value.idempotencyKey)
    && (value.importId === undefined || text(value.importId));
}
export function importCandidateKey(value: Pick<ImportCandidate, "sourceId" | "kind" | "recordId">): string {
  return JSON.stringify([value.sourceId, value.kind, value.recordId]);
}
export function nativeImportRecordId(value: Pick<ImportCandidate, "sourceId" | "kind" | "recordId">): string {
  return `pa-import:${value.sourceId}:${value.kind}:${value.recordId}`;
}
export function sortImportCandidates<T extends Pick<ImportCandidate, "sourceId" | "kind" | "recordId">>(values: readonly T[]): T[] {
  return [...values].sort((a, b) => Number(a.kind !== "organization") - Number(b.kind !== "organization")
    || a.sourceId.localeCompare(b.sourceId) || a.recordId.localeCompare(b.recordId));
}
function candidate(value: unknown): value is ImportCandidate {
  return object(value) && typeof value.sourceId === "string" && SOURCE.test(value.sourceId)
    && (value.kind === "organization" || value.kind === "client") && text(value.recordId)
    && typeof value.publicId === "string" && PUBLIC_ID.test(value.publicId) && text(value.name, 150)
    && text(value.businessAreaId) && (value.parentRecordId === null || text(value.parentRecordId))
    && (value.parentPublicId === null || typeof value.parentPublicId === "string" && PUBLIC_ID.test(value.parentPublicId));
}
/** Local persistence contains opaque references only. Server authorization is
 * rechecked before any names, profiles, or outcomes are restored. */
export function parseImportJob(value: string | null): ImportJob | null {
  try {
    const parsed: unknown = JSON.parse(value ?? "null");
    if (!object(parsed) || parsed.version !== 1 || typeof parsed.batchId !== "string" || !UUID.test(parsed.batchId)
      || !Array.isArray(parsed.records) || parsed.records.length < 1 || parsed.records.length > 1000
      || !parsed.records.every(reference)) return null;
    if (new Set(parsed.records.map(importCandidateKey)).size !== parsed.records.length) return null;
    return { version: 1, batchId: parsed.batchId, records: parsed.records.map(row => ({ sourceId: row.sourceId,
      kind: row.kind, recordId: row.recordId, businessAreaId: row.businessAreaId,
      idempotencyKey: row.idempotencyKey, ...(row.importId ? { importId: row.importId } : {}) })) };
  } catch { return null; }
}
export async function loadImportCandidates(request: ExistingImportRequest = api): Promise<ImportCandidate[]> {
  const items: ImportCandidate[] = [], seen = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: URLSearchParams = new URLSearchParams({ limit: "50", ...(cursor ? { cursor } : {}) });
    const result: unknown = await request<unknown>(`${EXISTING_IMPORT_ENDPOINT}/candidates?${query}`);
    if (!object(result) || !Array.isArray(result.items) || result.items.length > 50
      || !(result.nextCursor === null || text(result.nextCursor, 4096))) throw new Error("Invalid import candidate response.");
    for (const item of result.items) {
      if (!candidate(item) || seen.has(importCandidateKey(item))) throw new Error("Ambiguous import candidate response.");
      seen.add(importCandidateKey(item)); items.push(item);
    }
    if (result.nextCursor === null) return sortImportCandidates(items);
    cursor = result.nextCursor;
    if (cursors.has(cursor)) throw new Error("Import candidate pagination did not advance.");
    cursors.add(cursor);
  }
  throw new Error("Too many records for one import review.");
}
function review(value: unknown, expected: ImportReference, batchId: string): ImportReview {
  if (!object(value) || !text(value.importId) || value.batchId !== batchId
    || value.sourceId !== expected.sourceId || value.kind !== expected.kind || value.recordId !== expected.recordId
    || value.businessAreaId !== expected.businessAreaId || value.nativeRecordId !== nativeImportRecordId(expected)
    || typeof value.publicId !== "string" || !PUBLIC_ID.test(value.publicId) || !text(value.name, 150)
    || !(value.parentPublicId === undefined || value.parentPublicId === null
      || typeof value.parentPublicId === "string" && PUBLIC_ID.test(value.parentPublicId))
    || !(value.parentRecordId === null || text(value.parentRecordId))
    || value.parentNativeRecordId !== (value.parentRecordId === null ? null
      : nativeImportRecordId({ sourceId: expected.sourceId, kind: "organization", recordId: value.parentRecordId }))
    || !object(value.profile) || Object.keys(value.profile).length > 20
    || !Object.values(value.profile).every(field => typeof field === "string" && field.length <= 2000)
    || typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))
    throw new Error("Import review does not match the selected record.");
  return { ...value, parentPublicId: value.parentPublicId ?? null } as ImportReview;
}
export async function reviewImportRecord(request: ExistingImportRequest, batchId: string,
  selected: ImportCandidate, ref: ImportReference): Promise<ImportReview> {
  const result = await request<unknown>(`${EXISTING_IMPORT_ENDPOINT}/review`, { method: "POST",
    headers: { "Idempotency-Key": ref.idempotencyKey }, body: JSON.stringify({ batchId, sourceId: ref.sourceId,
      kind: ref.kind, recordId: ref.recordId, businessAreaId: ref.businessAreaId, idempotencyKey: ref.idempotencyKey }) });
  if (!object(result) || result.status !== "reviewed") throw new Error("This record could not be reviewed. Refresh its source before continuing.");
  const parsed = review(result.review, ref, batchId);
  if (parsed.publicId !== selected.publicId || parsed.parentRecordId !== selected.parentRecordId
    || parsed.parentPublicId !== selected.parentPublicId)
    throw new Error("The PA record or its organization changed. Refresh the import list.");
  return parsed;
}
export async function readImportStatus(request: ExistingImportRequest, batchId: string, ref: ImportReference): Promise<ImportStatus> {
  if (!ref.importId) throw new Error("No import review is available.");
  const result = await request<unknown>(`${EXISTING_IMPORT_ENDPOINT}/status?${new URLSearchParams({ importId: ref.importId })}`);
  if (!object(result) || !["reviewed", "activated", "pending", "blocked", "conflict"].includes(String(result.status)))
    throw new Error("Import status could not be verified.");
  const parsed = review(result.review, ref, batchId);
  if (parsed.importId !== ref.importId) throw new Error("Import status returned a different review.");
  if (result.renewable !== undefined && typeof result.renewable !== "boolean") throw new Error("Invalid import renewal status.");
  return { status: result.status as ImportState, review: parsed,
    ...(typeof result.reason === "string" ? { reason: result.reason } : {}),
    ...(typeof result.renewable === "boolean" ? { renewable: result.renewable } : {}),
    ...(typeof result.expiryReason === "string" ? { expiryReason: result.expiryReason } : {}) };
}
export async function renewImportRecord(request: ExistingImportRequest, previous: ImportReview,
  ref: ImportReference): Promise<ImportReview> {
  const result = await request<unknown>(`${EXISTING_IMPORT_ENDPOINT}/renew`, { method: "POST",
    headers: { "Idempotency-Key": previous.importId }, body: JSON.stringify({ importId: previous.importId }) });
  if (!object(result) || result.status !== "reviewed") throw new Error("This import could not be renewed. Check its saved status.");
  const parsed = review(result.review, ref, previous.batchId);
  const fields = ["importId", "publicId", "parentRecordId", "parentPublicId", "parentNativeRecordId", "name"] as const;
  const profile = (value: Record<string, string>) => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (fields.some(field => parsed[field] !== previous[field]) || profile(parsed.profile) !== profile(previous.profile))
    throw new Error("The renewed import changed its reviewed identity or profile.");
  return parsed;
}
export async function executeImportRecord(request: ExistingImportRequest, value: ImportReview): Promise<ImportState> {
  const result = await request<unknown>(`${EXISTING_IMPORT_ENDPOINT}/execute`, { method: "POST",
    headers: { "Idempotency-Key": value.importId }, body: JSON.stringify({ importId: value.importId }) });
  if (!object(result) || result.importId !== value.importId
    || !["activated", "pending", "blocked", "conflict"].includes(String(result.status))
    || result.status === "activated" && result.recordId !== value.nativeRecordId)
    throw new Error("Import acknowledgement could not be verified. Check its status before resuming.");
  return result.status as ImportState;
}
export async function advanceImportRecord(request: ExistingImportRequest, batchId: string, ref: ImportReference,
  shouldContinue: () => boolean): Promise<ImportStatus> {
  const current = await readImportStatus(request, batchId, ref);
  if (current.status === "activated" || current.status === "blocked" || current.status === "conflict" || !shouldContinue()) return current;
  if (current.renewable) return { ...current, status: "blocked", reason: "Renew the expired review before continuing." };
  return { ...current, status: await executeImportRecord(request, current.review) };
}
