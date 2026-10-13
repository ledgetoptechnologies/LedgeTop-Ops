import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ admin: vi.fn(), grant: vi.fn(), resolve: vi.fn(), current: vi.fn() }));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery", () => ({
  currentDirectoryRelationshipRecoveryAdministrator: mocks.admin,
}));
vi.mock("../src/worker/native-directory-profile-routes", () => ({ selectGrant: mocks.grant }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: mocks.resolve }));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-service", () => ({
  validateDirectoryRelationshipRecoveryReviewCurrent: mocks.current,
}));
import { readDirectoryRelationshipRecoveryStatus } from "../src/worker/project-alpha-directory-relationship-generation-recovery-status";

const actor = { staffId: "staff-1", accessSubject: "subject-1", email: "owner@example.test", admissionVersion: 3,
  profileVersion: 4, verifiedUntil: "2999-01-01T00:00:00.000Z" };
const identity = { instance: "10000000-0000-4000-8000-000000000001", application: "20000000-0000-4000-8000-000000000002",
  epoch: "30000000-0000-4000-8000-000000000003" };
const permissions = ["directory.profile.view", "directory.profile.edit", "directory.identity.link", "directory.enrollment.manage"];
const selected = ["client-one", "organization-one"].flatMap(recordId => permissions.map(permission =>
  ({ recordId, permission, grantId: `${recordId}:${permission}` })));
const baseRow = { review_id: "40000000-0000-4000-8000-000000000004", client_record_id: "client-one",
  source_id: "project-alpha:staging", source_instance_id: identity.instance, application_id: identity.application,
  history_epoch_id: identity.epoch, destination_origin: "https://pa.example.test", predecessor_command_id: "50000000-0000-4000-8000-000000000005",
  intended_organization_record_id: "organization-one", expected_client_revision: "7", expected_organization_revision: "9",
  observed_authorization_generation: "12", evidence_sha256: "a".repeat(64), reviewer_staff_id: actor.staffId,
  reviewer_access_subject: actor.accessSubject, reviewer_email: actor.email, reviewer_admission_version: actor.admissionVersion,
  reviewer_profile_version: actor.profileVersion, selected_grants_json: JSON.stringify(selected),
  expires_at: "2999-01-01T00:00:00.000Z", state: "open", authorization_id: null, outbox_state: null, attempts: null, updated_at: null };

function fixture(row: Record<string, unknown> | null = baseRow) {
  const statement = { bind: vi.fn(() => statement), all: vi.fn(async () => ({ results: row ? [row] : [] })) };
  const db = { withSession: vi.fn(() => db), prepare: vi.fn(() => statement) } as unknown as D1Database;
  return { db, env: { OPS_DB: db, PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "true",
    PROJECT_ALPHA_API_V2_CONNECTIONS: "configured" } };
}

describe("relationship recovery read-only status", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.admin.mockResolvedValue(true);
    mocks.current.mockResolvedValue("current");
    mocks.grant.mockImplementation((_db, _staff, permission, record) => Promise.resolve(`${record}:${permission}`));
    mocks.resolve.mockReturnValue({ enabled: true, connection: { baseUrl: "https://pa.example.test",
      expectedSourceInstanceId: identity.instance, expectedApplicationId: identity.application, expectedHistoryEpoch: identity.epoch } });
  });

  it("is default-off before database or authority access", async () => {
    const { db } = fixture();
    await expect(readDirectoryRelationshipRecoveryStatus({ OPS_DB: db }, { recordId: "client-one" }, actor)).resolves.toEqual({ status: "none" });
    expect(db.withSession).not.toHaveBeenCalled(); expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("returns only the sealed review comparison for a current open review", async () => {
    const { env } = fixture();
    await expect(readDirectoryRelationshipRecoveryStatus(env, { recordId: "client-one" }, actor)).resolves.toEqual({ status: "review_ready",
      review: { reviewId: baseRow.review_id, recordId: "client-one", sourceId: "project-alpha:staging",
        predecessorCommandId: baseRow.predecessor_command_id, evidenceSha256: "a".repeat(64), clientRevision: "7",
        organizationRevision: "9", organizationRecordId: "organization-one", remoteParentPublicId: null,
        observedAuthorizationGeneration: "12", expiresAt: baseRow.expires_at } });
  });

  it.each([
    ["pending", 0, "prepared"], ["pending", 2, "dispatch_pending"], ["leased", 1, "dispatch_pending"],
    ["acknowledged", 1, "acknowledged"], ["terminal", 1, "terminal"],
  ] as const)("maps immutable %s outbox state without exposing its outcome", async (outboxState, attempts, status) => {
    const row = { ...baseRow, state: "authorized" as const, authorization_id: "60000000-0000-4000-8000-000000000006",
      outbox_state: outboxState, attempts, updated_at: "2026-10-10T00:00:00.000Z", expires_at: "2026-10-09T00:00:00.000Z" };
    const { env } = fixture(row);
    await expect(readDirectoryRelationshipRecoveryStatus(env, { recordId: "client-one" }, actor)).resolves.toEqual({ status,
      sourceId: "project-alpha:staging", updatedAt: row.updated_at });
  });

  it("fails closed when current reviewer authority or the exact grant set changed", async () => {
    const { env } = fixture(); mocks.grant.mockResolvedValueOnce(null);
    await expect(readDirectoryRelationshipRecoveryStatus(env, { recordId: "client-one" }, actor)).resolves.toEqual({
      status: "authority_revoked" });
  });

  it("does not fall back to or disclose the source of an older actor-owned review", async () => {
    const { env } = fixture({ ...baseRow, reviewer_staff_id: "different-reviewer" });
    await expect(readDirectoryRelationshipRecoveryStatus(env, { recordId: "client-one" }, actor)).resolves.toEqual({
      status: "authority_revoked" });
    expect(mocks.grant).not.toHaveBeenCalled();
  });
});
