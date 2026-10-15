import { resolveProjectAlphaApiV2Connection, type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { ReviewedImportDestination } from "./reviewed-import-enrollment-writer";

export type ReviewedImportEnrollmentSelection = Readonly<{
  recordId: string; kind: "client" | "organization"; expectedRecordVersion: number;
  expectedEnrollmentVersion: number; sourceIds: readonly string[];
}>;
export type ReviewedImportEnrollmentResolution =
  | Readonly<{ status: "resolved"; destinations: readonly ReviewedImportDestination[] }>
  | Readonly<{ status: "conflict"; reason: "stale_record" | "stale_enrollment" | "source_authority_unavailable" }>
  | Readonly<{ status: "denied" }>;
export type ReviewedImportEnrollmentReview = Readonly<{ recordId: string; kind: "client" | "organization";
  recordVersion: number; enrollmentVersion: number; sources: readonly Readonly<{ sourceId: string; enrolled: boolean }>[] }>;
export type ReviewedImportEnrollmentReviewOutcome = Readonly<{ status: "reviewed"; review: ReviewedImportEnrollmentReview }>
  | Readonly<{ status: "conflict"; reason: "source_authority_unavailable" }>;
type Environment = ProjectAlphaApiV2ConnectionEnvironment & Readonly<{ OPS_DB: D1Database }>;
type Mapping = { sourceId: string; sourceInstanceUUID: string; applicationUUID: string; historyEpoch: string;
  externalCanonicalId: string; origin: string; activationVersion: number; publicId: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/u;
const unavailable = (): ReviewedImportEnrollmentResolution => ({ status: "conflict", reason: "source_authority_unavailable" });

function destination(value: unknown): value is ReviewedImportDestination {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== 6 || typeof item.sourceId !== "string" || !SOURCE.test(item.sourceId)
    || typeof item.sourceInstanceUUID !== "string" || !UUID.test(item.sourceInstanceUUID)
    || typeof item.applicationUUID !== "string" || !UUID.test(item.applicationUUID)
    || typeof item.historyEpoch !== "string" || !UUID.test(item.historyEpoch)
    || typeof item.externalCanonicalId !== "string" || !item.externalCanonicalId
    || new TextEncoder().encode(item.externalCanonicalId).byteLength > 764 || /\p{C}/u.test(item.externalCanonicalId)
    || typeof item.origin !== "string") return false;
  try { return new URL(item.origin).origin === item.origin && item.origin.startsWith("https://"); } catch { return false; }
}
function same(left: ReviewedImportDestination, right: ReviewedImportDestination): boolean {
  return left.sourceId === right.sourceId && left.sourceInstanceUUID === right.sourceInstanceUUID
    && left.applicationUUID === right.applicationUUID && left.historyEpoch === right.historyEpoch
    && left.origin === right.origin && left.externalCanonicalId === right.externalCanonicalId;
}

/** Resolve explicit source choices to server-owned acquired mapping tuples.
 * This is not an authorization or fresh-inventory bypass: the authenticated
 * adapter selects grants, and the writer's atomic receipt triggers recheck
 * authority, inventory, settled work and provenance at commit time. */
export async function resolveReviewedImportEnrollmentDestinations(env: Environment,
  selection: ReviewedImportEnrollmentSelection): Promise<ReviewedImportEnrollmentResolution> {
  if (!selection || !["client", "organization"].includes(selection.kind) || typeof selection.recordId !== "string"
    || !selection.recordId || selection.recordId.length > 191 || /\p{C}/u.test(selection.recordId)
    || !Number.isSafeInteger(selection.expectedRecordVersion) || selection.expectedRecordVersion < 1
    || !Number.isSafeInteger(selection.expectedEnrollmentVersion) || selection.expectedEnrollmentVersion < 0
    || !Array.isArray(selection.sourceIds) || selection.sourceIds.length < 1 || selection.sourceIds.length > 16
    || !selection.sourceIds.every(id => typeof id === "string" && SOURCE.test(id))
    || new Set(selection.sourceIds).size !== selection.sourceIds.length) return unavailable();
  try {
    const db = env.OPS_DB.withSession("first-primary");
    const record = await db.prepare(`SELECT record.record_kind kind,record.current_version version
      FROM operations_directory_records record JOIN operations_directory_revisions revision
        ON revision.record_id=record.record_id AND revision.version=record.current_version WHERE record.record_id=?`)
      .bind(selection.recordId).first<{ kind: string; version: number }>();
    if (!record || record.kind !== selection.kind || record.version !== selection.expectedRecordVersion)
      return { status: "conflict", reason: "stale_record" };
    const enrollment = await db.prepare(`SELECT enrollment_version version,enrollment_kind kind,destinations_json destinations
      FROM effective_native_directory_enrollments WHERE record_id=?`).bind(selection.recordId)
      .first<{ version: number; kind: string; destinations: string }>();
    if ((enrollment?.version ?? 0) !== selection.expectedEnrollmentVersion)
      return { status: "conflict", reason: "stale_enrollment" };
    // Native-create history has its own immutable admission. Never add a
    // missing history epoch or convert that history through an import editor.
    if (enrollment && enrollment.kind !== "reviewed_import") return unavailable();
    let prior: ReviewedImportDestination[] = [];
    if (enrollment) {
      const value: unknown = JSON.parse(enrollment.destinations);
      if (!Array.isArray(value) || value.length < 1 || value.length > 16 || !value.every(destination)
        || new Set(value.map(item => item.sourceId)).size !== value.length) return unavailable();
      prior = value;
      if (prior.some(item => !selection.sourceIds.includes(item.sourceId))) return unavailable();
    }
    const destinations: ReviewedImportDestination[] = [];
    for (const sourceId of [...selection.sourceIds].sort()) {
      const configured = resolveProjectAlphaApiV2Connection(env, sourceId);
      if (!configured.enabled || !configured.connection.expectedHistoryEpoch) return unavailable();
      const connection = configured.connection;
      const rows = (await db.prepare(`SELECT mapping.source_id sourceId,mapping.source_instance_id sourceInstanceUUID,
          mapping.application_id applicationUUID,mapping.history_epoch_id historyEpoch,mapping.external_id externalCanonicalId,
          response.destination_origin origin,activation.local_record_version activationVersion,mapping.project_alpha_public_id publicId
        FROM project_alpha_active_directory_mappings mapping
        JOIN project_alpha_existing_directory_binding_activation_receipts activation
          ON mapping.mapping_kind='acquired' AND mapping.provenance_id=activation.activation_id
          AND mapping.record_id=activation.record_id AND mapping.resource_type=activation.resource_type
          AND mapping.source_id=activation.source_id AND mapping.source_instance_id=activation.source_instance_id
          AND mapping.application_id=activation.application_id AND mapping.history_epoch_id=activation.history_epoch_id
          AND mapping.external_id=activation.external_id AND mapping.project_alpha_public_id=activation.project_alpha_public_id
        JOIN project_alpha_existing_directory_binding_acquired_mapping_receipts acquired ON acquired.receipt_id=activation.acquired_receipt_id
          AND acquired.record_id=activation.record_id AND acquired.source_id=activation.source_id
          AND acquired.source_instance_id=activation.source_instance_id AND acquired.application_id=activation.application_id
          AND acquired.history_epoch_id=activation.history_epoch_id AND acquired.resource_type=activation.resource_type
          AND acquired.external_id=activation.external_id AND acquired.project_alpha_public_id=activation.project_alpha_public_id
          AND acquired.project_alpha_revision=activation.project_alpha_revision
        JOIN project_alpha_existing_directory_binding_acquisition_response_receipts response ON response.command_id=acquired.command_id
          AND response.source_instance_id=activation.source_instance_id AND response.application_id=activation.application_id
          AND response.history_epoch_id=activation.history_epoch_id AND response.resource_type=activation.resource_type
          AND response.external_id=activation.external_id AND response.project_alpha_public_id=activation.project_alpha_public_id
          AND response.project_alpha_revision=activation.project_alpha_revision
        JOIN project_alpha_existing_directory_binding_acquisition_commands command ON command.command_id=response.command_id
          AND command.record_id=activation.record_id AND command.source_id=activation.source_id
          AND command.source_instance_id=activation.source_instance_id AND command.application_id=activation.application_id
          AND command.history_epoch_id=activation.history_epoch_id AND command.resource_type=activation.resource_type
          AND command.external_id=activation.external_id AND command.project_alpha_public_id=activation.project_alpha_public_id
          AND command.project_alpha_revision=activation.project_alpha_revision
        JOIN project_alpha_existing_directory_binding_review_evidence review
          ON review.receipt_id=activation.review_receipt_id AND command.review_receipt_id=review.receipt_id
          AND review.record_id=activation.record_id AND review.source_id=activation.source_id
          AND review.source_instance_id=activation.source_instance_id AND review.application_id=activation.application_id
          AND review.history_epoch_id=activation.history_epoch_id AND review.resource_type=activation.resource_type
          AND review.external_id=activation.external_id AND review.project_alpha_public_id=activation.project_alpha_public_id
          AND review.project_alpha_revision=activation.project_alpha_revision
        WHERE mapping.record_id=? AND mapping.resource_type=? AND mapping.source_id=?
          AND mapping.source_instance_id=? AND mapping.application_id=? AND mapping.history_epoch_id=?
          AND (SELECT count(*) FROM project_alpha_active_directory_mappings candidate
            WHERE candidate.source_id=mapping.source_id AND candidate.source_instance_id=mapping.source_instance_id
              AND candidate.application_id=mapping.application_id AND candidate.history_epoch_id=mapping.history_epoch_id
              AND candidate.resource_type=mapping.resource_type AND (candidate.record_id=mapping.record_id
                OR candidate.external_id=mapping.external_id OR candidate.project_alpha_public_id=mapping.project_alpha_public_id))=1
        LIMIT 2`).bind(selection.recordId, selection.kind, sourceId, connection.expectedSourceInstanceId,
          connection.expectedApplicationId, connection.expectedHistoryEpoch).all<Mapping>()).results;
      if (rows.length !== 1) return unavailable();
      const row = rows[0]!;
      const proposed = { sourceId: row.sourceId, sourceInstanceUUID: row.sourceInstanceUUID,
        applicationUUID: row.applicationUUID, historyEpoch: row.historyEpoch, origin: row.origin,
        externalCanonicalId: row.externalCanonicalId };
      if (!destination(proposed) || proposed.origin !== connection.baseUrl || !/^[0-9a-f]{32}$/u.test(row.publicId)) return unavailable();
      const previous = prior.find(item => item.sourceId === sourceId);
      if (previous ? !same(previous, proposed) : row.activationVersion !== selection.expectedRecordVersion) return unavailable();
      destinations.push(proposed);
    }
    return { status: "resolved", destinations };
  } catch { return unavailable(); }
}

/** Read-only choices for an explicitly selected Operations record. Only source
 * aliases and current CAS versions leave this helper; no PA provenance does.
 * Every candidate is passed through the same exact server resolver as POST. */
export async function readReviewedImportEnrollmentReview(env: Environment,
  input: Readonly<{ recordId: string; kind: "client" | "organization" }>): Promise<ReviewedImportEnrollmentReviewOutcome> {
  const failed = (): ReviewedImportEnrollmentReviewOutcome => ({ status: "conflict", reason: "source_authority_unavailable" });
  if (!input || !["client", "organization"].includes(input.kind) || typeof input.recordId !== "string"
    || !input.recordId || input.recordId.length > 191 || /\p{C}/u.test(input.recordId)) return failed();
  try {
    const db = env.OPS_DB.withSession("first-primary");
    const record = await db.prepare(`SELECT record.current_version version FROM operations_directory_records record
      JOIN operations_directory_revisions revision ON revision.record_id=record.record_id AND revision.version=record.current_version
      WHERE record.record_id=? AND record.record_kind=?
        AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_state state WHERE state.record_id=record.record_id AND state.status<>'active')
        AND NOT EXISTS(SELECT 1 FROM operations_directory_lifecycle_fences fence WHERE fence.record_id=record.record_id)`)
      .bind(input.recordId, input.kind).first<{ version: number }>();
    if (!record || !Number.isSafeInteger(record.version) || record.version < 1) return failed();
    const enrollment = await db.prepare(`SELECT enrollment_version version,enrollment_kind kind,destinations_json destinations
      FROM effective_native_directory_enrollments WHERE record_id=?`).bind(input.recordId)
      .first<{ version: number; kind: string; destinations: string }>();
    if (enrollment && (enrollment.kind !== "reviewed_import" || !Number.isSafeInteger(enrollment.version) || enrollment.version < 1)) return failed();
    let existing: string[] = [];
    if (enrollment) {
      const prior: unknown = JSON.parse(enrollment.destinations);
      if (!Array.isArray(prior) || prior.length < 1 || prior.length > 16 || !prior.every(destination)
        || new Set(prior.map(item => item.sourceId)).size !== prior.length) return failed();
      existing = prior.map(item => item.sourceId).sort();
    }
    const selection = { recordId: input.recordId, kind: input.kind, expectedRecordVersion: record.version,
      expectedEnrollmentVersion: enrollment?.version ?? 0 };
    if (existing.length && (await resolveReviewedImportEnrollmentDestinations(env, { ...selection, sourceIds: existing })).status !== "resolved")
      return failed();
    const candidates = (await db.prepare(`SELECT DISTINCT source_id sourceId FROM project_alpha_active_directory_mappings
      WHERE record_id=? AND resource_type=? AND mapping_kind='acquired' ORDER BY source_id LIMIT 65`)
      .bind(input.recordId, input.kind).all<{ sourceId: string }>()).results;
    if (candidates.length > 64 || candidates.some(row => !SOURCE.test(row.sourceId))) return failed();
    const sources = existing.map(sourceId => ({ sourceId, enrolled: true }));
    if (existing.length < 16) for (const candidate of candidates) {
      if (existing.includes(candidate.sourceId)) continue;
      const result = await resolveReviewedImportEnrollmentDestinations(env, { ...selection, sourceIds: [...existing, candidate.sourceId] });
      if (result.status === "resolved") sources.push({ sourceId: candidate.sourceId, enrolled: false });
    }
    return { status: "reviewed", review: { recordId: input.recordId, kind: input.kind, recordVersion: record.version,
      enrollmentVersion: enrollment?.version ?? 0, sources: sources.sort((left, right) => left.sourceId.localeCompare(right.sourceId)) } };
  } catch { return failed(); }
}
