import type { Permission } from "@ltds/shared";
import type { SqlScope } from "./acl";
import type { StaffPrincipal } from "./types";
import { projectAlphaReadVisibleSql } from "./project-alpha-read-visibility";

export type PaResourceKind = "operation" | "task" | "calendar";
export interface SqlFilter { sql: string; values: unknown[] }

const EMPLOYEE_PERMISSIONS = new Set<Permission>([
  "dashboard.view",
  "operations.view",
  "projects.view",
  "tasks.view",
  "sops.view",
  "sops.assign",
  "airspace.view",
  "file_requests.view",
  "file_requests.create",
  "file_requests.manage",
  "delivery.browse",
  "delivery.share.create",
  "delivery.share.revoke",
  "delivery.share.audit",
  "team.view",
  "administration.view",
]);

export function employeePermissions(permissions: Permission[], administrator: boolean): Permission[] {
  return administrator ? permissions : permissions.filter(permission => EMPLOYEE_PERMISSIONS.has(permission));
}

export function paResourceFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, alias: string, kind: PaResourceKind, explicitAllOperations = false): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  const visible = `${alias}.active=1 AND ${projectAlphaReadVisibleSql(`${alias}.projection_source_id`)}`;
  if (administrator) return { sql: visible, values: [] };
  if (explicitAllOperations && scope.global) return { sql: visible, values: [] };
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };
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
  // Primary staff identity does not grant authority in another business source.
  return { sql: `${visible} AND ${alias}.projection_source_id='project-alpha:primary' AND ${assignment}`, values };
}

export function paProjectFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, explicitAllOperations = false): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  const visible = `p.active=1 AND ${projectAlphaReadVisibleSql("p.projection_source_id")}`;
  if (administrator) return { sql: visible, values: [] };
  if (explicitAllOperations && scope.global) return { sql: visible, values: [] };
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };
  return {
    sql: `${visible} AND p.projection_source_id='project-alpha:primary' AND (p.manager_user_id=? OR EXISTS (SELECT 1 FROM pa_project_assignments visible_project WHERE visible_project.project_id=p.id AND visible_project.user_id=? AND visible_project.active=1) OR EXISTS (SELECT 1 FROM pa_operations visible_operation JOIN pa_operation_assignments visible_operation_assignment ON visible_operation_assignment.operation_id=visible_operation.id AND visible_operation_assignment.user_id=? AND visible_operation_assignment.active=1 WHERE visible_operation.project_id=p.id AND visible_operation.active=1) OR EXISTS (SELECT 1 FROM pa_tasks visible_task JOIN pa_task_assignments visible_task_assignment ON visible_task_assignment.task_id=visible_task.id AND visible_task_assignment.user_id=? AND visible_task_assignment.active=1 WHERE visible_task.project_id=p.id AND visible_task.active=1))`,
    values: [principal.projectAlphaUserId, principal.projectAlphaUserId, principal.projectAlphaUserId, principal.projectAlphaUserId],
  };
}

export function paCalendarFilter(scope: SqlScope, principal: StaffPrincipal, administrator: boolean, alias = "e", explicitAllOperations = false): SqlFilter {
  if (scope.deniedGlobal) return { sql: "0=1", values: [] };
  const visible = `${alias}.active=1 AND ${projectAlphaReadVisibleSql(`${alias}.projection_source_id`)}`;
  if (administrator) return { sql: visible, values: [] };
  if (explicitAllOperations && scope.global) return { sql: visible, values: [] };
  if (!principal.projectAlphaUserId) return { sql: "0=1", values: [] };
  return {
    sql: `${visible} AND ${alias}.projection_source_id='project-alpha:primary' AND (((${alias}.source_type='operation') AND EXISTS (SELECT 1 FROM pa_operation_assignments visible_assignment WHERE visible_assignment.operation_id=${alias}.source_id AND visible_assignment.user_id=? AND visible_assignment.active=1)) OR ((${alias}.source_type='task') AND EXISTS (SELECT 1 FROM pa_task_assignments visible_assignment WHERE visible_assignment.task_id=${alias}.source_id AND visible_assignment.user_id=? AND visible_assignment.active=1)))`,
    values: [principal.projectAlphaUserId, principal.projectAlphaUserId],
  };
}
