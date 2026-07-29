import type { Permission, PermissionScope } from "@ltds/shared";

export type Env = Cloudflare.Env & {
  PROJECT_ALPHA_API_KEY?: string;
  OPERATIONS_SESSION_SECRET: string;
  DELIVERY_TOKEN_SECRET: string;
  DELIVERY_PREVIOUS_TOKEN_SECRET?: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  DELIVERY_PREVIOUS_ACCESS_CODE_PEPPER?: string;
  AUDIT_IP_SECRET: string;
  STREAM_API_TOKEN?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  R2_INCOMING_BUCKET_NAME: string;
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
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  NOTIFICATION_EMAIL?: SendEmail;
  NOTIFICATION_FROM?: string;
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
