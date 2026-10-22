import { canonicalOperationsPortalNativeDeliveryAuthorityCommand, sha256OperationsPortalNativeDeliveryAuthorityCommand }
  from "@ltds/shared/operations-portal-native-delivery-authority";
import { isHiddenKey, validateRelativePath } from "../files";
import { nativeDeliveryDeploymentEnabled } from "../operations-native-delivery-deployment";
import { hmac, sha256 } from "../security";
import type { OperationsNativeContentAuditEnv } from "./operations-native-content-audit";
import type { VerifiedClientPrincipal } from "./types";
import { authorizeWindowsPortalSuccessor, type WindowsPortalSuccessorContext } from "./windows-portal-successor-authorization";

export type WindowsPortalSuccessorContentAuditEnv = Parameters<typeof authorizeWindowsPortalSuccessor>[0] & OperationsNativeContentAuditEnv;
export type WindowsPortalSuccessorContentStartInput = Readonly<{
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">; context: WindowsPortalSuccessorContext;
  storageKey: string; indexedETag: string; strongETag: string; providerVersion: string; sha256: string; size: number;
}>;
const TABLE = "windows_portal_successor_content_start_events", WINDOW = 600_000;
const OBJECTS = [TABLE, "operations_portal_native_delivery_successor_candidates", "windows_portal_successor_content_start_timeline",
  "windows_portal_successor_content_start_insert_guard", "windows_portal_successor_content_start_no_update",
  "windows_portal_successor_content_start_no_delete"] as const;
const HASH = /^[a-f0-9]{64}$/u;
const encoder = new TextEncoder();
/** No provider, database, path or identity details cross this failure boundary. */
export class WindowsPortalSuccessorAuditUnavailableError extends Error {
  constructor() { super("windows-successor-content-audit-unavailable"); this.name = "WindowsPortalSuccessorAuditUnavailableError"; }
}
const unavailable = (): never => { throw new WindowsPortalSuccessorAuditUnavailableError(); };
function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key =>
    `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
  const result = JSON.stringify(value); if (result === undefined) return unavailable(); return result;
}
async function ready(env: WindowsPortalSuccessorContentAuditEnv): Promise<string> {
  if (!nativeDeliveryDeploymentEnabled(env) || env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED !== "true"
    || !bounded(env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET, 4096)
    || env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET.length < 32) return unavailable();
  const rows = (await env.DELIVERY_DB.withSession("first-primary").prepare(
    `SELECT name FROM sqlite_master WHERE name IN (${OBJECTS.map(() => "?").join(",")}) ORDER BY name`)
    .bind(...OBJECTS).all<{ name: string }>()).results.map(row => row.name);
  if (JSON.stringify(rows) !== JSON.stringify([...OBJECTS].sort())) return unavailable();
  return env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET;
}

/** Source-only file.download audit. It never changes grant/publication state.
 * Remote/R2 identity must be verified by the route; D1 cannot inspect R2 object
 * versions. Both remote and local successor proof are repeated here, so a
 * caller-supplied context or existing dedupe event is never authorization. */
export async function appendWindowsPortalSuccessorContentStart(env: WindowsPortalSuccessorContentAuditEnv,
  input: WindowsPortalSuccessorContentStartInput, now = new Date()): Promise<Readonly<{ eventId: string; occurredAt: string; replayed: boolean }>> {
  try {
    // Detach every caller-owned value before the first await, including nested
    // continuity/grant objects. No assertion, raw key or version is persisted.
    const raw = JSON.stringify(input);
    if (encoder.encode(raw).byteLength > 100_000) return unavailable();
    const selected = JSON.parse(raw) as WindowsPortalSuccessorContentStartInput;
    const { principal, context, storageKey, indexedETag, strongETag, providerVersion, size } = selected;
    const grant = context?.originalGrant, nowTime = now.getTime();
    if (!grant || context.kind !== "windows-portal-successor-v1" || grant.action !== "delivery.grant" || !grant.features.includes("file.download")
      || !grant.expiresAt || Date.parse(grant.expiresAt) <= Date.now() || !bounded(principal?.issuer, 512) || !bounded(principal?.subject, 512)
      || grant.recipient.issuer !== principal.issuer || grant.recipient.subject !== principal.subject
      || context.selectedR2Prefix !== grant.resource.selectedR2Prefix || !bounded(storageKey, 1024) || isHiddenKey(storageKey)
      || !storageKey.startsWith(context.selectedR2Prefix) || storageKey === context.selectedR2Prefix
      || !bounded(indexedETag, 256) || !bounded(strongETag, 256) || !/^"[\x21\x23-\x7e]+"$/u.test(strongETag)
      || indexedETag !== strongETag && strongETag !== `"${indexedETag}"`
      || !bounded(providerVersion, 256) || !HASH.test(selected.sha256) || !Number.isSafeInteger(size) || size < 0 || size > 2 ** 40
      || !Number.isFinite(nowTime)) return unavailable();
    const relative = storageKey.slice(context.selectedR2Prefix.length);
    if (validateRelativePath(relative) !== relative) return unavailable();
    const occurredAt = new Date(nowTime).toISOString(), canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(grant);
    const authorityId = grant.authority.authorityId, expectedContext = stable(context);
    if (await sha256OperationsPortalNativeDeliveryAuthorityCommand(grant) !== context.originalRequestFingerprint) return unavailable();
    const secret = await ready(env);
    const before = await authorizeWindowsPortalSuccessor(env, principal, authorityId);
    if (!before.ok || stable(before.successorContext) !== expectedContext) return unavailable();
    const principalFingerprint = await hmac(secret, `windows-successor-content:principal:v1\0${principal.issuer}\0${principal.subject}`);
    const prefixFingerprint = await hmac(secret, `windows-successor-content:prefix:v1\0${context.selectedR2Prefix}`);
    const resourceFingerprint = await hmac(secret, `windows-successor-content:resource:v1\0${prefixFingerprint}\0${storageKey}`);
    const contentVersionFingerprint = await hmac(secret, `windows-successor-content:version:v1\0${resourceFingerprint}\0${JSON.stringify([strongETag, providerVersion, selected.sha256, size])}`);
    const current = context.continuity.current;
    const dedupeWindow = Math.floor(nowTime / WINDOW);
    const dedupeKey = await sha256(JSON.stringify(["windows-successor-content-start:v1", principalFingerprint,
      authorityId, grant.authority.resultingRevision, grant.operationId, context.originalRequestFingerprint,
      stable(context.continuity), resourceFingerprint, contentVersionFingerprint, dedupeWindow]));
    const eventId = `windows-successor-content-${dedupeKey}`;
    const fields: Record<string, string | number> = {
      event_id: eventId, dedupe_key: dedupeKey, dedupe_window: dedupeWindow, action: "file.download_requested", feature: "file.download",
      principal_fingerprint: principalFingerprint, authority_id: authorityId, authority_revision: Number(grant.authority.resultingRevision),
      delivery_operation_id: grant.operationId, delivery_request_fingerprint: context.originalRequestFingerprint,
      recipient_binding_id: grant.recipient.recipientBindingId, target_id: grant.target.targetId, workspace_id: grant.target.workspaceId,
      home_ownership_epoch: Number(grant.recipient.homeOwnershipEpoch), home_grant_revision: Number(grant.recipient.homeGrantRevision),
      home_grant_operation_id: grant.recipient.homeGrantOperationId, home_request_fingerprint: grant.recipient.homeRequestFingerprint,
      original_publication_operation_id: grant.publication.operationId, original_publication_id: grant.publication.publicationId,
      original_publication_revision: Number(grant.publication.revision), original_publication_source_sequence: Number(grant.publication.sourceSequence),
      original_publication_snapshot_id: grant.publication.snapshotId, original_publication_snapshot_sha256: grant.publication.snapshotSha256,
      folder_reservation_id: grant.resource.folderReservationId, folder_reservation_revision: Number(grant.resource.folderReservationRevision),
      client_folder_binding_id: grant.resource.clientFolderBindingId, external_project_id: grant.resource.externalProjectId,
      project_version: Number(grant.resource.projectVersion), effective_publication_operation_id: current.operationId,
      effective_publication_id: current.publicationId, effective_publication_revision: current.revision,
      effective_publication_source_sequence: current.sourceSequence, effective_publication_snapshot_id: current.snapshotId,
      effective_publication_snapshot_sha256: current.snapshotSha256, chain_sha256: context.continuity.chainSha256,
      publication_count: context.continuity.publicationCount, prefix_fingerprint: prefixFingerprint, resource_fingerprint: resourceFingerprint,
      content_version_fingerprint: contentVersionFingerprint, occurred_at: occurredAt,
    };
    const fence = `(candidate.authority_id=? AND candidate.issuer=? AND candidate.subject=?
      AND candidate.canonical_command_json=? AND candidate.request_fingerprint=?)
      AND (candidate.publication_operation_id=? AND candidate.publication_id=? AND candidate.publication_revision=?
        AND candidate.publication_source_sequence=? AND candidate.snapshot_id=? AND candidate.snapshot_sha256=?)
      AND (file.r2_key=? AND file.etag=? AND file.size=?
        AND substr(file.r2_key,1,length(json_extract(candidate.canonical_command_json,'$.resource.selectedR2Prefix')))
          =json_extract(candidate.canonical_command_json,'$.resource.selectedR2Prefix'))
      AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
        AND (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix'
          AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)))`;
    const bindings = [authorityId, principal.issuer, principal.subject, canonical, context.originalRequestFingerprint,
      current.operationId, current.publicationId, current.revision, current.sourceSequence, current.snapshotId, current.snapshotSha256,
      storageKey, indexedETag, size] as const;
    const db = env.DELIVERY_DB.withSession("first-primary"), columns = Object.keys(fields);
    const insert = db.prepare(`INSERT OR IGNORE INTO ${TABLE}(${columns.join(",")})
      SELECT ${columns.map(() => "?").join(",")} FROM operations_portal_native_delivery_successor_candidates candidate
      JOIN file_index file ON file.r2_key=? AND file.etag=? AND file.size=? WHERE ${fence}`)
      .bind(...Object.values(fields), storageKey, indexedETag, size, ...bindings);
    const select = db.prepare(`SELECT event.event_id eventId,event.occurred_at occurredAt FROM ${TABLE} event
      JOIN operations_portal_native_delivery_successor_candidates candidate ON candidate.authority_id=event.authority_id
      JOIN file_index file ON file.r2_key=? AND file.etag=? AND file.size=?
      WHERE event.dedupe_key=? AND event.principal_fingerprint=? AND event.resource_fingerprint=? AND event.content_version_fingerprint=?
        AND event.effective_publication_operation_id=candidate.publication_operation_id
        AND event.chain_sha256=? AND ${fence}`)
      .bind(storageKey, indexedETag, size, dedupeKey, principalFingerprint, resourceFingerprint, contentVersionFingerprint,
        context.continuity.chainSha256, ...bindings);
    const [written, selectedResult] = await db.batch([insert, select]);
    const stored = selectedResult?.results[0] as { eventId: string; occurredAt: string } | undefined;
    if (!written?.success || !selectedResult?.success || !stored) return unavailable();
    const after = await authorizeWindowsPortalSuccessor(env, principal, authorityId);
    if (!after.ok || stable(after.successorContext) !== expectedContext || Date.parse(grant.expiresAt) <= Date.now()) return unavailable();
    return Object.freeze({ eventId: stored.eventId, occurredAt: stored.occurredAt, replayed: Number(written.meta.changes || 0) === 0 });
  } catch { return unavailable(); }
}
