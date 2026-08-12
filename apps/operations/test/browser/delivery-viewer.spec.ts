import { expect, test, type Page } from "@playwright/test";

type ViewerRequests = { imageSource: number; videoSource: number; thumbnail: number };

async function mockDeliveryViewer(page: Page): Promise<ViewerRequests> {
  const requests: ViewerRequests = { imageSource: 0, videoSource: 0, thumbnail: 0 };
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/thumbnail")) requests.thumbnail += 1;
    if (url.pathname === "/api/session") {
      await route.fulfill({ json: {
        user: {
          id: "staff-viewer",
          email: "staff-viewer@example.test",
          displayName: "Viewer Staff",
          status: "Active",
          profileType: "Employee",
          isAdministrator: false,
          permissions: ["delivery.browse"],
          divisions: [],
        },
        csrfToken: "csrf-viewer",
        timezone: "America/Chicago",
        mapStyleUrl: null,
        mapboxPublicToken: null,
        capabilities: { deliveryJobsRoot: { enabled: true } },
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders") {
      const prefix = url.searchParams.get("prefix") || "";
      await route.fulfill({ json: {
        prefix,
        folders: [],
        files: [
          {
            id: "opaque-image",
            name: "photo.jpg",
            displayName: "photo.jpg",
            kind: "image",
            size: 4096,
            thumbnailState: "pending",
            thumbnailFallbackKind: "image",
            previewUrl: "/api/delivery/items/opaque-image/source",
            sourceUrl: "/api/delivery/items/opaque-image/source",
            downloadUrl: "/api/delivery/items/opaque-image/download",
          },
          {
            id: "opaque-video",
            name: "flight.mp4",
            displayName: "flight.mp4",
            kind: "video",
            size: 8192,
            thumbnailState: "not_applicable",
            thumbnailFallbackKind: "video",
            previewStatus: "unavailable",
            sourceUrl: "/api/delivery/items/opaque-video/source",
            downloadUrl: "/api/delivery/items/opaque-video/download",
          },
        ],
        nextCursor: null,
      } });
      return;
    }
    if (url.pathname === "/api/delivery/folders/locations") {
      await route.fulfill({ json: { points: [], imageCount: 0, truncated: false } });
      return;
    }
    if (url.pathname === "/api/delivery/shares") {
      await route.fulfill({ json: { shares: [] } });
      return;
    }
    if (url.pathname === "/api/delivery/items/opaque-image/source") {
      requests.imageSource += 1;
      await route.fulfill({
        status: 200,
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="orange"/></svg>',
      });
      return;
    }
    if (url.pathname === "/api/delivery/items/opaque-video/source") {
      requests.videoSource += 1;
      await route.fulfill({ status: 200, contentType: "video/mp4", body: "synthetic-video" });
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return requests;
}

test("image original loads only after activation and Escape restores trigger focus", async ({ page }) => {
  const requests = await mockDeliveryViewer(page);
  await page.goto("/delivery");

  const trigger = page.getByRole("button", { name: "Open photo.jpg" });
  await expect(trigger).toBeVisible();
  expect(requests.imageSource).toBe(0);

  await trigger.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Preview photo.jpg" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("img", { name: "photo.jpg" })).toBeVisible();
  await expect.poll(() => requests.imageSource).toBeGreaterThan(0);
  await expect(viewer).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");

  await page.keyboard.press("Escape");
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
});

test("video original loads only on activation and a backdrop pointer closes the viewer", async ({ page }) => {
  const requests = await mockDeliveryViewer(page);
  await page.goto("/delivery");

  const trigger = page.getByRole("button", { name: "Open flight.mp4" });
  await expect(trigger).toBeVisible();
  const icon = page.getByLabel("video preview unavailable");
  await expect(icon).toBeVisible();
  await expect(icon.locator(".file-kind")).toHaveText("video");
  await expect(icon).toContainText("File-type icon");
  expect(requests.videoSource).toBe(0);
  expect(requests.thumbnail).toBe(0);

  await trigger.click();
  const viewer = page.getByRole("dialog", { name: "Preview flight.mp4" });
  await expect(viewer).toBeVisible();
  await expect.poll(() => requests.videoSource).toBeGreaterThan(0);

  await page.locator(".modal-backdrop").evaluate((element) => {
    element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await expect(viewer).toHaveCount(0);
  await expect(trigger).toBeFocused();
});
