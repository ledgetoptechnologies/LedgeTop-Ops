import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn(), proof: vi.fn(), profile: vi.fn(), binding: vi.fn(), inventory: vi.fn(), plan: vi.fn() }));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({ resolveProjectAlphaApiV2Connection: mocks.resolve }));
vi.mock("../src/worker/project-alpha-directory-relationship-api-v2", () => ({
  sendConfiguredProjectAlphaDirectoryRelationshipCommand: mocks.send,
  validatedProjectAlphaDirectoryRelationshipGenerationConflict: mocks.proof,
}));
vi.mock("../src/worker/project-alpha-directory-command-api-v2", () => ({ readConfiguredProjectAlphaDirectoryInventory: mocks.inventory }));
vi.mock("../src/worker/project-alpha-directory-read-api-v2", () => ({
  readConfiguredProjectAlphaDirectoryProfile: mocks.profile,
  readConfiguredProjectAlphaDirectoryBindingStatus: mocks.binding,
}));
vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery-proposal", () => ({
  planDirectoryRelationshipGenerationRecovery: mocks.plan,
}));

import { collectDirectoryRelationshipGenerationRecoveryEvidence } from "../src/worker/project-alpha-directory-relationship-generation-recovery-evidence";

const ids = { instance: "10000000-0000-4000-8000-000000000001", application: "20000000-0000-4000-8000-000000000002",
  epoch: "30000000-0000-4000-8000-000000000003", predecessor: "40000000-0000-4000-8000-000000000004",
  successor: "50000000-0000-4000-8000-000000000005", conflict: "60000000-0000-4000-8000-000000000006",
  clientRead: "70000000-0000-4000-8000-000000000007", organizationRead: "80000000-0000-4000-8000-000000000008",
  bindingRead: "90000000-0000-4000-8000-000000000009", inventoryRead: "a0000000-0000-4000-8000-00000000000a" };
const sourceId = "project-alpha:staging", clientPublicId = "a".repeat(32), organizationPublicId = "b".repeat(32);
const predecessor = { commandId: ids.predecessor, expectedClientRevision: "7", expectedAuthorizationGeneration: "11",
  expectedCurrentOrganizationPublicId: null, organization: { externalId: "org-external", publicId: organizationPublicId, expectedRevision: "9" } };
const predecessorCommandJson = JSON.stringify(predecessor);
const input = { sourceId, clientExternalId: "client-external", clientPublicId, targetOrganizationExternalId: "org-external", targetOrganizationPublicId: organizationPublicId,
  predecessorCommandJson, successorCommandId: ids.successor };
const identity = { sourceId, sourceInstanceId: ids.instance, applicationId: ids.application, historyEpoch: ids.epoch };
const env = { PROJECT_ALPHA_API_V2_CONNECTIONS: "pinned-config" };
const profile = (kind: "client" | "organization", parent: string | null = null) => ({ status: "observed", observation: { authoritative: false, ...identity,
  requestId: kind === "client" ? ids.clientRead : ids.organizationRead, authorizationGeneration: "12",
  resource: { type: kind, id: kind === "client" ? clientPublicId : organizationPublicId, revision: kind === "client" ? "7" : "9" },
  profile: { publicId: kind === "client" ? clientPublicId : organizationPublicId, name: "private", email: "private@example.test", phone: null,
    address: { line1: null, line2: null, city: null, state: null, postalCode: null, country: null },
    ...(kind === "client" ? { clientType: "business", organizationPublicId: parent } : {}) } } });
const binding = () => ({ status: "observed", observation: { authoritative: false, ...identity, requestId: ids.bindingRead,
  authorizationGeneration: "12", binding: { type: "organization", externalId: "org-external", publicId: organizationPublicId,
    createdAt: "2026-10-10T00:00:00.000Z" }, resource: { revision: "9", present: true } } });
const inventoryResources = () => [
    { type: "client", publicId: clientPublicId, revision: "7", present: true, lastAction: "upsert", projectionSha256: "1".repeat(64),
      binding: { externalId: "client-external", status: "active", resourceRevision: "7" } },
    { type: "organization", publicId: organizationPublicId, revision: "9", present: true, lastAction: "upsert", projectionSha256: "2".repeat(64),
      binding: { externalId: "org-external", status: "active", resourceRevision: "9" } },
  ];
const inventory = (nextCursor: string | null = null, resources = inventoryResources(), requestIdValue = ids.inventoryRead) =>
  ({ status: "observed", inventory: { authoritative: false, ...identity, requestId: requestIdValue,
    authorizationGeneration: "12", resources, nextCursor } });

describe("relationship generation recovery evidence collector", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolve.mockReturnValue({ sourceId, enabled: true, connection: { baseUrl: "https://pa.example.test", expectedSourceInstanceId: ids.instance,
      expectedApplicationId: ids.application, expectedHistoryEpoch: ids.epoch } });
    mocks.send.mockResolvedValue({ status: "conflict", reason: "http_status", httpStatus: 409 });
    mocks.proof.mockReturnValue({ command: predecessor, destinationOrigin: "https://pa.example.test",
      requestPath: `/api/v2/directory/clients/${clientPublicId}/organization/assign/commands`, response: { apiVersion: "2", ...identity,
        requestId: ids.conflict, error: { code: "authorization_generation_conflict" } } });
    mocks.profile.mockImplementation((_env, _source, kind) => Promise.resolve(profile(kind)));
    mocks.binding.mockResolvedValue(binding()); mocks.inventory.mockResolvedValue(inventory());
    mocks.plan.mockReturnValue({ ...predecessor, commandId: ids.successor, expectedAuthorizationGeneration: "12" });
  });

  it("returns sanitized sealed evidence, the planned successor, and the root inventory page", async () => {
    const result = await collectDirectoryRelationshipGenerationRecoveryEvidence(env, input);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    expect(result.evidence).toMatchObject({ predecessorCommandId: ids.predecessor, successorCommandId: ids.successor,
      observedAuthorizationGeneration: "12", remoteParentPublicId: null,
      replayConflictJson: JSON.stringify(mocks.proof.mock.results[0]?.value?.response),
      replayRequestPath: `/api/v2/directory/clients/${clientPublicId}/organization/assign/commands`,
      evidenceSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(result.evidence).not.toHaveProperty("name"); expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(result.inventoryPagesForRootPersistence).toHaveLength(1);
    expect(result.evidence.readRequestIds).toMatchObject({ clientInventory: ids.inventoryRead, organizationInventory: ids.inventoryRead });
    expect(mocks.send.mock.calls[0]![0]).not.toBe(env);
    expect(mocks.send.mock.calls[0]![0]).toEqual(env);
  });

  it("rejects a generic 409 without branded structured proof", async () => {
    mocks.proof.mockReturnValueOnce(null);
    await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, input)).resolves.toEqual({ status: "blocked", reason: "conflict_proof" });
    expect(mocks.profile).not.toHaveBeenCalled();
  });

  it("rejects byte-changed predecessor replay", async () => {
    const changed = { ...input, predecessorCommandJson: predecessorCommandJson.replace(",\"expectedClientRevision\"", ", \"expectedClientRevision\"") };
    await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, changed)).resolves.toEqual({ status: "blocked", reason: "not_eligible" });
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("rejects a replay that is no longer the structured generation conflict", async () => {
    mocks.send.mockResolvedValueOnce({ status: "acknowledged", httpStatus: 200 }); mocks.proof.mockReturnValueOnce(null);
    await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, input)).resolves.toEqual({ status: "blocked", reason: "conflict_proof" });
  });

  it.each([
    ["already applied parent", () => { const value = profile("client", organizationPublicId); mocks.profile.mockImplementation((_e, _s, kind) => Promise.resolve(kind === "client" ? value : profile("organization"))); }, "remote_state"],
    ["client revision drift", () => { const value = profile("client"); value.observation.resource.revision = "8"; mocks.profile.mockImplementation((_e, _s, kind) => Promise.resolve(kind === "client" ? value : profile("organization"))); }, "remote_state"],
    ["generation drift", () => { const value = binding(); value.observation.authorizationGeneration = "13"; mocks.binding.mockResolvedValue(value); }, "generation"],
    ["identity drift", () => { const value = inventory(); value.inventory.sourceInstanceId = "f0000000-0000-4000-8000-00000000000f"; mocks.inventory.mockResolvedValue(value); }, "configuration"],
    ["binding drift", () => { const value = binding(); value.observation.resource.revision = "10"; mocks.binding.mockResolvedValue(value); }, "remote_state"],
  ])("fails closed for %s", async (_label, mutate, reason) => {
    mutate(); await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, input)).resolves.toEqual({ status: "blocked", reason });
  });

  it("walks bounded pages until both exact inventory resources are independently observed", async () => {
    const resources = inventoryResources();
    const first = inventory(`client:${clientPublicId}`, [resources[0]!] ), second = inventory(null, [resources[1]!], ids.organizationRead);
    mocks.inventory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const result = await collectDirectoryRelationshipGenerationRecoveryEvidence(env, input);
    expect(result.status).toBe("observed");
    if (result.status !== "observed") return;
    expect(result.inventoryPagesForRootPersistence).toHaveLength(2);
    expect(result.evidence.readRequestIds).toMatchObject({ clientInventory: ids.inventoryRead, organizationInventory: ids.organizationRead });
    expect(mocks.inventory.mock.calls[1]![2]).toMatchObject({ cursor: `client:${clientPublicId}`, limit: 200 });
  });

  it("fails closed on a repeated inventory cursor without fabricating missing organization evidence", async () => {
    const page = inventory(`client:${clientPublicId}`, [inventoryResources()[0]!]);
    mocks.inventory.mockResolvedValue(page);
    await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, input)).resolves.toEqual({ status: "blocked", reason: "remote_state" });
    expect(mocks.inventory).toHaveBeenCalledTimes(2);
  });

  it("fails before network access for wrong configured identity", async () => {
    mocks.resolve.mockReturnValueOnce({ sourceId, enabled: false, connection: {} });
    await expect(collectDirectoryRelationshipGenerationRecoveryEvidence(env, input)).resolves.toEqual({ status: "blocked", reason: "configuration" });
    expect(mocks.send).not.toHaveBeenCalled();
  });
});
