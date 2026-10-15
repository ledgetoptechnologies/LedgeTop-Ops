import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES,
  type OperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryFeature,
  type OperationsPortalNativeDeliveryAuthorizationReadRequest, type OperationsPortalNativeDeliveryAuthorizationProof,
  type OperationsPortalNativeDeliveryAuthorizationReaderBinding }
  from '@ltds/shared/operations-portal-native-delivery-authority';
import { isHiddenKey, normalizeRoot } from '../files';
import { operationsNativeDeliveryHandleMatchesCommand, type OperationsNativeDeliveryHandle } from './operations-native-delivery-handles';
import type { VerifiedClientPrincipal } from './types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const MAX_RESPONSE_BYTES = 16_384, TIMEOUT_MS = 1_500;
const encoder = new TextEncoder();

function authorizationRequest(command: OperationsPortalNativeDeliveryAuthorityCommand, feature: OperationsPortalNativeDeliveryFeature): OperationsPortalNativeDeliveryAuthorizationReadRequest {
  return { authorityId: command.authority.authorityId, authorityRevision: Number(command.authority.resultingRevision),
    recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
    issuer: command.recipient.issuer, subject: command.recipient.subject,
    targetId: command.target.targetId, targetRevision: Number(command.target.targetRevision),
    targetClientRecordId: command.recipient.targetClientRecordId, clientAuthorityId: command.target.clientAuthorityId,
    workspaceId: command.target.workspaceId, homeOwnershipEpoch: Number(command.recipient.homeOwnershipEpoch),
    homeGrantRevision: Number(command.recipient.homeGrantRevision), homeGrantOperationId: command.recipient.homeGrantOperationId,
    homeRequestFingerprint: command.recipient.homeRequestFingerprint, publicationOperationId: command.publication.operationId,
    publicationId: command.publication.publicationId, publicationRevision: Number(command.publication.revision),
    publicationSourceSequence: Number(command.publication.sourceSequence), publicationSnapshotId: command.publication.snapshotId,
    publicationSnapshotSha256: command.publication.snapshotSha256, folderReservationId: command.resource.folderReservationId,
    folderReservationRevision: Number(command.resource.folderReservationRevision), clientFolderBindingId: command.resource.clientFolderBindingId,
    externalProjectId: command.resource.externalProjectId, projectVersion: Number(command.resource.projectVersion),
    opsFolderProjectId: command.resource.opsFolderProjectId, opsDivisionId: command.resource.opsDivisionId, feature };
}

export type NativeOperationsDeliveryAuthorizationRequest = OperationsPortalNativeDeliveryAuthorizationReadRequest;
export type NativeOperationsDeliveryAuthorizationBinding = OperationsPortalNativeDeliveryAuthorizationReaderBinding;
export type NativeOperationsDeliveryAuthorizationEnv = Readonly<{
  DELIVERY_DB: D1Database; ENVIRONMENT?: string; CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER?: NativeOperationsDeliveryAuthorizationBinding;
}>;
/** Server-internal only: never serialize this command/prefix to the browser. */
export type NativeOperationsDeliveryContext = Readonly<{
  command: OperationsPortalNativeDeliveryAuthorityCommand; requestFingerprint: string; selectedR2Prefix: string;
}>;
export type NativeOperationsDeliveryAuthorizationResult = Readonly<{ ok: true; context: NativeOperationsDeliveryContext }>
  | Readonly<{ ok: false; code: 'disabled' | 'denied' | 'unavailable' }>;
type Row = { canonical_command_json: string; request_fingerprint: string };

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Reflect.ownKeys(value);
  if (names.length !== keys.length || names.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return names.every(key => typeof key === 'string' && descriptors[key]?.enumerable && 'value' in descriptors[key]!)
    ? value as Record<string, unknown> : null;
}
function privateResponse(wire: unknown): unknown {
  if (typeof wire !== 'string' || wire.length > MAX_RESPONSE_BYTES || encoder.encode(wire).byteLength > MAX_RESPONSE_BYTES) return null;
  try { const value: unknown = JSON.parse(wire); return JSON.stringify(value) === wire ? value : null; } catch { return null; }
}
function expectedProof(command: OperationsPortalNativeDeliveryAuthorityCommand): OperationsPortalNativeDeliveryAuthorizationProof {
  if (!command.expiresAt) throw new Error('native-delivery-proof-unavailable');
  return { authorityId: command.authority.authorityId, authorityRevision: Number(command.authority.resultingRevision),
    recipientBindingId: command.recipient.recipientBindingId, enrollmentIntentId: command.recipient.enrollmentIntentId,
    issuer: command.recipient.issuer, subject: command.recipient.subject,
    targetId: command.target.targetId, targetRevision: Number(command.target.targetRevision), targetClientRecordId: command.recipient.targetClientRecordId,
    clientAuthorityId: command.target.clientAuthorityId, workspaceId: command.target.workspaceId,
    clientFolderBindingId: command.resource.clientFolderBindingId, folderReservationId: command.resource.folderReservationId,
    folderReservationRevision: Number(command.resource.folderReservationRevision), externalProjectId: command.resource.externalProjectId,
    projectVersion: Number(command.resource.projectVersion), publicationOperationId: command.publication.operationId,
    publicationId: command.publication.publicationId, publicationRevision: Number(command.publication.revision),
    publicationSourceSequence: Number(command.publication.sourceSequence),
    publicationSnapshotId: command.publication.snapshotId, publicationSnapshotSha256: command.publication.snapshotSha256,
    homeOwnershipEpoch: Number(command.recipient.homeOwnershipEpoch), homeGrantRevision: Number(command.recipient.homeGrantRevision),
    homeGrantOperationId: command.recipient.homeGrantOperationId, homeRequestFingerprint: command.recipient.homeRequestFingerprint,
    opsFolderProjectId: command.resource.opsFolderProjectId, opsDivisionId: command.resource.opsDivisionId,
    selectedR2Prefix: command.resource.selectedR2Prefix, expiresAt: command.expiresAt, features: command.features };
}
function matchesProof(value: unknown, command: OperationsPortalNativeDeliveryAuthorityCommand): boolean {
  const expected = expectedProof(command), proof = exact(value, Object.keys(expected));
  return !!proof && Object.entries(expected).every(([key, value]) => key === 'features'
    ? Array.isArray(proof[key]) && JSON.stringify(proof[key]) === JSON.stringify(value) : proof[key] === value);
}
async function boundedRead(binding: NativeOperationsDeliveryAuthorizationBinding, input: NativeOperationsDeliveryAuthorizationRequest): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([binding.readNativeDeliveryAuthorization(input), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('native-delivery-authorization-timeout')), TIMEOUT_MS);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
async function currentRow(env: NativeOperationsDeliveryAuthorizationEnv, principal: Pick<VerifiedClientPrincipal, 'issuer' | 'subject'>,
  authorityId: string): Promise<Row | null> {
  return env.DELIVERY_DB.withSession('first-primary').prepare(`SELECT canonical_command_json,request_fingerprint
    FROM operations_portal_native_delivery_live_heads WHERE authority_id=?
      AND json_extract(canonical_command_json,'$.recipient.issuer')=?
      AND json_extract(canonical_command_json,'$.recipient.subject')=?`).bind(authorityId, principal.issuer, principal.subject).first<Row>();
}

/** The caller must repeat this proof before every index/R2 phase and final
 * byte handoff. A decoded handle, current home or historical command alone is
 * never file authority. Missing native schema cannot fall back to PA grants. */
export async function authorizeNativeOperationsDelivery(env: NativeOperationsDeliveryAuthorizationEnv,
  principal: Pick<VerifiedClientPrincipal, 'issuer' | 'subject'>, authorityId: string, feature: OperationsPortalNativeDeliveryFeature,
  handle?: OperationsNativeDeliveryHandle): Promise<NativeOperationsDeliveryAuthorizationResult> {
  if (env.ENVIRONMENT !== 'staging' || env.CLIENT_PORTAL_ORIGIN !== 'https://client-staging.ledgetopdroneservices.com'
    || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== 'true') return { ok: false, code: 'disabled' };
  if (!UUID.test(authorityId) || !principal.issuer || !principal.subject || principal.issuer.length > 512 || principal.subject.length > 512)
    return { ok: false, code: 'denied' };
  if (!env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER) return { ok: false, code: 'unavailable' };
  try {
    const before = await currentRow(env, principal, authorityId);
    if (!before) return { ok: false, code: 'denied' };
    if (typeof before.canonical_command_json !== 'string' || before.canonical_command_json.length > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES
      || encoder.encode(before.canonical_command_json).byteLength > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES
      || typeof before.request_fingerprint !== 'string' || !HASH.test(before.request_fingerprint)) return { ok: false, code: 'unavailable' };
    const command = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(before.canonical_command_json));
    if (!command || canonicalOperationsPortalNativeDeliveryAuthorityCommand(command) !== before.canonical_command_json
      || await sha256OperationsPortalNativeDeliveryAuthorityCommand(command) !== before.request_fingerprint) return { ok: false, code: 'unavailable' };
    if (command.action !== 'delivery.grant' || command.authority.authorityId !== authorityId || command.recipient.issuer !== principal.issuer
      || command.recipient.subject !== principal.subject || !command.features.includes(feature) || !command.expiresAt
      || Date.parse(command.expiresAt) <= Date.now() || normalizeRoot(command.resource.selectedR2Prefix) !== command.resource.selectedR2Prefix
      || isHiddenKey(command.resource.selectedR2Prefix) || handle && (!operationsNativeDeliveryHandleMatchesCommand(handle, command)
        || handle.expires <= Date.now())) return { ok: false, code: 'denied' };
    const raw = privateResponse(await boundedRead(env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER, authorizationRequest(command, feature)));
    const success = exact(raw, ['ok', 'protocolVersion', 'authorization']);
    if (!success || success.ok !== true || success.protocolVersion !== 1 || !matchesProof(success.authorization, command)) {
      const failure = exact(raw, ['ok', 'protocolVersion', 'code']);
      return { ok: false, code: failure?.ok === false && failure.protocolVersion === 1
        && (failure.code === 'denied' || failure.code === 'disabled') ? 'denied' : 'unavailable' };
    }
    // A revoke/new publication during the RPC must invalidate the old proof.
    const after = await currentRow(env, principal, authorityId);
    if (!after || after.request_fingerprint !== before.request_fingerprint || after.canonical_command_json !== before.canonical_command_json
      || Date.parse(command.expiresAt) <= Date.now() || handle && handle.expires <= Date.now()) return { ok: false, code: 'denied' };
    return { ok: true, context: { command, requestFingerprint: before.request_fingerprint, selectedR2Prefix: command.resource.selectedR2Prefix } };
  } catch { return { ok: false, code: 'unavailable' }; }
}
