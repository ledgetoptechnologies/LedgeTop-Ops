const BASE = "/api/native-client-portal/operations-delivery-authority";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const CSRF = /^\d{1,12}\.[0-9a-f]{64}$/u;
const CURSOR = /^v1\.[A-Za-z0-9_-]+\.[0-9a-f]{64}$/u;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const STAFF_HEADERS = Object.freeze({ "X-Native-Staff-Request": "1" });
export const OPERATIONS_NATIVE_DELIVERY_FEATURES = [
  "folder.list", "file.metadata", "file.preview", "file.download",
] as const;

export type OperationsNativeDeliveryFeature = typeof OPERATIONS_NATIVE_DELIVERY_FEATURES[number];
export type OperationsNativeDeliveryCandidate = Readonly<{
  candidateFingerprint: string;
  recipientBindingId: string;
  enrollmentIntentId: string;
  targetId: string;
  targetRevision: number;
  targetClientRecordId: string;
  clientLabel: string;
  recipientLabel: string;
  workspaceId: string;
  homeOwnershipEpoch: number;
  homeGrantRevision: number;
  publicationRevision: number;
  folderReservationId: string;
  folderReservationRevision: number;
  clientFolderBindingId: string;
  externalProjectId: string;
  projectLabel: string;
  projectVersion: number;
  opsFolderProjectId: string;
  folderLabel: string;
  opsDivisionId: string;
}>;
export type OperationsNativeDeliveryCandidatePage = Readonly<{
  items: readonly OperationsNativeDeliveryCandidate[];
  page: Readonly<{ nextCursor: string | null }>;
}>;
export type OperationsNativeDeliveryAuthority = Readonly<{
  authorityId: string;
  revision: number;
  state: "active" | "revoked";
  recipientBindingId: string;
  enrollmentIntentId: string;
  folderReservationId: string;
  targetId: string;
  targetClientRecordId: string;
  workspaceId: string;
  clientFolderBindingId: string;
  externalProjectId: string;
  opsFolderProjectId: string;
  opsDivisionId: string;
  clientLabel: string;
  recipientLabel: string;
  projectLabel: string;
  folderLabel: string;
  features: readonly OperationsNativeDeliveryFeature[];
  expiresAt: string | null;
  latestOperationId: string;
  latestAction: "delivery.grant" | "delivery.revoke";
  transportStatus: "pending" | "acknowledged" | "dead";
  recoveryOperationId: string | null;
}>;
export type OperationsNativeDeliveryAuthorityPage = Readonly<{
  items: readonly OperationsNativeDeliveryAuthority[];
  page: Readonly<{ nextCursor: string | null }>;
}>;
export type OperationsNativeDeliveryOwnerSession = Readonly<{ csrfToken: string; verifiedUntil: string }>;
export type OperationsNativeDeliveryGrantInput = Readonly<{
  operationId: string;
  authorityId: string;
  recipientBindingId: string;
  folderReservationId: string;
  expectedRevision: 0;
  expectedCandidateFingerprint: string;
  features: readonly OperationsNativeDeliveryFeature[];
  expiresAt: string;
  reasonCode: string;
}>;
export type OperationsNativeDeliveryRevokeInput = Readonly<{
  operationId: string;
  expectedRevision: number;
  reasonCode: string;
}>;
export type OperationsNativeDeliveryRecoverInput = Readonly<{
  invocationId: string;
  operationId: string;
  expectedRevision: number;
  reason: string;
}>;
export type OperationsNativeDeliveryMutationSuccess = Readonly<{
  operationId: string;
  status: "acknowledged" | "pending";
  authority: OperationsNativeDeliveryAuthority;
  replayed: boolean;
  recoveryOperationId: string | null;
}>;
export type OperationsNativeDeliveryMutationRejected = Readonly<{
  operationId: string;
  status: "rejected";
}>;
export type OperationsNativeDeliveryMutationResult =
  OperationsNativeDeliveryMutationSuccess | OperationsNativeDeliveryMutationRejected;

export class OperationsNativeDeliveryOwnerApiError extends Error {
  constructor(readonly status: number, readonly uncertain: boolean) {
    super(uncertain ? "uncertain" : "denied");
  }
}

function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    return null;
  const names = Object.keys(value);
  return names.length === fields.length && fields.every(field => Object.hasOwn(value, field))
    && names.every(field => fields.includes(field)) ? value as Record<string, unknown> : null;
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value === value.trim() && !/\p{C}/u.test(value);
}
function integer(value: unknown, minimum = 1): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}
function canonicalInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length !== 24) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function parseFeatures(value: unknown, allowEmpty: boolean): readonly OperationsNativeDeliveryFeature[] | null {
  if (!Array.isArray(value) || value.length > OPERATIONS_NATIVE_DELIVERY_FEATURES.length
    || (!allowEmpty && value.length === 0)) return null;
  let prior = -1;
  for (const item of value) {
    const index = OPERATIONS_NATIVE_DELIVERY_FEATURES.indexOf(item as OperationsNativeDeliveryFeature);
    if (typeof item !== "string" || index <= prior) return null;
    prior = index;
  }
  return Object.freeze([...value]) as readonly OperationsNativeDeliveryFeature[];
}

export function parseOperationsNativeDeliveryCandidate(value: unknown): OperationsNativeDeliveryCandidate | null {
  const row = exactRecord(value, ["candidateFingerprint", "recipientBindingId", "enrollmentIntentId", "targetId",
    "targetRevision", "targetClientRecordId", "clientLabel", "recipientLabel", "workspaceId", "homeOwnershipEpoch",
    "homeGrantRevision", "publicationRevision", "folderReservationId", "folderReservationRevision",
    "clientFolderBindingId", "externalProjectId", "projectLabel", "projectVersion", "opsFolderProjectId",
    "folderLabel", "opsDivisionId"]);
  if (!row || typeof row.candidateFingerprint !== "string" || !HASH.test(row.candidateFingerprint)
    || typeof row.recipientBindingId !== "string" || !UUID.test(row.recipientBindingId)
    || typeof row.enrollmentIntentId !== "string" || !UUID.test(row.enrollmentIntentId)
    || typeof row.targetId !== "string" || !UUID.test(row.targetId)
    || !integer(row.targetRevision) || !bounded(row.targetClientRecordId, 191)
    || !bounded(row.clientLabel, 160) || !bounded(row.recipientLabel, 160) || !bounded(row.workspaceId, 200)
    || !integer(row.homeOwnershipEpoch) || !integer(row.homeGrantRevision) || !integer(row.publicationRevision)
    || typeof row.folderReservationId !== "string" || !UUID.test(row.folderReservationId)
    || !integer(row.folderReservationRevision) || !bounded(row.clientFolderBindingId, 200)
    || !bounded(row.externalProjectId, 191) || !bounded(row.projectLabel, 160) || !integer(row.projectVersion)
    || !bounded(row.opsFolderProjectId, 191) || !bounded(row.folderLabel, 160) || !bounded(row.opsDivisionId, 191))
    return null;
  return Object.freeze(row as OperationsNativeDeliveryCandidate);
}

export function parseOperationsNativeDeliveryAuthority(value: unknown): OperationsNativeDeliveryAuthority | null {
  const row = exactRecord(value, ["authorityId", "revision", "state", "recipientBindingId", "folderReservationId",
    "enrollmentIntentId", "targetId", "targetClientRecordId", "workspaceId", "clientFolderBindingId",
    "externalProjectId", "opsFolderProjectId", "opsDivisionId", "clientLabel", "recipientLabel", "projectLabel",
    "folderLabel", "features", "expiresAt", "latestOperationId", "latestAction", "transportStatus",
    "recoveryOperationId"]);
  const features = row && parseFeatures(row.features, row.state === "revoked");
  if (!row || typeof row.authorityId !== "string" || !UUID.test(row.authorityId) || !integer(row.revision)
    || row.state !== "active" && row.state !== "revoked"
    || typeof row.recipientBindingId !== "string" || !UUID.test(row.recipientBindingId)
    || typeof row.enrollmentIntentId !== "string" || !UUID.test(row.enrollmentIntentId)
    || typeof row.folderReservationId !== "string" || !UUID.test(row.folderReservationId)
    || typeof row.targetId !== "string" || !UUID.test(row.targetId) || !bounded(row.targetClientRecordId, 191)
    || !bounded(row.workspaceId, 200) || !bounded(row.clientFolderBindingId, 200)
    || !bounded(row.externalProjectId, 191) || !bounded(row.opsFolderProjectId, 191)
    || !bounded(row.opsDivisionId, 191) || !bounded(row.clientLabel, 160) || !bounded(row.recipientLabel, 160)
    || !bounded(row.projectLabel, 160) || !bounded(row.folderLabel, 160) || !features
    || row.state === "active" && !canonicalInstant(row.expiresAt)
    || row.state === "revoked" && row.expiresAt !== null
    || typeof row.latestOperationId !== "string" || !UUID.test(row.latestOperationId)
    || row.latestAction !== "delivery.grant" && row.latestAction !== "delivery.revoke"
    || row.state === "active" && row.latestAction !== "delivery.grant"
    || row.state === "revoked" && row.latestAction !== "delivery.revoke"
    || row.transportStatus !== "pending" && row.transportStatus !== "acknowledged" && row.transportStatus !== "dead"
    || row.recoveryOperationId !== null
      && (typeof row.recoveryOperationId !== "string" || !UUID.test(row.recoveryOperationId))
    || row.transportStatus === "pending" && row.recoveryOperationId !== row.latestOperationId
    || row.transportStatus !== "pending" && row.recoveryOperationId !== null) return null;
  return Object.freeze({ ...row, features }) as OperationsNativeDeliveryAuthority;
}

type ExpectedMutation = Readonly<{ operationId: string; authorityId: string;
  action: "delivery.grant" | "delivery.revoke"; state: "active" | "revoked"; revision: number;
  recipientBindingId: string; folderReservationId: string }>;
function parseMutationResult(value: unknown, expected: ExpectedMutation): OperationsNativeDeliveryMutationResult | null {
  const rejected = exactRecord(value, ["operationId", "status"]);
  if (rejected?.operationId === expected.operationId && rejected.status === "rejected")
    return Object.freeze({ operationId: expected.operationId, status: "rejected" });
  const row = exactRecord(value, ["operationId", "status", "authority", "replayed", "recoveryOperationId"]);
  const authority = row && parseOperationsNativeDeliveryAuthority(row.authority);
  if (!row || row.operationId !== expected.operationId || !authority
    || authority.authorityId !== expected.authorityId || authority.latestOperationId !== expected.operationId
    || authority.latestAction !== expected.action || authority.state !== expected.state
    || authority.revision !== expected.revision || authority.recipientBindingId !== expected.recipientBindingId
    || authority.folderReservationId !== expected.folderReservationId
    || row.status !== "acknowledged" && row.status !== "pending"
    || typeof row.replayed !== "boolean"
    || row.status === "pending" && authority.transportStatus !== "pending"
    || row.status === "acknowledged" && authority.transportStatus !== "acknowledged"
    || row.status === "pending" && row.recoveryOperationId !== expected.operationId
    || row.status === "acknowledged" && row.recoveryOperationId !== null
    || row.recoveryOperationId !== authority.recoveryOperationId) return null;
  return Object.freeze({ operationId: expected.operationId,
    status: row.status as OperationsNativeDeliveryMutationSuccess["status"], authority, replayed: row.replayed,
    recoveryOperationId: row.recoveryOperationId as string | null });
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:;|$)/iu.test(contentType)) {
    await response.body?.cancel();
    throw new OperationsNativeDeliveryOwnerApiError(503, true);
  }
  const declared = response.headers.get("Content-Length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) {
    await response.body?.cancel();
    throw new OperationsNativeDeliveryOwnerApiError(503, true);
  }
  if (!response.body) throw new OperationsNativeDeliveryOwnerApiError(503, true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new OperationsNativeDeliveryOwnerApiError(503, true);
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof OperationsNativeDeliveryOwnerApiError) throw error;
    throw new OperationsNativeDeliveryOwnerApiError(503, true);
  } finally {
    reader.releaseLock();
  }
}

async function request(path: string, init: RequestInit = {}) {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, { ...init, credentials: "same-origin", cache: "no-store", redirect: "error" });
  } catch {
    throw new OperationsNativeDeliveryOwnerApiError(503, true);
  }
  if (!response.ok && response.status !== 409) {
    await response.body?.cancel();
    return { response, value: undefined };
  }
  const value = await readBoundedJson(response);
  return { response, value };
}
function denied(status: number, uncertain = status >= 500 || status === 429): never {
  throw new OperationsNativeDeliveryOwnerApiError(status, uncertain);
}
function mutationHeaders(csrfToken: string) {
  if (!CSRF.test(csrfToken)) denied(400, false);
  return { "Content-Type": "application/json", "X-CSRF-Token": csrfToken };
}

export async function openOperationsNativeDeliveryOwnerSession(): Promise<OperationsNativeDeliveryOwnerSession> {
  const { response, value } = await request("/session", { headers: STAFF_HEADERS });
  if (!response.ok) denied(response.status);
  const row = exactRecord(value, ["csrfToken", "verifiedUntil"]);
  if (!row || typeof row.csrfToken !== "string" || !CSRF.test(row.csrfToken)
    || !canonicalInstant(row.verifiedUntil) || Date.parse(row.verifiedUntil) <= Date.now()) denied(503, true);
  return Object.freeze({ csrfToken: row.csrfToken, verifiedUntil: row.verifiedUntil });
}

export async function listOperationsNativeDeliveryCandidates(targetId: string, cursor?: string | null): Promise<OperationsNativeDeliveryCandidatePage> {
  if (!UUID.test(targetId) || cursor !== undefined && cursor !== null
    && (cursor.length > 1024 || !CURSOR.test(cursor))) denied(400, false);
  const query = new URLSearchParams({ targetId });
  if (cursor) query.set("cursor", cursor);
  const { response, value } = await request(`/candidates?${query.toString()}`, { headers: STAFF_HEADERS });
  if (!response.ok) denied(response.status);
  const row = exactRecord(value, ["items", "page"]), page = row && exactRecord(row.page, ["nextCursor"]);
  if (!row || !Array.isArray(row.items) || row.items.length > 25 || !page
    || page.nextCursor !== null && (typeof page.nextCursor !== "string"
      || page.nextCursor.length > 1024 || !CURSOR.test(page.nextCursor))) denied(503, true);
  const items = row.items.map(parseOperationsNativeDeliveryCandidate);
  if (items.some(item => item === null) || items.some(item => item!.targetId !== targetId)) denied(503, true);
  const keys = new Set<string>(), fingerprints = new Set<string>();
  for (const item of items as OperationsNativeDeliveryCandidate[]) {
    const key = `${item.recipientBindingId}\u0000${item.folderReservationId}`;
    if (keys.has(key) || fingerprints.has(item.candidateFingerprint)) denied(503, true);
    keys.add(key); fingerprints.add(item.candidateFingerprint);
  }
  if (cursor && page.nextCursor === cursor) denied(503, true);
  return Object.freeze({ items: Object.freeze(items as OperationsNativeDeliveryCandidate[]),
    page: Object.freeze({ nextCursor: page.nextCursor as string | null }) });
}

export async function listOperationsNativeDeliveryAuthorities(targetId: string,
  cursor?: string | null): Promise<OperationsNativeDeliveryAuthorityPage> {
  if (!UUID.test(targetId) || cursor !== undefined && cursor !== null
    && (cursor.length > 1024 || !CURSOR.test(cursor))) denied(400, false);
  const query = new URLSearchParams({ targetId });
  if (cursor) query.set("cursor", cursor);
  const { response, value } = await request(`/authorities?${query.toString()}`, { headers: STAFF_HEADERS });
  if (!response.ok) denied(response.status);
  const row = exactRecord(value, ["items", "page"]), page = row && exactRecord(row.page, ["nextCursor"]);
  if (!row || !Array.isArray(row.items) || row.items.length > 25 || !page
    || page.nextCursor !== null && (typeof page.nextCursor !== "string"
      || page.nextCursor.length > 1024 || !CURSOR.test(page.nextCursor))) denied(503, true);
  const items = row.items.map(parseOperationsNativeDeliveryAuthority);
  if (items.some(item => item === null) || items.some(item => item!.targetId !== targetId)) denied(503, true);
  const ids = new Set<string>();
  for (const item of items as OperationsNativeDeliveryAuthority[]) {
    if (ids.has(item.authorityId)) denied(503, true);
    ids.add(item.authorityId);
  }
  if (cursor && page.nextCursor === cursor) denied(503, true);
  return Object.freeze({ items: Object.freeze(items as OperationsNativeDeliveryAuthority[]),
    page: Object.freeze({ nextCursor: page.nextCursor as string | null }) });
}

export async function readOperationsNativeDeliveryAuthority(authorityId: string): Promise<OperationsNativeDeliveryAuthority> {
  if (!UUID.test(authorityId)) denied(400, false);
  const { response, value } = await request(`/authorities/${encodeURIComponent(authorityId)}`, { headers: STAFF_HEADERS });
  if (!response.ok) denied(response.status);
  const row = exactRecord(value, ["authority"]), authority = row && parseOperationsNativeDeliveryAuthority(row.authority);
  if (!authority || authority.authorityId !== authorityId) denied(503, true);
  return authority;
}

async function mutation(path: string, csrfToken: string, input: object, expected: ExpectedMutation) {
  const { response, value } = await request(path, { method: "POST", headers: mutationHeaders(csrfToken),
    body: JSON.stringify(input) });
  if (response.status === 409) {
    const stale = exactRecord(value, ["error"]);
    if (stale?.error === "candidate_review_stale") denied(409, false);
  }
  const result = parseMutationResult(value, expected);
  if (!result || ![200, 201, 202, 409].includes(response.status)
    || response.status === 202 && result.status !== "pending"
    || response.status === 409 && result.status !== "rejected"
    || (response.status === 200 || response.status === 201) && result.status !== "acknowledged")
    denied(response.ok ? 503 : response.status, response.ok);
  return result;
}

export async function grantOperationsNativeDeliveryAuthority(csrfToken: string,
  input: OperationsNativeDeliveryGrantInput): Promise<OperationsNativeDeliveryMutationResult> {
  if (!UUID.test(input.operationId) || !UUID.test(input.authorityId) || !UUID.test(input.recipientBindingId)
    || !UUID.test(input.folderReservationId) || input.expectedRevision !== 0
    || !HASH.test(input.expectedCandidateFingerprint) || !parseFeatures(input.features, false)
    || !canonicalInstant(input.expiresAt) || Date.parse(input.expiresAt) <= Date.now()
    || Date.parse(input.expiresAt) > Date.now() + 30 * 86_400_000 || !bounded(input.reasonCode, 200)) denied(400, false);
  const body: OperationsNativeDeliveryGrantInput = Object.freeze({ operationId: input.operationId,
    authorityId: input.authorityId, recipientBindingId: input.recipientBindingId,
    folderReservationId: input.folderReservationId, expectedRevision: 0,
    expectedCandidateFingerprint: input.expectedCandidateFingerprint,
    features: Object.freeze([...input.features]), expiresAt: input.expiresAt, reasonCode: input.reasonCode });
  return mutation("/authorities", csrfToken, body, { operationId: input.operationId,
    authorityId: input.authorityId, action: "delivery.grant", state: "active", revision: 1,
    recipientBindingId: input.recipientBindingId, folderReservationId: input.folderReservationId });
}

export async function revokeOperationsNativeDeliveryAuthority(csrfToken: string,
  authority: OperationsNativeDeliveryAuthority, input: OperationsNativeDeliveryRevokeInput) {
  if (!UUID.test(input.operationId) || !integer(input.expectedRevision) || input.expectedRevision !== authority.revision
    || authority.state !== "active" || !bounded(input.reasonCode, 200)) denied(400, false);
  const body: OperationsNativeDeliveryRevokeInput = Object.freeze({ operationId: input.operationId,
    expectedRevision: input.expectedRevision, reasonCode: input.reasonCode });
  return mutation(`/authorities/${encodeURIComponent(authority.authorityId)}/revoke`, csrfToken,
    body, { operationId: input.operationId, authorityId: authority.authorityId, action: "delivery.revoke",
      state: "revoked", revision: input.expectedRevision + 1, recipientBindingId: authority.recipientBindingId,
      folderReservationId: authority.folderReservationId });
}

export async function recoverOperationsNativeDeliveryAuthority(csrfToken: string,
  authority: OperationsNativeDeliveryAuthority, input: OperationsNativeDeliveryRecoverInput) {
  if (!UUID.test(input.invocationId) || !UUID.test(input.operationId) || input.operationId !== authority.recoveryOperationId
    || !integer(input.expectedRevision) || input.expectedRevision !== authority.revision
    || authority.transportStatus !== "pending" || !bounded(input.reason, 500)) denied(400, false);
  const body: OperationsNativeDeliveryRecoverInput = Object.freeze({ invocationId: input.invocationId,
    operationId: input.operationId, expectedRevision: input.expectedRevision, reason: input.reason });
  return mutation(`/authorities/${encodeURIComponent(authority.authorityId)}/recover`, csrfToken,
    body, { operationId: input.operationId, authorityId: authority.authorityId, action: authority.latestAction,
      state: authority.state, revision: input.expectedRevision, recipientBindingId: authority.recipientBindingId,
      folderReservationId: authority.folderReservationId });
}

export function newOperationsNativeDeliveryOperationId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
