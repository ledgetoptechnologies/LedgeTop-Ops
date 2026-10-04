import { canonicalOperationsPortalNativeDeliveryAuthorityCommand,
  sha256OperationsPortalNativeDeliveryAuthorityCommand,
  type OperationsPortalNativeDeliveryFeature } from "@ltds/shared/operations-portal-native-delivery-authority";
import { isHiddenKey, validateRelativePath } from "../files";
import { d1TablesPresent } from "../schema-readiness";
import { hmac, sha256 } from "../security";
import type { NativeOperationsDeliveryContext } from "./operations-native-delivery-authorization";
import type { VerifiedClientPrincipal } from "./types";

const TABLE = "operations_portal_native_content_start_events";
const OBJECTS = ["operations_portal_native_content_start_timeline",
  "operations_portal_native_content_start_insert_guard", "operations_portal_native_content_start_no_update",
  "operations_portal_native_content_start_no_delete"] as const;
const WINDOW_MS = 10 * 60 * 1000;
const CANONICAL_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export type OperationsNativeContentAuditEnv = Readonly<{
  DELIVERY_DB: D1Database;
  ENVIRONMENT?: string;
  CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET?: string;
}>;
export type OperationsNativeContentStartInput = Readonly<{
  principal: Pick<VerifiedClientPrincipal, "issuer" | "subject">;
  context: NativeOperationsDeliveryContext;
  action: "file.preview_requested" | "file.download_requested";
  feature: Extract<OperationsPortalNativeDeliveryFeature, "file.preview" | "file.download">;
  storageKey: string;
  contentVersion: string;
}>;

export class OperationsNativeContentAuditUnavailableError extends Error {
  readonly code = "OPERATIONS_NATIVE_CONTENT_AUDIT_UNAVAILABLE";
  constructor(readonly reason: "disabled" | "configuration_invalid" | "schema_missing" | "schema_incomplete" | "authority_stale") {
    super(`Operations native content audit is unavailable: ${reason}`);
    this.name = "OperationsNativeContentAuditUnavailableError";
  }
}

function unavailable(reason: OperationsNativeContentAuditUnavailableError["reason"]): never {
  throw new OperationsNativeContentAuditUnavailableError(reason);
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}
async function ready(env: OperationsNativeContentAuditEnv) {
  if (env.ENVIRONMENT !== "staging" || env.CLIENT_PORTAL_ORIGIN !== "https://client-staging.ledgetopdroneservices.com"
    || env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_ENABLED !== "true") unavailable("disabled");
  if (!bounded(env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET, 4096)
    || env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET.length < 32) unavailable("configuration_invalid");
  if (!await d1TablesPresent(env.DELIVERY_DB, [TABLE])) unavailable("schema_missing");
  try {
    const names = (await env.DELIVERY_DB.withSession("first-primary").prepare(
      `SELECT name FROM sqlite_master WHERE name IN (${OBJECTS.map(() => "?").join(",")}) ORDER BY name`,
    ).bind(...OBJECTS).all<{ name: string }>()).results.map(row => row.name);
    if (JSON.stringify(names) !== JSON.stringify([...OBJECTS].sort())) unavailable("schema_incomplete");
  } catch (error) {
    if (error instanceof OperationsNativeContentAuditUnavailableError) throw error;
    unavailable("schema_incomplete");
  }
  return env.CLIENT_PORTAL_OPERATIONS_NATIVE_CONTENT_AUDIT_HMAC_SECRET;
}

export async function appendOperationsNativeContentStart(env: OperationsNativeContentAuditEnv,
  input: OperationsNativeContentStartInput, now = new Date()) {
  const secret = await ready(env), command = input.context?.command;
  if (!command || command.action !== "delivery.grant" || !bounded(input.principal?.issuer, 512)
    || !bounded(input.principal?.subject, 512) || command.recipient.issuer !== input.principal.issuer
    || command.recipient.subject !== input.principal.subject
    || (input.action === "file.preview_requested" ? input.feature !== "file.preview" : input.feature !== "file.download")
    || !command.features.includes(input.feature) || !command.expiresAt || Date.parse(command.expiresAt) <= Date.now()
    || !bounded(input.storageKey, 1024) || input.storageKey.includes("\\") || input.storageKey.includes("//")
    || !input.storageKey.startsWith(command.resource.selectedR2Prefix)
    || input.storageKey === command.resource.selectedR2Prefix || isHiddenKey(input.storageKey)
    || !bounded(input.contentVersion, 1024) || !Number.isFinite(now.getTime())) unavailable("authority_stale");
  try { validateRelativePath(input.storageKey.slice(command.resource.selectedR2Prefix.length)); }
  catch { unavailable("authority_stale"); }
  const canonical = canonicalOperationsPortalNativeDeliveryAuthorityCommand(command);
  if (await sha256OperationsPortalNativeDeliveryAuthorityCommand(command) !== input.context.requestFingerprint)
    unavailable("authority_stale");
  const occurredAt = now.toISOString(); if (!CANONICAL_TIME.test(occurredAt)) unavailable("authority_stale");
  const principalFingerprint = await hmac(secret, `operations-native-content:principal:v1\0${input.principal.issuer}\0${input.principal.subject}`);
  const prefixFingerprint = await hmac(secret, `operations-native-content:prefix:v1\0${command.resource.selectedR2Prefix}`);
  const resourceFingerprint = await hmac(secret, `operations-native-content:resource:v1\0${prefixFingerprint}\0${input.storageKey}`);
  const contentVersionFingerprint = await hmac(secret,
    `operations-native-content:version:v1\0${resourceFingerprint}\0${input.contentVersion}`);
  const dedupeWindow = Math.floor(now.getTime() / WINDOW_MS);
  const dedupeKey = await sha256(JSON.stringify(["operations-native-content-start:v1", input.action, input.feature,
    principalFingerprint, command.authority.authorityId, command.authority.resultingRevision, command.operationId,
    input.context.requestFingerprint, resourceFingerprint, contentVersionFingerprint, dedupeWindow]));
  const eventId = `operations-native-content-${dedupeKey}`;
  const pins = [command.authority.authorityId, Number(command.authority.resultingRevision), command.operationId,
    input.context.requestFingerprint, command.recipient.recipientBindingId, command.target.targetId,
    command.target.workspaceId, Number(command.recipient.homeOwnershipEpoch), Number(command.recipient.homeGrantRevision),
    command.recipient.homeGrantOperationId, command.recipient.homeRequestFingerprint, command.publication.operationId,
    command.publication.publicationId, Number(command.publication.revision), command.publication.snapshotId,
    command.publication.snapshotSha256, command.resource.folderReservationId,
    Number(command.resource.folderReservationRevision), command.resource.clientFolderBindingId,
    command.resource.externalProjectId, Number(command.resource.projectVersion)] as const;
  const fence = `live.authority_id=? AND live.revision=? AND live.latest_operation_id=?
    AND live.request_fingerprint=? AND live.recipient_binding_id=? AND live.target_id=?
    AND json_extract(live.canonical_command_json,'$.target.workspaceId')=?
    AND CAST(json_extract(live.canonical_command_json,'$.recipient.homeOwnershipEpoch') AS INTEGER)=?
    AND CAST(json_extract(live.canonical_command_json,'$.recipient.homeGrantRevision') AS INTEGER)=?
    AND json_extract(live.canonical_command_json,'$.recipient.homeGrantOperationId')=?
    AND json_extract(live.canonical_command_json,'$.recipient.homeRequestFingerprint')=?
    AND json_extract(live.canonical_command_json,'$.publication.operationId')=?
    AND json_extract(live.canonical_command_json,'$.publication.publicationId')=?
    AND CAST(json_extract(live.canonical_command_json,'$.publication.revision') AS INTEGER)=?
    AND json_extract(live.canonical_command_json,'$.publication.snapshotId')=?
    AND json_extract(live.canonical_command_json,'$.publication.snapshotSha256')=?
    AND live.folder_reservation_id=?
    AND CAST(json_extract(live.canonical_command_json,'$.resource.folderReservationRevision') AS INTEGER)=?
    AND json_extract(live.canonical_command_json,'$.resource.clientFolderBindingId')=?
    AND json_extract(live.canonical_command_json,'$.resource.externalProjectId')=?
    AND CAST(json_extract(live.canonical_command_json,'$.resource.projectVersion') AS INTEGER)=?
    AND live.canonical_command_json=?
    AND json_extract(live.canonical_command_json,'$.recipient.issuer')=?
    AND json_extract(live.canonical_command_json,'$.recipient.subject')=?
    AND EXISTS(SELECT 1 FROM json_each(live.canonical_command_json,'$.features') WHERE value=?)
    AND file.r2_key=? AND file.etag=?
    AND substr(file.r2_key,1,length(json_extract(live.canonical_command_json,'$.resource.selectedR2Prefix')))
      =json_extract(live.canonical_command_json,'$.resource.selectedR2Prefix')
    AND NOT EXISTS(SELECT 1 FROM delivery_tombstones tombstone WHERE tombstone.restored_at IS NULL
      AND (tombstone.physical_key=file.r2_key OR (tombstone.tombstone_kind='prefix'
        AND substr(file.r2_key,1,length(tombstone.physical_key))=tombstone.physical_key)))`;
  const fenceBindings = [...pins, canonical, input.principal.issuer, input.principal.subject, input.feature,
    input.storageKey, input.contentVersion] as const;
  const database = env.DELIVERY_DB.withSession("first-primary");
  const insert = database.prepare(`INSERT OR IGNORE INTO ${TABLE}(
    event_id,dedupe_key,dedupe_window,action,feature,principal_fingerprint,authority_id,authority_revision,
    delivery_operation_id,delivery_request_fingerprint,recipient_binding_id,target_id,workspace_id,
    home_ownership_epoch,home_grant_revision,home_grant_operation_id,home_request_fingerprint,
    publication_operation_id,publication_id,publication_revision,publication_snapshot_id,publication_snapshot_sha256,
    folder_reservation_id,folder_reservation_revision,client_folder_binding_id,external_project_id,project_version,
    prefix_fingerprint,resource_fingerprint,content_version_fingerprint,occurred_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
    FROM operations_portal_native_delivery_live_heads live JOIN file_index file ON file.r2_key=? AND file.etag=?
    WHERE ${fence}`).bind(eventId, dedupeKey, dedupeWindow, input.action, input.feature, principalFingerprint,
      ...pins, prefixFingerprint, resourceFingerprint, contentVersionFingerprint, occurredAt,
      input.storageKey, input.contentVersion, ...fenceBindings);
  const select = database.prepare(`SELECT event.event_id eventId,event.occurred_at occurredAt
    FROM ${TABLE} event
    JOIN operations_portal_native_delivery_live_heads live ON live.authority_id=event.authority_id
      AND live.revision=event.authority_revision AND live.latest_operation_id=event.delivery_operation_id
      AND live.request_fingerprint=event.delivery_request_fingerprint
    JOIN file_index file ON file.r2_key=? AND file.etag=?
    WHERE event.dedupe_key=? AND event.principal_fingerprint=? AND event.prefix_fingerprint=?
      AND event.resource_fingerprint=? AND event.content_version_fingerprint=? AND ${fence}`)
    .bind(input.storageKey, input.contentVersion, dedupeKey, principalFingerprint, prefixFingerprint,
      resourceFingerprint, contentVersionFingerprint, ...fenceBindings);
  try {
    const [written, selected] = await database.batch([insert, select]);
    if (!written || !selected) unavailable("authority_stale");
    const stored = (selected.results as Array<{ eventId: string; occurredAt: string }>)[0];
    if (!stored) unavailable("authority_stale");
    return Object.freeze({ ...stored, replayed: Number(written.meta.changes || 0) === 0 });
  } catch (error) {
    if (error instanceof OperationsNativeContentAuditUnavailableError) throw error;
    unavailable("authority_stale");
  }
}
