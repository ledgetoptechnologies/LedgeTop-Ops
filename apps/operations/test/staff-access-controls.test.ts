import { describe, expect, it } from "vitest";
import { PERMISSIONS } from "@ltds/shared";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/worker/index.ts", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/client/OperationsApp.tsx", import.meta.url), "utf8");

describe("staff access controls", () => {
  it("keeps the ACL vocabulary constrained to known permissions", () => {
    for (const permission of ["operations.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke", "delivery.share.audit", "team.view", "administration.view"]) {
      expect(PERMISSIONS).toContain(permission);
    }
  });

  it("exposes a system-admin-only, strict allowlisted update endpoint with audit logging", () => {
    expect(source).toContain('app.put("/api/admin/staff/:id/access-controls"');
    expect(source).toContain("await requireGlobal(c.env,principal,\"roles.manage\")");
    expect(source).toContain("staffAccessSchema");
    expect(source).toContain("staff.access_controls.updated");
    expect(source).toContain("Administrators cannot change their own access controls");
  });

  it("connects each visible admin toggle to the CSRF-protected API, while ordinary team viewers cannot mutate it", () => {
    expect(client).toContain("/access-controls");
    expect(client).toContain('api<{staff:any[]}>("/api/team/staff")');
    expect(client).toContain("session.user.isAdministrator&&person.id!==session.user.id");
    expect(client).toContain("View all operations, projects, and tasks");
    expect(client).toContain("Create client links");
  });
});
