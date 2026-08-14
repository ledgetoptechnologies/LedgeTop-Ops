import type { ClientDelegatedShareSignerBinding } from "@ltds/shared";

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
  EXPECTED_HOST: string;
  CLIENT_PORTAL_ENABLED?: string;
  CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_REQUEST_V2_ENABLED?: string;
  /** Server-only Project Alpha catalog projection. Default-off and never browser writable. */
  PROJECT_ALPHA_CATALOG_SYNC_ENABLED?: string;
  PROJECT_ALPHA_CATALOG_APPLICATION_KEY?: string;
  PROJECT_ALPHA_CATALOG_ACCESS_TEAM_DOMAIN?: string;
  PROJECT_ALPHA_CATALOG_ACCESS_AUD?: string;
  PROJECT_ALPHA_CATALOG_HMAC_SECRET?: string;
  /** Server-only PA portal hierarchy/entitlement projection. Independent and default-off. */
  PROJECT_ALPHA_PORTAL_SYNC_ENABLED?: string;
  PROJECT_ALPHA_PORTAL_APPLICATION_KEY?: string;
  PROJECT_ALPHA_PORTAL_ACCESS_TEAM_DOMAIN?: string;
  PROJECT_ALPHA_PORTAL_ACCESS_AUD?: string;
  PROJECT_ALPHA_PORTAL_HMAC_SECRET?: string;
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
  /** Client invitation/member mutations. Independent from read-only hierarchy rollout. */
  CLIENT_PORTAL_MEMBERSHIP_MANAGEMENT_ENABLED?: string;
  /** Native Cloudflare Email Service delivery for the invitation outbox. Default-off. */
  CLIENT_PORTAL_INVITATION_EMAIL_ENABLED?: string;
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
  CLIENT_DELEGATED_SHARE_SESSION_SECRET?: string;
  CLIENT_DELEGATED_SHARE_KEY_ID?: string;
  /**
   * Dedicated Client Portal Access application values. These deliberately do
   * not reuse the staff Operations or Ops Sync audience.
   */
  CLIENT_ACCESS_TEAM_DOMAIN?: string;
  CLIENT_ACCESS_AUD?: string;
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
  recipient_email?: string | null;
  image_location_map_enabled?: number;
}
