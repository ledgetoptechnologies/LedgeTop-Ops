import { PERMISSIONS, type Permission } from "@ltds/shared";
import { HTTPException } from "hono/http-exception";
import type { Env, GrantRow, ResourceContext, StaffPrincipal } from "./types";

export async function loadGrants(env: Env, staffId: string): Promise<GrantRow[]> {
  const result = await env.OPS_DB.withSession("first-primary").prepare(`
    SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id divisionId,'role' source
    FROM staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id WHERE a.staff_id=?
    UNION ALL
    SELECT rp.permission_key permission,'allow' effect,a.scope,a.division_id divisionId,'role' source
    FROM local_staff_role_assignments a JOIN role_permissions rp ON rp.role_id=a.role_id WHERE a.staff_id=?
    UNION ALL
    SELECT permission_key permission,effect,scope,division_id divisionId,'override' source
    FROM staff_permission_overrides WHERE staff_id=?
  `).bind(staffId, staffId, staffId).all<GrantRow>();
  return result.results;
}

export async function isAdministrator(env: Env, principal: StaffPrincipal): Promise<boolean> {
  return Boolean(await env.OPS_DB.withSession("first-primary").prepare("SELECT 1 ok FROM staff_role_assignments WHERE staff_id=? AND role_id IN ('role-owner','role-admin') AND scope='global' LIMIT 1").bind(principal.id).first());
}

function matches(grant: GrantRow, principal: StaffPrincipal, context?: ResourceContext): boolean {
  if (!context) return true;
  if (grant.scope === "global") return true;
  if (grant.scope === "division") return Boolean(context.divisionId && grant.divisionId === context.divisionId);
  if (grant.scope === "assigned") return Boolean(context.assignedStaffIds?.includes(principal.id));
  return context.ownerId === principal.id;
}

export function evaluatePermission(grants: GrantRow[], principal: StaffPrincipal, permission: Permission, context?: ResourceContext): boolean {
  const applicable = grants.filter(grant => grant.permission === permission && matches(grant, principal, context));
  if (applicable.some(grant => grant.source === "override" && grant.effect === "deny")) return false;
  return applicable.some(grant => grant.effect === "allow");
}

export async function requirePermission(env: Env, principal: StaffPrincipal, permission: Permission, context?: ResourceContext, notFound = false): Promise<void> {
  if (!(await hasPermission(env, principal, permission, context))) throw new HTTPException(notFound ? 404 : 403, { message: notFound ? "Resource not found" : `Missing permission: ${permission}` });
}

export async function hasPermission(env: Env, principal: StaffPrincipal, permission: Permission, context?: ResourceContext): Promise<boolean> {
  return evaluatePermission(await loadGrants(env, principal.id), principal, permission, context);
}

export async function permissionKeys(env: Env, principal: StaffPrincipal): Promise<Permission[]> {
  const grants = await loadGrants(env, principal.id);
  return PERMISSIONS.filter(permission => {
    const rows = grants.filter(grant => grant.permission === permission);
    if (rows.some(row => row.source === "override" && row.effect === "deny" && row.scope === "global")) return false;
    return rows.some(row => row.effect === "allow");
  });
}

export interface SqlScope {
  global: boolean;
  divisions: string[];
  assigned: boolean;
  own: boolean;
  deniedDivisions: string[];
  deniedGlobal: boolean;
}

export async function sqlScope(env: Env, principal: StaffPrincipal, permission: Permission): Promise<SqlScope> {
  const rows = (await loadGrants(env, principal.id)).filter(row => row.permission === permission);
  const deniedGlobal = rows.some(row => row.source === "override" && row.effect === "deny" && row.scope === "global");
  return {
    global: !deniedGlobal && rows.some(row => row.effect === "allow" && row.scope === "global"),
    divisions: [...new Set(rows.filter(row => row.effect === "allow" && row.scope === "division" && row.divisionId).map(row => row.divisionId!))],
    assigned: rows.some(row => row.effect === "allow" && row.scope === "assigned"),
    own: rows.some(row => row.effect === "allow" && row.scope === "own"),
    deniedDivisions: [...new Set(rows.filter(row => row.source === "override" && row.effect === "deny" && row.scope === "division" && row.divisionId).map(row => row.divisionId!))],
    deniedGlobal,
  };
}

export function buildScopedWhere(scope: SqlScope, principal: StaffPrincipal, alias: string, assignmentSql?: string): { sql: string; values: unknown[] } {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  const allowed: string[] = []; const values: unknown[] = [];
  if (scope.global) allowed.push("1=1");
  if (scope.divisions.length) { allowed.push(`${alias}.division_id IN (${scope.divisions.map(() => "?").join(",")})`); values.push(...scope.divisions); }
  if (scope.assigned && assignmentSql) { allowed.push(assignmentSql); values.push(principal.id); }
  if (scope.own) { allowed.push(`${alias}.created_by=?`); values.push(principal.id); }
  if (!allowed.length) return { sql: "0=1", values: [] };
  if (scope.deniedDivisions.length) { const placeholders = scope.deniedDivisions.map(() => "?").join(","); values.push(...scope.deniedDivisions); return { sql: `((${allowed.join(" OR ")}) AND ${alias}.division_id NOT IN (${placeholders}))`, values }; }
  return { sql: `(${allowed.join(" OR ")})`, values };
}
