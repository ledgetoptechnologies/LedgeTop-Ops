import { afterEach, describe, expect, it, vi } from "vitest";
import { decideInvitationRequest, invitationRequestDetail, invitationRequestHref, loadInvitationPolicy, loadInvitationRequestDetail, saveInvitationPolicy, type InvitationPolicy } from "../src/client/invitation-administration-api";
import { readInvitationApprovalRoute } from "../src/client/InvitationApprovals";
import { inboxEndpoint, inboxSources, parseInboxPage } from "../src/client/staff-inbox";
import { invitationRequestSchema } from "../../client/src/client/invitation-request-api";

const sourceId = "project-alpha:primary", workspaceId = "workspace-one";
const row = {id: "request-one", sourceId, sourceName: "Project Alpha", workspaceId, workspaceName: "Acme", requesterIdentityId: "identity-one", requesterEmail: null, version: 1, status: "pending", email: "guest@example.test", scope: {type: "project", publicId: "project-one"}, capabilities: ["workspace.view", "delivery.view", "request.create"], accessTerms: null, policyVersion: 1, createdAt: "2026-08-26T12:00:00Z", updatedAt: "2026-08-26T12:00:00Z", invitationId: null, reasonCode: null, canCancel: true};
const current = invitationRequestDetail.parse({request: row, contextVersion: "context-one", capabilities: {canApprove: true, canReject: true}, unavailableReason: null});
const policy: InvitationPolicy = {sourceId, workspaceId, workspaceName: "Acme", policy: "allowed", version: 1, contextVersion: "policy-one", capabilities: {canManagePolicy: true}};
const signal = () => new AbortController().signal;
function response(value: unknown) {return new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});}
afterEach(() => vi.unstubAllGlobals());

describe("invitation administration frontend contracts", () => {
  it("accepts the actual three invitable capabilities without inferring roles", () => {expect(invitationRequestSchema.parse(row).capabilities).toEqual(row.capabilities); expect(() => invitationRequestSchema.parse({...row, capabilities: ["member.manage"]})).toThrow();});
  it("opens only exact source/workspace request coordinates", () => {
    const href = invitationRequestHref(current.request); expect(href).toBe("/clients/invitation-requests/request-one?sourceId=project-alpha%3Aprimary&workspaceId=workspace-one");
    const url = new URL(href, "https://ops.test"); expect(readInvitationApprovalRoute(url.pathname, url.search).invalid).toBe(false);
    expect(readInvitationApprovalRoute(url.pathname, "?workspaceId=workspace-one").invalid).toBe(true);
    expect(readInvitationApprovalRoute(url.pathname, `${url.search}&sourceId=project-alpha%3Ab`).invalid).toBe(true);
    expect(readInvitationApprovalRoute("/clients/invitation-requests", "").status).toBe("open");
  });
  it("never grants an Inbox source from administrator or raw team permissions alone", () => {
    expect(inboxSources({permissions: ["team.manage", "team.view"], isAdministrator: true, feedbackEnabled: false})).toEqual([]);
    expect(inboxSources({permissions: [], isAdministrator: false, feedbackEnabled: false, invitationReview: true})).toEqual(["invitations"]);
    expect(inboxEndpoint("invitations", "Acme & Sons", "next")).toBe("/api/client-portal/invitation-requests?status=open&q=Acme+%26+Sons&cursor=next");
  });
  it("keeps empty continuation pages and composite identity without inventing access", () => {
    const page = {items: [], page: {hasMore: true, nextCursor: "next", limit: 25}, capabilities: {canReview: true}};
    expect(parseInboxPage("invitations", page, "")).toEqual({items: [], nextCursor: "next"});
    const result = parseInboxPage("invitations", {...page, items: [row, {...row, sourceId: "project-alpha:b", workspaceId: "workspace-b", status: "approving"}]}, "");
    expect(result.items.map(item => item.id)).toEqual(["project-alpha:primary:workspace-one:request-one", "project-alpha:b:workspace-b:request-one"]); expect(result.items[1]?.status).toContain("not issued");
    expect(() => parseInboxPage("invitations", {...page, capabilities: {canReview: false}}, "")).toThrow();
    expect(() => parseInboxPage("invitations", {...page, items: [{...row, status: "approved"}]}, "")).toThrow();
  });
  it("parses the nested policy mutation response and binds the exact version/context", async () => {
    const fetch = vi.fn().mockResolvedValue(response({policy: {...policy, policy: "require_approval", version: 2}, replayed: false})); vi.stubGlobal("fetch", fetch);
    expect((await saveInvitationPolicy(policy, "require_approval", "same-key", signal())).policy).toBe("require_approval");
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({sourceId, policy: "require_approval", expectedVersion: 1, contextVersion: "policy-one"});
  });
  it("rejects a policy response from a different workspace", async () => {vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({...policy, workspaceId: "workspace-b"}))); await expect(loadInvitationPolicy(workspaceId, sourceId, signal())).rejects.toThrow("context");});
  it("rejects a detail response from a different source", async () => {vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({...current, request: {...row, sourceId: "project-alpha:b"}}))); await expect(loadInvitationRequestDetail(row.id, sourceId, workspaceId, signal())).rejects.toThrow("context");});
  it("approval sends no reason and requires a published invitation", async () => {
    const fetch = vi.fn().mockResolvedValue(response({request: {...row, status: "approved", invitationId: "invite-one", version: 3}, replayed: false})); vi.stubGlobal("fetch", fetch);
    await decideInvitationRequest(current, "approve", "ignored", "same-key", signal()); expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("reason");
  });
  it.each([{status: "approving", invitationId: null, version: 2}, {status: "approved", invitationId: null, version: 3}, {status: "approved", invitationId: "invite-one", version: 1}])("does not claim a malformed/unfinished approval as success: %o", async change => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({request: {...row, ...change}, replayed: false}))); await expect(decideInvitationRequest(current, "approve", "", "same-key", signal())).rejects.toThrow("could not be confirmed");
  });
  it("rejection preserves its optional note without claiming publication", async () => {
    const fetch = vi.fn().mockResolvedValue(response({request: {...row, status: "rejected", version: 2}, replayed: false})); vi.stubGlobal("fetch", fetch);
    await decideInvitationRequest(current, "reject", "Wrong scope", "same-key", signal()); expect(JSON.parse(fetch.mock.calls[0]![1].body).reason).toBe("Wrong scope");
  });
});
