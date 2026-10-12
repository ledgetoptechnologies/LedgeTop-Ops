import standardWorker from "./index";
import { handleOperationsNativeRecipientOwnerHttp } from "./operations-portal-native-recipient-owner-http";
import type { OperationsPortalNativeDeliveryAuthorityDispatchEnv } from "./operations-portal-native-delivery-authority-dispatch";
import { exactNativeStagingConfiguration, exactNativeDirectoryMaintenanceStagingConfiguration } from "./staging-native-authority-policy";
import { handleOperationsNativeDirectoryMaintenanceOwnerHttp } from "./operations-native-directory-maintenance-owner-http";
import type { Env } from "./types";
import { dispatchOperationsPortalNativeOwnerRequest, isOperationsPortalNativeOwnerPath, type OperationsPortalNativeOwnerEnv }
  from "./operations-portal-native-owner-routes";

const STAGING_HOST = "ops-staging.ledgetopdroneservices.com";
const STAGING_ORIGIN = `https://${STAGING_HOST}`;
const RECIPIENT_API = "/api/native-client-portal/operations-recipient-enrollment";
const DIRECTORY_MAINTENANCE_API = "/api/native-client-portal/directory-maintenance-authority";
const DIRECTORY_MAINTENANCE_PAGE = "/administration/staging/directory-maintenance-authority";
const OWNER_PAGES = new Set([
  "/administration/client-portal/operations-recipients",
]);

type NativeStagingEnv = OperationsPortalNativeOwnerEnv & Env & OperationsPortalNativeDeliveryAuthorityDispatchEnv & {
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: unknown;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_CANCELLATION_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED?: string;
  NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED?: string;
};

function pathFamily(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export default {
  async fetch(request: Request, env: NativeStagingEnv, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathFamily(pathname, DIRECTORY_MAINTENANCE_API) || pathname === DIRECTORY_MAINTENANCE_PAGE) {
      if (!exactNativeDirectoryMaintenanceStagingConfiguration(request, env)) return notFound();
      if (pathname === DIRECTORY_MAINTENANCE_PAGE) return env.ASSETS.fetch(request);
      return handleOperationsNativeDirectoryMaintenanceOwnerHttp(request, {
        environment: env.ENVIRONMENT, expectedHost: STAGING_HOST,
        enabledFlag: env.NATIVE_DIRECTORY_MAINTENANCE_OWNER_ENABLED ?? "false",
        configuration: { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
          origin: STAGING_ORIGIN, csrfSecret: env.OPERATIONS_SESSION_SECRET }, database: env.OPS_DB,
      });
    }
    if (isOperationsPortalNativeOwnerPath(pathname) && env.ENVIRONMENT !== "staging") return notFound();
    const ordinaryOwner = await dispatchOperationsPortalNativeOwnerRequest(request, env);
    if (ordinaryOwner) return ordinaryOwner;
    const owned = pathFamily(pathname, RECIPIENT_API) || OWNER_PAGES.has(pathname);
    if (owned && !exactNativeStagingConfiguration(request, env)) return notFound();
    if (OWNER_PAGES.has(pathname)) return env.ASSETS.fetch(request);
    if (pathFamily(pathname, RECIPIENT_API)) return handleOperationsNativeRecipientOwnerHttp(request, {
      environment: env.ENVIRONMENT, expectedHost: env.EXPECTED_HOST,
      configuration: { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
        origin: STAGING_ORIGIN, recipientOrigin: env.DELIVERY_BASE_URL, csrfSecret: env.OPERATIONS_SESSION_SECRET },
      database: env.OPS_DB, dispatch: env,
    });
    return standardWorker.fetch(request, env, ctx);
  },
  queue: standardWorker.queue,
  scheduled: standardWorker.scheduled,
};

export * from "./index";
export { OperationsPortalNativeDeliveryAuthorizationReader } from "./operations-portal-native-delivery-authorization-entrypoint";
export { ClientPortalNativeFinancialReader } from "./client-portal-native-financial-entrypoint";
