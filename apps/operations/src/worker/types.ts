import type { Permission, PermissionScope } from "@ltds/shared";
import type { ThumbnailRendererContainer } from "./thumbnail-renderer-container";

export type Env = Omit<
  Cloudflare.Env,
  | "DIRECT_DELIVERY_UPLOADS_ENABLED"
  | "R2_PURGE_ENABLED"
  | "THUMBNAIL_RENDERER"
  | "LEGACY_CLIENT_REQUEST_PA_QUOTE_LINK_ENABLED"
  | "PROJECT_ALPHA_DRAFT_QUOTES_ENABLED"
  | "PROJECT_ALPHA_API_V2_MONITOR_ENABLED"
  | "PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT"
  | "PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED"
  | "PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED"
  | "PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED"
  | "PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED"
  | "PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ACCEPTANCE_ENABLED"
  | "PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID"
  | "PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN"
  | "NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED"
  | "NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID"
  | "NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED"
  | "NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED"
  | "NATIVE_INTEGRATION_CONTROL_ENABLED"
  | "NATIVE_INTEGRATION_CONTROL_ORIGIN"
  | "CLIENT_ONBOARDING_ADMIN_ENABLED"
  | "CLIENT_ONBOARDING_ADMIN_ORIGIN"
  | "CLIENT_ONBOARDING_HANDOFF_KEYRING"
  | "DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED"
  | "CLIENT_DELEGATED_SHARE_SIGNER_ENABLED"
  | "CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED"
  | "CLIENT_PORTAL_HIERARCHY_V2_ENABLED"
  | "CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED"
  | "CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED"
  | "PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED"
  | "AUTHENTICATED_DELIVERY_CREATION_ENABLED"
  | "PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED"
  | "AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED"
  | "CLIENT_PORTAL_ORIGINS"
  | "OPERATIONS_ORIGINS"
  | "CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED"
  | "CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE"
  | "PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED"
  | "PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED"
  | "OPS_INVENTORY_CATALOG_STAGING"
  | "OPS_INVENTORY_CATALOG_PROMOTION"
> & {
  PROJECT_ALPHA_API_KEY?: string;
  /** Temporary release barrier for the preserving client-notification table rebuild. */
  CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE?: string;
  /** Deploy-managed connector credential sets; never returned by registry APIs. */
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
  /** Versioned, deployment-owned API-v2 connections. Never accepted from a browser or connector registry request. */
  PROJECT_ALPHA_API_V2_CONNECTIONS?: string;
  /** Default-off, route-less PA catalog snapshot to Client staging coordinator. */
  PROJECT_ALPHA_CATALOG_STAGING_COORDINATOR_ENABLED?: string;
  /** Default-off, route-less promotion after an exact staged snapshot. */
  PROJECT_ALPHA_CATALOG_PROMOTION_COORDINATOR_ENABLED?: string;
  /** Private Client Worker RPC; receives catalog content only, never PA credentials. */
  OPS_INVENTORY_CATALOG_STAGING?: import("./project-alpha-catalog-staging-coordinator").OpsCatalogStagingBinding;
  /** Private Client Worker RPC; accepts only explicit registry/source/checkpoint authority. */
  OPS_INVENTORY_CATALOG_PROMOTION?: import("./project-alpha-catalog-staging-coordinator").OpsCatalogPromotionBinding;
  /** Default-off bounded API-v2 health/incident monitor. */
  PROJECT_ALPHA_API_V2_MONITOR_ENABLED?: string;
  /** Explicit deployment-owned owner mailbox for outage alerts; never inferred from Project Alpha data. */
  PROJECT_ALPHA_API_V2_MONITOR_RECIPIENT?: string;
  /** Default-off bounded read-only PA Directory reconciliation scheduler. */
  PROJECT_ALPHA_DIRECTORY_RECONCILIATION_ENABLED?: string;
  /** Default-off administrator-only API-v2 capabilities and inventory readiness check. */
  PROJECT_ALPHA_API_V2_READ_ACCEPTANCE_ENABLED?: string;
  /** Default-off, manually invoked administrator-only Project-v2 staging acceptance. */
  PROJECT_ALPHA_PROJECT_V2_ACTIVATION_ENABLED?: string;
  /** Default-off administrator transport for private PA Directory and Project consumers. */
  PROJECT_ALPHA_PRIVATE_ADMIN_TRANSPORT_ENABLED?: string;
  /** Staging-only, manually invoked Directory bootstrap acceptance fixture. */
  PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ACCEPTANCE_ENABLED?: string;
  /** Staging-only immutable source pin for the Directory bootstrap fixture. */
  PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_SOURCE_ID?: string;
  /** Staging-only exact HTTPS origin pin for the Directory bootstrap fixture. */
  PROJECT_ALPHA_DIRECTORY_V2_BOOTSTRAP_ORIGIN?: string;
  /** Default-off, staging-only native organization fixture with no PA enrollment. */
  NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_ENABLED?: string;
  /** Deployment-pinned active business area for the native-only staging fixture. */
  NATIVE_DIRECTORY_STAGING_EMPTY_ENROLLMENT_FIXTURE_BUSINESS_AREA_ID?: string;
  /** Default-off authenticated native Directory profile create/update routes. */
  NATIVE_DIRECTORY_PROFILE_WRITES_ENABLED?: string;
  /** Default-off bounded scheduled delivery for native Directory outboxes. */
  NATIVE_DIRECTORY_OUTBOX_DRAIN_ENABLED?: string;
  /** Default-off native, explicit-grant authority for monitor lifecycle control. */
  NATIVE_INTEGRATION_CONTROL_ENABLED?: string;
  /** Exact same-origin native monitor-control UI origin; no implicit fallback. */
  NATIVE_INTEGRATION_CONTROL_ORIGIN?: string;
  /** Default-off native staff issuance/reveal boundary for client profile onboarding. */
  CLIENT_ONBOARDING_ADMIN_ENABLED?: string;
  /** Exact HTTPS Operations origin for the native onboarding staff boundary. */
  CLIENT_ONBOARDING_ADMIN_ORIGIN?: string;
  /** Deployment secret containing the bounded AES-GCM handoff keyring. */
  CLIENT_ONBOARDING_HANDOFF_KEYRING?: string;
  PROJECT_ALPHA_CONNECTOR_SNAPSHOT_CREDENTIALS?: string;
  PROJECT_ALPHA_CONNECTOR_EVENT_CREDENTIALS?: string;
  /** Deploy-managed source manifest; selects configured credential references and is never browser-administered. */
  PROJECT_ALPHA_CONNECTOR_SOURCES?: string;
  PROJECT_ALPHA_CONNECTOR_SOURCES_REQUIRED?: string;
  /** Non-secret Cloudflare Access service-token expiry timestamps for connector operations diagnostics. */
  PROJECT_ALPHA_LTDS_ACCESS_SERVICE_TOKEN_EXPIRES_AT?: string;
  PROJECT_ALPHA_LTT_ACCESS_SERVICE_TOKEN_EXPIRES_AT?: string;
  /** Temporary, default-off gate for numeric quote linkage on pre-catalog requests only. */
  LEGACY_CLIENT_REQUEST_PA_QUOTE_LINK_ENABLED?: string;
  /** Enables the separately scoped, staff-triggered private draft command. */
  PROJECT_ALPHA_DRAFT_QUOTES_ENABLED?: string;
  /** Dedicated PA credential with only portal.quote-draft.create. */
  PROJECT_ALPHA_DRAFT_QUOTE_API_KEY?: string;
  /** HMAC secret for timestamped, replay-protected PA draft commands. */
  PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET?: string;
  PROJECT_ALPHA_PORTAL_APPLICATION_KEY?: string;
  PROJECT_ALPHA_PORTAL_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_PORTAL_HMAC_SECRET?: string;
  PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET?: string;
  PROJECT_ALPHA_DELIVERY_INTENTS_ENABLED?: string;
  /** Default-off, time-bounded emergency bridge while producers move to Ops Sync. */
  PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_ENABLED?: string;
  PROJECT_ALPHA_DELIVERY_DIRECT_COMPAT_UNTIL?: string;
  PROJECT_ALPHA_DELIVERY_GUEST_ENABLED?: string;
  CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED?: string;
  /** Enables exact-source portal-workspace reconciliation for every visible source. */
  CLIENT_PORTAL_WORKSPACE_RECONCILIATION_ENABLED?: string;
  /** @deprecated Compatibility alias for CLIENT_PORTAL_WORKSPACE_RECONCILIATION_ENABLED. */
  CLIENT_PORTAL_PRIMARY_WORKSPACE_RECONCILIATION_ENABLED?: string;
  /** Default-off, read-only Client Hub display of selected schema-v4 Project Alpha contact roles. */
  CLIENT_HUB_PA_CONTACT_ASSIGNMENTS_ENABLED?: string;
  /** Enables staff public-share recipient lookup from the PA portal projection. */
  DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED?: string;
  /** Defense-in-depth gate for the private Client -> Operations share signer RPC. */
  CLIENT_DELEGATED_SHARE_SIGNER_ENABLED?: string;
  /** Default-off private Client -> Operations onboarding recipient bridge. */
  CLIENT_ONBOARDING_RECIPIENT_BRIDGE_ENABLED?: string;
  /** Enables staff recovery for the additive client workspace hierarchy. */
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED?: string;
  /** Must match the Client deployment before publishing relation-backed grants. */
  CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED?: string;
  /** Mirror Client before staff can issue an approved named invitation. */
  CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED?: string;
  /** Coordinated release barrier for every project-access authority mutation. Default off. */
  PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED?: string;
  OPERATIONS_SESSION_SECRET: string;
  /** Anonymous public-share origin; never use the authenticated portal origin as an implicit fallback. */
  PUBLIC_SHARE_ORIGIN: string;
  /** Exact authenticated portal origins allowed to embed newly uploaded Stream media. */
  CLIENT_PORTAL_ORIGINS?: string;
  /** Exact staff-facing origins served by the same Operations deployment. */
  OPERATIONS_ORIGINS?: string;
  DELIVERY_TOKEN_SECRET: string;
  DELIVERY_PREVIOUS_TOKEN_SECRET?: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER?: string;
  AUDIT_IP_SECRET: string;
  STREAM_API_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_DELIVERY_UPLOAD_ACCESS_KEY_ID?: string;
  R2_DELIVERY_UPLOAD_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID: string;
  R2_PURGE_ENABLED?: string;
  R2_BUCKET_NAME: string;
  R2_INCOMING_BUCKET_NAME: string;
  DIRECT_DELIVERY_UPLOADS_ENABLED?: string;
  INCOMING_BASE_URL: string;
  INCOMING_EXPECTED_HOST: string;
  INCOMING_BUCKET: R2Bucket;
  INCOMING_LIFECYCLE_WORKFLOW: Workflow;
  /** Enable only after the ready-prefix TrueNAS cutover and migration. */
  INCOMING_RCLONE_PROMOTION_ENABLED?: string;
  INCOMING_RCLONE_PROMOTION_WORKFLOW?: Workflow<import("./incoming-rclone-dispatch").IncomingPromotionSegment>;
  TURNSTILE_SITE_KEY: string;
  TURNSTILE_SECRET: string;
  INCOMING_SESSION_SECRET: string;
  INCOMING_ACCESS_CODE_PEPPER: string;
  INCOMING_PICKUP_SECRET: string;
  R2_CRUD_WORKFLOW: Workflow;
  THUMBNAIL_QUEUE: Queue<{
    kind: "image-thumbnail.v1";
    sourceKey: string;
    sourceEtag: string;
  }>;
  THUMBNAIL_RENDERER: DurableObjectNamespace<ThumbnailRendererContainer>;
  FILE_EVENTS_QUEUE_NAME: string;
  THUMBNAIL_QUEUE_NAME: string;
  THUMBNAIL_DLQ_NAME: string;
  /** Dedicated bearer secret for the bounded TrueNAS thumbnail ingest endpoint. */
  THUMBNAIL_INGEST_SECRET?: string;
  /** Exact Operations edge hostname accepted by the ingest endpoint. */
  THUMBNAIL_INGEST_EXPECTED_HOST?: string;
  /** Exact machine-facing hostname accepted by the TrueNAS renderer API. */
  THUMBNAIL_RENDERER_EXPECTED_HOST?: string;
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  NOTIFICATION_EMAIL?: SendEmail;
  NOTIFICATION_FROM?: string;
  SMTP_NOTIFICATIONS_ENABLED?: string;
  SMTP_HOST?: string;
  SMTP_FROM?: string;
  SMTP_USERNAME?: string;
  SMTP_PASSWORD?: string;
  /** Address that receives new client service-request triage notices. */
  CLIENT_REQUEST_TRIAGE_TO?: string;
  /** Default-off staff mutation surface for portal-v2 identity denials. */
  CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED?: string;
  CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED?: string;
  /** Mirrors the client Worker denylist rollout for safe grant recipient checks. */
  CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED?: string;
  CLIENT_PORTAL_OPERATIONS_MANAGEMENT_ENABLED?: string;
  /** Default-off collaborator access-expiry notice reconciliation and mail. */
  PROJECT_ACCESS_EXPIRY_NOTIFICATIONS_ENABLED?: string;
  /** Default-off exact-principal folder change mail. */
  AUTHENTICATED_DELIVERY_NOTIFICATIONS_ENABLED?: string;
  /** Migration-first, default-off atomic file-event capture and durable target recovery. */
  AUTHENTICATED_DELIVERY_RECOVERY_ENABLED?: string;
  /** Default-off explicit authenticated folder-grant management. */
  AUTHENTICATED_DELIVERY_GRANTS_ENABLED?: string;
  /** Independent default-off gate for new grants, restores, and folder bindings. */
  AUTHENTICATED_DELIVERY_CREATION_ENABLED?: string;
  /** Default-off LTDS authorization/control-plane integration with the self-hosted Viewer. */
  VIEWER_INTEGRATION_ENABLED?: string;
  /** Default-off administrative dataset and processing control plane. */
  VIEWER_PROCESSING_ENABLED?: string;
  /** Default-off staff creation and revocation of bearer public Viewer links. */
  VIEWER_PUBLIC_SHARES_ENABLED?: string;
  VIEWER_BASE_URL?: string;
  VIEWER_SERVICE_KEY_ID?: string;
  VIEWER_SERVICE_HMAC_SECRET?: string;
  /** Key id expected on signed Viewer -> Operations processing events. */
  VIEWER_EVENT_KEY_ID?: string;
  /** Separate HMAC secret for Viewer -> Operations event callbacks. */
  VIEWER_EVENT_HMAC_SECRET?: string;
  /** Previous callback key accepted only during an explicit rotation window. */
  VIEWER_EVENT_PREVIOUS_KEY_ID?: string;
  VIEWER_EVENT_PREVIOUS_HMAC_SECRET?: string;
  /** Installation display-unit default; invalid or absent values fail to imperial. */
  DEFAULT_UNITS?: string;
  /** Default-off private Client -> Operations Viewer session issuer. */
  CLIENT_VIEWER_SESSION_ISSUER_ENABLED?: string;
  /** Separate default-off client creation/revocation of Viewer public links. */
  CLIENT_VIEWER_SHARES_ENABLED?: string;
  MAPBOX_PUBLIC_TOKEN?: string;
  SUA_GATEWAY_USER?: string;
  SUA_GATEWAY_PASSWORD?: string;
  DROPBOX_IMPORT_ENABLED?: string;
  DROPBOX_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  DROPBOX_IMPORT_TOKEN_SECRET?: string;
  DROPBOX_IMPORT_WORKFLOW?: Workflow;
};

export interface StaffPrincipal {
  id: string;
  email: string;
  displayName: string;
  accessSubject: string;
  projectAlphaUserId: string | null;
}

export interface GrantRow {
  permission: Permission;
  effect: "allow" | "deny";
  scope: PermissionScope;
  divisionId: string | null;
  source: "role" | "override";
}

export interface ResourceContext {
  divisionId?: string | null;
  assignedStaffIds?: string[];
  ownerId?: string | null;
}
