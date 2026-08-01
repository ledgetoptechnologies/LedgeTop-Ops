import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import { ClientPortalApp } from "./ClientPortalApp";
import { DeliveryApp } from "./DeliveryApp";
import { parseClientPortalRoute } from "./portal-route";

const portalRoute = parseClientPortalRoute(window.location.pathname);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {portalRoute.isPortal ? <ClientPortalApp initialPage={portalRoute.page} /> : <DeliveryApp />}
  </StrictMode>,
);
