import type { ClientDelegatedShareSignerBinding, ViewerSessionIssuerBinding } from "@ltds/shared";

export interface Env {
  DELIVERY_DB: D1Database;
  DATA_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  STREAM: { video(id: string): { generateToken(): Promise<string> } };
  ACCESS_CODE_RATE_LIMITER: RateLimit;
  PUBLIC_SESSION_RATE_LIMITER: RateLimit;
  PUBLIC_MANIFEST_RATE_LIMITER: RateLimit;
  PUBLIC_MEDIA_RATE_LIMITER: RateLimit;
  PUBLIC_THUMBNAIL_RATE_LIMITER: RateLimit;
  PUBLIC_DOWNLOAD_RATE_LIMITER: RateLimit;
  PUBLIC_STREAM_RATE_LIMITER: RateLimit;
  PUBLIC_BULK_RATE_LIMITER: RateLimit;
  PUBLIC_BASE_URL: string;
  /** Canonical public delivery/share origin. PUBLIC_BASE_URL remains a rollout-compatible mirror. */
  PUBLIC_SHARE_ORIGIN?: string;
  EXPECTED_HOST: string;
  CLIENT_PORTAL_ENABLED?: string;
  CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_ORIGINS?: string;
  /** Legacy delivery/portal origins retained only for compatible reads and canonical redirects. */
  LEGACY_CLIENT_ORIGINS?: string;
  /** Immutable, privacy-bounded authenticated content-start audit producer. Default-off. */
  CLIENT_PORTAL_CONTENT_AUDIT_ENABLED?: string;
  /** Temporary release barrier for the preserving client-notification table rebuild. */
  CLIENT_PORTAL_NOTIFICATION_MIGRATION_MAINTENANCE?: string;
  /** Dedicated HMAC key for content/version fingerprints; never reused for IP or sessions. */
  CLIENT_PORTAL_CONTENT_AUDIT_HMAC_SECRET?: string;
  CLIENT_PORTAL_REQUEST_V2_ENABLED?: string;
  /** Source-qualified requests from native PA workspaces. Independent and default-off. */
  CLIENT_PORTAL_NATIVE_REQUESTS_ENABLED?: string;
  /**
   * Bounded comma-separated exact Project Alpha source IDs allowed to expose
   * native feedback. Default empty; malformed configuration fails closed.
   */
  CLIENT_PORTAL_NATIVE_FEEDBACK_SOURCE_IDS?: string;
  /** Server-only Project Alpha catalog projection. Default-off and never browser writable. */
  PROJECT_ALPHA_CATALOG_SYNC_ENABLED?: string;
  PROJECT_ALPHA_CATALOG_APPLICATION_KEY?: string;
  PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN?: string;
  PROJECT_ALPHA_CATALOG_ACCESS_AUD?: string;
  PROJECT_ALPHA_CATALOG_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_CATALOG_HMAC_SECRET?: string;
  PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_CATALOG_PREVIOUS_HMAC_SECRET?: string;
  /** Server-only PA portal hierarchy/entitlement projection. Independent and default-off. */
  PROJECT_ALPHA_PORTAL_SYNC_ENABLED?: string;
  /** Emergency-only legacy HTTP receiver. Production keeps this false; Ops Sync RPC remains independently enabled. */
  PROJECT_ALPHA_PORTAL_DIRECT_HTTP_ENABLED?: string;
  PROJECT_ALPHA_PORTAL_APPLICATION_KEY?: string;
  PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN?: string;
  PROJECT_ALPHA_PORTAL_ACCESS_AUD?: string;
  PROJECT_ALPHA_PORTAL_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_PORTAL_HMAC_SECRET?: string;
  PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_KEY_ID?: string;
  PROJECT_ALPHA_PORTAL_PREVIOUS_HMAC_SECRET?: string;
  /** Default-off HMAC receiver for source-owned service facts. */
  PROJECT_ALPHA_SERVICE_ASSIGNMENT_SYNC_ENABLED?: string;
  /** Default-off exact-target filter for request service availability. Never grants access. */
  CLIENT_PORTAL_SERVICE_ASSIGNMENT_POLICY_ENABLED?: string;
  /** Deploy-managed existing-connector credential envelope; portal keys only. */
  PROJECT_ALPHA_CONNECTOR_CREDENTIALS?: string;
  /** Default-off, read-only Project Alpha planning guidance integration. */
  PROJECT_ALPHA_PRICING_HINTS_ENABLED?: string;
  PROJECT_ALPHA_PRICING_HINT_URL?: string;
  PROJECT_ALPHA_PRICING_HINT_ALLOWED_ORIGIN?: string;
  PROJECT_ALPHA_PRICING_HINT_API_KEY?: string;
  PROJECT_ALPHA_PRICING_HINT_HMAC_SECRET?: string;
  PROJECT_ALPHA_PRICING_HINT_APPLICATION_KEY?: string;
  PROJECT_ALPHA_PRICING_HINT_CURRENCIES?: string;
  CLIENT_PORTAL_TEAM_ENABLED?: string;
  /** Additive PA-backed workspace hierarchy. Default-off until shadow parity is proven. */
  CLIENT_PORTAL_HIERARCHY_V2_ENABLED?: string;
  CLIENT_PORTAL_PA_IDENTITY_AUTO_ELIGIBILITY_ENABLED?: string;
  /** Enables live global/scoped identity denials. Default off for additive rollout. */
  CLIENT_PORTAL_IDENTITY_DENYLIST_ENABLED?: string;
  /** Mirrored release barrier proving Operations can administer eligibility blocks. */
  CLIENT_PORTAL_DENY_POLICY_MANAGEMENT_ENABLED?: string;
  CLIENT_PORTAL_ROOT_ACCESS_POLICY_ENABLED?: string;
  /** Requires an explicit live authenticated delivery grant in addition to portal-v2 entitlement. */
  AUTHENTICATED_DELIVERY_GRANTS_ENABLED?: string;
  /** Mirrored release declaration; creation is performed only by Operations. */
  AUTHENTICATED_DELIVERY_CREATION_ENABLED?: string;
  /** Many-to-many PA directory edges and project-retention authorization. Independent/default-off. */
  CLIENT_PORTAL_HIERARCHY_RELATIONS_ENABLED?: string;
  /** Client invitation/member mutations. Independent from read-only hierarchy rollout. */
  CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED?: string;
  /** Coordinated release barrier for every project-access authority mutation. Default off. */
  PROJECT_ACCESS_AUTHORITY_MUTATIONS_ENABLED?: string;
  /** Client promotion/demotion of existing local workspace members. Default off. */
  CLIENT_PORTAL_PEER_ADMIN_ENABLED?: string;
  /** Client-local reusable contacts. Default-off; records never grant portal access. */
  CLIENT_PORTAL_ADDRESS_BOOK_ENABLED?: string;
  CLIENT_PORTAL_ADDRESS_BOOK_FINGERPRINT_SECRET?: string;
  /** Native Cloudflare Email Service delivery for the invitation outbox. Default-off. */
  CLIENT_PORTAL_INVITATION_EMAIL_ENABLED?: string;
  /**
   * Operator attestation that the invitee is enrolled in the dedicated Client
   * Portal Access application before invitation email is handed off.
   */
  CLIENT_PORTAL_ACCESS_ENROLLMENT_READY?: string;
  CLIENT_PORTAL_INVITATION_EMAIL?: SendEmail;
  CLIENT_PORTAL_INVITATION_FROM?: string;
  CLIENT_PORTAL_INVITATION_FROM_NAME?: string;
  /**
   * Client-delegated public links remain unavailable until an internal
   * Operations signer service binding is contract-tested. Never bind the
   * Operations DELIVERY_TOKEN_SECRET into this Worker.
  */
  CLIENT_DELEGATED_SHARES_ENABLED?: string;
  CLIENT_DELEGATED_SHARE_SIGNER?: ClientDelegatedShareSignerBinding;
  /** Default-off portal Viewer launch surface; the HMAC key stays in Operations. */
  CLIENT_VIEWER_ENABLED?: string;
  /** Separate default-off client creation/revocation of Viewer public links. */
  CLIENT_VIEWER_SHARES_ENABLED?: string;
  VIEWER_SESSION_ISSUER?: ViewerSessionIssuerBinding;
  CLIENT_DELEGATED_SHARE_SESSION_SECRET?: string;
  CLIENT_DELEGATED_SHARE_KEY_ID?: string;
  /**
   * Dedicated Client Portal Access application values. These deliberately do
   * not reuse the staff Operations or Ops Sync audience.
   */
  CLIENT_ACCESS_TEAM_DOMAIN?: string;
  CLIENT_ACCESS_AUD?: string;
  CLIENT_ACCESS_AUDS?: string;
  MAPBOX_PUBLIC_TOKEN?: string;
  ENVIRONMENT: string;
  SESSION_KEY_ID: string;
  PREVIOUS_SESSION_KEY_ID?: string;
  DELIVERY_SESSION_SECRET: string;
  DELIVERY_PREVIOUS_SESSION_SECRET?: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER?: string;
  AUDIT_IP_SECRET: string;
  R2_S3_ENDPOINT: string;
  R2_BUCKET_NAME: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  /** Default-off until a real scanner consumes quarantine objects and signs receipts. */
  CLIENT_REQUEST_ATTACHMENTS_ENABLED?: string;
  CLIENT_REQUEST_ATTACHMENT_SCANNER_SECRET?: string;
  /** Dedicated R2 Object Read & Write credential used only to sign attachment part PUTs. */
  CLIENT_REQUEST_ATTACHMENT_R2_ACCESS_KEY_ID?: string;
  CLIENT_REQUEST_ATTACHMENT_R2_SECRET_ACCESS_KEY?: string;
  BULK_DOWNLOAD_WORKFLOW: Workflow;
  CLOUD_TRANSFER_WORKFLOW: Workflow;
  CLOUD_TRANSFER_DROPBOX_ENABLED?: string;
  CLOUD_TRANSFER_GOOGLE_ENABLED?: string;
  CLOUD_TRANSFER_GOOGLE_PICKER_CLIENT_ENABLED?: string;
  DROPBOX_CLIENT_ID?: string;
  DROPBOX_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_PICKER_API_KEY?: string;
  GOOGLE_CLOUD_PROJECT_NUMBER?: string;
  CLOUD_TRANSFER_TOKEN_SECRET?: string;
  CLOUD_TRANSFER_PREVIOUS_TOKEN_SECRET?: string;
  CLOUD_TRANSFER_KEY_ID?: string;
  CLOUD_TRANSFER_PREVIOUS_KEY_ID?: string;
  STREAM_CUSTOMER_CODE?: string;
}

export interface ShareRow {
  id: string;
  public_id: string | null;
  project_id: string;
  token_hash: string;
  label: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  password_algorithm: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  revoked_reason: string | null;
  unavailable_since: string | null;
  share_version: number;
  client_name: string;
  project_name: string;
  r2_prefix: string;
  r2_object_key?: string | null;
  recipient_email?: string | null;
  image_location_map_enabled?: number;
}
