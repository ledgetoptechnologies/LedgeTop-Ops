import { parseClientOnboardingFields, type ClientOnboardingFields } from "@ltds/shared";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

export type ClientOnboardingSubmissionReview = Readonly<{
  invitationId: string;
  submissionId: string;
  fieldsSha256: string;
  submittedAt: string;
  targetClientRecordId: string | null;
  scopes: readonly Readonly<{ businessAreaId: string; divisionId: string | null }>[];
  fields: ClientOnboardingFields;
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const denied = (): never => { throw Error("client_onboarding_review_denied"); };

type ReviewRow = {
  invitation_id: string;
  submission_id: string;
  fields_json: string;
  fields_sha256: string;
  submitted_at: string;
  target_client_record_id: string | null;
  scopes_json: string;
};

/**
 * Reads one immutable submission only when the current native actor can edit
 * every scope in its review context. The query deliberately mirrors the
 * decision authority: proposed issuance scopes for new clients, and the full
 * current resource scope set for existing clients. Any matching deny wins.
 */
export async function readClientOnboardingSubmissionForReview(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  submissionId: unknown): Promise<ClientOnboardingSubmissionReview> {
  try {
    if (typeof submissionId !== "string" || !UUID.test(submissionId)
      || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const actor = authenticated.identity;
    const row = await database.withSession("first-primary").prepare(`WITH candidate AS (
      SELECT submission.invitation_id,submission.submission_id,submission.fields_json,
        submission.fields_sha256,submission.created_at AS submitted_at,
        invitation.target_client_record_id,issuance.scopes_json
      FROM client_onboarding_submissions submission
      JOIN client_onboarding_invitations invitation ON invitation.invitation_id=submission.invitation_id
      JOIN client_onboarding_issuance_commands issuance ON issuance.invitation_id=submission.invitation_id
      JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
        AND admission.bound_access_subject=? AND admission.version=?
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
        AND profile.version=? AND profile.login_email=?
      WHERE submission.submission_id=? AND invitation.state='submitted' AND invitation.version=2
    ), review_scopes AS (
      SELECT candidate.submission_id,candidate.target_client_record_id AS record_id,
        CASE WHEN candidate.target_client_record_id IS NULL THEN 'new' ELSE 'existing' END AS target_kind,
        json_extract(scope.value,'$.businessAreaId') AS business_area_id,
        json_extract(scope.value,'$.divisionId') AS division_id
      FROM candidate,json_each(candidate.scopes_json) scope
      WHERE candidate.target_client_record_id IS NULL
      UNION ALL
      SELECT candidate.submission_id,candidate.target_client_record_id,'existing',
        scope.business_area_id,scope.division_id
      FROM candidate JOIN native_directory_resource_scopes scope
        ON scope.record_id=candidate.target_client_record_id AND scope.active=1
      WHERE candidate.target_client_record_id IS NOT NULL
    )
    SELECT candidate.invitation_id,candidate.submission_id,candidate.fields_json,
      candidate.fields_sha256,candidate.submitted_at,candidate.target_client_record_id,
      (SELECT json_group_array(json_object('businessAreaId',business_area_id,'divisionId',division_id))
        FROM (SELECT business_area_id,division_id FROM review_scopes
          WHERE submission_id=candidate.submission_id ORDER BY business_area_id,division_id)) AS scopes_json
    FROM candidate
    WHERE (SELECT count(*) FROM review_scopes WHERE submission_id=candidate.submission_id) BETWEEN 1 AND 128
      AND NOT EXISTS(SELECT 1 FROM review_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id AND division.active=1
        WHERE scope.submission_id=candidate.submission_id
          AND (area.id IS NULL OR (scope.division_id IS NOT NULL AND division.id IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM review_scopes scope
        WHERE scope.submission_id=candidate.submission_id AND NOT EXISTS(
          SELECT 1 FROM native_directory_grants grant_row
          WHERE grant_row.staff_id=? AND grant_row.permission='directory.profile.edit'
            AND grant_row.effect='allow' AND grant_row.active=1
            AND (grant_row.scope_kind='global'
              OR (scope.target_kind='existing' AND grant_row.scope_kind='resource' AND grant_row.resource_id=scope.record_id)
              OR (scope.target_kind='existing' AND grant_row.scope_kind='assigned' AND EXISTS(
                SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=scope.record_id
                  AND assignment.staff_id=? AND assignment.active=1))
              OR (grant_row.scope_kind='business_area' AND grant_row.business_area_id=scope.business_area_id)
              OR (grant_row.scope_kind='division' AND grant_row.division_id=scope.division_id))))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny_row
        WHERE deny_row.staff_id=? AND deny_row.permission='directory.profile.edit'
          AND deny_row.effect='deny' AND deny_row.active=1
          AND EXISTS(SELECT 1 FROM review_scopes scope WHERE scope.submission_id=candidate.submission_id
            AND (deny_row.scope_kind='global'
              OR (scope.target_kind='existing' AND deny_row.scope_kind='resource' AND deny_row.resource_id=scope.record_id)
              OR (scope.target_kind='existing' AND deny_row.scope_kind='assigned' AND EXISTS(
                SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=scope.record_id
                  AND assignment.staff_id=? AND assignment.active=1))
              OR (deny_row.scope_kind='business_area' AND deny_row.business_area_id=scope.business_area_id)
              OR (deny_row.scope_kind='division' AND deny_row.division_id=scope.division_id))))
    LIMIT 1`).bind(actor.staffId, actor.verifiedAccessSubject, authenticated.admissionVersion,
      actor.profileVersion, actor.email, submissionId, actor.staffId, actor.staffId,
      actor.staffId, actor.staffId).first<ReviewRow>();
    if (!row || row.submission_id !== submissionId || !UUID.test(row.invitation_id)
      || !HEX.test(row.fields_sha256) || !Number.isFinite(Date.parse(row.submitted_at))) return denied();
    const rawScopes: unknown = JSON.parse(row.scopes_json);
    if (!Array.isArray(rawScopes) || rawScopes.length < 1 || rawScopes.length > 128) return denied();
    const scopes = rawScopes.map(value => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return denied();
      const scope = value as Record<string, unknown>;
      if (Object.keys(scope).length !== 2 || typeof scope.businessAreaId !== "string"
        || (scope.divisionId !== null && typeof scope.divisionId !== "string")) return denied();
      return Object.freeze({ businessAreaId: scope.businessAreaId, divisionId: scope.divisionId as string | null });
    });
    const fields = parseClientOnboardingFields(JSON.parse(row.fields_json));
    return Object.freeze({ invitationId: row.invitation_id, submissionId: row.submission_id,
      fieldsSha256: row.fields_sha256, submittedAt: row.submitted_at,
      targetClientRecordId: row.target_client_record_id, scopes: Object.freeze(scopes), fields });
  } catch { return denied(); }
}
