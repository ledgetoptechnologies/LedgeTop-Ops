import { projectAlphaSourceName } from "@ltds/shared";

/** Staff onboarding API client. Responses are validated before use; the one-time
 * recipient link and invitation secret are only ever held in component memory. */
export const endpoint = "/api/client-onboarding/staff";

export type StaffSession = { csrfToken: string; verifiedUntil: string };
export type InboxCursor = { submittedAt: string; submissionId: string };
export type InboxItem = { submissionId: string; submittedAt: string; name: string; organizationName: string;
  clientType: "consumer" | "business"; existingClient: boolean };
export type InboxPage = { submissions: InboxItem[]; nextCursor: InboxCursor | null };
export type ReviewFields = { clientType: "consumer" | "business"; name: string; email: string; phone: string;
  organizationName: string; organizationEmail: string; organizationPhone: string; addressLine1: string;
  addressLine2: string; city: string; state: string; postalCode: string; country: string };
export type Review = { invitationId: string; submissionId: string; fieldsSha256: string; submittedAt: string;
  targetClientRecordId: string | null; scopes: Array<{ businessAreaId: string; divisionId: string | null }>; fields: ReviewFields };
export type Approval = { decisionId: string; submissionId: string; clientRecordId: string; clientRecordVersion: number;
  organizationRecordId?: string; organizationRecordVersion?: number; relationshipVersion: number; replayed: boolean };
export type ExistingCompany = { recordId: string; expectedVersion: number; name: string; sourceIds: string[]; reusable: boolean;
  reason: null | "grouped_parent_alias_unsupported" | "acquired_parent_alias_unsupported" | "company_not_active" | "selected_sources_not_covered" };
export type ExistingCompanyPage = { companies: ExistingCompany[]; nextAfterRecordId: string | null };
export type SharedCompany = { groupId: string; expectedVersion: number; name: string;
  members: Array<{ recordId: string; expectedVersion: number; sourceIds: string[] }>; reviewAvailable: boolean;
  reason: null | "membership_unavailable" | "company_not_active" | "select_destination" | "selected_sources_not_unique" };
export type SharedCompanyPage = { companies: SharedCompany[]; nextAfterGroupId: string | null };
export type SharedPlan = { planId: string; submissionId: string; companyGroupId: string; companyGroupVersion: number;
  sourceIds: string[]; expiresAt: string; state: "reviewed"; approvalAvailable: boolean;
  children: Array<{ clientRecordId: string; parentRecordId: string; parentRecordVersion: number; sourceIds: string[] }>; replayed: boolean };
export type SharedApproval = { decisionId: string; outcome: "approved"; submissionId: string; clientRecordId: string;
  organizationRecordId: string; organizationRecordVersion: number; replayed: boolean; planId: string;
  portalActivation: "pending" | "active" | "blocked" };
export type Activation = { clientRecordId: string; updatedAt: string; state: "pending" | "active" | "blocked";
  reason: "awaiting_pa" | "awaiting_portal" | "authority_changed" | "identity_changed" | "enrollment_required" | "active" | "activation_failed" };
export type OrganizationSelection = { kind: "new" } | { kind: "existing"; recordId: string; expectedVersion: number };
export type SharedSelection = { kind: "shared_existing"; groupId: string; expectedVersion: number;
  members: Array<{ recordId: string; expectedVersion: number }> };

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SOURCE = /^project-alpha:[a-z0-9][a-z0-9_-]{0,63}$/;
const ISO = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max;
const version = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 1;
const sources = (value: unknown, max = 16): value is string[] => Array.isArray(value) && value.length <= max
  && value.every(item => typeof item === "string" && SOURCE.test(item)) && new Set(value).size === value.length;
export const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export const uuid = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** Staff-facing business name for a Project Alpha destination. */
export const destinationName = (sourceId: string) => projectAlphaSourceName(sourceId);
export const destinationList = (sourceIds: readonly string[]) => sourceIds.length === 0 ? "Operations only"
  : sourceIds.map(destinationName).join(" and ");

export type RequestFailure = Error & { status?: number };
export async function json(path: string, init: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...init });
  const payload: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(record(payload) && typeof payload.error === "string" ? payload.error : `Request failed (${response.status})`), { status: response.status });
  if (!record(payload)) throw new Error("invalid_response");
  return payload;
}
/** A definite 4xx is a denial; anything else (network, 5xx, unverifiable echo) is uncertain. */
export const uncertainFailure = (caught: unknown) => {
  const status = caught instanceof Error && "status" in caught ? Number((caught as RequestFailure).status) : 0;
  return !status || status >= 500 || (caught instanceof Error && caught.message === "invalid_response");
};
export const post = (session: StaffSession, route: string, body: unknown) => json(`${endpoint}/${route}`, { method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRF-Token": session.csrfToken }, body: JSON.stringify(body) });

export function validSession(value: Record<string, unknown>): value is StaffSession & Record<string, unknown> {
  return typeof value.csrfToken === "string" && SHA.test(value.csrfToken) && ISO(value.verifiedUntil);
}
function validCursor(value: unknown): value is InboxCursor {
  return record(value) && Object.keys(value).length === 2 && ISO(value.submittedAt) && typeof value.submissionId === "string" && UUID.test(value.submissionId);
}
export function validInbox(value: Record<string, unknown>): value is InboxPage & Record<string, unknown> {
  return Array.isArray(value.submissions) && value.submissions.length <= 32 && value.submissions.every(item => record(item)
    && typeof item.submissionId === "string" && UUID.test(item.submissionId) && ISO(item.submittedAt) && text(item.name, 150)
    && text(item.organizationName, 150) && (item.clientType === "consumer" || item.clientType === "business") && typeof item.existingClient === "boolean")
    && (value.nextCursor === null || validCursor(value.nextCursor));
}
export function validReview(value: Record<string, unknown>): value is Review & Record<string, unknown> {
  return typeof value.invitationId === "string" && typeof value.submissionId === "string"
    && typeof value.fieldsSha256 === "string" && SHA.test(value.fieldsSha256) && ISO(value.submittedAt)
    && (value.targetClientRecordId === null || typeof value.targetClientRecordId === "string")
    && Array.isArray(value.scopes) && value.scopes.length > 0 && value.scopes.length <= 128
    && record(value.fields) && (value.fields.clientType === "consumer" || value.fields.clientType === "business")
    && typeof value.fields.name === "string" && typeof value.fields.email === "string";
}
export function validChoices(value: Record<string, unknown>): value is { sourceIds: string[] } & Record<string, unknown> {
  return sources(value.sourceIds);
}
export function validApproval(value: Record<string, unknown>): value is Approval & Record<string, unknown> {
  return typeof value.decisionId === "string" && typeof value.submissionId === "string"
    && typeof value.clientRecordId === "string" && Number.isSafeInteger(value.clientRecordVersion)
    && ((value.organizationRecordId === undefined && value.organizationRecordVersion === undefined)
      || (typeof value.organizationRecordId === "string" && Number.isSafeInteger(value.organizationRecordVersion)))
    && Number.isSafeInteger(value.relationshipVersion) && typeof value.replayed === "boolean";
}
const EXISTING_REASONS = new Set([null, "grouped_parent_alias_unsupported", "acquired_parent_alias_unsupported", "company_not_active", "selected_sources_not_covered"]);
export function validExistingCompanies(value: Record<string, unknown>): value is ExistingCompanyPage & Record<string, unknown> {
  return Array.isArray(value.companies) && value.companies.length <= 20 && value.companies.every(item => record(item)
    && typeof item.recordId === "string" && item.recordId.length > 0 && version(item.expectedVersion) && text(item.name, 300)
    && sources(item.sourceIds) && typeof item.reusable === "boolean" && EXISTING_REASONS.has(item.reason as never))
    && (value.nextAfterRecordId === null || typeof value.nextAfterRecordId === "string");
}
const SHARED_REASONS = new Set([null, "membership_unavailable", "company_not_active", "select_destination", "selected_sources_not_unique"]);
export function validSharedCompanies(value: Record<string, unknown>): value is SharedCompanyPage & Record<string, unknown> {
  return Array.isArray(value.companies) && value.companies.length <= 20 && value.companies.every(item => record(item)
    && typeof item.groupId === "string" && UUID.test(item.groupId) && version(item.expectedVersion) && text(item.name, 300)
    && Array.isArray(item.members) && item.members.length >= 1 && item.members.length <= 2
    && item.members.every(member => record(member) && typeof member.recordId === "string" && version(member.expectedVersion) && sources(member.sourceIds))
    && typeof item.reviewAvailable === "boolean" && SHARED_REASONS.has(item.reason as never))
    && (value.nextAfterGroupId === null || (typeof value.nextAfterGroupId === "string" && UUID.test(value.nextAfterGroupId)));
}
export function validSharedPlan(value: Record<string, unknown>, expected: { planId: string; submissionId: string; groupId: string }): value is SharedPlan & Record<string, unknown> {
  return value.planId === expected.planId && value.submissionId === expected.submissionId && value.companyGroupId === expected.groupId
    && version(value.companyGroupVersion) && sources(value.sourceIds, 2) && ISO(value.expiresAt) && value.state === "reviewed"
    && typeof value.approvalAvailable === "boolean" && typeof value.replayed === "boolean"
    && Array.isArray(value.children) && value.children.length >= 1 && value.children.length <= 2
    && value.children.every(child => record(child) && typeof child.clientRecordId === "string" && typeof child.parentRecordId === "string"
      && version(child.parentRecordVersion) && sources(child.sourceIds));
}
export function validSharedApproval(value: Record<string, unknown>, planId: string, submissionId: string): value is SharedApproval & Record<string, unknown> {
  return value.decisionId === planId && value.planId === planId && value.outcome === "approved" && value.submissionId === submissionId
    && typeof value.clientRecordId === "string" && typeof value.organizationRecordId === "string" && version(value.organizationRecordVersion)
    && typeof value.replayed === "boolean" && ["pending", "active", "blocked"].includes(value.portalActivation as string);
}
const ACTIVATION_REASONS = new Set(["awaiting_pa", "awaiting_portal", "authority_changed", "identity_changed", "enrollment_required", "active", "activation_failed"]);
export function validActivation(value: Record<string, unknown>): value is { activation: Activation | null } & Record<string, unknown> {
  const activation = value.activation;
  return activation === null || (record(activation) && typeof activation.clientRecordId === "string" && ISO(activation.updatedAt)
    && ["pending", "active", "blocked"].includes(activation.state as string) && ACTIVATION_REASONS.has(activation.reason as string));
}

export const activationText: Record<Activation["reason"], string> = {
  awaiting_pa: "Waiting for the selected business records to be created in Project Alpha.",
  awaiting_portal: "Business records are ready. Waiting for the client's portal sign-in to be confirmed.",
  active: "Portal access is active. The client can sign in and edit their own profile. Files are still shared separately.",
  authority_changed: "Paused: the approving staff member's permissions changed. An authorized reviewer needs to check it.",
  identity_changed: "Paused: the client's sign-in identity changed. Confirm the right person before continuing.",
  enrollment_required: "Paused: a selected business isn't enrolled for this client yet.",
  activation_failed: "Portal activation failed. Check the client's record and try again from Client Hub.",
};
export const existingReasonText: Record<NonNullable<ExistingCompany["reason"]>, string> = {
  grouped_parent_alias_unsupported: "This company is already shared across businesses; choose it under “Shared company”.",
  acquired_parent_alias_unsupported: "This company is linked from another company and can't be reused here.",
  company_not_active: "This company isn't active.",
  selected_sources_not_covered: "This company isn't set up for every selected business.",
};
export const sharedReasonText: Record<NonNullable<SharedCompany["reason"]>, string> = {
  membership_unavailable: "Its business records can't be verified right now.",
  company_not_active: "This company isn't active.",
  select_destination: "Choose which businesses this client is for first.",
  selected_sources_not_unique: "The selected businesses don't map to one record each.",
};
