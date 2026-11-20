import { expect, test, type Page } from "@playwright/test";

const controls = {
  allOperations: false, sopAssignment: false, deliveryBrowse: true, deliveryLinkCreate: false,
  deliveryLinkRevoke: false, deliveryLinkAudit: false, teamRoster: true, administration: false,
  viewerAccess: false, viewerDatasets: false, viewerProcessing: false, viewerPublish: false,
  viewerShareCreate: false, viewerShareRevoke: false, viewerClientAccess: false, viewerStoragePurge: false,
};

const roster = [
  // Owner by role, not by any sync flag.
  { id: "staff-role-owner", email: "owner@example.test", display_name: "Role Owner", status: "active",
    roles: "Owner", provisioning_source: "local", sync_protected: 0, owner_role: true, localControls: controls },
  // An Ops-native hire is inserted with sync_protected=1 but is not an owner.
  { id: "staff-native-hire", email: "hire@example.test", display_name: "Native Hire", status: "active",
    roles: "", provisioning_source: "local", sync_protected: 1, owner_role: false, localControls: controls },
  // Historical imported record: no external manager is implied.
  { id: "staff-imported", email: "imported@example.test", display_name: "Imported Operator", status: "inactive",
    roles: "Operator", provisioning_source: "project-alpha", sync_protected: 0, owner_role: false, localControls: controls },
];

async function mockTeam(page: Page, nativeEnabled: boolean) {
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "roles.manage"], divisions: [] },
      csrfToken: "csrf-team", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/native-staff/session" && nativeEnabled) return route.fulfill({ json: {
      csrfToken: `1.${"a".repeat(64)}`, verifiedUntil: new Date(Date.now() + 3_600_000).toISOString(),
    } });
    if (path === "/api/team/staff" && request.method() === "GET") return route.fulfill({ json: { staff: roster } });
    if (/^\/api\/team\/staff\/[^/]+\/assigned-work$/.test(path))
      return route.fulfill({ json: { operations: [], truncated: false } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

function card(page: Page, name: string) {
  return page.locator(".staff-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
}

for (const nativeEnabled of [false, true]) {
  test(`Team never presents Project Alpha as the staff manager (native lifecycle ${nativeEnabled ? "on" : "off"})`, async ({ page }) => {
    await mockTeam(page, nativeEnabled);
    await page.goto("/team");
    await expect(page.getByRole("heading", { name: "Role Owner" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Team" })).toBeVisible();
    await expect(page.locator(".page-heading p")).toHaveCount(0);
    await expect(page.locator("main")).not.toContainText("Project Alpha");
    await expect(page.locator("body")).not.toContainText(/Project Alpha|Managed in/);
    if (nativeEnabled) {
      await expect(page.getByText("Employee management is not enabled in this environment.")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Load staff profile" }).first()).toBeVisible();
    } else {
      await expect(page.getByRole("status").filter({ hasText: "Employee management is not enabled in this environment." })).toBeVisible();
    }
  });
}

test("Team derives Protected Owner from the owner role, never from sync protection", async ({ page }) => {
  await mockTeam(page, false);
  await page.goto("/team");
  await expect(card(page, "Role Owner").getByText("Protected Owner", { exact: true })).toBeVisible();
  await expect(card(page, "Native Hire").getByText("Protected Owner", { exact: true })).toHaveCount(0);
  await expect(card(page, "Native Hire").getByText("Operations profile", { exact: true })).toBeVisible();
  await expect(card(page, "Imported Operator").getByText("Protected Owner", { exact: true })).toHaveCount(0);
  await expect(card(page, "Imported Operator").getByText("Imported profile", { exact: true })).toBeVisible();
  await expect(card(page, "Native Hire").getByText("No inherited role", { exact: true })).toBeVisible();
  await expect(page.getByText("Protected Owner", { exact: true })).toHaveCount(1);
  // The real warning on inactive staff stays visible next to the access editor.
  await expect(card(page, "Imported Operator").getByText("Saved access does not activate an inactive employee.")).toBeVisible();
});
