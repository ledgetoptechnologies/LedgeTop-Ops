import type { Env } from "./types";
import { handleOperationsPortalNativeBillingSourceAuthorityOwnerHttp } from "./operations-portal-native-billing-source-authority-owner-http";
import { reviewNativeBillingSourceAuthority,grantNativeBillingSourceAuthority,revokeNativeBillingSourceAuthority,
  readNativeBillingSourceAuthorityStatus } from "./operations-portal-native-billing-source-authority-issuer";
import { configuredDeploymentOrigin } from "@ltds/shared/configured-deployment-origin";
import { handleOperationsPortalNativeDeliveryAuthorityOwnerHttp } from "./operations-portal-native-delivery-authority-owner-http";
import type { OperationsPortalNativeDeliveryAuthorityDispatchEnv } from "./operations-portal-native-delivery-authority-dispatch";
import { handleOperationsPortalNativeBillingAuthorityOwnerHttp } from "./operations-portal-native-billing-authority-owner-http";
import { handleOperationsPortalNativeBillingPermissionOwnerHttp,
  OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE } from "./operations-portal-native-billing-permission-owner-http";
import { reviewOperationsPortalNativeBillingCandidate, grantOperationsPortalNativeBillingAuthority,
  revokeOperationsPortalNativeBillingAuthority, readOperationsPortalNativeBillingAuthorityStatus }
  from "./operations-portal-native-billing-authority-issuer";
import { handleOperationsPortalWorkspaceOwnerHttp } from "./operations-portal-workspace-owner-http";
import type { OperationsPortalWorkspacePublicationBinding } from "./operations-portal-workspace-publication-outbox";
import type { OperationsPortalNativeRecipientAuthorityBinding } from "./operations-portal-native-recipient-authority-dispatch";

const RECIPIENT_PAGE = "/administration/client-portal/operations-recipients";
const DELIVERY_API = "/api/native-client-portal/operations-delivery-authority";
const DELIVERY_PAGE = "/administration/client-portal/operations-delivery-authority";
const WORKSPACE_API = "/api/native-client-portal/operations-workspaces";
const WORKSPACE_PAGE = "/administration/client-portal/operations-workspaces";
const BILLING_API = "/api/native-client-portal/operations-billing-authority";
const BILLING_SOURCE_API = "/api/native-client-portal/operations-billing-source-authority";
const BILLING_PAGE = "/administration/client-portal/operations-billing-authority";
const BILLING_PERMISSION_PAGE = "/administration/client-portal/operations-billing-permissions";

export type OperationsPortalNativeOwnerEnv = Env & OperationsPortalNativeDeliveryAuthorityDispatchEnv & {
  CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED?: string;
  CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?: OperationsPortalNativeRecipientAuthorityBinding;
  OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_NATIVE_BILLING_PERMISSION_DIAGNOSTIC_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED?: string;
  OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?: OperationsPortalWorkspacePublicationBinding;
};

const family = (pathname: string, base: string) => pathname === base || pathname.startsWith(`${base}/`);
const notFound = () => Response.json({ error: "Not found" }, { status: 404 });

export function isOperationsPortalNativeOwnerPath(pathname: string): boolean {
  return pathname === RECIPIENT_PAGE
    || family(pathname, DELIVERY_API) || pathname === DELIVERY_PAGE
    || family(pathname, WORKSPACE_API) || pathname === WORKSPACE_PAGE
    || family(pathname, BILLING_API) || family(pathname,BILLING_SOURCE_API) || pathname === BILLING_PAGE
    || family(pathname, OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE) || pathname === BILLING_PERMISSION_PAGE;
}

/** Mounts only ordinary owner workflows. Staging fixtures and maintenance are intentionally absent. */
export async function dispatchOperationsPortalNativeOwnerRequest(request: Request,
  env: OperationsPortalNativeOwnerEnv): Promise<Response | null> {
  const pathname = new URL(request.url).pathname;
  const recipient = pathname === RECIPIENT_PAGE;
  const delivery = family(pathname, DELIVERY_API) || pathname === DELIVERY_PAGE;
  const workspace = family(pathname, WORKSPACE_API) || pathname === WORKSPACE_PAGE;
  const billing = family(pathname, BILLING_API) || pathname === BILLING_PAGE;
  const billingSource = family(pathname,BILLING_SOURCE_API);
  const billingPermission = family(pathname, OPERATIONS_NATIVE_BILLING_PERMISSION_OWNER_BASE)
    || pathname === BILLING_PERMISSION_PAGE;
  if (!recipient && !delivery && !workspace && !billing && !billingPermission && !billingSource) return null;

  const origin = configuredDeploymentOrigin({ environment: env.ENVIRONMENT,
    origin: env.PUBLIC_BASE_URL, expectedHost: env.EXPECTED_HOST });
  if (!origin || new URL(request.url).origin !== origin) return notFound();
  const configuration = { enabled: true, issuer: env.TEAM_DOMAIN ?? "", staffAudience: env.OPERATIONS_AUD,
    origin, csrfSecret: env.OPERATIONS_SESSION_SECRET };

  if (recipient) {
    if (env.CLIENT_PORTAL_NATIVE_RECIPIENT_ENROLLMENT_ENABLED !== "true"
      || env.CLIENT_PORTAL_NATIVE_RECIPIENT_OWNER_ENABLED !== "true"
      || env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY_DISPATCH_ENABLED !== "true"
      || typeof env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?.applyNativeAuthority !== "function"
      || typeof env.OPERATIONS_PORTAL_NATIVE_RECIPIENT_AUTHORITY?.getNativeAuthorityStatus !== "function") return notFound();
    return env.ASSETS.fetch(request);
  }

  if (delivery) {
    if (env.OPERATIONS_PORTAL_NATIVE_DELIVERY_OWNER_ENABLED !== "true") return notFound();
    if (pathname === DELIVERY_PAGE) return env.ASSETS.fetch(request);
    return handleOperationsPortalNativeDeliveryAuthorityOwnerHttp(request, { environment: env.ENVIRONMENT,
      expectedHost: env.EXPECTED_HOST, configuration, database: env.OPS_DB, dispatch: env });
  }
  if (workspace) {
    if (env.OPERATIONS_PORTAL_WORKSPACE_OWNER_ENABLED !== "true"
      || env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION_DISPATCH_ENABLED !== "true"
      || typeof env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?.publishWorkspace !== "function"
      || typeof env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION?.getPublicationStatus !== "function") return notFound();
    if (pathname === WORKSPACE_PAGE) return env.ASSETS.fetch(request);
    return handleOperationsPortalWorkspaceOwnerHttp(request, { environment: env.ENVIRONMENT,
      expectedHost: env.EXPECTED_HOST, configuration, database: env.OPS_DB,
      publication: env.OPERATIONS_PORTAL_WORKSPACE_PUBLICATION,folderAuthority:env });
  }
  if (env.OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED !== "true") return notFound();
  if(billingSource)return handleOperationsPortalNativeBillingSourceAuthorityOwnerHttp(request,{
    environment:env.ENVIRONMENT,expectedHost:env.EXPECTED_HOST,lifecycleFlag:env.OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED,
    configuration,database:env.OPS_DB,core:{review:(_db,a,i)=>reviewNativeBillingSourceAuthority(env,a,i),
      grant:(_db,a,i)=>grantNativeBillingSourceAuthority(env,a,i),revoke:(_db,a,i)=>revokeNativeBillingSourceAuthority(env,a,i),
      readStatus:(_db,a,id)=>readNativeBillingSourceAuthorityStatus(env,a,id)}});
  if (pathname === BILLING_PAGE || pathname === BILLING_PERMISSION_PAGE) return env.ASSETS.fetch(request);
  if (billingPermission) return handleOperationsPortalNativeBillingPermissionOwnerHttp(request, {
    environment: env.ENVIRONMENT, expectedHost: env.EXPECTED_HOST,
    delegationFlag: env.OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED,
    diagnosticFlag: env.OPERATIONS_PORTAL_NATIVE_BILLING_PERMISSION_DIAGNOSTIC_ENABLED,
    configuration, database: env.OPS_DB,
  });
  return handleOperationsPortalNativeBillingAuthorityOwnerHttp(request, { environment: env.ENVIRONMENT,
    expectedHost: env.EXPECTED_HOST, lifecycleFlag: env.OPERATIONS_PORTAL_NATIVE_BILLING_OWNER_ENABLED,
    configuration, database: env.OPS_DB, core: { review: reviewOperationsPortalNativeBillingCandidate,
      grant: grantOperationsPortalNativeBillingAuthority, revoke: revokeOperationsPortalNativeBillingAuthority,
      readStatus: readOperationsPortalNativeBillingAuthorityStatus } });
}
