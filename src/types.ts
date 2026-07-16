export interface Env {
  DB: D1Database;
  DATA_BUCKET: R2Bucket;
  ACCESS_CODE_RATE_LIMITER: RateLimit;
  PUBLIC_BASE_URL: string;
  TEAM_DOMAIN: string;
  POLICY_AUD: string;
  BOOTSTRAP_ADMIN_EMAIL: string;
  APP_SECRET: string;
}

export interface StaffPrincipal {
  type: "staff";
  id: string;
  email: string;
  displayName: string | null;
  role: "admin" | "staff";
}

export interface IntegrationPrincipal {
  type: "integration";
  id: string;
  name: string;
  scopes: string[];
}

export type Principal = StaffPrincipal | IntegrationPrincipal;

export interface ShareRecord {
  id: string;
  project_id: string;
  token_hash: string;
  label: string | null;
  password_hash: string | null;
  password_salt: string | null;
  password_iterations: number | null;
  expires_at: string | null;
  revoked_at: string | null;
  client_name: string;
  project_name: string;
  r2_prefix: string;
  external_ref: string | null;
}
