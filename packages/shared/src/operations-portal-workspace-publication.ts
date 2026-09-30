/**
 * Closed, inert contract for a future Operations-owned portal workspace
 * publication. It describes a complete bounded topology snapshot and exact
 * references to independently delivered Operations authority heads.
 *
 * Parsing, canonicalization, and hashing do not publish data or authorize
 * workspace, directory, or file access. No route, binding, migration, reader,
 * grant, or entitlement consumes this module yet. A future producer and
 * consumer must independently prove completeness/currentness and commit with
 * an atomic CAS before any runtime reader may rely on a publication.
 */

export const OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL =
  "operations-portal-workspace-publication" as const;
export const OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL_VERSION = 1 as const;

export const OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS = Object.freeze({
  directoryRecords: 500,
  externalFencesPerDirectoryRecord: 8,
  projects: 1_000,
  folderReservations: 1_000,
  recipientAuthorityHeads: 1_000,
  deliveryAuthorityHeads: 2_000,
  canonicalBytes: 2 * 1024 * 1024,
});

export type OperationsPortalRootKind = "organization" | "standalone_client";
export type OperationsPortalHeadState = "active" | "revoked";

export type OperationsPortalExternalFreshnessFence = Readonly<{
  sourceId: string;
  sourceInstanceId: string;
  applicationId: string;
  historyEpoch: string;
  authorizationGeneration: string;
  publicId: string;
  revision: string;
  projectionSha256: string;
}>;

export type OperationsPortalDirectoryRecord = Readonly<{
  recordId: string;
  kind: "organization" | "client";
  version: string;
  parentRecordId: string | null;
  relationshipVersion: string | null;
  displayName: string;
  /** Zero or more exact shared-record mirrors. Multiple PA instances may
   * explicitly map to this one Operations-owned customer; none owns identity,
   * membership, hierarchy, or grants. */
  externalFences: readonly OperationsPortalExternalFreshnessFence[];
}>;

export type OperationsPortalProject = Readonly<{
  externalProjectId: string;
  version: string;
  name: string;
  lifecycle: "not_started" | "active" | "completed" | "cancelled";
  plannedStart: string | null;
  plannedEnd: string | null;
  completedAt: string | null;
  archived: boolean;
  archivedAt: string | null;
  overdueWarning: boolean;
  published: boolean;
  organizationRecordId: string | null;
  clientRecordId: string | null;
  externalFence: OperationsPortalExternalFreshnessFence | null;
}>;

export type OperationsPortalFolderReservation = Readonly<{
  reservationId: string;
  externalProjectId: string;
  /** Exact project_folders.project_id for the one authoritative Ops base.
   * A future producer must prove r2Prefix is contained by that row's base
   * prefix. Readers authorize this exact reservation and must not infer
   * authority through longest-prefix matching. */
  opsFolderProjectId: string;
  divisionId: string;
  clientFolderBindingId: string;
  bindingVersion: string;
  r2Prefix: string;
  state: OperationsPortalHeadState;
}>;

export type OperationsPortalRecipientAuthorityHeadReference = Readonly<{
  recipientBindingId: string;
  enrollmentIntentId: string;
  targetClientRecordId: string;
  clientAuthorityId: string;
  workspaceId: string;
  issuer: string;
  subject: string;
  enrollmentRevision: string;
  ownershipEpoch: string;
  grantRevision: string;
  state: OperationsPortalHeadState;
  lastOperationId: string;
  protocolVersion: 3;
  permissions: readonly [] | readonly ["operations.service_home.read"];
}>;

export type OperationsPortalDeliveryAuthorityHeadReference = Readonly<{
  authorityId: string;
  authorityRevision: string;
  state: OperationsPortalHeadState;
  lastOperationId: string;
  clientAuthorityId: string;
  workspaceId: string;
  recipientBindingId: string;
  enrollmentIntentId: string;
  homeOwnershipEpoch: string;
  homeGrantRevision: string;
  folderReservationId: string;
  folderBindingId: string;
  expiresAt: string | null;
}>;

export type OperationsPortalWorkspacePublication = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL;
  protocolVersion: typeof OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL_VERSION;
  action: "publish";
  publicationId: string;
  operationId: string;
  expectedRevision: string;
  resultingRevision: string;
  target: Readonly<{
    targetId: string;
    targetRevision: string;
    clientAuthorityId: string;
    workspaceId: string;
    rootKind: OperationsPortalRootKind;
    rootRecordId: string;
  }>;
  snapshot: Readonly<{
    snapshotId: string;
    checkpointId: string;
    sourceSequence: string;
    complete: true;
    counts: Readonly<{
      directoryRecords: number;
      projects: number;
      folderReservations: number;
      recipientAuthorityHeads: number;
      deliveryAuthorityHeads: number;
    }>;
    snapshotSha256: string;
    directoryRecords: readonly OperationsPortalDirectoryRecord[];
    projects: readonly OperationsPortalProject[];
    folderReservations: readonly OperationsPortalFolderReservation[];
    recipientAuthorityHeads: readonly OperationsPortalRecipientAuthorityHeadReference[];
    deliveryAuthorityHeads: readonly OperationsPortalDeliveryAuthorityHeadReference[];
  }>;
  actorProof: Readonly<{
    staffId: string;
    verifiedAccessSubject: string;
    admissionVersion: string;
    profileVersion: string;
    grantGeneration: string;
    verifiedUntil: string;
  }>;
  observedAt: string;
}>;

type UnknownRecord = Record<string, unknown>;

const PUBLICATION_KEYS = ["protocol", "protocolVersion", "action", "publicationId", "operationId",
  "expectedRevision", "resultingRevision", "target", "snapshot", "actorProof", "observedAt"] as const;
const TARGET_KEYS = ["targetId", "targetRevision", "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId"] as const;
const SNAPSHOT_KEYS = ["snapshotId", "checkpointId", "sourceSequence", "complete", "counts", "snapshotSha256",
  "directoryRecords", "projects", "folderReservations", "recipientAuthorityHeads", "deliveryAuthorityHeads"] as const;
const COUNT_KEYS = ["directoryRecords", "projects", "folderReservations", "recipientAuthorityHeads", "deliveryAuthorityHeads"] as const;
const DIRECTORY_KEYS = ["recordId", "kind", "version", "parentRecordId", "relationshipVersion", "displayName", "externalFences"] as const;
const PROJECT_KEYS = ["externalProjectId", "version", "name", "lifecycle", "plannedStart", "plannedEnd", "completedAt",
  "archived", "archivedAt", "overdueWarning", "published", "organizationRecordId", "clientRecordId", "externalFence"] as const;
const FENCE_KEYS = ["sourceId", "sourceInstanceId", "applicationId", "historyEpoch", "authorizationGeneration",
  "publicId", "revision", "projectionSha256"] as const;
const FOLDER_KEYS = ["reservationId", "externalProjectId", "opsFolderProjectId", "divisionId", "clientFolderBindingId",
  "bindingVersion", "r2Prefix", "state"] as const;
const RECIPIENT_KEYS = ["recipientBindingId", "enrollmentIntentId", "targetClientRecordId", "clientAuthorityId", "workspaceId",
  "issuer", "subject", "enrollmentRevision", "ownershipEpoch", "grantRevision", "state", "lastOperationId", "protocolVersion", "permissions"] as const;
const DELIVERY_KEYS = ["authorityId", "authorityRevision", "state", "lastOperationId", "clientAuthorityId", "workspaceId",
  "recipientBindingId", "enrollmentIntentId", "homeOwnershipEpoch", "homeGrantRevision", "folderReservationId", "folderBindingId", "expiresAt"] as const;
const ACTOR_KEYS = ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "grantGeneration", "verifiedUntil"] as const;

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const PA_SOURCE_ID = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/u;
const PUBLIC_ID = /^[0-9a-f]{32}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]{0,18})$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,18}$/u;
const MAX_SIGNED_INT64 = "9223372036854775807";
const RESERVED_PREFIX_SEGMENTS = new Set(["dump", "_ltds", ".previews"]);

function exactObject(value: unknown, keys: readonly string[]): UnknownRecord | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key))) return null;
    const copy: UnknownRecord = Object.create(null) as UnknownRecord;
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy[key] = descriptor.value;
    }
    return copy;
  } catch { return null; }
}

function exactArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const ownKeys = Reflect.ownKeys(value);
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null;
    if (!Number.isSafeInteger(length) || length < 0 || length > maximum
      || ownKeys.length !== length + 1 || !ownKeys.includes("length")) return null;
    const copy: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return null;
      copy.push(descriptor.value);
    }
    return copy;
  } catch { return null; }
}

function uuid(value: unknown): string | null {
  return typeof value === "string" && UUID_V4.test(value) ? value : null;
}
function permanentId(value: unknown, maximum = 191): string | null {
  // Canonical Operations IDs are opaque, not URL/path segments. Existing
  // Directory IDs include `ops/client/...`; do not normalize, split or apply
  // folder-path rules to them. Native persistence additionally enforces its
  // own 191-code-point/764-byte bounds; workspace/binding IDs allow 200 here.
  if (typeof value !== "string" || value.length === 0 || Array.from(value).length > maximum || /\p{C}/u.test(value)) return null;
  const bytes = new TextEncoder().encode(value);
  if (bytes.byteLength > maximum * 4 || new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== value) return null;
  return value;
}
function boundedText(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value !== value.trim()) return null;
  return /[\u0000-\u001f\u007f]/u.test(value) ? null : value;
}
function decimal(value: unknown, positive = false): string | null {
  if (typeof value !== "string" || !(positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) return null;
  return value.length < MAX_SIGNED_INT64.length || (value.length === MAX_SIGNED_INT64.length && value <= MAX_SIGNED_INT64)
    ? value : null;
}
function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value ? value : null;
}
function nullableTime(value: unknown): string | null | undefined {
  return value === null ? null : canonicalTime(value) ?? undefined;
}
function calendarDate(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value ? value : undefined;
}
function nullablePermanentId(value: unknown): string | null | undefined {
  return value === null ? null : permanentId(value) ?? undefined;
}
function safePrefix(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 1_000 || value !== value.trim()
    || /[\u0000-\u001f\u007f\\*?\[\]{}#%]/u.test(value) || value.startsWith("/") || !value.endsWith("/")
    || value.includes("//")) return null;
  const segments = value.slice(0, -1).split("/");
  if (segments.some(segment => !segment || segment === "." || segment === ".."
    || RESERVED_PREFIX_SEGMENTS.has(segment.toLowerCase()))) return null;
  return value;
}
function headState(value: unknown): OperationsPortalHeadState | null {
  return value === "active" || value === "revoked" ? value : null;
}
function freeze<T extends object>(value: T): Readonly<T> { return Object.freeze(value); }
function compare(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function unique(values: readonly string[]): boolean { return new Set(values).size === values.length; }
function exactCount(value: unknown, actual: number, maximum: number, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value === actual && value >= minimum && value <= maximum
    ? value : null;
}
function oneMore(expected: string, resulting: string): boolean {
  try { return BigInt(resulting) === BigInt(expected) + 1n; } catch { return false; }
}

function parseFence(value: unknown): OperationsPortalExternalFreshnessFence | null {
  const record = exactObject(value, FENCE_KEYS);
  if (!record || typeof record.sourceId !== "string" || !PA_SOURCE_ID.test(record.sourceId)) return null;
  const sourceInstanceId = uuid(record.sourceInstanceId), applicationId = uuid(record.applicationId);
  const historyEpoch = uuid(record.historyEpoch), authorizationGeneration = decimal(record.authorizationGeneration);
  const publicId = typeof record.publicId === "string" && PUBLIC_ID.test(record.publicId) ? record.publicId : null;
  const revision = decimal(record.revision, true);
  const projectionSha256 = typeof record.projectionSha256 === "string" && SHA256.test(record.projectionSha256)
    ? record.projectionSha256 : null;
  if (!sourceInstanceId || !applicationId || !historyEpoch || authorizationGeneration === null || !publicId
    || revision === null || !projectionSha256) return null;
  return freeze({ sourceId: record.sourceId, sourceInstanceId, applicationId, historyEpoch,
    authorizationGeneration, publicId, revision, projectionSha256 });
}
function parseNullableFence(value: unknown): OperationsPortalExternalFreshnessFence | null | undefined {
  return value === null ? null : parseFence(value) ?? undefined;
}

function fenceIdentity(fence: OperationsPortalExternalFreshnessFence): string {
  return [fence.sourceId, fence.sourceInstanceId, fence.applicationId, fence.historyEpoch, fence.publicId].join("\u0000");
}

function parseDirectoryFences(value: unknown): readonly OperationsPortalExternalFreshnessFence[] | null {
  const raw = exactArray(value, OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.externalFencesPerDirectoryRecord);
  if (!raw) return null;
  const fences = raw.map(parseFence);
  if (fences.some(fence => !fence)) return null;
  return freeze((fences as OperationsPortalExternalFreshnessFence[])
    .sort((left, right) => compare(fenceIdentity(left), fenceIdentity(right))));
}

function parseDirectoryRecord(value: unknown): OperationsPortalDirectoryRecord | null {
  const record = exactObject(value, DIRECTORY_KEYS);
  if (!record) return null;
  const recordId = permanentId(record.recordId), version = decimal(record.version, true);
  const parentRecordId = nullablePermanentId(record.parentRecordId);
  const relationshipVersion = record.relationshipVersion === null ? null : decimal(record.relationshipVersion, true) ?? undefined;
  const displayName = boundedText(record.displayName, 240), externalFences = parseDirectoryFences(record.externalFences);
  if (!recordId || (record.kind !== "organization" && record.kind !== "client") || version === null
    || parentRecordId === undefined || relationshipVersion === undefined || !displayName || !externalFences) return null;
  if ((parentRecordId === null) !== (relationshipVersion === null)) return null;
  return freeze({ recordId, kind: record.kind, version, parentRecordId, relationshipVersion, displayName, externalFences });
}

function parseProject(value: unknown): OperationsPortalProject | null {
  const record = exactObject(value, PROJECT_KEYS);
  if (!record) return null;
  const externalProjectId = permanentId(record.externalProjectId), version = decimal(record.version, true);
  const name = boundedText(record.name, 150), plannedStart = calendarDate(record.plannedStart), plannedEnd = calendarDate(record.plannedEnd);
  const completedAt = nullableTime(record.completedAt), archivedAt = nullableTime(record.archivedAt);
  const organizationRecordId = nullablePermanentId(record.organizationRecordId);
  const clientRecordId = nullablePermanentId(record.clientRecordId), externalFence = parseNullableFence(record.externalFence);
  if (!externalProjectId || version === null || !name
    || (record.lifecycle !== "not_started" && record.lifecycle !== "active" && record.lifecycle !== "completed" && record.lifecycle !== "cancelled")
    || plannedStart === undefined || plannedEnd === undefined || completedAt === undefined || archivedAt === undefined
    || typeof record.archived !== "boolean" || typeof record.overdueWarning !== "boolean" || typeof record.published !== "boolean"
    || organizationRecordId === undefined || clientRecordId === undefined || externalFence === undefined
    || (plannedStart !== null && plannedEnd !== null && plannedEnd < plannedStart)
    || (record.archived && archivedAt === null) || (!record.archived && archivedAt !== null)
    || (record.lifecycle === "completed" && completedAt === null) || (record.lifecycle !== "completed" && completedAt !== null)) return null;
  return freeze({ externalProjectId, version, name,
    lifecycle: record.lifecycle as OperationsPortalProject["lifecycle"], plannedStart, plannedEnd, completedAt,
    archived: record.archived, archivedAt, overdueWarning: record.overdueWarning, published: record.published,
    organizationRecordId, clientRecordId, externalFence });
}

function parseFolder(value: unknown): OperationsPortalFolderReservation | null {
  const record = exactObject(value, FOLDER_KEYS);
  if (!record) return null;
  const reservationId = uuid(record.reservationId), externalProjectId = permanentId(record.externalProjectId);
  const opsFolderProjectId = permanentId(record.opsFolderProjectId), divisionId = permanentId(record.divisionId);
  const clientFolderBindingId = permanentId(record.clientFolderBindingId, 200), bindingVersion = decimal(record.bindingVersion, true);
  const r2Prefix = safePrefix(record.r2Prefix), state = headState(record.state);
  return reservationId && externalProjectId && opsFolderProjectId && divisionId && clientFolderBindingId
    && bindingVersion !== null && r2Prefix && state ? freeze({ reservationId, externalProjectId, opsFolderProjectId,
      divisionId, clientFolderBindingId, bindingVersion, r2Prefix, state }) : null;
}

function parsePermissions(value: unknown, state: OperationsPortalHeadState): readonly [] | readonly ["operations.service_home.read"] | null {
  const permissions = exactArray(value, 1);
  if (!permissions) return null;
  if (state === "revoked") return permissions.length === 0 ? freeze([]) : null;
  return permissions.length === 1 && permissions[0] === "operations.service_home.read"
    ? freeze(["operations.service_home.read"] as const) : null;
}

function parseRecipient(value: unknown): OperationsPortalRecipientAuthorityHeadReference | null {
  const record = exactObject(value, RECIPIENT_KEYS);
  if (!record) return null;
  const recipientBindingId = uuid(record.recipientBindingId), enrollmentIntentId = uuid(record.enrollmentIntentId);
  const targetClientRecordId = permanentId(record.targetClientRecordId), clientAuthorityId = uuid(record.clientAuthorityId);
  const workspaceId = permanentId(record.workspaceId, 200), issuer = boundedText(record.issuer, 512), subject = boundedText(record.subject, 512);
  const enrollmentRevision = decimal(record.enrollmentRevision, true), ownershipEpoch = decimal(record.ownershipEpoch, true);
  const grantRevision = decimal(record.grantRevision, true), state = headState(record.state), lastOperationId = uuid(record.lastOperationId);
  const permissions = state && parsePermissions(record.permissions, state);
  if (!recipientBindingId || !enrollmentIntentId || !targetClientRecordId || !clientAuthorityId || !workspaceId || !issuer || !subject
    || enrollmentRevision === null || ownershipEpoch === null || grantRevision === null || !state || !lastOperationId
    || record.protocolVersion !== 3 || !permissions) return null;
  return freeze({ recipientBindingId, enrollmentIntentId, targetClientRecordId, clientAuthorityId, workspaceId, issuer, subject,
    enrollmentRevision, ownershipEpoch, grantRevision, state, lastOperationId, protocolVersion: 3 as const, permissions });
}

function parseDelivery(value: unknown): OperationsPortalDeliveryAuthorityHeadReference | null {
  const record = exactObject(value, DELIVERY_KEYS);
  if (!record) return null;
  const authorityId = uuid(record.authorityId), authorityRevision = decimal(record.authorityRevision, true);
  const state = headState(record.state), lastOperationId = uuid(record.lastOperationId), clientAuthorityId = uuid(record.clientAuthorityId);
  const workspaceId = permanentId(record.workspaceId, 200), recipientBindingId = uuid(record.recipientBindingId);
  const enrollmentIntentId = uuid(record.enrollmentIntentId), homeOwnershipEpoch = decimal(record.homeOwnershipEpoch, true);
  const homeGrantRevision = decimal(record.homeGrantRevision, true), folderReservationId = uuid(record.folderReservationId);
  const folderBindingId = permanentId(record.folderBindingId, 200), expiresAt = nullableTime(record.expiresAt);
  if (!authorityId || authorityRevision === null || !state || !lastOperationId || !clientAuthorityId || !workspaceId
    || !recipientBindingId || !enrollmentIntentId || homeOwnershipEpoch === null || homeGrantRevision === null
    || !folderReservationId || !folderBindingId || expiresAt === undefined) return null;
  return freeze({ authorityId, authorityRevision, state, lastOperationId, clientAuthorityId, workspaceId,
    recipientBindingId, enrollmentIntentId, homeOwnershipEpoch, homeGrantRevision, folderReservationId, folderBindingId, expiresAt });
}

function topologyValid(publication: OperationsPortalWorkspacePublication): boolean {
  const { target, snapshot } = publication;
  const directory = new Map(snapshot.directoryRecords.map(record => [record.recordId, record]));
  const root = directory.get(target.rootRecordId);
  if (!root || root.parentRecordId !== null || root.relationshipVersion !== null
    || root.kind !== (target.rootKind === "organization" ? "organization" : "client")) return false;
  for (const record of snapshot.directoryRecords) {
    if (record.recordId === target.rootRecordId) continue;
    if (target.rootKind !== "organization" || record.kind !== "client" || record.parentRecordId !== target.rootRecordId
      || record.relationshipVersion === null) return false;
  }
  if (target.rootKind === "standalone_client" && snapshot.directoryRecords.length !== 1) return false;

  const projects = new Map(snapshot.projects.map(project => [project.externalProjectId, project]));
  for (const project of snapshot.projects) {
    if (project.organizationRecordId === null && project.clientRecordId === null) return false;
    if (target.rootKind === "standalone_client") {
      if (project.organizationRecordId !== null || project.clientRecordId !== target.rootRecordId) return false;
    } else {
      if (project.organizationRecordId !== null && project.organizationRecordId !== target.rootRecordId) return false;
      if (project.clientRecordId !== null) {
        const client = directory.get(project.clientRecordId);
        if (!client || client.kind !== "client" || client.parentRecordId !== target.rootRecordId) return false;
      }
    }
  }
  const folders = new Map(snapshot.folderReservations.map(folder => [folder.reservationId, folder]));
  if (snapshot.folderReservations.some(folder => {
    const project = projects.get(folder.externalProjectId);
    return !project || (folder.state === "active" && !project.published);
  })) return false;

  const recipients = new Map(snapshot.recipientAuthorityHeads.map(head => [head.recipientBindingId, head]));
  for (const recipient of snapshot.recipientAuthorityHeads) {
    if (recipient.clientAuthorityId !== target.clientAuthorityId || recipient.workspaceId !== target.workspaceId) return false;
    const record = directory.get(recipient.targetClientRecordId);
    if (recipient.state === "active" && (!record || record.kind !== "client")) return false;
  }
  for (const delivery of snapshot.deliveryAuthorityHeads) {
    if (delivery.clientAuthorityId !== target.clientAuthorityId || delivery.workspaceId !== target.workspaceId) return false;
    const recipient = recipients.get(delivery.recipientBindingId), folder = folders.get(delivery.folderReservationId);
    if (!recipient || !folder || delivery.enrollmentIntentId !== recipient.enrollmentIntentId
      || delivery.folderBindingId !== folder.clientFolderBindingId) return false;
    if (delivery.state === "active" && (recipient.state !== "active" || folder.state !== "active"
      || delivery.homeOwnershipEpoch !== recipient.ownershipEpoch || delivery.homeGrantRevision !== recipient.grantRevision
      || (delivery.expiresAt !== null && Date.parse(delivery.expiresAt) <= Date.parse(publication.observedAt)))) return false;
  }
  return true;
}

function identitiesUnique(publication: OperationsPortalWorkspacePublication): boolean {
  const snapshot = publication.snapshot;
  const directoryFences = snapshot.directoryRecords.flatMap(record => record.externalFences.map(fenceIdentity));
  const projectFences = snapshot.projects.flatMap(project => project.externalFence ? [fenceIdentity(project.externalFence)] : []);
  const operationIds = [...snapshot.recipientAuthorityHeads.map(head => head.lastOperationId),
    ...snapshot.deliveryAuthorityHeads.map(head => head.lastOperationId)];
  return unique(snapshot.directoryRecords.map(record => record.recordId)) && unique(directoryFences)
    && unique(snapshot.projects.map(project => project.externalProjectId)) && unique(projectFences)
    && unique(snapshot.folderReservations.map(folder => folder.reservationId))
    && unique(snapshot.folderReservations.map(folder => folder.clientFolderBindingId))
    && unique(snapshot.folderReservations.map(folder => folder.r2Prefix))
    && unique(snapshot.recipientAuthorityHeads.map(head => head.recipientBindingId))
    && unique(snapshot.recipientAuthorityHeads.map(head => head.enrollmentIntentId))
    && unique(snapshot.recipientAuthorityHeads.map(head => `${head.issuer}\u0000${head.subject}`))
    && unique(snapshot.deliveryAuthorityHeads.map(head => head.authorityId)) && unique(operationIds);
}

function snapshotHashMaterial(publication: OperationsPortalWorkspacePublication): string {
  const { snapshot, target } = publication;
  return JSON.stringify({
    protocol: publication.protocol,
    protocolVersion: publication.protocolVersion,
    target,
    snapshot: {
      snapshotId: snapshot.snapshotId,
      checkpointId: snapshot.checkpointId,
      sourceSequence: snapshot.sourceSequence,
      complete: snapshot.complete,
      counts: snapshot.counts,
      directoryRecords: snapshot.directoryRecords,
      projects: snapshot.projects,
      folderReservations: snapshot.folderReservations,
      recipientAuthorityHeads: snapshot.recipientAuthorityHeads,
      deliveryAuthorityHeads: snapshot.deliveryAuthorityHeads,
    },
  });
}

function parseInternal(value: unknown): OperationsPortalWorkspacePublication | null {
  const record = exactObject(value, PUBLICATION_KEYS);
  if (!record || record.protocol !== OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL
    || record.protocolVersion !== 1 || record.action !== "publish") return null;
  const publicationId = uuid(record.publicationId), operationId = uuid(record.operationId);
  const expectedRevision = decimal(record.expectedRevision), resultingRevision = decimal(record.resultingRevision, true);
  if (!publicationId || !operationId || publicationId === operationId || expectedRevision === null || resultingRevision === null
    || !oneMore(expectedRevision, resultingRevision)) return null;

  const targetRecord = exactObject(record.target, TARGET_KEYS);
  const targetId = targetRecord && uuid(targetRecord.targetId), targetRevision = targetRecord && decimal(targetRecord.targetRevision, true);
  const clientAuthorityId = targetRecord && uuid(targetRecord.clientAuthorityId);
  const workspaceId = targetRecord && permanentId(targetRecord.workspaceId, 200), rootRecordId = targetRecord && permanentId(targetRecord.rootRecordId);
  const rootKind = targetRecord?.rootKind;
  if (!targetRecord || !targetId || targetRevision === null || !clientAuthorityId || !workspaceId || !rootRecordId
    || (rootKind !== "organization" && rootKind !== "standalone_client")) return null;
  const target: OperationsPortalWorkspacePublication["target"] = freeze({
    targetId, targetRevision, clientAuthorityId, workspaceId, rootKind, rootRecordId,
  });

  const snapshotRecord = exactObject(record.snapshot, SNAPSHOT_KEYS), countsRecord = snapshotRecord && exactObject(snapshotRecord.counts, COUNT_KEYS);
  if (!snapshotRecord || !countsRecord || snapshotRecord.complete !== true) return null;
  const rawDirectoryRecords = exactArray(snapshotRecord.directoryRecords,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.directoryRecords);
  const rawProjects = exactArray(snapshotRecord.projects, OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects);
  const rawFolderReservations = exactArray(snapshotRecord.folderReservations,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.folderReservations);
  const rawRecipientHeads = exactArray(snapshotRecord.recipientAuthorityHeads,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.recipientAuthorityHeads);
  const rawDeliveryHeads = exactArray(snapshotRecord.deliveryAuthorityHeads,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.deliveryAuthorityHeads);
  if (!rawDirectoryRecords || !rawProjects || !rawFolderReservations || !rawRecipientHeads || !rawDeliveryHeads) return null;
  const snapshotId = uuid(snapshotRecord.snapshotId), checkpointId = uuid(snapshotRecord.checkpointId);
  const sourceSequence = decimal(snapshotRecord.sourceSequence, true);
  const snapshotSha256 = typeof snapshotRecord.snapshotSha256 === "string" && SHA256.test(snapshotRecord.snapshotSha256)
    ? snapshotRecord.snapshotSha256 : null;
  const directoryRecords = rawDirectoryRecords.map(parseDirectoryRecord);
  const projects = rawProjects.map(parseProject), folderReservations = rawFolderReservations.map(parseFolder);
  const recipientHeads = rawRecipientHeads.map(parseRecipient), deliveryHeads = rawDeliveryHeads.map(parseDelivery);
  if (!snapshotId || !checkpointId || snapshotId === checkpointId || sourceSequence === null || !snapshotSha256
    || directoryRecords.some(item => !item) || projects.some(item => !item) || folderReservations.some(item => !item)
    || recipientHeads.some(item => !item) || deliveryHeads.some(item => !item)) return null;
  const directoryCount = exactCount(countsRecord.directoryRecords, directoryRecords.length,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.directoryRecords, 1);
  const projectCount = exactCount(countsRecord.projects, projects.length, OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.projects);
  const folderCount = exactCount(countsRecord.folderReservations, folderReservations.length,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.folderReservations);
  const recipientCount = exactCount(countsRecord.recipientAuthorityHeads, recipientHeads.length,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.recipientAuthorityHeads);
  const deliveryCount = exactCount(countsRecord.deliveryAuthorityHeads, deliveryHeads.length,
    OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.deliveryAuthorityHeads);
  if (directoryCount === null || projectCount === null || folderCount === null || recipientCount === null || deliveryCount === null) return null;
  const counts = freeze({ directoryRecords: directoryCount, projects: projectCount, folderReservations: folderCount,
    recipientAuthorityHeads: recipientCount, deliveryAuthorityHeads: deliveryCount });
  const snapshot = freeze({ snapshotId, checkpointId, sourceSequence, complete: true as const, counts, snapshotSha256,
    directoryRecords: freeze((directoryRecords as OperationsPortalDirectoryRecord[]).sort((a, b) => compare(a.recordId, b.recordId))),
    projects: freeze((projects as OperationsPortalProject[]).sort((a, b) => compare(a.externalProjectId, b.externalProjectId))),
    folderReservations: freeze((folderReservations as OperationsPortalFolderReservation[])
      .sort((a, b) => compare(a.externalProjectId, b.externalProjectId) || compare(a.reservationId, b.reservationId))),
    recipientAuthorityHeads: freeze((recipientHeads as OperationsPortalRecipientAuthorityHeadReference[])
      .sort((a, b) => compare(a.issuer, b.issuer) || compare(a.subject, b.subject) || compare(a.recipientBindingId, b.recipientBindingId))),
    deliveryAuthorityHeads: freeze((deliveryHeads as OperationsPortalDeliveryAuthorityHeadReference[])
      .sort((a, b) => compare(a.authorityId, b.authorityId))),
  });

  const actorRecord = exactObject(record.actorProof, ACTOR_KEYS);
  const staffId = actorRecord && permanentId(actorRecord.staffId), verifiedAccessSubject = actorRecord && boundedText(actorRecord.verifiedAccessSubject, 512);
  const admissionVersion = actorRecord && decimal(actorRecord.admissionVersion, true), profileVersion = actorRecord && decimal(actorRecord.profileVersion, true);
  const grantGeneration = actorRecord && decimal(actorRecord.grantGeneration, true), verifiedUntil = actorRecord && canonicalTime(actorRecord.verifiedUntil);
  const observedAt = canonicalTime(record.observedAt);
  if (!actorRecord || !staffId || !verifiedAccessSubject || admissionVersion === null || profileVersion === null
    || grantGeneration === null || !verifiedUntil || !observedAt || Date.parse(verifiedUntil) <= Date.parse(observedAt)) return null;
  const actorProof = freeze({ staffId, verifiedAccessSubject, admissionVersion, profileVersion, grantGeneration, verifiedUntil });
  const publication: OperationsPortalWorkspacePublication = freeze({
    protocol: OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_PROTOCOL,
    protocolVersion: 1 as const,
    action: "publish" as const,
    publicationId,
    operationId,
    expectedRevision,
    resultingRevision,
    target,
    snapshot,
    actorProof,
    observedAt,
  });
  if (!identitiesUnique(publication) || !topologyValid(publication)
    || new TextEncoder().encode(JSON.stringify(publication)).byteLength > OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_LIMITS.canonicalBytes) return null;
  return publication;
}

/** Shape validation is not authority and does not verify snapshotSha256. */
export function parseOperationsPortalWorkspacePublication(value: unknown): OperationsPortalWorkspacePublication | null {
  return parseInternal(value);
}

export function canonicalOperationsPortalWorkspacePublication(value: unknown): string {
  const publication = parseInternal(value);
  if (!publication) throw new Error("operations-portal-workspace-publication-invalid");
  return JSON.stringify(publication);
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const result = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(result)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Hashes the canonical snapshot material, excluding only snapshotSha256. */
export async function sha256OperationsPortalWorkspaceSnapshot(value: unknown): Promise<string> {
  const publication = parseInternal(value);
  if (!publication) throw new Error("operations-portal-workspace-publication-invalid");
  return digest(snapshotHashMaterial(publication));
}

/** Hashes the complete canonical publication, including snapshotSha256. */
export async function sha256OperationsPortalWorkspacePublication(value: unknown): Promise<string> {
  return digest(canonicalOperationsPortalWorkspacePublication(value));
}

/** Verifies the declared snapshot hash; it still does not establish authority. */
export async function verifyOperationsPortalWorkspacePublication(value: unknown): Promise<OperationsPortalWorkspacePublication | null> {
  const publication = parseInternal(value);
  if (!publication || await digest(snapshotHashMaterial(publication)) !== publication.snapshot.snapshotSha256) return null;
  return publication;
}
