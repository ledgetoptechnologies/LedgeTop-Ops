import { z } from "zod";
import { requestJson } from "./bulk-download";

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
export type PortalInvitationRequest = z.infer<typeof invitationRequestSchema>;
export const invitationRequestPageSchema = z.object({items: z.array(invitationRequestSchema).max(100), nextCursor: z.string().min(1).max(4096).nullable()});
export const invitationRequestStatus = (status: PortalInvitationRequest["status"]) => ({pending: "Pending approval", approving: "Approval in progress — not issued", approved: "Approved", rejected: "Rejected", cancelled: "Cancelled", stale: "Needs a new request"})[status];
const capabilityLabels: Record<string, string> = {"workspace.view": "Workspace viewing", "delivery.view": "Delivery viewing", "request.create": "Service requests"};
export const invitationCapabilitiesLabel = (capabilities: readonly string[]) => capabilities.map(value => capabilityLabels[value] ?? "Unsupported capability").join(" · ");
export function invitationTermsLabel(terms: PortalInvitationRequest["accessTerms"]): string {
  if (!terms) return "Existing scope rules — unclassified";
  if (terms.mode === "project_end") return "Collaborator — first verified project completion + 7 days";
  if (terms.mode === "specific_date") return `Collaborator — until ${new Date(terms.expiresAt!).toLocaleString()}`;
  return `${terms.kind === "customer" ? "Customer" : "Collaborator"} — until revoked`;
}
export async function loadInvitationRequests(workspaceId: string, cursor: string | null, signal: AbortSignal, sourceId?: string) {
  const result = invitationRequestPageSchema.parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitation-requests${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, {signal}));
  if (result.items.some(item => item.workspaceId !== workspaceId || sourceId && item.sourceId !== sourceId) || result.nextCursor && result.nextCursor === cursor) throw Object.assign(new Error("Invitation requests could not be verified."), {status: 409});
  return result;
}
export async function cancelInvitationRequest(workspaceId: string, requestId: string, version: number, key: string, signal: AbortSignal) {
  const result = z.object({request: invitationRequestSchema, replayed: z.boolean()}).parse(await requestJson<unknown>(`/api/client/v2/workspaces/${encodeURIComponent(workspaceId)}/invitation-requests/${encodeURIComponent(requestId)}/cancel`, {
    method: "POST", signal, headers: {"Content-Type": "application/json", "Idempotency-Key": key}, body: JSON.stringify({expectedVersion: version}),
  }));
  if (result.request.id !== requestId || result.request.workspaceId !== workspaceId || result.request.status !== "cancelled" || result.request.version !== version + 1) throw new Error("Cancellation could not be confirmed.");
  return result;
}
