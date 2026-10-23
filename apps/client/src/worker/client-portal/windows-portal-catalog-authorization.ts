import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, parseOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand, OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES,
  type OperationsPortalNativeDeliveryAuthorityCommand, type OperationsPortalNativeDeliveryPublicationPins,
  type OperationsPortalNativeDeliveryPublicationContinuity, type WindowsPortalCatalogFeature,
  type OperationsPortalNativeCatalogSuccessorReaderBinding }
  from "@ltds/shared/operations-portal-native-delivery-authority";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { operationsNativeDeliveryProofMatchesCommand, type NativeOperationsDeliveryAuthorizationEnv,
  type NativeOperationsDeliveryAuthorizationBinding } from "./operations-native-delivery-authorization";
import { WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL } from "./windows-portal-successor-candidate";
import { isHiddenKey, normalizeRoot } from "../files";
import type { VerifiedClientPrincipal } from "./types";

export type { WindowsPortalCatalogFeature } from "@ltds/shared/operations-portal-native-delivery-authority";
export type WindowsPortalCatalogReaderBinding = OperationsPortalNativeCatalogSuccessorReaderBinding;
export type WindowsPortalCatalogAuthorizationEnv = Omit<NativeOperationsDeliveryAuthorizationEnv, "OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER"> & Readonly<{
  OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER?: NativeOperationsDeliveryAuthorizationBinding & WindowsPortalCatalogReaderBinding;
}>;
type Candidate = { canonical_command_json: string; request_fingerprint: string; publication_operation_id: string;
  publication_id: string; publication_revision: number; publication_source_sequence: number; snapshot_id: string; snapshot_sha256: string };
/** Distinct from ordinary NativeOperationsDeliveryContext. Never pass this to
 * original-publication byte/audit routes or serialize its private grant/prefix. */
export type WindowsPortalCatalogContext = Readonly<{
  kind: "windows-portal-catalog-v1"; feature: WindowsPortalCatalogFeature; originalGrant: OperationsPortalNativeDeliveryAuthorityCommand;
  originalRequestFingerprint: string; selectedR2Prefix: string; continuity: OperationsPortalNativeDeliveryPublicationContinuity;
}>;
export type WindowsPortalCatalogResult = Readonly<{ ok: true; catalogContext: WindowsPortalCatalogContext }>
  | Readonly<{ ok: false; code: "disabled" | "denied" | "unavailable" }>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder(), MAX_RESPONSE = 16_384, TIMEOUT = 1_500;
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const names = Reflect.ownKeys(value), descriptors = Object.getOwnPropertyDescriptors(value);
  return names.length === keys.length && names.every(key => typeof key === "string" && keys.includes(key)
    && descriptors[key]?.enumerable && "value" in descriptors[key]!) ? value as Record<string, unknown> : null;
}
function wireValue(wire: unknown): unknown {
  if (typeof wire !== "string" || wire.length > MAX_RESPONSE || encoder.encode(wire).byteLength > MAX_RESPONSE) return null;
  try { const value: unknown = JSON.parse(wire); return JSON.stringify(value) === wire ? value : null; } catch { return null; }
}
function pins(value: unknown): OperationsPortalNativeDeliveryPublicationPins | null {
  const r = exact(value, ["operationId", "publicationId", "revision", "sourceSequence", "snapshotId", "snapshotSha256"]);
  if (!r || typeof r.operationId !== "string" || !UUID.test(r.operationId) || typeof r.publicationId !== "string" || !UUID.test(r.publicationId)
    || typeof r.snapshotId !== "string" || !UUID.test(r.snapshotId) || typeof r.snapshotSha256 !== "string" || !HASH.test(r.snapshotSha256)
    || typeof r.revision !== "number" || !Number.isSafeInteger(r.revision) || r.revision < 1 || r.sourceSequence !== r.revision) return null;
  return Object.freeze({ operationId: r.operationId, publicationId: r.publicationId, revision: r.revision,
    sourceSequence: r.revision, snapshotId: r.snapshotId, snapshotSha256: r.snapshotSha256 });
}
const currentPins = (c: Candidate) => pins({ operationId: c.publication_operation_id, publicationId: c.publication_id,
  revision: c.publication_revision, sourceSequence: c.publication_source_sequence, snapshotId: c.snapshot_id, snapshotSha256: c.snapshot_sha256 });
const same = (a: OperationsPortalNativeDeliveryPublicationPins, b: OperationsPortalNativeDeliveryPublicationPins) =>
  Object.entries(a).every(([key, value]) => b[key as keyof typeof b] === value);
async function candidate(env: WindowsPortalCatalogAuthorizationEnv, principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">, authorityId: string) {
  return env.DELIVERY_DB.withSession("first-primary").prepare(WINDOWS_PORTAL_SUCCESSOR_CANDIDATE_SQL)
    .bind(authorityId, principal.issuer, principal.subject).first<Candidate>();
}
async function read(binding: WindowsPortalCatalogReaderBinding, canonical: string, feature: WindowsPortalCatalogFeature): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([binding.readWindowsCatalogSuccessorAuthorization(canonical, feature), new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("windows-successor-timeout")), TIMEOUT);
  })]); } finally { if (timer !== undefined) clearTimeout(timer); }
}
/** Source-only catalog authorizer. Supports only explicit folder listing or file metadata. Caller must first verify a human session,
 * then repeat this proof before each catalog metadata phase and response.
 * No byte permission is implied; downloads require the separate download authorizer. */
export async function authorizeWindowsPortalCatalog(env: WindowsPortalCatalogAuthorizationEnv, rawPrincipal: Pick<VerifiedClientPrincipal, "issuer" | "subject">,
  authorityId: string, feature: WindowsPortalCatalogFeature): Promise<WindowsPortalCatalogResult> {
  const principal = { issuer: rawPrincipal.issuer, subject: rawPrincipal.subject };
  if (!nativeDeliveryDeploymentEnabled(env) || env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_READ_ENABLED !== "true") return { ok: false, code: "disabled" };
  if ((feature !== "folder.list" && feature !== "file.metadata") || !UUID.test(authorityId) || !principal.issuer || !principal.subject || principal.issuer.length > 512 || principal.subject.length > 512) return { ok: false, code: "denied" };
  const binding = env.OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORIZATION_READER;
  if (!binding || typeof binding.readWindowsCatalogSuccessorAuthorization !== "function") return { ok: false, code: "unavailable" };
  try {
    const before = await candidate(env, principal, authorityId);
    if (!before) return { ok: false, code: "denied" };
    if (typeof before.canonical_command_json !== "string" || before.canonical_command_json.length > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES
      || encoder.encode(before.canonical_command_json).byteLength > OPERATIONS_PORTAL_NATIVE_DELIVERY_AUTHORITY_MAX_BYTES
      || typeof before.request_fingerprint !== "string" || !HASH.test(before.request_fingerprint)) return { ok: false, code: "unavailable" };
    const grant = parseOperationsPortalNativeDeliveryAuthorityCommand(JSON.parse(before.canonical_command_json)), current = currentPins(before);
    if (!grant || !current || canonicalOperationsPortalNativeDeliveryAuthorityCommand(grant) !== before.canonical_command_json
      || await sha256OperationsPortalNativeDeliveryAuthorityCommand(grant) !== before.request_fingerprint) return { ok: false, code: "unavailable" };
    if (grant.action !== "delivery.grant" || grant.authority.authorityId !== authorityId || grant.recipient.issuer !== principal.issuer
      || grant.recipient.subject !== principal.subject || !grant.features.includes(feature) || !grant.expiresAt
      || !(Date.parse(grant.expiresAt) > Date.now()) || normalizeRoot(grant.resource.selectedR2Prefix) !== grant.resource.selectedR2Prefix
      || isHiddenKey(grant.resource.selectedR2Prefix)) return { ok: false, code: "denied" };
    const raw = wireValue(await read(binding, before.canonical_command_json, feature));
    const success = exact(raw, ["ok", "protocolVersion", "feature", "catalog"]), successor = exact(success?.catalog, ["authorization", "continuity"]);
    if (!success || success.ok !== true || success.protocolVersion !== 1 || success.feature !== feature || !successor
      || !operationsNativeDeliveryProofMatchesCommand(successor.authorization, grant)) {
      const failure = exact(raw, ["ok", "protocolVersion", "code"]);
      return { ok: false, code: failure?.ok === false && failure.protocolVersion === 1 && (failure.code === "denied" || failure.code === "disabled") ? "denied" : "unavailable" };
    }
    const continuity = exact(successor.continuity, ["grantOperationId", "grantFingerprint", "first", "current", "publicationCount", "chainSha256"]);
    const first = pins(continuity?.first), effective = pins(continuity?.current);
    const original = pins({ operationId: grant.publication.operationId, publicationId: grant.publication.publicationId,
      revision: Number(grant.publication.revision), sourceSequence: Number(grant.publication.sourceSequence), snapshotId: grant.publication.snapshotId,
      snapshotSha256: grant.publication.snapshotSha256 });
    if (!continuity || !first || !effective || !original || !same(first, original) || !same(effective, current)
      || continuity.grantOperationId !== grant.operationId || continuity.grantFingerprint !== before.request_fingerprint
      || typeof continuity.chainSha256 !== "string" || !HASH.test(continuity.chainSha256)
      || typeof continuity.publicationCount !== "number" || !Number.isSafeInteger(continuity.publicationCount)
      || continuity.publicationCount < 1 || continuity.publicationCount > 64 || effective.sourceSequence < first.sourceSequence
      || continuity.publicationCount !== effective.sourceSequence - first.sourceSequence + 1) return { ok: false, code: "unavailable" };
    const after = await candidate(env, principal, authorityId), afterPins = after && currentPins(after);
    if (!after || !afterPins || !same(afterPins, current) || before.canonical_command_json !== after.canonical_command_json
      || before.request_fingerprint !== after.request_fingerprint || !(Date.parse(grant.expiresAt) > Date.now())) return { ok: false, code: "denied" };
    return { ok: true, catalogContext: Object.freeze({ kind: "windows-portal-catalog-v1", feature, originalGrant: grant,
      originalRequestFingerprint: before.request_fingerprint, selectedR2Prefix: grant.resource.selectedR2Prefix,
      continuity: Object.freeze({ grantOperationId: grant.operationId, grantFingerprint: before.request_fingerprint, first,
        current: effective, publicationCount: continuity.publicationCount, chainSha256: continuity.chainSha256 }) }) };
  } catch { return { ok: false, code: "unavailable" }; }
}
