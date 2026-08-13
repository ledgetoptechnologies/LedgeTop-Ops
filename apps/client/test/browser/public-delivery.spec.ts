import { expect, test, type Page, type Route } from "@playwright/test";
import type { DeliveryLocationCollection } from "@ltds/shared";

const folderId = "Zm9sZGVy";
const rootImage = { id: "cm9vdC5qcGc", name: "Root photo.jpg", kind: "image", size: 1024, uploadedAt: "2026-08-01T12:00:00Z", previewUrl: "/media/root.svg", sourceUrl: "/media/root.svg", downloadUrl: "/api/public/shares/public/items/cm9vdC5qcGc/download", thumbnailState: "pending", thumbnailFallbackKind: "image" };
const folderImage = { ...rootImage, id: "Zm9sZGVyL3Bob3RvLmpwZw", name: "Folder photo.jpg", previewUrl: "/media/folder.svg", sourceUrl: "/media/folder.svg", downloadUrl: "/api/public/shares/public/items/Zm9sZGVyL3Bob3RvLmpwZw/download" };
const rootPdf = { id: "cmVwb3J0LnBkZg", name: "Report.pdf", kind: "pdf", size: 2048, uploadedAt: "2026-08-01T12:00:00Z", sourceUrl: "/media/report.pdf", downloadUrl: "/api/public/shares/public/items/cmVwb3J0LnBkZg/download", thumbnailState: "pending", thumbnailFallbackKind: "pdf" };
const rootVideo = { id: "ZmxpZ2h0Lm1wNA", name: "Flight.mp4", kind: "video", size: 4096, uploadedAt: "2026-08-01T12:00:00Z", sourceUrl: "/media/flight.mp4", downloadUrl: "/api/public/shares/public/items/ZmxpZ2h0Lm1wNA/download", thumbnailState: "not_applicable", thumbnailFallbackKind: "video", previewStatus: "processing" };
const share = { publicId: "public", label: null, clientName: "Acme", projectName: "North Site", expiresAt: null };
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="#e65e22"/></svg>`;

async function fulfillManifest(route: Route, rootExtras: Array<Record<string, unknown>> = []) {
  const url = new URL(route.request().url()); const folder = url.searchParams.get("folder") || "";
  await route.fulfill({ json: folder ? { share, folder: { id: folderId, name: "Folder", breadcrumbs: [{ id: folderId, name: "Folder" }] }, items: [folderImage], nextCursor: null } : { share, folder: { id: "", name: "North Site", breadcrumbs: [] }, items: [{ id: folderId, name: "Folder", kind: "folder", size: null, uploadedAt: null }, rootImage, ...rootExtras], nextCursor: null } });
}

async function mockShare(page: Page, mediaGate?: Promise<void>, locationResponse: { locations: DeliveryLocationCollection; mapboxPublicToken: string | null } = { locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null }, rootExtras: Array<Record<string, unknown>> = []) {
  await page.route("**/api/public/shares/public/manifest**", route => fulfillManifest(route, rootExtras));
  await page.route("**/api/public/shares/public/manifest/media**", async route => {
    if (mediaGate) await mediaGate;
    const folder = new URL(route.request().url()).searchParams.get("folder"); const item = folder ? folderImage : rootImage;
    await route.fulfill({ json: { items: [{ id: item.id, thumbnailUrl: `/thumb/${item.id}.svg`, thumbnailState: "ready", thumbnailFallbackKind: "image" }] } });
  });
  await page.route("**/api/public/shares/public/download-summary**", route => {
    const inFolder = new URL(route.request().url()).searchParams.get("folder") === folderId;
    return route.fulfill({ json: inFolder
      ? { fileCount: 1, totalBytes: 1024, knownBytes: 1024, unknownSizeCount: 0 }
      : { fileCount: 2, totalBytes: 1536, knownBytes: 1536, unknownSizeCount: 0 } });
  });
  await page.route("**/api/public/shares/public/locations**", route => route.fulfill({ json: locationResponse }));
  await page.route("**/media/*.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.route("**/media/report.pdf", route => route.fulfill({ contentType: "application/pdf", body: "%PDF-1.4\n%%EOF" }));
  await page.route("**/media/flight.mp4", route => route.fulfill({ contentType: "video/mp4", body: "" }));
  await page.route("**/thumb/*.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));
}

async function mockMapbox(page: Page) {
  await page.route("https://api.mapbox.com/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.includes("/styles/v1/")) await route.fulfill({ json: { version: 8, name: "LTDS test style", sources: {}, layers: [] } });
    else await route.fulfill({ status: 204, body: "" });
  });
  await page.route("https://events.mapbox.com/**", route => route.fulfill({ status: 204, body: "" }));
}

test("folder and file history restore without a document reload", async ({ page }) => {
  await mockShare(page); await page.goto("/s/public?view=grid");
  await page.evaluate(() => (window as unknown as { historySentinel: string }).historySentinel = crypto.randomUUID());
  await page.getByRole("button", { name: "Open Folder" }).click();
  await expect(page.getByText("Folder photo.jpg")).toBeVisible(); await expect(page).toHaveURL(new RegExp(`folder=${folderId}`));
  await page.getByRole("button", { name: "Preview Folder photo.jpg" }).click();
  await expect(page.getByRole("dialog", { name: "Preview Folder photo.jpg" })).toBeVisible(); await expect(page).toHaveURL(/file=Zm9sZGVyL3Bob3RvLmpwZw/);
  await page.goBack(); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByText("Folder photo.jpg")).toBeVisible();
  await page.goBack(); await expect(page.getByText("Root photo.jpg")).toBeVisible();
  await page.goForward(); await expect(page.getByText("Folder photo.jpg")).toBeVisible();
  expect(await page.evaluate(() => Boolean((window as unknown as { historySentinel?: string }).historySentinel))).toBe(true);
  expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(1);
});

test("Download all follows the authoritative folder and returns to root scope", async ({ page }) => {
  const requests: unknown[] = [];
  await mockShare(page);
  await page.route("**/api/public/shares/public/bulk-download", async route => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { downloadUrl: "/downloads/current-folder.zip" } });
  });
  await page.route("**/downloads/current-folder.zip", route => route.fulfill({
    status: 200,
    headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename=current-folder.zip" },
    body: "zip",
  }));
  await page.goto("/s/public?view=grid");
  await page.getByRole("button", { name: "Open Folder" }).click();
  await expect(page.getByText("Folder photo.jpg")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download all/ })).toContainText(/1 file .* 1\.0 KB/);
  const folderRequest = page.waitForRequest(request => request.url().endsWith("/api/public/shares/public/bulk-download"));
  await page.getByRole("button", { name: /Download all/ }).click(); await folderRequest;
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toEqual({ items: [folderId] });

  await page.goBack(); await expect(page.getByText("Root photo.jpg")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download all/ })).toContainText(/2 files .* 1\.5 KB/);
  const rootRequest = page.waitForRequest(request => request.url().endsWith("/api/public/shares/public/bulk-download"));
  await page.getByRole("button", { name: /Download all/ }).click(); await rootRequest;
  await expect.poll(() => requests.length).toBe(2);
  expect(requests[1]).toEqual({ all: true });
});

test("single-file Download is discoverable by hover and keyboard without exposing storage URLs", async ({ page }) => {
  await mockShare(page); await page.goto("/s/public?view=grid");
  const card = page.locator(".item-card").filter({ hasText: "Root photo.jpg" });
  const preview = card.getByRole("button", { name: "Preview Root photo.jpg" });
  const download = card.getByRole("link", { name: "Download Root photo.jpg" });
  await expect(download).toHaveAttribute("href", rootImage.downloadUrl);
  expect(await download.getAttribute("href")).not.toMatch(/r2\.cloudflarestorage\.com|storage\.cloudflareapi\.com/);
  if (page.viewportSize()!.width > 720) {
    await expect(download).toHaveCSS("opacity", "0");
    await card.hover(); await expect(download).toHaveCSS("opacity", "1");
  } else {
    await expect(download).toHaveCSS("opacity", "1");
  }
  await preview.focus(); await expect(download).toHaveCSS("opacity", "1");
  await page.keyboard.press("Tab"); await expect(download).toBeFocused();
  await expect(download).toHaveCSS("outline-style", "solid");
});

test("authoritative names paint before media metadata and aggregate independently", async ({ page }) => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  await mockShare(page, gate); await page.goto("/s/public?view=grid");
  await expect(page.getByText("Root photo.jpg")).toBeVisible();
  await expect(page.getByRole("button", { name: /Download all/ })).toContainText("2 files · 1.5 KB");
  await expect(page.locator(".thumbnail-skeleton")).toHaveCount(0);
  release(); await expect(page.locator(`img[src="/thumb/${rootImage.id}.svg"]`)).toBeVisible();
});

test("public photo map is progressive, responsive, and absent without opted-in GPS", async ({ page }) => {
  await mockShare(page); await page.goto("/s/public?view=grid");
  await expect(page.getByText("Root photo.jpg")).toBeVisible(); await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toHaveCount(0);

  await page.unrouteAll({ behavior: "wait" }); await mockMapbox(page);
  await mockShare(page, undefined, { locations: { points: [{ latitude: 44.501, longitude: -88.071, imageCount: 1, assetRef: `loc_${"a".repeat(43)}` }], imageCount: 1, truncated: false }, mapboxPublicToken: "pk.local-browser-test" });
  await page.reload();
  await expect(page.getByText("Root photo.jpg")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toBeVisible();
  const compact = page.locator(".image-location-map-canvas").first(); await expect(compact).toBeVisible();
  const bounds = await compact.boundingBox(); expect(bounds).not.toBeNull(); expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.getByRole("button", { name: "Enlarge map" }).click(); const dialog = page.getByRole("dialog", { name: "Image locations from available photo metadata" }); await expect(dialog).toBeVisible();
  await expect(page.locator("body")).toHaveCSS("overflow", "hidden"); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0);
});

test("image viewer matches Operations interaction and keeps PDF/video controls unchanged", async ({ page }) => {
  await mockShare(page, undefined, undefined, [rootPdf, rootVideo]); await page.goto("/s/public?view=grid");
  const trigger = page.getByRole("button", { name: "Preview Root photo.jpg" }); await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Preview Root photo.jpg" }); await expect(dialog).toBeFocused();
  const download = dialog.getByRole("link", { name: "Download Root photo.jpg" }); await expect(download).toHaveAttribute("href", rootImage.downloadUrl);
  const zoom = dialog.locator(".zoomable-delivery-image"); const box = await zoom.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height * .25); await page.mouse.wheel(0, -120);
  await expect(zoom.locator("img")).toHaveAttribute("style", /scale\(1\.18\)/); await expect(zoom.locator("img")).toHaveAttribute("style", /translate\([^0]/);
  await expect(dialog.getByRole("button", { name: "Fit" })).toBeVisible(); await dialog.getByRole("button", { name: "Fit" }).click();
  await expect(zoom.locator("img")).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/); await expect(dialog).toBeFocused();
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("dialog", { name: "Preview Report.pdf" })).toBeVisible();
  await expect(page.locator(".pdf-preview")).toBeVisible(); await expect(page.getByRole("button", { name: "Fit" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("dialog", { name: "Preview Flight.mp4" })).toBeVisible();
  await expect(page.locator(".zoomable-delivery-image")).toHaveCount(0); await expect(page.getByRole("button", { name: "Fit" })).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
});
