export type Env = Cloudflare.Env & {
  CF_ACCESS_GROUP_API_TOKEN: string;
  PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: string;
};

export const SUPPORTED_ROLES = [
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
  };
}
