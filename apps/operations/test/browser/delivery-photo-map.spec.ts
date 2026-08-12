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

async function mockDelivery(page: Page, locationResponse: {
  points: Array<{ latitude: number; longitude: number; imageCount: number; assetRef?: string }>;
  imageCount: number;
  truncated: boolean;
} = {
  points: [{ latitude: 44.501, longitude: -88.071, imageCount: 2 }],
  imageCount: 2,
  truncated: false,
}, resolveAsset?: (assetRef: string) => Promise<{
  status?: number;
  json: Record<string, unknown>;
}>) {
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
      await route.fulfill({ json: locationResponse });
    } else if (url.pathname === "/api/delivery/folders") {
      await route.fulfill({ json: { prefix: "Jobs/Clients/Acme/Current/", folders: [], files: [], nextCursor: null } });
    } else if (url.pathname.startsWith("/api/delivery/folders/location-assets/")) {
      expect(url.searchParams.get("prefix")).toBe("Jobs/Clients/Acme/Current/");
      const assetRef = decodeURIComponent(url.pathname.split("/").pop() || "");
      const resolved = resolveAsset
        ? await resolveAsset(assetRef)
        : { status: 404, json: { error: "Mapped image is no longer available." } };
      await route.fulfill({ status: resolved.status || 200, json: resolved.json });
    } else if (url.pathname === "/api/delivery/trash") {
      await route.fulfill({ json: { items: [] } });
    } else {
      await route.fulfill({ status: 404, json: { error: "Not found" } });
    }
  });
}

async function clickMappedPoint(page: Page) {
  const canvas = page
    .getByRole("dialog", { name: "Image locations from available photo metadata" })
    .locator(".image-location-map-canvas.expanded");
  await expect(canvas.locator("canvas.mapboxgl-canvas")).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
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

test("hides the entire photo map when the folder has no mapped photos", async ({ page }) => {
  await mockDelivery(page, { points: [], imageCount: 0, truncated: false });
  await page.goto("/delivery/Acme/Current");

  await expect(page.locator(".file-browser")).toBeVisible();
  await expect(page.locator(".image-location-map")).toHaveCount(0);
  await expect(page.getByText("No image locations are available for this folder.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toHaveCount(0);
});

test("mapped pin opens an authorized thumbnail and returns from the full-resolution viewer without recreating the map", async ({ page }) => {
  await mockMapbox(page);
  await mockDelivery(page, {
    points: [{ latitude: 44.501, longitude: -88.071, imageCount: 1, assetRef: "opaque-photo-a" }],
    imageCount: 1,
    truncated: false,
  }, async assetRef => {
    expect(assetRef).toBe("opaque-photo-a");
    return {
      json: {
        id: "opaque-item-a",
        kind: "image",
        name: "mapped-photo.jpg",
        displayName: "mapped-photo.jpg",
        size: 1234,
        thumbnailUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        thumbnailState: "ready",
        previewUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
        downloadUrl: "/api/delivery/items/opaque-item-a/download",
      },
    };
  });

  await page.goto("/delivery/Acme/Current");
  await page.getByRole("button", { name: "Enlarge map" }).click();
  const mapDialog = page.getByRole("dialog", { name: "Image locations from available photo metadata" });
  const expandedCanvas = mapDialog.locator(".image-location-map-canvas.expanded");
  await expandedCanvas.evaluate(element => ((window as any).__mappedCanvas = element));

  await clickMappedPoint(page);
  const selection = page.getByRole("complementary", { name: "Selected mapped image" });
  await expect(selection.getByAltText("Selected mapped image thumbnail")).toBeVisible();
  await expect(selection.getByRole("button", { name: "Back to map" })).toHaveCount(0);
  const selectionContrast = await selection.evaluate(element => {
    const label = element.querySelector(".image-location-selection-preview strong");
    const style = label ? getComputedStyle(label) : null;
    const panel = getComputedStyle(element);
    return { labelColor: style?.color, panelBorder: panel.borderColor };
  });
  expect(selectionContrast.labelColor).toBe("rgb(17, 24, 32)");
  expect(selectionContrast.panelBorder).not.toBe("rgb(238, 80, 7)");
  const openSelected = selection.getByRole("button", { name: "Open selected image" });
  await openSelected.hover();
  const hoverAccent = await openSelected.evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderColor, color: style.color };
  });
  expect(hoverAccent.background).toBe("rgb(255, 242, 232)");
  expect(hoverAccent.border).toBe("rgb(238, 80, 7)");
  expect(hoverAccent.color).toBe("rgb(17, 24, 32)");
  await openSelected.click();

  const preview = page.getByRole("dialog", { name: "Preview mapped-photo.jpg" });
  await expect(preview).toBeVisible();
  const overlayOrder = await page.evaluate(() => {
    const previewBackdrop = document.querySelector(".modal-backdrop");
    const mapBackdrop = document.querySelector(".image-location-map-backdrop");
    return {
      previewZ: Number(previewBackdrop ? getComputedStyle(previewBackdrop).zIndex : 0),
      mapZ: Number(mapBackdrop ? getComputedStyle(mapBackdrop).zIndex : 0),
    };
  });
  expect(overlayOrder.previewZ).toBeGreaterThan(overlayOrder.mapZ);
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(mapDialog).toBeVisible();
  await expect(selection).toBeVisible();
  expect(await expandedCanvas.evaluate(element => element === (window as any).__mappedCanvas)).toBe(true);

  await mapDialog.getByRole("button", { name: "Close" }).click();
  await expect(mapDialog).toHaveCount(0);
});

test("stale mapped asset errors stay inside the selection panel without an original fallback", async ({ page }) => {
  await mockMapbox(page);
  await mockDelivery(page, {
    points: [{ latitude: 44.501, longitude: -88.071, imageCount: 1, assetRef: "stale-photo" }],
    imageCount: 1,
    truncated: false,
  }, async () => ({
    status: 410,
    json: { error: "Mapped image is no longer available." },
  }));

  await page.goto("/delivery/Acme/Current");
  await page.getByRole("button", { name: "Enlarge map" }).click();
  await clickMappedPoint(page);

  const selection = page.getByRole("complementary", { name: "Selected mapped image" });
  await expect(selection.getByText("Mapped image is no longer available.")).toBeVisible();
  await expect(selection.getByRole("button", { name: "Open selected image" })).toHaveCount(0);
  await expect(selection.locator("img")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(selection).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "Image locations from available photo metadata" })).toBeVisible();
});
