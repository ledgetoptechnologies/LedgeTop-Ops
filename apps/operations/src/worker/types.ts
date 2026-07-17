import type { Permission, PermissionScope } from "@ltds/shared";

export interface ImagesBindingLike {
  input(stream: ReadableStream): { transform(options: Record<string, unknown>): { output(options: Record<string, unknown>): Promise<{ response(): Response }> } };
}

export interface Env {
  OPS_DB: D1Database;
  DELIVERY_DB: D1Database;
  DATA_BUCKET: R2Bucket;
  ASSETS: Fetcher;
  IMAGES: ImagesBindingLike;
  STREAM: { video(id: string): { generateToken(): Promise<string> } };
  PUBLIC_BASE_URL: string;
  EXPECTED_HOST: string;
  ENVIRONMENT: string;
  TEAM_DOMAIN: string;
  OPERATIONS_AUD: string;
  DELIVERY_BASE_URL: string;
  PROJECT_ALPHA_BASE_URL: string;
  PROJECT_ALPHA_API_KEY?: string;
  TFR_REGION: string;
  DISPLAY_TIMEZONE: string;
  MAP_STYLE_URL?: string;
  OPERATIONS_SESSION_SECRET: string;
  DELIVERY_TOKEN_SECRET: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  AUDIT_IP_SECRET: string;
  STREAM_ACCOUNT_ID?: string;
  STREAM_API_TOKEN?: string;
  STREAM_CUSTOMER_CODE?: string;
  SUA_GATEWAY_USER?: string;
  SUA_GATEWAY_PASSWORD?: string;
}

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
