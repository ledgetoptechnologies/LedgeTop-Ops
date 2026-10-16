import type { RequestError } from "./bulk-download";

/**
 * An independently authorized Operations home does not require a Client
 * workspace membership. Treat only the exact unscoped Client admission denial
 * as an absent optional surface; explicit workspace failures and every other
 * error still need to remain visible.
 */
export function isOptionalClientWorkspaceBootstrapAbsence(
  caught: unknown,
  requestedWorkspaceId: string | null,
): boolean {
  if (requestedWorkspaceId !== null) return false;
  const error = caught as RequestError;
  return error.status === 403 && error.body?.error === "Client access is not provisioned";
}

export const NO_AUTHORIZED_CLIENT_WORKSPACE = "no_authorized_client_workspace";

/** A verified identity whose workspace list is empty: an access-setup state,
 * not a service outage. Only the exact client-side code qualifies, so
 * transport and server failures keep their own classification. */
export function isNoAuthorizedClientWorkspace(caught: unknown): boolean {
  const error = caught as RequestError;
  return error?.status === 403 && error.body?.code === NO_AUTHORIZED_CLIENT_WORKSPACE;
}
