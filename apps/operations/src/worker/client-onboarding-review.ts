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

type ReviewCursor = Readonly<{ submittedAt: string; submissionId: string }>;

/** One authority query for individual review and the inbox: denied records never
 * affect the returned page size or cursor. */
type ReviewAuthority = Pick<AuthenticatedNativeStaffWithAdmissionVersion, "identity" | "admissionVersion">;
function authorizedReviewPlan(authenticated: ReviewAuthority,
  submissionId: string | null, after: ReviewCursor | null, limit: number) {
    const actor = authenticated.identity;
    return { sql: `WITH candidate AS (
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
      WHERE (? IS NULL OR submission.submission_id=?) AND invitation.state='submitted' AND invitation.version=2
        ${submissionId === null ? `AND NOT EXISTS(SELECT 1 FROM client_onboarding_decisions decision WHERE decision.submission_id=submission.submission_id)` : ''}
        AND (? IS NULL OR submission.created_at>? OR (submission.created_at=? AND submission.submission_id>?))
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
    ORDER BY candidate.submitted_at,candidate.submission_id LIMIT ?`, bindings: [actor.staffId, actor.verifiedAccessSubject, authenticated.admissionVersion,
      actor.profileVersion, actor.email, submissionId, submissionId, after?.submittedAt ?? null,
      after?.submittedAt ?? null, after?.submittedAt ?? null, after?.submissionId ?? null,
      actor.staffId, actor.staffId, actor.staffId, actor.staffId, limit] };

}
function authorizedReviews(database: D1Database, authenticated: ReviewAuthority,
  submissionId: string | null, after: ReviewCursor | null, limit: number): D1PreparedStatement {
  const plan = authorizedReviewPlan(authenticated, submissionId, after, limit);
  return database.withSession("first-primary").prepare(plan.sql).bind(...plan.bindings);
}
function parseReview(row: ReviewRow): ClientOnboardingSubmissionReview {
    if (!UUID.test(row.submission_id) || !UUID.test(row.invitation_id)
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

}

/** Reads only a submission covered by current edit authority over every scope. */
export async function readClientOnboardingSubmissionForReview(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  submissionId: unknown): Promise<ClientOnboardingSubmissionReview> {
  try {
    if (typeof submissionId !== "string" || !UUID.test(submissionId)
      || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const row = await authorizedReviews(database, authenticated, submissionId, null, 1).first<ReviewRow>();
    if (!row || row.submission_id !== submissionId) return denied();
    return parseReview(row);
  } catch { return denied(); }
}

export type ClientOnboardingInbox = Readonly<{
  submissions: readonly Readonly<{ submissionId: string; submittedAt: string; name: string;
    organizationName: string; clientType: "consumer" | "business"; existingClient: boolean }>[];
  nextCursor: ReviewCursor | null;
}>;

/** Bounded keyset page, filtering authorization in SQL before LIMIT. No totals,
 * bearer secrets or full submitted profiles are exposed by discovery. */
export async function listClientOnboardingSubmissionsForReview(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion, rawCursor: unknown = null): Promise<ClientOnboardingInbox> {
  try {
    if (!Number.isFinite(Date.parse(authenticated.verifiedUntil))
      || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    let after: ReviewCursor | null = null;
    if (rawCursor !== null) {
      if (!rawCursor || typeof rawCursor !== "object" || Array.isArray(rawCursor)) return denied();
      const value = rawCursor as Record<string, unknown>;
      if (Object.keys(value).length !== 2 || typeof value.submittedAt !== "string"
        || typeof value.submissionId !== "string" || !UUID.test(value.submissionId)
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.submittedAt)
        || !Number.isFinite(Date.parse(value.submittedAt))
        || new Date(value.submittedAt).toISOString() !== value.submittedAt) return denied();
      after = { submittedAt: value.submittedAt, submissionId: value.submissionId };
    }
    const rows = (await authorizedReviews(database, authenticated, null, after, 33).all<ReviewRow>()).results;
    if (Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const reviews = rows.slice(0, 32).map(parseReview);
    const last = reviews.at(-1);
    return Object.freeze({ submissions: Object.freeze(reviews.map(review => Object.freeze({
      submissionId: review.submissionId, submittedAt: review.submittedAt, name: review.fields.name,
      organizationName: review.fields.organizationName, clientType: review.fields.clientType,
      existingClient: review.targetClientRecordId !== null,
    }))), nextCursor: rows.length > 32 && last
      ? Object.freeze({ submittedAt: last.submittedAt, submissionId: last.submissionId }) : null });
  } catch { return denied(); }
}


/** Scheduler-only lookup for a deployment-selected staff recipient. It does not
 * authenticate a request or manufacture an Access session. Current profile and
 * admission witnesses are joined to exactly the same review authority query. */
export async function readClientOnboardingNotificationRecipient(database: D1Database,
  submissionId: string, staffId: string): Promise<{ email: string; admissionVersion: number; profileVersion: number;
    guard: { sql: string; bindings: (string | number | null)[] } } | null> {
  if (!UUID.test(submissionId) || !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,190}$/.test(staffId)) return null;
  const row = await database.withSession("first-primary").prepare(`SELECT profile.login_email email,
    profile.display_name,profile.version profile_version,admission.version admission_version,admission.bound_access_subject
    FROM native_staff_admissions admission JOIN native_staff_profiles profile ON profile.staff_id=admission.staff_id
    JOIN staff_users staff ON staff.id=admission.staff_id AND staff.status='active'
    WHERE admission.staff_id=? AND admission.active=1
      AND NOT EXISTS(SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?)`)
    .bind(staffId, submissionId).first<{email:string;display_name:string;profile_version:number;admission_version:number;bound_access_subject:string}>();
  if (!row || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(row.email) || row.email.length > 254) return null;
  const plan = authorizedReviewPlan({ identity: { kind: "native", staffId,
    verifiedAccessSubject: row.bound_access_subject, email: row.email, displayName: row.display_name,
    profileVersion: row.profile_version }, admissionVersion: row.admission_version }, submissionId, null, 1);
  const guard = { sql: `EXISTS(${plan.sql})
    AND EXISTS(SELECT 1 FROM staff_users WHERE id=? AND status='active')
    AND NOT EXISTS(SELECT 1 FROM client_onboarding_decisions WHERE submission_id=?)`,
    bindings: [...plan.bindings, staffId, submissionId] };
  const authorized = await database.withSession("first-primary").prepare(`SELECT 1 WHERE ${guard.sql}`)
    .bind(...guard.bindings).first();
  return authorized ? { email: row.email, admissionVersion: row.admission_version, profileVersion: row.profile_version, guard } : null;
}
