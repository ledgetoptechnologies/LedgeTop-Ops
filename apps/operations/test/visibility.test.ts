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

  it("allows only direct operation assignment", () => {
    const filter = paResourceFilter(scope, employee, false, "o", "operation");
    expect(filter.sql).toContain("visible_assignment.operation_id=o.id");
    expect(filter.sql).not.toContain("visible_division");
    expect(filter.values).toEqual(["7"]);
  });

  it("uses only multi-worker task assignment", () => {
    const filter = paResourceFilter(scope, employee, false, "t", "task");
    expect(filter.sql).toContain("pa_task_assignments");
    expect(filter.sql).not.toContain("business_unit_id");
    expect(filter.sql).not.toContain("visible_assignment.operation_id=t.operation_id");
    expect(filter.values).toEqual(["7"]);
  });

  it("shows project context from manager, team, operation, or task assignment", () => {
    const filter = paProjectFilter(scope, employee, false);
    expect(filter.sql).toContain("p.manager_user_id=?");
    expect(filter.sql).toContain("visible_project.user_id=?");
    expect(filter.sql).toContain("visible_operation_assignment.user_id=?");
    expect(filter.sql).toContain("visible_task_assignment.user_id=?");
    expect(filter.sql).not.toContain("visible_division");
    expect(filter.values).toEqual(["7", "7", "7", "7"]);
  });

  it("shows employees only directly assigned operation and task calendar events", () => {
    const filter = paCalendarFilter(scope, employee, false);
    expect(filter.sql).toContain("e.source_type='operation'");
    expect(filter.sql).toContain("e.source_type='task'");
    expect(filter.sql).not.toContain("contract");
    expect(filter.sql).not.toContain("invoice");
    expect(filter.sql).toContain("pa_task_assignments");
    expect(filter.sql).not.toContain("visible_division");
    expect(filter.values).toEqual(["7", "7"]);
  });

  it("gives administrators global active-record visibility", () => {
    expect(paResourceFilter(scope, employee, true, "o", "operation")).toEqual({ sql: "o.active=1", values: [] });
    expect(paProjectFilter(scope, employee, true)).toEqual({ sql: "p.active=1", values: [] });
  });
});
