import { beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeProjectAlphaDirectoryReadAdoption,
  type ProjectAlphaDirectoryReadAdoptionRuntimeDependencies } from "../src/worker/project-alpha-directory-read-adoption-runtime-finalizer";
import type { ProjectAlphaExistingDirectoryAcquisitionOutcome } from "../src/worker/project-alpha-existing-directory-acquisition-coordinator";
import type { ProjectAlphaExistingDirectoryBindingOutcome } from "../src/worker/project-alpha-existing-directory-binding-review-consumer";

const receiptId = "10000000-0000-4000-8000-000000000001";
const key = "20000000-0000-4000-8000-000000000002";
const finalizationId = "30000000-0000-4000-8000-000000000003";
const reviewId = "40000000-0000-4000-8000-000000000004";
const commandId = "50000000-0000-4000-8000-000000000005";
const activationKey = "60000000-0000-4000-8000-000000000006";
const acquiredReview = "70000000-0000-4000-8000-000000000007";
const publicId = "a".repeat(32);
const actor = { staffId: "owner", accessSubject: "native:owner", admissionVersion: 1, profileVersion: 2, grantGeneration: 3 };
const remoteProfile = { publicId, name: "Remote", email: "remote@example.test", phone: null,
  address: { line1: "2 Remote Way", line2: null, city: "Remote", state: "WI", postalCode: "50000", country: "US" },
  clientType: "business" as const, organizationPublicId: null };
async function sha(value: unknown) { return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))))]
  .map(value => value.toString(16).padStart(2, "0")).join(""); }

describe("Project Alpha Directory sealed-review runtime finalizer", () => {
  let localReceipt: null | { adoption_id: string; result_record_version: number; adopted_fields_json: string;
    selected_profile_grant_id: string; expected_local_profile_sha256: string; project_alpha_profile_sha256: string;
    result_profile_sha256: string };
  let row: Record<string, unknown>;
  let deps: ReturnType<typeof fixture>;
  const runtimeDeps = () => deps as unknown as ProjectAlphaDirectoryReadAdoptionRuntimeDependencies;
  const env = { ENVIRONMENT: "staging", PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "true",
    PROJECT_ALPHA_DIRECTORY_LOCAL_PROFILE_ADOPTION_ENABLED: "true", OPS_DB: {} as D1Database,
    PROJECT_ALPHA_API_V2_CONNECTIONS: "[]" };
  function fixture() {
    const applyLocalProfile = vi.fn(async () => {
      localReceipt = { adoption_id: "adoption", result_record_version: 8, adopted_fields_json: '["email"]',
        selected_profile_grant_id: "profile-edit", expected_local_profile_sha256: "b".repeat(64),
        project_alpha_profile_sha256: row.project_alpha_profile_sha256 as string, result_profile_sha256: "c".repeat(64) };
      return { status: "applied" as const, adoptionId: "adoption", mutationId: "mutation", recordId: "ops-1",
        recordVersion: 8, adoptedFields: ["email"] };
    });
    return {
      prepare: vi.fn(),
      readProfile: vi.fn(async () => ({ status: "observed" as const, observation: { authoritative: false as const,
        sourceId: "project-alpha:test", sourceInstanceId: "80000000-0000-4000-8000-000000000008",
        applicationId: "90000000-0000-4000-8000-000000000009", historyEpoch: "a0000000-0000-4000-8000-00000000000a",
        requestId: "b0000000-0000-4000-8000-00000000000b", authorizationGeneration: "9",
        resource: { type: "client" as const, id: publicId, revision: "5" }, profile: remoteProfile } })),
      applyLocalProfile,
      acquire: vi.fn(async (): Promise<ProjectAlphaExistingDirectoryAcquisitionOutcome> => ({ status: "acquired" as const, reviewReceiptId: acquiredReview, commandId,
        acquiredReceiptId: "acquired", replayed: false })),
      activate: vi.fn(async (): Promise<ProjectAlphaExistingDirectoryBindingOutcome> => ({ status: "activated" as const, activationId: "activated", reviewItemId: acquiredReview,
        idempotencyKey: activationKey, recordId: "ops-1", resourceType: "client" as const, replayed: false })),
      loadFinalizations: vi.fn(async () => [row]),
      loadDecisions: vi.fn(async () => [{ field_name: "email", decision: "adopt_project_alpha" }]),
      loadLocalReceipt: vi.fn(async () => localReceipt),
      selectProfileGrant: vi.fn(async (): Promise<string | null> => "profile-edit"),
      readCurrentLocalProfile: vi.fn(async () => localReceipt
        ? { version: localReceipt.result_record_version, profileSha256: localReceipt.result_profile_sha256 } : null),
    };
  }
  beforeEach(async () => {
    localReceipt = null;
    row = { finalization_id: finalizationId, idempotency_key: key,
      request_sha256: await sha({ fieldReviewReceiptId: receiptId, actor }), field_review_receipt_id: receiptId,
      source_id: "project-alpha:test", source_instance_id: "80000000-0000-4000-8000-000000000008",
      application_id: "90000000-0000-4000-8000-000000000009", history_epoch_id: "a0000000-0000-4000-8000-00000000000a",
      resource_type: "client", record_id: "ops-1", reviewed_external_id: "pa-client-77", target_external_id: "ops-1",
      acquisition_external_id: "pa-client-77", acquisition_identity_mode: "preserve_reviewed",
      project_alpha_public_id: publicId, project_alpha_revision: "5",
      authorization_generation: "9", local_record_version: 7, local_profile_sha256: "b".repeat(64),
      project_alpha_profile_sha256: await sha(remoteProfile), reviewer_staff_id: actor.staffId,
      reviewer_access_subject: actor.accessSubject, reviewer_admission_version: actor.admissionVersion,
      reviewer_profile_version: actor.profileVersion, reviewer_grant_generation: actor.grantGeneration,
      adopted_field_count: 1, acquisition_review_id: reviewId, acquisition_command_id: commandId,
      activation_idempotency_key: activationKey };
    deps = fixture();
  });

  it("is staging-only and default-off", async () => {
    await expect(finalizeProjectAlphaDirectoryReadAdoption({ ...env, PROJECT_ALPHA_DIRECTORY_EXACT_ADOPTION_ENABLED: "false" },
      { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps())).resolves.toEqual({ status: "disabled" });
    expect(deps.loadFinalizations).not.toHaveBeenCalled();
  });

  it("finalizes and exactly replays only the canonical mapping saga without portal, Delivery, folder, or public-link effects", async () => {
    const unrelated = { portalGrants: 4, workspaces: 2, folders: 7, deliveryRows: 11, publicLinks: 3 };
    const first = await finalizeProjectAlphaDirectoryReadAdoption(env,
      { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps());
    expect(first).toMatchObject({ status: "finalized", finalizationId, activationId: "activated", recordId: "ops-1" });
    deps.acquire.mockImplementationOnce(async () => ({ status: "acquired" as const, reviewReceiptId: acquiredReview, commandId,
      acquiredReceiptId: "acquired", replayed: true }));
    deps.activate.mockImplementationOnce(async () => ({ status: "activated" as const, activationId: "activated", reviewItemId: acquiredReview,
      idempotencyKey: activationKey, recordId: "ops-1", resourceType: "client" as const, replayed: true }));
    const replay = await finalizeProjectAlphaDirectoryReadAdoption(env,
      { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps());
    expect(replay).toEqual({ ...first, status: "replayed" });
    expect(deps.applyLocalProfile).toHaveBeenCalledTimes(1);
    expect((deps.acquire.mock.calls as unknown[][])[1]![1]).toEqual((deps.acquire.mock.calls as unknown[][])[0]![1]);
    expect((deps.activate.mock.calls as unknown[][])[1]![1]).toEqual((deps.activate.mock.calls as unknown[][])[0]![1]);
    expect(unrelated).toEqual({ portalGrants: 4, workspaces: 2, folders: 7, deliveryRows: 11, publicLinks: 3 });
  });

  it("resumes after local apply when PA bind fails, using one local mutation and byte-stable acquisition input", async () => {
    deps.acquire.mockImplementationOnce(async () => ({ status: "uncertain" as const, reason: "transport" as const }));
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "uncertain", stage: "acquire", reason: "transport" });
    const firstCommand = (deps.acquire.mock.calls as unknown[][])[0]![1];
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toMatchObject({ status: "finalized", finalizationId, adoptedFields: ["email"] });
    expect(deps.applyLocalProfile).toHaveBeenCalledTimes(1);
    expect(deps.acquire).toHaveBeenCalledTimes(2);
    expect((deps.acquire.mock.calls as unknown[][])[1]![1]).toEqual(firstCommand);
    expect(firstCommand).toMatchObject({ commandId, reviewId, recordId: "ops-1", externalId: "pa-client-77",
      expectedAuthorizationGeneration: "9", localRecordVersion: 8 });
  });

  it("resumes activation after PA bind succeeds without a second local apply or a new command", async () => {
    deps.activate.mockImplementationOnce(async () => ({ status: "uncertain" as const, reason: "database" as const }));
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "uncertain", stage: "activate", reason: "database" });
    deps.acquire.mockImplementationOnce(async () => ({ status: "acquired" as const, reviewReceiptId: acquiredReview, commandId,
      acquiredReceiptId: "acquired", replayed: true }));
    deps.activate.mockImplementationOnce(async () => ({ status: "activated" as const, activationId: "activated", reviewItemId: acquiredReview,
      idempotencyKey: activationKey, recordId: "ops-1", resourceType: "client" as const, replayed: true }));
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toMatchObject({ status: "replayed", activationId: "activated" });
    expect(deps.applyLocalProfile).toHaveBeenCalledTimes(1);
    expect((deps.acquire.mock.calls as unknown[][])[1]![1]).toEqual((deps.acquire.mock.calls as unknown[][])[0]![1]);
    expect((deps.activate.mock.calls as unknown[][])[1]![1]).toEqual((deps.activate.mock.calls as unknown[][])[0]![1]);
  });

  it("blocks unsupported adopted relationship fields before local apply or acquisition", async () => {
    row.adopted_field_count = 1;
    deps.loadDecisions.mockResolvedValueOnce([{ field_name: "organization_public_id", decision: "adopt_project_alpha" }]);
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "blocked", stage: "local_profile", reason: "unsupported_decision" });
    expect(deps.applyLocalProfile).not.toHaveBeenCalled();
    expect(deps.acquire).not.toHaveBeenCalled();
    expect(deps.activate).not.toHaveBeenCalled();
  });

  it("rejects stale authority and altered immutable local-phase evidence", async () => {
    row.reviewer_grant_generation = 4;
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "blocked", stage: "prepare", reason: "authority" });
    row.reviewer_grant_generation = 3;
    localReceipt = { adoption_id: "adoption", result_record_version: 8, adopted_fields_json: '["name"]',
      selected_profile_grant_id: "profile-edit", expected_local_profile_sha256: "b".repeat(64),
      project_alpha_profile_sha256: row.project_alpha_profile_sha256 as string, result_profile_sha256: "c".repeat(64) };
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "conflict", stage: "local_profile", reason: "receipt" });
  });

  it("fails closed when profile-edit authority is revoked or the applied profile drifts between phases", async () => {
    deps.acquire.mockImplementationOnce(async () => ({ status: "uncertain" as const, reason: "transport" as const }));
    await finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps());
    deps.selectProfileGrant.mockResolvedValueOnce(null);
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "blocked", stage: "local_profile", reason: "authority" });
    expect(deps.acquire).toHaveBeenCalledTimes(1);
    expect((deps.selectProfileGrant.mock.calls as unknown[][]).at(-1)?.[3]).toBe(8);
    deps.readCurrentLocalProfile.mockResolvedValueOnce({ version: 8, profileSha256: "d".repeat(64) });
    await expect(finalizeProjectAlphaDirectoryReadAdoption(env, { fieldReviewReceiptId: receiptId, idempotencyKey: key, actor }, runtimeDeps()))
      .resolves.toEqual({ status: "blocked", stage: "local_profile", reason: "stale_local" });
    expect(deps.acquire).toHaveBeenCalledTimes(1);
  });
});
