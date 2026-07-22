import type { Permission, PermissionScope } from "@ltds/shared";

export type Env = Cloudflare.Env & {
  PROJECT_ALPHA_API_KEY?: string;
  OPERATIONS_SESSION_SECRET: string;
  DELIVERY_TOKEN_SECRET: string;
  DELIVERY_ACCESS_CODE_PEPPER: string;
  AUDIT_IP_SECRET: string;
  STREAM_API_TOKEN?: string;
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
