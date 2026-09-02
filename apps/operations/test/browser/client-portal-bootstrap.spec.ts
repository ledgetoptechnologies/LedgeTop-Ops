import { expect, test, type Page, type Route } from "@playwright/test";

const account = {
  id: "legacy-account-opaque", displayName: "Greenwood Client Portal", status: "active",
  projectAlphaClientId: null, projectAlphaOrganizationId: null, updatedAt: "2026-09-01T12:00:00Z",
  verifiedIdentityCount: 2, activeMemberCount: 2, activeManagerCount: 1, activationState: "unlinked",
};
const source = {
  clientId: "pa-client-opaque", clientName: "St. Joseph project contact", organizationId: "pa-org-opaque",
  organizationName: "Greenwood Project Management LLC", rootType: "organization", rootPublicId: "pa-org-opaque",
};

async function fixture(page: Page, activation: (route: Route) => Promise<unknown>, administrator = true) {
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === "/api/session") return route.fulfill({ json: {
      user: { id: "staff-admin", email: "admin@example.test", displayName: "Admin", status: "Active",
        profileType: administrator ? "Administrator" : "Employee", isAdministrator: administrator, permissions: ["team.view", "operations.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (url.pathname === "/api/client-service-requests") return route.fulfill({ json: { requests: [] } });
    if (url.pathname === "/api/client-hub") return route.fulfill({ json: {
      clients: [], nextCursor: null, capabilities: { directory: true, requests: true, delivery: false, viewer: false },
      sources: [{ source_id: "project-alpha:primary", display_name: "Project Alpha" }],
    } });
    if (url.pathname.startsWith("/api/admin/client-account-activation")) return activation(route);
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
}

test("Client Hub stages one exact Project Alpha portal root without treating authentication as access", async ({ page }) => {
  let reads = 0, posted: unknown = null;
  await fixture(page, async route => {
    if (route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      return route.fulfill({ json: { accountId: account.id, unchanged: false } });
    }
    reads += 1;
    return route.fulfill({ json: { workspaceMigrationApplied: true,
      accounts: reads === 1 ? [account] : [{ ...account, activationState: "projected" }], sources: [source] } });
  });

  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Portal workspace coverage" })).toBeVisible();
  expect(reads).toBe(0);
  await expect(page.getByText("Project Alpha-backed client accounts are reconciled automatically after a successful sync.")).toBeVisible();
  await page.getByRole("button", { name: "Review legacy exceptions" }).click();
  await expect(page.getByText("1. Eligibility")).toBeVisible();
  await expect(page.getByText("Workspace creation never grants access by itself.")).toBeVisible();
  await expect(page.getByLabel("Existing client portal account")).toHaveValue(account.id);
  await page.getByLabel("Project Alpha workspace root").selectOption({ label: "Greenwood Project Management LLC — St. Joseph project contact" });
  await expect(page.getByText("2 verified active members · 1 manager.")).toBeVisible();
  await page.getByRole("button", { name: "Review portal setup" }).click();
  await expect(page.getByRole("heading", { name: "Review before creating access" })).toBeVisible();
  await expect(page.getByText("Existing workspace, manager, and project grants only")).toBeVisible();
  await expect(page.getByText(account.id)).toHaveCount(0);
  await expect(page.getByText(source.rootPublicId)).toHaveCount(0);
  await page.getByRole("button", { name: "Create workspace and memberships" }).click();
  await expect(page.getByText(/Portal workspace created for Greenwood Client Portal/)).toBeVisible();
  expect(posted).toEqual({ projectAlphaClientId: source.clientId, expectedUpdatedAt: account.updatedAt });
  expect(reads).toBe(2);
});

test("Client Hub blocks empty membership and indistinguishable Project Alpha names", async ({ page }) => {
  const duplicate = { ...source, clientId: "another-pa-client", organizationId: "another-pa-org", rootPublicId: "another-pa-org" };
  await fixture(page, route => route.fulfill({ json: { workspaceMigrationApplied: true,
    accounts: [{ ...account, activeMemberCount: 0, activeManagerCount: 0 }], sources: [source, duplicate] } }));
  await page.goto("/clients");
  await page.getByRole("button", { name: "Review legacy exceptions" }).click();
  await expect(page.getByText("Member needed")).toBeVisible();
  await expect(page.getByText(/no verified active member/i)).toBeVisible();
  const sourceSelect = page.getByLabel("Project Alpha workspace root");
  await expect(sourceSelect.locator("option", { hasText: "duplicate name; review in Project Alpha" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Review portal setup" })).toBeDisabled();
});

test("Client Hub does not expose the administrator bootstrap to a non-administrator with operational review access", async ({ page }) => {
  let requested = false;
  await fixture(page, route => { requested = true; return route.fulfill({ status: 403, json: { error: "Administrator access required" } }); }, false);
  await page.goto("/clients");
  await expect(page.getByRole("heading", { name: "Portal workspace coverage" })).toHaveCount(0);
  expect(requested).toBe(false);
});
