import standardWorker from "./index";
import { handleOperationsNativeRecipientOwnerHttp } from "./operations-portal-native-recipient-owner-http";
import { handleOperationsPortalNativeDeliveryAuthorityOwnerHttp } from "./operations-portal-native-delivery-authority-owner-http";
import { handleOperationsPortalWorkspaceOwnerHttp } from "./operations-portal-workspace-owner-http";
import type { OperationsPortalWorkspacePublicationBinding } from "./operations-portal-workspace-publication-outbox";
import type { OperationsPortalNativeDeliveryAuthorityDispatchEnv } from "./operations-portal-native-delivery-authority-dispatch";
import { exactNativeStagingConfiguration } from "./staging-native-authority-policy";
import type { Env } from "./types";

const STAGING_HOST = "ops-staging.ledgetopdroneservices.com";
const STAGING_ORIGIN = `https://${STAGING_HOST}`;
const RECIPIENT_API = "/api/native-client-portal/operations-recipient-enrollment";
const DELIVERY_API = "/api/native-client-portal/operations-delivery-authority";
const WORKSPACE_API = "/api/native-client-portal/operations-workspaces";
const WORKSPACE_PAGE = "/administration/client-portal/operations-workspaces";
const OWNER_PAGES = new Set([
  "/administration/client-portal/operations-recipients",
  "/administration/client-portal/operations-delivery-authority",
]);

type NativeStagingEnv = Env & OperationsPortalNativeDeliveryAuthorityDispatchEnv & {
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: unknown;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_READER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?: OperationsPortalWorkspacePublicationBinding;
};

function pathFamily(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export default {
  async fetch(request: Request, env: NativeStagingEnv, ctx: ExecutionContext): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    const workspaceOwned = pathFamily(pathname, WORKSPACE_API) || pathname === WORKSPACE_PAGE;
    const owned = pathFamily(pathname, RECIPIENT_API) || pathFamily(pathname, DELIVERY_API) || OWNER_PAGES.has(pathname);
    if (owned && !exactNativeStagingConfiguration(request, env)) return notFound();
    const workspaceEnabled = exactNativeStagingConfiguration(request, env)
      && env.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED === "true"
      && env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED === "true"
      && typeof env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?.publishWorkspace === "function"
      && typeof env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?.getPublicationStatus === "function";
    if (workspaceOwned && !workspaceEnabled) return notFound();
    if (pathname === WORKSPACE_PAGE) return env.ASSETS.fetch(request);
    if (OWNER_PAGES.has(pathname)) return env.ASSETS.fetch(request);
    if (pathFamily(pathname, RECIPIENT_API)) return handleOperationsNativeRecipientOwnerHttp(request, {
      environment: env.ENVIRONMENT, expectedHost: env.EXPECTED_HOST,
      configuration: { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
        origin: STAGING_ORIGIN, recipientOrigin: env.DELIVERY_BASE_URL, csrfSecret: env.OPERATIONS_SESSION_SECRET },
      database: env.OPS_DB, dispatch: env,
    });
    if (pathFamily(pathname, DELIVERY_API)) return handleOperationsPortalNativeDeliveryAuthorityOwnerHttp(request, {
      environment: env.ENVIRONMENT, expectedHost: env.EXPECTED_HOST,
      configuration: { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
        origin: STAGING_ORIGIN, csrfSecret: env.OPERATIONS_SESSION_SECRET }, database: env.OPS_DB, dispatch: env,
    });
    if (pathFamily(pathname, WORKSPACE_API)) return handleOperationsPortalWorkspaceOwnerHttp(request, {
      environment: env.ENVIRONMENT, expectedHost: env.EXPECTED_HOST,
      configuration: { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
        origin: STAGING_ORIGIN, csrfSecret: env.OPERATIONS_SESSION_SECRET }, database: env.OPS_DB,
      publication: env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION!,
    });
    return standardWorker.fetch(request, env, ctx);
  },
  queue: standardWorker.queue,
  scheduled: standardWorker.scheduled,
};

export * from "./index";
export { OperationsPortalNativeDeliveryAuthorizationReader } from "./operations-portal-native-delivery-authorization-entrypoint";
