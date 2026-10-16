import { expect, test } from "@playwright/test";

for (const optIn of [false, true]) {
  test(`new public share photo locations require explicit opt-in (${optIn})`, async ({ page }) => {
    let posted: Record<string, unknown> | null = null;
    await page.route("**/api/**", async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.pathname === "/api/session") return route.fulfill({ json: {
        user: { id: "staff-map", email: "staff@example.test", displayName: "Staff", status: "Active", profileType: "Administrator", isAdministrator: true, permissions: ["delivery.browse", "delivery.share.create"], divisions: [] },
        csrfToken: "csrf", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null,
        capabilities: { deliveryJobsRoot: { enabled: true } },
      } });
      if (url.pathname === "/api/delivery/folders") return route.fulfill({ json: {
        prefix: url.searchParams.get("prefix") || "Jobs/Clients/",
        folders: [{ id: "folder-map", prefix: "Jobs/Clients/Map/", physicalKey: "Jobs/Clients/Map/", name: "Map", displayName: "Map", kind: "folder" }], files: [], nextCursor: null,
      } });
      if (url.pathname === "/api/delivery/folders/locations") return route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      if (url.pathname === "/api/delivery/shares/active") return route.fulfill({ json: { share: null } });
      if (url.pathname === "/api/delivery/shares" && request.method() === "POST") {
        posted = request.postDataJSON();
        return route.fulfill({ status: 201, json: { share: { id: "share-map", shareUrl: "https://client.example.test/s/map", accessCode: null, passwordProtected: false, expiresAt: null, lifecycle: "created", idempotentReplay: false } } });
      }
      if (url.pathname === "/api/delivery/shares") return route.fulfill({ json: { shares: [] } });
      return route.fulfill({ status: 404, json: { error: "Not found" } });
    });
    await page.goto("/delivery");
    await page.getByRole("button", { name: "Actions for Map" }).click();
    await page.getByRole("menuitem", { name: "Share" }).click();
    const checkbox = page.getByRole("checkbox", { name: /Show photo locations on this client share/ });
    await expect(checkbox).not.toBeChecked();
    if (optIn) await checkbox.check();
    await page.getByRole("button", { name: "Create link" }).click();
    await expect.poll(() => posted).not.toBeNull();
    expect(posted).toMatchObject({ imageLocationMapEnabled: optIn });
  });
}
