import type { Env } from "./types";
import { publicShareOrigin } from "./origins";
import { projectAccessAuthorityMutationsEnabled } from "./project-access-mutation-gate";

export type PortalWorkflowReadinessReason =
  | "client_runtime_unverified"
  | "operations_feature_disabled"
  | "operations_configuration_unavailable"
  | "schema_unavailable"
  | "notification_transport_unavailable"
  | "readiness_check_unavailable";

export type PortalWorkflowReadinessState = "ready" | "blocked" | "unverified";

export interface PortalWorkflowReadinessItem {
  state: PortalWorkflowReadinessState;
  reasons: PortalWorkflowReadinessReason[];
  checks: { clientRuntime: "unverified" | null; operationsFeature: boolean | null;
    operationsConfiguration: boolean | null; schema: boolean; transport: boolean | null };
}

export interface PortalWorkflowReadiness {
  ready: boolean;
  workflows: {
    nativeFeedback: PortalWorkflowReadinessItem;
    serviceRequests: PortalWorkflowReadinessItem;
    requestAttachments: PortalWorkflowReadinessItem;
    delegatedSharing: PortalWorkflowReadinessItem;
    expiryNotices: PortalWorkflowReadinessItem;
  };
}

const DELIVERY_TABLES = {
  nativeFeedback: ["portal_native_feedback", "portal_native_feedback_events", "portal_native_feedback_mutations", "portal_native_feedback_notifications"],
  serviceRequests: ["client_service_request_drafts", "client_service_requests", "portal_native_request_storage_bindings"],
  requestAttachments: ["client_service_request_attachments", "client_service_request_attachment_parts", "portal_native_request_attachment_part_tickets"],
  delegatedSharing: [
    "client_share_folder_targets", "client_share_delegations", "client_delegated_shares", "client_delegated_share_events",
    "client_delegated_share_staff_mutations", "portal_v2_identities", "portal_v2_workspaces", "portal_v2_workspace_memberships",
    "portal_v2_entitlements", "portal_v2_folder_bindings", "portal_v2_directory_checkpoints", "portal_v2_directory_generations",
    "portal_v2_directory_entities",
  ],
  // Union of the exact authority-history, direct-recipient and companion-recipient
  // dependencies compiled by processProjectAccessExpiryNotifications.
  expiryNotices: [
    "portal_project_access_authority_history_state", "portal_project_access_authority_events",
    "portal_project_access_notice_outbox", "portal_project_access_notice_audit",
    "portal_project_access_companion_notice_outbox", "portal_project_access_companion_notice_audit",
    "portal_project_access_companion_recipient_claims", "portal_project_access_companion_recipient_reservations",
    "portal_project_access_terms", "portal_project_access_deadlines", "portal_v2_entitlements",
    "portal_v2_authenticated_delivery_grants", "portal_v2_authenticated_delivery_grant_recipients",
    "portal_v2_identity_denials", "portal_v2_invitations", "portal_v2_invitation_entitlements", "portal_v2_folder_bindings",
    "portal_v2_workspaces", "pa_portal_workspace_sources", "portal_v2_directory_checkpoints",
    "portal_v2_directory_generations", "portal_v2_directory_entities", "pa_portal_principals",
    "portal_v2_identities", "portal_v2_workspace_memberships",
  ],
} as const;
const OPERATIONS_TABLES = { expiryNotices: ["staff_users"] } as const;

function database(env: Env): D1Database {
  const value = env.DELIVERY_DB as D1Database & { withSession?: (consistency: "first-primary") => D1Database };
  return value.withSession?.("first-primary") ?? value;
}

function item(clientRuntime: "unverified" | null, operationsFeature: boolean | null, operationsConfiguration: boolean | null,
  schema: boolean, transport: boolean | null, extra: PortalWorkflowReadinessReason[] = []): PortalWorkflowReadinessItem {
  const reasons = [...extra];
  if (clientRuntime === "unverified") reasons.push("client_runtime_unverified");
  if (operationsFeature === false) reasons.push("operations_feature_disabled");
  if (operationsConfiguration === false) reasons.push("operations_configuration_unavailable");
  if (!schema) reasons.push("schema_unavailable");
  if (transport === false) reasons.push("notification_transport_unavailable");
  const state = reasons.length === 1 && reasons[0] === "client_runtime_unverified" ? "unverified" : reasons.length ? "blocked" : "ready";
  return { state, reasons: [...new Set(reasons)], checks: { clientRuntime, operationsFeature, operationsConfiguration, schema, transport } };
}

function delegatedSignerConfigurationReady(env: Env): boolean {
  if (!env.DELIVERY_TOKEN_SECRET || env.DELIVERY_TOKEN_SECRET.length < 32
    || !env.DELIVERY_ACCESS_CODE_PEPPER || env.DELIVERY_ACCESS_CODE_PEPPER.length < 32) return false;
  try {
    publicShareOrigin(env);
    return true;
  } catch {
    return false;
  }
}

/**
 * Identifier-free, read-only deployment preflight for the portal workflows
 * that cross the Client and Operations Workers. Client runtime flags are not
 * visible here and therefore remain explicitly unverified. No secret,
 * recipient, source identifier, or record count is returned to the browser.
 */
export async function portalWorkflowReadiness(env: Env): Promise<PortalWorkflowReadiness> {
  const flags = {
    delegatedSigner: env.CLIENT_DELEGATED_SHARE_SIGNER_ENABLED === "true",
    expiry: env.PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED === "true"
      && projectAccessAuthorityMutationsEnabled(env),
  };
  const delegatedSignerConfiguration = delegatedSignerConfigurationReady(env);
  const transport = env.SMTP_NOTIFICATIONS_ENABLED === "true"
    && Boolean(env.SMTP_HOST && env.SMTP_USERNAME && env.SMTP_PASSWORD && env.SMTP_FROM);
  try {
    const deliveryNames = [...new Set(Object.values(DELIVERY_TABLES).flat())];
    const operationsNames = [...new Set(Object.values(OPERATIONS_TABLES).flat())];
    const [deliveryRows, operationsRows] = await Promise.all([
      database(env).prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name IN (${deliveryNames.map(() => "?").join(",")})`).bind(...deliveryNames).all<{ name: string }>(),
      env.OPS_DB.withSession("first-primary").prepare(`SELECT name FROM sqlite_master
        WHERE type='table' AND name IN (${operationsNames.map(() => "?").join(",")})`).bind(...operationsNames).all<{ name: string }>(),
    ]);
    const deliveryPresent = new Set(deliveryRows.results.map(row => row.name));
    const operationsPresent = new Set(operationsRows.results.map(row => row.name));
    const schema = (key: keyof typeof DELIVERY_TABLES) => DELIVERY_TABLES[key].every(name => deliveryPresent.has(name));
    const expirySchema = schema("expiryNotices") && OPERATIONS_TABLES.expiryNotices.every(name => operationsPresent.has(name));
    const workflows = {
      nativeFeedback: item("unverified", null, null, schema("nativeFeedback"), null),
      serviceRequests: item("unverified", null, null, schema("serviceRequests"), null),
      requestAttachments: item("unverified", null, null, schema("requestAttachments"), null),
      delegatedSharing: item("unverified", flags.delegatedSigner, delegatedSignerConfiguration, schema("delegatedSharing"), null),
      expiryNotices: item(null, flags.expiry, null, expirySchema, transport),
    };
    return { ready: Object.values(workflows).every(value => value.state === "ready"), workflows };
  } catch {
    const unavailable = (): PortalWorkflowReadinessItem => ({ state: "blocked", reasons: ["readiness_check_unavailable"],
      checks: { clientRuntime: null, operationsFeature: null, operationsConfiguration: null, schema: false, transport: null } });
    return { ready: false, workflows: { nativeFeedback: unavailable(), serviceRequests: unavailable(),
      requestAttachments: unavailable(), delegatedSharing: unavailable(), expiryNotices: unavailable() } };
  }
}
