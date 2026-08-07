import { expect, test, type Page } from "@playwright/test";

async function mockMapbox(page: Page) {
  await page.route("https://api.mapbox.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/styles/v1/")) {
      await route.fulfill({ json: { version: 8, name: "LTDS test style", sources: {}, layers: [] } });
    } else {
      await route.fulfill({ status: 204, body: "" });
    }
  });
  await page.route("https://events.mapbox.com/**", route => route.fulfill({ status: 204, body: "" }));
}

async function mockDelivery(page: Page) {
  await page.route("**/api/**", async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-a",
          email: "staff@example.test",
          displayName: "Staff Viewer",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["delivery.browse"],
          divisions: ["division-a"],
        },
        csrfToken: "csrf-test",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: "pk.local-browser-test",
        capabilities: {},
      } });
    } else if (url.pathname === "/api/delivery/folders/locations") {
      expect(url.searchParams.get("prefix")).toBe("Jobs/Clients/Acme/Current/");
      await route.fulfill({ json: {
        points: [{ latitude: 44.501, longitude: -88.071, imageCount: 2 }],
        imageCount: 2,
        truncated: false,
      } });
    } else if (url.pathname === "/api/delivery/folders") {
      await route.fulfill({ json: { prefix: "Jobs/Clients/Acme/Current/", folders: [], files: [], nextCursor: null } });
    } else if (url.pathname === "/api/delivery/trash") {
      await route.fulfill({ json: { items: [] } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

test("assigned Operations viewer gets a compact and fullscreen photo map without overflow", async ({ page }, testInfo) => {
  await mockMapbox(page);
  await mockDelivery(page);
  await page.goto("/delivery/Acme/Current");
  await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toBeVisible();
  const compact = page.locator(".image-location-map-canvas").first();
  const compactBox = await compact.boundingBox();
  expect(compactBox).not.toBeNull();
  expect(compactBox!.height).toBeGreaterThanOrEqual(180);
  expect(compactBox!.height).toBeLessThanOrEqual(270);

  await page.getByRole("button", { name: "Enlarge map" }).click();
  const dialog = page.getByRole("dialog", { name: "Image locations from available photo metadata" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".image-location-map-canvas.expanded")).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);

  expect(await page.evaluate(() => ({
    documentFits: document.documentElement.scrollWidth <= window.innerWidth,
    bodyFits: document.body.scrollWidth <= window.innerWidth,
  }))).toEqual({ documentFits: true, bodyFits: true });
  if (testInfo.project.name.includes("mobile")) {
    const box = await page.locator(".image-location-map").boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  }
});
