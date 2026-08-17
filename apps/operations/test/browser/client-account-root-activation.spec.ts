import { expect, test } from "@playwright/test";

test("administrator links the reviewed Project Alpha root on desktop and mobile", async ({ page }) => {
  let activationPosted = false;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-admin", email: "admin@example.test", displayName: "Admin",
        status: "Active", profileType: "Administrator", isAdministrator: true,
        permissions: ["administration.view", "operations.manage"], divisions: [],
      },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: {},
    } });
    if (path === "/api/admin/client-account-activation" && request.method() === "GET") {
      return route.fulfill({ json: {
        workspaceMigrationApplied: true,
        accounts: [{
          id: "account-a", displayName: "Acme Surveying", status: "active",
          projectAlphaClientId: null, projectAlphaOrganizationId: null,
          updatedAt: "2026-08-16T00:00:00Z", activationState: "unlinked",
        }],
        sources: [{
          clientId: "pa-client-a", clientName: "Acme North Site",
          organizationId: "pa-org-a", organizationName: "Acme Organization",
          rootType: "organization", rootPublicId: "pa-org-a",
        }],
      } });
    }
    if (path === "/api/admin/client-account-activation/account-a" && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("csrf-test");
      expect(request.postDataJSON()).toEqual({
        projectAlphaClientId: "pa-client-a",
        expectedUpdatedAt: "2026-08-16T00:00:00Z",
      });
      activationPosted = true;
      return route.fulfill({ json: {
        accountId: "account-a", projectAlphaClientId: "pa-client-a",
        projectAlphaOrganizationId: "pa-org-a", rootType: "organization",
        rootPublicId: "pa-org-a", unchanged: false,
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  page.on("dialog", dialog => void dialog.accept());
  await page.goto("/administration");

  const heading = page.getByRole("heading", { name: "Client account Project Alpha activation" });
  const card = page.locator("section.ltds-card").filter({ has: heading });
  await expect(card).toBeVisible();
  await expect(card.getByText(/Workspace migration 0121 is active/)).toBeVisible();
  await expect(page.getByLabel("Legacy client account")).toHaveValue("account-a");
  await expect(page.getByLabel("Project Alpha client")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Link Project Alpha root" })).toBeDisabled();
  await page.getByLabel("Project Alpha client").selectOption("pa-client-a");
  await expect(card.locator(".notice.full")).toContainText("Effective workspace root: Acme Organization · pa-org-a");
  await page.getByRole("button", { name: "Link Project Alpha root" }).click();
  await expect(page.getByText(/complete legacy workspace projection was created atomically and audited/)).toBeVisible();
  expect(activationPosted).toBe(true);

  const box = await card.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
});
