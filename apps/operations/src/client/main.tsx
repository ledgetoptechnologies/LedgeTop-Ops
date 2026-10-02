import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import "./request-workflow.css";
import { OperationsApp } from "./OperationsApp";
import { OperationsViewerShell, parseOperationsViewerShellRoute } from "./OperationsViewerShell";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";
import { ClientPortalRecipientEnrollment } from "./ClientPortalRecipientEnrollment";
import { OperationsNativeRecipientEnrollment } from "./OperationsNativeRecipientEnrollment";
import { OperationsNativeDeliveryAuthority } from "./OperationsNativeDeliveryAuthority";

const nativeOwnerHost = window.location.protocol === "https:"
  && window.location.hostname === "ops-staging.ledgetopdroneservices.com"
  && window.location.port === "";
const viewerShellRoute = parseOperationsViewerShellRoute(window.location.pathname);
const onboardingStaffRoute = window.location.pathname === "/administration/client-onboarding";
const recipientEnrollmentRoute = window.location.pathname === "/administration/client-portal/recipients";
const operationsRecipientEnrollmentRoute = nativeOwnerHost
  && window.location.pathname === "/administration/client-portal/operations-recipients";
const operationsDeliveryAuthorityRoute = nativeOwnerHost
  && window.location.pathname === "/administration/client-portal/operations-delivery-authority";
createRoot(document.getElementById("root")!).render(<StrictMode>{operationsDeliveryAuthorityRoute
  ? <OperationsNativeDeliveryAuthority />
  : operationsRecipientEnrollmentRoute
  ? <OperationsNativeRecipientEnrollment />
  : recipientEnrollmentRoute
  ? <ClientPortalRecipientEnrollment />
  : onboardingStaffRoute
  ? <ClientOnboardingStaff />
  : viewerShellRoute
  ? <OperationsViewerShell route={viewerShellRoute} />
  : <OperationsApp />}</StrictMode>);
