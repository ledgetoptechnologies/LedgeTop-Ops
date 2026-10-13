/** Closed private wire for one explicitly selected native recipient folder.
 * Parsing proves shape only. Both Workers must revalidate their current local
 * state before accepting a command or serving bytes. */
export const OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL =
  "operations-portal-native-delivery-authority" as const;
export const OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_VERSION = 1 as const;
export const OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES = 65_536;
export const OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES = Object.freeze([
  "folder.list", "file.metadata", "file.preview", "file.download",
] as const);

export type OperationsPortalNativeDeliveryFeature =
  (typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES)[number];
export type OperationsPortalNativeDeliveryAuthorityAction = "delivery.grant" | "delivery.revoke";
export type OperationsPortalNativeDeliveryAuthorityCommand = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL;
  protocolVersion: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_VERSION;
  permissionSchemaVersion: 3;
  action: OperationsPortalNativeDeliveryAuthorityAction;
  operationId: string;
  authority: Readonly<{ authorityId: string; expectedRevision: string; resultingRevision: string }>;
  target: Readonly<{ targetId: string; targetRevision: string; clientAuthorityId: string; workspaceId: string;
    rootKind: "organization" | "standalone_client"; rootRecordId: string }>;
  recipient: Readonly<{ recipientBindingId: string; enrollmentIntentId: string; targetClientRecordId: string;
    issuer: string; subject: string; homeOwnershipEpoch: string; homeGrantRevision: string;
    homeGrantOperationId: string; homeRequestFingerprint: string }>;
  publication: Readonly<{ operationId: string; publicationId: string; revision: string; sourceSequence: string;
    snapshotId: string; snapshotSha256: string }>;
  resource: Readonly<{ folderReservationId: string; folderReservationRevision: string; clientFolderBindingId: string;
    externalProjectId: string; projectVersion: string; opsFolderProjectId: string; opsDivisionId: string;
    selectedR2Prefix: string; baseR2Prefix: string; baseMatchMethod: string; baseConfirmedBy: string;
    baseConfirmedAt: string }>;
  features: readonly OperationsPortalNativeDeliveryFeature[];
  expiresAt: string | null;
  reasonCode: string;
  observedAt: string;
}>;

export type OperationsPortalNativeDeliveryAuthorityStatusRequest = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL;
  protocolVersion: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_VERSION;
  operationId: string;
  requestFingerprint: string;
}>;
export type OperationsPortalNativeDeliveryAuthorityReceipt = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL;
  protocolVersion: typeof OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_VERSION;
  status: "recorded" | "duplicate";
  operationId: string;
  requestFingerprint: string;
  action: OperationsPortalNativeDeliveryAuthorityAction;
  authorityId: string;
  recipientBindingId: string;
  folderReservationId: string;
  resultingRevision: string;
  resultingState: "active" | "revoked";
}>;
export type OperationsPortalNativeDeliveryAuthorityRpcResult =
  | Readonly<{ ok: true; protocolVersion: 1; receipt: OperationsPortalNativeDeliveryAuthorityReceipt }>
  | Readonly<{ ok: false; protocolVersion: 1; code: string; retryable: boolean }>;
export interface OperationsPortalNativeDeliveryAuthorityBinding {
  applyNativeDeliveryAuthority(canonicalCommandJson: string): Promise<unknown>;
  getNativeDeliveryAuthorityStatus(canonicalStatusRequestJson: string): Promise<unknown>;
}
export type OperationsPortalNativeDeliveryAuthorizationReadRequest = Readonly<{
  authorityId: string; authorityRevision: number; recipientBindingId: string; enrollmentIntentId: string;
  issuer: string; subject: string;
  targetId: string; targetRevision: number; targetClientRecordId: string; clientAuthorityId: string; workspaceId: string;
  homeOwnershipEpoch: number; homeGrantRevision: number; homeGrantOperationId: string; homeRequestFingerprint: string;
  publicationOperationId: string; publicationId: string; publicationRevision: number; publicationSourceSequence: number;
  publicationSnapshotId: string; publicationSnapshotSha256: string;
  folderReservationId: string; folderReservationRevision: number; clientFolderBindingId: string;
  externalProjectId: string; projectVersion: number; opsFolderProjectId: string; opsDivisionId: string;
  feature: OperationsPortalNativeDeliveryFeature;
}>;
export type OperationsPortalNativeDeliveryAuthorizationProof = Readonly<{
  authorityId: string; authorityRevision: number; recipientBindingId: string; enrollmentIntentId: string;
  issuer: string; subject: string; targetId: string; targetRevision: number; targetClientRecordId: string;
  clientAuthorityId: string; workspaceId: string;
  clientFolderBindingId: string; folderReservationId: string; folderReservationRevision: number;
  externalProjectId: string; projectVersion: number; publicationOperationId: string; publicationId: string;
  publicationRevision: number; publicationSourceSequence: number; publicationSnapshotId: string;
  publicationSnapshotSha256: string;
  homeOwnershipEpoch: number; homeGrantRevision: number; homeGrantOperationId: string; homeRequestFingerprint: string;
  opsFolderProjectId: string; opsDivisionId: string; selectedR2Prefix: string;
  expiresAt: string; features: readonly OperationsPortalNativeDeliveryFeature[];
}>;
export type OperationsPortalNativeDeliveryAuthorizationReaderResult =
  | Readonly<{ ok: true; protocolVersion: 1; authorization: OperationsPortalNativeDeliveryAuthorizationProof }>
  | Readonly<{ ok: false; protocolVersion: 1; code: "disabled" | "denied" }>;
export interface OperationsPortalNativeDeliveryAuthorizationReaderBinding {
  readNativeDeliveryAuthorization(input: OperationsPortalNativeDeliveryAuthorizationReadRequest): Promise<string>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const INTEGER = /^(?:0|[1-9][0-9]{0,15})$/u;
const MAX_INTEGER = "9007199254740991";
const encoder = new TextEncoder();
type UnknownRecord = Record<string, unknown>;

function exact(value: unknown, keys: readonly string[]): UnknownRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const output: UnknownRecord = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    output[key] = descriptor.value;
  }
  return output;
}
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value); }
function integer(value: unknown, positive = true): value is string {
  return typeof value === "string" && INTEGER.test(value) && (!positive || value !== "0")
    && (value.length < MAX_INTEGER.length || value.length === MAX_INTEGER.length && value <= MAX_INTEGER);
}
function text(value: unknown, maximum = 512): value is string {
  if (typeof value !== "string" || !value || value !== value.trim() || Array.from(value).length > maximum || /\p{C}/u.test(value)) return false;
  const bytes = encoder.encode(value);
  try { return bytes.byteLength <= maximum * 4 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === value; }
  catch { return false; }
}
function instant(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function issuer(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value && !url.port
      && !url.username && !url.password && url.hostname.endsWith(".cloudflareaccess.com")
      && url.hostname !== ".cloudflareaccess.com"; } catch { return false; }
}
function prefix(value: unknown): value is string {
  return text(value, 1024) && !value.startsWith("/") && value.endsWith("/")
    && !value.includes("\\") && !value.includes("//")
    && value.slice(0, -1).split("/").every(part => part && part !== "." && part !== "..");
}
function features(value: unknown, grant: boolean): readonly OperationsPortalNativeDeliveryFeature[] | null {
  if (!Array.isArray(value) || Reflect.ownKeys(value).length !== value.length + 1 || grant === (value.length === 0)) return null;
  let previous = -1;
  const output: OperationsPortalNativeDeliveryFeature[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const feature = descriptor?.enumerable && "value" in descriptor ? descriptor.value : null;
    const order = OPERATIONS_PORTAL_NATIVE_DELIVERY_FEATURES.indexOf(feature as OperationsPortalNativeDeliveryFeature);
    if (order <= previous) return null;
    previous = order; output.push(feature as OperationsPortalNativeDeliveryFeature);
  }
  return Object.freeze(output);
}

function parseCommand(value: unknown): OperationsPortalNativeDeliveryAuthorityCommand | null {
  const command = exact(value, ["protocol", "protocolVersion", "permissionSchemaVersion", "action", "operationId",
    "authority", "target", "recipient", "publication", "resource", "features", "expiresAt", "reasonCode", "observedAt"]);
  if (!command || command.protocol !== OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL
    || command.protocolVersion !== 1 || command.permissionSchemaVersion !== 3
    || command.action !== "delivery.grant" && command.action !== "delivery.revoke"
    || !uuid(command.operationId) || !instant(command.observedAt) || !text(command.reasonCode, 200)) return null;
  const grant = command.action === "delivery.grant";
  const authority = exact(command.authority, ["authorityId", "expectedRevision", "resultingRevision"]);
  const target = exact(command.target, ["targetId", "targetRevision", "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId"]);
  const recipient = exact(command.recipient, ["recipientBindingId", "enrollmentIntentId", "targetClientRecordId",
    "issuer", "subject", "homeOwnershipEpoch", "homeGrantRevision", "homeGrantOperationId", "homeRequestFingerprint"]);
  const publication = exact(command.publication, ["operationId", "publicationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256"]);
  const resource = exact(command.resource, ["folderReservationId", "folderReservationRevision", "clientFolderBindingId",
    "externalProjectId", "projectVersion", "opsFolderProjectId", "opsDivisionId", "selectedR2Prefix", "baseR2Prefix",
    "baseMatchMethod", "baseConfirmedBy", "baseConfirmedAt"]);
  const selectedFeatures = features(command.features, grant);
  if (!authority || !uuid(authority.authorityId) || !integer(authority.expectedRevision, false)
    || !integer(authority.resultingRevision) || BigInt(authority.resultingRevision) !== BigInt(authority.expectedRevision) + 1n
    || !target || !uuid(target.targetId) || !integer(target.targetRevision) || !uuid(target.clientAuthorityId)
    || !text(target.workspaceId, 200) || !text(target.rootRecordId, 191)
    || target.rootKind !== "organization" && target.rootKind !== "standalone_client"
    || !recipient || !uuid(recipient.recipientBindingId) || !uuid(recipient.enrollmentIntentId)
    || !text(recipient.targetClientRecordId, 191)
    || !issuer(recipient.issuer) || !text(recipient.subject, 512) || !integer(recipient.homeOwnershipEpoch)
    || !integer(recipient.homeGrantRevision) || !uuid(recipient.homeGrantOperationId) || !hash(recipient.homeRequestFingerprint)
    || !publication || !uuid(publication.operationId) || !uuid(publication.publicationId)
    || !integer(publication.revision) || !integer(publication.sourceSequence) || !uuid(publication.snapshotId)
    || !hash(publication.snapshotSha256) || !resource || !uuid(resource.folderReservationId)
    || !integer(resource.folderReservationRevision) || !text(resource.clientFolderBindingId, 200)
    || !text(resource.externalProjectId, 191) || !integer(resource.projectVersion)
    || !text(resource.opsFolderProjectId, 191) || !text(resource.opsDivisionId, 191)
    || !prefix(resource.selectedR2Prefix) || !prefix(resource.baseR2Prefix)
    || !resource.selectedR2Prefix.startsWith(resource.baseR2Prefix)
    || !text(resource.baseMatchMethod, 80) || !text(resource.baseConfirmedBy, 191)
    || !text(resource.baseConfirmedAt, 64) || !selectedFeatures
    || (grant ? !instant(command.expiresAt) || command.expiresAt <= command.observedAt
      || Date.parse(command.expiresAt) > Date.parse(command.observedAt) + 30 * 86_400_000 : command.expiresAt !== null)) return null;
  return Object.freeze({
    protocol: OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1, permissionSchemaVersion: 3,
    action: command.action, operationId: command.operationId,
    authority: Object.freeze({ authorityId: authority.authorityId, expectedRevision: authority.expectedRevision,
      resultingRevision: authority.resultingRevision }),
    target: Object.freeze({ targetId: target.targetId, targetRevision: target.targetRevision,
      clientAuthorityId: target.clientAuthorityId, workspaceId: target.workspaceId,
      rootKind: target.rootKind, rootRecordId: target.rootRecordId }),
    recipient: Object.freeze({ recipientBindingId: recipient.recipientBindingId, enrollmentIntentId: recipient.enrollmentIntentId,
      targetClientRecordId: recipient.targetClientRecordId, issuer: recipient.issuer, subject: recipient.subject,
      homeOwnershipEpoch: recipient.homeOwnershipEpoch, homeGrantRevision: recipient.homeGrantRevision,
      homeGrantOperationId: recipient.homeGrantOperationId, homeRequestFingerprint: recipient.homeRequestFingerprint }),
    publication: Object.freeze({ operationId: publication.operationId, publicationId: publication.publicationId,
      revision: publication.revision, sourceSequence: publication.sourceSequence, snapshotId: publication.snapshotId,
      snapshotSha256: publication.snapshotSha256 }),
    resource: Object.freeze({ folderReservationId: resource.folderReservationId,
      folderReservationRevision: resource.folderReservationRevision, clientFolderBindingId: resource.clientFolderBindingId,
      externalProjectId: resource.externalProjectId, projectVersion: resource.projectVersion,
      opsFolderProjectId: resource.opsFolderProjectId, opsDivisionId: resource.opsDivisionId,
      selectedR2Prefix: resource.selectedR2Prefix, baseR2Prefix: resource.baseR2Prefix,
      baseMatchMethod: resource.baseMatchMethod, baseConfirmedBy: resource.baseConfirmedBy,
      baseConfirmedAt: resource.baseConfirmedAt }), features: selectedFeatures,
    expiresAt: command.expiresAt as string | null, reasonCode: command.reasonCode, observedAt: command.observedAt,
  });
}

export function parseOperationsPortalNativeDeliveryAuthorityCommand(value: unknown) {
  try { const command = parseCommand(value); return command
      && encoder.encode(JSON.stringify(command)).byteLength <= OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES ? command : null; }
  catch { return null; }
}
export function canonicalOperationsPortalNativeDeliveryAuthorityCommand(value: unknown): string {
  const command = parseOperationsPortalNativeDeliveryAuthorityCommand(value);
  if (!command) throw new Error("operations_portal_native_delivery_authority_invalid");
  return JSON.stringify(command);
}
export async function sha256OperationsPortalNativeDeliveryAuthorityCommand(value: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalOperationsPortalNativeDeliveryAuthorityCommand(value));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function parseOperationsPortalNativeDeliveryAuthorityStatusRequest(value: unknown): OperationsPortalNativeDeliveryAuthorityStatusRequest | null {
  try {
    const request = exact(value, ["protocol", "protocolVersion", "operationId", "requestFingerprint"]);
    return request && request.protocol === OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL && request.protocolVersion === 1
      && uuid(request.operationId) && hash(request.requestFingerprint) ? Object.freeze({
        protocol: OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1,
        operationId: request.operationId, requestFingerprint: request.requestFingerprint,
      }) : null;
  } catch { return null; }
}
export function canonicalOperationsPortalNativeDeliveryAuthorityStatusRequest(value: unknown): string {
  const request = parseOperationsPortalNativeDeliveryAuthorityStatusRequest(value);
  if (!request) throw new Error("operations_portal_native_delivery_authority_status_invalid");
  return JSON.stringify(request);
}
export function parseOperationsPortalNativeDeliveryAuthorityReceipt(value: unknown,
  command?: OperationsPortalNativeDeliveryAuthorityCommand, requestFingerprint?: string,
): OperationsPortalNativeDeliveryAuthorityReceipt | null {
  try {
    const receipt = exact(value, ["protocol", "protocolVersion", "status", "operationId", "requestFingerprint", "action",
      "authorityId", "recipientBindingId", "folderReservationId", "resultingRevision", "resultingState"]);
    if (!receipt || receipt.protocol !== OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL || receipt.protocolVersion !== 1
      || receipt.status !== "recorded" && receipt.status !== "duplicate" || !uuid(receipt.operationId)
      || !hash(receipt.requestFingerprint) || receipt.action !== "delivery.grant" && receipt.action !== "delivery.revoke"
      || !uuid(receipt.authorityId) || !uuid(receipt.recipientBindingId) || !uuid(receipt.folderReservationId)
      || !integer(receipt.resultingRevision) || receipt.resultingState !== "active" && receipt.resultingState !== "revoked") return null;
    const parsed = Object.freeze({ protocol: OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1 as const,
      status: receipt.status, operationId: receipt.operationId, requestFingerprint: receipt.requestFingerprint,
      action: receipt.action, authorityId: receipt.authorityId, recipientBindingId: receipt.recipientBindingId,
      folderReservationId: receipt.folderReservationId, resultingRevision: receipt.resultingRevision,
      resultingState: receipt.resultingState });
    if (requestFingerprint && parsed.requestFingerprint !== requestFingerprint) return null;
    if (command && (parsed.operationId !== command.operationId || parsed.action !== command.action
      || parsed.authorityId !== command.authority.authorityId
      || parsed.recipientBindingId !== command.recipient.recipientBindingId
      || parsed.folderReservationId !== command.resource.folderReservationId
      || parsed.resultingRevision !== command.authority.resultingRevision
      || parsed.resultingState !== (command.action === "delivery.grant" ? "active" : "revoked"))) return null;
    return parsed;
  } catch { return null; }
}
