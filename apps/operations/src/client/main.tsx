import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppDialogHost } from "@ltds/ui";
import "@ltds/ui/styles.css";
import "mapbox-gl/dist/mapbox-gl.css";
import "./styles.css";
import "./request-workflow.css";
import { OperationsApp } from "./OperationsApp";
import { ClientOnboardingStaff } from "./ClientOnboardingStaff";
import { ClientPortalRecipientEnrollment } from "./ClientPortalRecipientEnrollment";
import { OperationsNativeRecipientEnrollment } from "./OperationsNativeRecipientEnrollment";
import { OperationsNativeDeliveryAuthority } from "./OperationsNativeDeliveryAuthority";
import { OperationsNativeBillingAuthority } from "./OperationsNativeBillingAuthority";
import { OperationsNativeBillingPermissions } from "./OperationsNativeBillingPermissions";
import { OperationsDirectoryMaintenance } from "./OperationsDirectoryMaintenance";
import { OperationsPortalWorkspaceOwner } from "./OperationsPortalWorkspaceOwner";
import { DirectoryReplayAcceptance } from "./DirectoryReplayAcceptance";
import { isDirectoryReplayAcceptanceLocation } from "./DirectoryReplayAcceptanceRoute";
import { ProjectReplayAcceptance } from "./ProjectReplayAcceptance";
import { isProjectReplayAcceptanceLocation } from "./ProjectReplayAcceptanceRoute";
import { LinkLoginPage } from "./LinkLoginPage";
import { LINK_LOGIN_PATH } from "./login-links-api";

const onboardingStaffRoute = window.location.pathname === "/administration/client-onboarding";
const recipientEnrollmentRoute = window.location.pathname === "/administration/client-portal/recipients";
const operationsRecipientEnrollmentRoute = window.location.pathname === "/administration/client-portal/operations-recipients";
const operationsDeliveryAuthorityRoute = window.location.pathname === "/administration/client-portal/operations-delivery-authority";
const operationsBillingAuthorityRoute = window.location.pathname === "/administration/client-portal/operations-billing-authority";
const operationsBillingPermissionsRoute = window.location.pathname === "/administration/client-portal/operations-billing-permissions";
const directoryMaintenanceRoute = window.location.protocol === "https:"
  && window.location.hostname === "ops-staging.ledgetopdroneservices.com" && window.location.port === ""
  && window.location.pathname === "/administration/staging/directory-maintenance-authority";
const operationsWorkspaceRoute = window.location.pathname === "/administration/client-portal/operations-workspaces";
const directoryReplayAcceptanceRoute = isDirectoryReplayAcceptanceLocation(window.location);
const projectReplayAcceptanceRoute = isProjectReplayAcceptanceLocation(window.location);
// Confirming a linked sign-in email happens before Operations starts: the email being added has no session yet.
const linkLoginRoute = window.location.pathname === LINK_LOGIN_PATH;
createRoot(document.getElementById("root")!).render(<StrictMode>{linkLoginRoute
  ? <LinkLoginPage />
  : projectReplayAcceptanceRoute
  ? <ProjectReplayAcceptance />
  : directoryReplayAcceptanceRoute
  ? <DirectoryReplayAcceptance />
  : operationsWorkspaceRoute
  ? <OperationsPortalWorkspaceOwner />
  : operationsDeliveryAuthorityRoute
  ? <OperationsNativeDeliveryAuthority />
  : operationsBillingAuthorityRoute
  ? <OperationsNativeBillingAuthority />
  : operationsBillingPermissionsRoute
  ? <OperationsNativeBillingPermissions />
  : directoryMaintenanceRoute
  ? <OperationsDirectoryMaintenance />
  : operationsRecipientEnrollmentRoute
  ? <OperationsNativeRecipientEnrollment />
  : recipientEnrollmentRoute
  ? <ClientPortalRecipientEnrollment />
  : onboardingStaffRoute
  ? <ClientOnboardingStaff />
  : <OperationsApp />}<AppDialogHost /></StrictMode>);
