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
  R2_CRUD_WORKFLOW: Workflow;
  ALERT_EMAIL?: SendEmail;
  ALERT_FROM?: string;
  ALERT_TO?: string;
  NOTIFICATION_EMAIL?: SendEmail;
  NOTIFICATION_FROM?: string;
  SUA_GATEWAY_USER?: string;
  SUA_GATEWAY_PASSWORD?: string;
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
