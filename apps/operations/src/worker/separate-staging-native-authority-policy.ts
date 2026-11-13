/** New account contract. The historical staging policy remains unchanged. */
export const SEPARATE_NATIVE_STAGE = Object.freeze({
  profile: "separate-account-native-requests-v1",
  accountId: "df3f376bae6ee621f50cf972ebcc9484",
  host: "ledge-top-ops-staging.ledge-top-staging.workers.dev",
  origin: "https://ledge-top-ops-staging.ledge-top-staging.workers.dev",
  recipientOrigin: "https://ledge-top-clients-staging.ledge-top-staging.workers.dev",
  issuer: "https://ledge-top-staging.cloudflareaccess.com",
  audience: "ffb0d85b1929560fbafd7476a987401e0e25dc5000a251fcdcf85bc2ae5d7f84",
});

export interface SeparateNativeStagingEnv {
  ENVIRONMENT?: string;
  STAGING_NATIVE_REQUEST_PROFILE?: string;
  EXPECTED_HOST?: string;
  PUBLIC_BASE_URL?: string;
  DELIVERY_BASE_URL?: string;
  TEAM_DOMAIN?: string;
  OPERATIONS_AUD?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: unknown;
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?: unknown;
}

/** Configuration admission is not staff authentication or permission to grant. */
export function exactSeparateNativeStagingDeployment(request: Request, env: SeparateNativeStagingEnv): boolean {
  return env.ENVIRONMENT === "staging"
    && env.STAGING_NATIVE_REQUEST_PROFILE === SEPARATE_NATIVE_STAGE.profile
    && env.EXPECTED_HOST === SEPARATE_NATIVE_STAGE.host
    && env.PUBLIC_BASE_URL === SEPARATE_NATIVE_STAGE.origin
    && env.DELIVERY_BASE_URL === SEPARATE_NATIVE_STAGE.recipientOrigin
    && env.TEAM_DOMAIN === SEPARATE_NATIVE_STAGE.issuer
    && env.OPERATIONS_AUD === SEPARATE_NATIVE_STAGE.audience
    && new URL(request.url).origin === SEPARATE_NATIVE_STAGE.origin;
}

function hasMethods(binding: unknown, names: readonly string[]): boolean {
  if (!binding || (typeof binding !== "object" && typeof binding !== "function")) return false;
  try { return names.every(name => typeof (binding as Record<string, unknown>)[name] === "function"); }
  catch { return false; }
}

export function separateNativeRecipientOwnerEnabled(env: SeparateNativeStagingEnv): boolean {
  return env.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED === "true"
    && env.CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED === "true"
    && env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED === "true"
    && hasMethods(env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY,
      ["applyNativeAuthority", "getNativeAuthorityStatus"]);
}

export function separateNativeWorkspaceOwnerEnabled(env: SeparateNativeStagingEnv): boolean {
  return env.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED === "true"
    && env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED === "true"
    && hasMethods(env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION, ["publishWorkspace", "getPublicationStatus"]);
}

const family = (path: string, base: string) => path === base || path.startsWith(`${base}/`);
export function separateNativeOwnerRoute(path: string): "recipient" | "workspace" | "excluded" | "ordinary" {
  if (family(path, "/api/native-client-portal/operations-recipient-enrollment")
    || path === "/administration/client-portal/operations-recipients") return "recipient";
  if (family(path, "/api/native-client-portal/operations-workspaces")
    || path === "/administration/client-portal/operations-workspaces") return "workspace";
  // This reduced profile does not activate delivery, billing or maintenance.
  if (family(path, "/api/native-client-portal") || family(path, "/administration/client-portal")
    || family(path, "/administration/staging")) return "excluded";
  return "ordinary";
}
