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
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };

  const resourceBusinessUnit = kind === "task"
    ? `COALESCE(${alias}.business_unit_id,(SELECT visible_parent.business_unit_id FROM pa_operations visible_parent WHERE visible_parent.id=${alias}.operation_id AND visible_parent.active=1))`
    : `${alias}.business_unit_id`;
  const oversight = divisions.length ? `EXISTS (SELECT 1 FROM divisions visible_division WHERE visible_division.project_alpha_business_unit_id=${resourceBusinessUnit} AND visible_division.id IN (${placeholders(divisions)}))` : '0=1';
  let assignment: string;
  const values: unknown[] = [];
  if (kind === "operation") {
    assignment = `EXISTS (SELECT 1 FROM pa_operation_assignments visible_assignment WHERE visible_assignment.operation_id=${alias}.id AND visible_assignment.user_id=? AND visible_assignment.active=1)`;
    values.push(principal.projectAlphaUserId);
  } else if (kind === "task") {
    assignment = `EXISTS (SELECT 1 FROM pa_task_assignments visible_assignment WHERE visible_assignment.task_id=${alias}.id AND visible_assignment.user_id=? AND visible_assignment.active=1)`;
    values.push(principal.projectAlphaUserId);
  } else {
    assignment = `EXISTS (SELECT 1 FROM pa_project_assignments visible_assignment WHERE visible_assignment.project_id=${alias}.project_id AND visible_assignment.user_id=? AND visible_assignment.active=1)`;
    values.push(principal.projectAlphaUserId);
  }
  values.push(...divisions);
  return { sql: `${alias}.active=1 AND (${assignment} OR ${oversight})`, values };
}

export function paProjectFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  if (administrator) return { sql: "p.active=1", values: [] };
  const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };
  const oversight = divisions.length ? `EXISTS (SELECT 1 FROM divisions visible_division WHERE visible_division.project_alpha_business_unit_id=p.business_unit_id AND visible_division.id IN (${placeholders(divisions)}))` : '0=1';
  return {
    sql: `p.active=1 AND (EXISTS (SELECT 1 FROM pa_project_assignments visible_project WHERE visible_project.project_id=p.id AND visible_project.user_id=? AND visible_project.active=1) OR EXISTS (SELECT 1 FROM pa_operations visible_operation JOIN pa_operation_assignments visible_operation_assignment ON visible_operation_assignment.operation_id=visible_operation.id AND visible_operation_assignment.user_id=? AND visible_operation_assignment.active=1 WHERE visible_operation.project_id=p.id AND visible_operation.active=1) OR EXISTS (SELECT 1 FROM pa_tasks visible_task JOIN pa_task_assignments visible_task_assignment ON visible_task_assignment.task_id=visible_task.id AND visible_task_assignment.user_id=? AND visible_task_assignment.active=1 WHERE visible_task.project_id=p.id AND visible_task.active=1) OR ${oversight})`,
    values: [principal.projectAlphaUserId, principal.projectAlphaUserId, principal.projectAlphaUserId, ...divisions],
  };
}

export function paCalendarFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, alias = "e"): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  if (administrator) return { sql: `${alias}.active=1`, values: [] };
  const divisions = scope.divisions.filter(id => !scope.deniedDivisions.includes(id));
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };
  const oversight = divisions.length ? `EXISTS (SELECT 1 FROM divisions visible_division WHERE visible_division.project_alpha_business_unit_id=${alias}.business_unit_id AND visible_division.id IN (${placeholders(divisions)}))` : '0=1';
  return {
    sql: `${alias}.active=1 AND (((${alias}.source_type='operation') AND EXISTS (SELECT 1 FROM pa_operation_assignments visible_assignment WHERE visible_assignment.operation_id=${alias}.source_id AND visible_assignment.user_id=? AND visible_assignment.active=1)) OR ((${alias}.source_type='task') AND EXISTS (SELECT 1 FROM pa_task_assignments visible_assignment WHERE visible_assignment.task_id=${alias}.source_id AND visible_assignment.user_id=? AND visible_assignment.active=1)) OR ${oversight})`,
    values: [principal.projectAlphaUserId, principal.projectAlphaUserId, ...divisions],
  };
}
