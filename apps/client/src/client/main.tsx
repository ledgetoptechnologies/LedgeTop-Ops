import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import { parseClientPortalRoute } from "./portal-route";

const ClientPortalApp = lazy(async () => {
  const module = await import("./ClientPortalApp");
  return { default: module.ClientPortalApp };
});
const DeliveryApp = lazy(async () => {
  const module = await import("./DeliveryApp");
  return { default: module.DeliveryApp };
});
const ClientShareUnavailable = lazy(async () => {
  const module = await import("./ClientShareUnavailable");
  return { default: module.ClientShareUnavailable };
});

const portalRoute = parseClientPortalRoute(window.location.pathname);
// Every path in this namespace is isolated from DeliveryApp, including a
// malformed ID. The server decides whether an eventual delegated ID exists.
const isClientDelegatedShare = window.location.pathname.startsWith("/client-share/");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Suspense fallback={<main className="portal-loading-shell" aria-busy="true" aria-label="Loading LTDS Client Portal" />}>
      {portalRoute.isPortal
        ? <ClientPortalApp initialPage={portalRoute.page} />
        : isClientDelegatedShare
          ? <ClientShareUnavailable />
          : <DeliveryApp />}
    </Suspense>
  </StrictMode>,
);
