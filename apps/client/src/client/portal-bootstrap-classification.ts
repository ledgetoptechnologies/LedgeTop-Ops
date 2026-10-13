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
