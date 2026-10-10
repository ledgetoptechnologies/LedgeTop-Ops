import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareProjectAlphaProjectV2Recovery,
  type ProjectAlphaProjectV2RecoveryActor,
  type ProjectAlphaProjectV2RecoveryRequest,
} from "../src/worker/project-alpha-project-v2-recovery";

const authorizationId = "10000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000002";
const applicationId = "10000000-0000-4000-8000-000000000003";
const sourceInstanceId = "10000000-0000-4000-8000-000000000004";
const historyEpochId = "10000000-0000-4000-8000-000000000005";
const sha = "a".repeat(64);

const actor: ProjectAlphaProjectV2RecoveryActor = {
  staffId: "staff-original", accessSubject: "subject-original", email: "staff@example.test",
  admissionVersion: 3, profileVersion: 4, verifiedUntil: "2999-01-01T00:00:00.000Z",
};
const manager: ProjectAlphaProjectV2RecoveryActor = {
  staffId: "staff-manager", accessSubject: "subject-manager", email: "manager@example.test",
  admissionVersion: 5, profileVersion: 6, verifiedUntil: "2999-01-01T00:00:00.000Z",
};
const input: ProjectAlphaProjectV2RecoveryRequest = {
  authorizationId, commandId, sourceId: "project-alpha:staging", expectedApplicationId: applicationId,
  expectedEventVersion: 2, reason: "Operator reviewed the exact uncertain request",
};

const terminal = {
  command_id: commandId, operation: "create", external_project_id: "ops-project-1",
  source_id: input.sourceId, application_id: applicationId, destination_base_url: "https://pa.example.test",
  expected_source_instance_id: sourceInstanceId, expected_history_epoch_id: historyEpochId,
  state: "terminal", attempts: 1, lease_token: null, lease_expires_at: null, outcome_json: "{}",
  request_sha256: sha, expected_local_version: 0, expected_local_projection_sha256: null,
  expected_mapping_state: "absent", expected_project_alpha_public_id: null,
  original_actor_staff_id: actor.staffId, original_actor_access_subject: actor.accessSubject,
  original_actor_email: actor.email, original_actor_admission_version: actor.admissionVersion,
  original_actor_profile_version: actor.profileVersion, original_grant_generation: 7,
  original_scopes_json: "[]", latest_event_version: 2, latest_event_state: "uncertain",
  success_receipt_count: 0, settlement_count: 0,
} as const;

type State = { existing: Record<string, unknown> | null; snapshot: Record<string, unknown> | null;
  generation: number | null; batchError: boolean; statements: Array<{ sql: string; binds: unknown[] }> };

function fixture(change: Partial<State> = {}) {
  const state: State = { existing: null, snapshot: { ...terminal }, generation: 7, batchError: false,
    statements: [], ...change };
  const db = {
    prepare: vi.fn((sql: string) => ({ bind: vi.fn((...binds: unknown[]) => {
      const statement = { sql, binds }; state.statements.push(statement);
      return {
        first: vi.fn(async (column?: string) => {
          if (sql.includes("FROM project_alpha_project_v2_recovery_authorizations authorization")) return state.existing;
          if (sql.includes("FROM project_alpha_project_outbox outbox")) return state.snapshot;
          if (sql.includes("SELECT generation.generation")) {
            const [staffId, subject, admissionVersion, email, profileVersion] = binds;
            const known = (staffId === actor.staffId && subject === actor.accessSubject
                && admissionVersion === actor.admissionVersion && email === actor.email
                && profileVersion === actor.profileVersion)
              || (staffId === manager.staffId && subject === manager.accessSubject
                && admissionVersion === manager.admissionVersion && email === manager.email
                && profileVersion === manager.profileVersion);
            const generation = known ? state.generation : null;
            return column === "generation" ? generation : { generation };
          }
          return null;
        }),
      };
    }) })),
    batch: vi.fn(async () => { if (state.batchError) throw new Error("synthetic race"); return []; }),
  } as unknown as D1Database;
  const env = { OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
    [input.sourceId]: { sourceId: input.sourceId, enabled: true, baseUrl: "https://pa.example.test",
      apiKey: "private", sourceInstanceId, applicationId, historyEpoch: historyEpochId },
  } }) };
  return { state, db, env };
}

describe("Project-v2 uncertain recovery writer", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fails closed on unavailable, disabled, or changed source/application selection", async () => {
    const unavailable = fixture();
    unavailable.env.PROJECT_ALPHA_API_V2_CONNECTIONS = "{}";
    await expect(prepareProjectAlphaProjectV2Recovery(unavailable.env, input, actor))
      .resolves.toEqual({ status: "blocked", reason: "configuration" });
    const disabled = fixture();
    disabled.env.PROJECT_ALPHA_API_V2_CONNECTIONS = disabled.env.PROJECT_ALPHA_API_V2_CONNECTIONS.replace('"enabled":true', '"enabled":false');
    await expect(prepareProjectAlphaProjectV2Recovery(disabled.env, input, actor))
      .resolves.toEqual({ status: "blocked", reason: "configuration" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture().env,
      { ...input, expectedApplicationId: historyEpochId }, actor))
      .resolves.toEqual({ status: "blocked", reason: "configuration" });
  });

  it("replays only the same still-live authorization and conflicts on key reuse", async () => {
    const existing = { authorization_id: authorizationId, command_id: commandId,
      original_event_state_version: 2, eligibility_state: "terminal_uncertain", source_id: input.sourceId,
      application_id: applicationId, actor_staff_id: actor.staffId, actor_access_subject: actor.accessSubject,
      actor_email: actor.email, actor_admission_version: actor.admissionVersion,
      actor_profile_version: actor.profileVersion, reason: input.reason, live: 1 };
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ existing }).env, input, actor)).resolves.toEqual({
      status: "prepared", authorizationId, commandId, sourceId: input.sourceId,
      uncertainEventVersion: 2, replayed: true,
    });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ existing }).env,
      { ...input, commandId: historyEpochId }, actor)).resolves.toEqual({ status: "conflict", reason: "authorization_id" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ existing: { ...existing, live: 0 } }).env,
      input, actor)).resolves.toEqual({ status: "blocked", reason: "authority" });
  });

  it("fails cross-manager recovery before reopening dispatch and rejects forged identity, stale authority and command state", async () => {
    const managed = fixture();
    await expect(prepareProjectAlphaProjectV2Recovery(managed.env, input, manager)).resolves.toEqual({
      status: "blocked", reason: "authority",
    });
    const authorization = managed.state.statements.find(statement =>
      statement.sql.includes("INSERT INTO project_alpha_project_v2_recovery_authorizations"));
    expect(authorization).toBeUndefined();
    await expect(prepareProjectAlphaProjectV2Recovery(fixture().env, input,
      { ...manager, accessSubject: "forged-subject" })).resolves.toEqual({ status: "blocked", reason: "authority" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ generation: null }).env, input, actor))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture().env,
      { ...input, expectedEventVersion: 1 }, actor)).resolves.toEqual({ status: "blocked", reason: "stale" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ snapshot: { ...terminal, state: "leased",
      lease_token: "live", lease_expires_at: Math.floor(Date.now() / 1000) + 300 } }).env, input, actor))
      .resolves.toEqual({ status: "blocked", reason: "live_lease" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ snapshot: { ...terminal,
      success_receipt_count: 1 } }).env, input, actor)).resolves.toEqual({ status: "blocked", reason: "successful" });
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ snapshot: { ...terminal,
      settlement_count: 1 } }).env, input, actor)).resolves.toEqual({ status: "blocked", reason: "settled" });
  });

  it("atomically authorizes, appends pending, and reopens an exact terminal snapshot", async () => {
    const { env, db, state } = fixture();
    await expect(prepareProjectAlphaProjectV2Recovery(env, input, actor)).resolves.toEqual({
      status: "prepared", authorizationId, commandId, sourceId: input.sourceId,
      uncertainEventVersion: 2, replayed: false,
    });
    expect(db.batch).toHaveBeenCalledOnce();
    const batch = vi.mocked(db.batch).mock.calls[0]![0];
    expect(batch).toHaveLength(3);
    const writes = state.statements.slice(-3);
    expect(writes[0]!.sql).toContain("INSERT INTO project_alpha_project_v2_recovery_authorizations");
    expect(writes[0]!.binds).toContain(input.reason);
    expect(writes[0]!.binds).not.toContain("private");
    expect(writes[1]!.sql).toContain("'pending'");
    expect(writes[2]!.sql).toContain("UPDATE project_alpha_project_outbox SET state='pending'");
  });

  it("first snapshots uncertainty for an expired leased pending row in the same batch", async () => {
    const expired = { ...terminal, state: "leased", lease_token: "expired-lease",
      lease_expires_at: 0, outcome_json: null, latest_event_state: "pending" };
    const { env, db, state } = fixture({ snapshot: expired });
    await expect(prepareProjectAlphaProjectV2Recovery(env, input, actor)).resolves.toMatchObject({
      status: "prepared", uncertainEventVersion: 3,
    });
    expect(vi.mocked(db.batch).mock.calls[0]![0]).toHaveLength(4);
    const writes = state.statements.slice(-4);
    expect(writes[0]!.sql).toContain("'uncertain'");
    expect(writes[1]!.binds).toContain("expired_lease_lost_ack");
    expect(writes[2]!.sql).toContain("'pending'");
    expect(writes[3]!.sql).toContain("UPDATE project_alpha_project_outbox");
  });

  it("returns an unknown database outcome instead of claiming recovery after an atomic write failure", async () => {
    await expect(prepareProjectAlphaProjectV2Recovery(fixture({ batchError: true }).env, input, actor))
      .resolves.toEqual({ status: "uncertain", reason: "database" });
  });
});
