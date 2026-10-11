import type { AuthenticatedNativeStaffWithAdmissionVersion as Actor } from "./native-staff-auth";
import { canonicalOperationsPortalNativeBillingAuthorityCommand, parseOperationsPortalNativeBillingAuthorityCommand,
  type OperationsPortalNativeBillingAuthorityCommand as Command } from "../../../../packages/shared/src/operations-portal-native-billing-authority";

export type NativeBillingSelection = Readonly<{ targetId: string; recipientBindingId: string;
  entity: Readonly<{ kind: "organization" | "client" | "project"; nativeId: string }>; expiresAt: string | null }>;
export type NativeBillingCandidateReview = NativeBillingSelection & Readonly<{
  grantId: string | null; expectedRevision: number; reviewFingerprint: string }>;
export type NativeBillingGrantInput = NativeBillingSelection & Readonly<{
  operationId: string; grantId: string; expectedRevision: number; reviewFingerprint: string }>;
export type NativeBillingRevokeInput = Readonly<{ operationId: string; grantId: string; expectedRevision: number }>;
export type NativeBillingAuthorityStatus = Readonly<{ grantId: string; revision: number;
  state: "active" | "revoked"; live: boolean; targetId: string; recipientBindingId: string;
  entity: NativeBillingSelection["entity"]; expiresAt: string | null }>;
export type NativeBillingMutationResult = Readonly<{ status: "applied" | "replayed"; operationId: string;
  authority: NativeBillingAuthorityStatus }> | Readonly<{ status: "conflict"; reason: "request" | "review" | "revision" | "authority" }>;
type Db = D1DatabaseSession;
type Row = Record<string, string | number | null>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const HASH = /^[0-9a-f]{64}$/u;
const denied = (): never => { throw new Error("native_billing_authority_denied"); };
const text = (r: Row, key: string): string => { const v=r[key]; return typeof v==="string" ? v : denied(); };
const num = (r: Row, key: string): number => { const v=r[key]; return typeof v==="number" && Number.isSafeInteger(v) ? v : denied(); };
const exact = (v: unknown, keys: string[]): v is Record<string, unknown> => v!==null && typeof v==="object"
  && Object.getPrototypeOf(v)===Object.prototype && Object.keys(v).length===keys.length && keys.every(k=>Object.hasOwn(v,k));
const selectionKeys=["targetId","recipientBindingId","entity","expiresAt"];
function selection(v: NativeBillingSelection): boolean {
  return UUID.test(v.targetId) && UUID.test(v.recipientBindingId) && exact(v.entity,["kind","nativeId"])
    && ["organization","client","project"].includes(v.entity.kind) && typeof v.entity.nativeId==="string"
    && v.entity.nativeId.length>0 && v.entity.nativeId.length<=191 && v.entity.nativeId.trim()===v.entity.nativeId
    && !/\p{C}/u.test(v.entity.nativeId) && (v.expiresAt===null || typeof v.expiresAt==="string"
      && Number.isFinite(Date.parse(v.expiresAt)) && new Date(v.expiresAt).toISOString()===v.expiresAt);
}
const hash = async (value: string): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256",new TextEncoder().encode(value)))).map(v=>v.toString(16).padStart(2,"0")).join("");
async function row(db: Db, sql: string, ...values: (string|number|null)[]): Promise<Row> {
  return await db.prepare(sql).bind(...values).first<Row>() ?? denied();
}
async function authorized(db: Db, actor: Actor, root: string): Promise<number> {
  const value=await db.prepare(`SELECT generation.generation FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN staff_users staff ON staff.id=admission.staff_id
    JOIN operations_portal_native_billing_permission_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.version=? AND staff.status='active' AND staff.access_subject=? AND ?>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
        WHERE p.staff_id=admission.staff_id AND p.record_id=? AND p.effect='allow')
      AND NOT EXISTS(SELECT 1 FROM operations_portal_workspace_effective_billing_permissions p
        WHERE p.staff_id=admission.staff_id AND p.record_id=? AND p.effect='deny')`)
    .bind(actor.identity.staffId,actor.identity.verifiedAccessSubject,actor.admissionVersion,actor.identity.profileVersion,
      actor.identity.verifiedAccessSubject,actor.verifiedUntil,root,root).first<Row>();
  return value && num(value,"generation")>=1 ? num(value,"generation") : denied();
}
async function currentCommand(db: Db, actor: Actor, input: NativeBillingSelection, grantId: string,
  expectedRevision: number, operationId: string): Promise<Command> {
  const workspace=await row(db,"SELECT * FROM operations_portal_native_workspace_authority_heads WHERE target_id=? AND state='active'",input.targetId);
  const generation=await authorized(db,actor,text(workspace,"root_record_id"));
  const recipient=await row(db,`SELECT r.* FROM operations_portal_native_recipient_authority_heads r
    JOIN client_onboarding_recipient_identity_bindings b ON b.binding_id=r.recipient_binding_id
    WHERE r.recipient_binding_id=? AND r.target_id=? AND r.state='active' AND b.status='active'
      AND (b.expires_at IS NULL OR b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      AND b.target_client_record_id=r.target_client_record_id AND b.access_issuer=r.issuer AND b.access_subject=r.subject`,input.recipientBindingId,input.targetId);
  if(num(recipient,"ownership_epoch")!==num(workspace,"ownership_epoch")) denied();
  const receipt=await row(db,"SELECT * FROM operations_portal_native_authority_receipts WHERE operation_id=?",text(recipient,"latest_operation_id"));
  const publication=await row(db,"SELECT * FROM operations_portal_workspace_publication_heads WHERE target_id=?",input.targetId);
  const pubReceipt=await row(db,"SELECT * FROM operations_portal_workspace_publication_receipts WHERE operation_id=?",text(publication,"latest_operation_id"));
  if(input.entity.kind==="organization") {
    if(text(workspace,"root_kind")!=="organization" || input.entity.nativeId!==text(workspace,"root_record_id")) denied();
  } else if(input.entity.kind==="client") {
    if(input.entity.nativeId!==text(recipient,"target_client_record_id")) denied();
  } else {
    await row(db,`SELECT p.external_project_id FROM operations_portal_workspace_publication_project_sources s
      JOIN operations_portal_workspace_publication_snapshots snap ON snap.checkpoint_id=s.checkpoint_id
      JOIN operations_shared_projects p ON p.external_project_id=s.external_project_id
      WHERE snap.snapshot_id=? AND s.external_project_id=? AND s.project_version=p.current_version AND s.archived=p.archived
        AND s.organization_record_id IS p.organization_record_id AND s.client_record_id IS p.client_record_id
        AND ((?='organization' AND p.organization_record_id=?) OR (?='standalone_client'
          AND p.organization_record_id IS NULL AND p.client_record_id=?))`,text(publication,"snapshot_id"),input.entity.nativeId,
      text(workspace,"root_kind"),text(workspace,"root_record_id"),text(workspace,"root_kind"),text(recipient,"target_client_record_id"));
  }
  const command=parseOperationsPortalNativeBillingAuthorityCommand({protocol:"operations-portal-native-billing-authority",protocolVersion:1,
    action:"billing.grant",operationId,authority:{grantId,expectedRevision:String(expectedRevision),resultingRevision:String(expectedRevision+1)},
    workspace:{targetId:input.targetId,targetRevision:String(num(workspace,"target_revision")),clientAuthorityId:text(workspace,"client_authority_id"),
      workspaceId:text(workspace,"workspace_id"),rootKind:text(workspace,"root_kind"),rootRecordId:text(workspace,"root_record_id")},
    recipient:{recipientBindingId:input.recipientBindingId,enrollmentIntentId:text(recipient,"enrollment_intent_id"),targetClientRecordId:text(recipient,"target_client_record_id"),
      issuer:text(recipient,"issuer"),subject:text(recipient,"subject"),ownershipEpoch:String(num(recipient,"ownership_epoch")),grantRevision:String(num(recipient,"grant_revision")),
      grantOperationId:text(recipient,"latest_operation_id"),requestFingerprint:text(receipt,"request_fingerprint")},
    publication:{operationId:text(publication,"latest_operation_id"),publicationId:text(pubReceipt,"publication_id"),revision:String(num(publication,"publication_revision")),
      sourceSequence:String(num(publication,"source_sequence")),snapshotId:text(publication,"snapshot_id"),snapshotSha256:text(publication,"snapshot_sha256"),requestFingerprint:text(pubReceipt,"operation_fingerprint")},
    entity:input.entity,actorProof:{staffId:actor.identity.staffId,verifiedAccessSubject:actor.identity.verifiedAccessSubject,admissionVersion:String(actor.admissionVersion),
      profileVersion:String(actor.identity.profileVersion),grantGeneration:String(generation),verifiedUntil:actor.verifiedUntil},expiresAt:input.expiresAt,observedAt:new Date().toISOString()});
  return command ?? denied();
}
// Deliberately excludes action-time/session fields and operation/grant IDs.
// Stable review remains bound to the selected lineage and permission generation.
async function fingerprint(c: Command): Promise<string> {
  return hash(JSON.stringify({workspace:c.workspace,recipient:c.recipient,publication:c.publication,entity:c.entity,
    expiresAt:c.expiresAt,expectedRevision:c.authority.expectedRevision,staffId:c.actorProof.staffId,
    accessSubject:c.actorProof.verifiedAccessSubject,grantGeneration:c.actorProof.grantGeneration}));
}
export async function reviewOperationsPortalNativeBillingCandidate(database: D1Database, actor: Actor,
  input: NativeBillingSelection): Promise<NativeBillingCandidateReview> {
  if(!exact(input,selectionKeys) || !selection(input) || input.expiresAt!==null && input.expiresAt<=new Date().toISOString()) denied();
  const db=database.withSession("first-primary");
  const head=await db.prepare(`SELECT grant_id,revision FROM operations_portal_native_billing_authority_heads
    WHERE recipient_binding_id=? AND entity_kind=? AND native_entity_id=?`).bind(input.recipientBindingId,input.entity.kind,input.entity.nativeId).first<Row>();
  const expectedRevision=head?num(head,"revision"):0,grantId=head?text(head,"grant_id"):null;
  const c=await currentCommand(db,actor,input,grantId??crypto.randomUUID(),expectedRevision,crypto.randomUUID());
  return {...input,entity:{...input.entity},grantId,expectedRevision,reviewFingerprint:await fingerprint(c)};
}
async function saved(db: Db, operationId: string): Promise<Command|null> {
  const value=await db.prepare("SELECT canonical_command_json,request_sha256 FROM operations_portal_native_billing_authority_commands WHERE operation_id=?")
    .bind(operationId).first<Row>();
  if(value===null)return null;
  const wire=text(value,"canonical_command_json"),command=parseOperationsPortalNativeBillingAuthorityCommand(JSON.parse(wire));
  if(!command || canonicalOperationsPortalNativeBillingAuthorityCommand(command)!==wire || await hash(wire)!==text(value,"request_sha256"))return denied();
  return command;
}
export async function readOperationsPortalNativeBillingAuthorityStatus(database: D1Database, actor: Actor,
  grantId: string): Promise<NativeBillingAuthorityStatus> {
  if(!UUID.test(grantId)) denied();
  const db=database.withSession("first-primary"),head=await row(db,`SELECT h.*,c.root_record_id,c.target_id FROM operations_portal_native_billing_authority_heads h
    JOIN operations_portal_native_billing_authority_commands c ON c.operation_id=h.latest_operation_id WHERE h.grant_id=?`,grantId);
  await authorized(db,actor,text(head,"root_record_id"));
  const state=text(head,"state"),kind=text(head,"entity_kind");
  if(state!=="active" && state!=="revoked") return denied();
  if(kind!=="organization" && kind!=="client" && kind!=="project") return denied();
  return {grantId,revision:num(head,"revision"),state,targetId:text(head,"target_id"),recipientBindingId:text(head,"recipient_binding_id"),live:Boolean(await db.prepare("SELECT 1 FROM operations_portal_native_billing_live_authority WHERE grant_id=?").bind(grantId).first()),
    entity:{kind,nativeId:text(head,"native_entity_id")},expiresAt:head.expires_at===null?null:text(head,"expires_at")};
}
function commandInsert(db: Db,c: Command,wire: string,sha: string): D1PreparedStatement {
  const columns="operation_id,request_sha256,canonical_command_json,action,grant_id,expected_revision,resulting_revision,target_id,target_revision,client_authority_id,workspace_id,root_kind,root_record_id,recipient_binding_id,enrollment_intent_id,target_client_record_id,issuer,subject,ownership_epoch,recipient_grant_revision,recipient_grant_operation_id,recipient_request_fingerprint,publication_operation_id,publication_id,publication_revision,publication_source_sequence,publication_snapshot_id,publication_snapshot_sha256,publication_request_fingerprint,entity_kind,native_entity_id,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,expires_at,observed_at";
  const w=c.workspace,r=c.recipient,p=c.publication,a=c.actorProof;
  const values=[c.operationId,sha,wire,c.action,c.authority.grantId,Number(c.authority.expectedRevision),Number(c.authority.resultingRevision),w.targetId,Number(w.targetRevision),w.clientAuthorityId,w.workspaceId,w.rootKind,w.rootRecordId,
    r.recipientBindingId,r.enrollmentIntentId,r.targetClientRecordId,r.issuer,r.subject,Number(r.ownershipEpoch),Number(r.grantRevision),r.grantOperationId,r.requestFingerprint,p.operationId,p.publicationId,Number(p.revision),Number(p.sourceSequence),p.snapshotId,p.snapshotSha256,p.requestFingerprint,
    c.entity.kind,c.entity.nativeId,a.staffId,a.verifiedAccessSubject,Number(a.admissionVersion),Number(a.profileVersion),Number(a.grantGeneration),a.verifiedUntil,c.expiresAt,c.observedAt];
  return db.prepare(`INSERT INTO operations_portal_native_billing_authority_commands(${columns}) VALUES(${values.map(()=>"?").join(",")})`).bind(...values);
}
async function commit(db: Db,c: Command): Promise<void> {
  const wire=canonicalOperationsPortalNativeBillingAuthorityCommand(c),sha=await hash(wire),claim=crypto.randomUUID(),finalization=crypto.randomUUID();
  const grant=c.action==="billing.grant",state=grant?"active":"revoked",revision=Number(c.authority.resultingRevision);
  const statements=[commandInsert(db,c,wire,sha),
    db.prepare("INSERT INTO operations_portal_native_billing_authority_outbox(operation_id,request_sha256,canonical_wire_json) VALUES(?,?,?)").bind(c.operationId,sha,wire),
    db.prepare("UPDATE operations_portal_native_billing_authority_outbox SET state='claimed',attempts=1,lease_token=?,lease_expires_at=unixepoch()*1000+60000 WHERE operation_id=? AND state='pending'").bind(claim,c.operationId),
    db.prepare("UPDATE operations_portal_native_billing_authority_outbox SET state='acknowledged',lease_token=NULL,lease_expires_at=NULL,acknowledged_claim_token=? WHERE operation_id=? AND state='claimed' AND lease_token=?").bind(claim,c.operationId,claim),
    db.prepare("INSERT INTO operations_portal_native_billing_authority_receipts(operation_id,request_sha256,grant_id,resulting_revision,resulting_state,acknowledged_claim_token) VALUES(?,?,?,?,?,?)").bind(c.operationId,sha,c.authority.grantId,revision,state,claim)];
  if(grant) {const r=c.recipient,p=c.publication,a=c.actorProof;
    statements.push(db.prepare(`INSERT INTO operations_portal_native_billing_grant_finalizations(finalization_id,operation_id,request_sha256,grant_id,current_target_revision,current_ownership_epoch,current_recipient_grant_revision,current_recipient_grant_operation_id,current_publication_operation_id,current_publication_revision,current_publication_source_sequence,current_publication_snapshot_id,current_publication_snapshot_sha256,actor_staff_id,actor_access_subject,actor_admission_version,actor_profile_version,actor_grant_generation,actor_verified_until,observed_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(finalization,c.operationId,sha,c.authority.grantId,Number(c.workspace.targetRevision),Number(r.ownershipEpoch),Number(r.grantRevision),r.grantOperationId,p.operationId,Number(p.revision),Number(p.sourceSequence),p.snapshotId,p.snapshotSha256,a.staffId,a.verifiedAccessSubject,Number(a.admissionVersion),Number(a.profileVersion),Number(a.grantGeneration),a.verifiedUntil,c.observedAt));
  }
  if(Number(c.authority.expectedRevision)===0) statements.push(db.prepare(`INSERT INTO operations_portal_native_billing_authority_heads(grant_id,recipient_binding_id,entity_kind,native_entity_id,revision,state,expires_at,latest_grant_finalization_id,creation_operation_id,latest_operation_id)
    VALUES(?,?,?,?,?,'active',?,?,?,?)`).bind(c.authority.grantId,c.recipient.recipientBindingId,c.entity.kind,c.entity.nativeId,revision,c.expiresAt,finalization,c.operationId,c.operationId));
  else statements.push(db.prepare(`UPDATE operations_portal_native_billing_authority_heads SET revision=?,state=?,expires_at=?,latest_operation_id=?,
    latest_grant_finalization_id=CASE WHEN ?='active' THEN ? ELSE latest_grant_finalization_id END,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE grant_id=? AND revision=?`)
    .bind(revision,state,c.expiresAt,c.operationId,state,finalization,c.authority.grantId,Number(c.authority.expectedRevision)));
  // Local ledger acknowledgement only: no remote receipt or Client ACK exists.
  await db.batch(statements);
}
async function replay(database: D1Database,db: Db,actor: Actor,c: Command,input: NativeBillingGrantInput|NativeBillingRevokeInput): Promise<NativeBillingMutationResult> {
  await authorized(db,actor,c.workspace.rootRecordId);
  const grant=c.action==="billing.grant";
  if(c.actorProof.staffId!==actor.identity.staffId || c.actorProof.verifiedAccessSubject!==actor.identity.verifiedAccessSubject
    || c.authority.grantId!==input.grantId || Number(c.authority.expectedRevision)!==input.expectedRevision
    || grant!==Object.hasOwn(input,"reviewFingerprint")) return {status:"conflict",reason:"request"};
  if(grant && "reviewFingerprint" in input) {
    if(c.workspace.targetId!==input.targetId || c.recipient.recipientBindingId!==input.recipientBindingId || c.entity.kind!==input.entity.kind
      || c.entity.nativeId!==input.entity.nativeId || c.expiresAt!==input.expiresAt || await fingerprint(c)!==input.reviewFingerprint)
      return {status:"conflict",reason:"request"};
    // Expiry/revocation/lineage/permission changes never resurrect prior access.
    if(!await db.prepare("SELECT 1 FROM operations_portal_native_billing_live_authority WHERE grant_id=?").bind(input.grantId).first()) denied();
  }
  return {status:"replayed",operationId:input.operationId,authority:await readOperationsPortalNativeBillingAuthorityStatus(database,actor,input.grantId)};
}
export async function grantOperationsPortalNativeBillingAuthority(database: D1Database,actor: Actor,input: NativeBillingGrantInput): Promise<NativeBillingMutationResult> {
  if(!exact(input,[...selectionKeys,"operationId","grantId","expectedRevision","reviewFingerprint"]) || !selection(input)
    || !UUID.test(input.operationId) || !UUID.test(input.grantId) || !HASH.test(input.reviewFingerprint)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<0 || input.expectedRevision>=Number.MAX_SAFE_INTEGER) return {status:"conflict",reason:"request"};
  const db=database.withSession("first-primary");
  try {
    const prior=await saved(db,input.operationId);if(prior)return await replay(database,db,actor,prior,input);
    const review=await reviewOperationsPortalNativeBillingCandidate(database,actor,{targetId:input.targetId,recipientBindingId:input.recipientBindingId,entity:input.entity,expiresAt:input.expiresAt});
    if(review.expectedRevision!==input.expectedRevision || review.grantId!==null && review.grantId!==input.grantId) return {status:"conflict",reason:"revision"};
    if(review.reviewFingerprint!==input.reviewFingerprint) return {status:"conflict",reason:"review"};
    const c=await currentCommand(db,actor,input,input.grantId,input.expectedRevision,input.operationId);
    if(await fingerprint(c)!==input.reviewFingerprint) return {status:"conflict",reason:"review"};
    await commit(db,c);
    return {status:"applied",operationId:input.operationId,authority:await readOperationsPortalNativeBillingAuthorityStatus(database,actor,input.grantId)};
  } catch {
    const prior=await saved(db,input.operationId);if(prior) {try{return await replay(database,db,actor,prior,input);}catch{/* fail closed */}}
    return {status:"conflict",reason:"authority"};
  }
}
export async function revokeOperationsPortalNativeBillingAuthority(database: D1Database,actor: Actor,input: NativeBillingRevokeInput): Promise<NativeBillingMutationResult> {
  if(!exact(input,["operationId","grantId","expectedRevision"]) || !UUID.test(input.operationId) || !UUID.test(input.grantId)
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision<1 || input.expectedRevision>=Number.MAX_SAFE_INTEGER) return {status:"conflict",reason:"request"};
  const db=database.withSession("first-primary");
  try {
    const prior=await saved(db,input.operationId);if(prior)return await replay(database,db,actor,prior,input);
    const head=await row(db,"SELECT * FROM operations_portal_native_billing_authority_heads WHERE grant_id=?",input.grantId);
    if(num(head,"revision")!==input.expectedRevision || text(head,"state")!=="active")return {status:"conflict",reason:"revision"};
    const original=await saved(db,text(head,"latest_operation_id"));if(!original)return denied();
    const generation=await authorized(db,actor,original.workspace.rootRecordId);
    const c=parseOperationsPortalNativeBillingAuthorityCommand({...original,operationId:input.operationId,action:"billing.revoke",expiresAt:null,
      authority:{grantId:input.grantId,expectedRevision:String(input.expectedRevision),resultingRevision:String(input.expectedRevision+1)},
      actorProof:{staffId:actor.identity.staffId,verifiedAccessSubject:actor.identity.verifiedAccessSubject,admissionVersion:String(actor.admissionVersion),profileVersion:String(actor.identity.profileVersion),grantGeneration:String(generation),verifiedUntil:actor.verifiedUntil},observedAt:new Date().toISOString()});
    if(!c)return denied();await commit(db,c);
    return {status:"applied",operationId:input.operationId,authority:await readOperationsPortalNativeBillingAuthorityStatus(database,actor,input.grantId)};
  } catch {
    const prior=await saved(db,input.operationId);if(prior){try{return await replay(database,db,actor,prior,input);}catch{/* fail closed */}}
    return {status:"conflict",reason:"authority"};
  }
}
