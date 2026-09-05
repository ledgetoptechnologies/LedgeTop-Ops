// Replace Wrangler's generic Service shape with the entrypoint's typed RPC
// contract. Keep it optional so a staged deployment fails retryably instead of
// making local fixtures invent unrelated fetch/connect methods.
export type Env = Omit<Cloudflare.Env, "CLIENT_PORTAL_PROJECTION_INGRESS"|"OPERATIONS_DELIVERY_INTENT_INGRESS"> & {
  CF_ACCESS_GROUP_API_TOKEN: string;
  CF_ACCESS_GROUP_NAME?: string;
  PROJECT_ALPHA_WEBHOOK_HMAC_SECRET: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PUBLIC_KEY?: string;
  PROJECT_ALPHA_WEBHOOK_ED25519_PREVIOUS_PUBLIC_KEY?: string;
  PROJECT_ALPHA_ALLOW_LEGACY_HMAC?: string;
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
  CLIENT_PORTAL_PROJECTION_INGRESS?: PortalProjectionIngressBinding;
  OPERATIONS_DELIVERY_INTENT_INGRESS?: DeliveryIntentIngressBinding;
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
export interface ProjectionEvent {
  event_id: string;
  event_type: "projection.changed";
  occurred_at: string;
  schema_version: 1;
  application_key: string;
  projection: {
    entity_type: ProjectionEntityType;
    entity_id: string;
    action: "upsert" | "revoke";
    source_updated_at: string;
    data: Record<string, unknown>;
  };
}

export interface PortalProjectionEvent {
  event_id: string;
  event_type: "portal.projection";
  occurred_at: string;
  schema_version: 1;
  application_key: string;
  projection_kind: "portal" | "catalog" | "service_assignments";
  projection: unknown;
}

export type DeliveryIntentKind="preflight"|"provision"|"revoke";
export interface DeliveryIntentEvent {
  event_id:string;
  event_type:"delivery.intent";
  occurred_at:string;
  schema_version:1;
  application_key:string;
  intent_kind:DeliveryIntentKind;
  intent:Record<string,unknown>;
}

export interface DeliveryIntentIngressBinding {
  ingestProjectAlphaDeliveryIntent(input:{
    protocolVersion:1;sourceId:string;applicationKey:string;deliveryId:string;
    intentKind:DeliveryIntentKind;body:string;connectorProof:{revision:number;version:number};
  }):Promise<
    |{ok:true;protocolVersion:1;result:Record<string,unknown>}
    |{ok:false;protocolVersion:1;code:string;retryable:boolean}
  >;
}

export interface PortalProjectionIngressBinding {
  ingestProjectAlphaPortalProjection(input: {
    protocolVersion: 1;
    sourceId: string;
    applicationKey: string;
    deliveryId: string;
    projectionKind: "portal" | "catalog" | "service_assignments";
    body: string;
  }): Promise<
    | { ok: true; protocolVersion: 1; status: "completed" | "ignored" | "duplicate" }
    | { ok: false; protocolVersion: 1; code: string; retryable: boolean }
  >;
}

export type IntegrationEvent = EntitlementEvent | ProjectionEvent | PortalProjectionEvent | DeliveryIntentEvent;
