import { expect, test } from "@playwright/test";

test("shows safe PA preflight diagnostics after exact-ID staging binding refresh", async ({ page }) => {
  let refreshRequest: { body: unknown; csrf: string | null; idempotency: string | null } | null = null;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: {
      connectors: [{ sourceId: "project-alpha:staging", displayName: "Project Alpha staging", producerBindingId: "staging-binding",
        snapshotOrigin: "https://pa-staging.example.test", snapshotBasePath: "/", applicationKey: "staging", profile: "business_data",
        state: "active", readVisible: true, activeRevision: 3, version: 4 }], health: [], legacyPrimary: false,
    } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/sources") return route.fulfill({ json: { sources: ["project-alpha:staging"] } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/read-acceptance") return route.fulfill({ json: {
      sourceId: "project-alpha:staging", readOnly: true,
      capabilities: { status: "verified", exactIdentityMatch: true, exactContractMatch: true },
      directory: { status: "observed", count: 1 }, projects: { status: "binding_stale" },
    } });
    if (path === "/api/admin/project-alpha/private/projects/bindings/refresh") {
      refreshRequest = { body: JSON.parse(request.postData() || "null"), csrf: request.headers()["x-csrf-token"] ?? null,
        idempotency: request.headers()["idempotency-key"] ?? null };
      return route.fulfill({ json: { outcome: { status: "not_refreshed", reason: "preflight_missing_endpoint" } } });
    }
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });

  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  await page.getByRole("button", { name: "Verify read-only API connection" }).click();
  await expect(page.getByText("Staging project binding is stale.", { exact: false })).toBeVisible();
  await page.getByLabel("Exact external Project ID", { exact: true }).fill("pa-staging-project-123");
  await page.getByLabel("Confirm exact external Project ID", { exact: true }).fill("pa-staging-project-123");
  await page.getByRole("button", { name: "Refresh staging binding", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Binding was not refreshed (preflight missing endpoint)" }))
    .toContainText("Binding was not refreshed (preflight missing endpoint)");
  expect(refreshRequest).toEqual({ body: { sourceId: "project-alpha:staging", externalProjectId: "pa-staging-project-123" }, csrf: "csrf-test", idempotency: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
});

test("does not expose the staging refresh action for another source", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf-test",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: {
      connectors: [{ sourceId: "project-alpha:primary", displayName: "Project Alpha primary", producerBindingId: "primary-binding",
        snapshotOrigin: "https://pa.example.test", snapshotBasePath: "/", applicationKey: "primary", profile: "business_data",
        state: "active", readVisible: true, activeRevision: 3, version: 4 }], health: [], legacyPrimary: false,
    } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/sources") return route.fulfill({ json: { sources: ["project-alpha:primary"] } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/read-acceptance") return route.fulfill({ json: {
      sourceId: "project-alpha:primary", readOnly: true, capabilities: { status: "verified", exactIdentityMatch: true, exactContractMatch: true },
      directory: { status: "observed", count: 1 }, projects: { status: "binding_stale" },
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  await page.getByRole("button", { name: "Verify read-only API connection" }).click();
  await expect(page.getByRole("button", { name: "Refresh staging binding", exact: true })).toHaveCount(0);
});

test("discovers API-v2 acceptance independently when the legacy connector registry is empty", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: { id: "admin", email: "admin@example.test", displayName: "Admin", status: "Active", profileType: "Administrator",
        isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf-test",
      timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
    } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: { connectors: [], health: [], legacyPrimary: false } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/sources") return route.fulfill({ json: { sources: ["project-alpha:staging"] } });
    if (path === "/api/admin/integrations/project-alpha/api-v2/read-acceptance") return route.fulfill({ json: {
      sourceId: "project-alpha:staging", readOnly: true,
      capabilities: { status: "verified", exactIdentityMatch: true, exactContractMatch: true },
      directory: { status: "observed", count: 0 }, projects: { status: "binding_stale" },
    } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/administration");
  await page.getByText("Staging API-v2 operator review").click();
  await expect(page.getByLabel("Enabled API-v2 sources").getByText("project-alpha:staging", { exact: true })).toBeVisible();
  await page.getByLabel("Enabled API-v2 sources").getByRole("button", { name: "Verify read-only API connection" }).click();
  await expect(page.getByText("Staging project binding is stale.", { exact: false })).toBeVisible();
});
