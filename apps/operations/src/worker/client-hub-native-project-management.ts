import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { sha256, timingSafeEqual } from "./crypto";
import type { ClientHubCollectionContext } from "./client-hub-collections";
import { authenticateNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { activateProjectAlphaProjectV2Canonical } from "./project-alpha-project-canonical-activation-adapter";
import { resolveProjectAlphaApiV2Connection, withEnabledConfiguredProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { planProjectAlphaProjectV2Command, type ProjectAlphaProjectV2CommandProducerAction } from "./project-alpha-project-v2-command-producer";
import { dispatchProjectAlphaProjectV2PendingCommand } from "./project-alpha-project-v2-pending-dispatcher";
import { prepareProjectAlphaProjectV2Acceptance, type ProjectAcceptancePreparationReaders } from "./project-alpha-project-v2-preparation";
import { settleProjectAlphaProjectV2Read } from "./project-alpha-project-read-settlement-adapter";
import { externalId as validProjectAlphaExternalId } from "./project-alpha-project-transport";
import type { Env, StaffPrincipal } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const externalId = z.string().min(1).max(191);
const projectExternalId = z.string().refine(validProjectAlphaExternalId);
const scope = z.discriminatedUnion("scopeKind", [
  z.object({ scopeKind: z.literal("business_area"), businessAreaId: externalId, divisionId: z.null() }).strict(),
  z.object({ scopeKind: z.literal("division"), businessAreaId: externalId, divisionId: externalId }).strict(),
]);
const project = z.object({ name: z.string().trim().min(1).max(160), description: z.string().max(4000).nullable(),
  estimatedStart: z.string().date().nullable(), estimatedEnd: z.string().date().nullable() }).strict();
export const nativeProjectPrepareSchema = z.object({ expectedContextVersion: z.string().min(1).max(128),
  operation: z.enum(["create","update"]).default("create"), commandId: z.string().regex(UUID),
  externalProjectId: projectExternalId, scopes: z.array(scope).max(128), project }).strict()
  .superRefine((value, context) => {
    if (value.operation === "create" && !UUID.test(value.externalProjectId))
      context.addIssue({ code: "custom", path: ["externalProjectId"], message: "Create project IDs must be UUIDs" });
  });
const relation = z.object({ externalId, expectedPublicId: z.string().regex(/^[0-9a-f]{32}$/),
  expectedRevision: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/), expectedProjectionSha256: z.string().regex(SHA256) }).strict();
const frozenCreateRequest = z.object({ sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  expectedApplicationId: z.string().regex(UUID), operation: z.literal("create"), scopes: z.array(scope).max(128),
  local: z.object({ expectedLocalVersion: z.literal(0), expectedLocalProjectionSha256: z.null() }).strict(),
  directory: z.object({ organizationRecordId: externalId.nullable(), clientRecordId: externalId.nullable() }).strict(),
  command: z.object({ commandId: z.string().regex(UUID), externalId: z.string().regex(UUID),
    expectedAuthorizationGeneration: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/), project,
    organization: relation.nullable(), client: relation.nullable() }).strict(),
}).strict().refine(value => value.directory.organizationRecordId !== null || value.directory.clientRecordId !== null)
  .refine(value => (value.directory.organizationRecordId === null) === (value.command.organization === null)
    && (value.directory.clientRecordId === null) === (value.command.client === null));
const frozenUpdateRequest = z.object({ sourceId: z.string().regex(/^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/),
  expectedApplicationId: z.string().regex(UUID), operation: z.literal("update"), scopes: z.array(scope).max(128),
  local: z.object({ expectedLocalVersion: z.number().int().positive(), expectedLocalProjectionSha256: z.string().regex(SHA256) }).strict(),
  command: z.object({ commandId: z.string().regex(UUID), externalId: projectExternalId,
    expectedAuthorizationGeneration: z.string().regex(/^(?:0|[1-9][0-9]{0,18})$/),
    expectedPublicId: z.string().regex(/^[0-9a-f]{32}$/), expectedRevision: z.string().regex(/^[1-9][0-9]{0,18}$/),
    expectedProjectionSha256: z.string().regex(SHA256), project }).strict(),
}).strict();
const frozenRequest = z.discriminatedUnion("operation",[frozenCreateRequest,frozenUpdateRequest]);
export const nativeProjectSubmitSchema = z.object({ expectedContextVersion: z.string().min(1).max(128), request: frozenRequest }).strict();

type GrantRow = { effect: "allow" | "deny"; scope_kind: "global" | "business_area" | "division" | "exact_project";
  business_area_id: string | null; division_id: string | null };
export async function readClientHubNativeProjectCapability(env: Env, principal: StaffPrincipal,
  context: ClientHubCollectionContext) {
  if (context.root.root_namespace !== "business" || !["organization","standalone_client"].includes(context.root.kind)
    || !context.root.source_id.startsWith("project-alpha:")) return null;
  let selected: ReturnType<typeof resolveProjectAlphaApiV2Connection>;
  try { selected = resolveProjectAlphaApiV2Connection(env, context.root.source_id); }
  catch { return { available: false as const, reason: "native_destination_unavailable" as const, scopes: [] }; }
  if (!selected.enabled || !selected.connection.expectedHistoryEpoch)
    return { available: false as const, reason: "native_destination_unavailable" as const, scopes: [] };
  const db = env.OPS_DB.withSession("first-primary");
  const [mappingRows, actorRow, grants] = await Promise.all([
    db.prepare(`SELECT mapping.record_id FROM project_alpha_active_directory_mappings mapping
      JOIN operations_directory_records record ON record.record_id=mapping.record_id AND record.record_kind=?
      JOIN project_alpha_api_v2_directory_observations_current observation
        ON observation.source_id=mapping.source_id AND observation.source_instance_id=mapping.source_instance_id
        AND observation.application_id=mapping.application_id AND observation.history_epoch_id=mapping.history_epoch_id
        AND observation.resource_type=mapping.resource_type AND observation.project_alpha_public_id=mapping.project_alpha_public_id
      WHERE mapping.record_id=? AND mapping.source_id=? AND mapping.source_instance_id=? AND mapping.application_id=?
        AND mapping.history_epoch_id=? AND mapping.resource_type=? AND observation.present=1
        AND observation.has_conflict=0 AND observation.binding_external_id=mapping.external_id
        AND observation.binding_status='active' AND observation.binding_resource_revision=observation.resource_revision
        AND (?='organization' OR EXISTS (SELECT 1 FROM operations_directory_client_organizations relationship
          WHERE relationship.client_record_id=mapping.record_id AND relationship.organization_record_id IS NULL)) LIMIT 2`)
      .bind(context.root.kind === "organization" ? "organization" : "client",context.root.public_id, context.root.source_id,
        selected.connection.expectedSourceInstanceId,selected.connection.expectedApplicationId,
        selected.connection.expectedHistoryEpoch,context.root.kind === "organization" ? "organization" : "client",context.root.kind)
      .all<{ record_id: string }>(),
    db.prepare(`SELECT admission.staff_id FROM native_staff_admissions admission
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
      JOIN native_project_grant_generations generation ON generation.staff_id=admission.staff_id
      WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=? AND profile.login_email=?`)
      .bind(principal.id, principal.accessSubject, principal.email).first<{ staff_id: string }>(),
    db.prepare(`SELECT effect,scope_kind,business_area_id,division_id FROM native_project_grants
      WHERE staff_id=? AND capability='project.shared.sync' AND active=1
      ORDER BY effect,scope_kind,ifnull(business_area_id,''),ifnull(division_id,'')`).bind(principal.id).all<GrantRow>(),
  ]);
  if (mappingRows.results.length !== 1)
    return { available: false as const, reason: "source_mapping_unavailable" as const, scopes: [] };
  if (!actorRow) return { available: false as const, reason: "native_authority_required" as const, scopes: [] };
  const rows = grants.results;
  if (rows.some(row => row.effect === "deny" && row.scope_kind === "global"))
    return { available: false as const, reason: "native_authority_required" as const, scopes: [] };
  if (rows.some(row => row.effect === "allow" && row.scope_kind === "global"))
    return { available: true as const, reason: "available" as const, scopes: [[]] as const };
  const denied = (candidate: GrantRow) => rows.some(row => row.effect === "deny"
    && (row.scope_kind === candidate.scope_kind && row.business_area_id === candidate.business_area_id
      && row.division_id === candidate.division_id
      || row.scope_kind === "business_area" && row.business_area_id === candidate.business_area_id));
  const allowed = rows.filter(row => row.effect === "allow" && (row.scope_kind === "business_area" || row.scope_kind === "division") && !denied(row));
  const scopes = allowed.map(row => [row.scope_kind === "business_area"
    ? { scopeKind: "business_area" as const, businessAreaId: row.business_area_id!, divisionId: null }
    : { scopeKind: "division" as const, businessAreaId: row.business_area_id!, divisionId: row.division_id! }]);
  return scopes.length ? { available: true as const, reason: "available" as const, scopes }
    : { available: false as const, reason: "native_authority_required" as const, scopes: [] };
}

function nativeProjectOwner(context: ClientHubCollectionContext): void {
  if (context.root.root_namespace !== "business" || !["organization","standalone_client"].includes(context.root.kind)
    || !context.root.source_id.startsWith("project-alpha:") || !context.root.public_id)
    throw new HTTPException(409, { message: "Native project creation requires an exact business owner workspace" });
}
async function actor(request: Request, env: Env, principal: StaffPrincipal) {
  let authenticated: Awaited<ReturnType<typeof authenticateNativeStaffWithAdmissionVersion>>;
  try { authenticated = await authenticateNativeStaffWithAdmissionVersion(request, env.OPS_DB,
    { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD }); }
  catch { throw new HTTPException(403, { message: "Current native staff authority is required" }); }
  const identity = authenticated.identity;
  if (identity.staffId !== principal.id || identity.email !== principal.email
    || identity.verifiedAccessSubject !== principal.accessSubject)
    throw new HTTPException(403, { message: "Operations and native staff identities do not match" });
  return { staffId: identity.staffId, accessSubject: identity.verifiedAccessSubject, email: identity.email,
    admissionVersion: authenticated.admissionVersion, profileVersion: identity.profileVersion,
    verifiedUntil: authenticated.verifiedUntil };
}
async function authorityGeneration(env: Env, staffId: string): Promise<number> {
  const generation = await env.OPS_DB.withSession("first-primary").prepare(
    "SELECT generation FROM native_project_grant_generations WHERE staff_id=?",
  ).bind(staffId).first<number>("generation");
  if (!Number.isSafeInteger(generation) || generation! < 0)
    throw new HTTPException(403, { message: "Current native project authority is required" });
  return generation!;
}
function connection(env: Env, sourceId: string) {
  try {
    const selected = resolveProjectAlphaApiV2Connection(env, sourceId);
    if (!selected.enabled || !selected.connection.expectedHistoryEpoch) throw new Error();
    return selected;
  } catch { throw new HTTPException(409, { message: "The native Project Alpha destination is unavailable" }); }
}
function safeOutcome(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { status: "uncertain", reason: "invalid_outcome" };
  const row = value as Record<string, unknown>, result: Record<string, unknown> = {
    status: typeof row.status === "string" ? row.status : "uncertain",
  };
  for (const key of ["reason", "commandId", "receiptId", "settlementId", "activationId", "externalProjectId"])
    if (typeof row[key] === "string") result[key] = row[key];
  if (typeof row.replayed === "boolean") result.replayed = row.replayed;
  if (typeof row.version === "number" && Number.isSafeInteger(row.version)) result.version = row.version;
  return result;
}
function includesPreparedScopes(options: readonly (readonly unknown[])[], expected: readonly unknown[]): boolean {
  const wanted = JSON.stringify(expected);
  return options.some(option => JSON.stringify(option) === wanted);
}

async function deterministicRecoveryId(commandId: string, eventVersion: number, generation: number): Promise<string> {
  const encoded = await sha256(`${commandId}:${eventVersion}:${generation}`);
  const decoded = atob(encoded.replace(/-/g,"+").replace(/_/g,"/")+"=");
  const bytes = Uint8Array.from(decoded, value => value.charCodeAt(0));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes.slice(0,16), value => value.toString(16).padStart(2,"0")).join("");
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

async function authorizeClientHubUncertainRecovery(env: Env, commandId: string, generation: number,
  verifiedUntil: string): Promise<boolean> {
  const db = env.OPS_DB.withSession("first-primary");
  const row = await db.prepare(`SELECT preparation.*,outbox.attempts,outbox.outcome_json,
      fingerprint.request_sha256 command_request_sha256,intent.expected_local_version,
      intent.expected_local_projection_sha256,intent.expected_mapping_state,intent.expected_project_alpha_public_id,
      proof.scopes_json,rtrim(outbox.destination_base_url,'/') destination_origin,
      event.state_version uncertain_event_version
    FROM client_hub_native_project_preparations preparation
    JOIN native_project_command_reservations reservation ON reservation.command_id=preparation.command_id
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=preparation.command_id
      AND outbox.external_project_id=preparation.external_project_id AND outbox.state='terminal'
      AND outbox.lease_token IS NULL AND outbox.lease_expires_at IS NULL
    JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=preparation.command_id
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=preparation.command_id
    JOIN native_project_command_proofs proof ON proof.command_id=preparation.command_id
    JOIN project_alpha_project_v2_events event ON event.command_id=preparation.command_id AND event.state='uncertain'
      AND event.state_version=(SELECT MAX(latest.state_version) FROM project_alpha_project_v2_events latest
        WHERE latest.command_id=preparation.command_id)
    WHERE preparation.command_id=? AND preparation.transmission_started_at IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=preparation.command_id)
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement WHERE settlement.command_id=preparation.command_id)
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation WHERE activation.command_id=preparation.command_id)`)
    .bind(commandId).first<Record<string, unknown>>();
  if (!row || typeof row.uncertain_event_version !== "number" || typeof row.attempts !== "number"
    || typeof row.outcome_json !== "string")
    return authorizeClientHubRecoveryRenewal(env,commandId,generation,verifiedUntil);
  const authorizationId = await deterministicRecoveryId(commandId,row.uncertain_event_version,generation);
  const expiresAt = new Date(Math.min(Date.now()+15*60_000,Date.parse(verifiedUntil))).toISOString();
  try {
    await db.batch([
      db.prepare(`INSERT INTO client_hub_native_project_recovery_authorizations(
        authorization_id,command_id,uncertain_event_version,original_attempts,original_outcome_json,
        preparation_request_json,preparation_request_sha256,command_request_sha256,external_project_id,
        source_id,source_instance_id,application_id,history_epoch_id,destination_origin,context_root_namespace,
        context_root_kind,context_root_public_id,context_version,original_actor_staff_id,original_actor_access_subject,
        original_actor_email,original_actor_admission_version,original_actor_profile_version,
        original_authority_generation,current_authority_generation,scopes_json,expected_local_version,
        expected_local_projection_sha256,expected_mapping_state,expected_project_alpha_public_id,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
        authorizationId,commandId,row.uncertain_event_version,row.attempts,row.outcome_json,row.request_json,
        row.request_sha256,row.command_request_sha256,row.external_project_id,row.context_source_id,row.source_instance_id,
        row.application_id,row.history_epoch_id,row.destination_origin,row.context_root_namespace,row.context_root_kind,
        row.context_root_public_id,row.context_version,row.actor_staff_id,row.actor_access_subject,row.actor_email,
        row.actor_admission_version,row.actor_profile_version,row.authority_generation,generation,row.scopes_json,
        row.expected_local_version,row.expected_local_projection_sha256,row.expected_mapping_state,
        row.expected_project_alpha_public_id,expiresAt),
      db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
        VALUES(?,?,?,?, 'pending')`).bind(commandId,(row.uncertain_event_version as number)+1,crypto.randomUUID(),row.command_request_sha256),
      db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
        outcome_json=NULL,client_hub_recovery_authorization_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND state='terminal' AND attempts=? AND outcome_json=?`)
        .bind(authorizationId,commandId,row.attempts,row.outcome_json),
    ]);
    return true;
  } catch {
    return !!await db.prepare(`SELECT 1 FROM client_hub_native_project_live_recovery_authorizations
      WHERE authorization_id=?`).bind(authorizationId).first("1");
  }
}

async function authorizeClientHubRecoveryRenewal(env: Env, commandId: string, generation: number,
  verifiedUntil: string): Promise<boolean> {
  const db=env.OPS_DB.withSession("first-primary");
  const row=await db.prepare(`SELECT preparation.*,outbox.state,outbox.attempts,outbox.lease_token,
      outbox.lease_expires_at,outbox.client_hub_recovery_authorization_id prior_authorization_id,
      fingerprint.request_sha256 command_request_sha256,intent.expected_local_version,
      intent.expected_local_projection_sha256,intent.expected_mapping_state,intent.expected_project_alpha_public_id,
      proof.scopes_json,rtrim(outbox.destination_base_url,'/') destination_origin,
      event.state_version latest_event_version,event.state latest_event_state,
      prior.uncertain_event_version prior_uncertain_event_version,prior.original_outcome_json prior_outcome_json
    FROM client_hub_native_project_preparations preparation
    JOIN project_alpha_project_outbox outbox ON outbox.command_id=preparation.command_id
    JOIN project_alpha_project_v2_request_fingerprints fingerprint ON fingerprint.command_id=preparation.command_id
    JOIN project_alpha_project_v2_canonical_intents intent ON intent.command_id=preparation.command_id
    JOIN native_project_command_proofs proof ON proof.command_id=preparation.command_id
    JOIN project_alpha_project_v2_events event ON event.command_id=preparation.command_id
      AND event.state_version=(SELECT MAX(latest.state_version) FROM project_alpha_project_v2_events latest
        WHERE latest.command_id=preparation.command_id)
    LEFT JOIN client_hub_native_project_recovery_authorizations prior
      ON prior.authorization_id=outbox.client_hub_recovery_authorization_id AND prior.command_id=outbox.command_id
    WHERE preparation.command_id=? AND preparation.transmission_started_at IS NOT NULL
      AND ((outbox.state='leased' AND outbox.lease_expires_at<=unixepoch('now') AND event.state='pending')
        OR (outbox.state='pending' AND prior.authorization_id IS NOT NULL
          AND prior.expires_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
          AND event.state='pending' AND event.state_version=prior.uncertain_event_version+1
          AND outbox.attempts=prior.original_attempts+1))
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_success_receipts receipt WHERE receipt.command_id=preparation.command_id)
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_settlement_receipts settlement WHERE settlement.command_id=preparation.command_id)
      AND NOT EXISTS (SELECT 1 FROM project_alpha_project_v2_canonical_activation_receipts activation WHERE activation.command_id=preparation.command_id)`)
    .bind(commandId).first<Record<string,unknown>>();
  if(!row || typeof row.attempts!=="number" || typeof row.latest_event_version!=="number")return false;
  const leased=row.state==="leased",reason=leased?"expired_lease":"expired_unsent";
  const priorId=typeof row.prior_authorization_id==="string"?row.prior_authorization_id:null;
  if(!leased && !priorId)return false;
  const uncertainVersion=leased?row.latest_event_version+1:Number(row.prior_uncertain_event_version);
  if(!Number.isSafeInteger(uncertainVersion))return false;
  const authorizationId=crypto.randomUUID(),expiresAt=new Date(Math.min(Date.now()+15*60_000,Date.parse(verifiedUntil))).toISOString();
  const originalOutcome=leased?JSON.stringify({status:"uncertain",reason:"expired_lease"}):String(row.prior_outcome_json);
  const insert=db.prepare(`INSERT INTO client_hub_native_project_recovery_authorizations(
      authorization_id,command_id,uncertain_event_version,original_attempts,original_outcome_json,
      preparation_request_json,preparation_request_sha256,command_request_sha256,external_project_id,
      source_id,source_instance_id,application_id,history_epoch_id,destination_origin,context_root_namespace,
      context_root_kind,context_root_public_id,context_version,original_actor_staff_id,original_actor_access_subject,
      original_actor_email,original_actor_admission_version,original_actor_profile_version,
      original_authority_generation,current_authority_generation,scopes_json,expected_local_version,
      expected_local_projection_sha256,expected_mapping_state,expected_project_alpha_public_id,
      authorization_reason,prior_authorization_id,expected_outbox_state,expected_lease_token,
      expected_lease_expires_at,expected_event_state_version,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      authorizationId,commandId,uncertainVersion,row.attempts,originalOutcome,row.request_json,row.request_sha256,
      row.command_request_sha256,row.external_project_id,row.context_source_id,row.source_instance_id,row.application_id,
      row.history_epoch_id,row.destination_origin,row.context_root_namespace,row.context_root_kind,row.context_root_public_id,
      row.context_version,row.actor_staff_id,row.actor_access_subject,row.actor_email,row.actor_admission_version,
      row.actor_profile_version,row.authority_generation,generation,row.scopes_json,row.expected_local_version,
      row.expected_local_projection_sha256,row.expected_mapping_state,row.expected_project_alpha_public_id,
      reason,priorId,row.state,leased?row.lease_token:null,leased?row.lease_expires_at:null,row.latest_event_version,expiresAt);
  const statements:D1PreparedStatement[]=[insert];
  if(leased)statements.push(
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
      VALUES(?,?,?,?, 'uncertain')`).bind(commandId,uncertainVersion,crypto.randomUUID(),row.command_request_sha256),
    db.prepare(`INSERT INTO project_alpha_project_v2_events(command_id,state_version,transition_id,request_sha256,state)
      VALUES(?,?,?,?, 'pending')`).bind(commandId,uncertainVersion+1,crypto.randomUUID(),row.command_request_sha256),
    db.prepare(`UPDATE project_alpha_project_outbox SET state='pending',lease_token=NULL,lease_expires_at=NULL,
      outcome_json=NULL,client_hub_recovery_authorization_id=?,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE command_id=? AND state='leased' AND attempts=? AND lease_token=? AND lease_expires_at=?
        AND lease_expires_at<=unixepoch('now') AND client_hub_recovery_authorization_id IS ?`)
      .bind(authorizationId,commandId,row.attempts,row.lease_token,row.lease_expires_at,priorId));
  else statements.push(db.prepare(`UPDATE project_alpha_project_outbox SET client_hub_recovery_authorization_id=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE command_id=? AND state='pending'
      AND attempts=? AND client_hub_recovery_authorization_id=?`).bind(authorizationId,commandId,row.attempts,priorId));
  statements.push(db.prepare(`INSERT INTO client_hub_native_project_recovery_renewal_receipts(
    authorization_id,prior_authorization_id,command_id,authorization_reason) VALUES(?,?,?,?)`)
    .bind(authorizationId,priorId,commandId,reason));
  try{await db.batch(statements);return true;}catch{return false;}
}

async function ensureClientHubPostAckContinuation(env:Env,commandId:string,receiptId:string,
  actorValue:Awaited<ReturnType<typeof actor>>,generation:number,scopes:readonly unknown[]):Promise<boolean>{
  const db=env.OPS_DB.withSession("first-primary");
  const bound=await db.prepare(`SELECT client_hub_recovery_authorization_id authorization_id
    FROM project_alpha_project_outbox WHERE command_id=?`).bind(commandId).first<string>("authorization_id");
  if(!bound)return true;
  const expiresAt=new Date(Math.min(Date.now()+15*60_000,Date.parse(actorValue.verifiedUntil))).toISOString();
  try{
    await db.prepare(`INSERT INTO client_hub_native_project_post_ack_continuations(
      continuation_id,command_id,authorization_id,success_receipt_id,acknowledgement_id,acknowledged_state_version,
      request_sha256,external_project_id,actor_staff_id,actor_access_subject,actor_admission_version,
      actor_profile_version,actor_email,grant_generation,current_grant_generation,scopes_json,expires_at)
      SELECT ?,receipt.command_id,recovery.authorization_id,receipt.receipt_id,receipt.acknowledgement_id,
        acknowledgement.acknowledged_state_version,receipt.request_sha256,recovery.external_project_id,
        ?,?,?,?,?,recovery.original_authority_generation,?,?,?
      FROM project_alpha_project_v2_success_receipts receipt
      JOIN project_alpha_project_v2_validated_acknowledgements acknowledgement
        ON acknowledgement.acknowledgement_id=receipt.acknowledgement_id
      JOIN client_hub_native_project_recovery_authorizations recovery
        ON recovery.authorization_id=? AND recovery.command_id=receipt.command_id
      WHERE receipt.receipt_id=? AND receipt.command_id=?
      ON CONFLICT(command_id,current_grant_generation) DO NOTHING`).bind(crypto.randomUUID(),actorValue.staffId,actorValue.accessSubject,actorValue.admissionVersion,
      actorValue.profileVersion,actorValue.email,generation,JSON.stringify(scopes),expiresAt,bound,receiptId,commandId).run();
    return !!await db.prepare(`SELECT 1 FROM project_alpha_project_v2_live_settlement_proofs
      WHERE command_id=?`).bind(commandId).first("1");
  }catch{return false;}
}

export async function prepareClientHubNativeProject(env: Env, request: Request, principal: StaffPrincipal,
  context: ClientHubCollectionContext, raw: unknown, readers?: ProjectAcceptancePreparationReaders) {
  nativeProjectOwner(context);
  const parsed = nativeProjectPrepareSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Native project preparation is invalid" });
  if (parsed.data.expectedContextVersion !== context.contextVersion)
    throw new HTTPException(409, { message: "Client context changed. Refresh the workspace to continue" });
  const selected = connection(env, context.root.source_id), currentActor = await actor(request, env, principal);
  const outcome = await prepareProjectAlphaProjectV2Acceptance(env, parsed.data.operation === "create"
    ? { operation: "create", sourceId: context.root.source_id,
      expectedApplicationId: selected.connection.expectedApplicationId, externalProjectId: parsed.data.externalProjectId,
      organizationRecordId: context.root.kind === "organization" ? context.root.public_id : null,
      clientRecordId: context.root.kind === "standalone_client" ? context.root.public_id : null,
      actor: { ...currentActor, scopes: parsed.data.scopes } }
    : { operation: "update", sourceId: context.root.source_id,
      expectedApplicationId: selected.connection.expectedApplicationId, externalProjectId: parsed.data.externalProjectId,
      actor: { ...currentActor, scopes: parsed.data.scopes } }, readers);
  if (outcome.status !== "prepared") return outcome;
  if (outcome.preparation.operation !== parsed.data.operation)
    throw new HTTPException(409, { message: "Native project preparation changed" });
  const frozen = outcome.preparation.operation === "create" ? { sourceId: context.root.source_id,
    expectedApplicationId: selected.connection.expectedApplicationId, operation: "create" as const,
    scopes: parsed.data.scopes, local: outcome.preparation.local, directory: outcome.preparation.directory,
    command: { commandId: parsed.data.commandId, externalId: parsed.data.externalProjectId,
      expectedAuthorizationGeneration: outcome.preparation.expectedAuthorizationGeneration, project: parsed.data.project,
      organization: outcome.preparation.organization, client: outcome.preparation.client } }
    : { sourceId: context.root.source_id, expectedApplicationId: selected.connection.expectedApplicationId,
      operation: "update" as const, scopes: parsed.data.scopes, local: outcome.preparation.local,
      command: { commandId: parsed.data.commandId, externalId: parsed.data.externalProjectId,
        expectedAuthorizationGeneration: outcome.preparation.expectedAuthorizationGeneration,
        expectedPublicId: outcome.preparation.expectedPublicId, expectedRevision: outcome.preparation.expectedRevision,
        expectedProjectionSha256: outcome.preparation.expectedProjectionSha256, project: parsed.data.project } };
  const requestJson = JSON.stringify(frozen), requestSha256 = await sha256(requestJson);
  const generation = await authorityGeneration(env, currentActor.staffId);
  let insert: D1Result;
  try {
    insert = await env.OPS_DB.withSession("first-primary").prepare(`INSERT INTO client_hub_native_project_preparations(
      command_id,external_project_id,request_json,request_sha256,context_source_id,context_root_namespace,context_root_kind,
      context_root_public_id,context_version,actor_staff_id,actor_access_subject,actor_email,actor_admission_version,
      actor_profile_version,authority_generation,source_instance_id,application_id,history_epoch_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(command_id) DO NOTHING`).bind(
      frozen.command.commandId,frozen.command.externalId,requestJson,requestSha256,context.root.source_id,context.root.root_namespace,
      context.root.kind,context.root.public_id,context.contextVersion,currentActor.staffId,currentActor.accessSubject,currentActor.email,
      currentActor.admissionVersion,currentActor.profileVersion,generation,selected.connection.expectedSourceInstanceId,
      selected.connection.expectedApplicationId,selected.connection.expectedHistoryEpoch,
    ).run();
  } catch {
    throw new HTTPException(409, { message: "The native project reference is already prepared" });
  }
  if (!insert.meta.changes) {
    const existing = await env.OPS_DB.withSession("first-primary").prepare(
      "SELECT request_json,request_sha256 FROM client_hub_native_project_preparations WHERE command_id=?",
    ).bind(frozen.command.commandId).first<{ request_json: string; request_sha256: string }>();
    if (!existing || existing.request_json !== requestJson || !timingSafeEqual(existing.request_sha256, requestSha256))
      throw new HTTPException(409, { message: "The prepared command identifier is already bound to another request" });
  }
  return { status: "prepared" as const, request: frozen };
}

export async function submitClientHubNativeProject(env: Env, request: Request, principal: StaffPrincipal,
  context: ClientHubCollectionContext, raw: unknown, send: typeof fetch = fetch) {
  nativeProjectOwner(context);
  const parsed = nativeProjectSubmitSchema.safeParse(raw);
  if (!parsed.success) throw new HTTPException(400, { message: "Native project request is invalid" });
  const input = parsed.data, value = input.request;
  if (input.expectedContextVersion !== context.contextVersion)
    throw new HTTPException(409, { message: "Client context changed. Refresh the workspace to continue" });
  if (request.headers.get("Idempotency-Key") !== value.command.commandId)
    throw new HTTPException(400, { message: "Idempotency-Key must match the prepared command" });
  const selected = connection(env, context.root.source_id);
  if (value.sourceId !== context.root.source_id || value.expectedApplicationId !== selected.connection.expectedApplicationId
    || value.operation === "create" && (context.root.kind === "organization" ? value.directory.organizationRecordId !== context.root.public_id
      || value.directory.clientRecordId !== null : value.directory.organizationRecordId !== null
      || value.directory.clientRecordId !== context.root.public_id))
    throw new HTTPException(409, { message: "The prepared native project destination changed" });
  const currentActor = await actor(request, env, principal);
  const requestJson = JSON.stringify(value), requestSha256 = await sha256(requestJson);
  const prepared = await env.OPS_DB.withSession("first-primary").prepare(`SELECT * FROM client_hub_native_project_preparations
    WHERE command_id=? AND external_project_id=?`).bind(value.command.commandId,value.command.externalId).first<Record<string, unknown>>();
  const generation = await authorityGeneration(env, currentActor.staffId);
  const knownAcknowledgement = prepared?.transmission_started_at === null ? null
    : await env.OPS_DB.withSession("first-primary").prepare(
      "SELECT receipt_id FROM project_alpha_project_v2_success_receipts WHERE command_id=?",
    ).bind(value.command.commandId).first<string>("receipt_id");
  const recoveryCapability = prepared?.transmission_started_at !== null
    ? await readClientHubNativeProjectCapability(env,principal,context) : null;
  const exactPreparedIdentity = !!prepared && prepared.request_json === requestJson
    && timingSafeEqual(String(prepared.request_sha256),requestSha256)
    && prepared.context_source_id === context.root.source_id
    && prepared.context_root_namespace === context.root.root_namespace
    && prepared.context_root_kind === context.root.kind && prepared.context_root_public_id === context.root.public_id
    && prepared.context_version === context.contextVersion && prepared.actor_staff_id === currentActor.staffId
    && prepared.actor_access_subject === currentActor.accessSubject && prepared.actor_email === currentActor.email
    && prepared.actor_admission_version === currentActor.admissionVersion
    && prepared.actor_profile_version === currentActor.profileVersion
    && prepared.source_instance_id === selected.connection.expectedSourceInstanceId
    && prepared.application_id === selected.connection.expectedApplicationId
    && prepared.history_epoch_id === selected.connection.expectedHistoryEpoch;
  if (!exactPreparedIdentity)
    throw new HTTPException(409, { message: "The prepared native project request or authority changed" });
  const recoveringWithCurrentAuthority = !!knownAcknowledgement && recoveryCapability?.available === true
    && includesPreparedScopes(recoveryCapability.scopes,value.scopes);
  const recoveringUncertain = !knownAcknowledgement && prepared?.transmission_started_at !== null
    && recoveryCapability?.available === true
    && includesPreparedScopes(recoveryCapability.scopes,value.scopes)
    && await authorizeClientHubUncertainRecovery(env,value.command.commandId,generation,currentActor.verifiedUntil);
  if (!recoveringWithCurrentAuthority && !recoveringUncertain && prepared.authority_generation !== generation)
    throw new HTTPException(409, { message: "The prepared native project request or authority changed" });
  const action: ProjectAlphaProjectV2CommandProducerAction = value.operation === "create"
    ? { sourceId: value.sourceId, actor: { ...currentActor, scopes: value.scopes }, operation: "create" as const,
      local: value.local, directory: value.directory, command: value.command }
    : { sourceId: value.sourceId, actor: { ...currentActor, scopes: value.scopes }, operation: "update" as const,
      local: value.local, command: { commandId:value.command.commandId,externalId:value.command.externalId,
        expectedRevision:value.command.expectedRevision,expectedProjectionSha256:value.command.expectedProjectionSha256,
        expectedAuthorizationGeneration:value.command.expectedAuthorizationGeneration,project:value.command.project } };
  if (!recoveringWithCurrentAuthority && !recoveringUncertain) {
    const planned = await planProjectAlphaProjectV2Command(env, action,
      env.OPS_DB.prepare(`UPDATE client_hub_native_project_preparations
        SET transmission_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE command_id=? AND transmission_started_at IS NULL
          AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now') AND request_json=? AND request_sha256=?
          AND context_version=? AND actor_staff_id=? AND authority_generation=?
          AND source_instance_id=? AND application_id=? AND history_epoch_id=?`).bind(value.command.commandId,
        requestJson,requestSha256,context.contextVersion,currentActor.staffId,generation,
        selected.connection.expectedSourceInstanceId,selected.connection.expectedApplicationId,
        selected.connection.expectedHistoryEpoch));
    if (planned.status !== "queued") return safeOutcome(planned);
  }
  const started = await env.OPS_DB.withSession("first-primary").prepare(`UPDATE client_hub_native_project_preparations
    SET transmission_started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE command_id=? AND transmission_started_at IS NULL AND expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
      AND request_json=? AND request_sha256=? AND context_version=? AND actor_staff_id=? AND authority_generation=?
      AND source_instance_id=? AND application_id=? AND history_epoch_id=?`).bind(value.command.commandId,requestJson,requestSha256,
    context.contextVersion,currentActor.staffId,generation,selected.connection.expectedSourceInstanceId,
    selected.connection.expectedApplicationId,selected.connection.expectedHistoryEpoch).run();
  if (!started.meta.changes && prepared.transmission_started_at === null) {
    const concurrent = await env.OPS_DB.withSession("first-primary").prepare(
      "SELECT transmission_started_at,request_sha256 FROM client_hub_native_project_preparations WHERE command_id=?",
    ).bind(value.command.commandId).first<{ transmission_started_at: string | null; request_sha256: string }>();
    if (!concurrent?.transmission_started_at || !timingSafeEqual(concurrent.request_sha256,requestSha256))
      throw new HTTPException(409, { message: "The prepared native project request expired or changed before transmission" });
  }
  const dispatched = await dispatchProjectAlphaProjectV2PendingCommand(env, value.sourceId, value.command.commandId, send);
  if (dispatched.status !== "acknowledged") return safeOutcome(dispatched);
  if(!await ensureClientHubPostAckContinuation(env,value.command.commandId,dispatched.receiptId,currentActor,generation,value.scopes))
    return {status:"blocked",reason:"authority"};
  const selectedSettlement = await withEnabledConfiguredProjectAlphaApiV2Connection(env, value.sourceId,
    configured => settleProjectAlphaProjectV2Read(env, dispatched.receiptId, configured, send));
  if (selectedSettlement.status !== "enabled") return { status: "blocked", reason: "configuration" };
  if (selectedSettlement.value.status !== "settled") return safeOutcome(selectedSettlement.value);
  return safeOutcome(await activateProjectAlphaProjectV2Canonical(env, selectedSettlement.value.settlementId));
}
