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

/** New client presentation origin on the same physical Worker/database. The
 * public bearer namespace and machine ingress stay on their existing host. */
export const NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE = JSON.stringify({
  ...JSON.parse(NATIVE_DELIVERY_PRODUCTION_PROFILE),
  portalOrigin: "https://portal.ledgetop.app",
  privateRequestOrigins: ["https://portal.ledgetop.app"],
});

/** Separate public delivery origin with the same exact physical deployment.
 * Retain the former private byte origin while existing portal sessions drain.
 * This declaration does not publish settings or retire any host. */
export const NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE = JSON.stringify({
  ...JSON.parse(NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE),
  publicShareOrigin: "https://delivery.ledgetop.app",
});

/** Exact installed overlap profiles remain readable during the canonical-only
 * rollout. Their historical metadata does not authorize a legacy browser origin:
 * nativeDeliveryRequestOriginAllowed still admits only portal.ledgetop.app. */
export const NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE = JSON.stringify({
  ...JSON.parse(NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE),
  privateRequestOrigins: ["https://portal.ledgetop.app", "https://portal.ledgetopdroneservices.com"],
});
export const NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE = JSON.stringify({
  ...JSON.parse(NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE),
  publicShareOrigin: "https://delivery.ledgetop.app",
});

export type NativeDeliveryDeploymentEnv = Readonly<{
  ENVIRONMENT?: string;
  EXPECTED_HOST?: string;
  PUBLIC_BASE_URL?: string;
  PUBLIC_SHARE_ORIGIN?: string;
  CLIENT_PORTAL_ORIGIN?: string;
  CLIENT_PORTAL_ORIGINS?: string;
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
  const deliveryCanonical = env.PUBLIC_SHARE_ORIGIN === "https://delivery.ledgetop.app";
  const publicOrigin = deliveryCanonical ? "https://delivery.ledgetop.app" : "https://portal.ledgetopdroneservices.com";
  const expectedProfile = env.CLIENT_PORTAL_ORIGIN === "https://portal.ledgetop.app"
    ? deliveryCanonical ? NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE : NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE
    : env.CLIENT_PORTAL_ORIGIN === "https://portal.ledgetopdroneservices.com"
    ? deliveryCanonical ? null : NATIVE_DELIVERY_PORTAL_PRODUCTION_PROFILE
    : env.CLIENT_PORTAL_ORIGIN === "https://client.ledgetopdroneservices.com" && !deliveryCanonical ? NATIVE_DELIVERY_PRODUCTION_PROFILE : null;
  const installedOverlapProfile = env.CLIENT_PORTAL_ORIGIN === "https://portal.ledgetop.app"
    ? deliveryCanonical ? NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE : NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE
    : null;
  return env.ENVIRONMENT === "production"
    && expectedProfile !== null
    && (env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE === expectedProfile
      || (installedOverlapProfile !== null && env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE === installedOverlapProfile))
    && env.EXPECTED_HOST === new URL(publicOrigin).host
    && env.PUBLIC_BASE_URL === publicOrigin
    && env.PUBLIC_SHARE_ORIGIN === publicOrigin;
}

/** The migration profile pins the canonical private browser origin. Arbitrary
 * presentation aliases and public hosts never acquire byte access. */
export function nativeDeliveryRequestOriginAllowed(env: NativeDeliveryDeploymentEnv, requestUrl: string): boolean {
  if (!nativeDeliveryDeploymentEnabled(env)) return false;
  let origin: string;
  try { origin = new URL(requestUrl).origin; } catch { return false; }
  if ([NATIVE_DELIVERY_APP_PORTAL_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_DELIVERY_PRODUCTION_PROFILE,
    NATIVE_DELIVERY_APP_PORTAL_OVERLAP_PRODUCTION_PROFILE, NATIVE_DELIVERY_APP_DELIVERY_OVERLAP_PRODUCTION_PROFILE]
    .includes(env.CLIENT_PORTAL_OPERATIONS_NATIVE_DELIVERY_DEPLOYMENT_PROFILE ?? "")) {
    const configured = env.CLIENT_PORTAL_ORIGINS?.split(",").map(value => value.trim()) ?? [];
    if (!configured.length || configured.length > 4 || new Set(configured).size !== configured.length
      || !configured.includes(env.CLIENT_PORTAL_ORIGIN ?? "")) return false;
    try {
      if (configured.some(value => { const url = new URL(value); return url.protocol !== "https:" || url.origin !== value; })) return false;
    } catch { return false; }
    return origin === "https://portal.ledgetop.app"
      && configured.includes(origin);
  }
  return origin === env.CLIENT_PORTAL_ORIGIN;
}
