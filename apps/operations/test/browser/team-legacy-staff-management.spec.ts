import { expect, test, type Page } from "@playwright/test";

type Person = Record<string, unknown> & { id: string; display_name: string; status: string };

async function mockTeam(page: Page, canManage: boolean) {
  const roster: Person[] = [
    { id: "staff-admin", email: "admin@example.test", display_name: "Admin", status: "active", updated_at: "2026-01-01 00:00:00",
      roles: "Administrator", provisioning_source: "local", sync_protected: 0, owner_role: false, access_controls_editable: false, profile_editable: false },
    { id: "staff-owner", email: "owner@example.test", display_name: "Role Owner", status: "active", updated_at: "2026-01-01 00:00:00",
      roles: "Owner", provisioning_source: "local", sync_protected: 0, owner_role: true, access_controls_editable: false, profile_editable: false },
    { id: "staff-plain", email: "plain@example.test", display_name: "Plain Person", status: "active", updated_at: "2026-01-01 00:00:00",
      roles: "", provisioning_source: "local", sync_protected: 0, owner_role: false, access_controls_editable: false, profile_editable: canManage },
    { id: "staff-inactive-admin", email: "inactive-admin@example.test", display_name: "Inactive Admin", status: "inactive", updated_at: "2026-01-01 00:00:00",
      roles: "Administrator", provisioning_source: "local", sync_protected: 0, owner_role: false, access_controls_editable: false,
      profile_editable: canManage, reactivate_requires_owner: true },
  ];
  const writes: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: "Administrator", isAdministrator: true, permissions: ["team.view", "roles.manage"], divisions: [] },
      csrfToken: "csrf-team", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/team/staff" && request.method() === "GET") return route.fulfill({ json: { staff: roster, can_manage_staff: canManage } });
    if (/^\/api\/team\/staff\/[^/]+\/assigned-work$/.test(path)) return route.fulfill({ json: { operations: [], truncated: false } });
    if (path === "/api/admin/staff" && request.method() === "POST") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: "POST", path, body });
      roster.push({ id: `staff-local-${body.commandId}`, email: String(body.email).toLowerCase(), display_name: String(body.displayName),
        status: "active", updated_at: "2026-01-02 00:00:00", roles: "", provisioning_source: "local", sync_protected: 0,
        owner_role: false, access_controls_editable: true, profile_editable: true });
      return route.fulfill({ status: 201, json: { success: true } });
    }
    const patch = /^\/api\/admin\/staff\/([^/]+)$/.exec(path);
    if (patch && request.method() === "PATCH") {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ method: "PATCH", path, body });
      const target = roster.find(entry => entry.id === decodeURIComponent(patch[1]!))!;
      if (body.displayName) target.display_name = String(body.displayName);
      const reactivating = body.status === "active" && target.status === "inactive";
      if (body.status) target.status = String(body.status);
      target.updated_at = reactivating ? "2026-01-04 00:00:00" : "2026-01-03 00:00:00";
      return route.fulfill({ json: { success: true, ...(reactivating ? { retained: { roles: 2, overrides: 1, alternateLogins: 0 } } : {}) } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return writes;
}

const card = (page: Page, name: string) => page.locator(".staff-card").filter({ has: page.getByRole("heading", { name, exact: true }) });

test("Team add and edit controls follow the server flags and send versioned commands", async ({ page }) => {
  const writes = await mockTeam(page, true);
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "Plain Person" })).toBeVisible();
  await expect(card(page, "Role Owner").getByRole("button", { name: "Edit name" })).toHaveCount(0);
  await expect(card(page, "Admin").getByRole("button", { name: "Deactivate" })).toHaveCount(0);
  // Reactivating an administrator is owner-only: a non-owner viewer gets no Reactivate control.
  await expect(card(page, "Inactive Admin").getByRole("button", { name: "Edit name" })).toBeVisible();
  await expect(card(page, "Inactive Admin").getByRole("button", { name: "Reactivate" })).toHaveCount(0);

  await page.getByRole("button", { name: "Add staff member" }).click();
  await page.getByLabel("Name", { exact: true }).fill("New Person");
  await page.getByLabel("Email", { exact: true }).fill("New.Person@Example.test");
  await page.getByRole("button", { name: "Add staff member" }).click();
  await expect(page.getByRole("heading", { name: "New Person" })).toBeVisible();
  const created = writes.find(write => write.method === "POST")!;
  expect(created.body).toMatchObject({ displayName: "New Person", email: "New.Person@Example.test" });
  expect(String(created.body.commandId)).toMatch(/^[0-9a-f-]{36}$/);

  await card(page, "Plain Person").getByRole("button", { name: "Edit name" }).click();
  await card(page, "Plain Person").getByLabel("Name").fill("Renamed Person");
  await card(page, "Plain Person").getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("heading", { name: "Renamed Person" })).toBeVisible();
  expect(writes.at(-1)!.body).toEqual({ expectedUpdatedAt: "2026-01-01 00:00:00", displayName: "Renamed Person" });

  await card(page, "Renamed Person").getByRole("button", { name: "Deactivate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Deactivate" }).click();
  await expect(card(page, "Renamed Person").getByRole("button", { name: "Reactivate" })).toBeVisible();
  expect(writes.at(-1)!.body).toEqual({ expectedUpdatedAt: "2026-01-03 00:00:00", status: "inactive" });

  // Reactivation asks first, says what comes back, and then reports what was retained.
  const patches = writes.length;
  await card(page, "Renamed Person").getByRole("button", { name: "Reactivate" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Their previous roles, access and sign-in emails come back with them.");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(writes.length).toBe(patches);
  await card(page, "Renamed Person").getByRole("button", { name: "Reactivate" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Reactivate" }).click();
  await expect(card(page, "Renamed Person").getByRole("button", { name: "Deactivate" })).toBeVisible();
  expect(writes.at(-1)!.body).toEqual({ expectedUpdatedAt: "2026-01-03 00:00:00", status: "active" });
  await expect(card(page, "Renamed Person").getByRole("status")).toHaveText("Reactivated with 2 role(s), 1 access setting(s) and 0 other sign-in email(s).");
});

test("Team hides add and edit controls when the server does not allow them", async ({ page }) => {
  await mockTeam(page, false);
  await page.goto("/team");
  await expect(page.getByRole("heading", { name: "Plain Person" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add staff member" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Edit name" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Deactivate|Reactivate/ })).toHaveCount(0);
});
