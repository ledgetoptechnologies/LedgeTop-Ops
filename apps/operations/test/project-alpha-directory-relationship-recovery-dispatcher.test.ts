import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  validate: vi.fn(), load: vi.fn(), live: vi.fn(), claim: vi.fn(), release: vi.fn(), settle: vi.fn(),
  sendCommand: vi.fn(), validatedAck: vi.fn(), isCommand: vi.fn(), withConnection: vi.fn(),
}));

vi.mock("../src/worker/project-alpha-directory-relationship-generation-recovery", () => ({
  validateDirectoryRelationshipRecoveryReservation: mocks.validate,
}));
vi.mock("../src/worker/project-alpha-directory-effective-relationship-commands", () => ({
  loadEffectiveRelationshipCommand: mocks.load,
  isEffectiveRelationshipCommandLive: mocks.live,
  claimEffectiveRelationshipCommand: mocks.claim,
  releaseEffectiveRelationshipCommand: mocks.release,
  settleEffectiveRelationshipCommand: mocks.settle,
}));
vi.mock("../src/worker/project-alpha-directory-relationship-api-v2", () => ({
  isProjectAlphaDirectoryRelationshipCommand: mocks.isCommand,
  sendProjectAlphaDirectoryOrganizationRelationshipCommand: mocks.sendCommand,
  validatedProjectAlphaDirectoryCommandAcknowledgement: mocks.validatedAck,
}));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.withConnection,
}));

import { dispatchProjectAlphaDirectoryRelationshipCommand } from
  "../src/worker/project-alpha-directory-relationship-outbox-dispatcher";

const commandId = "00000000-0000-4000-8000-000000000001";
const sourceId = "project-alpha:staging";
const command = { commandId, expectedClientRevision: "4", expectedAuthorizationGeneration: "7",
  expectedCurrentOrganizationPublicId: null,
  organization: { externalId: "org/external", publicId: "a".repeat(32), expectedRevision: "3" } };
const commandJson = JSON.stringify(command);
const row = { command_id: commandId, source_id: sourceId,
  source_instance_id: "00000000-0000-4000-8000-000000000002",
  application_id: "00000000-0000-4000-8000-000000000003",
  history_epoch_id: "00000000-0000-4000-8000-000000000004",
  destination_origin: "https://pa.example.test", client_public_id: "b".repeat(32), action: "assign",
  command_json: commandJson, request_json: "{}", state: "pending", attempts: 0, next_attempt_at: 0,
  lease_expires_at: null, outcome_json: null };
const leased = { ...row, state: "leased", attempts: 1, lease_expires_at: Date.now() + 60_000 };
const connection = { expectedSourceInstanceId: row.source_instance_id, expectedApplicationId: row.application_id,
  expectedHistoryEpoch: row.history_epoch_id, baseUrl: row.destination_origin };

function environment(flag: string | undefined) {
  return { OPS_DB: {} as D1Database, PROJECT_ALPHA_API_V2_CONNECTIONS: "configured",
    PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: flag };
}

const acknowledgedResponse = { requestId: "00000000-0000-4000-8000-000000000005", replayed: false,
  sourceInstanceId: row.source_instance_id, applicationId: row.application_id, historyEpoch: row.history_epoch_id,
  result: { action: "assign", client: { publicId: row.client_public_id, revision: "5" },
    organizationPublicId: command.organization.publicId, authorizationGeneration: "7" } };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.load.mockResolvedValueOnce(row).mockResolvedValueOnce(leased);
  mocks.live.mockResolvedValue(true);
  mocks.claim.mockResolvedValue(true);
  mocks.release.mockResolvedValue(undefined);
  mocks.settle.mockResolvedValue(true);
  mocks.validate.mockResolvedValue(true);
  mocks.isCommand.mockReturnValue(true);
  mocks.withConnection.mockImplementation(async (_env: unknown, _source: string,
    use: (value: typeof connection) => Promise<unknown>) => ({ status: "enabled", value: await use(connection) }));
  mocks.sendCommand.mockResolvedValue({ status: "acknowledged" });
  mocks.validatedAck.mockReturnValue({ command, destinationOrigin: row.destination_origin,
    response: acknowledgedResponse });
});

describe("relationship generation recovery dispatcher", () => {
  it.each([undefined, "false", "TRUE"])('is default-off before repository or transport access (%s)', async flag => {
    const send = vi.fn();
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(environment(flag), sourceId, commandId,
      send, "generation_recovery")).resolves.toEqual({ status: "blocked", reason: "configuration" });
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.withConnection).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("uses the explicit discriminator and never falls back by colliding command ID", async () => {
    mocks.load.mockReset().mockResolvedValue(null);
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(environment("true"), sourceId, commandId,
      vi.fn(), "generation_recovery")).resolves.toEqual({ status: "blocked", reason: "in_progress" });
    expect(mocks.load).toHaveBeenCalledWith(expect.anything(), "generation_recovery", commandId);
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("validates before claim and immediately before send", async () => {
    const events: string[] = [];
    mocks.validate.mockImplementation(async () => { events.push("validate"); return true; });
    mocks.claim.mockImplementation(async () => { events.push("claim"); return true; });
    mocks.sendCommand.mockImplementation(async () => { events.push("send"); return { status: "acknowledged" }; });
    await dispatchProjectAlphaDirectoryRelationshipCommand(environment("true"), sourceId, commandId, vi.fn(),
      "generation_recovery");
    expect(events).toEqual(["validate", "claim", "validate", "send"]);
  });

  it("releases the lease and refuses transport when authority is revoked between validations", async () => {
    mocks.validate.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const send = vi.fn();
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(environment("true"), sourceId, commandId, send,
      "generation_recovery")).resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledWith(expect.anything(), "generation_recovery", leased,
      expect.any(String), expect.any(Number), expect.any(Number));
    expect(mocks.sendCommand).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("durably settles an exact branded ACK despite post-send flag or grant revocation", async () => {
    const env = environment("true");
    mocks.sendCommand.mockImplementation(async () => {
      env.PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED = "false";
      mocks.validate.mockResolvedValue(false);
      return { status: "acknowledged" };
    });
    await expect(dispatchProjectAlphaDirectoryRelationshipCommand(env, sourceId, commandId, vi.fn(),
      "generation_recovery")).resolves.toEqual({ status: "acknowledged", commandId, replayed: false,
      clientPublicId: row.client_public_id, revision: "5" });
    expect(mocks.validate).toHaveBeenCalledTimes(2);
    expect(mocks.live).toHaveBeenCalledTimes(2);
    expect(mocks.settle).toHaveBeenCalledWith(expect.anything(), "generation_recovery", commandId,
      expect.any(String), expect.any(Number), "acknowledged",
      JSON.stringify({ status: "acknowledged", response: acknowledgedResponse }));
    expect(mocks.release).not.toHaveBeenCalled();
  });
});
