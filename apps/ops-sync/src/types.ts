export type Env = Cloudflare.Env & {
  CF_ACCESS_GROUP_API_TOKEN: string;
  CF_ACCESS_GROUP_NAME?: string;
  PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY?: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY?: string;
  PROJECT_ALPHA_ALLOW_LEGACY_HMAC?: string;
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
};

export const SUPPORTED_ROLES = [
  "role-admin",
  "role-operator",
  "role-delivery-coordinator",
  "role-division-manager",
] as const;

export type SupportedRole = (typeof SUPPORTED_ROLES)[number];

export interface EntitlementEvent {
  event_id: string;
  event_type: "application_entitlement.changed" | "application_entitlement.revoked" | "user.changed";
  occurred_at: string;
  schema_version: 1;
  user: {
    id: string;
    email: string;
    display_name: string;
    active: boolean;
  };
  entitlement: {
    application_key: string;
    enabled: boolean;
    role_key: SupportedRole;
    business_unit_ids: string[];
    oversight_business_unit_ids?: string[];
    manual_access?: boolean;
    automatic_access?: boolean;
    unit_oversight?: boolean;
  };
}

export type ProjectionEntityType = "client" | "organization" | "project" | "project_assignment" | "business_unit" | "operation" | "operation_assignment" | "task" | "task_assignment";
interface ProjectionEventEnvelope {
  event_id: string;
  event_type: "projection.changed";
  occurred_at: string;
  application_key: string;
}
export type ProjectionEvent = ProjectionEventEnvelope & ({
  schema_version: 1;
  projection: {
    entity_type: ProjectionEntityType;
    entity_id: string;
    action: "upsert" | "revoke";
    source_updated_at: string;
    data: Record<string, unknown>;
  };
} | {
  schema_version: 2;
  projection: {
    entity_type: ProjectionEntityType;
    entity_id: string;
    action: "tombstone";
    source_updated_at: string;
    // Runtime schema is a strict empty object; keep the transport type broad
    // enough for negative fixtures to prove that validation rejects PII.
    data: Record<string, unknown>;
  };
});

export type IntegrationEvent = EntitlementEvent | ProjectionEvent;
