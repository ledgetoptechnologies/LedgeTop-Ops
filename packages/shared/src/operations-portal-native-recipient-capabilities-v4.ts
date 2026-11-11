/**
 * Unactivated v4 recipient capability grammar.
 *
 * This module only validates/canonicalizes request data; it grants no access.
 * The v3 authority parser and persisted v3 commands remain unchanged. Runtime
 * consumers must wait for the coordinated Ops/Client schema and owner-review
 * integration before using v4 values to authorize any request.
 */
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_CAPABILITY_SCHEMA_V4 = 4 as const;
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION = "operations.service_home.read" as const;
export const OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION = "operations.request.create" as const;

export type OperationsPortalNativeRecipientPermissionsV3 = readonly []
  | readonly [typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION];
export type OperationsPortalNativeRecipientPermissionsV4 = OperationsPortalNativeRecipientPermissionsV3
  | readonly [typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION,
      typeof OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION];
export type OperationsPortalNativeRecipientPermissions = OperationsPortalNativeRecipientPermissionsV4;
export type OperationsPortalNativeRecipientPermissionSchema = 3 | 4;
export type OperationsPortalNativeRecipientAction = "recipient.grant" | "recipient.revoke" | "workspace.revoke";

const HOME = OPERATIONS_PORTAL_NATIVE_RECIPIENT_HOME_PERMISSION;
const INQUIRY = OPERATIONS_PORTAL_NATIVE_RECIPIENT_INQUIRY_PERMISSION;
const encoder = new TextEncoder();
export type OperationsPortalNativeRecipientIssueRequest = Readonly<{
  operationId: string;
  targetId: string;
  targetClientRecordId: string;
  expiresAt: string;
  permissions: readonly [typeof HOME] | readonly [typeof INQUIRY, typeof HOME];
  permissionSchemaVersion: 3 | 4;
  legacyShape: boolean;
}>;

/** Companion capability command; it can never grant recipient-home access. */
export type OperationsPortalNativeInquiryCapabilityCommandV4 = Readonly<{
  protocol: "operations-portal-native-inquiry-capability";
  protocolVersion: 1;
  permissionSchemaVersion: 4;
  action: "grant" | "revoke";
  operationId: string;
  target: Readonly<{ targetId: string; targetRevision: string; clientAuthorityId: string;
    workspaceId: string; targetClientRecordId: string }>;
  recipient: Readonly<{ recipientBindingId: string; enrollmentIntentId: string; issuer: string; subject: string }>;
  baseAuthority: Readonly<{ operationId: string; ownershipEpoch: string; grantRevision: string }>;
  publication: Readonly<{ operationId: string; revision: string; sourceSequence: string;
    snapshotId: string; snapshotSha256: string }>;
  transition: Readonly<{ expectedRevision: string; resultingRevision: string }>;
  permission: typeof INQUIRY;
  expiresAt: string;
  actorProof: Readonly<{ staffId: string; verifiedAccessSubject: string; admissionVersion: string;
    profileVersion: string; grantGeneration: string; verifiedUntil: string }>;
  observedAt: string;
}>;

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH256 = /^[0-9a-f]{64}$/u;
const POSITIVE_DECIMAL = /^[1-9][0-9]{0,15}$/u;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9][0-9]{0,15})$/u;
const OPAQUE = (value: unknown, maximum: number): value is string => typeof value === "string"
  && value.length > 0 && value.length <= maximum && value.trim() === value && !/\p{C}/u.test(value);
const positiveDecimal = (value: unknown): value is string => typeof value === "string"
  && POSITIVE_DECIMAL.test(value) && Number.isSafeInteger(Number(value));
const nonnegativeDecimal = (value: unknown): value is string => typeof value === "string"
  && NONNEGATIVE_DECIMAL.test(value) && Number.isSafeInteger(Number(value));
const uuid4 = (value: unknown): value is string => typeof value === "string" && UUID4.test(value);
const exactInstant = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function accessIssuer(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 512) return false;
  try { const url = new URL(value); return url.protocol === "https:" && url.origin === value
    && !url.username && !url.password && !url.port && url.hostname.endsWith(".cloudflareaccess.com")
    && url.hostname !== ".cloudflareaccess.com"; } catch { return false; }
}

/** Strictly parse one companion request.create grant/revoke; this is not an authorization decision. */
export function parseOperationsPortalNativeInquiryCapabilityCommandV4(
  input: unknown,
): OperationsPortalNativeInquiryCapabilityCommandV4 | null {
  try {
    const command = exactObject(input, ["protocol", "protocolVersion", "permissionSchemaVersion", "action", "operationId",
      "target", "recipient", "baseAuthority", "publication", "transition", "permission", "expiresAt", "actorProof", "observedAt"]);
    const target = exactObject(command?.target,
      ["targetId", "targetRevision", "clientAuthorityId", "workspaceId", "targetClientRecordId"]);
    const recipient = exactObject(command?.recipient, ["recipientBindingId", "enrollmentIntentId", "issuer", "subject"]);
    const base = exactObject(command?.baseAuthority, ["operationId", "ownershipEpoch", "grantRevision"]);
    const publication = exactObject(command?.publication,
      ["operationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256"]);
    const transition = exactObject(command?.transition, ["expectedRevision", "resultingRevision"]);
    const actor = exactObject(command?.actorProof,
      ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "grantGeneration", "verifiedUntil"]);
    if (!command || command.protocol !== "operations-portal-native-inquiry-capability" || command.protocolVersion !== 1
      || command.permissionSchemaVersion !== 4 || command.permission !== INQUIRY
      || (command.action !== "grant" && command.action !== "revoke") || !uuid4(command.operationId)
      || !target || !uuid4(target.targetId) || !positiveDecimal(target.targetRevision)
      || !uuid4(target.clientAuthorityId) || !OPAQUE(target.workspaceId, 200)
      || !OPAQUE(target.targetClientRecordId, 191) || !recipient || !uuid4(recipient.recipientBindingId)
      || !uuid4(recipient.enrollmentIntentId) || !accessIssuer(recipient.issuer)
      || !OPAQUE(recipient.subject, 512) || !base || !uuid4(base.operationId)
      || !positiveDecimal(base.ownershipEpoch) || !positiveDecimal(base.grantRevision)
      || !publication || !uuid4(publication.operationId) || !positiveDecimal(publication.revision)
      || !positiveDecimal(publication.sourceSequence) || !uuid4(publication.snapshotId)
      || typeof publication.snapshotSha256 !== "string" || !HASH256.test(publication.snapshotSha256)
      || !transition || !nonnegativeDecimal(transition.expectedRevision) || !positiveDecimal(transition.resultingRevision)
      || (command.action === "grant" ? transition.expectedRevision !== "0" || transition.resultingRevision !== "1"
        : BigInt(transition.resultingRevision) !== BigInt(transition.expectedRevision) + 1n)
      || !exactInstant(command.expiresAt) || !exactInstant(command.observedAt)
      || command.action === "grant" && command.expiresAt <= command.observedAt
      || !actor || !OPAQUE(actor.staffId, 191) || !OPAQUE(actor.verifiedAccessSubject, 512)
      || !positiveDecimal(actor.admissionVersion) || !positiveDecimal(actor.profileVersion)
      || !positiveDecimal(actor.grantGeneration) || !exactInstant(actor.verifiedUntil)
      || actor.verifiedUntil <= command.observedAt) return null;
    const result: OperationsPortalNativeInquiryCapabilityCommandV4 = Object.freeze({
      protocol: "operations-portal-native-inquiry-capability", protocolVersion: 1, permissionSchemaVersion: 4,
      action: command.action, operationId: command.operationId,
      target: Object.freeze({ targetId: target.targetId as string, targetRevision: target.targetRevision as string,
        clientAuthorityId: target.clientAuthorityId as string, workspaceId: target.workspaceId as string,
        targetClientRecordId: target.targetClientRecordId as string }),
      recipient: Object.freeze({ recipientBindingId: recipient.recipientBindingId as string,
        enrollmentIntentId: recipient.enrollmentIntentId as string, issuer: recipient.issuer as string,
        subject: recipient.subject as string }),
      baseAuthority: Object.freeze({ operationId: base.operationId as string,
        ownershipEpoch: base.ownershipEpoch as string, grantRevision: base.grantRevision as string }),
      publication: Object.freeze({ operationId: publication.operationId as string, revision: publication.revision as string,
        sourceSequence: publication.sourceSequence as string, snapshotId: publication.snapshotId as string,
        snapshotSha256: publication.snapshotSha256 }),
      transition: Object.freeze({ expectedRevision: transition.expectedRevision as string,
        resultingRevision: transition.resultingRevision as string }), permission: INQUIRY,
      expiresAt: command.expiresAt as string,
      actorProof: Object.freeze({ staffId: actor.staffId as string, verifiedAccessSubject: actor.verifiedAccessSubject as string,
        admissionVersion: actor.admissionVersion as string, profileVersion: actor.profileVersion as string,
        grantGeneration: actor.grantGeneration as string, verifiedUntil: actor.verifiedUntil as string }),
      observedAt: command.observedAt as string,
    });
    return encoder.encode(JSON.stringify(result)).byteLength <= 16_384 ? result : null;
  } catch { return null; }
}

export function canonicalOperationsPortalNativeInquiryCapabilityCommandV4(input: unknown): string {
  const command = parseOperationsPortalNativeInquiryCapabilityCommandV4(input);
  if (!command) throw new Error("operations_portal_native_inquiry_capability_invalid");
  return JSON.stringify(command);
}

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(descriptors);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== "string" || !keys.includes(key)
      || !descriptors[key]!.enumerable || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}

function exactPermissions(value: unknown): readonly string[] | null {
  try {
    if (!Array.isArray(value)) return null;
    const length = Object.getOwnPropertyDescriptor(value, "length");
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value)
      || Reflect.ownKeys(value).length !== length.value + 1) return null;
    const result: string[] = [];
    for (let index = 0; index < length.value; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor?.enumerable || !("value" in descriptor) || typeof descriptor.value !== "string") return null;
      result.push(descriptor.value);
    }
    return result;
  } catch { return null; }
}

/** Validate the action/version-specific permission list and freeze a copy. */
export function parseOperationsPortalNativeRecipientCapabilities(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): OperationsPortalNativeRecipientPermissionsV3 | OperationsPortalNativeRecipientPermissionsV4 | null {
  const permissions = exactPermissions(input);
  if (!permissions || (version !== 3 && version !== 4)) return null;
  if (action !== "recipient.grant" && action !== "recipient.revoke" && action !== "workspace.revoke") return null;
  if (action !== "recipient.grant") {
    if (permissions.length !== 0) return null;
    return Object.freeze([] as const);
  }
  if (version === 3) {
    if (permissions.length !== 1 || permissions[0] !== HOME) return null;
    return Object.freeze([HOME] as const);
  }
  if (permissions.length === 2 && permissions[0] === INQUIRY && permissions[1] === HOME)
    return Object.freeze([INQUIRY, HOME] as const);
  return null;
}

/** Version is derived from the capability set; v3 remains home-only. */
export function operationsPortalNativeRecipientPermissionSchema(
  input: unknown,
): OperationsPortalNativeRecipientPermissionSchema | null {
  const permissions = exactPermissions(input);
  if (!permissions) return null;
  if (permissions.length === 1 && permissions[0] === HOME) return 3;
  if (permissions.length === 2 && permissions[0] === INQUIRY && permissions[1] === HOME) return 4;
  return null;
}

export function encodeOperationsPortalNativeRecipientCapabilities(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): string | null {
  const parsed = parseOperationsPortalNativeRecipientCapabilities(version, action, input);
  return parsed ? JSON.stringify(parsed) : null;
}

export function parseOperationsPortalNativeRecipientCapabilitiesJson(
  version: unknown, action: OperationsPortalNativeRecipientAction, input: unknown,
): OperationsPortalNativeRecipientPermissionsV3 | OperationsPortalNativeRecipientPermissionsV4 | null {
  if (typeof input !== "string" || encoder.encode(input).byteLength > 256) return null;
  try { return parseOperationsPortalNativeRecipientCapabilities(version, action, JSON.parse(input)); }
  catch { return null; }
}

/**
 * Strict owner issue-intent request parser. The legacy four-field body is
 * preserved as v3 home-only. The five-field form must explicitly list one of
 * the allowed canonical sets; request.create is never inferred or defaulted.
 */
export function parseOperationsPortalNativeRecipientIssueRequest(
  input: unknown, nowMilliseconds = Date.now(),
): OperationsPortalNativeRecipientIssueRequest | null {
  const legacy = exactObject(input, ["operationId", "targetId", "targetClientRecordId", "expiresAt"]);
  const current = legacy ? null : exactObject(input,
    ["operationId", "targetId", "targetClientRecordId", "expiresAt", "permissions"]);
  const body = legacy ?? current;
  if (!body || typeof body.operationId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.operationId)
    || typeof body.targetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(body.targetId)
    || typeof body.targetClientRecordId !== "string" || body.targetClientRecordId.length < 1
    || body.targetClientRecordId.length > 191 || body.targetClientRecordId.trim() !== body.targetClientRecordId
    || /\p{C}/u.test(body.targetClientRecordId) || body.targetClientRecordId.includes("\0")
    || typeof body.expiresAt !== "string"
    || body.expiresAt.length !== 24 || !Number.isFinite(Date.parse(body.expiresAt))
    || new Date(body.expiresAt).toISOString() !== body.expiresAt || !Number.isFinite(nowMilliseconds)) return null;
  const expiresAtMilliseconds = Date.parse(body.expiresAt);
  if (expiresAtMilliseconds <= nowMilliseconds || expiresAtMilliseconds > nowMilliseconds + 7 * 86_400_000) return null;
  const permissions = legacy ? [HOME] as const
    : parseOperationsPortalNativeRecipientCapabilities(4, "recipient.grant", body.permissions)
      ?? parseOperationsPortalNativeRecipientCapabilities(3, "recipient.grant", body.permissions);
  if (!permissions || permissions.length === 0) return null;
  const permissionSchemaVersion = operationsPortalNativeRecipientPermissionSchema(permissions);
  if (!permissionSchemaVersion) return null;
  return Object.freeze({ operationId: body.operationId, targetId: body.targetId,
    targetClientRecordId: body.targetClientRecordId, expiresAt: body.expiresAt,
    permissions, permissionSchemaVersion, legacyShape: !!legacy });
}
