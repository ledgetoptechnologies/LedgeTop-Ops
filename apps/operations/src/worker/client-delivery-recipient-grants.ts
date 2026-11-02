import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authorizeDeliveryFolderPrefix, decodeRef, encodeRef, normalizePrefix } from "./delivery";
import { hasPermission, requirePermission } from "./acl";
import { requireActivePrimaryWorkspaceBindingReceipt } from "./primary-delivery-workspace-bindings";
import { listClientDeliveryRecipients } from "./client-delivery-recipients";
import type { Env, StaffPrincipal } from "./types";

type App = Hono<{ Bindings: Env; Variables: { principal: StaffPrincipal; administrator: boolean } }>;
type Scope = "organization" | "client";
type Snapshot = { snapshotId: string; sourceSequence: number; snapshotSha256: string; directoryRecords: Array<{
  recordId: string; kind: "organization" | "client"; version: string; parentRecordId: string | null; relationshipVersion: string | null;
}> };
type Authority = { targetId: string; targetRevision: number; clientAuthorityId: string; workspaceId: string;
  rootKind: "organization" | "standalone_client"; rootRecordId: string; publicationRevision: number; sourceSequence: number;
  snapshotId: string; snapshotSha256: string; operationId: string; ackToken: string; acknowledgedClaimToken: string;
  checkpointId: string; currentCheckpointId: string; snapshotJson: string };
type Binding = { id: string; workspaceId: string; sourceId: string; ownerScopeType: Scope; ownerPublicId: string;
  r2Prefix: string; sourceVersion: string; receiptVersion: number; opsDivisionId: string; projectPublicId: null;
  rootType: Authority["rootKind"]; rootPublicId: string; rootRecordId: string };
type RecordRow = { record_id: string; record_kind: "client" | "organization"; current_version: number; display_name: string;
  organization_record_id: string | null; relationship_version: string | number | null; organization_version: number | null;
  organization_name: string | null };
type Recipient = { recipientId: string; recipientVersion: string; type: "client" | "organization"; displayName: string;
  organizationName: string | null; portal: { state: "ready" | "no_members" | "not_set_up" }; memberCount: number | null };
type WorkspacePins = { workspaceId: string; targetId: string; clientAuthorityId: string; targetRevision: number;
  publicationRevision: number; sourceId: string; snapshotId: string; snapshotSha256: string; workspaceVersion: string;
  membershipVersion: string; memberCount: number; portalReady: boolean };
type DirectGrant = { grantId: string; version: number; workspaceId: string; folderBindingId: string; recipientRecordId: string;
  ownerScopeType: Scope; ownerRecordId: string; bindingSourceVersion: string; bindingReceiptVersion: number;
  audience: "all_members"; status: "active" | "revoked" | "expired"; expiresAt: string | null;
  createdAt: string; revokedAt: string | null; canRevoke: boolean };
export type Resolved = { prefix: string; folderRef: string; binding: Binding; authority: Authority; snapshot: Snapshot;
  recipient: Recipient; record: RecordRow; workspace: WorkspacePins; recipientRecordId: string; canRevoke: boolean };
type Rpc = { readDirectFolderWorkspaceState(value: unknown): Promise<unknown>;
  listDirectWorkspaceFolderGrants(value: unknown): Promise<unknown>; applyDirectWorkspaceFolderGrant(value: unknown): Promise<unknown> };

const PRIMARY = "project-alpha:primary", VERSION = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const GRANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u, MAX_BINDINGS = 50;
const db = (value: D1Database) => value.withSession("first-primary");
const badRequest = (): never => { throw new HTTPException(400, { message: "Client folder sharing request is invalid" }); };
const conflict = (message = "Client or folder access changed. Refresh and review sharing again."): never => {
  throw new HTTPException(409, { message });
};
const unavailable = (): never => { throw new HTTPException(503, { message: "Client folder sharing is temporarily unavailable" }); };
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value), names = Object.keys(descriptors);
    if (Reflect.ownKeys(value).some(key => typeof key !== "string") || names.length !== keys.length
      || names.some(key => !keys.includes(key) || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(names.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}
function iso(value: unknown): string | null {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
}
function b64url(bytes: Uint8Array): string {
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
async function digest(value: unknown): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))));
}
async function deterministicUuid(value: unknown): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)))).slice(0, 16);
  bytes[6] = (bytes[6]! & 15) | 64; bytes[8] = (bytes[8]! & 63) | 128;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
}
function service(env: Env): Rpc {
  const binding = env.CLIENT_PORTAL_AUTHORITY_V2 as unknown as Rpc | undefined;
  if (!binding || typeof binding.readDirectFolderWorkspaceState !== "function"
    || typeof binding.listDirectWorkspaceFolderGrants !== "function" || typeof binding.applyDirectWorkspaceFolderGrant !== "function") return unavailable();
  return binding;
}
function rpcError(value: unknown): never {
  const row = exact(value, ["ok", "protocolVersion", "code", "retryable"]);
  if (!row || row.ok !== false || row.protocolVersion !== 1 || typeof row.code !== "string" || typeof row.retryable !== "boolean") return unavailable();
  if (row.code === "conflict" || row.code === "folder_not_bound") return conflict();
  if (row.code === "invalid") return badRequest();
  return unavailable();
}
function parseFolderRef(value: unknown): { folderRef: string; prefix: string } {
  if (typeof value !== "string" || value.length < 2 || value.length > 1400 || !/^[A-Za-z0-9_-]+$/u.test(value)) return badRequest();
  return { folderRef: value, prefix: normalizePrefix(decodeRef(value)) };
}
function parsePreviewBody(raw: unknown, withPreview = false) {
  const fields = ["folderRef", "recipientId", "recipientVersion", "audience", "expiresAt"].concat(withPreview ? ["previewVersion"] : []);
  const value = exact(raw, fields);
  if (!value || typeof value.folderRef !== "string" || value.folderRef.length > 1400
    || typeof value.recipientId !== "string" || value.recipientId.length > 200
    || typeof value.recipientVersion !== "string" || !/^crv_[A-Za-z0-9_-]{43}$/u.test(value.recipientVersion)
    || value.audience !== "all_members" || !(value.expiresAt === null || typeof value.expiresAt === "string")
    || (withPreview && (typeof value.previewVersion !== "string" || !/^cpv_[A-Za-z0-9_-]{43}$/u.test(value.previewVersion)))) return badRequest();
  const parsed = parseFolderRef(value.folderRef);
  if (value.expiresAt !== null && (iso(value.expiresAt) !== value.expiresAt || Date.parse(value.expiresAt) <= Date.now())) return badRequest();
  return { folderRef: parsed.folderRef, recipientId: value.recipientId, recipientVersion: value.recipientVersion,
    audience: "all_members" as const, expiresAt: value.expiresAt as string | null,
    ...(withPreview ? { previewVersion: value.previewVersion as string } : {}) };
}
function parseRevokeBody(raw: unknown): { expectedVersion: number } {
  const value = exact(raw, ["expectedVersion"]);
  if (!value || !Number.isSafeInteger(value.expectedVersion) || Number(value.expectedVersion) < 1) return badRequest();
  return { expectedVersion: Number(value.expectedVersion) };
}
function parseIdempotencyKey(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/u.test(value)) return badRequest();
  return value;
}

async function resolveFolder(env: Env, principal: StaffPrincipal, folderRef: string): Promise<string> {
  const prefix = parseFolderRef(folderRef).prefix;
  await authorizeDeliveryFolderPrefix(env, principal, prefix);
  let listed: R2Objects;
  try { listed = await env.DATA_BUCKET.list({ prefix, delimiter: "/", limit: 1 }); } catch { return unavailable(); }
  if (!listed.objects.length && !listed.delimitedPrefixes.length) throw new HTTPException(404, { message: "Folder not found" });
  // Ops profile sharing is an independent grant. A PA project mapping may
  // provide another sharing route, but it must not block direct client sharing.
  return prefix;
}
async function readRecord(env: Env, id: string): Promise<RecordRow> {
  try {
    const row = await db(env.OPS_DB).prepare(["SELECT record.record_id,record.record_kind,record.current_version,json_extract(revision.profile_json,'$.name') display_name,",
      "relation.organization_record_id,relation.relationship_version,parent.current_version organization_version,json_extract(parent_revision.profile_json,'$.name') organization_name",
      "FROM operations_directory_records record JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version",
      "LEFT JOIN operations_directory_lifecycle_state lifecycle ON lifecycle.record_id=record.record_id",
      "LEFT JOIN operations_directory_client_organizations relation ON relation.client_record_id=record.record_id",
      "LEFT JOIN operations_directory_records parent ON parent.record_id=relation.organization_record_id AND parent.record_kind='organization'",
      "LEFT JOIN operations_directory_revisions parent_revision ON parent_revision.record_id=parent.record_id AND parent_revision.version=parent.current_version",
      "LEFT JOIN operations_directory_lifecycle_state parent_lifecycle ON parent_lifecycle.record_id=parent.record_id",
      "WHERE record.record_id=? AND record.record_kind IN ('client','organization') AND coalesce(lifecycle.status,'active')='active'",
      "AND (relation.organization_record_id IS NULL OR (parent.record_id IS NOT NULL AND coalesce(parent_lifecycle.status,'active')='active'))"].join(" "))
      .bind(id).first<RecordRow>();
    if (!row || !Number.isSafeInteger(row.current_version) || row.current_version < 1 || typeof row.display_name !== "string"
      || !row.display_name.trim() || row.display_name.length > 160 || (row.record_kind === "organization" && row.organization_record_id !== null)
      || (row.organization_record_id !== null && (!Number.isSafeInteger(row.organization_version) || !row.organization_name)))
      return conflict("That client is no longer available for sharing.");
    return row;
  } catch (error) { if (error instanceof HTTPException) throw error; return unavailable(); }
}
function parseSnapshot(raw: string): Snapshot {
  try {
    const parsed = JSON.parse(raw) as Partial<Snapshot>;
    if (!parsed || typeof parsed.snapshotId !== "string" || !Number.isSafeInteger(parsed.sourceSequence)
      || typeof parsed.snapshotSha256 !== "string" || !VERSION.test(parsed.snapshotSha256)
      || !Array.isArray(parsed.directoryRecords) || parsed.directoryRecords.length > 1000) return unavailable();
    const directoryRecords = [];
    for (const item of parsed.directoryRecords) {
      const row = exact(item, ["recordId", "kind", "version", "parentRecordId", "relationshipVersion", "displayName", "externalFences"]);
      if (!row || typeof row.recordId !== "string" || !["client", "organization"].includes(String(row.kind))
        || typeof row.version !== "string" || !/^\d{1,12}$/u.test(row.version)
        || !(row.parentRecordId === null || typeof row.parentRecordId === "string")
        || !(row.relationshipVersion === null || typeof row.relationshipVersion === "string" || typeof row.relationshipVersion === "number")
        || typeof row.displayName !== "string" || !Array.isArray(row.externalFences)) return unavailable();
      directoryRecords.push({ recordId: row.recordId, kind: row.kind as "client" | "organization", version: row.version,
        parentRecordId: row.parentRecordId as string | null,
        relationshipVersion: row.relationshipVersion === null ? null : String(row.relationshipVersion) });
    }
    return { snapshotId: parsed.snapshotId, sourceSequence: Number(parsed.sourceSequence), snapshotSha256: parsed.snapshotSha256, directoryRecords };
  } catch (error) { if (error instanceof HTTPException) throw error; return unavailable(); }
}
async function readAuthority(env: Env, rootRecordId: string): Promise<Authority> {
  try {
    const row = await db(env.OPS_DB).prepare(["SELECT workspace.target_id,workspace.target_revision,workspace.client_authority_id,workspace.workspace_id,",
      "workspace.root_kind,workspace.root_record_id,publication.publication_revision,publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256,",
      "snapshot.snapshot_id snapshot_verified_id,snapshot.snapshot_json,publication.latest_operation_id operation_id,",
      "receipt.acknowledged_claim_token ack_token,outbox.acknowledged_claim_token acknowledged_claim_token,publication.checkpoint_id,current_checkpoint.checkpoint_id current_checkpoint_id",
      "FROM operations_portal_native_workspace_authority_heads workspace",
      "JOIN operations_portal_workspace_reservation_heads reservation ON reservation.target_id=workspace.target_id AND reservation.revision=workspace.target_revision",
      "AND reservation.client_authority_id=workspace.client_authority_id AND reservation.workspace_id=workspace.workspace_id AND reservation.root_kind=workspace.root_kind",
      "AND reservation.root_record_id=workspace.root_record_id AND reservation.state='active'",
      "JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=workspace.target_id AND publication.target_revision=workspace.target_revision",
      "AND publication.client_authority_id=workspace.client_authority_id AND publication.workspace_id=workspace.workspace_id AND publication.root_kind=workspace.root_kind",
      "AND publication.root_record_id=workspace.root_record_id",
      "JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id",
      "AND snapshot.operation_id=publication.latest_operation_id AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.publication_revision",
      "AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256",
      "JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=publication.latest_operation_id AND receipt.target_id=publication.target_id",
      "AND receipt.resulting_revision=publication.publication_revision AND receipt.source_sequence=publication.source_sequence AND receipt.snapshot_id=publication.snapshot_id",
      "AND receipt.snapshot_sha256=publication.snapshot_sha256",
      "JOIN operations_portal_workspace_publication_outbox outbox ON outbox.operation_id=publication.latest_operation_id AND outbox.target_id=publication.target_id",
      "AND outbox.state='acknowledged' AND outbox.acknowledged_claim_token=receipt.acknowledged_claim_token",
      "JOIN operations_portal_workspace_publication_current_checkpoints current_checkpoint ON current_checkpoint.checkpoint_id=publication.checkpoint_id",
      "WHERE workspace.root_record_id=? AND workspace.state='active' AND workspace.root_kind IN ('organization','standalone_client')",
      "AND publication.source_sequence=publication.publication_revision"].join(" ")).bind(rootRecordId).first<Record<string, unknown>>();
    if (!row || typeof row.snapshot_json !== "string" || row.snapshot_verified_id !== row.snapshot_id
      || row.checkpoint_id !== row.current_checkpoint_id || row.source_sequence !== row.publication_revision
      || row.ack_token !== row.acknowledged_claim_token || typeof row.ack_token !== "string" || !row.ack_token
      || typeof row.operation_id !== "string" || !row.operation_id) return conflict("The Client Workspace publication is not current and acknowledged.");
    if (typeof row.target_id !== "string" || !row.target_id || !Number.isSafeInteger(row.target_revision)
      || !UUID.test(String(row.client_authority_id)) || typeof row.workspace_id !== "string" || !row.workspace_id
      || !["organization", "standalone_client"].includes(String(row.root_kind)) || typeof row.root_record_id !== "string"
      || !Number.isSafeInteger(row.publication_revision) || !Number.isSafeInteger(row.source_sequence)
      || typeof row.snapshot_id !== "string" || typeof row.snapshot_sha256 !== "string" || !VERSION.test(row.snapshot_sha256)) return unavailable();
    const authority: Authority = { targetId: row.target_id, targetRevision: Number(row.target_revision),
      clientAuthorityId: String(row.client_authority_id), workspaceId: row.workspace_id, rootKind: row.root_kind as Authority["rootKind"],
      rootRecordId: row.root_record_id, publicationRevision: Number(row.publication_revision), sourceSequence: Number(row.source_sequence),
      snapshotId: row.snapshot_id, snapshotSha256: row.snapshot_sha256, operationId: String(row.operation_id),
      ackToken: String(row.ack_token), acknowledgedClaimToken: String(row.acknowledged_claim_token),
      checkpointId: String(row.checkpoint_id), currentCheckpointId: String(row.current_checkpoint_id), snapshotJson: row.snapshot_json };
    const snapshot = parseSnapshot(authority.snapshotJson);
    if (snapshot.snapshotId !== authority.snapshotId || snapshot.sourceSequence !== authority.sourceSequence
      || snapshot.snapshotSha256 !== authority.snapshotSha256) return conflict("The Client Workspace snapshot changed. Refresh and retry.");
    return authority;
  } catch (error) { if (error instanceof HTTPException) throw error; return unavailable(); }
}
async function readBinding(env: Env, prefix: string, authority: Authority): Promise<Binding> {
  try {
    const rows = await db(env.DELIVERY_DB).prepare(["SELECT binding.id,binding.workspace_id,workspace.project_alpha_source_id source_id,binding.owner_scope_type,",
      "binding.owner_public_id,binding.r2_prefix,binding.source_version,receipt.version receipt_version,receipt.ops_division_id,receipt.project_public_id,",
      "receipt.root_type,receipt.root_public_id,workspace.root_type workspace_root_type,workspace.root_record_id",
      "FROM portal_v2_folder_bindings binding JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'",
      "AND workspace.project_alpha_source_id='project-alpha:primary'",
      "JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id AND receipt.workspace_id=binding.workspace_id",
      "AND receipt.source_id='project-alpha:primary' AND receipt.state='active' AND receipt.ownership_kind='explicit_workspace'",
      "AND receipt.project_public_id IS NULL AND receipt.owner_scope_type IN ('organization','client') AND receipt.r2_prefix=binding.r2_prefix",
      "WHERE binding.workspace_id=? AND binding.r2_prefix=? AND binding.source_type='operations' AND binding.status='active'",
      "AND binding.revoked_at IS NULL AND binding.source_version IS NOT NULL LIMIT 2"].join(" "))
      .bind(authority.workspaceId, prefix).all<Binding & { workspace_root_type: string }>();
    if (rows.results.length !== 1) return conflict(rows.results.length ? "More than one active Client Workspace binding matches this folder." : "This folder is not explicitly linked to that client workspace.");
    const row = rows.results[0]!;
    if (row.sourceId !== PRIMARY || row.rootRecordId !== authority.rootRecordId || row.rootType !== authority.rootKind
      || row.workspace_root_type !== authority.rootKind || !row.id || !row.ownerPublicId || !row.sourceVersion
      || !Number.isSafeInteger(row.receiptVersion) || !row.opsDivisionId || row.projectPublicId !== null || row.r2Prefix !== prefix) return conflict();
    return row;
  } catch (error) { if (error instanceof HTTPException) throw error; return unavailable(); }
}
async function ownerRecordId(env: Env, binding: Binding): Promise<string> {
  try {
    const rows = await db(env.OPS_DB).prepare(["SELECT mapping.record_id FROM project_alpha_active_directory_mappings mapping",
      "JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=mapping.resource_type",
      "WHERE mapping.source_id='project-alpha:primary' AND mapping.resource_type=? AND mapping.project_alpha_public_id=? LIMIT 2"].join(" "))
      .bind(binding.ownerScopeType, binding.ownerPublicId).all<{ record_id: string }>();
    if (rows.results.length !== 1) return conflict("The Client Workspace owner mapping is missing or ambiguous.");
    return rows.results[0]!.record_id;
  } catch (error) { if (error instanceof HTTPException) throw error; return unavailable(); }
}
async function validateBinding(env: Env, principal: StaffPrincipal, binding: Binding): Promise<boolean> {
  const proof = await requireActivePrimaryWorkspaceBindingReceipt(env, binding.id, binding.r2Prefix);
  if (!proof || proof.ownershipMode !== "explicit_workspace" || proof.divisionId !== binding.opsDivisionId)
    return conflict("The explicit Client Workspace folder binding is no longer current.");
  await requirePermission(env, principal, "delivery.share.create", { divisionId: proof.divisionId }, true);
  return hasPermission(env, principal, "delivery.share.revoke", { divisionId: proof.divisionId });
}
export function publicationContains(authority: Authority, snapshot: Snapshot, record: RecordRow): boolean {
  const root = snapshot.directoryRecords.find(row => row.recordId === authority.rootRecordId);
  const target = snapshot.directoryRecords.find(row => row.recordId === record.record_id);
  const rootKind = authority.rootKind === "organization" ? "organization" : "client";
  if (!root || !target || root.kind !== rootKind || root.parentRecordId !== null
    || root.version !== String(record.organization_record_id ? record.organization_version : record.current_version)) return false;
  if (record.organization_record_id === null)
    return target.recordId === root.recordId && target.parentRecordId === null && target.version === String(record.current_version);
  return authority.rootKind === "organization" && record.organization_record_id === root.recordId
    && target.kind === "client" && target.parentRecordId === root.recordId && target.version === String(record.current_version)
    && target.relationshipVersion === String(record.relationship_version);
}
async function resolve(env: Env, principal: StaffPrincipal, folderRef: string, recipientId: string,
  expectedVersion: string, mustBeReady: boolean): Promise<Resolved> {
  const prefix = await resolveFolder(env, principal, folderRef), record = await readRecord(env, recipientId);
  const listed = await listClientDeliveryRecipients(env, principal, { folderRef, q: record.display_name, limit: 20 });
  const recipient = listed.recipients.find(row => row.recipientId === recipientId) as Recipient | undefined;
  if (!recipient) return conflict();
  if (recipient.recipientVersion !== expectedVersion || recipient.type !== record.record_kind
    || recipient.displayName !== record.display_name || recipient.organizationName !== record.organization_name) return conflict();
  if (mustBeReady && (recipient.portal.state !== "ready" || !Number.isSafeInteger(recipient.memberCount) || (recipient.memberCount ?? 0) < 1))
    return conflict("This client's portal needs at least one active member before folder sharing can be reviewed.");
  const authority = await readAuthority(env, record.organization_record_id ?? record.record_id);
  const snapshot = parseSnapshot(authority.snapshotJson);
  if (!publicationContains(authority, snapshot, record)) conflict("The selected client is not part of the current published workspace.");
  const binding = await readBinding(env, prefix, authority);
  const rootOwnerRecordId = await ownerRecordId(env, binding);
  if (rootOwnerRecordId !== authority.rootRecordId
    || binding.ownerScopeType !== (authority.rootKind === "organization" ? "organization" : "client")
    || (record.record_kind === "organization" && authority.rootRecordId !== recipientId))
    conflict("This folder is not explicitly bound to the selected client workspace.");
  const canRevoke = await validateBinding(env, principal, binding);
  const response = await service(env).readDirectFolderWorkspaceState({ protocolVersion: 1, workspaceId: authority.workspaceId,
    targetId: authority.targetId, clientAuthorityId: authority.clientAuthorityId, sourceId: binding.sourceId });
  const state = exact(response, ["ok", "protocolVersion", "workspaceId", "targetId", "clientAuthorityId", "targetRevision",
    "publicationRevision", "sourceId", "snapshotId", "snapshotSha256", "workspaceVersion", "membershipVersion", "memberCount", "portalReady"]);
  if (!state || state.ok !== true || state.protocolVersion !== 1) rpcError(response);
  if (state.workspaceId !== authority.workspaceId || state.targetId !== authority.targetId || state.clientAuthorityId !== authority.clientAuthorityId
    || state.targetRevision !== authority.targetRevision || state.publicationRevision !== authority.publicationRevision
    || state.sourceId !== binding.sourceId || state.snapshotId !== authority.snapshotId || state.snapshotSha256 !== authority.snapshotSha256
    || typeof state.workspaceVersion !== "string" || !VERSION.test(state.workspaceVersion)
    || typeof state.membershipVersion !== "string" || !VERSION.test(state.membershipVersion)
    || !Number.isSafeInteger(state.memberCount) || Number(state.memberCount) < 0 || typeof state.portalReady !== "boolean") conflict();
  if (mustBeReady && (state.portalReady !== true || Number(state.memberCount) < 1))
    conflict("This client's portal needs at least one active member before folder sharing can be reviewed.");
  return { prefix, folderRef, binding, authority, snapshot, recipient, record, workspace: state as unknown as WorkspacePins,
    recipientRecordId: recipientId, canRevoke };
}
function listInput(context: Resolved) {
  return { protocolVersion: 1, workspaceId: context.authority.workspaceId, targetId: context.authority.targetId,
    clientAuthorityId: context.authority.clientAuthorityId, sourceId: context.binding.sourceId, folderBindingId: context.binding.id,
    ownerScopeType: context.binding.ownerScopeType, ownerRecordId: context.binding.rootPublicId,
    recipientRecordId: context.recipientRecordId, expectedWorkspaceVersion: context.workspace.workspaceVersion,
    expectedMembershipVersion: context.workspace.membershipVersion };
}
function parseGrantList(value: unknown): { workspaceVersion: string; membershipVersion: string; memberCount: number;
  bindingSourceVersion: string; bindingReceiptVersion: number; grants: DirectGrant[] } {
  const row = exact(value, ["ok", "protocolVersion", "workspaceVersion", "membershipVersion", "memberCount", "bindingSourceVersion",
    "bindingReceiptVersion", "grants"]);
  if (!row || row.ok !== true || row.protocolVersion !== 1 || typeof row.workspaceVersion !== "string" || !VERSION.test(row.workspaceVersion)
    || typeof row.membershipVersion !== "string" || !VERSION.test(row.membershipVersion) || !Number.isSafeInteger(row.memberCount)
    || typeof row.bindingSourceVersion !== "string" || !Number.isSafeInteger(row.bindingReceiptVersion)
    || !Array.isArray(row.grants) || row.grants.length > 100) rpcError(value);
  const grants: DirectGrant[] = [];
  for (const raw of row.grants as unknown[]) {
    const grant = exact(raw, ["grantId", "version", "workspaceId", "folderBindingId", "recipientRecordId", "ownerScopeType",
      "ownerRecordId", "bindingSourceVersion", "bindingReceiptVersion", "audience", "status", "expiresAt", "createdAt", "revokedAt", "canRevoke"]);
    if (!grant || typeof grant.grantId !== "string" || !UUID.test(grant.grantId) || !Number.isSafeInteger(grant.version)
      || typeof grant.workspaceId !== "string" || typeof grant.folderBindingId !== "string" || typeof grant.recipientRecordId !== "string"
      || !["organization", "client"].includes(String(grant.ownerScopeType)) || typeof grant.ownerRecordId !== "string"
      || typeof grant.bindingSourceVersion !== "string" || !Number.isSafeInteger(grant.bindingReceiptVersion)
      || grant.audience !== "all_members" || !["active", "revoked", "expired"].includes(String(grant.status))
      || !(grant.expiresAt === null || iso(grant.expiresAt) !== null) || iso(grant.createdAt) === null
      || !(grant.revokedAt === null || iso(grant.revokedAt) !== null) || typeof grant.canRevoke !== "boolean") return unavailable();
    grants.push(grant as unknown as DirectGrant);
  }
  return { workspaceVersion: row.workspaceVersion, membershipVersion: row.membershipVersion, memberCount: Number(row.memberCount),
    bindingSourceVersion: row.bindingSourceVersion, bindingReceiptVersion: Number(row.bindingReceiptVersion), grants };
}
export function grantView(row: DirectGrant, recipient: Recipient, canRevoke: boolean) {
  const expiresAt = row.expiresAt === null ? null : iso(row.expiresAt);
  const status = row.status === "active" && expiresAt && Date.parse(expiresAt) <= Date.now() ? "expired" : row.status;
  return { grantId: row.grantId, version: row.version, recipientId: row.recipientRecordId, recipientLabel: recipient.displayName,
    recipientType: recipient.type, audienceLabel: "All current and future Client Workspace members",
    recipientCount: recipient.memberCount, status, expiresAt, updatedAt: iso(row.revokedAt) ?? iso(row.createdAt)!,
    canRevoke: canRevoke && status === "active" };
}
async function bindingsForFolder(env: Env, prefix: string): Promise<Binding[]> {
  try {
    const rows = await db(env.DELIVERY_DB).prepare(["SELECT binding.id,binding.workspace_id,workspace.project_alpha_source_id source_id,",
      "binding.owner_scope_type,binding.owner_public_id,binding.r2_prefix,binding.source_version,receipt.version receipt_version,receipt.ops_division_id,",
      "receipt.project_public_id,receipt.root_type,receipt.root_public_id,authority.root_record_id",
      "FROM portal_v2_folder_bindings binding JOIN portal_v2_workspaces workspace ON workspace.id=binding.workspace_id AND workspace.status='active'",
      "AND workspace.project_alpha_source_id='project-alpha:primary'",
      "JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id AND receipt.workspace_id=binding.workspace_id",
      "AND receipt.source_id='project-alpha:primary' AND receipt.state='active' AND receipt.ownership_kind='explicit_workspace'",
      "AND receipt.project_public_id IS NULL AND receipt.owner_scope_type IN ('organization','client') AND receipt.r2_prefix=binding.r2_prefix",
      "JOIN operations_portal_native_workspace_authority_heads authority ON authority.workspace_id=workspace.id",
      "AND authority.state='active' AND authority.root_kind=workspace.root_type",
      "WHERE binding.r2_prefix=? AND binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL",
      "AND binding.source_version IS NOT NULL ORDER BY binding.workspace_id LIMIT ?"].join(" "))
      .bind(prefix, MAX_BINDINGS + 1).all<Binding>();
    if (rows.results.length > MAX_BINDINGS) return unavailable();
    return rows.results;
  } catch { return unavailable(); }
}
async function listAll(env: Env, principal: StaffPrincipal, folderRef: string) {
  const prefix = await resolveFolder(env, principal, folderRef), bindings = await bindingsForFolder(env, prefix), grants = [];
  for (const binding of bindings) {
    const authority = await readAuthority(env, binding.rootRecordId);
    if (authority.workspaceId !== binding.workspaceId) conflict();
    const rootId = await ownerRecordId(env, binding), record = await readRecord(env, rootId);
    const rows = await listClientDeliveryRecipients(env, principal, { folderRef, q: record.display_name, limit: 20 });
    const recipient = rows.recipients.find(value => value.recipientId === rootId) as Recipient | undefined;
    if (!recipient || !publicationContains(authority, parseSnapshot(authority.snapshotJson), record)) return conflict();
    const context = await resolve(env, principal, folderRef, rootId, recipient.recipientVersion, false);
    const result = parseGrantList(await service(env).listDirectWorkspaceFolderGrants(listInput(context)));
    if (result.workspaceVersion !== context.workspace.workspaceVersion || result.membershipVersion !== context.workspace.membershipVersion
      || result.bindingSourceVersion !== binding.sourceVersion || result.bindingReceiptVersion !== binding.receiptVersion
      || result.grants.some(grant => grant.workspaceId !== binding.workspaceId || grant.folderBindingId !== binding.id
        || grant.ownerRecordId !== binding.rootPublicId || grant.ownerScopeType !== binding.ownerScopeType)) conflict();
    const canRevoke = await hasPermission(env, principal, "delivery.share.revoke", { divisionId: binding.opsDivisionId });
    for (const grant of result.grants) {
      const target = await readRecord(env, grant.recipientRecordId);
      if (!publicationContains(authority, parseSnapshot(authority.snapshotJson), target)) conflict("A shared client is no longer in the current published workspace.");
      const targetRows = await listClientDeliveryRecipients(env, principal, { folderRef, q: target.display_name, limit: 20 });
      const targetRecipient = targetRows.recipients.find(value => value.recipientId === grant.recipientRecordId) as Recipient | undefined;
      if (!targetRecipient) return conflict("A shared client is no longer available.");
      grants.push(grantView(grant, targetRecipient, canRevoke));
    }
  }
  return { grants };
}
export async function previewVersionForContext(context: Resolved, staffId: string, input: ReturnType<typeof parsePreviewBody>) {
  return "cpv_" + await digest({ v: 1, staff: staffId, folder: await digest(context.prefix),
    recipientVersion: input.recipientVersion, authority: [context.authority.targetId, context.authority.targetRevision,
      context.authority.clientAuthorityId, context.authority.workspaceId, context.authority.publicationRevision,
      context.authority.sourceSequence, context.authority.snapshotId, context.authority.snapshotSha256,
      context.authority.operationId, context.authority.ackToken, context.authority.checkpointId],
    membership: [context.workspace.workspaceVersion, context.workspace.membershipVersion, context.workspace.memberCount],
    binding: [context.binding.id, context.binding.sourceVersion, context.binding.receiptVersion,
      context.binding.ownerScopeType, context.binding.ownerPublicId, context.binding.opsDivisionId],
    record: [context.record.record_id, context.record.current_version, context.record.organization_record_id,
      context.record.relationship_version, context.record.organization_version], expiresAt: input.expiresAt });
}
export async function assertReviewedPreview(context: Resolved, staffId: string, input: ReturnType<typeof parsePreviewBody>, submitted: string) {
  if (await previewVersionForContext(context, staffId, input) !== submitted)
    conflict("Folder or Client Workspace access changed after review. Review sharing again.");
}
async function preview(env: Env, principal: StaffPrincipal, input: ReturnType<typeof parsePreviewBody>) {
  const context = await resolve(env, principal, input.folderRef, input.recipientId, input.recipientVersion, true);
  const previewVersion = await previewVersionForContext(context, principal.id, input);
  return { previewVersion, recipientId: context.recipient.recipientId, recipientLabel: context.recipient.displayName,
    audienceLabel: "All current and future Client Workspace members", recipientCount: context.workspace.memberCount, expiresAt: input.expiresAt };
}
async function createGrant(env: Env, principal: StaffPrincipal, input: ReturnType<typeof parsePreviewBody>, previewVersion: string, key: string) {
  const context = await resolve(env, principal, input.folderRef, input.recipientId, input.recipientVersion, true), client = service(env);
  await assertReviewedPreview(context, principal.id, input, previewVersion);
  const operationId = await deterministicUuid(["direct-folder-grant", principal.id, key, "create"]);
  const grantId = await deterministicUuid(["direct-folder-grant-id", principal.id, key, "create"]);
  const response = await client.applyDirectWorkspaceFolderGrant({ ...listInput(context), protocolVersion: 1, operationId,
    action: "grant.create", expectedBindingSourceVersion: context.binding.sourceVersion,
    expectedBindingReceiptVersion: context.binding.receiptVersion, grantId, expiresAt: input.expiresAt });
  const result = exact(response, ["ok", "protocolVersion", "operationId", "grantId", "version", "state", "replayed"]);
  if (!result || result.ok !== true || result.protocolVersion !== 1) rpcError(response);
  if (result.operationId !== operationId || result.grantId !== grantId || !Number.isSafeInteger(result.version)
    || result.state !== "active" || typeof result.replayed !== "boolean") return unavailable();
  const listing = parseGrantList(await client.listDirectWorkspaceFolderGrants(listInput(context)));
  const grant = listing.grants.find(value => value.grantId === grantId);
  if (!grant || grant.recipientRecordId !== input.recipientId || grant.version !== result.version || grant.status !== "active") return unavailable();
  return { grant: grantView(grant, context.recipient, context.canRevoke), replayed: result.replayed };
}
async function revokeGrant(env: Env, principal: StaffPrincipal, grantId: string, version: number, key: string) {
  if (!GRANT_ID.test(grantId)) badRequest();
  let locator: { workspace_id: string; binding_id: string; r2_prefix: string; source_id: string; target_id: string; client_authority_id: string;
    owner_scope_type: Scope; owner_record_id: string; recipient_record_id: string; root_record_id: string } | null;
  try {
    locator = await db(env.DELIVERY_DB).prepare(["SELECT grant_record.workspace_id,grant_record.folder_binding_id binding_id,binding.r2_prefix,",
      "grant_record.source_id,grant_record.target_id,grant_record.client_authority_id,grant_record.owner_scope_type,",
      "grant_record.owner_record_id,grant_record.recipient_record_id,authority.root_record_id",
      "FROM operations_portal_direct_folder_grants grant_record",
      "JOIN portal_v2_folder_bindings binding ON binding.id=grant_record.folder_binding_id AND binding.workspace_id=grant_record.workspace_id",
      "JOIN portal_primary_staff_bindings receipt ON receipt.binding_id=binding.id AND receipt.workspace_id=binding.workspace_id",
      "AND receipt.state='active' AND receipt.ownership_kind='explicit_workspace' AND receipt.project_public_id IS NULL",
      "JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id AND workspace.status='active'",
      "JOIN operations_portal_native_workspace_authority_heads authority ON authority.workspace_id=workspace.id AND authority.state='active'",
      "WHERE grant_record.grant_id=? AND binding.source_type='operations' AND binding.status='active' AND binding.revoked_at IS NULL",
      "AND receipt.source_id=grant_record.source_id AND receipt.r2_prefix=binding.r2_prefix",
      "AND grant_record.status IN ('active','revoked') LIMIT 2"].join(" "))
      .bind(grantId).first();
  } catch { return unavailable(); }
  if (!locator) return conflict("This share was not found or its folder authority is no longer active.");
  if (locator.source_id !== PRIMARY || !UUID.test(locator.client_authority_id)) return unavailable();
  const authority = await readAuthority(env, locator.root_record_id);
  if (authority.workspaceId !== locator.workspace_id || authority.targetId !== locator.target_id
    || authority.clientAuthorityId !== locator.client_authority_id) conflict();
  const folderRef = encodeRef(locator.r2_prefix.slice(0, -1));
  const binding = await readBinding(env, locator.r2_prefix, authority);
  if (binding.id !== locator.binding_id || binding.sourceId !== locator.source_id
    || binding.ownerScopeType !== locator.owner_scope_type || binding.rootPublicId !== locator.owner_record_id) conflict();
  const record = await readRecord(env, locator.recipient_record_id);
  const rows = await listClientDeliveryRecipients(env, principal, { folderRef, q: record.display_name, limit: 20 });
  const recipient = rows.recipients.find(value => value.recipientId === locator.recipient_record_id) as Recipient | undefined;
  if (!recipient) return conflict("The Client Workspace recipient is no longer available.");
  const context = await resolve(env, principal, folderRef, locator.recipient_record_id, recipient.recipientVersion, false);
  if (context.binding.id !== locator.binding_id) conflict();
  const client = service(env), input = listInput(context);
  const current = parseGrantList(await client.listDirectWorkspaceFolderGrants(input)).grants.find(value => value.grantId === grantId);
  if (!current || current.recipientRecordId !== locator.recipient_record_id || current.workspaceId !== locator.workspace_id
    || current.folderBindingId !== locator.binding_id || current.ownerRecordId !== locator.owner_record_id
    || current.ownerScopeType !== locator.owner_scope_type) conflict();
  await requirePermission(env, principal, "delivery.share.revoke", { divisionId: binding.opsDivisionId }, true);
  const operationId = await deterministicUuid(["direct-folder-grant", principal.id, key, "revoke"]);
  const response = await client.applyDirectWorkspaceFolderGrant({ ...input, protocolVersion: 1, operationId,
    action: "grant.revoke", expectedBindingSourceVersion: binding.sourceVersion,
    expectedBindingReceiptVersion: binding.receiptVersion, grantId, expectedGrantVersion: version });
  const result = exact(response, ["ok", "protocolVersion", "operationId", "grantId", "version", "state", "replayed"]);
  if (!result || result.ok !== true || result.protocolVersion !== 1) rpcError(response);
  if (result.operationId !== operationId || result.grantId !== grantId || result.version !== version + 1
    || result.state !== "revoked" || typeof result.replayed !== "boolean") return unavailable();
  const listing = parseGrantList(await client.listDirectWorkspaceFolderGrants(input));
  const revoked = listing.grants.find(value => value.grantId === grantId);
  if (!revoked || revoked.version !== result.version || revoked.status !== "revoked") return unavailable();
  return { grant: grantView(revoked, context.recipient, false), replayed: result.replayed };
}
export function registerClientDeliveryRecipientGrantRoutes(app: App): void {
  const base = "/api/delivery/client-recipients";
  app.get(base + "/grants", async c => {
    c.header("Cache-Control", "no-store");
    const url = new URL(c.req.url);
    if ([...url.searchParams.keys()].length !== 1 || !url.searchParams.has("folderRef") || url.searchParams.getAll("folderRef").length !== 1) return badRequest();
    return c.json(await listAll(c.env, c.get("principal"), parseFolderRef(url.searchParams.get("folderRef")).folderRef));
  });
  app.post(base + "/grants/preview", async c => {
    c.header("Cache-Control", "no-store"); let body: unknown; try { body = await c.req.json(); } catch { return badRequest(); }
    return c.json(await preview(c.env, c.get("principal"), parsePreviewBody(body)));
  });
  app.post(base + "/grants", async c => {
    c.header("Cache-Control", "no-store"); let body: unknown; try { body = await c.req.json(); } catch { return badRequest(); }
    const input = parsePreviewBody(body, true);
    return c.json(await createGrant(c.env, c.get("principal"), input, input.previewVersion!, parseIdempotencyKey(c.req.header("Idempotency-Key"))));
  });
  app.post(base + "/grants/:grantId/revoke", async c => {
    c.header("Cache-Control", "no-store"); let body: unknown; try { body = await c.req.json(); } catch { return badRequest(); }
    const input = parseRevokeBody(body);
    const grantId = c.req.param("grantId"); if (!grantId) return badRequest();
    return c.json(await revokeGrant(c.env, c.get("principal"), grantId,
      input.expectedVersion, parseIdempotencyKey(c.req.header("Idempotency-Key"))));
  });
}
export { deterministicUuid, parseFolderRef, parseIdempotencyKey, parsePreviewBody, parseRevokeBody };
