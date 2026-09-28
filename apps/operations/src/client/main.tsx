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

const viewerShellRoute = parseOperationsViewerShellRoute(window.location.pathname);
const onboardingStaffRoute = window.location.pathname === "/administration/client-onboarding";
const recipientEnrollmentRoute = window.location.pathname === "/administration/client-portal/recipients";
createRoot(document.getElementById("root")!).render(<StrictMode>{recipientEnrollmentRoute
  ? <ClientPortalRecipientEnrollment />
  : onboardingStaffRoute
  ? <ClientOnboardingStaff />
  : viewerShellRoute
  ? <OperationsViewerShell route={viewerShellRoute} />
  : <OperationsApp />}</StrictMode>);
