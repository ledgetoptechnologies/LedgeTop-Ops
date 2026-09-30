/**
 * Closed, inert contract for a future Operations-owned API-v2 portal
 * publication proof. Parsing validates shape and canonical identity only; it
 * never establishes source authority, currentness, publication, or file
 * access. A reviewed producer must revalidate the live source, workspace,
 * directory, project, and folder rows and commit them with an atomic CAS.
 *
 * This contract is deliberately separate from the v1 verified-recipient
 * authority command. No route, service binding, grant, entitlement, upload,
 * processing, or administrator permission consumes this module yet.
 */

export const API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL =
  "api-v2-portal-publication-proof" as const;
export const API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL_VERSION = 1 as const;

export type ApiV2PortalPublicationProofAction = "publish" | "suspend" | "revoke";
export type ApiV2PortalPublicationProofState = "active" | "suspended" | "revoked";
export type ApiV2PortalPublicationProofReceiptStatus = "recorded" | "replayed";

export type ApiV2PortalPublicationProof = Readonly<{
  protocol: typeof API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL;
  protocolVersion: typeof API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL_VERSION;
  proofId: string;
  operationId: string;
  action: ApiV2PortalPublicationProofAction;
  proofRevision: number;
  expectedRevision: number;
  resultingRevision: number;
  state: ApiV2PortalPublicationProofState;
  source: Readonly<{
    sourceId: string;
    sourceInstanceId: string;
    applicationId: string;
    historyEpoch: string;
    authorizationGeneration: number;
  }>;
  workspace: Readonly<{
    workspaceId: string;
    rootType: "organization" | "standalone_client";
    rootPublicId: string;
    sourceWorkspaceId: string;
  }>;
  directory: Readonly<{
    snapshotId: string;
    generationId: string;
    checkpointId: string;
    sourceGeneration: string;
    sourceSequence: string;
    pageCount: number;
    itemCount: number;
    complete: true;
    snapshotSha256: string;
  }>;
  project: Readonly<{
    publicId: string;
    revision: string;
    projectionSha256: string;
  }>;
  folder: Readonly<{
    bindingId: string;
    sourceVersion: string;
    r2Prefix: string;
  }>;
  observedAt: string;
  verifiedUntil: string;
}>;

export type ApiV2PortalPublicationProofReceipt = Readonly<{
  protocol: typeof API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL;
  protocolVersion: typeof API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL_VERSION;
  operationId: string;
  status: ApiV2PortalPublicationProofReceiptStatus;
  proofId: string;
  sourceId: string;
  expectedRevision: number;
  resultingRevision: number;
  state: ApiV2PortalPublicationProofState;
  proofSha256: string;
  proof: ApiV2PortalPublicationProof;
}>;

type UnknownRecord = Record<string, unknown>;

const PROOF_KEYS = [
  "protocol", "protocolVersion", "proofId", "operationId", "action", "proofRevision",
  "expectedRevision", "resultingRevision", "state", "source", "workspace", "directory",
  "project", "folder", "observedAt", "verifiedUntil",
] as const;
const SOURCE_KEYS = ["sourceId", "sourceInstanceId", "applicationId", "historyEpoch", "authorizationGeneration"] as const;
const WORKSPACE_KEYS = ["workspaceId", "rootType", "rootPublicId", "sourceWorkspaceId"] as const;
const DIRECTORY_KEYS = [
  "snapshotId", "generationId", "checkpointId", "sourceGeneration", "sourceSequence", "pageCount",
  "itemCount", "complete", "snapshotSha256",
] as const;
const PROJECT_KEYS = ["publicId", "revision", "projectionSha256"] as const;
const FOLDER_KEYS = ["bindingId", "sourceVersion", "r2Prefix"] as const;
const RECEIPT_KEYS = [
  "protocol", "protocolVersion", "operationId", "status", "proofId", "sourceId", "expectedRevision",
  "resultingRevision", "state", "proofSha256", "proof",
] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SOURCE_ID = /^[a-z][a-z0-9_-]{0,31}:[a-z0-9][a-z0-9_-]{0,63}$/u;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const PUBLIC_ID = /^[0-9a-f]{32}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,18}$/u;
const MAX_SAFE_REVISION = 2_147_483_647;
const RESERVED_PREFIX_SEGMENTS = new Set(["dump", "_ltds", ".previews"]);

function exactObject(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
    }
    return value as UnknownRecord;
  } catch {
    return null;
  }
}

function boundedId(value: unknown): string | null {
  return typeof value === "string" && value === value.trim() && OPAQUE_ID.test(value) && !value.includes("..") ? value : null;
}
function uuid(value: unknown): string | null { return typeof value === "string" && UUID_V4.test(value) ? value : null; }
function sha256(value: unknown): string | null { return typeof value === "string" && SHA256.test(value) ? value : null; }
function revision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= MAX_SAFE_REVISION ? value : null;
}
function nonNegativeRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SAFE_REVISION ? value : null;
}
function expectedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value < MAX_SAFE_REVISION ? value : null;
}
function decimal(value: unknown, positive = false): string | null {
  return typeof value === "string" && (positive ? POSITIVE_DECIMAL : DECIMAL).test(value) ? value : null;
}
function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}
function sourceId(value: unknown): string | null { return typeof value === "string" && SOURCE_ID.test(value) ? value : null; }
function publicId(value: unknown): string | null { return typeof value === "string" && PUBLIC_ID.test(value) ? value : null; }
function safePrefix(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 1000 || value !== value.trim()
    || /[\u0000-\u001f\u007f\\]/u.test(value) || value.startsWith("/") || !value.endsWith("/") || value.includes("//")) return null;
  const segments = value.slice(0, -1).split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || RESERVED_PREFIX_SEGMENTS.has(segment.toLowerCase()))) return null;
  return value;
}
function freeze<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }

function parseProofInternal(value: unknown): ApiV2PortalPublicationProof | null {
  const record = exactObject(value, PROOF_KEYS);
  if (!record || record.protocol !== API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL || record.protocolVersion !== 1) return null;
  const proofId = uuid(record.proofId), operationId = uuid(record.operationId);
  const action = record.action, state = record.state;
  const proofRevision = revision(record.proofRevision), expected = expectedRevision(record.expectedRevision);
  const resulting = revision(record.resultingRevision);
  if (!proofId || !operationId || (action !== "publish" && action !== "suspend" && action !== "revoke")
    || (state !== "active" && state !== "suspended" && state !== "revoked") || proofRevision === null || expected === null
    || resulting === null || resulting !== expected + 1 || proofRevision !== resulting
    || (action === "publish" && state !== "active") || (action === "suspend" && state !== "suspended")
    || (action === "revoke" && state !== "revoked")) return null;

  const sourceRecord = exactObject(record.source, SOURCE_KEYS);
  const sourceInstanceId = sourceRecord && uuid(sourceRecord.sourceInstanceId);
  const applicationId = sourceRecord && uuid(sourceRecord.applicationId);
  const historyEpoch = sourceRecord && uuid(sourceRecord.historyEpoch);
  const source = sourceRecord && sourceId(sourceRecord.sourceId);
  const authorizationGeneration = sourceRecord && nonNegativeRevision(sourceRecord.authorizationGeneration);
  if (!sourceRecord || !source || !sourceInstanceId || !applicationId || !historyEpoch || authorizationGeneration === null) return null;

  const workspaceRecord = exactObject(record.workspace, WORKSPACE_KEYS);
  const workspaceId = workspaceRecord && boundedId(workspaceRecord.workspaceId);
  const rootPublicId = workspaceRecord && boundedId(workspaceRecord.rootPublicId);
  const sourceWorkspaceId = workspaceRecord && boundedId(workspaceRecord.sourceWorkspaceId);
  const rootType = workspaceRecord?.rootType;
  if (!workspaceRecord || !workspaceId || !rootPublicId || !sourceWorkspaceId
    || (rootType !== "organization" && rootType !== "standalone_client")) return null;

  const directoryRecord = exactObject(record.directory, DIRECTORY_KEYS);
  const snapshotId = directoryRecord && uuid(directoryRecord.snapshotId);
  const generationId = directoryRecord && boundedId(directoryRecord.generationId);
  const checkpointId = directoryRecord && boundedId(directoryRecord.checkpointId);
  const sourceGeneration = directoryRecord && decimal(directoryRecord.sourceGeneration);
  const sourceSequence = directoryRecord && decimal(directoryRecord.sourceSequence);
  const pageCount = directoryRecord && typeof directoryRecord.pageCount === "number" && Number.isSafeInteger(directoryRecord.pageCount)
    && directoryRecord.pageCount >= 1 && directoryRecord.pageCount <= 32 ? directoryRecord.pageCount : null;
  const itemCount = directoryRecord && typeof directoryRecord.itemCount === "number" && Number.isSafeInteger(directoryRecord.itemCount)
    && directoryRecord.itemCount >= 0 && directoryRecord.itemCount <= 5_000 ? directoryRecord.itemCount : null;
  const snapshotSha256 = directoryRecord && sha256(directoryRecord.snapshotSha256);
  if (!directoryRecord || !snapshotId || !generationId || !checkpointId || !sourceGeneration || !sourceSequence
    || pageCount === null || itemCount === null || directoryRecord.complete !== true || !snapshotSha256) return null;

  const projectRecord = exactObject(record.project, PROJECT_KEYS);
  const projectPublicId = projectRecord && publicId(projectRecord.publicId);
  const projectRevision = projectRecord && decimal(projectRecord.revision, true);
  const projectionSha256 = projectRecord && sha256(projectRecord.projectionSha256);
  if (!projectRecord || !projectPublicId || !projectRevision || !projectionSha256) return null;

  const folderRecord = exactObject(record.folder, FOLDER_KEYS);
  const bindingId = folderRecord && boundedId(folderRecord.bindingId);
  const sourceVersion = folderRecord && boundedId(folderRecord.sourceVersion);
  const r2Prefix = folderRecord && safePrefix(folderRecord.r2Prefix);
  if (!folderRecord || !bindingId || !sourceVersion || !r2Prefix) return null;

  const observedAt = canonicalTime(record.observedAt), verifiedUntil = canonicalTime(record.verifiedUntil);
  if (!observedAt || !verifiedUntil || Date.parse(verifiedUntil) <= Date.parse(observedAt)) return null;
  return freeze({
    protocol: API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL,
    protocolVersion: 1 as const,
    proofId, operationId, action, proofRevision, expectedRevision: expected, resultingRevision: resulting, state,
    source: freeze({ sourceId: source, sourceInstanceId, applicationId, historyEpoch, authorizationGeneration }),
    workspace: freeze({ workspaceId, rootType, rootPublicId, sourceWorkspaceId }),
    directory: freeze({ snapshotId, generationId, checkpointId, sourceGeneration, sourceSequence, pageCount, itemCount, complete: true as const, snapshotSha256 }),
    project: freeze({ publicId: projectPublicId, revision: projectRevision, projectionSha256 }),
    folder: freeze({ bindingId, sourceVersion, r2Prefix }), observedAt, verifiedUntil,
  });
}

export function parseApiV2PortalPublicationProof(value: unknown): ApiV2PortalPublicationProof | null {
  return parseProofInternal(value);
}

export function canonicalApiV2PortalPublicationProof(value: unknown): string {
  const parsed = parseProofInternal(value);
  if (!parsed) throw new Error("api-v2-portal-publication-proof-invalid");
  return JSON.stringify(parsed);
}

export async function sha256ApiV2PortalPublicationProof(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalApiV2PortalPublicationProof(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function parseReceiptInternal(value: unknown, expectedProof?: ApiV2PortalPublicationProof): ApiV2PortalPublicationProofReceipt | null {
  const record = exactObject(value, RECEIPT_KEYS);
  if (!record || record.protocol !== API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL || record.protocolVersion !== 1
    || (record.status !== "recorded" && record.status !== "replayed")) return null;
  const proof = parseProofInternal(record.proof);
  const operationId = uuid(record.operationId), proofId = uuid(record.proofId), source = sourceId(record.sourceId);
  const expected = expectedRevision(record.expectedRevision), resulting = revision(record.resultingRevision);
  const proofSha256 = sha256(record.proofSha256);
  if (!proof || !operationId || !proofId || !source || expected === null || resulting === null || !proofSha256
    || proof.operationId !== operationId || proof.proofId !== proofId || proof.source.sourceId !== source
    || proof.expectedRevision !== expected || proof.resultingRevision !== resulting || proof.state !== record.state
    || (record.state !== "active" && record.state !== "suspended" && record.state !== "revoked")
    || (expectedProof && JSON.stringify(proof) !== JSON.stringify(expectedProof))) return null;
  return freeze({
    protocol: API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL,
    protocolVersion: 1 as const,
    operationId, status: record.status, proofId, sourceId: source, expectedRevision: expected,
    resultingRevision: resulting, state: record.state, proofSha256, proof,
  });
}

export function parseApiV2PortalPublicationProofReceipt(
  value: unknown, expectedProof?: ApiV2PortalPublicationProof,
): ApiV2PortalPublicationProofReceipt | null {
  return parseReceiptInternal(value, expectedProof);
}

/** Parses and verifies the canonical proof hash; parsing alone is not authority. */
export async function verifyApiV2PortalPublicationProofReceipt(
  value: unknown, expectedProof?: ApiV2PortalPublicationProof,
): Promise<ApiV2PortalPublicationProofReceipt | null> {
  const receipt = parseReceiptInternal(value, expectedProof);
  if (!receipt || await sha256ApiV2PortalPublicationProof(receipt.proof) !== receipt.proofSha256) return null;
  return receipt;
}

export async function createApiV2PortalPublicationProofReceipt(
  proofValue: unknown, status: ApiV2PortalPublicationProofReceiptStatus,
): Promise<ApiV2PortalPublicationProofReceipt> {
  const proof = parseProofInternal(proofValue);
  if (!proof) throw new Error("api-v2-portal-publication-proof-invalid");
  const receipt = {
    protocol: API_V2_PORTAL_PUBLICATION_PROOF_PROTOCOL,
    protocolVersion: 1 as const,
    operationId: proof.operationId, status, proofId: proof.proofId, sourceId: proof.source.sourceId,
    expectedRevision: proof.expectedRevision, resultingRevision: proof.resultingRevision, state: proof.state,
    proofSha256: await sha256ApiV2PortalPublicationProof(proof), proof,
  } satisfies ApiV2PortalPublicationProofReceipt;
  return freeze(receipt);
}
