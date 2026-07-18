import type { Permission } from "@ltds/shared";
import type { SqlScope } from "./acl";
import type { StaffPrincipal } from "./types";

export type PaResourceKind = "operation" | "task" | "calendar";
export interface SqlFilter { sql: string; values: unknown[] }

const EMPLOYEE_PERMISSIONS = new Set<Permission>([
  "dashboard.view",
  "operations.view",
  "projects.view",
  "tasks.view",
  "airspace.view",
]);

function placeholders(values: unknown[]): string { return values.map(() => "?").join(","); }

export function employeePermissions(permissions: Permission[], administrator: boolean): Permission[] {
  return administrator ? permissions : permissions.filter(permission => EMPLOYEE_PERMISSIONS.has(permission));
}

export function paResourceFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, alias: string, kind: PaResourceKind): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  if (administrator) return { sql: `${alias}.active=1`, values: [] };
  const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
  if (!principal.projectAlphaUserId || !divisions.length) return { sql: "0=1", values: [] };

  const resourceBusinessUnit = kind === "task"
    ? `COALESCE(${alias}.business_unit_id,(SELECT visible_parent.business_unit_id FROM pa_operations visible_parent WHERE visible_parent.id=${alias}.operation_id AND visible_parent.active=1))`
    : `${alias}.business_unit_id`;
  const businessUnit = `EXISTS (SELECT 1 FROM divisions visible_division WHERE visible_division.project_alpha_business_unit_id=${resourceBusinessUnit} AND visible_division.id IN (${placeholders(divisions)}))`;
  let assignment: string;
  const values: unknown[] = [...divisions];
  if (kind === "operation") {
    assignment = `EXISTS (SELECT 1 FROM pa_operation_assignments visible_assignment WHERE visible_assignment.operation_id=${alias}.id AND visible_assignment.user_id=? AND visible_assignment.active=1)`;
    values.push(principal.projectAlphaUserId);
  } else if (kind === "task") {
    assignment = `${alias}.assignee_user_id=?`;
    values.push(principal.projectAlphaUserId);
  } else {
    assignment = `EXISTS (SELECT 1 FROM pa_project_assignments visible_assignment WHERE visible_assignment.project_id=${alias}.project_id AND visible_assignment.user_id=? AND visible_assignment.active=1)`;
    values.push(principal.projectAlphaUserId);
  }
  return { sql: `${alias}.active=1 AND ${businessUnit} AND ${assignment}`, values };
}

export function paProjectFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  if (administrator) return { sql: "p.active=1", values: [] };
  const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
  if (!principal.projectAlphaUserId || !divisions.length) return { sql: "0=1", values: [] };
  const divisionSlots = placeholders(divisions);
  return {
    sql: `p.active=1 AND (EXISTS (SELECT 1 FROM pa_project_assignments visible_project WHERE visible_project.project_id=p.id AND visible_project.user_id=? AND visible_project.active=1) OR EXISTS (SELECT 1 FROM pa_operations visible_operation JOIN pa_operation_assignments visible_operation_assignment ON visible_operation_assignment.operation_id=visible_operation.id AND visible_operation_assignment.user_id=? AND visible_operation_assignment.active=1 JOIN divisions visible_division ON visible_division.project_alpha_business_unit_id=visible_operation.business_unit_id WHERE visible_operation.project_id=p.id AND visible_operation.active=1 AND visible_division.id IN (${divisionSlots})) OR EXISTS (SELECT 1 FROM pa_tasks visible_task LEFT JOIN pa_operations visible_parent ON visible_parent.id=visible_task.operation_id AND visible_parent.active=1 JOIN divisions visible_division ON visible_division.project_alpha_business_unit_id=COALESCE(visible_task.business_unit_id,visible_parent.business_unit_id) WHERE visible_task.project_id=p.id AND visible_task.assignee_user_id=? AND visible_task.active=1 AND visible_division.id IN (${divisionSlots})))`,
    values: [principal.projectAlphaUserId, principal.projectAlphaUserId, ...divisions, principal.projectAlphaUserId, ...divisions],
  };
}

export function paCalendarFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, alias = "e"): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  if (administrator) return { sql: `${alias}.active=1`, values: [] };
  const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
  if (!principal.projectAlphaUserId || !divisions.length) return { sql: "0=1", values: [] };
  const slots = placeholders(divisions);
  return {
    sql: `${alias}.active=1 AND ((${alias}.source_type='operation' AND EXISTS (SELECT 1 FROM pa_operations visible_operation JOIN pa_operation_assignments visible_assignment ON visible_assignment.operation_id=visible_operation.id AND visible_assignment.user_id=? AND visible_assignment.active=1 JOIN divisions visible_division ON visible_division.project_alpha_business_unit_id=visible_operation.business_unit_id WHERE visible_operation.id=${alias}.source_id AND visible_operation.active=1 AND visible_division.id IN (${slots}))) OR (${alias}.source_type='task' AND EXISTS (SELECT 1 FROM pa_tasks visible_task LEFT JOIN pa_operations visible_parent ON visible_parent.id=visible_task.operation_id AND visible_parent.active=1 JOIN divisions visible_division ON visible_division.project_alpha_business_unit_id=COALESCE(visible_task.business_unit_id,visible_parent.business_unit_id) WHERE visible_task.id=${alias}.source_id AND visible_task.assignee_user_id=? AND visible_task.active=1 AND visible_division.id IN (${slots}))))`,
    values: [principal.projectAlphaUserId, ...divisions, principal.projectAlphaUserId, ...divisions],
  };
}
