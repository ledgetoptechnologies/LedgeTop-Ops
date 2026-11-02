import type { Env } from "./types";
import { d1TablesPresent } from "./schema-readiness";
import { sha256Hex } from "./security";

type DatabaseEnv = Pick<Env, "DELIVERY_DB" | "CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED">;
const directFolderGrantsEnabled = (env: DatabaseEnv) => env.CLIENT_PORTAL_DIRECT_FOLDER_GRANTS_ENABLED?.trim().toLowerCase() !== "false";
type Action = "grant.create" | "grant.revoke";
type SnapshotRecord = { recordId?: unknown; kind?: unknown; parentRecordId?: unknown };
type Snapshot = { snapshotId?: unknown; sourceSequence?: unknown; snapshotSha256?: unknown; directoryRecords?: unknown };
type WorkspaceState = {
  workspaceId: string; targetId: string; clientAuthorityId: string; targetRevision: number;
  publicationRevision: number; sourceId: string; snapshotId: string; snapshotSha256: string;
  rootKind: string; rootRecordId: string; rootPublicId: string; workspaceVersion: string; membershipVersion: string; memberCount: number; snapshot: Snapshot;
};
type GrantRow = { grant_id: string; grant_version: number; workspace_id: string; target_id: string;
  client_authority_id: string; target_revision: number; publication_revision: number; publication_snapshot_id: string;
  publication_snapshot_sha256: string; source_id: string; folder_ref: string;
  owner_scope_type: "organization" | "client"; owner_record_id: string;
  recipient_record_id: string; status: "active" | "revoked" | "expired"; expires_at: string | null;
  created_at: string; revoked_at: string | null };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/u;
const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_PREFIX = /^Jobs\/Clients\//u;
const fail = (code: "disabled" | "invalid" | "conflict" | "folder_not_bound" | "workspace_unavailable" | "temporarily_unavailable") =>
  ({ ok: false as const, protocolVersion: 1 as const, code, retryable: code === "temporarily_unavailable" || code === "workspace_unavailable" });
const validText = (value: unknown, max = 200): value is string => typeof value === "string" && value.length > 0
  && value.length <= max && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value);
const session = (env: DatabaseEnv) => env.DELIVERY_DB.withSession("first-primary");
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const validInstant = (value: unknown): value is string => typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value));

function plain(input: unknown, fields: readonly string[]): Record<string, unknown> | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.getPrototypeOf(input) !== Object.prototype) return null;
    if (Reflect.ownKeys(input).some(key => typeof key !== "string")) return null;
    const descriptors = Object.getOwnPropertyDescriptors(input), keys = Object.keys(descriptors);
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key) || !("value" in descriptors[key]!))) return null;
    return Object.fromEntries(keys.map(key => [key, descriptors[key]!.value]));
  } catch { return null; }
}

function safePrefix(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 14 || value.length > 1000 || !value.endsWith("/")
    || !SAFE_PREFIX.test(value) || value !== value.normalize("NFC") || value.includes("\\")
    || value.includes("//") || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  const parts = value.slice(0, -1).split("/");
  return parts.every(part => part.length > 0 && part !== "." && part !== ".." && part.length <= 255);
}
function folderRefPrefix(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 2 || value.length > 1400 || !/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=")), ch => ch.charCodeAt(0));
    const canonical = btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
    if (canonical !== value) return null;
    const path = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return safePrefix(`${path}/`) ? `${path}/` : null;
  } catch { return null; }
}

function parseSnapshot(raw: string): Snapshot | null {
  try {
    const value = JSON.parse(raw) as Snapshot;
    if (!value || typeof value !== "object" || !Array.isArray(value.directoryRecords)
      || !validText(value.snapshotId, 200) || !positive(value.sourceSequence) || !SHA256.test(String(value.snapshotSha256))) return null;
    return value;
  } catch { return null; }
}

function matchingDirectory(snapshot: Snapshot, input: { rootKind: string; rootRecordId: string; recipientRecordId: string }): boolean {
  const records = snapshot.directoryRecords as SnapshotRecord[];
  const get = (id: string) => records.find(record => record.recordId === id);
  const root = get(input.rootRecordId);
  if (!root || root.parentRecordId !== null) return false;
  const recipient = get(input.recipientRecordId);
  if (!recipient) return false;
  const rootDirectoryKind = input.rootKind === "organization" ? "organization" : "client";
  if (root.kind !== rootDirectoryKind) return false;
  if (input.rootKind === "standalone_client") return recipient.recordId === input.rootRecordId
    && recipient.kind === "client" && recipient.parentRecordId === null;
  return recipient.recordId === input.rootRecordId
    ? recipient.kind === "organization" && recipient.parentRecordId === null
    : recipient.kind === "client" && recipient.parentRecordId === input.rootRecordId;
}

async function tableReady(env: DatabaseEnv): Promise<boolean> {
  return d1TablesPresent(env.DELIVERY_DB, ["operations_portal_direct_folder_grants",
    "operations_portal_direct_folder_grant_mutations", "operations_portal_direct_folder_grant_audit",
    "operations_portal_native_workspace_authority_heads", "operations_portal_workspace_publication_heads",
    "operations_portal_workspace_publication_snapshots", "operations_portal_workspace_publication_receipts",
    "portal_v2_workspaces",
    "portal_v2_directory_checkpoints","portal_v2_directory_generations","portal_v2_directory_entities",
    "pa_portal_projection_checkpoints","pa_portal_projection_generations",
    "portal_v2_workspace_memberships", "portal_v2_identities"]);
}

async function workspaceState(env: DatabaseEnv, input: { workspaceId: string; targetId: string;
  clientAuthorityId: string; sourceId: string }): Promise<WorkspaceState | null> {
  if (!OPAQUE.test(input.workspaceId) || !OPAQUE.test(input.targetId) || !UUID.test(input.clientAuthorityId)
    || !SOURCE.test(input.sourceId) || !await tableReady(env)) return null;
  const db = session(env);
  const row = await db.prepare(`SELECT authority.target_id,authority.target_revision,authority.client_authority_id,
      authority.workspace_id,authority.root_kind,authority.root_record_id,workspace.root_type,COALESCE(workspace.pa_organization_public_id,workspace.pa_client_public_id) root_public_id,publication.revision publication_revision,
      publication.source_sequence,publication.snapshot_id,publication.snapshot_sha256,snapshot.snapshot_json,
      workspace.project_alpha_source_id,workspace.status
    FROM operations_portal_native_workspace_authority_heads authority
    JOIN operations_portal_workspace_publication_heads publication ON publication.target_id=authority.target_id
      AND publication.target_revision=authority.target_revision AND publication.client_authority_id=authority.client_authority_id
      AND publication.workspace_id=authority.workspace_id
    JOIN operations_portal_workspace_publication_receipts receipt ON receipt.operation_id=publication.latest_operation_id
      AND receipt.target_id=publication.target_id AND receipt.resulting_revision=publication.revision
      AND receipt.snapshot_id=publication.snapshot_id AND receipt.snapshot_sha256=publication.snapshot_sha256
    JOIN operations_portal_workspace_publication_snapshots snapshot ON snapshot.snapshot_id=publication.snapshot_id
      AND snapshot.target_id=publication.target_id AND snapshot.revision=publication.revision
      AND snapshot.source_sequence=publication.source_sequence AND snapshot.snapshot_sha256=publication.snapshot_sha256
    JOIN portal_v2_workspaces workspace ON workspace.id=authority.workspace_id AND workspace.status='active'
      AND workspace.project_alpha_source_id=?
    JOIN pa_portal_workspace_sources source ON source.workspace_id=workspace.id AND source.projection_source_id=?
    WHERE authority.target_id=? AND authority.workspace_id=? AND authority.client_authority_id=? AND authority.state='active'`)
    .bind(input.sourceId, input.sourceId, input.targetId, input.workspaceId, input.clientAuthorityId)
    .first<{ target_id:string;target_revision:number;client_authority_id:string;workspace_id:string;root_kind:string;root_record_id:string;
      root_type:string;root_public_id:string;publication_revision:number;source_sequence:number;snapshot_id:string;snapshot_sha256:string;snapshot_json:string;
      project_alpha_source_id:string;status:string }>();
  if (!row || !positive(row.target_revision) || !positive(row.publication_revision) || !positive(row.source_sequence)
    || !SHA256.test(row.snapshot_sha256) || row.project_alpha_source_id !== input.sourceId
    || row.root_kind !== row.root_type || !validText(row.root_public_id,512)) return null;
  const snapshot = parseSnapshot(row.snapshot_json);
  if (!snapshot || snapshot.snapshotId !== row.snapshot_id || snapshot.snapshotSha256 !== row.snapshot_sha256
    || snapshot.sourceSequence !== row.source_sequence) return null;
  const members = await db.prepare(`SELECT identity.id,identity.status,identity.revoked_at,membership.source_type,
      membership.source_version,membership.expires_at
    FROM portal_v2_workspace_memberships membership JOIN portal_v2_identities identity ON identity.id=membership.identity_id
    WHERE membership.workspace_id=? AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
      AND identity.status='active' AND identity.revoked_at IS NULL ORDER BY identity.id LIMIT 1001`)
    .bind(input.workspaceId).all<{id:string;status:string;revoked_at:string|null;source_type:string;source_version:string|null;expires_at:string|null}>();
  const live = members.results;
  if(live.length>1000)return null;
  const workspaceVersion = await sha256Hex(JSON.stringify(["direct-folder-workspace-v1",row.target_id,row.target_revision,
    row.client_authority_id,row.workspace_id,row.publication_revision,row.source_sequence,row.snapshot_id,row.snapshot_sha256,input.sourceId]));
  const membershipVersion = await sha256Hex(JSON.stringify(["direct-folder-members-v1",input.workspaceId,
    live.map(member=>[member.id,member.source_type,member.source_version,member.expires_at])]));
  return { workspaceId:row.workspace_id,targetId:row.target_id,clientAuthorityId:row.client_authority_id,
    targetRevision:row.target_revision,publicationRevision:row.publication_revision,sourceId:input.sourceId,
    snapshotId:row.snapshot_id,snapshotSha256:row.snapshot_sha256,rootKind:row.root_kind,rootRecordId:row.root_record_id,rootPublicId:row.root_public_id,workspaceVersion,membershipVersion,
    memberCount:live.length,snapshot };
}

function commonState(value: Record<string,unknown>) {
  return { workspaceId:value.workspaceId as string,targetId:value.targetId as string,
    clientAuthorityId:value.clientAuthorityId as string,sourceId:value.sourceId as string };
}

function requestFingerprint(value: Record<string,unknown>,fields:readonly string[]): Promise<string> {
  return sha256Hex(JSON.stringify(["ops-direct-folder-grant-v1",fields.map(field=>[field,value[field]])]));
}
function grantView(row: GrantRow) {
  const r2Prefix=folderRefPrefix(row.folder_ref);if(!r2Prefix)throw new Error("direct-folder-reference-invalid");
  return { grantId:row.grant_id,version:row.grant_version,workspaceId:row.workspace_id,
  r2Prefix,recipientRecordId:row.recipient_record_id,ownerScopeType:row.owner_scope_type,
  ownerRecordId:row.owner_record_id,
  audience:"all_members" as const,status:row.status,expiresAt:row.expires_at,
  createdAt:row.created_at,revokedAt:row.revoked_at,canRevoke:row.status==="active" }; }

/** Read-only, private service-binding method. It returns no identity details or paths. */
export async function readDirectFolderWorkspaceState(env:DatabaseEnv,raw:unknown){
  if(!directFolderGrantsEnabled(env))return fail("disabled");
  const value=plain(raw,["protocolVersion","workspaceId","targetId","clientAuthorityId","sourceId"]);
  if(!value||value.protocolVersion!==1||!validText(value.workspaceId)||!validText(value.targetId)
    ||!UUID.test(String(value.clientAuthorityId))||!SOURCE.test(String(value.sourceId)))return fail("invalid");
  try{
    const state=await workspaceState(env,commonState(value));if(!state)return fail("workspace_unavailable");
    return {ok:true as const,protocolVersion:1 as const,workspaceId:state.workspaceId,targetId:state.targetId,
      clientAuthorityId:state.clientAuthorityId,targetRevision:state.targetRevision,publicationRevision:state.publicationRevision,
      sourceId:state.sourceId,snapshotId:state.snapshotId,snapshotSha256:state.snapshotSha256,
      workspaceVersion:state.workspaceVersion,membershipVersion:state.membershipVersion,memberCount:state.memberCount,
      portalReady:state.memberCount>0};
  }catch{return fail("temporarily_unavailable");}
}

/** List direct Ops grants for one exact folder/profile pair; never substitutes an empty list on database failure. */
export async function listDirectWorkspaceFolderGrants(env:DatabaseEnv,raw:unknown){
  if(!directFolderGrantsEnabled(env))return fail("disabled");
  const value=plain(raw,["protocolVersion","workspaceId","targetId","clientAuthorityId","sourceId","folderRef",
    "expectedWorkspaceVersion","expectedMembershipVersion"]);
  if(!value||value.protocolVersion!==1||!validText(value.workspaceId)||!validText(value.targetId)
    ||!UUID.test(String(value.clientAuthorityId))||!SOURCE.test(String(value.sourceId))||!folderRefPrefix(value.folderRef)
    ||!SHA256.test(String(value.expectedWorkspaceVersion))
    ||!SHA256.test(String(value.expectedMembershipVersion)))return fail("invalid");
  try{
    const state=await workspaceState(env,commonState(value));if(!state)return fail("workspace_unavailable");
    if(state.workspaceVersion!==value.expectedWorkspaceVersion)return fail("conflict");
    if(state.membershipVersion!==value.expectedMembershipVersion)return fail("conflict");
    const ownerScopeType=state.rootKind==="organization"?"organization":"client";
    const rows=await session(env).prepare(`SELECT grant_id,grant_version,workspace_id,target_id,client_authority_id,
      target_revision,publication_revision,publication_snapshot_id,publication_snapshot_sha256,source_id,folder_ref,
      owner_scope_type,owner_record_id,recipient_record_id,status,expires_at,
      created_at,revoked_at FROM operations_portal_direct_folder_grants WHERE workspace_id=? AND folder_ref=?
      ORDER BY created_at DESC,grant_id LIMIT 101`).bind(value.workspaceId,value.folderRef).all<GrantRow>();
    if(rows.results.length>100)return fail("temporarily_unavailable");
    if(rows.results.some(row=>row.owner_scope_type!==ownerScopeType||row.owner_record_id!==state.rootPublicId
      ||!matchingDirectory(state.snapshot,{rootKind:state.rootKind,rootRecordId:state.rootRecordId,recipientRecordId:row.recipient_record_id})))return fail("conflict");
    const now=Date.now(),grants=rows.results.map(row=>grantView({...row,
      status:row.status==="active"&&row.expires_at&&Date.parse(row.expires_at)<=now?"expired":row.status}));
    const fresh=await workspaceState(env,commonState(value));
    if(!fresh||fresh.workspaceVersion!==state.workspaceVersion||fresh.membershipVersion!==state.membershipVersion)return fail("conflict");
    return {ok:true as const,protocolVersion:1 as const,workspaceVersion:state.workspaceVersion,
      membershipVersion:state.membershipVersion,memberCount:state.memberCount,grants};
  }catch{return fail("temporarily_unavailable");}
}

/** Idempotent, CAS-protected grant create/revoke. Folder authority is an exact
 * canonical Ops path; recipient authority comes from the acknowledged snapshot. */
export async function applyDirectWorkspaceFolderGrant(env:DatabaseEnv,raw:unknown){
  if(!directFolderGrantsEnabled(env))return fail("disabled");
  const value=raw&&typeof raw==="object"&&!Array.isArray(raw)?raw as Record<string,unknown>:null;
  if(!value)return fail("invalid");
  const action=value.action;
  const commonFields=["protocolVersion","operationId","action","workspaceId","targetId","clientAuthorityId","sourceId",
    "folderRef","recipientRecordId","expectedWorkspaceVersion",
    "expectedMembershipVersion","grantId"] as const;
  const fields=action==="grant.create"?[...commonFields,"expiresAt"]:action==="grant.revoke"?[...commonFields,"expectedGrantVersion"]:[];
  const request=plain(raw,fields);
  if(!request||request.protocolVersion!==1||!validText(request.operationId)||!validText(request.workspaceId)
    ||!validText(request.targetId)||!UUID.test(String(request.clientAuthorityId))||!SOURCE.test(String(request.sourceId))
    ||!folderRefPrefix(request.folderRef)
    ||!validText(request.recipientRecordId)||!SHA256.test(String(request.expectedWorkspaceVersion))
    ||!SHA256.test(String(request.expectedMembershipVersion))
    ||!UUID.test(String(request.grantId))
    ||(action==="grant.create"&&request.expiresAt!==null&&(!validInstant(request.expiresAt)||Date.parse(String(request.expiresAt))<=Date.now()))
    ||(action==="grant.revoke"&&!positive(request.expectedGrantVersion)))return fail("invalid");
  try{
    const fingerprint=await requestFingerprint(request,fields);
    const db=session(env);
    const prior=await db.prepare(`SELECT request_fingerprint,action,grant_id,resulting_version,resulting_state
      FROM operations_portal_direct_folder_grant_mutations WHERE operation_id=?`).bind(request.operationId)
      .first<{request_fingerprint:string;action:Action;grant_id:string;resulting_version:number;resulting_state:"active"|"revoked"}>();
    if(prior)return prior.request_fingerprint===fingerprint?{ok:true as const,protocolVersion:1 as const,
      operationId:String(request.operationId),grantId:prior.grant_id,version:prior.resulting_version,state:prior.resulting_state,replayed:true}:fail("conflict");
    const state=await workspaceState(env,commonState(request));if(!state)return fail("workspace_unavailable");
    if(state.workspaceVersion!==request.expectedWorkspaceVersion||state.membershipVersion!==request.expectedMembershipVersion
      ||action==="grant.create"&&state.memberCount===0)return fail("conflict");
    const rootKind=state.rootKind;
    const rootRecordId=state.rootRecordId;
    const ownerScopeType=rootKind==="organization"?"organization":"client";
    const ownerRecordId=state.rootPublicId;
    if(!matchingDirectory(state.snapshot,{rootKind,rootRecordId,recipientRecordId:String(request.recipientRecordId)}))return fail("conflict");
    const actionValue=action as Action;
    if(actionValue==="grant.create"){
      const exists=await db.prepare(`SELECT grant_id,grant_version,status FROM operations_portal_direct_folder_grants
        WHERE workspace_id=? AND folder_ref=? AND recipient_record_id=? AND status='active' AND revoked_at IS NULL`)
        .bind(request.workspaceId,request.folderRef,request.recipientRecordId)
        .first<{grant_id:string;grant_version:number;status:string}>();
      if(exists)return fail("conflict");
      const result=await db.batch([
        db.prepare(`INSERT INTO operations_portal_direct_folder_grants(grant_id,grant_version,workspace_id,target_id,
          client_authority_id,target_revision,publication_revision,publication_snapshot_id,publication_snapshot_sha256,
           source_id,folder_ref,owner_scope_type,owner_record_id,
          recipient_record_id,audience,status,expires_at,created_by_operation_id)
          VALUES(?,1,?,?,?,?,?,?,?,?,?,?,?,?,'all_members','active',?,?)`).bind(request.grantId,request.workspaceId,
          request.targetId,request.clientAuthorityId,state.targetRevision,state.publicationRevision,state.snapshotId,
          state.snapshotSha256,state.sourceId,request.folderRef,ownerScopeType,
          ownerRecordId,request.recipientRecordId,request.expiresAt,request.operationId),
        db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
          grant_id,resulting_version,resulting_state) VALUES(?,?,'grant.create',?,1,'active')`)
          .bind(request.operationId,fingerprint,request.grantId),
        db.prepare(`INSERT INTO operations_portal_direct_folder_grant_audit(operation_id,grant_id,grant_version,
          workspace_id,action,details_json) VALUES(?,?,1,?,'grant.created',?)`)
          .bind(request.operationId,request.grantId,request.workspaceId,JSON.stringify({audience:"all_members",expiresAt:request.expiresAt})),
      ]);
      const fresh=await workspaceState(env,commonState(request));
      if(!fresh||fresh.workspaceVersion!==state.workspaceVersion||fresh.membershipVersion!==state.membershipVersion)return fail("conflict");
      return {ok:true as const,protocolVersion:1 as const,operationId:String(request.operationId),grantId:String(request.grantId),version:1,state:"active" as const,replayed:result[0]!.meta.changes===0};
    }
    const current=await db.prepare(`SELECT grant_version,status,workspace_id,folder_ref,owner_scope_type,owner_record_id,
      recipient_record_id FROM operations_portal_direct_folder_grants
      WHERE grant_id=? AND workspace_id=? AND folder_ref=?`).bind(request.grantId,request.workspaceId,request.folderRef)
      .first<{grant_version:number;status:string;workspace_id:string;folder_ref:string;owner_scope_type:string;owner_record_id:string;
        recipient_record_id:string}>();
    if(!current||current.status!=="active"||current.grant_version!==request.expectedGrantVersion
      ||current.owner_scope_type!==ownerScopeType||current.owner_record_id!==ownerRecordId
      ||current.recipient_record_id!==request.recipientRecordId)return fail("conflict");
    const nextVersion=current.grant_version+1,revokedAt=new Date().toISOString();
    await db.batch([
      db.prepare(`UPDATE operations_portal_direct_folder_grants SET status='revoked',grant_version=?,revoked_at=?,
        revoked_by_operation_id=?,updated_at=? WHERE grant_id=? AND workspace_id=? AND folder_ref=?
        AND status='active' AND grant_version=?`).bind(nextVersion,revokedAt,request.operationId,revokedAt,
          request.grantId,request.workspaceId,request.folderRef,current.grant_version),
      db.prepare(`INSERT INTO operations_portal_direct_folder_grant_mutations(operation_id,request_fingerprint,action,
        grant_id,resulting_version,resulting_state) VALUES(?,?,'grant.revoke',?,?,'revoked')`)
        .bind(request.operationId,fingerprint,request.grantId,nextVersion),
      db.prepare(`INSERT INTO operations_portal_direct_folder_grant_audit(operation_id,grant_id,grant_version,
        workspace_id,action,details_json) VALUES(?,?,?,?,'grant.revoked','{}')`)
        .bind(request.operationId,request.grantId,nextVersion,request.workspaceId),
    ]);
    return {ok:true as const,protocolVersion:1 as const,operationId:String(request.operationId),grantId:String(request.grantId),version:nextVersion,state:"revoked" as const,replayed:false};
  }catch(error){
    if(error instanceof Error&&/no such table|no such column/.test(error.message))return fail("temporarily_unavailable");
    if(error instanceof Error&&/constraint|UNIQUE/i.test(error.message))return fail("conflict");
    return fail("temporarily_unavailable");
  }
}

export type DirectWorkspaceFolderResource={workspaceId:string;targetId:string;targetRevision:number;clientAuthorityId:string;sourceId:string;
  grantId:string;grantVersion:number;expiresAt:string|null;r2Prefix:string;displayName:string};

/** Current authority for direct-folder list/open/download. Raw
 * prefixes stay inside this Worker module and are never serialized. */
export async function listAuthorizedDirectWorkspaceFolderResources(env:DatabaseEnv,input:{workspaceId:string;targetId:string;
  clientAuthorityId:string;sourceId:string;issuer:string;subject:string}):Promise<DirectWorkspaceFolderResource[]>{
  if(!directFolderGrantsEnabled(env))return [];
  if(!validText(input.issuer,512)||!validText(input.subject,512))return [];
  if(!await tableReady(env))throw new Error("direct-folder-schema-unavailable");
  const state=await workspaceState(env,input);if(!state)throw new Error("direct-folder-workspace-authority-unavailable");
  if(state.memberCount===0)return [];
  const rows=await session(env).prepare(`SELECT grant_record.folder_ref,grant_record.grant_id,grant_record.grant_version,grant_record.expires_at,
      grant_record.target_id,grant_record.target_revision,grant_record.client_authority_id,grant_record.source_id,
      grant_record.owner_scope_type,grant_record.owner_record_id,grant_record.recipient_record_id
    FROM operations_portal_direct_folder_grants grant_record
    JOIN portal_v2_workspaces workspace ON workspace.id=grant_record.workspace_id AND workspace.status='active'
      AND workspace.project_alpha_source_id=grant_record.source_id
    JOIN portal_v2_workspace_memberships membership ON membership.workspace_id=grant_record.workspace_id
      AND membership.status='active' AND membership.revoked_at IS NULL
      AND (membership.expires_at IS NULL OR datetime(membership.expires_at)>datetime('now'))
    JOIN portal_v2_identities identity ON identity.id=membership.identity_id
      AND identity.issuer=? AND identity.subject=? AND identity.status='active' AND identity.revoked_at IS NULL
    WHERE grant_record.workspace_id=? AND grant_record.target_id=? AND grant_record.client_authority_id=?
      AND grant_record.target_revision=?
      AND grant_record.source_id=? AND grant_record.status='active' AND grant_record.revoked_at IS NULL
      AND (grant_record.expires_at IS NULL OR datetime(grant_record.expires_at)>datetime('now'))
    ORDER BY grant_record.folder_ref LIMIT 101`).bind(input.issuer,input.subject,input.workspaceId,input.targetId,
      input.clientAuthorityId,state.targetRevision,input.sourceId)
    .all<{folder_ref:string;grant_id:string;grant_version:number;expires_at:string|null;target_id:string;target_revision:number;
      client_authority_id:string;source_id:string;
      owner_scope_type:"organization"|"client";owner_record_id:string;recipient_record_id:string}>();
  if(rows.results.length>100)throw new Error("direct-folder-capacity-exceeded");
  // Re-read the workspace and the target identity after the folder query. This
  // makes a concurrent membership, publication, or authority change deny the read.
  const fresh=await workspaceState(env,input);
  if(!fresh||fresh.workspaceVersion!==state.workspaceVersion||fresh.membershipVersion!==state.membershipVersion)return [];
  const eligible=rows.results.flatMap(row=>{
    const r2Prefix=folderRefPrefix(row.folder_ref);
    if(!r2Prefix||row.owner_scope_type!==(fresh.rootKind==="organization"?"organization":"client")
      ||row.owner_record_id!==fresh.rootPublicId
      ||!matchingDirectory(fresh.snapshot,{rootKind:fresh.rootKind,rootRecordId:fresh.rootRecordId,
        recipientRecordId:row.recipient_record_id}))return [];
    return [{row,r2Prefix}];
  });
  return eligible.map(({row,r2Prefix})=>({workspaceId:state.workspaceId,targetId:state.targetId,targetRevision:state.targetRevision,
    clientAuthorityId:state.clientAuthorityId,sourceId:state.sourceId,grantId:row.grant_id,grantVersion:row.grant_version,
    expiresAt:row.expires_at,r2Prefix,
    displayName:r2Prefix.slice(0,-1).split("/").at(-1)??"Shared folder"}));
}

/** Resolve the current private Ops authority from the Client workspace rather
 * than accepting a target or authority identifier from a portal session. */
export async function listAuthorizedDirectWorkspaceFolderResourcesForPrincipal(env:DatabaseEnv,input:{workspaceId:string;issuer:string;subject:string}){
  if(!directFolderGrantsEnabled(env))return [] as DirectWorkspaceFolderResource[];
  if(!await tableReady(env))throw new Error("direct-folder-schema-unavailable");
  const row=await session(env).prepare(`SELECT authority.target_id,authority.client_authority_id,workspace.project_alpha_source_id source_id
    FROM operations_portal_native_workspace_authority_heads authority
    JOIN portal_v2_workspaces workspace ON workspace.id=authority.workspace_id AND workspace.status='active'
    WHERE authority.workspace_id=? AND authority.state='active'`).bind(input.workspaceId)
    .first<{target_id:string;client_authority_id:string;source_id:string}>();
  if(!row)throw new Error("direct-folder-workspace-authority-unavailable");
  return listAuthorizedDirectWorkspaceFolderResources(env,{workspaceId:input.workspaceId,targetId:row.target_id,
    clientAuthorityId:row.client_authority_id,sourceId:row.source_id,issuer:input.issuer,subject:input.subject});
}
