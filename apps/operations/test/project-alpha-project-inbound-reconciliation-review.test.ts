import { describe, expect, it } from "vitest";
import {
  readProjectAlphaInboundProjectProposal,
  type InboundProjectGrant,
} from "../src/worker/project-alpha-project-inbound-reconciliation";

const proposalId = "10000000-0000-4000-8000-000000000001";
const sourceInstanceId = "10000000-0000-4000-8000-000000000002";
const applicationId = "10000000-0000-4000-8000-000000000003";
const historyEpochId = "10000000-0000-4000-8000-000000000004";
const requestId = "10000000-0000-4000-8000-000000000005";
const externalProjectId = "ops-project-1";
const projectAlphaPublicId = "a".repeat(32);
const localProjection = "b".repeat(64);
const remoteProjection = "c".repeat(64);
const actor = { staffId: "staff-admin", accessSubject: "access-subject" } as const;

function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => Array.isArray(item) ? item.map(normalize)
    : item && typeof item === "object" ? Object.fromEntries(Object.keys(item as Record<string, unknown>).sort()
      .map(key => [key, normalize((item as Record<string, unknown>)[key])])) : item;
  return JSON.stringify(normalize(value));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function localSnapshot(name = "Operations name") {
  return {
    external_project_id: externalProjectId,
    source_id: "project-alpha:primary",
    source_instance_id: sourceInstanceId,
    application_id: applicationId,
    history_epoch_id: historyEpochId,
    project_alpha_public_id: projectAlphaPublicId,
    pa_revision: "1",
    current_version: 1,
    canonical_projection_sha256: localProjection,
    name,
    description: null,
    lifecycle: "active",
    archived: 0,
    overdue_warning: 0,
    completed_at: null,
    archived_at: null,
    planned_start: "2026-10-01",
    planned_end: "2026-10-31",
    organization_record_id: null,
    client_record_id: null,
    scopes_json: "[]",
  };
}

function remoteSnapshot(extraData: Record<string, unknown> = {}) {
  return {
    apiVersion: "2",
    sourceInstanceId,
    applicationId,
    historyEpoch: historyEpochId,
    requestId,
    replayed: false,
    accepted: true,
    resource: { type: "project", id: projectAlphaPublicId, revision: "2", projectionSha256: remoteProjection },
    data: {
      name: "Project Alpha name",
      description: "Reviewed description",
      status: "active",
      archived: false,
      overdueWarning: false,
      completedAt: null,
      archivedAt: null,
      estimatedStart: "2026-10-01",
      estimatedEnd: "2026-11-15",
      clientPublicId: null,
      organizationPublicId: null,
      ...extraData,
    },
  };
}

async function fixture(options: {
  remoteExtra?: Record<string, unknown>;
  grants?: readonly InboundProjectGrant[];
  headName?: string;
  reviewerStaffId?: string;
} = {}) {
  const localJson = canonical(localSnapshot());
  const remoteJson = JSON.stringify(remoteSnapshot(options.remoteExtra));
  const proposal = {
    proposal_id: proposalId,
    source_id: "project-alpha:primary",
    source_instance_id: sourceInstanceId,
    application_id: applicationId,
    history_epoch_id: historyEpochId,
    external_project_id: externalProjectId,
    project_alpha_public_id: projectAlphaPublicId,
    expected_local_version: 1,
    expected_local_projection_sha256: localProjection,
    observed_remote_revision: "2",
    observed_remote_projection_sha256: remoteProjection,
    local_snapshot_json: localJson,
    remote_snapshot_json: remoteJson,
    remote_snapshot_sha256: await sha256(remoteJson),
    target_organization_record_id: null,
    target_client_record_id: null,
    reviewer_staff_id: options.reviewerStaffId ?? actor.staffId,
    reviewer_access_subject: actor.accessSubject,
    reviewer_admission_version: 3,
    reviewer_profile_version: 4,
    project_grant_generation: 5,
    normalized_scopes_json: "[]",
    expires_at: "2999-01-01T00:00:00.000Z",
  };
  const grants = options.grants ?? [{ effect: "allow", scope_kind: "global",
    business_area_id: null, division_id: null, external_project_id: null }];
  const database = {
    prepare(sql: string) {
      return { bind: (..._values: unknown[]) => ({
        first: async (column?: string) => {
          if (sql.includes("FROM project_alpha_project_inbound_proposals")) return proposal;
          if (sql.includes("FROM native_staff_admissions admission"))
            return { admission_version: 3, profile_version: 4, generation: 5 };
          if (sql.includes("FROM project_alpha_project_mappings")) return column === "count" ? 1 : { count: 1 };
          if (sql.includes("FROM operations_shared_projects")) return localSnapshot(options.headName);
          return null;
        },
        all: async () => sql.includes("FROM native_project_grants") ? { results: grants } : { results: [] },
      }) };
    },
  } as unknown as D1Database;
  return { OPS_DB: database };
}

describe("PA-origin project proposal review", () => {
  it("returns only a validated, fixed-shape diff to the current authorized reviewer", async () => {
    const outcome = await readProjectAlphaInboundProjectProposal(await fixture(), actor, proposalId);
    expect(outcome).toEqual({ status: "available", proposal: {
      proposalId,
      sourceId: "project-alpha:primary",
      externalProjectId,
      projectAlphaPublicId,
      expectedLocalVersion: 1,
      expiresAt: "2999-01-01T00:00:00.000Z",
      operations: expect.objectContaining({ revision: "1", name: "Operations name", estimatedEnd: "2026-10-31" }),
      projectAlpha: expect.objectContaining({ revision: "2", name: "Project Alpha name", estimatedEnd: "2026-11-15" }),
      changedFields: ["name", "description", "estimatedEnd"],
    } });
    const serialized = JSON.stringify(outcome);
    expect(serialized).not.toContain(requestId);
    expect(serialized).not.toContain(actor.accessSubject);
    expect(serialized).not.toContain("remote_snapshot");
    expect(serialized).not.toContain("authorization");
  });

  it("fails closed for another reviewer, denied authority, stale local state, or extra snapshot fields", async () => {
    await expect(readProjectAlphaInboundProjectProposal(await fixture({ reviewerStaffId: "staff-other" }), actor, proposalId))
      .resolves.toEqual({ status: "unavailable", reason: "authority" });
    await expect(readProjectAlphaInboundProjectProposal(await fixture({ grants: [{ effect: "deny", scope_kind: "global",
      business_area_id: null, division_id: null, external_project_id: null }] }), actor, proposalId))
      .resolves.toEqual({ status: "unavailable", reason: "authority" });
    await expect(readProjectAlphaInboundProjectProposal(await fixture({ headName: "Changed locally" }), actor, proposalId))
      .resolves.toEqual({ status: "unavailable", reason: "stale_evidence" });
    await expect(readProjectAlphaInboundProjectProposal(await fixture({ remoteExtra: { apiToken: "must-not-escape" } }), actor, proposalId))
      .resolves.toEqual({ status: "unavailable", reason: "invalid_evidence" });
  });
});
