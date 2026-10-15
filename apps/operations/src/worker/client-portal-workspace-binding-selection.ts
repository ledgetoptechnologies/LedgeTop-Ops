import { z } from "zod";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const bounded = z.string().min(1).max(200).refine(value =>
  value === value.trim() && !/\p{C}/u.test(value));
const commandSchema = z.object({
  selectionId: uuid,
  recordId: uuid,
  activationId: uuid,
  workspaceId: bounded,
  sourceWorkspaceId: bounded,
  checkpoint: z.object({
    sourceGeneration: bounded,
    sourceSequence: z.number().int().positive().safe(),
    snapshotGenerationId: bounded,
  }).strict(),
}).strict();

export type PortalWorkspaceBindingSelectionCommand = z.infer<typeof commandSchema>;
export type PortalWorkspaceBindingSelectionReceipt = Readonly<{
  selectionId: string;
  clientAuthorityId: string;
  recordId: string;
  activationId: string;
  workspaceId: string;
  sourceId: string;
  sourceWorkspaceId: string;
  rootType: "organization" | "standalone_client";
  rootPublicId: string;
  checkpoint: PortalWorkspaceBindingSelectionCommand["checkpoint"];
  state: "inactive";
  replayed: boolean;
}>;

type Source = {
  record_version: number;
  source_id: string;
  source_instance_id: string;
  application_id: string;
  history_epoch_id: string;
  resource_type: "organization" | "client";
  project_alpha_public_id: string;
};
type Saved = {
  selection_id: string;
  request_sha256: string;
  client_authority_id: string;
  record_id: string;
  activation_id: string;
  workspace_id: string;
  source_id: string;
  source_workspace_id: string;
  root_type: "organization" | "standalone_client";
  root_public_id: string;
  checkpoint_source_generation: string;
  checkpoint_source_sequence: number;
  checkpoint_snapshot_generation_id: string;
  reviewed_by_staff_id: string;
  reviewed_access_subject: string;
  reviewed_admission_version: number;
  reviewed_profile_version: number;
  reviewed_grant_generation: number;
};
const denied = (): never => { throw Error("portal_workspace_binding_selection_denied"); };
const savedSql = `SELECT selection_id,request_sha256,client_authority_id,record_id,activation_id,
  workspace_id,source_id,source_workspace_id,root_type,root_public_id,checkpoint_source_generation,
  checkpoint_source_sequence,checkpoint_snapshot_generation_id,reviewed_by_staff_id,
  reviewed_access_subject,reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation
  FROM client_portal_workspace_binding_selections WHERE selection_id=?`;

const receipt = (row: Saved, replayed: boolean): PortalWorkspaceBindingSelectionReceipt => ({
  selectionId: row.selection_id, clientAuthorityId: row.client_authority_id,
  recordId: row.record_id, activationId: row.activation_id, workspaceId: row.workspace_id,
  sourceId: row.source_id, sourceWorkspaceId: row.source_workspace_id,
  rootType: row.root_type, rootPublicId: row.root_public_id,
  checkpoint: { sourceGeneration: row.checkpoint_source_generation,
    sourceSequence: row.checkpoint_source_sequence,
    snapshotGenerationId: row.checkpoint_snapshot_generation_id },
  state: "inactive", replayed,
});
async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
    .map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** One explicit PA activation, not a name/email match or the rebuildable Client Hub cache. */
async function currentSource(db: D1Database, command: PortalWorkspaceBindingSelectionCommand): Promise<Source | null> {
  return db.withSession("first-primary").prepare(`SELECT record.current_version record_version,
    activation.source_id,activation.source_instance_id,activation.application_id,
    activation.history_epoch_id,activation.resource_type,activation.project_alpha_public_id
    FROM project_alpha_existing_directory_binding_activation_receipts activation
    JOIN operations_directory_records record ON record.record_id=activation.record_id
    WHERE activation.activation_id=? AND activation.record_id=?
      AND record.current_version=activation.local_record_version
      AND record.record_kind=activation.resource_type`)
    .bind(command.activationId, command.recordId).first<Source>();
}

/** Rechecked for retries as well as first writes. The INSERT trigger repeats this atomically. */
async function currentGrantGeneration(db: D1Database, actor: AuthenticatedNativeStaffWithAdmissionVersion,
  recordId: string): Promise<number | null> {
  return db.withSession("first-primary").prepare(`SELECT generation.generation
    FROM native_staff_admissions admission
    JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN native_directory_grant_generations generation ON generation.staff_id=admission.staff_id
    WHERE admission.staff_id=? AND admission.active=1 AND admission.bound_access_subject=?
      AND admission.version=? AND profile.version=?
      AND EXISTS(SELECT 1 FROM staff_role_assignments role WHERE role.staff_id=admission.staff_id
        AND role.role_id='role-owner' AND role.scope='global')
      AND EXISTS(SELECT 1 FROM native_directory_grants grant WHERE grant.staff_id=admission.staff_id
        AND grant.permission='directory.portal_access.manage' AND grant.effect='allow' AND grant.active=1
        AND (grant.scope_kind='global' OR (grant.scope_kind='resource' AND grant.resource_id=?)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny WHERE deny.staff_id=admission.staff_id
        AND deny.permission='directory.portal_access.manage' AND deny.effect='deny' AND deny.active=1
        AND (deny.scope_kind='global' OR (deny.scope_kind='resource' AND deny.resource_id=?)
          OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=? AND scope.active=1 AND scope.business_area_id=deny.business_area_id))
          OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM native_directory_resource_scopes scope
            WHERE scope.record_id=? AND scope.active=1 AND scope.division_id=deny.division_id))))`)
    .bind(actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion,
      actor.identity.profileVersion, recordId, recordId, recordId, recordId).first<number>("generation");
}

/**
 * Private, unmounted producer for an inactive portal-workspace selection.
 * It never sends to Client, creates membership, or changes Delivery/public links.
 * A later dispatcher must recheck freshness and obtain the separate Client receipt.
 */
export async function selectPortalWorkspaceBinding(db: D1Database,
  actor: AuthenticatedNativeStaffWithAdmissionVersion, raw: unknown,
): Promise<PortalWorkspaceBindingSelectionReceipt> {
  const parsed = commandSchema.safeParse(raw);
  const verifiedUntil = Date.parse(actor.verifiedUntil);
  if (!parsed.success || !Number.isFinite(verifiedUntil) || verifiedUntil <= Date.now()) return denied();
  const command = parsed.data;
  const source = await currentSource(db, command);
  if (!source || !Number.isSafeInteger(source.record_version) || source.record_version < 1
    || !/^[0-9a-f]{32}$/.test(source.project_alpha_public_id)
    || !["organization", "client"].includes(source.resource_type)) return denied();
  const generation = await currentGrantGeneration(db, actor, command.recordId);
  if (!Number.isSafeInteger(generation) || generation === null || generation < 1) return denied();
  const requestSha256 = await digest(JSON.stringify(["portal-workspace-binding-selection-v1",
    command.selectionId, command.recordId, command.activationId, command.workspaceId,
    command.sourceWorkspaceId, command.checkpoint.sourceGeneration, command.checkpoint.sourceSequence,
    command.checkpoint.snapshotGenerationId,
    actor.identity.staffId, actor.identity.verifiedAccessSubject, actor.admissionVersion,
    actor.identity.profileVersion, generation, source.record_version, source.source_id,
    source.source_instance_id, source.application_id, source.history_epoch_id,
    source.resource_type, source.project_alpha_public_id]));
  const prior = await db.withSession("first-primary").prepare(savedSql).bind(command.selectionId).first<Saved>();
  if (prior) {
    if (prior.request_sha256 !== requestSha256 || prior.reviewed_by_staff_id !== actor.identity.staffId
      || prior.reviewed_access_subject !== actor.identity.verifiedAccessSubject
      || prior.reviewed_admission_version !== actor.admissionVersion
      || prior.reviewed_profile_version !== actor.identity.profileVersion
      || prior.reviewed_grant_generation !== generation) return denied();
    return receipt(prior, true);
  }
  const clientAuthorityId = crypto.randomUUID();
  try {
    await db.prepare(`INSERT INTO client_portal_workspace_binding_selections
      (selection_id,request_sha256,client_authority_id,record_id,activation_id,record_version,
        source_id,source_instance_id,application_id,history_epoch_id,root_type,root_public_id,
        workspace_id,source_workspace_id,checkpoint_source_generation,checkpoint_source_sequence,
        checkpoint_snapshot_generation_id,reviewed_by_staff_id,reviewed_access_subject,
        reviewed_admission_version,reviewed_profile_version,reviewed_grant_generation,verified_until)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(
      command.selectionId, requestSha256, clientAuthorityId, command.recordId, command.activationId,
      source.record_version, source.source_id, source.source_instance_id, source.application_id,
      source.history_epoch_id, source.resource_type === "client" ? "standalone_client" : "organization",
      source.project_alpha_public_id, command.workspaceId, command.sourceWorkspaceId,
      command.checkpoint.sourceGeneration, command.checkpoint.sourceSequence,
      command.checkpoint.snapshotGenerationId, actor.identity.staffId,
      actor.identity.verifiedAccessSubject, actor.admissionVersion, actor.identity.profileVersion,
      generation, actor.verifiedUntil).run();
  } catch {
    const raced = await db.withSession("first-primary").prepare(savedSql).bind(command.selectionId).first<Saved>();
    const currentGeneration = await currentGrantGeneration(db, actor, command.recordId);
    const current = await currentSource(db, command);
    if (!raced || raced.request_sha256 !== requestSha256
      || raced.reviewed_by_staff_id !== actor.identity.staffId
      || raced.reviewed_access_subject !== actor.identity.verifiedAccessSubject
      || raced.reviewed_admission_version !== actor.admissionVersion
      || raced.reviewed_profile_version !== actor.identity.profileVersion
      || raced.reviewed_grant_generation !== generation || currentGeneration !== generation
      || current?.record_version !== source.record_version) return denied();
    return receipt(raced, true);
  }
  const saved = await db.withSession("first-primary").prepare(savedSql).bind(command.selectionId).first<Saved>();
  if (!saved || saved.request_sha256 !== requestSha256 || saved.client_authority_id !== clientAuthorityId)
    return denied();
  return receipt(saved, false);
}
