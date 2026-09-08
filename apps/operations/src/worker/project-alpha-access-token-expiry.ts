import type { Env } from "./types";

export type ProjectAlphaAccessTokenExpiryState =
  | "healthy"
  | "renewal_due"
  | "expires_soon"
  | "expired"
  | "unconfigured"
  | "invalid";

export interface ProjectAlphaAccessTokenExpiryItem {
  connector: "ltds" | "ltt";
  label: string;
  state: ProjectAlphaAccessTokenExpiryState;
  /** A deployment-provided expiry timestamp only; never a token, client ID, or credential fingerprint. */
  expiresAt: string | null;
  daysRemaining: number | null;
}

export interface ProjectAlphaAccessTokenExpiryDiagnostic {
  generatedAt: string;
  healthy: boolean;
  connectors: ProjectAlphaAccessTokenExpiryItem[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function item(connector: "ltds" | "ltt", label: string, configured: string | undefined, now: number): ProjectAlphaAccessTokenExpiryItem {
  const value = configured?.trim();
  if (!value) return { connector, label, state: "unconfigured", expiresAt: null, daysRemaining: null };
  if (!RFC3339_UTC.test(value)) return { connector, label, state: "invalid", expiresAt: null, daysRemaining: null };
  const expiration = Date.parse(value);
  if (!Number.isFinite(expiration)) return { connector, label, state: "invalid", expiresAt: null, daysRemaining: null };
  const daysRemaining = Math.floor((expiration - now) / DAY_MS);
  const state: ProjectAlphaAccessTokenExpiryState = daysRemaining < 0 ? "expired"
    : daysRemaining <= 90 ? "expires_soon"
      : daysRemaining <= 365 ? "renewal_due"
        : "healthy";
  return { connector, label, state, expiresAt: new Date(expiration).toISOString(), daysRemaining };
}

/**
 * Read-only, credential-free reminder for deployment-owned Cloudflare Access
 * service tokens. The timestamp is deliberately configured independently of
 * the token secret, so this endpoint cannot reveal or derive machine access.
 */
export function projectAlphaAccessTokenExpiryDiagnostic(env: Env, now = Date.now()): ProjectAlphaAccessTokenExpiryDiagnostic {
  const connectors = [
    item("ltds", "Ledge Top Drone Services", env.PROJECT_ALPHA_LTDS_ACCESS_SERVICE_TOKEN_EXPIRES_AT, now),
    item("ltt", "Ledge Top Technologies", env.PROJECT_ALPHA_LTT_ACCESS_SERVICE_TOKEN_EXPIRES_AT, now),
  ];
  return { generatedAt: new Date(now).toISOString(), healthy: connectors.every(value => value.state === "healthy"), connectors };
}
