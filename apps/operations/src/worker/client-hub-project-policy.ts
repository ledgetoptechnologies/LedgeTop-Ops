import { hasLocalGlobalAllow, hasPermission, isAdministrator, sqlScope } from "./acl";
import { sha256 } from "./crypto";
import { paProjectFilter, type SqlFilter } from "./visibility";
import type { Env, StaffPrincipal } from "./types";

export interface ClientHubBusinessProjectPolicy { allowed: boolean; proof: string; filter: SqlFilter }

/** Same manager/assignment/all-work policy as the existing project API. A
 * directory permission is not a grant to read every business project. The proof
 * belongs in the shared detail context, so policy changes invalidate all panes. */
export async function readClientHubBusinessProjectPolicy(env: Env, principal: StaffPrincipal): Promise<ClientHubBusinessProjectPolicy> {
  const [allowed, scope, directory, administrator, explicitAll] = await Promise.all([
    hasPermission(env, principal, "projects.view"), sqlScope(env, principal, "projects.view"),
    sqlScope(env, principal, "team.view"), isAdministrator(env, principal),
    hasLocalGlobalAllow(env, principal, "operations.view_all"),
  ]);
  const permitted = allowed && directory.global && !directory.deniedGlobal && !scope.deniedGlobal;
  return {
    allowed: permitted,
    proof: await sha256(JSON.stringify([principal.id, principal.projectAlphaUserId ?? null, permitted, scope, directory, administrator, explicitAll])),
    filter: permitted ? paProjectFilter(administrator ? scope : { ...scope, divisions: [] }, principal, administrator,
      administrator || explicitAll) : { sql: "0=1", values: [] },
  };
}
