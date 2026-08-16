import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  evaluatePermission,
  hasLocalGlobalAllow,
  loadGrants,
  requirePermission,
  sqlScope,
} from "./acl";
import type { Env, StaffPrincipal } from "./types";
import { paResourceFilter } from "./visibility";

type AppEnv = {
  Bindings: Env;
  Variables: { principal: StaffPrincipal; administrator: boolean };
};
type App = Hono<AppEnv>;

interface TargetStaffRow {
  id: string;
  display_name: string;
  project_alpha_user_id: string | null;
}

interface AssignedOperationRow {
  id: string;
  title: string;
  status: string;
  scheduled_start_at: string | null;
  project_name: string | null;
  division_id: string | null;
  assigned_staff_ids: string | null;
  brief_available: number;
  sop_count: number;
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(",");
}

async function visibleTargetStaff(
  env: Env,
  principal: StaffPrincipal,
  targetId: string,
): Promise<TargetStaffRow> {
  await requirePermission(env, principal, "team.view");
  const scope = await sqlScope(env, principal, "team.view");
  const conditions = ["s.id=?"];
  const values: unknown[] = [targetId];
  if (!scope.global) {
    const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
    if (!divisions.length)
      throw new HTTPException(404, { message: "Staff member not found" });
    conditions.push(`EXISTS (
      SELECT 1 FROM staff_divisions visible_division
      WHERE visible_division.staff_id=s.id
        AND visible_division.division_id IN (${placeholders(divisions)})
    )`);
    values.push(...divisions);
  }
  if (scope.deniedDivisions.length) {
    conditions.push(`NOT EXISTS (
      SELECT 1 FROM staff_divisions denied_division
      WHERE denied_division.staff_id=s.id
        AND denied_division.division_id IN (${placeholders(scope.deniedDivisions)})
    )`);
    values.push(...scope.deniedDivisions);
  }
  const target = await env.OPS_DB.withSession("first-primary").prepare(
    `SELECT s.id,s.display_name,s.project_alpha_user_id
     FROM staff_users s WHERE ${conditions.join(" AND ")} LIMIT 1`,
  ).bind(...values).first<TargetStaffRow>();
  if (!target) throw new HTTPException(404, { message: "Staff member not found" });
  return target;
}

async function assignedOperations(
  env: Env,
  principal: StaffPrincipal,
  administrator: boolean,
  target: TargetStaffRow,
) {
  await requirePermission(env, principal, "operations.view");
  if (!target.project_alpha_user_id) return [];
  const [scope, explicitAll, grants] = await Promise.all([
    sqlScope(env, principal, "operations.view"),
    hasLocalGlobalAllow(env, principal, "operations.view_all"),
    loadGrants(env, principal.id),
  ]);
  const filter = paResourceFilter(
    scope,
    principal,
    administrator,
    "o",
    "operation",
    explicitAll,
  );
  const rows = await env.OPS_DB.withSession("first-primary").prepare(
    `SELECT o.id,o.title,o.status,o.scheduled_start_at,p.name project_name,d.id division_id,
       (SELECT GROUP_CONCAT(staff.id) FROM pa_operation_assignments current_assignment
        JOIN staff_users staff ON staff.project_alpha_user_id=current_assignment.user_id
        WHERE current_assignment.operation_id=o.id AND current_assignment.active=1) assigned_staff_ids,
       CASE WHEN brief.operation_id IS NULL THEN 0 ELSE 1 END brief_available,
       COUNT(DISTINCT links.revision_id) sop_count
     FROM pa_operations o
     JOIN pa_operation_assignments target_assignment
       ON target_assignment.operation_id=o.id AND target_assignment.user_id=?
         AND target_assignment.active=1
     LEFT JOIN pa_projects p ON p.id=o.project_id
     LEFT JOIN divisions d ON d.project_alpha_business_unit_id=o.business_unit_id
     LEFT JOIN operational_job_briefs brief ON brief.operation_id=o.id
     LEFT JOIN operational_job_brief_sop_links links ON links.operation_id=o.id
     WHERE ${filter.sql}
     GROUP BY o.id,o.title,o.status,o.scheduled_start_at,p.name,d.id,brief.operation_id
     ORDER BY COALESCE(o.scheduled_start_at,o.updated_at) DESC,o.id
     LIMIT 100`,
  ).bind(target.project_alpha_user_id, ...filter.values).all<AssignedOperationRow>();
  return rows.results.map(row => {
    const canViewSops = evaluatePermission(grants, principal, "sops.view", {
      divisionId: row.division_id,
      assignedStaffIds: row.assigned_staff_ids?.split(",").filter(Boolean) || [],
    });
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      scheduledStart: row.scheduled_start_at,
      projectName: row.project_name,
      briefAvailable: Boolean(row.brief_available),
      canViewSops,
      sopCount: canViewSops ? row.sop_count : 0,
    };
  });
}

export function registerTeamAssignedWorkRoutes(app: App): void {
  app.get("/api/team/staff/:id/assigned-work", async c => {
    const targetId = c.req.param("id");
    if (!targetId || targetId.length > 128)
      throw new HTTPException(404, { message: "Staff member not found" });
    const principal = c.get("principal");
    const target = await visibleTargetStaff(c.env, principal, targetId);
    const operations = await assignedOperations(
      c.env,
      principal,
      c.get("administrator"),
      target,
    );
    return c.json({
      staff: { id: target.id, displayName: target.display_name },
      operations,
      truncated: operations.length === 100,
    });
  });
}
