import { listEnabledProjectAlphaApiV2SourceIds,
  type ProjectAlphaApiV2ConnectionEnvironment } from "./project-alpha-api-v2-connections";
import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";

export type ClientOnboardingEnrollmentChoices = Readonly<{
  sourceIds: readonly string[];
}>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_ENABLED_SOURCES = 16;
const denied = (): never => { throw Error("client_onboarding_enrollment_discovery_denied"); };
const unavailable = (): never => { throw Error("client_onboarding_enrollment_discovery_unavailable"); };

function submittedId(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return denied();
  const row = value as Record<string, unknown>;
  if (Reflect.ownKeys(row).length !== 1 || !Object.hasOwn(row, "submissionId")
    || typeof row.submissionId !== "string" || !UUID.test(row.submissionId)) return denied();
  return row.submissionId;
}

/**
 * Read-only discovery is bound to an immutable submitted onboarding record.
 * Target kind and authority scopes come from D1, not the browser. The single
 * first-primary statement rechecks native admission/profile pins and requires
 * both permissions across every current issuance/target scope.
 */
export async function readClientOnboardingEnrollmentChoices(database: D1Database,
  environment: ProjectAlphaApiV2ConnectionEnvironment,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  rawRequest: unknown): Promise<ClientOnboardingEnrollmentChoices> {
  try {
    if (Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const submissionId = submittedId(rawRequest);
    const actor = authenticated.identity;
    const row = await database.withSession("first-primary").prepare(`WITH candidate AS (
      SELECT submission.submission_id,invitation.target_client_record_id,issuance.scopes_json
      FROM client_onboarding_submissions submission
      JOIN client_onboarding_invitations invitation ON invitation.invitation_id=submission.invitation_id
      JOIN client_onboarding_issuance_commands issuance ON issuance.invitation_id=submission.invitation_id
      JOIN native_staff_admissions admission ON admission.staff_id=? AND admission.active=1
        AND admission.bound_access_subject=? AND admission.version=?
      JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
        AND profile.version=? AND profile.login_email=?
      WHERE submission.submission_id=? AND invitation.state='submitted' AND invitation.version=2
    ), target_scopes AS (
      SELECT candidate.submission_id,candidate.target_client_record_id AS record_id,
        'new' AS target_kind,json_extract(scope.value,'$.businessAreaId') AS business_area_id,
        json_extract(scope.value,'$.divisionId') AS division_id
      FROM candidate,json_each(candidate.scopes_json) scope
      WHERE candidate.target_client_record_id IS NULL
      UNION ALL
      SELECT candidate.submission_id,candidate.target_client_record_id,'existing',
        scope.business_area_id,scope.division_id
      FROM candidate JOIN native_directory_resource_scopes scope
        ON scope.record_id=candidate.target_client_record_id AND scope.active=1
      WHERE candidate.target_client_record_id IS NOT NULL
    ), needed_permissions(permission) AS (
      SELECT 'directory.profile.view' UNION ALL SELECT 'directory.enrollment.manage'
    )
    SELECT candidate.submission_id FROM candidate
    WHERE (SELECT count(*) FROM target_scopes WHERE submission_id=candidate.submission_id) BETWEEN 1 AND 128
      AND NOT EXISTS(SELECT 1 FROM target_scopes scope
        LEFT JOIN native_business_areas area ON area.id=scope.business_area_id AND area.active=1
        LEFT JOIN native_business_divisions division ON division.id=scope.division_id
          AND division.business_area_id=scope.business_area_id AND division.active=1
        WHERE scope.submission_id=candidate.submission_id
          AND (area.id IS NULL OR (scope.division_id IS NOT NULL AND division.id IS NULL)))
      AND NOT EXISTS(SELECT 1 FROM needed_permissions needed CROSS JOIN target_scopes scope
        WHERE scope.submission_id=candidate.submission_id AND NOT EXISTS(
          SELECT 1 FROM native_directory_grants allow_row
          WHERE allow_row.staff_id=? AND allow_row.permission=needed.permission
            AND allow_row.effect='allow' AND allow_row.active=1
            AND (allow_row.scope_kind='global'
              OR (scope.target_kind='existing' AND allow_row.scope_kind='resource' AND allow_row.resource_id=scope.record_id)
              OR (scope.target_kind='existing' AND allow_row.scope_kind='assigned' AND EXISTS(
                SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=scope.record_id
                  AND assignment.staff_id=? AND assignment.active=1))
              OR (allow_row.scope_kind='business_area' AND allow_row.business_area_id=scope.business_area_id)
              OR (allow_row.scope_kind='division' AND allow_row.division_id=scope.division_id))))
      AND NOT EXISTS(SELECT 1 FROM needed_permissions needed CROSS JOIN target_scopes scope
        JOIN native_directory_grants deny_row ON deny_row.staff_id=? AND deny_row.permission=needed.permission
          AND deny_row.effect='deny' AND deny_row.active=1
        WHERE scope.submission_id=candidate.submission_id
          AND (deny_row.scope_kind='global'
            OR (scope.target_kind='existing' AND deny_row.scope_kind='resource' AND deny_row.resource_id=scope.record_id)
            OR (scope.target_kind='existing' AND deny_row.scope_kind='assigned' AND EXISTS(
              SELECT 1 FROM native_directory_assignments assignment WHERE assignment.record_id=scope.record_id
                AND assignment.staff_id=? AND assignment.active=1))
            OR (deny_row.scope_kind='business_area' AND deny_row.business_area_id=scope.business_area_id)
            OR (deny_row.scope_kind='division' AND deny_row.division_id=scope.division_id)))
    LIMIT 1`).bind(actor.staffId, actor.verifiedAccessSubject, authenticated.admissionVersion,
      actor.profileVersion, actor.email, submissionId, actor.staffId, actor.staffId,
      actor.staffId, actor.staffId).first<{ submission_id: string }>();
    if (!row || row.submission_id !== submissionId || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    let sourceIds: readonly string[];
    try {
      sourceIds = listEnabledProjectAlphaApiV2SourceIds(environment);
      if (sourceIds.length > MAX_ENABLED_SOURCES) return unavailable();
    }
    catch { return unavailable(); }
    return Object.freeze({ sourceIds: Object.freeze([...sourceIds]) });
  } catch (error) {
    if (error instanceof Error && error.message === "client_onboarding_enrollment_discovery_unavailable") throw error;
    return denied();
  }
}
