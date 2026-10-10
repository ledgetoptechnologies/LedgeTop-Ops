import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  settle: vi.fn(),
  activate: vi.fn(),
  postAck: vi.fn(),
  withEnabled: vi.fn(),
  planBind: vi.fn(),
}));

vi.mock("../src/worker/project-alpha-project-v2-pending-dispatcher", () => ({
  dispatchProjectAlphaProjectV2PendingCommand: mocks.dispatch,
}));
vi.mock("../src/worker/project-alpha-project-read-settlement-adapter", () => ({
  settleProjectAlphaProjectV2Read: mocks.settle,
}));
vi.mock("../src/worker/project-alpha-project-canonical-activation-adapter", () => ({
  activateProjectAlphaProjectV2Canonical: mocks.activate,
}));
vi.mock("../src/worker/project-alpha-project-v2-post-ack-resume", () => ({
  prepareProjectAlphaProjectV2PostAckResume: mocks.postAck,
}));
vi.mock("../src/worker/project-alpha-api-v2-connections", () => ({
  withEnabledConfiguredProjectAlphaApiV2Connection: mocks.withEnabled,
}));
vi.mock("../src/worker/project-alpha-project-adoption-bind-consumer", () => ({
  planProjectAlphaProjectAdoptionBind: mocks.planBind,
}));

import {
  finalizeProjectAlphaProjectAdoption,
  type ProjectAlphaProjectAdoptionFinalizerActor,
  type ProjectAlphaProjectAdoptionFinalizerEnvironment,
} from "../src/worker/project-alpha-project-adoption-finalizer";

const reservationId = "10000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000002";
const bridgeId = "10000000-0000-4000-8000-000000000003";
const receiptId = "10000000-0000-4000-8000-000000000004";
const settlementId = "10000000-0000-4000-8000-000000000005";
const activationId = "10000000-0000-4000-8000-000000000006";
const applicationId = "10000000-0000-4000-8000-000000000007";
const actor: ProjectAlphaProjectAdoptionFinalizerActor = {
  staffId: "staff-owner",
  accessSubject: "access|owner",
  email: "owner@example.test",
  admissionVersion: 3,
  profileVersion: 4,
  verifiedUntil: "2999-01-01T00:00:00.000Z",
};
const binding = {
  bridge_id: bridgeId,
  reservation_id: reservationId,
  command_id: commandId,
  source_id: "project-alpha:primary",
  application_id: applicationId,
  external_project_id: "ops-project-1",
  reviewer_staff_id: actor.staffId,
  reviewer_access_subject: actor.accessSubject,
  reviewer_admission_version: actor.admissionVersion,
  reviewer_profile_version: actor.profileVersion,
  reviewer_owner_role_id: "role-owner",
  project_grant_generation: 9,
  normalized_scopes_json: "[]",
  reviewer_email: actor.email,
};
const action = { reservationId, commandId };
const connection = {
  baseUrl: "https://pa.example.test",
  apiKey: "private",
  expectedSourceInstanceId: "10000000-0000-4000-8000-000000000008",
  expectedApplicationId: applicationId,
  expectedHistoryEpoch: "10000000-0000-4000-8000-000000000009",
};

function environment(options: { binding?: typeof binding | null; authority?: number; enabled?: boolean;
  bindingError?: boolean; authorityError?: boolean } = {}): ProjectAlphaProjectAdoptionFinalizerEnvironment {
  const db = {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => {
          if (sql.includes("FROM project_alpha_project_adoption_bind_receipts")) {
            if (options.bindingError) throw new Error("private database detail");
            return options.binding === undefined ? binding : options.binding;
          }
          if (options.authorityError) throw new Error("private database detail");
          return options.authority ?? 1;
        }),
      })),
    })),
  } as unknown as D1Database;
  return {
    OPS_DB: db,
    PROJECT_ALPHA_API_V2_CONNECTIONS: "private",
    PROJECT_ALPHA_PROJECT_ADOPTION_FINALIZATION_ENABLED: options.enabled === false ? "false" : "true",
  };
}

const prepared = (value: string | null = null) => ({
  status: "prepared" as const,
  authorizationId: bridgeId,
  commandId,
  sourceId: binding.source_id,
  successReceiptId: receiptId,
  settlementId: value,
  replayed: false,
});
const activated = (replayed = false) => ({
  status: "activated" as const,
  activationId,
  settlementId,
  commandId,
  externalProjectId: binding.external_project_id,
  version: 2,
  replayed,
});

describe("Project Alpha project adoption finalizer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.planBind.mockResolvedValue({ status: "planned", bridgeId, reservationId, commandId,
      requestSha256: "f".repeat(64), replayed: true });
    mocks.withEnabled.mockImplementation(async (_env, _sourceId, callback) => ({
      status: "enabled", value: await callback(connection),
    }));
    mocks.settle.mockResolvedValue({ status: "settled", settlementId, successReceiptId: receiptId,
      commandId, replayed: false });
    mocks.activate.mockResolvedValue(activated(false));
  });

  it("is default-off and rejects non-exact server identity input before database or transport work", async () => {
    const disabled = environment({ enabled: false });
    expect(await finalizeProjectAlphaProjectAdoption(disabled, actor, action)).toEqual({
      stage: "preflight", outcome: { status: "blocked", reason: "disabled" },
    });
    expect(disabled.OPS_DB.prepare).not.toHaveBeenCalled();

    const enabled = environment();
    expect(await finalizeProjectAlphaProjectAdoption(enabled, actor, { ...action, sourceId: binding.source_id })).toEqual({
      stage: "preflight", outcome: { status: "rejected", reason: "invalid_action" },
    });
    expect(await finalizeProjectAlphaProjectAdoption(enabled, { ...actor, extra: true }, action)).toEqual({
      stage: "preflight", outcome: { status: "rejected", reason: "invalid_actor" },
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("fails closed on missing, substituted-caller, or no-longer-current owner authority", async () => {
    expect(await finalizeProjectAlphaProjectAdoption(environment({ binding: null }), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "blocked", reason: "missing_bind" },
    });
    expect(await finalizeProjectAlphaProjectAdoption(environment({
      binding: { ...binding, reviewer_staff_id: "different-owner" },
    }), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "blocked", reason: "authority" },
    });
    expect(await finalizeProjectAlphaProjectAdoption(environment({ authority: 0 }), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "blocked", reason: "authority" },
    });
    expect(mocks.postAck).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("derives every coordinate from the immutable bind and completes dispatch, settlement, and activation", async () => {
    mocks.postAck.mockResolvedValueOnce({ status: "blocked", reason: "stale" }).mockResolvedValueOnce(prepared());
    mocks.dispatch.mockResolvedValue({ status: "acknowledged", receiptId, replayed: false });
    const transport = vi.fn() as unknown as typeof fetch;
    const env = environment();
    expect(await finalizeProjectAlphaProjectAdoption(env, actor, action, transport)).toEqual({
      stage: "activate", outcome: activated(false),
    });
    expect(mocks.dispatch).toHaveBeenCalledWith(env, binding.source_id, commandId, transport);
    expect(mocks.postAck).toHaveBeenNthCalledWith(1, env, {
      authorizationId: bridgeId,
      commandId,
      sourceId: binding.source_id,
      expectedApplicationId: applicationId,
      reason: "Complete exact Project Alpha adoption",
    }, actor);
    expect(mocks.withEnabled).toHaveBeenCalledWith(env, binding.source_id, expect.any(Function));
    expect(mocks.settle).toHaveBeenCalledWith(env, receiptId, connection, transport);
    expect(mocks.activate).toHaveBeenCalledWith(env, settlementId);
  });

  it("returns an exact activated replay without dispatch, canonical GET, or activation work", async () => {
    mocks.postAck.mockResolvedValue(activated(true));
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "activate", outcome: activated(true),
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.withEnabled).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("denies a success replay when the authoritative bind predicate drifts after its first check", async () => {
    mocks.planBind.mockResolvedValueOnce({ status: "planned", bridgeId, reservationId, commandId,
      requestSha256: "f".repeat(64), replayed: true })
      .mockResolvedValueOnce({ status: "blocked", reason: "current_state" });
    mocks.postAck.mockResolvedValue(activated(true));
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "activate", outcome: { status: "blocked", reason: "authority" },
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.withEnabled).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not POST when the authoritative bind replay reports directory, relationship, or scope drift", async () => {
    mocks.planBind.mockResolvedValue({ status: "blocked", reason: "current_state" });
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "blocked", reason: "authority" },
    });
    expect(mocks.postAck).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("resumes acknowledged and settled commands without issuing another PA POST", async () => {
    mocks.postAck.mockResolvedValueOnce(prepared()).mockResolvedValueOnce(prepared(settlementId));
    const first = await finalizeProjectAlphaProjectAdoption(environment(), actor, action);
    expect(first).toEqual({ stage: "activate", outcome: activated(false) });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.settle).toHaveBeenCalledTimes(1);

    vi.clearAllMocks();
    mocks.postAck.mockResolvedValue(prepared(settlementId));
    mocks.activate.mockResolvedValue(activated(false));
    const second = await finalizeProjectAlphaProjectAdoption(environment(), actor, action);
    expect(second).toEqual({ stage: "activate", outcome: activated(false) });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.withEnabled).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("stops at uncertain dispatch and never opens settlement or recovery itself", async () => {
    mocks.postAck.mockResolvedValue({ status: "blocked", reason: "stale" });
    mocks.dispatch.mockResolvedValue({ status: "uncertain", reason: "lost_ack" });
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "dispatch", outcome: { status: "uncertain", reason: "lost_ack" },
    });
    expect(mocks.dispatch).toHaveBeenCalledTimes(1);
    expect(mocks.settle).not.toHaveBeenCalled();
    expect(mocks.activate).not.toHaveBeenCalled();
  });

  it("does not dispatch when receipt-bound settlement authorization or connection selection fails", async () => {
    mocks.postAck.mockResolvedValueOnce({ status: "blocked", reason: "authority" });
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "authorize_settlement", outcome: { status: "blocked", reason: "authority" },
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();

    vi.clearAllMocks();
    mocks.postAck.mockResolvedValue(prepared());
    mocks.withEnabled.mockResolvedValue({ status: "misconfigured" });
    expect(await finalizeProjectAlphaProjectAdoption(environment(), actor, action)).toEqual({
      stage: "settle", outcome: { status: "blocked", reason: "configuration" },
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
    expect(mocks.settle).not.toHaveBeenCalled();
  });

  it("sanitizes database failures to a bounded preflight outcome", async () => {
    expect(await finalizeProjectAlphaProjectAdoption(environment({ bindingError: true }), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "uncertain", reason: "database" },
    });
    expect(await finalizeProjectAlphaProjectAdoption(environment({ authorityError: true }), actor, action)).toEqual({
      stage: "preflight", outcome: { status: "uncertain", reason: "database" },
    });
  });
});
