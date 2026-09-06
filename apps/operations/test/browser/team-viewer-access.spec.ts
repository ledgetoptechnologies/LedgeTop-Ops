import { expect, test } from "@playwright/test";

const deniedControls = {
  allOperations: false,
  sopAssignment: false,
  deliveryBrowse: true,
  deliveryLinkCreate: true,
  deliveryLinkRevoke: true,
  deliveryLinkAudit: true,
  teamRoster: true,
  administration: false,
  viewerAccess: false,
  viewerDatasets: false,
  viewerProcessing: false,
  viewerPublish: false,
  viewerShareCreate: false,
  viewerShareRevoke: false,
  viewerClientAccess: false,
  viewerStoragePurge: false,
};

test("an administrator can grant a synced operator base 3D-model access without granting destructive authority", async ({ page }) => {
  let controls = { ...deniedControls };
  const updates: Record<string, boolean>[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "roles.manage"], divisions: [] },
      csrfToken: "csrf-team", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/team/staff" && request.method() === "GET") return route.fulfill({ json: { staff: [{
      id: "staff-kollin", email: "kollin@example.test", display_name: "Kollin", status: "active",
      roles: "Operator", sync_protected: 0, owner_role: 0, localControls: controls,
    }] } });
    if (path === "/api/team/staff/staff-kollin/assigned-work")
      return route.fulfill({ json: { operations: [], tasks: [] } });
    if (path === "/api/admin/staff/staff-kollin/access-controls" && request.method() === "PUT") {
      controls = request.postDataJSON() as typeof controls;
      updates.push(controls);
      return route.fulfill({ json: { success: true, controls } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/team");
  const categories = page.getByRole("tablist", { name: "Kollin access categories" });
  const operationsTab = categories.getByRole("tab", { name: "Operations" });
  const viewerTab = categories.getByRole("tab", { name: "3D Models" });
  await expect(operationsTab).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("group", { name: "Operations access" })).toBeVisible();
  await expect(page.getByRole("group", { name: "3D Models access" })).toBeHidden();
  await operationsTab.focus();
  await operationsTab.press("ArrowRight");
  await expect(viewerTab).toBeFocused();
  await expect(viewerTab).toHaveAttribute("aria-selected", "true");
  const viewer = page.getByRole("group", { name: "3D Models access" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByLabel("View and open 3D models")).not.toBeChecked();
  await expect(viewer.getByLabel("Permanently purge Viewer storage (owner only)")).toBeDisabled();
  await viewer.getByLabel("View and open 3D models").click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toMatchObject({
    viewerAccess: true,
    viewerDatasets: false,
    viewerProcessing: false,
    viewerPublish: false,
    viewerStoragePurge: false,
  });
  await expect(viewer.getByLabel("View and open 3D models")).toBeChecked();
});
