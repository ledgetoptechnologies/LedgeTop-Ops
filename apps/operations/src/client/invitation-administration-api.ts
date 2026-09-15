import { z } from "zod";
import { api } from "./api";

// This is an Operations-owned copy of the client-portal wire contract.  Do not
// import the Client application's Zod schema here: each application resolves
// its own Zod package, and combining schemas from different Zod minors makes
// Zod's internal type metadata incompatible.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const timestamp = z.string().max(64).refine(value => /^\d{4}-\d{2}-\d{2}[T ]/.test(value) && Number.isFinite(Date.parse(value)));
export const invitationRequestSchema = z.object({
  id, sourceId: z.string().regex(/^project-alpha:[A-Za-z0-9_-]+$/), sourceName: z.string().max(1000),
  workspaceId: id, workspaceName: z.string().max(1000), requesterIdentityId: id, requesterEmail: z.string().max(320).nullable(),
  version: z.number().int().positive(), status: z.enum(["pending", "approving", "approved", "rejected", "cancelled", "stale"]),
  email: z.string().max(320), scope: z.object({type: z.enum(["workspace", "organization", "department", "client", "project"]), publicId: id}),
  capabilities: z.array(z.enum(["workspace.view", "delivery.view", "request.create"])).max(3),
  accessTerms: z.object({id: z.string().min(1).max(200), kind: z.enum(["customer", "collaborator"]), mode: z.enum(["specific_date", "project_end", "until_revoked"]),
    expiresAt: timestamp.nullable(), effectiveExpiresAt: timestamp.nullable(), completionPending: z.boolean(), expired: z.boolean()}).nullable(),
  policyVersion: z.number().int().nonnegative(), createdAt: timestamp, updatedAt: timestamp,
  invitationId: id.nullable(), reasonCode: z.string().max(2000).nullable(), canCancel: z.boolean(),
});
export type InvitationRequest = z.infer<typeof invitationRequestSchema>;
export const invitationRequestStatus = (status: InvitationRequest["status"]) => ({pending: "Pending approval", approving: "Approval in progress — not issued", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", stale: "Needs a new request"})[status];
const capabilityLabels: Record<string, string> = {"workspace.view": "Workspace viewing", "delivery.view": "Delivery viewing", "request.create": "Service requests"};
export const invitationCapabilitiesLabel = (capabilities: readonly string[]) => capabilities.map(value => capabilityLabels[value] ?? "Unsupported capability").join(" · ");
export function invitationTermsLabel(terms: InvitationRequest["accessTerms"]): string {
  if (!terms) return "Existing scope rules — unclassified";
  if (terms.mode === "project_end") return "Collaborator — first verified project completion + 7 days";
  if (terms.mode === "specific_date") return `Collaborator — until ${new Date(terms.expiresAt!).toLocaleString()}`;
  return `${terms.kind === "customer" ? "Customer" : "Collaborator"} — until revoked`;
}
export interface InvitationAdministrationAccess { enabled: boolean; canReview: boolean; canManagePolicy: boolean; error?: string }
export const invitationAdministrationPath = "/clients/invitation-requests";
const source = z.string().regex(/^project-alpha:[A-Za-z0-9_-]+$/);
export const invitationPolicySchema = z.object({workspaceId: id, sourceId: source, workspaceName: z.string().max(1000),
  policy: z.enum(["allowed", "disabled", "require_approval"]), version: z.number().int().nonnegative(), contextVersion: z.string().min(1).max(512), capabilities: z.object({canManagePolicy: z.boolean()})});
export type InvitationPolicy = z.infer<typeof invitationPolicySchema>;
export const policyLabels = {allowed: "Allowed", disabled: "Disabled", require_approval: "Require administrator approval"};
export const invitationRequestPage = z.object({items: z.array(invitationRequestSchema).max(100), page: z.object({hasMore: z.boolean(), nextCursor: z.string().min(1).max(4096).nullable(), limit: z.number().int().positive()}), capabilities: z.object({canReview: z.boolean()})});
export const invitationRequestDetail = z.object({request: invitationRequestSchema, contextVersion: z.string().min(1).max(512), capabilities: z.object({canApprove: z.boolean(), canReject: z.boolean()}), unavailableReason: z.string().max(2000).nullable()});
export type InvitationRequestDetail = z.infer<typeof invitationRequestDetail>;
export async function loadInvitationAdministrationAccess(signal: AbortSignal): Promise<InvitationAdministrationAccess> {
  return z.object({enabled: z.boolean(), canReview: z.boolean(), canManagePolicy: z.boolean()}).parse(await api<unknown>("/api/client-portal/invitation-requests/capabilities", {signal}));
}
export function invitationRequestHref(row: Pick<InvitationRequest, "id" | "sourceId" | "workspaceId">) {
  return `${invitationAdministrationPath}/${encodeURIComponent(row.id)}?${new URLSearchParams({sourceId: row.sourceId, workspaceId: row.workspaceId})}`;
}
export async function loadInvitationPolicy(workspaceId: string, sourceId: string, signal: AbortSignal) {
  const result = invitationPolicySchema.parse(await api<unknown>(`/api/client-portal/workspaces/${encodeURIComponent(workspaceId)}/invitation-policy?${new URLSearchParams({sourceId})}`, {signal}));
  if (result.workspaceId !== workspaceId || result.sourceId !== sourceId) throw new Error("Invitation policy context could not be verified.");
  return result;
}
export async function saveInvitationPolicy(current: InvitationPolicy, policy: InvitationPolicy["policy"], key: string, signal: AbortSignal) {
  const response = z.object({policy: invitationPolicySchema, replayed: z.boolean()}).parse(await api<unknown>(`/api/client-portal/workspaces/${encodeURIComponent(current.workspaceId)}/invitation-policy`, {method: "PATCH", signal,
    headers: {"Idempotency-Key": key}, body: JSON.stringify({sourceId: current.sourceId, policy, expectedVersion: current.version, contextVersion: current.contextVersion})}));
  const result = response.policy;
  if (result.workspaceId !== current.workspaceId || result.sourceId !== current.sourceId || result.policy !== policy || result.version !== current.version + 1) throw new Error("Policy save could not be confirmed.");
  return result;
}
export async function loadInvitationRequestDetail(id: string, sourceId: string, workspaceId: string, signal: AbortSignal) {
  const result = invitationRequestDetail.parse(await api<unknown>(`/api/client-portal/invitation-requests/${encodeURIComponent(id)}?${new URLSearchParams({sourceId, workspaceId})}`, {signal}));
  if (result.request.id !== id || result.request.sourceId !== sourceId || result.request.workspaceId !== workspaceId) throw new Error("Invitation request context could not be verified.");
  return result;
}
export async function decideInvitationRequest(current: InvitationRequestDetail, decision: "approve" | "reject", reason: string, key: string, signal: AbortSignal) {
  const row = current.request;
  const result = z.object({request: invitationRequestSchema, replayed: z.boolean()}).parse(await api<unknown>(`/api/client-portal/invitation-requests/${encodeURIComponent(row.id)}/decision`, {method: "POST", signal,
    headers: {"Idempotency-Key": key}, body: JSON.stringify({sourceId: row.sourceId, workspaceId: row.workspaceId, decision, expectedVersion: row.version, contextVersion: current.contextVersion, ...(decision === "reject" && reason ? {reason} : {})})}));
  if (result.request.id !== row.id || result.request.sourceId !== row.sourceId || result.request.workspaceId !== row.workspaceId || result.request.email !== row.email || result.request.scope.type !== row.scope.type || result.request.scope.publicId !== row.scope.publicId || result.request.version <= row.version || (decision === "reject" ? result.request.status !== "rejected" : result.request.status !== "approved" || !result.request.invitationId)) throw new Error("Invitation decision could not be confirmed.");
  return result;
}
