import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientHubCollectionContext } from "../src/worker/client-hub-collections";
import type { Env, StaffPrincipal } from "../src/worker/types";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), propose: vi.fn(), read: vi.fn(), resolve: vi.fn() }));
vi.mock("../src/worker/native-staff-auth", () => ({ authenticateNativeStaffWithAdmissionVersion: mocks.auth }));
vi.mock("../src/worker/project-alpha-project-inbound-reconciliation", () => ({
  proposeProjectAlphaInboundProjectEdit: mocks.propose,
  readProjectAlphaInboundProjectProposal: mocks.read,
  resolveProjectAlphaInboundProjectEdit: mocks.resolve,
}));

import { proposeClientHubProjectInboundReview, readClientHubProjectInboundReview,
  resolveClientHubProjectInboundReview } from "../src/worker/client-hub-project-inbound-review";

const principal: StaffPrincipal = { id: "staff-1", email: "staff@example.test", displayName: "Staff",
  accessSubject: "access|staff-1", projectAlphaUserId: null };
const context: ClientHubCollectionContext = {
  root: { kind: "organization", display_name: "Org", source_id: "project-alpha:primary",
    root_namespace: "business", public_id: "a".repeat(32), pa_internal_id: "pa-org", pa_public_id: "a".repeat(32),
    mapping_status: "mapped" } as unknown as ClientHubCollectionContext["root"],
  access: { directory: true, requests: true, delivery: true, viewer: true }, contextVersion: "c".repeat(64),
  canonicalRoot: { sourceId: "project-alpha:primary", rootNamespace: "business", kind: "organization", publicId: "a".repeat(32) },
};
const key = "10000000-0000-4000-8000-000000000001", proposalId = "10000000-0000-4000-8000-000000000002";
const env = (enabled = true) => ({ PROJECT_ALPHA_PROJECT_INBOUND_RECONCILIATION_ENABLED: enabled ? "true" : "false",
  TEAM_DOMAIN: "https://team.cloudflareaccess.com", OPERATIONS_AUD: "aud", OPS_DB: {} }) as unknown as Env;
const request = (idempotencyKey = key) => new Request("https://ops.example.test/review", {
  method: "POST", headers: { "Idempotency-Key": idempotencyKey }, body: "{}",
});
const available = { status: "available", proposal: { proposalId, sourceId: "project-alpha:primary",
  externalProjectId: "project-1", expectedLocalVersion: 1, expiresAt: "2999-01-01T00:00:00.000Z",
  projectAlphaPublicId: "b".repeat(32), operations: {}, projectAlpha: {}, changedFields: ["name"] } } as const;

describe("Client Hub project inbound review adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.auth.mockResolvedValue({ admissionVersion: 2, verifiedUntil: "2999-01-01T00:00:00.000Z",
      identity: { staffId: principal.id, verifiedAccessSubject: principal.accessSubject, email: principal.email, profileVersion: 3 } });
    mocks.propose.mockResolvedValue({ status: "proposed", proposalId, replayed: false });
    mocks.read.mockResolvedValue(available);
    mocks.resolve.mockResolvedValue({ status: "resolved", resolutionId: key, decision: "accept_project_alpha",
      syncStatus: "synchronized", resultingVersion: 2, replayed: false });
  });

  it("binds a positive proposal and resolution to the native principal and exact route context", async () => {
    await expect(proposeClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key })).resolves.toMatchObject({ status: "proposed" });
    expect(mocks.propose).toHaveBeenCalledWith(expect.anything(),
      { staffId: principal.id, accessSubject: principal.accessSubject },
      { idempotencyKey: key, sourceId: "project-alpha:primary", externalProjectId: "project-1" });
    await expect(resolveClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key, proposalId,
        decision: "accept_project_alpha" })).resolves.toMatchObject({ status: "resolved" });
  });

  it("is default-off before authentication or core access", async () => {
    await expect(proposeClientHubProjectInboundReview(env(false), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key })).rejects.toMatchObject({ status: 404 });
    expect(mocks.auth).not.toHaveBeenCalled(); expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("denies a principal that does not match the trusted native identity", async () => {
    mocks.auth.mockResolvedValueOnce({ identity: { staffId: "other", verifiedAccessSubject: principal.accessSubject,
      email: principal.email, profileVersion: 3 }, admissionVersion: 2 });
    await expect(proposeClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key })).rejects.toMatchObject({ status: 403 });
    expect(mocks.propose).not.toHaveBeenCalled();
  });

  it("rejects mismatched project context and cross-project proposal evidence", async () => {
    await expect(proposeClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: "d".repeat(64), idempotencyKey: key })).rejects.toMatchObject({ status: 409 });
    mocks.read.mockResolvedValueOnce({ ...available, proposal: { ...available.proposal, externalProjectId: "project-2" } });
    await expect(readClientHubProjectInboundReview(env(), request(), principal, context, "project-1", proposalId,
      context.contextVersion)).rejects.toMatchObject({ status: 404 });
  });

  it("preserves stale-evidence outcomes without converting them to success", async () => {
    mocks.read.mockResolvedValueOnce({ status: "unavailable", reason: "stale_evidence" });
    await expect(readClientHubProjectInboundReview(env(), request(), principal, context, "project-1", proposalId,
      context.contextVersion)).resolves.toEqual({ status: "unavailable", reason: "stale_evidence" });
    mocks.read.mockResolvedValueOnce({ status: "unavailable", reason: "stale_evidence" });
    await expect(resolveClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key, proposalId,
        decision: "requires_follow_up" })).rejects.toMatchObject({ status: 409 });
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("passes replay results through and rejects the unsupported keep-Operations label", async () => {
    mocks.propose.mockResolvedValueOnce({ status: "proposed", proposalId, replayed: true });
    await expect(proposeClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key })).resolves.toMatchObject({ replayed: true });
    await expect(resolveClientHubProjectInboundReview(env(), request(), principal, context, "project-1",
      { expectedContextVersion: context.contextVersion, idempotencyKey: key, proposalId,
        decision: "keep_operations" })).rejects.toMatchObject({ status: 400 });
  });
});
