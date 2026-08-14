import { expect, test } from "@playwright/test";

test("administrators can transfer delegated-share recovery authority on desktop and mobile", async ({ page }) => {
  let transferred = false;
  let version = 3;
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: {
      user: {
        id: "staff-admin", email: "admin@example.test", displayName: "Admin",
        status: "Active", profileType: "Administrator", isAdministrator: true,
        permissions: ["administration.view", "delivery.share.audit", "delivery.share.create", "delivery.share.revoke"],
        divisions: [],
      },
      csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
      capabilities: {},
    } });
    if (path === "/api/admin/client-delegated-shares" && request.method() === "GET") return route.fulfill({ json: {
      workspaces: [{ id: "workspace-00000001", displayName: "Acme", managers: [
        { identityId: "identity-00000001", email: "old@example.test", entitlementId: "entitlement-share-01" },
        { identityId: "identity-00000002", email: "new@example.test", entitlementId: "entitlement-share-02" },
      ] }],
      targets: [{ id: "target-root-000001", workspaceId: "workspace-00000001", displayName: "Project deliverables", status: "active" }],
      delegations: [{
        id: "delegation-0000001", workspaceId: "workspace-00000001",
        identityId: transferred ? "identity-00000002" : "identity-00000001",
        managerEmail: transferred ? "new@example.test" : "old@example.test",
        rootTargetId: "target-root-000001", imageLocationMapEnabled: true,
        version, status: "active", expiresAt: "2099-01-01T00:00:00.000Z",
      }],
      shares: [{ id: "client-share-000001", publicId: "cs_public_00000000001", delegationId: "delegation-0000001", label: "Review", status: "active", expiresAt: "2099-01-01T00:00:00.000Z" }],
    } });
    if (path.endsWith("/delegations/delegation-0000001/transfer") && request.method() === "POST") {
      expect(request.headers()["x-csrf-token"]).toBe("csrf-test");
      expect(request.headers()["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
      expect(request.postDataJSON()).toEqual({
        identityId: "identity-00000002", entitlementId: "entitlement-share-02", expectedVersion: 3,
      });
      transferred = true; version = 4;
      return route.fulfill({ json: { delegation: { id: "delegation-0000001", version, replayed: false } } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });

  await page.goto("/administration");
  await expect(page.getByRole("heading", { name: "Client-created link recovery" })).toBeVisible();
  await expect(page.getByText(/Project deliverables · Acme/)).toBeVisible();
  await expect(page.getByText(/1 active link/)).toBeVisible();
  await expect(page.getByText(/map enabled/)).toBeVisible();
  await page.getByLabel("Replacement manager for Project deliverables").selectOption("identity-00000002:entitlement-share-02");
  await page.getByRole("button", { name: "Transfer" }).click();
  await expect(page.getByText(/Manager authority transferred/)).toBeVisible();
  await expect(page.getByText(/new@example\.test/)).toBeVisible();
  expect(transferred).toBe(true);

  const row = page.locator(".delegated-share-admin-row").first();
  expect((await row.boundingBox())!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
