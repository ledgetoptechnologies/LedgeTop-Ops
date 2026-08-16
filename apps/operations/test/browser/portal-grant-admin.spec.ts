import { expect, test } from "@playwright/test";

const user = {
  id: "staff-grant-admin", email: "admin@example.test", displayName: "Grant Admin",
  status: "Active", profileType: "Administrator", isAdministrator: true,
  permissions: ["administration.view", "delivery.browse", "delivery.share.create", "delivery.share.revoke"], divisions: [],
};

test("creates a distinct authenticated Client Portal grant with keyboard typeahead", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  let created = false;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-grants", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { deliveryJobsRoot: { enabled: true }, authenticatedDeliveryGrants: { enabled: true } } } });
    if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: { prefix: url.searchParams.get("prefix") || "Jobs/Clients/",
      folders: [{ id: "folder-acme", prefix: "Jobs/Clients/Acme/", name: "Acme", displayName: "Acme", kind: "folder" }], files: [], nextCursor: null } });
    if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
    if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: null } });
    if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
    if (url.pathname === "/api/delivery/authenticated-grants/audiences") return route.fulfill({ json: { audiences: [
      { type: "organization", publicId: "org-acme", displayName: "Acme Organization" },
    ] } });
    if (url.pathname === "/api/delivery/authenticated-grants" && route.request().method() === "POST") {
      posted = route.request().postDataJSON(); created = true;
      return route.fulfill({ status: 201, json: { grant: { id: "grant-v1", grantId: "grant-logical", version: 1, status: "active" } } });
    }
    if (url.pathname === "/api/delivery/authenticated-grants") return route.fulfill({ json: {
      folderBindingId: "binding-acme", grants: created ? [{ id: "grant-v1", grantId: "grant-logical", version: 1,
        audience: { type: "organization", publicId: "org-acme" }, audienceLabel: "Acme Organization",
        workspaceLabel: "Acme Workspace", status: "active", expiresAt: null, recipientCount: 0,
        dynamicAudience: true, updatedAt: "2026-08-15T12:00:00Z" }] : [],
    } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/delivery");
  await page.getByRole("button", { name: "Actions for Acme" }).click();
  await page.getByRole("menuitem", { name: "Share" }).click();
  await expect(page.getByText("Authenticated Client Portal access")).toHaveCount(0);
  await page.getByRole("button", { name: "Grant to Client Portal" }).click();
  await expect(page.getByText(/never creates a bearer link/i)).toBeVisible();
  const audience = page.getByRole("combobox", { name: /Organization, department, client, project, or person/ });
  await audience.fill("Acme");
  await expect(page.getByRole("option", { name: /Acme Organization/ })).toBeVisible();
  await audience.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(audience).toHaveValue("Acme Organization");
  await expect(page.getByText(/dynamic current authorized members/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Grant authenticated access" }).click();
  await expect(page.getByRole("status")).toContainText("Authenticated portal access granted");
  expect(posted).toMatchObject({ folderBindingId: "binding-acme", audienceType: "organization",
    audiencePublicId: "org-acme", reasonCode: "client_delivery_access", expiresAt: null });
  await expect(page.getByText("Dynamic current authorized members")).toBeVisible();
  await expect(page.getByRole("button", { name: "Revoke" })).toBeVisible();
});

test("Administration creates a scoped exact-identity denial without raw ID entry", async ({ page }) => {
  let posted: Record<string, unknown> | null = null;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-denials", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { portalIdentityDenials: { enabled: true } } } });
    if (url.pathname === "/api/client-portal/identity-denials/identities") return route.fulfill({ json: { identities: [
      { identityId: "identity-alex", displayName: "Alex Client", email: "alex@example.test" },
    ] } });
    if (url.pathname === "/api/client-portal/identity-denials/scopes") return route.fulfill({ json: { scopes: [
      { scopeType: "project", workspaceId: "workspace-acme", publicId: "project-hilly", displayName: "Hilly Haven",
        workspaceLabel: "Acme Workspace", breadcrumb: "Acme Workspace › Acme Organization › Hilly Haven" },
    ] } });
    if (url.pathname === "/api/client-portal/identity-denials" && route.request().method() === "POST") {
      posted = route.request().postDataJSON();
      return route.fulfill({ status: 201, json: { denial: { id: "denial-new" }, replayed: false } });
    }
    if (url.pathname === "/api/client-portal/identity-denials") return route.fulfill({ json: { denials: [] } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Client Portal identity denylist" })).toBeVisible();
  const identity = page.getByRole("combobox", { name: "Verified identity" });
  await identity.fill("Alex"); await expect(page.getByRole("option", { name: /Alex Client/ })).toBeVisible();
  await identity.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(identity).toHaveValue("Alex Client (alex@example.test)");
  await page.getByRole("combobox", { name: "Scope", exact: true }).selectOption("project");
  const scope = page.getByRole("combobox", { name: "Project" });
  await scope.fill("Hilly"); await expect(page.getByRole("option", { name: /Hilly Haven/ })).toBeVisible();
  await scope.press("ArrowDown"); await page.keyboard.press("Enter");
  await expect(scope).toHaveValue("Acme Workspace › Acme Organization › Hilly Haven");
  await expect(page.getByPlaceholder(/Opaque/)).toHaveCount(0);
  await page.getByRole("button", { name: "Create identity denial" }).click();
  await expect(page.getByRole("status")).toContainText("Portal identity denial created");
  expect(posted).toMatchObject({ identityId: "identity-alex", scopeType: "project",
    workspaceId: "workspace-acme", scopePublicId: "project-hilly", reasonCode: "security_response", expiresAt: null });
});

test("denylist controls remain hidden while the default-off capability is false", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/session") return route.fulfill({ json: { user, csrfToken: "csrf-off", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: { portalIdentityDenials: { enabled: false } } } });
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  await page.goto("/administration");
  await expect(page.getByText("Client Portal identity denylist")).toHaveCount(0);
});
