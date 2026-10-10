import { describe, expect, it, vi } from "vitest";
import { prepareProjectAlphaProjectV2PostAckResume } from "../src/worker/project-alpha-project-v2-post-ack-resume";

const authorizationId = "10000000-0000-4000-8000-000000000001";
const commandId = "10000000-0000-4000-8000-000000000002";
const applicationId = "10000000-0000-4000-8000-000000000003";
const sourceInstanceId = "10000000-0000-4000-8000-000000000004";
const historyEpochId = "10000000-0000-4000-8000-000000000005";
const actor = {
  staffId: "staff-owner", accessSubject: "subject-owner", email: "owner@example.test",
  admissionVersion: 3, profileVersion: 4, verifiedUntil: "2999-01-01T00:00:00.000Z",
};
const request = {
  authorizationId, commandId, sourceId: "project-alpha:staging", expectedApplicationId: applicationId,
  reason: "Resume exact completed request",
};

function completedAuthorization(overrides: Record<string, unknown> = {}) {
  return {
    authorization_id: authorizationId, command_id: commandId, source_id: request.sourceId,
    application_id: applicationId, reason: request.reason, success_receipt_id: "receipt-1",
    settlement_id: "settlement-1", actor_staff_id: actor.staffId,
    actor_access_subject: actor.accessSubject, actor_email: actor.email,
    actor_admission_version: actor.admissionVersion, actor_profile_version: actor.profileVersion,
    actor_project_grant_generation: 7, actor_scopes_json: "[]", external_project_id: "ops/project-1",
    // The live view excludes a consumed or expired authorization. Exact completed
    // replay must use the immutable receipt chain, not require it to remain live.
    live: 0, recovery_match: 0, recovery_event_state_version: null,
    recovery_eligibility_state: null, chain_complete: 1, activation_id: "activation-1",
    activation_settlement_id: "settlement-1", activation_command_id: commandId,
    activation_external_project_id: "ops/project-1", activation_version: 1,
    ...overrides,
  };
}

function fixture(existing: Record<string, unknown> | null) {
  const statements: string[] = [];
  const write = vi.fn(async () => ({ success: true }));
  const db = {
    prepare: vi.fn((sql: string) => {
      statements.push(sql);
      return {
        bind: vi.fn(() => ({
          first: vi.fn(async () => {
            if (sql.includes("FROM project_alpha_project_v2_post_ack_authorizations authorization")) return existing;
            if (sql.includes("SELECT 1 current_authority")) return 1;
            return null;
          }),
          run: write,
        })),
      };
    }),
  } as unknown as D1Database;
  const env = {
    OPS_DB: db,
    PROJECT_ALPHA_API_V2_CONNECTIONS: JSON.stringify({ version: 1, instances: {
      [request.sourceId]: { sourceId: request.sourceId, enabled: true,
        baseUrl: "https://pa.example.test", apiKey: "test-only",
        sourceInstanceId, applicationId, historyEpoch: historyEpochId },
    } }),
  };
  return { db, env, statements, write };
}

describe("Project-v2 post-ack resume replay", () => {
  it("replays an inactive authorization only from the exact completed chain and current actor authority", async () => {
    const { db, env, statements, write } = fixture(completedAuthorization());
    await expect(prepareProjectAlphaProjectV2PostAckResume(env, request, actor)).resolves.toEqual({
      status: "activated", activationId: "activation-1", settlementId: "settlement-1",
      commandId, externalProjectId: "ops/project-1", version: 1, replayed: true,
    });
    expect(statements.some(sql => sql.includes("INSERT INTO project_alpha_project_v2_post_ack_authorizations"))).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(db.prepare).toHaveBeenCalledTimes(2);
  });

  it("does not replay an incomplete chain or a different request as a completed result", async () => {
    const incomplete = fixture(completedAuthorization({ chain_complete: 0 }));
    await expect(prepareProjectAlphaProjectV2PostAckResume(incomplete.env, request, actor))
      .resolves.toEqual({ status: "blocked", reason: "stale" });
    expect(incomplete.db.prepare).toHaveBeenCalledTimes(1);

    const changed = fixture(completedAuthorization());
    await expect(prepareProjectAlphaProjectV2PostAckResume(changed.env,
      { ...request, reason: "Different request" }, actor))
      .resolves.toEqual({ status: "conflict", reason: "authorization_id" });
    expect(changed.db.prepare).toHaveBeenCalledTimes(1);
  });

  it("does not bypass current actor-session expiry for a completed replay", async () => {
    const { db, env } = fixture(completedAuthorization());
    await expect(prepareProjectAlphaProjectV2PostAckResume(env, request,
      { ...actor, verifiedUntil: "2000-01-01T00:00:00.000Z" }))
      .resolves.toEqual({ status: "blocked", reason: "authority" });
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
