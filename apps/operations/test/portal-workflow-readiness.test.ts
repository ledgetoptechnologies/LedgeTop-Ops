import { describe, expect, it } from "vitest";
import { portalWorkflowReadiness } from "../src/worker/portal-workflow-readiness";

const tables = [
  "portal_native_feedback", "portal_native_feedback_events", "portal_native_feedback_mutations", "portal_native_feedback_notifications",
  "client_service_request_drafts", "client_service_requests", "client_service_request_attachments", "client_service_request_attachment_parts",
  "portal_native_request_storage_bindings", "portal_native_request_attachment_part_tickets", "client_share_folder_targets",
  "client_share_delegations", "client_delegated_shares", "client_delegated_share_events", "client_delegated_share_staff_mutations",
  "portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships", "portal_v2_entitlements", "portal_v2_folder_bindings",
  "portal_v2_directory_checkpoints", "portal_v2_directory_generations", "portal_v2_directory_entities",
  "portal_project_access_authority_history_state", "portal_project_access_authority_events",
  "portal_project_access_terms", "portal_project_access_deadlines", "portal_project_access_notice_outbox", "portal_project_access_notice_audit",
  "portal_project_access_companion_notice_outbox", "portal_project_access_companion_notice_audit",
  "portal_project_access_companion_recipient_claims", "portal_project_access_companion_recipient_reservations",
  "portal_v2_authenticated_delivery_grants", "portal_v2_authenticated_delivery_grant_recipients", "portal_v2_identity_denials",
  "portal_v2_invitations", "portal_v2_invitation_entitlements", "pa_portal_workspace_sources", "pa_portal_principals",
];

function database(present: string[]) {
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: present.map(name => ({ name })) }) }) }) };
  return { ...db, withSession: () => db };
}

function env(present = tables, overrides: Record<string, unknown> = {}, operationsPresent = ["staff_users"]) {
  return { DELIVERY_DB: database(present), OPS_DB: database(operationsPresent), CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "true",
    DELIVERY_TOKEN_SECRET: "t".repeat(32), DELIVERY_ACCESS_CODE_PEPPER: "p".repeat(32), PUBLIC_SHARE_ORIGIN: "https://portal.example.test",
    PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED: "true", PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: "true",
    SMTP_NOTIFICATIONS_ENABLED: "true", SMTP_HOST: "smtp.example.test", SMTP_USERNAME: "user",
    SMTP_PASSWORD: "secret", SMTP_FROM: "no-reply@example.test", ...overrides } as any;
}

describe("portal workflow readiness", () => {
  it("never guesses Client runtime state while reporting authoritative companion readiness", async () => {
    const result = await portalWorkflowReadiness(env());
    expect(result.ready).toBe(false);
    expect(result.workflows.nativeFeedback.state).toBe("unverified");
    expect(result.workflows.serviceRequests.state).toBe("unverified");
    expect(result.workflows.requestAttachments.state).toBe("unverified");
    expect(result.workflows.delegatedSharing.state).toBe("unverified");
    expect(result.workflows.expiryNotices.state).toBe("ready");
    expect(result.workflows.nativeFeedback.reasons).toEqual(["client_runtime_unverified"]);
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("fails closed with typed reasons for disabled flags, missing schema, and unavailable transport", async () => {
    const result = await portalWorkflowReadiness(env(tables.filter(name => name !== "portal_native_feedback_notifications"), {
      CLIENT_DELEGATED_SHARE_SIGNER_ENABLED: "false", PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED: "false",
      SMTP_PASSWORD: "",
    }));
    expect(result.ready).toBe(false);
    expect(result.workflows.nativeFeedback.reasons).toEqual(expect.arrayContaining(["client_runtime_unverified", "schema_unavailable"]));
    expect(result.workflows.serviceRequests.reasons).toContain("client_runtime_unverified");
    expect(result.workflows.delegatedSharing.reasons).toContain("operations_feature_disabled");
    expect(result.workflows.expiryNotices.reasons).toEqual(expect.arrayContaining(["operations_feature_disabled", "notification_transport_unavailable"]));
  });

  it("blocks expiry when its mutation gate or either database schema is incomplete", async () => {
    const disabled = await portalWorkflowReadiness(env(tables, { PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED: "false" }));
    expect(disabled.workflows.expiryNotices.reasons).toContain("operations_feature_disabled");
    const missingDelivery = await portalWorkflowReadiness(env(tables.filter(name => name !== "portal_project_access_authority_events")));
    expect(missingDelivery.workflows.expiryNotices.reasons).toContain("schema_unavailable");
    const missingOperations = await portalWorkflowReadiness(env(tables, {}, []));
    expect(missingOperations.workflows.expiryNotices.reasons).toContain("schema_unavailable");
  });

  it.each([
    ["token secret", { DELIVERY_TOKEN_SECRET: "short" }],
    ["access-code pepper", { DELIVERY_ACCESS_CODE_PEPPER: "short" }],
    ["public origin", { PUBLIC_SHARE_ORIGIN: "not-an-origin" }],
  ])("blocks delegated signing for an invalid %s without exposing configuration", async (_label, overrides) => {
    const result = await portalWorkflowReadiness(env(tables, overrides));
    expect(result.workflows.delegatedSharing.state).toBe("blocked");
    expect(result.workflows.delegatedSharing.reasons).toContain("operations_configuration_unavailable");
    expect(JSON.stringify(result)).not.toMatch(/short|not-an-origin|portal\.example/);
  });

  it("returns one redacted unavailable reason per workflow when D1 cannot be checked", async () => {
    const broken = env();
    broken.DELIVERY_DB = { withSession: () => ({ prepare: () => { throw new Error("sensitive database detail"); } }) } as any;
    const result = await portalWorkflowReadiness(broken);
    expect(result.ready).toBe(false);
    expect(Object.values(result.workflows).every(value => value.reasons.join() === "readiness_check_unavailable")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sensitive");
  });
});
