import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import { parseClientPortalRoute } from "./portal-route";
import { consumeInvitationToken } from "./invitation-acceptance";
import { consumeDeliveryRoute, handoffLegacyPublicShare } from "./route";
import { ClientViewerShell, parseClientViewerShellRoute } from "./ClientViewerShell";
import { ClientOnboardingRecipientApp } from "./ClientOnboardingRecipientApp";
import { consumeClientOnboardingRecipientRoute } from "./client-onboarding-recipient-route";
import { ClientPortalRecipientEnrollmentApp } from "./ClientPortalRecipientEnrollmentApp";
import { consumeClientPortalRecipientEnrollmentRoute, consumeOperationsNativeRecipientEnrollmentRoute } from "./client-portal-recipient-enrollment-route";

const ClientPortalApp = lazy(async () => {
  const module = await import("./ClientPortalApp");
  return { default: module.ClientPortalApp };
});
const PortalBootstrapApp = lazy(async () => {
  const module = await import("./PortalBootstrapApp");
  return { default: module.PortalBootstrapApp };
});
const DeliveryApp = lazy(async () => {
  const module = await import("./DeliveryApp");
  return { default: module.DeliveryApp };
});
const InvitationAcceptanceApp = lazy(async () => {
  const module = await import("./InvitationAcceptanceApp");
  return { default: module.InvitationAcceptanceApp };
});
if (!handoffLegacyPublicShare(window.location, url => window.location.replace(url))) {
  const nativeRecipientEnrollmentRoute = consumeOperationsNativeRecipientEnrollmentRoute(window.location, window.history);
  const recipientEnrollmentRoute = consumeClientPortalRecipientEnrollmentRoute(window.location, window.history);
  const portalRoute = parseClientPortalRoute(window.location.pathname);
  const isPortalRoot = window.location.pathname === "/portal" || window.location.pathname === "/portal/";
  const viewerShellRoute = parseClientViewerShellRoute(window.location.pathname);
  const isClientDelegatedShare = window.location.pathname.startsWith("/client-share/");
  const isInvitationAcceptance = window.location.pathname === "/portal/invitations/accept";
  const onboardingRoute = consumeClientOnboardingRecipientRoute(window.location, window.history);
  const invitationToken = isInvitationAcceptance
    ? consumeInvitationToken(window.location, window.history)
    : null;
  const deliveryRoute = !portalRoute.isPortal && !isInvitationAcceptance
    ? consumeDeliveryRoute(
        window.location,
        window.history,
        isClientDelegatedShare ? "client-delegated" : "staff",
      )
    : null;

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <Suspense fallback={<main className="portal-loading-shell" aria-busy="true" aria-label="Loading Ledge Top client portal" />}>
        {nativeRecipientEnrollmentRoute
          ? <ClientPortalRecipientEnrollmentApp {...nativeRecipientEnrollmentRoute} protocol="operations-native" />
          : recipientEnrollmentRoute
          ? <ClientPortalRecipientEnrollmentApp {...recipientEnrollmentRoute} />
          : onboardingRoute
          ? <ClientOnboardingRecipientApp {...onboardingRoute} />
          : viewerShellRoute
          ? <ClientViewerShell route={viewerShellRoute} />
          : isInvitationAcceptance
          ? <InvitationAcceptanceApp token={invitationToken} />
          : isPortalRoot
          ? <PortalBootstrapApp />
          : portalRoute.isPortal
          ? <ClientPortalApp initialPage={portalRoute.page} />
          : isClientDelegatedShare
            ? <DeliveryApp namespace="client-delegated" initialRoute={deliveryRoute ?? undefined} />
            : <DeliveryApp initialRoute={deliveryRoute ?? undefined} />}
      </Suspense>
    </StrictMode>,
  );
}
