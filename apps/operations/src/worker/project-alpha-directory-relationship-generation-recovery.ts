import { parseDuplicateFreeJson } from "./bounded-json";
import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { isProjectAlphaDirectoryRelationshipCommand } from "./project-alpha-directory-relationship-api-v2";

export type DirectoryRelationshipRecoveryEnvironment = Readonly<{
  OPS_DB: D1Database;
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED?: string;
}>;

export type DirectoryRelationshipRecoveryActor = Readonly<{
  staffId: string; accessSubject: string; email: string;
  admissionVersion: number; profileVersion: number;
}>;
type SelectedGrant = Readonly<{ recordId: string; permission: string; grantId: string }>;
const PERMISSIONS = ["directory.profile.view", "directory.profile.edit", "directory.identity.link",
  "directory.enrollment.manage"] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const GENERATION = /^(?:0|[1-9][0-9]{0,18})$/;

function grants(value: string, client: string, organization: string): SelectedGrant[] | null {
  let parsed: unknown;
  try { parsed = parseDuplicateFreeJson(value); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== 8 || client === organization) return null;
  const result: SelectedGrant[] = [], seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).length !== 3 || typeof entry.recordId !== "string"
      || ![client, organization].includes(entry.recordId) || typeof entry.permission !== "string"
      || !PERMISSIONS.some(permission => permission === entry.permission)
      || typeof entry.grantId !== "string" || !entry.grantId) return null;
    const key = `${entry.recordId}\u0000${entry.permission}`;
    if (seen.has(key)) return null;
    seen.add(key);
    result.push({ recordId: entry.recordId, permission: entry.permission, grantId: entry.grantId });
  }
  return result;
}

/** Trusted server identity only. Administrator status and compensation/ownership
 * are independent; this matches the existing acl.ts global administrator policy. */
export async function currentDirectoryRelationshipRecoveryAdministrator(db: D1Database,
  actor: DirectoryRelationshipRecoveryActor): Promise<boolean> {
  return !!await db.withSession("first-primary").prepare(`SELECT 1 present FROM staff_users staff
    JOIN native_staff_admissions admission ON admission.staff_id=staff.id
    JOIN native_staff_profiles profile ON profile.staff_id=staff.id
    WHERE staff.id=? AND staff.status='active' AND staff.access_subject=?
      AND admission.active=1 AND admission.bound_access_subject=? AND admission.version=?
      AND profile.login_email=? AND profile.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments assignment WHERE assignment.staff_id=staff.id
        AND assignment.role_id IN ('role-owner','role-admin') AND assignment.scope='global')`)
    .bind(actor.staffId, actor.accessSubject, actor.accessSubject, actor.admissionVersion,
      actor.email, actor.profileVersion).first();
}

/** Check the selected grant itself, not a newly selected substitute. A scoped
 * deny wins even when another allow (including global) still exists. */
async function selectedGrantLive(db: D1Database, staffId: string, selected: SelectedGrant): Promise<boolean> {
  return !!await db.withSession("first-primary").prepare(`SELECT 1 present FROM native_directory_grants g
    WHERE g.id=? AND g.staff_id=? AND g.permission=? AND g.effect='allow' AND g.active=1
      AND (g.scope_kind='global' OR g.scope_kind='resource' AND g.resource_id=?
        OR g.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
        OR g.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=g.business_area_id)
        OR g.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=g.division_id))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants d WHERE d.staff_id=? AND d.permission=? AND d.effect='deny' AND d.active=1
        AND (d.scope_kind='global' OR d.scope_kind='resource' AND d.resource_id=?
          OR d.scope_kind='assigned' AND EXISTS(SELECT 1 FROM native_directory_assignments a WHERE a.record_id=? AND a.staff_id=? AND a.active=1)
          OR d.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.business_area_id=d.business_area_id)
          OR d.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes s WHERE s.record_id=? AND s.active=1 AND s.division_id=d.division_id)))`)
    .bind(selected.grantId, staffId, selected.permission, selected.recordId, selected.recordId, staffId,
      selected.recordId, selected.recordId, staffId, selected.permission, selected.recordId,
      selected.recordId, staffId, selected.recordId, selected.recordId).first();
}

type Reservation = {
  command_id: string; source_id: string; source_instance_id: string; application_id: string;
  history_epoch_id: string; destination_origin: string; client_record_id: string;
  intended_organization_record_id: string; command_json: string; selected_grants_json: string;
  actor_staff_id: string; actor_access_subject: string; actor_email: string;
  actor_admission_version: number; actor_profile_version: number; expires_at: string;
  observed_authorization_generation: string;
};

/** Live pre-send authority only. Historical ACK consumers must NOT call this:
 * revoking a grant cannot erase proof of an already-applied PA operation. */
export async function validateDirectoryRelationshipRecoveryReservation(env: DirectoryRelationshipRecoveryEnvironment,
  commandId: string): Promise<boolean> {
  // Before any new-table access: old deployments can remain safely default-off.
  const flag = env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED;
  const configuredSnapshot = env.PROJECT_ALPHA_API_V2_CONNECTIONS;
  if (flag !== "true" || !UUID.test(commandId)) return false;
  try {
    const row = await env.OPS_DB.withSession("first-primary").prepare(`SELECT outbox.command_id,outbox.source_id,
        outbox.source_instance_id,outbox.application_id,outbox.history_epoch_id,outbox.destination_origin,
        outbox.client_record_id,outbox.command_json,review.intended_organization_record_id,
        recovery.selected_grants_json,recovery.actor_staff_id,recovery.actor_access_subject,recovery.actor_email,
        recovery.actor_admission_version,recovery.actor_profile_version,recovery.expires_at,
        recovery.observed_authorization_generation
      FROM project_alpha_directory_relationship_recovery_outbox outbox
      JOIN project_alpha_directory_relationship_generation_recoveries recovery
        ON recovery.authorization_id=outbox.authorization_id AND recovery.successor_command_id=outbox.command_id
        AND recovery.successor_command_json=outbox.command_json AND recovery.successor_request_json=outbox.request_json
        AND recovery.predecessor_command_id=outbox.predecessor_command_id
      JOIN project_alpha_directory_relationship_generation_recovery_reviews review ON review.review_id=recovery.review_id
        AND review.state='authorized' AND review.evidence_sha256=recovery.evidence_sha256
        AND review.selected_grants_json=recovery.selected_grants_json
      JOIN project_alpha_directory_live_relationship_generation_recoveries live ON live.authorization_id=recovery.authorization_id
      JOIN project_alpha_active_directory_mappings client_mapping ON client_mapping.record_id=review.client_record_id
        AND client_mapping.resource_type='client' AND client_mapping.source_id=review.source_id
        AND client_mapping.source_instance_id=review.source_instance_id AND client_mapping.application_id=review.application_id
        AND client_mapping.history_epoch_id=review.history_epoch_id AND client_mapping.external_id=review.client_external_id
        AND client_mapping.project_alpha_public_id=review.client_public_id
      JOIN project_alpha_active_directory_mappings organization_mapping ON organization_mapping.record_id=review.intended_organization_record_id
        AND organization_mapping.resource_type='organization' AND organization_mapping.source_id=review.source_id
        AND organization_mapping.source_instance_id=review.source_instance_id AND organization_mapping.application_id=review.application_id
        AND organization_mapping.history_epoch_id=review.history_epoch_id AND organization_mapping.external_id=review.organization_external_id
        AND organization_mapping.project_alpha_public_id=review.organization_public_id
      JOIN project_alpha_directory_relationship_outbox predecessor ON predecessor.command_id=outbox.predecessor_command_id
        AND predecessor.state='terminal' AND predecessor.command_json=recovery.predecessor_command_json
        AND json_extract(predecessor.outcome_json,'$.httpStatus')=409
      JOIN operations_directory_client_organizations relation ON relation.client_record_id=outbox.client_record_id
        AND relation.relationship_version=outbox.relationship_version AND relation.organization_record_id=outbox.organization_record_id
      JOIN operations_directory_client_organization_history history ON history.client_record_id=outbox.client_record_id
        AND history.relationship_version=outbox.relationship_version AND history.mutation_id=predecessor.mutation_id
        AND history.organization_record_id=outbox.organization_record_id AND history.previous_organization_record_id IS NULL
      JOIN operations_directory_records client ON client.record_id=outbox.client_record_id AND client.record_kind='client'
        AND client.current_version=review.client_record_version AND client.current_version=history.client_record_version
      JOIN operations_directory_records organization ON organization.record_id=outbox.organization_record_id
        AND organization.record_kind='organization' AND organization.current_version=review.organization_record_version
        AND organization.current_version=history.organization_record_version
      WHERE outbox.command_id=? AND outbox.state IN ('pending','leased') AND recovery.recovery_depth=1
        AND recovery.root_command_id=predecessor.command_id AND review.predecessor_command_id=predecessor.command_id
        AND review.client_record_id=outbox.client_record_id AND review.relationship_version=outbox.relationship_version
        AND review.source_id=outbox.source_id AND review.source_instance_id=outbox.source_instance_id
        AND review.application_id=outbox.application_id AND review.history_epoch_id=outbox.history_epoch_id
        AND review.destination_origin=outbox.destination_origin
        AND recovery.source_id=outbox.source_id AND recovery.source_instance_id=outbox.source_instance_id
        AND recovery.application_id=outbox.application_id AND recovery.history_epoch_id=outbox.history_epoch_id
        AND recovery.destination_origin=outbox.destination_origin
        AND NOT EXISTS(SELECT 1 FROM project_alpha_api_v2_inventory_receipts receipt WHERE receipt.source_id=outbox.source_id
          AND receipt.source_instance_id=outbox.source_instance_id AND receipt.application_id=outbox.application_id
          AND receipt.history_epoch_id=outbox.history_epoch_id AND (length(receipt.authorization_generation)>length(recovery.observed_authorization_generation)
            OR length(receipt.authorization_generation)=length(recovery.observed_authorization_generation)
              AND receipt.authorization_generation>recovery.observed_authorization_generation))
        AND NOT EXISTS(SELECT 1 FROM project_alpha_directory_relationship_outbox later WHERE later.client_record_id=outbox.client_record_id
          AND later.source_id=outbox.source_id AND later.source_instance_id=outbox.source_instance_id
          AND later.application_id=outbox.application_id AND later.history_epoch_id=outbox.history_epoch_id
          AND later.relationship_version>outbox.relationship_version)`)
      .bind(commandId).first<Reservation>();
    if (!row || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= Date.now()
      || !GENERATION.test(row.observed_authorization_generation)
      || BigInt(row.observed_authorization_generation) >= 9223372036854775807n) return false;
    const configured = resolveProjectAlphaApiV2Connection({ PROJECT_ALPHA_API_V2_CONNECTIONS: configuredSnapshot }, row.source_id);
    if (!configured.enabled || configured.connection.expectedSourceInstanceId !== row.source_instance_id
      || configured.connection.expectedApplicationId !== row.application_id
      || configured.connection.expectedHistoryEpoch !== row.history_epoch_id
      || new URL(configured.connection.baseUrl).origin !== row.destination_origin) return false;
    const command: unknown = parseDuplicateFreeJson(row.command_json);
    if (!isProjectAlphaDirectoryRelationshipCommand("assign", command)
      || command.commandId !== commandId || command.expectedAuthorizationGeneration !== row.observed_authorization_generation) return false;
    const selected = grants(row.selected_grants_json, row.client_record_id, row.intended_organization_record_id);
    if (!selected || !await currentDirectoryRelationshipRecoveryAdministrator(env.OPS_DB, {
      staffId: row.actor_staff_id, accessSubject: row.actor_access_subject, email: row.actor_email,
      admissionVersion: row.actor_admission_version, profileVersion: row.actor_profile_version,
    })) return false;
    // Bounded eight checks, sequential so no unbounded D1 fan-out.
    for (const item of selected) if (!await selectedGrantLive(env.OPS_DB, row.actor_staff_id, item)) return false;
    return env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED === "true"
      && env.PROJECT_ALPHA_API_V2_CONNECTIONS === configuredSnapshot;
  } catch { return false; }
}
