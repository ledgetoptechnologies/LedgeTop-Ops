import type { AuthenticatedNativeStaffWithAdmissionVersion } from "./native-staff-auth";
import { approveNativeOnlyClientOnboarding,
  type NativeOnlyClientOnboardingApprovalOutcome } from "./native-directory-onboarding-write-composer";
import type { NativeDirectoryScope, NativeDirectoryWriterActor } from "./native-directory-profile-writer";
import { readClientOnboardingSubmissionForReview } from "./client-onboarding-review";

export type ClientOnboardingApprovalReceipt = Extract<NativeOnlyClientOnboardingApprovalOutcome,
  { status: "written" }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const denied = (): never => { throw Error("client_onboarding_approval_denied"); };

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}
async function sha256(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
async function deterministicUuid(seed: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(seed))).slice(0, 16);
  digest[6] = (digest[6]! & 0x0f) | 0x40;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const value = [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

async function selectedCreateGrant(database: D1Database, staffId: string,
  permission: "directory.profile.edit" | "directory.identity.link", recordId: string,
  scopes: readonly NativeDirectoryScope[]): Promise<string> {
  const scopeJson = JSON.stringify(scopes);
  const row = await database.withSession("first-primary").prepare(`SELECT grant.id
    FROM native_directory_grants grant
    WHERE grant.staff_id=? AND grant.permission=? AND grant.effect='allow' AND grant.active=1
      AND (grant.scope_kind='global'
        OR (grant.scope_kind='business_area' AND NOT EXISTS(SELECT 1 FROM json_each(?) scope
          WHERE json_extract(scope.value,'$.businessAreaId')<>grant.business_area_id))
        OR (grant.scope_kind='division' AND NOT EXISTS(SELECT 1 FROM json_each(?) scope
          WHERE json_extract(scope.value,'$.divisionId') IS NULL
            OR json_extract(scope.value,'$.divisionId')<>grant.division_id)))
      AND NOT EXISTS(SELECT 1 FROM native_directory_grants deny
        WHERE deny.staff_id=grant.staff_id AND deny.permission=grant.permission
          AND deny.effect='deny' AND deny.active=1
          AND (deny.scope_kind='global'
            OR (deny.scope_kind='resource' AND deny.resource_id=?)
            OR (deny.scope_kind='business_area' AND EXISTS(SELECT 1 FROM json_each(?) scope
              WHERE json_extract(scope.value,'$.businessAreaId')=deny.business_area_id))
            OR (deny.scope_kind='division' AND EXISTS(SELECT 1 FROM json_each(?) scope
              WHERE json_extract(scope.value,'$.divisionId')=deny.division_id))))
    ORDER BY CASE grant.scope_kind WHEN 'division' THEN 1 WHEN 'business_area' THEN 2 ELSE 3 END,grant.id
    LIMIT 1`).bind(staffId, permission, scopeJson, scopeJson, recordId, scopeJson, scopeJson)
    .first<{ id: string }>();
  if (!row?.id) return denied();
  return row.id;
}

function hasOrganizationProposal(fields: Awaited<ReturnType<typeof readClientOnboardingSubmissionForReview>>["fields"]): boolean {
  return fields.clientType !== "consumer" || [fields.organizationName, fields.organizationEmail,
    fields.organizationPhone].some(value => value.trim() !== "");
}

/**
 * Approves only the smallest native-only target supported by the private 0083
 * composer: a new unlinked consumer client. Browser input contributes no
 * identity, grants, target IDs, versions, scope, profile fields or PA
 * destinations. Business/organization proposals remain pending for a later
 * organization-aware disposition instead of silently losing submitted data.
 */
export async function approveNewNativeOnlyClientOnboarding(database: D1Database,
  authenticated: AuthenticatedNativeStaffWithAdmissionVersion,
  submissionId: unknown, expectedFieldsSha256: unknown): Promise<ClientOnboardingApprovalReceipt> {
  try {
    if (typeof submissionId !== "string" || !UUID.test(submissionId)
      || typeof expectedFieldsSha256 !== "string" || !HEX.test(expectedFieldsSha256)
      || Date.parse(authenticated.verifiedUntil) <= Date.now()) return denied();
    const review = await readClientOnboardingSubmissionForReview(database, authenticated, submissionId);
    if (review.targetClientRecordId !== null || review.fieldsSha256 !== expectedFieldsSha256
      || hasOrganizationProposal(review.fields)) return denied();
    const issuance = await database.withSession("first-primary").prepare(`SELECT command.request_sha256
      FROM client_onboarding_issuance_commands command
      JOIN client_onboarding_invitations invitation ON invitation.invitation_id=command.invitation_id
        AND invitation.state='submitted' AND invitation.version=2 AND invitation.target_client_record_id IS NULL
      WHERE command.invitation_id=? LIMIT 1`).bind(review.invitationId).first<{ request_sha256: string }>();
    if (!issuance || !HEX.test(issuance.request_sha256)) return denied();
    const decisionId = await deterministicUuid(`client-onboarding-approval:v1:decision:${review.submissionId}`);
    const mutationId = await deterministicUuid(`client-onboarding-approval:v1:profile:${review.submissionId}`);
    const recordId = await deterministicUuid(`client-onboarding-approval:v1:record:${review.submissionId}`);
    const relationshipMutationId = await deterministicUuid(`${mutationId}\0client-relationship\0unlinked`);
    const selectedGrantId = await selectedCreateGrant(database, authenticated.identity.staffId,
      "directory.profile.edit", recordId, review.scopes);
    const selectedIdentityGrantId = await selectedCreateGrant(database, authenticated.identity.staffId,
      "directory.identity.link", recordId, review.scopes);
    const actor: NativeDirectoryWriterActor = {
      staffId: authenticated.identity.staffId,
      accessSubject: authenticated.identity.verifiedAccessSubject,
      admissionVersion: authenticated.admissionVersion,
      selectedGrantId,
      loginEmail: authenticated.identity.email,
      profileVersion: authenticated.identity.profileVersion,
      selectedIdentityGrantId,
    };
    const profile = {
      name: review.fields.name,
      email: review.fields.email,
      phone: review.fields.phone,
      clientType: review.fields.clientType,
      addressLine1: review.fields.addressLine1,
      addressLine2: review.fields.addressLine2,
      city: review.fields.city,
      state: review.fields.state,
      postalCode: review.fields.postalCode,
      country: review.fields.country,
    } as const;
    const reason = "Approved as a new native-only, unlinked client profile";
    const reviewedFieldsJson = JSON.stringify(review.fields);
    const requestSha256 = await sha256(JSON.stringify(["client-onboarding-native-only-approval-v1",
      decisionId, review.invitationId, review.submissionId, review.fieldsSha256, issuance.request_sha256,
      reason, reviewedFieldsJson, review.scopes, recordId, mutationId, relationshipMutationId,
      authenticated.identity.staffId, authenticated.identity.verifiedAccessSubject,
      authenticated.admissionVersion, authenticated.identity.profileVersion]));
    const outcome = await approveNativeOnlyClientOnboarding(database, {
      decisionId, invitationId: review.invitationId, submissionId: review.submissionId,
      fieldsSha256: review.fieldsSha256, requestSha256, reason, reviewedFieldsJson,
      scopes: review.scopes, verifiedUntil: authenticated.verifiedUntil,
      relationship: { mode: "change", expectedVersion: 0, mutationId: relationshipMutationId },
      profile: { operation: "create", mutationId, recordId, expectedLocalVersion: 0, kind: "client",
        createAdmissionId: `client-onboarding:${decisionId}:client`, profile, scopes: review.scopes,
        destinations: [], actor, relationship: { organizationRecordId: null, expectedRelationshipVersion: 0 } },
    });
    if (outcome.status !== "written") return denied();
    return outcome;
  } catch { return denied(); }
}
