import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  validateDirectoryRelationshipRecoveryReservation,
} from "../src/worker/project-alpha-directory-relationship-generation-recovery";

const sourceId = "project-alpha:staging";
const sourceInstanceId = "00000000-0000-4000-8000-000000000001";
const applicationId = "00000000-0000-4000-8000-000000000002";
const historyEpoch = "00000000-0000-4000-8000-000000000003";
const commandId = "00000000-0000-4000-8000-000000000004";
const clientId = "client-1";
const organizationId = "organization-1";

const connections = JSON.stringify({ version: 1, instances: { [sourceId]: {
  sourceId, enabled: true, baseUrl: "https://pa.example.test", apiKey: "secret",
  sourceInstanceId, applicationId, historyEpoch,
} } });

const permissions = ["directory.profile.view", "directory.profile.edit", "directory.identity.link",
  "directory.enrollment.manage"] as const;
const selectedGrants = JSON.stringify([clientId, organizationId].flatMap(recordId => permissions.map(permission => ({
  recordId, permission, grantId: `${recordId}-${permission}`,
}))));

const reservation = (overrides: Record<string, unknown> = {}) => ({
  command_id: commandId, source_id: sourceId, source_instance_id: sourceInstanceId,
  application_id: applicationId, history_epoch_id: historyEpoch, destination_origin: "https://pa.example.test",
  client_record_id: clientId, intended_organization_record_id: organizationId,
  command_json: JSON.stringify({ commandId, expectedClientRevision: "4", expectedAuthorizationGeneration: "7",
    expectedCurrentOrganizationPublicId: null,
    organization: { externalId: "org/external", publicId: "a".repeat(32), expectedRevision: "3" } }),
  selected_grants_json: selectedGrants, actor_staff_id: "staff-1", actor_access_subject: "subject-1",
  actor_email: "admin@example.test", actor_admission_version: 2, actor_profile_version: 3,
  expires_at: "2999-01-01T00:00:00.000Z", observed_authorization_generation: "7", ...overrides,
});

type Controls = { reservation?: Record<string, unknown> | null; administrator?: boolean; grantFailures?: Set<number> };

function database(controls: Controls = {}) {
  const queries: string[] = [];
  let grant = 0;
  const db = {
    withSession: vi.fn(() => db),
    prepare: vi.fn((sql: string) => {
      queries.push(sql);
      return { bind: vi.fn(() => ({ first: vi.fn(async () => {
        if (sql.includes("FROM project_alpha_directory_relationship_recovery_outbox outbox"))
          return controls.reservation === null ? null : controls.reservation ?? reservation();
        if (sql.includes("FROM staff_users staff")) return controls.administrator === false ? null : { present: 1 };
        if (sql.includes("FROM native_directory_grants g")) {
          grant += 1;
          return controls.grantFailures?.has(grant) ? null : { present: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }) })) };
    }),
  };
  return { db: db as unknown as D1Database, queries, grantCount: () => grant };
}

const environment = (db: D1Database, overrides: Record<string, unknown> = {}) => ({
  OPS_DB: db, PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
  PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: "true", ...overrides,
});

describe("Directory relationship generation recovery pre-send validator", () => {
  it.each([undefined, "false", "TRUE"])('is default-off with zero database queries for flag %s', async flag => {
    const guarded = new Proxy({}, { get() { throw new Error("database must not be touched"); } });
    await expect(validateDirectoryRelationshipRecoveryReservation({ OPS_DB: guarded as D1Database,
      PROJECT_ALPHA_API_V2_CONNECTIONS: connections,
      PROJECT_ALPHA_DIRECTORY_RELATIONSHIP_GENERATION_RECOVERY_ENABLED: flag }, commandId)).resolves.toBe(false);
  });

  it("requires a current administrator and all eight exact selected grants", async () => {
    const success = database();
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(success.db), commandId)).resolves.toBe(true);
    expect(success.grantCount()).toBe(8);

    const noAdmin = database({ administrator: false });
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(noAdmin.db), commandId)).resolves.toBe(false);
    expect(noAdmin.grantCount()).toBe(0);

    const revoked = database({ grantFailures: new Set([8]) });
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(revoked.db), commandId)).resolves.toBe(false);
    expect(revoked.grantCount()).toBe(8);
  });

  it("fails closed for expiry, configuration drift, and deny-aware selected-grant failure", async () => {
    const expired = database({ reservation: reservation({ expires_at: "2000-01-01T00:00:00.000Z" }) });
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(expired.db), commandId)).resolves.toBe(false);

    const drift = database();
    const changed = connections.replace("https://pa.example.test", "https://other.example.test");
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(drift.db,
      { PROJECT_ALPHA_API_V2_CONNECTIONS: changed }), commandId)).resolves.toBe(false);

    // selectedGrantLive embeds active deny precedence; a denied selection has
    // no result even if its exact allow row remains active.
    const denied = database({ grantFailures: new Set([1]) });
    await expect(validateDirectoryRelationshipRecoveryReservation(environment(denied.db), commandId)).resolves.toBe(false);
  });

  it("pins live mapping, enrollment, source identity, records, relationship, and generation through the guarded live view", async () => {
    const observed = database();
    await validateDirectoryRelationshipRecoveryReservation(environment(observed.db), commandId);
    const sql = observed.queries[0] ?? "";
    expect(sql).toContain("project_alpha_directory_live_relationship_generation_recoveries");
    expect(sql).toContain("project_alpha_active_directory_mappings");
    expect(sql).toContain("operations_directory_records client");
    expect(sql).toContain("operations_directory_records organization");
    expect(sql).toContain("project_alpha_api_v2_inventory_receipts");
    expect(sql).toContain("operations_directory_client_organizations relation");
    const migration = readFileSync(new URL("../migrations/0184_project_alpha_directory_relationship_generation_recovery.sql",
      import.meta.url), "utf8");
    const liveView = migration.slice(migration.indexOf("CREATE VIEW project_alpha_directory_live_relationship_generation_recoveries"),
      migration.indexOf("CREATE VIEW project_alpha_directory_effective_relationship_commands"));
    expect(liveView).toContain("native_directory_enrollments enrollment,json_each(enrollment.destinations_json) destination");
    expect(liveView).toContain("json_extract(destination.value,'$.sourceId')=review.source_id");
    expect(liveView).toContain("json_extract(destination.value,'$.externalCanonicalId')=CASE");
  });
});
