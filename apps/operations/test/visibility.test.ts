import { describe, expect, it } from "vitest";
import type { Permission } from "@ltds/shared";
import type { SqlScope } from "../src/worker/acl";
import type { StaffPrincipal } from "../src/worker/types";
import { employeePermissions, paCalendarFilter, paProjectFilter, paResourceFilter } from "../src/worker/visibility";

const employee: StaffPrincipal = { id: "staff-7", email: "pilot@example.com", displayName: "Pilot", accessSubject: "sub-7", projectAlphaUserId: "7" };
const scope: SqlScope = { global: false, divisions: ["division-30"], assigned: false, own: false, deniedDivisions: [], deniedGlobal: false };

describe("operations visibility", () => {
  it("limits the employee session to read-only operational permissions", () => {
    const permissions: Permission[] = ["dashboard.view", "operations.view", "tasks.create", "delivery.browse", "team.view"];
    expect(employeePermissions(permissions, false)).toEqual(["dashboard.view", "operations.view"]);
    expect(employeePermissions(permissions, true)).toEqual(permissions);
  });

  it("allows direct operation assignment or manual business-unit oversight", () => {
    const filter = paResourceFilter(scope, employee, false, "o", "operation");
    expect(filter.sql).toContain("visible_division.project_alpha_business_unit_id=o.business_unit_id");
    expect(filter.sql).toContain("visible_assignment.operation_id=o.id");
    expect(filter.sql).toContain(" OR ");
    expect(filter.values).toEqual(["7", "division-30"]);
  });

  it("uses multi-worker task assignment or business-unit oversight", () => {
    const filter = paResourceFilter(scope, employee, false, "t", "task");
    expect(filter.sql).toContain("pa_task_assignments");
    expect(filter.sql).toContain("COALESCE(t.business_unit_id");
    expect(filter.sql).not.toContain("visible_assignment.operation_id=t.operation_id");
    expect(filter.values).toEqual(["7", "division-30"]);
  });

  it("shows project context from team, operation, task, or oversight scope", () => {
    const filter = paProjectFilter(scope, employee, false);
    expect(filter.sql).toContain("visible_project.user_id=?");
    expect(filter.sql).toContain("visible_operation_assignment.user_id=?");
    expect(filter.sql).toContain("visible_task_assignment.user_id=?");
    expect(filter.sql).toContain("visible_division.project_alpha_business_unit_id=p.business_unit_id");
    expect(filter.values).toEqual(["7", "7", "7", "division-30"]);
  });

  it("shows employees only directly assigned operation and task calendar events", () => {
    const filter = paCalendarFilter(scope, employee, false);
    expect(filter.sql).toContain("e.source_type='operation'");
    expect(filter.sql).toContain("e.source_type='task'");
    expect(filter.sql).not.toContain("contract");
    expect(filter.sql).not.toContain("invoice");
    expect(filter.sql).toContain("pa_task_assignments");
    expect(filter.values).toEqual(["7", "7", "division-30"]);
  });

  it("gives administrators global active-record visibility", () => {
    expect(paResourceFilter(scope, employee, true, "o", "operation")).toEqual({ sql: "o.active=1", values: [] });
    expect(paProjectFilter(scope, employee, true)).toEqual({ sql: "p.active=1", values: [] });
  });
});
