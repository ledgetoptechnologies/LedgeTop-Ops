/** Deployment-owned admission, independent of recipient/content authorization.
 * A Worker cannot inspect a D1 object's physical database UUID. Release tooling
 * must verify the actual account, Worker, bindings and domains before setting
 * this exact profile; the profile is an assertion, never an access grant.
 */
export const NATIVE_DELIVERY_PRODUCTION_PROFILE = JSON.stringify({
  version: 1,
  accountId: "846c924bf17bf4f3dd15c97a4c5d1d51",
  workerName: "ledgetop-clients",
  databaseBinding: "DELIVERY_DB",
  databaseId: "7f40a7b7-c3ec-470e-a626-e798867f71f8",
  portalOrigin: "https://client.ledgetopdroneservices.com",
  publicShareOrigin: "https://portal.ledgetopdroneservices.com",
});

/** Canonical portal deployment. The original exact profile remains supported
 * only with its original primary origin for a coordinated rollout/rollback. */
export const NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE = JSON.stringify({
  ...JSON.parse(NATIVE_DELIVERY_PRODUCTION_PROFILE),
  portalOrigin: "https://portal.ledgetopdroneservices.com",
});

export type NativeDeliveryDeploymentEnv = Readonly<{
  ENVIRONMENT?: string;
  EXPECTED_HOST?: string;
  PUBLIC_BASE_URL?: string;
  PUBLIC_SHARE_ORIGIN?: string;
  CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE?: string;
}>;

/** Existing staging RPC consumers retain their original admission. Browser
 * reads/audits additionally require the exact authenticated staging portal. */
export function nativeDeliveryDeploymentEnabled(env: NativeDeliveryDeploymentEnv,
  surface: "rpc" | "portal" | "publication" = "portal"): boolean {
  if (env.ENVIRONMENT === "staging") {
    if (env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE) return false;
    if (surface === "publication") return env.EXPECTED_HOST === "delivery-staging.ledgetopdroneservices.com";
    return surface === "rpc" || ["https://client-staging.ledgetopdroneservices.com",
      "https://portal-staging.ledgetopdroneservices.com"].includes(env.CLIENT_PORTAL_ORIGIN ?? "");
  }
  const expectedProfile = env.CLIENT_PORTAL_ORIGIN === "https://portal.ledgetopdroneservices.com"
    ? NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE
    : env.CLIENT_PORTAL_ORIGIN === "https://client.ledgetopdroneservices.com" ? NATIVE_DELIVERY_PRODUCTION_PROFILE : null;
  return env.ENVIRONMENT === "production"
    && expectedProfile !== null && env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE === expectedProfile
    && env.EXPECTED_HOST === "portal.ledgetopdroneservices.com"
    && env.PUBLIC_BASE_URL === "https://portal.ledgetopdroneservices.com"
    && env.PUBLIC_SHARE_ORIGIN === "https://portal.ledgetopdroneservices.com";
}
