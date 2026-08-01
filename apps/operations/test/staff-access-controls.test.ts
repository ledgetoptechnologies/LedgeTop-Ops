import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@ltds/shared";
import { readFileSync } from "node:fs";
import { evaluatePermission } from "../src/worker/acl";
import { effectiveStaffAccessControls, staffAccessControlEffect } from "../src/worker/staff-access-controls";
import type { GrantRow, StaffPrincipal } from "../src/worker/types";

const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8");
const compactSource = source.replace(/\s+/g, "");
const compactClient = client.replace(/\s+/g, "");
const styles = readFileSync(new URL("../src/client/styles.css", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/0015_staff_acl_explicit_controls.sql", import.meta.url), "utf8");
const principal = { id: "staff-target" } as StaffPrincipal;

describe("staff access controls", () => {
  it("keeps the ACL vocabulary constrained to known permissions", () => {
    for (const permission of ["operations.view", "operations.view_all", "delivery.browse", "delivery.share.create", "delivery.share.revoke", "delivery.share.audit", "team.view", "administration.view"]) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it("makes an unchecked control an explicit global deny that wins over an inherited role allow", () => {
    const grants: GrantRow[] = [
      { permission: "delivery.browse", effect: "allow", scope: "global", divisionId: null, source: "role" },
      { permission: "delivery.browse", effect: "deny", scope: "global", divisionId: null, source: "override" },
    ];
    expect(staffAccessControlEffect(false)).toBe("deny");
    expect(evaluatePermission(grants, principal, "delivery.browse")).toBe(false);
    expect(effectiveStaffAccessControls({ inheritedPermissions: "delivery.browse", globalDenies: "delivery.browse" }).deliveryBrowse).toBe(false);
  });

  it("preserves an enabled direct capability and ordinary assigned-work access", () => {
    const grants: GrantRow[] = [
      { permission: "delivery.browse", effect: "allow", scope: "global", divisionId: null, source: "override" },
      { permission: "operations.view", effect: "allow", scope: "assigned", divisionId: null, source: "role" },
      { permission: "operations.view_all", effect: "deny", scope: "global", divisionId: null, source: "override" },
    ];
    expect(staffAccessControlEffect(true)).toBe("allow");
    expect(evaluatePermission(grants, principal, "delivery.browse")).toBe(true);
    expect(evaluatePermission(grants, principal, "operations.view", { assignedStaffIds: [principal.id] })).toBe(true);
    expect(evaluatePermission(grants, principal, "operations.view_all")).toBe(false);
  });

  it("exposes a system-admin-only, strict allowlisted update endpoint with audit logging", () => {
    expect(source).toContain('app.put("/api/admin/staff/:id/access-controls"');
    expect(compactSource).toContain("awaitrequireGlobal(c.env,principal,\"roles.manage\")");
    expect(source).toContain("staffAccessSchema");
    expect(source).toContain("staff.access_controls.updated");
    expect(source).toContain("Administrators cannot change their own access controls");
    expect(source).toContain("Protected staff access controls cannot be changed");
    expect(source).toContain("staffAccessControlEffect(value[control])");
    expect(source).toContain("permission_key=? AND scope='global'");
    expect(source).not.toContain('/delivery-access"');
  });

  it("connects each visible admin toggle to the CSRF-protected API, while ordinary team viewers cannot mutate it", () => {
    expect(client).toContain("/access-controls");
    expect(compactClient).toContain('api<{staff:any[]}>("/api/team/staff")');
    expect(compactClient).toContain('session.user.isAdministrator&&person.id!==session.user.id&&!person.sync_protected&&person.id!=="staff-beau-koltz"');
    expect(client).toContain("View all operations, projects, and tasks");
    expect(client).toContain("Create client links");
  });

  it("keeps each team access control inside a responsive card row", () => {
    expect(styles).toContain(".local-access-toggle{display:grid;grid-template-columns:minmax(0,1fr);gap:.55rem;width:100%;min-width:0");
    expect(styles).toContain(".local-access-toggle label{display:grid;grid-template-columns:1.15rem minmax(0,1fr)");
    expect(styles).toContain(".local-access-toggle label+label{padding-top:.55rem;border-top:1px solid var(--line)}");
  });

  it("migrates the one legacy delivery grant mechanism before deleting it", () => {
    expect(migration).toContain("INSERT OR IGNORE INTO staff_permission_overrides");
    expect(migration).toContain("'delivery.browse'");
    expect(migration).toContain("'delivery.share.create'");
    expect(migration).toContain("DELETE FROM local_staff_role_assignments");
    expect(migration).toContain("role_id='role-delivery-coordinator'");
    expect(migration).toContain("scope='global'");
  });
});
