import { resolveProjectAlphaApiV2Connection } from "./project-alpha-api-v2-connections";
import { selectGrant } from "./native-directory-profile-routes";
import { currentDirectoryRelationshipRecoveryAdministrator, type DirectoryRelationshipRecoveryActor,
  type DirectoryRelationshipRecoveryEnvironment } from "./project-alpha-directory-relationship-generation-recovery";
import { validateDirectoryRelationshipRecoveryReviewCurrent }
  from "./project-alpha-directory-relationship-generation-recovery-service";

type Actor = DirectoryRelationshipRecoveryActor & Readonly<{ verifiedUntil: string }>;
type SelectedGrant = Readonly<{ recordId: string; permission: string; grantId: string }>;
type ReviewRow = Readonly<{
  review_id: string; client_record_id: string; source_id: string; source_instance_id: string; application_id: string;
  history_epoch_id: string; destination_origin: string; predecessor_command_id: string; intended_organization_record_id: string;
  expected_client_revision: string; expected_organization_revision: string; observed_authorization_generation: string;
  evidence_sha256: string; reviewer_staff_id: string; reviewer_access_subject: string; reviewer_email: string;
  reviewer_admission_version: number; reviewer_profile_version: number; selected_grants_json: string;
  expires_at: string; state: "open" | "authorized" | "expired" | "invalidated";
  authorization_id: string | null; outbox_state: "pending" | "leased" | "acknowledged" | "terminal" | null;
  attempts: number | null; updated_at: string | null;
}>;

export type DirectoryRelationshipRecoveryStatus =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "review_ready"; review: Readonly<{ reviewId: string; recordId: string; sourceId: string;
      predecessorCommandId: string; evidenceSha256: string; clientRevision: string; organizationRevision: string;
      organizationRecordId: string; remoteParentPublicId: null; observedAuthorizationGeneration: string; expiresAt: string }> }>
  | Readonly<{ status: "review_expired" | "evidence_changed"; sourceId: string }>
  | Readonly<{ status: "authority_revoked" }>
  | Readonly<{ status: "prepared" | "dispatch_pending" | "acknowledged" | "terminal"; sourceId: string; updatedAt: string }>
  | Readonly<{ status: "uncertain"; reason: "storage_or_contract" }>;

const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const PERMISSIONS = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"] as const;
function recordId(value: string): boolean { return value.length > 0 && Array.from(value).length <= 191 && !/\p{C}/u.test(value)
  && new TextEncoder().encode(value).byteLength <= 764; }
function actorFresh(actor: Actor): boolean { return Number.isFinite(Date.parse(actor.verifiedUntil)) && Date.parse(actor.verifiedUntil) > Date.now(); }

async function exactGrants(db: D1Database, actor: Actor, client: string, organization: string): Promise<SelectedGrant[] | null> {
  if (!actorFresh(actor) || client === organization) return null;
  const result: SelectedGrant[] = [];
  for (const resource of [client, organization]) for (const permission of PERMISSIONS) {
    const grantId = await selectGrant(db, actor.staffId, permission, resource, [], false);
    if (!grantId) return null;
    result.push({ recordId: resource, permission, grantId });
  }
  return actorFresh(actor) ? result : null;
}

function review(row: ReviewRow) {
  return { reviewId: row.review_id, recordId: row.client_record_id, sourceId: row.source_id,
    predecessorCommandId: row.predecessor_command_id, evidenceSha256: row.evidence_sha256,
    clientRevision: row.expected_client_revision, organizationRevision: row.expected_organization_revision,
    organizationRecordId: row.intended_organization_record_id, remoteParentPublicId: null,
    observedAuthorizationGeneration: row.observed_authorization_generation, expiresAt: row.expires_at } as const;
}

/** Read-only re-entry. This function never refreshes evidence, persists state,
 * reserves a command, dispatches, or interprets private outcome JSON. */
export async function readDirectoryRelationshipRecoveryStatus(env: DirectoryRelationshipRecoveryEnvironment,
  input: Readonly<{ recordId: string; sourceId?: string }>, actor: Actor): Promise<DirectoryRelationshipRecoveryStatus> {
  if (env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED !== "true") return { status: "none" };
  if (!recordId(input.recordId) || input.sourceId !== undefined && !SOURCE.test(input.sourceId) || !actorFresh(actor))
    return { status: "authority_revoked" };
  try {
    if (!await currentDirectoryRelationshipRecoveryAdministrator(env.OPS_DB, actor))
      return { status: "authority_revoked" };
    // The newest review for the record (and optional source) is authoritative. We intentionally do not
    // fall back to an older actor-owned review: a newer review by another principal blocks re-entry.
    const select = `SELECT review.review_id,review.client_record_id,
        review.source_id,review.source_instance_id,review.application_id,review.history_epoch_id,review.destination_origin,
        review.predecessor_command_id,review.intended_organization_record_id,review.expected_client_revision,
        review.expected_organization_revision,review.observed_authorization_generation,review.evidence_sha256,
        review.reviewer_staff_id,review.reviewer_access_subject,review.reviewer_email,review.reviewer_admission_version,
        review.reviewer_profile_version,review.selected_grants_json,review.expires_at,review.state,
        recovery.authorization_id,outbox.state outbox_state,outbox.attempts,outbox.updated_at
      FROM project_alpha_directory_relationship_generation_recovery_reviews review
      LEFT JOIN project_alpha_directory_relationship_generation_recoveries recovery ON recovery.review_id=review.review_id
      LEFT JOIN project_alpha_directory_relationship_recovery_outbox outbox ON outbox.authorization_id=recovery.authorization_id
      WHERE review.client_record_id=?${input.sourceId === undefined ? "" : " AND review.source_id=?"}
      ORDER BY review.created_at DESC,review.review_id DESC LIMIT 1`;
    const statement = env.OPS_DB.withSession("first-primary").prepare(select);
    const rows = await (input.sourceId === undefined ? statement.bind(input.recordId) : statement.bind(input.recordId, input.sourceId)).all<ReviewRow>();
    const row = rows.results[0];
    if (!row) return { status: "none" };
    if (row.reviewer_staff_id !== actor.staffId || row.reviewer_access_subject !== actor.accessSubject
      || row.reviewer_email !== actor.email || row.reviewer_admission_version !== actor.admissionVersion
      || row.reviewer_profile_version !== actor.profileVersion)
      return { status: "authority_revoked" };
    const grants = await exactGrants(env.OPS_DB, actor, row.client_record_id, row.intended_organization_record_id);
    if (!grants || JSON.stringify(grants) !== row.selected_grants_json)
      return { status: "authority_revoked" };
    const connection = resolveProjectAlphaApiV2Connection(env, row.source_id);
    if (!connection.enabled || connection.connection.expectedSourceInstanceId !== row.source_instance_id
      || connection.connection.expectedApplicationId !== row.application_id
      || connection.connection.expectedHistoryEpoch !== row.history_epoch_id
      || new URL(connection.connection.baseUrl).origin !== row.destination_origin)
      return { status: "evidence_changed", sourceId: row.source_id };
    if (row.state === "expired" || row.state === "open" && Date.parse(row.expires_at) <= Date.now())
      return { status: "review_expired", sourceId: row.source_id };
    if (row.state === "invalidated") return { status: "evidence_changed", sourceId: row.source_id };
    if (row.state === "open") {
      const current = await validateDirectoryRelationshipRecoveryReviewCurrent(env, { recordId: row.client_record_id,
        sourceId: row.source_id, reviewId: row.review_id, evidenceSha256: row.evidence_sha256 }, actor);
      if (current !== "current") return { status: current, sourceId: row.source_id };
      return { status: "review_ready", review: review(row) };
    }
    if (!row.authorization_id || !row.outbox_state || row.attempts === null || !row.updated_at)
      return { status: "uncertain", reason: "storage_or_contract" };
    if (row.outbox_state === "acknowledged" || row.outbox_state === "terminal")
      return { status: row.outbox_state, sourceId: row.source_id, updatedAt: row.updated_at };
    return { status: row.outbox_state === "pending" && row.attempts === 0 ? "prepared" : "dispatch_pending",
      sourceId: row.source_id, updatedAt: row.updated_at };
  } catch { return { status: "uncertain", reason: "storage_or_contract" }; }
}
