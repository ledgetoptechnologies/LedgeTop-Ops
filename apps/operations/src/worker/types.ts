import type { Permission, PermissionScope } from "@ltds/shared";
import type { ThumbnailRendererContainer } from "./thumbnail-renderer-container";

export type Env = Omit<Cloudflare.Env, "DIRECT_DELIVERY_UPLOADS_ENABLED" | "R2_PURGE_ENABLED" | "THUMBNAIL_RENDERER"> & {
  PROJECT_ALPHA_API_KEY?: string;
  /** Enables the separately scoped, staff-triggered private draft command. */
  PROJECT_ALPHA_DRAFT_QUOTES_ENABLED?: string;
  /** Dedicated PA credential with only portal.quote-draft.create. */
  PROJECT_ALPHA_DRAFT_QUOTE_API_KEY?: string;
  /** HMAC secret for timestamped, replay-protected PA draft commands. */
  PROJECT_ALPHA_DRAFT_QUOTE_HMAC_SECRET?: string;
  /** Enables staff public-share recipient lookup from the PA portal projection. */
  DELIVERY_SHARE_DIRECTORY_RECIPIENTS_ENABLED?: string;
  OPERATIONS_SESSION_SECRET: string;
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
