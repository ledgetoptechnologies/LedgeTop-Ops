import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import "./request-workflow.css";
import { OperationsApp } from "./OperationsApp";
import { OperationsViewerShell, parseOperationsViewerShellRoute } from "./OperationsViewerShell";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";

const viewerShellRoute = parseOperationsViewerShellRoute(window.location.pathname);
const onboardingStaffRoute = window.location.pathname === "/administration/client-onboarding";
createRoot(document.getElementById("root")!).render(<StrictMode>{onboardingStaffRoute
  ? <ClientOnboardingStaff />
  : viewerShellRoute
  ? <OperationsViewerShell route={viewerShellRoute} />
  : <OperationsApp />}</StrictMode>);
