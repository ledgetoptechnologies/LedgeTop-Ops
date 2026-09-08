import { expect, test } from "@playwright/test";

test("Administration presents redacted portal workflow readiness and refreshes it", async ({ page }) => {
  let reads = 0;
  let releaseRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { releaseRefresh = resolve; });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin",
      status: "Active", profileType: "Administrator", isAdministrator: true,
      permissions: ["administration.view", "integrations.manage"], divisions: [] }, csrfToken: "csrf", timezone: "America/Chicago",
      mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: { connectors: [], health: [], legacyPrimary: false } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (path === "/api/admin/portal-workflow-readiness") {
      reads += 1;
      if (reads === 2) await refreshGate;
      return route.fulfill({ json: { ready: false, workflows: {
        nativeFeedback: { state: "unverified", reasons: ["client_runtime_unverified"] }, serviceRequests: { state: "unverified", reasons: ["client_runtime_unverified"] },
        requestAttachments: { state: "blocked", reasons: ["schema_unavailable"] },
        delegatedSharing: { state: "unverified", reasons: ["client_runtime_unverified"] }, expiryNotices: { state: "blocked", reasons: ["notification_transport_unavailable"] },
      } } });
    }
    if (path === "/api/admin/project-alpha-access-token-expiry") return route.fulfill({ json: { healthy: false, connectors: [
      { connector: "ltds", label: "Ledge Top Drone Services", state: "healthy", expiresAt: "2036-07-14T00:00:00.000Z", daysRemaining: 3595 },
      { connector: "ltt", label: "Ledge Top Technologies", state: "unconfigured", expiresAt: null, daysRemaining: null },
    ] } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/administration");
  const card = page.getByText("Client portal workflow readiness", { exact: true }).locator("..");
  await expect(page.getByText("Service requests", { exact: true })).toBeVisible();
  await expect(page.getByText("Client runtime gate must be verified in the Client deployment", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Notification transport is unavailable", { exact: true })).toBeVisible();
  await expect(page.getByText(/credential details/)).toBeVisible();
  await expect(page.getByText("Project Alpha connector token expiry", { exact: true })).toBeVisible();
  await expect(page.getByText(/No token, client ID, secret, or credential fingerprint is shown\./)).toBeVisible();
  await card.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(page.getByText("Refreshing portal workflows…", { exact: true })).toBeVisible();
  await expect(page.getByText("Service requests", { exact: true })).toHaveCount(0);
  releaseRefresh();
  await expect.poll(() => reads).toBe(2);
  await expect(card).toBeVisible();
});

test("Administration rejects an unknown readiness reason instead of presenting optimistic state", async ({ page }) => {
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { user: { id: "admin", email: "admin@example.test", displayName: "Admin",
      status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["administration.view", "integrations.manage"], divisions: [] },
      csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {} } });
    if (path === "/api/admin/integrations/project-alpha/connectors") return route.fulfill({ json: { connectors: [], health: [], legacyPrimary: false } });
    if (path === "/api/admin/audit") return route.fulfill({ json: { events: [] } });
    if (path === "/api/admin/portal-workflow-readiness") return route.fulfill({ json: { ready: true, workflows: {
      nativeFeedback: { state: "ready", reasons: ["future_unknown_reason"] }, serviceRequests: { state: "ready", reasons: [] },
      requestAttachments: { state: "ready", reasons: [] }, delegatedSharing: { state: "ready", reasons: [] }, expiryNotices: { state: "ready", reasons: [] },
    } } });
    return route.fulfill({ status: 404, json: { error: "not found" } });
  });
  await page.goto("/administration");
  await expect(page.getByRole("alert").filter({ hasText: "readiness response could not be verified" })).toBeVisible();
  await expect(page.getByText("All cross-application workflows are ready.")).toHaveCount(0);
});
