import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ target: vi.fn(), create: vi.fn(), revoke: vi.fn() }));
vi.mock("../src/worker/client-portal-identity-read", () => ({ requirePortalIdentityMutationTarget: mocks.target }));
vi.mock("../src/worker/client-portal-deny-policies", () => ({
  createPortalIdentityDenial: mocks.create, revokePortalIdentityDenial: mocks.revoke,
}));

import { reactivateClientPortalWorkspaceAccess, suspendClientPortalWorkspaceAccess } from "../src/worker/client-portal-workspace-access";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const env = {} as Env;
const actor = { id: "staff-admin" } as StaffPrincipal;
const context = { root: { workspace_id: "workspace-one" }, contextVersion: "root-context",
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "org-one" },
  access: { directory: true, requests: true, delivery: true, viewer: true } } as ClientHubCollectionContext;
const baseTarget = {
  workspace_id: "workspace-one", public_id: "principal-one", identity_id: "identity-one", binding_status: "linked",
  workspaceAccessSuspended: false, workspaceDenialCount: 0, removableWorkspaceDenialId: null,
  removableWorkspaceDenialUpdatedAt: null,
  actions: { canSuspendWorkspaceAccess: true, canReactivateWorkspaceAccess: false },
};

describe("Client Hub workspace portal access mutations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.target.mockResolvedValue(baseTarget);
    mocks.create.mockResolvedValue({ denial: { id: "denial-one" }, replayed: false });
    mocks.revoke.mockResolvedValue({ denial: { id: "denial-one", status: "revoked" }, replayed: false });
  });

  it("uses one exact workspace denial and preserves the caller idempotency and version fences", async () => {
    const input = { expectedContextVersion: "root-context", expectedPrincipalContext: "principal-context",
      reasonCode: "operator_workspace_pause" };
    const result = await suspendClientPortalWorkspaceAccess(env, actor, context, "principal-one", input, "workspace-pause-key-0001");
    expect(mocks.target).toHaveBeenCalledWith(env, actor, context, "principal-one", "root-context", "principal-context");
    expect(mocks.create).toHaveBeenCalledWith(env, actor, {
      identityId: "identity-one", workspaceId: "workspace-one", scopeType: "workspace",
      scopePublicId: "workspace-one", reasonCode: "operator_workspace_pause", expiresAt: null,
    }, "workspace-pause-key-0001");
    expect(result).toMatchObject({ outcome: "workspace_access_suspended", replayed: false });
  });

  it("restores only the reviewed denial from the same principal and workspace", async () => {
    mocks.target.mockResolvedValue({ ...baseTarget, workspaceAccessSuspended: true, workspaceDenialCount: 1,
      removableWorkspaceDenialId: "denial-one", removableWorkspaceDenialUpdatedAt: "2026-09-02 12:00:00",
      actions: { canSuspendWorkspaceAccess: false, canReactivateWorkspaceAccess: true } });
    const input = { expectedContextVersion: "root-context", expectedPrincipalContext: "principal-context",
      denialId: "denial-one", expectedUpdatedAt: "2026-09-02 12:00:00", reasonCode: "operator_workspace_restore" };
    const result = await reactivateClientPortalWorkspaceAccess(env, actor, context, "principal-one", input, "workspace-restore-key-0001");
    expect(mocks.revoke).toHaveBeenCalledWith(env, actor, "denial-one", "2026-09-02 12:00:00",
      "operator_workspace_restore", "workspace-restore-key-0001");
    expect(result).toMatchObject({ outcome: "workspace_access_reactivated", replayed: false });
  });

  it("rejects a denial from another workspace or stale row before any authority write", async () => {
    mocks.target.mockResolvedValue({ ...baseTarget, workspaceAccessSuspended: true, workspaceDenialCount: 1,
      removableWorkspaceDenialId: "denial-one", removableWorkspaceDenialUpdatedAt: "2026-09-02 12:00:00",
      actions: { canSuspendWorkspaceAccess: false, canReactivateWorkspaceAccess: true } });
    await expect(reactivateClientPortalWorkspaceAccess(env, actor, context, "principal-one", {
      expectedContextVersion: "root-context", expectedPrincipalContext: "principal-context",
      denialId: "foreign-workspace-denial", expectedUpdatedAt: "2026-09-02 12:00:00",
      reasonCode: "operator_workspace_restore",
    }, "workspace-restore-key-0002")).rejects.toMatchObject({ status: 409 });
    expect(mocks.revoke).not.toHaveBeenCalled();
  });
});
