/**
 * Closed, versioned staging contract for verified-recipient folder delivery.
 * This module validates and echoes authority data; it never grants, revokes,
 * or otherwise mutates access.
 *
 * Shape/canonical validation here is intentionally not freshness validation.
 * The eventual producer and consumer must join the current admission,
 * profile, positive directory generation, enrollment binding, folder/source,
 * workspace, and terms rows transactionally before accepting a command.
 */

export const VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL =
  "verified-recipient-delivery-authority" as const;
export const VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION = 1 as const;

export type VerifiedRecipientDeliveryAuthorityAction = "upsert" | "revoke";
export type VerifiedRecipientDeliveryAuthorityReceiptStatus = "recorded" | "replayed";
export type VerifiedRecipientDeliveryAccessTerms = Readonly<{
  id: string;
  kind: "customer" | "collaborator";
  mode: "specific_date" | "project_end" | "until_revoked";
  reviewedExpiresAt: string | null;
  effectiveExpiresAt: string | null;
}>;
export type VerifiedRecipientDeliveryOwnerProof = Readonly<{
  staffId: string;
  verifiedAccessSubject: string;
  admissionVersion: number;
  profileVersion: number;
  grantGeneration: number;
  verifiedUntil: string;
}>;
export type VerifiedRecipientDeliveryAuthorityCommand = Readonly<{
  protocol: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL;
  protocolVersion: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION;
  action: VerifiedRecipientDeliveryAuthorityAction;
  operationId: string;
  recipient: Readonly<{
    recipientBindingId: string;
    enrollmentIntentId: string;
    enrollmentRevision: number;
    issuer: string;
    subject: string;
  }>;
  selection: Readonly<{
    selectionId: string;
    clientAuthorityId: string;
    clientRecordId: string;
    workspaceId: string;
  }>;
  resource: Readonly<{
    folderBindingId: string;
    folderBindingSourceVersion: string;
    sourceId: string;
    projectPublicId: string;
    projectSourceVersion: string;
    currentGenerationId: string;
  }>;
  authority: Readonly<{
    authorityId: string;
    expectedRevision: number;
    resultingRevision: number;
  }>;
  terms: Readonly<{
    reasonCode: string;
    expiresAt: string | null;
    accessTerms: VerifiedRecipientDeliveryAccessTerms;
  }>;
  ownerProof: VerifiedRecipientDeliveryOwnerProof;
}>;
export type VerifiedRecipientDeliveryCapability =
  | Readonly<{ capability: "workspace.view"; scopeType: "workspace"; scopeId: string }>
  | Readonly<{ capability: "delivery.view"; scopeType: "folder"; scopeId: string }>;
export type VerifiedRecipientDeliveryAuthorityReceipt = Readonly<{
  protocol: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL;
  protocolVersion: typeof VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL_VERSION;
  operationId: string;
  action: VerifiedRecipientDeliveryAuthorityAction;
  status: VerifiedRecipientDeliveryAuthorityReceiptStatus;
  resultingState: "active" | "revoked";
  expectedRevision: number;
  resultingRevision: number;
  command: VerifiedRecipientDeliveryAuthorityCommand;
  capabilities: readonly VerifiedRecipientDeliveryCapability[];
  affectedScopes: readonly VerifiedRecipientDeliveryCapability[];
}>;

const COMMAND_KEYS = ["protocol", "protocolVersion", "action", "operationId", "recipient", "selection", "resource", "authority", "terms", "ownerProof"] as const;
const RECIPIENT_KEYS = ["recipientBindingId", "enrollmentIntentId", "enrollmentRevision", "issuer", "subject"] as const;
const SELECTION_KEYS = ["selectionId", "clientAuthorityId", "clientRecordId", "workspaceId"] as const;
const RESOURCE_KEYS = ["folderBindingId", "folderBindingSourceVersion", "sourceId", "projectPublicId", "projectSourceVersion", "currentGenerationId"] as const;
const AUTHORITY_KEYS = ["authorityId", "expectedRevision", "resultingRevision"] as const;
const TERMS_KEYS = ["reasonCode", "expiresAt", "accessTerms"] as const;
const ACCESS_TERMS_KEYS = ["id", "kind", "mode", "reviewedExpiresAt", "effectiveExpiresAt"] as const;
const OWNER_PROOF_KEYS = ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "grantGeneration", "verifiedUntil"] as const;
const RECEIPT_KEYS = ["protocol", "protocolVersion", "operationId", "action", "status", "resultingState", "expectedRevision", "resultingRevision", "command", "capabilities", "affectedScopes"] as const;
const CAPABILITY_KEYS = ["capability", "scopeType", "scopeId"] as const;
type UnknownRecord = Record<string, unknown>;

function exactObject(value: unknown, keys: readonly string[]): UnknownRecord | null {
  if (value === null || typeof value !== "object") return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return null;
  }
  return value as UnknownRecord;
}
function boundedString(value: unknown, maximum: number): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || value !== value.trim()) return null;
  return /[\u0000-\u001f\u007f]/u.test(value) ? null : value;
}
function uuidV4(value: unknown): string | null {
  const text = boundedString(value, 36);
  return text && text === text.toLowerCase() && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(text) ? text : null;
}
function positiveRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647 ? value : null;
}
function expectedRevision(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_646 ? value : null;
}
function canonicalTime(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) || date.toISOString() !== value ? null : value;
}
function nullableCanonicalTime(value: unknown): string | null | undefined {
  if (value === null) return null;
  return canonicalTime(value) ?? undefined;
}
function opaqueId(value: unknown, maximum = 200): string | null { return boundedString(value, maximum); }
function reasonCode(value: unknown): string | null {
  const text = boundedString(value, 80);
  return text && /^[A-Za-z0-9_. -]+$/u.test(text) ? text : null;
}

function parseAccessTerms(value: unknown): VerifiedRecipientDeliveryAccessTerms | null {
  const record = exactObject(value, ACCESS_TERMS_KEYS);
  if (!record) return null;
  const id = opaqueId(record.id);
  const kind = record.kind;
  const mode = record.mode;
  const reviewedExpiresAt = nullableCanonicalTime(record.reviewedExpiresAt);
  const effectiveExpiresAt = nullableCanonicalTime(record.effectiveExpiresAt);
  if (!id || (kind !== "customer" && kind !== "collaborator") || (mode !== "specific_date" && mode !== "project_end" && mode !== "until_revoked") || reviewedExpiresAt === undefined || effectiveExpiresAt === undefined) return null;
  if (kind === "customer" && mode !== "until_revoked") return null;
  if (mode === "specific_date" && (kind !== "collaborator" || reviewedExpiresAt === null || effectiveExpiresAt !== reviewedExpiresAt)) return null;
  if (mode === "project_end" && reviewedExpiresAt !== null) return null;
  if (mode === "until_revoked" && (reviewedExpiresAt !== null || effectiveExpiresAt !== null)) return null;
  return Object.freeze({ id, kind, mode, reviewedExpiresAt, effectiveExpiresAt });
}
function parseOwnerProof(value: unknown): VerifiedRecipientDeliveryOwnerProof | null {
  const record = exactObject(value, OWNER_PROOF_KEYS);
  if (!record) return null;
  const staffId = opaqueId(record.staffId);
  const verifiedAccessSubject = boundedString(record.verifiedAccessSubject, 512);
  const admissionVersion = positiveRevision(record.admissionVersion);
  const profileVersion = positiveRevision(record.profileVersion);
  const grantGeneration = positiveRevision(record.grantGeneration);
  const verifiedUntil = canonicalTime(record.verifiedUntil);
  if (!staffId || !verifiedAccessSubject || admissionVersion === null || profileVersion === null || grantGeneration === null || !verifiedUntil) return null;
  return Object.freeze({ staffId, verifiedAccessSubject, admissionVersion, profileVersion, grantGeneration, verifiedUntil });
}
function parseCommandInternal(value: unknown): VerifiedRecipientDeliveryAuthorityCommand | null {
  const record = exactObject(value, COMMAND_KEYS);
  if (!record || record.protocol !== VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL || record.protocolVersion !== 1) return null;
  const action = record.action;
  if (action !== "upsert" && action !== "revoke") return null;
  const operationId = uuidV4(record.operationId);
  const recipientRecord = exactObject(record.recipient, RECIPIENT_KEYS);
  const recipientBindingId = recipientRecord && uuidV4(recipientRecord.recipientBindingId);
  const enrollmentIntentId = recipientRecord && uuidV4(recipientRecord.enrollmentIntentId);
  const enrollmentRevision = recipientRecord && positiveRevision(recipientRecord.enrollmentRevision);
  const issuer = recipientRecord && boundedString(recipientRecord.issuer, 512);
  const subject = recipientRecord && boundedString(recipientRecord.subject, 512);
  const selectionRecord = exactObject(record.selection, SELECTION_KEYS);
  const selectionId = selectionRecord && uuidV4(selectionRecord.selectionId);
  const clientAuthorityId = selectionRecord && uuidV4(selectionRecord.clientAuthorityId);
  const clientRecordId = selectionRecord && opaqueId(selectionRecord.clientRecordId);
  const workspaceId = selectionRecord && opaqueId(selectionRecord.workspaceId);
  const resourceRecord = exactObject(record.resource, RESOURCE_KEYS);
  const folderBindingId = resourceRecord && opaqueId(resourceRecord.folderBindingId);
  const folderBindingSourceVersion = resourceRecord && opaqueId(resourceRecord.folderBindingSourceVersion, 128);
  const sourceId = resourceRecord && boundedString(resourceRecord.sourceId, 128);
  const projectPublicId = resourceRecord && opaqueId(resourceRecord.projectPublicId);
  const projectSourceVersion = resourceRecord && opaqueId(resourceRecord.projectSourceVersion, 128);
  const currentGenerationId = resourceRecord && opaqueId(resourceRecord.currentGenerationId);
  const authorityRecord = exactObject(record.authority, AUTHORITY_KEYS);
  const authorityId = authorityRecord && uuidV4(authorityRecord.authorityId);
  const expected = authorityRecord && expectedRevision(authorityRecord.expectedRevision);
  const resulting = authorityRecord && positiveRevision(authorityRecord.resultingRevision);
  const termsRecord = exactObject(record.terms, TERMS_KEYS);
  const reasonCodeValue = termsRecord && reasonCode(termsRecord.reasonCode);
  const expiresAt = termsRecord && nullableCanonicalTime(termsRecord.expiresAt);
  const accessTerms = termsRecord && parseAccessTerms(termsRecord.accessTerms);
  const ownerProof = parseOwnerProof(record.ownerProof);
  if (!operationId || !recipientBindingId || !enrollmentIntentId || enrollmentRevision === null || !issuer || !subject || !selectionId || !clientAuthorityId || !clientRecordId || !workspaceId || !folderBindingId || !folderBindingSourceVersion || !sourceId || !projectPublicId || !projectSourceVersion || !currentGenerationId || !authorityId || expected === null || resulting === null || resulting !== expected + 1 || (action === "revoke" && expected < 1) || !reasonCodeValue || expiresAt === undefined || !accessTerms || accessTerms.effectiveExpiresAt !== expiresAt || !ownerProof) return null;
  return Object.freeze({
    protocol: VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL,
    protocolVersion: 1,
    action,
    operationId,
    recipient: Object.freeze({ recipientBindingId, enrollmentIntentId, enrollmentRevision, issuer, subject }),
    selection: Object.freeze({ selectionId, clientAuthorityId, clientRecordId, workspaceId }),
    resource: Object.freeze({ folderBindingId, folderBindingSourceVersion, sourceId, projectPublicId, projectSourceVersion, currentGenerationId }),
    authority: Object.freeze({ authorityId, expectedRevision: expected, resultingRevision: resulting }),
    terms: Object.freeze({ reasonCode: reasonCodeValue, expiresAt, accessTerms }),
    ownerProof,
  });
}
export function parseVerifiedRecipientDeliveryAuthorityCommand(value: unknown): VerifiedRecipientDeliveryAuthorityCommand | null { return parseCommandInternal(value); }
type CapabilityTuple = readonly [
  VerifiedRecipientDeliveryCapability & { capability: "workspace.view" },
  VerifiedRecipientDeliveryCapability & { capability: "delivery.view" },
];
export function verifiedRecipientDeliveryAuthorityCapabilities(command: VerifiedRecipientDeliveryAuthorityCommand): CapabilityTuple {
  return Object.freeze([
    Object.freeze({ capability: "workspace.view" as const, scopeType: "workspace" as const, scopeId: command.selection.workspaceId }),
    Object.freeze({ capability: "delivery.view" as const, scopeType: "folder" as const, scopeId: command.resource.folderBindingId }),
  ] as const);
}
export function verifiedRecipientDeliveryAuthorityAffectedScopes(command: VerifiedRecipientDeliveryAuthorityCommand): CapabilityTuple { return verifiedRecipientDeliveryAuthorityCapabilities(command); }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function canonicalCommand(command: VerifiedRecipientDeliveryAuthorityCommand): string { return JSON.stringify(command); }
export function canonicalVerifiedRecipientDeliveryAuthorityCommand(command: VerifiedRecipientDeliveryAuthorityCommand): string {
  const parsed = parseCommandInternal(command);
  if (!parsed) throw new Error("verified_recipient_delivery_authority_command_invalid");
  return canonicalCommand(parsed);
}
export function createVerifiedRecipientDeliveryAuthorityReceipt(command: VerifiedRecipientDeliveryAuthorityCommand, status: VerifiedRecipientDeliveryAuthorityReceiptStatus): VerifiedRecipientDeliveryAuthorityReceipt {
  const parsed = parseCommandInternal(command);
  if (!parsed) throw new Error("verified_recipient_delivery_authority_command_invalid");
  const active = parsed.action === "upsert" ? verifiedRecipientDeliveryAuthorityCapabilities(parsed) : [];
  const affected = parsed.action === "revoke" ? verifiedRecipientDeliveryAuthorityAffectedScopes(parsed) : [];
  return Object.freeze({ protocol: VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1 as const, operationId: parsed.operationId, action: parsed.action, status, resultingState: parsed.action === "upsert" ? ("active" as const) : ("revoked" as const), expectedRevision: parsed.authority.expectedRevision, resultingRevision: parsed.authority.resultingRevision, command: parsed, capabilities: active, affectedScopes: affected });
}
function parseCapabilityList(value: unknown): CapabilityTuple | readonly [] | null {
  if (Array.isArray(value) && value.length === 0) return Object.freeze([]);
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = exactObject(value[0], CAPABILITY_KEYS);
  const second = exactObject(value[1], CAPABILITY_KEYS);
  const firstScopeId = first && opaqueId(first.scopeId);
  const secondScopeId = second && opaqueId(second.scopeId);
  if (!first || !second || first.capability !== "workspace.view" || first.scopeType !== "workspace" || !firstScopeId || second.capability !== "delivery.view" || second.scopeType !== "folder" || !secondScopeId) return null;
  return Object.freeze([
    Object.freeze({ capability: "workspace.view" as const, scopeType: "workspace" as const, scopeId: firstScopeId }),
    Object.freeze({ capability: "delivery.view" as const, scopeType: "folder" as const, scopeId: secondScopeId }),
  ] as const);
}
export function parseVerifiedRecipientDeliveryAuthorityReceipt(value: unknown, expectedCommand: VerifiedRecipientDeliveryAuthorityCommand): VerifiedRecipientDeliveryAuthorityReceipt | null {
  const expected = parseCommandInternal(expectedCommand);
  const record = exactObject(value, RECEIPT_KEYS);
  if (!expected || !record || record.protocol !== VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL || record.protocolVersion !== 1 || (record.status !== "recorded" && record.status !== "replayed")) return null;
  const command = parseCommandInternal(record.command);
  const operationId = uuidV4(record.operationId);
  const action = record.action;
  const resultingState = record.resultingState;
  const expectedRevisionValue = expectedRevision(record.expectedRevision);
  const resultingRevisionValue = positiveRevision(record.resultingRevision);
  const parsedCapabilities = parseCapabilityList(record.capabilities);
  const parsedAffectedScopes = parseCapabilityList(record.affectedScopes);
  if (!command || !operationId || (action !== "upsert" && action !== "revoke") || (resultingState !== "active" && resultingState !== "revoked") || expectedRevisionValue === null || resultingRevisionValue === null || !parsedCapabilities || !parsedAffectedScopes || operationId !== expected.operationId || action !== expected.action || resultingState !== (expected.action === "upsert" ? "active" : "revoked") || expectedRevisionValue !== expected.authority.expectedRevision || resultingRevisionValue !== expected.authority.resultingRevision || !sameJson(command, expected) || (action === "upsert" && (!sameJson(parsedCapabilities, verifiedRecipientDeliveryAuthorityCapabilities(expected)) || parsedAffectedScopes.length !== 0)) || (action === "revoke" && (parsedCapabilities.length !== 0 || !sameJson(parsedAffectedScopes, verifiedRecipientDeliveryAuthorityAffectedScopes(expected))))) return null;
  return Object.freeze({ protocol: VERIFIED_RECIPIENT_DELIVERY_AUTHORITY_PROTOCOL, protocolVersion: 1, operationId, action, status: record.status, resultingState, expectedRevision: expectedRevisionValue, resultingRevision: resultingRevisionValue, command, capabilities: parsedCapabilities, affectedScopes: parsedAffectedScopes });
}
