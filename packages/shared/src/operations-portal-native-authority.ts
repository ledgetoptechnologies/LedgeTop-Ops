/** Private Ops-native authority wire. Parsing describes a command; it grants
 * nothing. Consumers must join durable publication/consent/owner evidence and
 * apply atomic CAS. This protocol is not legacy PA workspace authority v3. */
export const OPERATIONS_PORTAL_NATIVE_AUTHORITY_PROTOCOL = "operations-portal-native-authority" as const;
export const OPERATIONS_PORTAL_NATIVE_AUTHORITY_MAX_BYTES = 32_768;

export type OperationsPortalNativeAuthorityTarget = Readonly<{
  targetId: string; targetRevision: string; clientAuthorityId: string; workspaceId: string;
  rootKind: "organization" | "standalone_client"; rootRecordId: string;
}>;
export type OperationsPortalNativeAuthorityRecipient = Readonly<{
  recipientBindingId: string; enrollmentIntentId: string; targetClientRecordId: string;
  issuer: string; subject: string;
}>;
export type OperationsPortalNativeAuthorityPublication = Readonly<{
  operationId: string; publicationId: string; revision: string; sourceSequence: string;
  snapshotId: string; snapshotSha256: string; requestFingerprint: string;
}>;
export type OperationsPortalNativeAuthorityCommand = Readonly<{
  protocol: typeof OPERATIONS_PORTAL_NATIVE_AUTHORITY_PROTOCOL; protocolVersion: 1;
  /** Permission grammar version, not the wire protocol discriminator. */
  permissionSchemaVersion: 3;
  action: "recipient.grant" | "recipient.revoke" | "workspace.revoke";
  operationId: string; target: OperationsPortalNativeAuthorityTarget;
  recipient: OperationsPortalNativeAuthorityRecipient | null;
  expected: Readonly<{ ownershipEpoch: string; grantRevision: string | null }>;
  resulting: Readonly<{ ownershipEpoch: string; grantRevision: string | null }>;
  permissions: readonly [] | readonly ["operations.service_home.read"];
  /** Entitlement policy, never the recipient's Access-session expiry. */
  expiresAt: string | null;
  publication: OperationsPortalNativeAuthorityPublication | null;
  actorProof: Readonly<{ staffId: string; verifiedAccessSubject: string; admissionVersion: string;
    profileVersion: string; grantGeneration: string; verifiedUntil: string }>;
  observedAt: string;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const MAX_INTEGER = "9007199254740991";
const encoder = new TextEncoder();
type RecordValue = Record<string, unknown>;

function exact(input: unknown, keys: readonly string[]): RecordValue | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const names = Reflect.ownKeys(input);
  if (names.length !== keys.length || names.some(key => typeof key !== "string" || !keys.includes(key))) return null;
  const result: RecordValue = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function uuid(input: unknown): input is string { return typeof input === "string" && UUID.test(input); }
function integer(input: unknown, positive = true): input is string {
  return typeof input === "string" && /^(?:0|[1-9][0-9]{0,15})$/u.test(input)
    && (!positive || input !== "0")
    && (input.length < MAX_INTEGER.length || input.length === MAX_INTEGER.length && input <= MAX_INTEGER);
}
function opaque(input: unknown, limit = 191): input is string {
  if (typeof input !== "string" || input.length === 0 || Array.from(input).length > limit || /\p{C}/u.test(input)) return false;
  const bytes = encoder.encode(input);
  return bytes.byteLength <= limit * 4 && new TextDecoder("utf-8", { fatal: true }).decode(bytes) === input;
}
function instant(input: unknown): input is string {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(input)) return false;
  const time = Date.parse(input);
  return Number.isFinite(time) && new Date(time).toISOString() === input;
}
function issuer(input: unknown): input is string {
  if (typeof input !== "string" || input.length > 512) return false;
  const url = new URL(input);
  return url.protocol === "https:" && url.origin === input && !url.username && !url.password
    && !url.port && url.hostname.endsWith(".cloudflareaccess.com") && url.hostname !== ".cloudflareaccess.com";
}
function permissions(input: unknown, grant: boolean): boolean {
  if (!Array.isArray(input)) return false;
  const size = Object.getOwnPropertyDescriptor(input, "length");
  const wanted = grant ? 1 : 0;
  if (!size || !("value" in size) || size.value !== wanted || Reflect.ownKeys(input).length !== wanted + 1) return false;
  if (!grant) return true;
  const permission = Object.getOwnPropertyDescriptor(input, "0");
  return !!permission?.enumerable && "value" in permission && permission.value === "operations.service_home.read";
}
function parse(input: unknown): OperationsPortalNativeAuthorityCommand | null {
  const command = exact(input, ["protocol", "protocolVersion", "permissionSchemaVersion", "action", "operationId",
    "target", "recipient", "expected", "resulting", "permissions", "expiresAt", "publication", "actorProof", "observedAt"]);
  if (!command || command.protocol !== OPERATIONS_PORTAL_NATIVE_AUTHORITY_PROTOCOL || command.protocolVersion !== 1
    || command.permissionSchemaVersion !== 3 || !uuid(command.operationId) || !instant(command.observedAt)
    || typeof command.action !== "string"
    || !["recipient.grant", "recipient.revoke", "workspace.revoke"].includes(command.action)) return null;
  const grant = command.action === "recipient.grant", workspaceRevoke = command.action === "workspace.revoke";
  const target = exact(command.target, ["targetId", "targetRevision", "clientAuthorityId", "workspaceId", "rootKind", "rootRecordId"]);
  if (!target || !uuid(target.targetId) || !integer(target.targetRevision) || !uuid(target.clientAuthorityId)
    || !opaque(target.workspaceId, 200) || !opaque(target.rootRecordId)
    || target.rootKind !== "organization" && target.rootKind !== "standalone_client") return null;
  const expected = exact(command.expected, ["ownershipEpoch", "grantRevision"]);
  const resulting = exact(command.resulting, ["ownershipEpoch", "grantRevision"]);
  if (!expected || !resulting || !integer(expected.ownershipEpoch, !grant) || !integer(resulting.ownershipEpoch)) return null;
  const actor = exact(command.actorProof, ["staffId", "verifiedAccessSubject", "admissionVersion", "profileVersion", "grantGeneration", "verifiedUntil"]);
  if (!actor || !opaque(actor.staffId) || !opaque(actor.verifiedAccessSubject)
    || actor.verifiedAccessSubject.trim() !== actor.verifiedAccessSubject || !integer(actor.admissionVersion)
    || !integer(actor.profileVersion) || !integer(actor.grantGeneration) || !instant(actor.verifiedUntil)
    || actor.verifiedUntil <= command.observedAt || !permissions(command.permissions, grant)) return null;
  let recipient: OperationsPortalNativeAuthorityRecipient | null = null;
  if (workspaceRevoke) {
    if (command.recipient !== null || expected.grantRevision !== null || resulting.grantRevision !== null
      || BigInt(resulting.ownershipEpoch) !== BigInt(expected.ownershipEpoch) + 1n) return null;
  } else {
    const value = exact(command.recipient, ["recipientBindingId", "enrollmentIntentId", "targetClientRecordId", "issuer", "subject"]);
    if (!value || !uuid(value.recipientBindingId) || !uuid(value.enrollmentIntentId) || !opaque(value.targetClientRecordId)
      || !issuer(value.issuer) || !opaque(value.subject, 512) || value.subject.trim() !== value.subject
      || !integer(expected.grantRevision, !grant) || !integer(resulting.grantRevision)
      || BigInt(resulting.grantRevision) !== BigInt(expected.grantRevision) + 1n
      || (expected.ownershipEpoch === "0" ? !grant || resulting.ownershipEpoch !== "1" || expected.grantRevision !== "0"
        : resulting.ownershipEpoch !== expected.ownershipEpoch)
      || target.rootKind === "standalone_client" && value.targetClientRecordId !== target.rootRecordId) return null;
    recipient = Object.freeze({ recipientBindingId: value.recipientBindingId, enrollmentIntentId: value.enrollmentIntentId,
      targetClientRecordId: value.targetClientRecordId, issuer: value.issuer, subject: value.subject });
  }
  if (command.expiresAt !== null && (!grant || !instant(command.expiresAt) || command.expiresAt <= command.observedAt)) return null;
  let publication: OperationsPortalNativeAuthorityPublication | null = null;
  if (command.publication !== null) {
    const value = exact(command.publication, ["operationId", "publicationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256", "requestFingerprint"]);
    if (!value || !uuid(value.operationId) || !uuid(value.publicationId) || !uuid(value.snapshotId)
      || !integer(value.revision) || !integer(value.sourceSequence) || typeof value.snapshotSha256 !== "string"
      || !HASH.test(value.snapshotSha256) || typeof value.requestFingerprint !== "string" || !HASH.test(value.requestFingerprint)) return null;
    publication = Object.freeze({ operationId: value.operationId, publicationId: value.publicationId,
      revision: value.revision, sourceSequence: value.sourceSequence, snapshotId: value.snapshotId,
      snapshotSha256: value.snapshotSha256, requestFingerprint: value.requestFingerprint });
  }
  if (grant && !publication) return null;
  const result: OperationsPortalNativeAuthorityCommand = Object.freeze({
    protocol: OPERATIONS_PORTAL_NATIVE_AUTHORITY_PROTOCOL, protocolVersion: 1, permissionSchemaVersion: 3,
    action: workspaceRevoke ? "workspace.revoke" : grant ? "recipient.grant" : "recipient.revoke",
    operationId: command.operationId,
    target: Object.freeze({ targetId: target.targetId, targetRevision: target.targetRevision,
      clientAuthorityId: target.clientAuthorityId, workspaceId: target.workspaceId,
      rootKind: target.rootKind, rootRecordId: target.rootRecordId }), recipient,
    expected: Object.freeze({ ownershipEpoch: expected.ownershipEpoch, grantRevision: workspaceRevoke ? null : String(expected.grantRevision) }),
    resulting: Object.freeze({ ownershipEpoch: resulting.ownershipEpoch, grantRevision: workspaceRevoke ? null : String(resulting.grantRevision) }),
    permissions: grant ? Object.freeze(["operations.service_home.read"] as const) : Object.freeze([] as const),
    expiresAt: command.expiresAt as string | null, publication,
    actorProof: Object.freeze({ staffId: actor.staffId, verifiedAccessSubject: actor.verifiedAccessSubject,
      admissionVersion: actor.admissionVersion, profileVersion: actor.profileVersion,
      grantGeneration: actor.grantGeneration, verifiedUntil: actor.verifiedUntil }), observedAt: command.observedAt,
  });
  return encoder.encode(JSON.stringify(result)).byteLength <= OPERATIONS_PORTAL_NATIVE_AUTHORITY_MAX_BYTES ? result : null;
}

/** Historical commands can be parsed for exact receipt recovery after proof
 * expiry. New grant authorization must separately check current proof/state. */
export function parseOperationsPortalNativeAuthorityCommand(input: unknown): OperationsPortalNativeAuthorityCommand | null {
  try { return parse(input); } catch { return null; }
}
export function canonicalOperationsPortalNativeAuthorityCommand(input: unknown): string {
  const command = parseOperationsPortalNativeAuthorityCommand(input);
  if (!command) throw new Error("operations_portal_native_authority_invalid");
  return JSON.stringify(command);
}
export async function sha256OperationsPortalNativeAuthorityCommand(input: unknown): Promise<string> {
  const bytes = encoder.encode(canonicalOperationsPortalNativeAuthorityCommand(input));
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}
