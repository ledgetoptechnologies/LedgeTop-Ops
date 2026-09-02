import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import { parseClientPortalRoute } from "./portal-route";
import { consumeInvitationToken } from "./invitation-acceptance";
import { consumeDeliveryRoute, handoffLegacyPublicShare } from "./route";

const ClientPortalApp = lazy(async () => {
  const module = await import("./ClientPortalApp");
  return { default: module.ClientPortalApp };
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
  const portalRoute = parseClientPortalRoute(window.location.pathname);
  const isClientDelegatedShare = window.location.pathname.startsWith("/client-share/");
  const isInvitationAcceptance = window.location.pathname === "/portal/invitations/accept";
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
      <Suspense fallback={<main className="portal-loading-shell" aria-busy="true" aria-label="Loading LTDS Client Portal" />}>
        {isInvitationAcceptance
          ? <InvitationAcceptanceApp token={invitationToken} />
          : portalRoute.isPortal
          ? <ClientPortalApp initialPage={portalRoute.page} />
          : isClientDelegatedShare
            ? <DeliveryApp namespace="client-delegated" initialRoute={deliveryRoute ?? undefined} />
            : <DeliveryApp initialRoute={deliveryRoute ?? undefined} />}
      </Suspense>
    </StrictMode>,
  );
}
