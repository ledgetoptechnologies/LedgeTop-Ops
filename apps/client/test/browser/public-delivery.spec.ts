import { expect, test, type Page, type Route } from "@playwright/test";
import type { DeliveryLocationCollection } from "@ltds/shared";

const folderId = "Zm9sZGVy";
const rootImage = { id: "cm9vdC5qcGc", name: "Root photo.jpg", kind: "image", size: 1024, uploadedAt: "2026-08-01T12:00:00Z", previewUrl: "/media/root.svg", sourceUrl: "/media/root.svg", downloadUrl: "/api/public/shares/public/items/cm9vdC5qcGc/download", thumbnailState: "pending", thumbnailFallbackKind: "image" };
const folderImage = { ...rootImage, id: "Zm9sZGVyL3Bob3RvLmpwZw", name: "Folder photo.jpg", previewUrl: "/media/folder.svg", sourceUrl: "/media/folder.svg", downloadUrl: "/api/public/shares/public/items/Zm9sZGVyL3Bob3RvLmpwZw/download" };
const rootPdf = { id: "cmVwb3J0LnBkZg", name: "Report.pdf", kind: "pdf", size: 2048, uploadedAt: "2026-08-01T12:00:00Z", sourceUrl: "/media/report.pdf", downloadUrl: "/api/public/shares/public/items/cmVwb3J0LnBkZg/download", thumbnailState: "pending", thumbnailFallbackKind: "pdf" };
const rootVideo = { id: "ZmxpZ2h0Lm1wNA", name: "Flight.mp4", kind: "video", size: 4096, uploadedAt: "2026-08-01T12:00:00Z", sourceUrl: "/media/flight.mp4", downloadUrl: "/api/public/shares/public/items/ZmxpZ2h0Lm1wNA/download", thumbnailState: "pending", thumbnailFallbackKind: "video", previewStatus: "ready" };
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
    const extras = folder ? [] : rootExtras.filter(extra => ["image", "pdf", "video"].includes(String(extra.kind)));
    await route.fulfill({ json: { items: [item, ...extras].map(candidate => ({
      id: candidate.id,
      thumbnailUrl: `/thumb/${candidate.id}.svg`,
      thumbnailState: "ready",
      thumbnailFallbackKind: candidate.kind,
      ...(candidate.kind === "video" ? { previewStatus: "previewStatus" in candidate && candidate.previewStatus === "ready" ? "ready" : "processing" } : {}),
    })) } });
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
  await page.route("**/api/public/shares/public/items/*/stream-ticket", route => route.fulfill({ json: { url: "/media/player.html" } }));
  await page.route("**/media/player.html", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><video controls><track kind=\"captions\"></video>" }));
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

test("consumes the original fragment once, survives refresh, and opens from the original link in another tab",async({page})=>{
  let exchanges=0;
  const install=async(target:Page)=>{
    await mockShare(target);
    await target.route("**/api/public/shares/public/session",route=>{exchanges+=1;return route.fulfill({json:{publicId:"public",canonicalPath:"/s/public"},headers:{"Set-Cookie":"__Host-ltds_delivery=test; Path=/; Secure; HttpOnly; SameSite=Lax"}});});
  };
  await install(page);
  await page.goto("/s/public#fragment-secret-that-is-long-enough-for-a-share");
  await expect(page.getByText("Root photo.jpg")).toBeVisible();
  await expect(page).toHaveURL(/\/s\/public\?view=grid$/);
  expect(exchanges).toBe(1);
  await page.reload();await expect(page.getByText("Root photo.jpg")).toBeVisible();expect(exchanges).toBe(1);
  const other=await page.context().newPage();await install(other);await other.goto("/s/public");
  await expect(other.getByText("Root photo.jpg")).toBeVisible();expect(exchanges).toBe(1);
  await other.goto("/s/public#fragment-secret-that-is-long-enough-for-a-share");
  await expect(other.getByText("Root photo.jpg")).toBeVisible();expect(exchanges).toBe(2);
  await other.close();
});

test("re-exchanges the in-memory fragment once when the first protected request reports an expired session",async({page})=>{
  let exchanges=0,manifests=0;
  await mockShare(page);
  await page.route("**/api/public/shares/public/session",route=>{exchanges+=1;return route.fulfill({json:{publicId:"public",canonicalPath:"/s/public"}});});
  await page.route("**/api/public/shares/public/manifest**",route=>{
    if(new URL(route.request().url()).pathname.endsWith("/manifest/media"))return route.fulfill({json:{items:[]}});
    manifests+=1;
    if(manifests===1)return route.fulfill({status:401,json:{error:"Delivery session expired",code:"DELIVERY_SESSION_EXPIRED"}});
    return fulfillManifest(route);
  });
  await page.goto("/s/public#fragment-secret-that-is-long-enough-for-a-share");
  await expect(page.getByText("Root photo.jpg")).toBeVisible();
  expect(exchanges).toBe(2);expect(manifests).toBe(2);
  await expect(page).toHaveURL(/\/s\/public\?view=grid$/);
});

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
  const thumbnail = card.locator(`img[src="/thumb/${rootImage.id}.svg"]`);
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate(image => {
    const loaded = image as HTMLImageElement;
    return loaded.complete && loaded.naturalWidth > 0;
  })).toBe(true);
  await expect(download).toHaveAttribute("href", rootImage.downloadUrl);
  expect(await download.getAttribute("href")).not.toMatch(/r2\.cloudflarestorage\.com|storage\.cloudflareapi\.com/);
  if (page.viewportSize()!.width > 720) {
    await expect(download).toHaveCSS("opacity", "0");
    await card.hover(); await expect(download).toHaveCSS("opacity", "1");
  } else {
    await expect(download).toHaveCSS("opacity", "1");
  }
  expect(await download.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const hit = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    return hit === element || element.contains(hit);
  })).toBe(true);
  await expect(download).toHaveCSS("z-index", "2");
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

test("public pagination paints 150 immediately, prefetches one page, and keeps 1200 items in a bounded render window", async ({ page }) => {
  let releasePageTwo!: () => void;
  const pageTwoGate = new Promise<void>(resolve => { releasePageTwo = resolve; });
  const pages = Array.from({ length: 8 }, (_, pageIndex) => Array.from({ length: 150 }, (_, index) => ({
    id: `file-${pageIndex}-${index}`,
    name: `Photo ${pageIndex * 150 + index + 1}.jpg`,
    kind: "image",
    size: 1024,
    uploadedAt: "2026-08-01T12:00:00Z",
    sourceUrl: "/media/root.svg",
    downloadUrl: `/api/public/shares/public/items/file-${pageIndex}-${index}/download`,
    thumbnailState: "pending",
    thumbnailFallbackKind: "image",
  })));
  const requested: Array<string | null> = [];
  await page.route("**/api/public/shares/public/manifest**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/manifest/media")) return route.fulfill({ json: { items: [] } });
    const cursor = url.searchParams.get("cursor");
    requested.push(cursor);
    if (cursor === "page-2") await pageTwoGate;
    const pageIndex = cursor ? Number(cursor.slice("page-".length)) - 1 : 0;
    await route.fulfill({ json: { share, folder: { id: "", name: "North Site", breadcrumbs: [] }, items: pages[pageIndex], nextCursor: pageIndex < 7 ? `page-${pageIndex + 2}` : null } });
  });
  await page.route("**/api/public/shares/public/download-summary**", route => route.fulfill({ json: { fileCount: 1200, totalBytes: 1200 * 1024, knownBytes: 1200 * 1024, unknownSizeCount: 0 } }));
  await page.route("**/api/public/shares/public/locations**", route => route.fulfill({ json: { locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null } }));
  await page.route("**/media/root.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));

  await page.goto("/s/public?view=list");
  await expect(page.getByText("Photo 1.jpg", { exact: true })).toBeVisible();
  await expect(page.locator(".item-row")).toHaveCount(150);
  await expect.poll(() => requested).toEqual([null, "page-2"]);
  await expect(page.getByText("Photo 151.jpg", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).evaluate((button: HTMLButtonElement) => button.click());
  await expect(page.getByText("Photo 1.jpg", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Loading more..." })).toBeDisabled();
  releasePageTwo();
  await expect(page.getByText("Photo 300.jpg", { exact: true })).toBeVisible();
  for (let pageNumber = 3; pageNumber <= 8; pageNumber += 1) {
    const button = page.getByRole("button", { name: "Load more" });
    await expect(button).toBeEnabled();
    await button.evaluate((element: HTMLButtonElement) => element.click());
    await expect(page.getByText(`Photo ${pageNumber * 150}.jpg`, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Photo 1200.jpg", { exact: true })).toBeVisible();
  await expect(page.locator(".item-row")).toHaveCount(450);
  await expect(page.getByRole("button", { name: "Show earlier items" })).toBeVisible();
  expect(requested).toEqual([null, "page-2", "page-3", "page-4", "page-5", "page-6", "page-7", "page-8"]);
});

test("protected revalidation failure clears cached share content", async ({ page }) => {
  let manifestRequests = 0;
  await page.route("**/api/public/shares/public/manifest**", async route => {
    if (new URL(route.request().url()).pathname.endsWith("/manifest/media")) return route.fulfill({ json: { items: [] } });
    manifestRequests += 1;
    if (manifestRequests === 1) return fulfillManifest(route);
    return route.fulfill({ status: 410, json: { error: "Share expired", code: "SHARED_FOLDER_UNAVAILABLE" } });
  });
  await page.route("**/api/public/shares/public/download-summary**", route => route.fulfill({ json: { fileCount: 1, totalBytes: 1024, knownBytes: 1024, unknownSizeCount: 0 } }));
  await page.route("**/api/public/shares/public/locations**", route => route.fulfill({ json: { locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null } }));
  await page.route("**/media/*.svg", route => route.fulfill({ contentType: "image/svg+xml", body: svg }));
  await page.goto("/s/public?view=grid");
  await expect(page.getByText("Root photo.jpg", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open Folder" }).click();
  await expect(page.getByText("This link is no longer valid", { exact: true })).toBeVisible();
  await expect(page.getByText("Root photo.jpg", { exact: true })).toHaveCount(0);
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
  const videoCard = page.locator(".item-card").filter({ hasText: "Flight.mp4" });
  await expect(videoCard.locator(`img[src="/thumb/${rootVideo.id}.svg"]`)).toBeVisible();
  await expect(videoCard.getByText("Preparing preview…")).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "Preview Root photo.jpg" }); await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Preview Root photo.jpg" }); await expect(dialog).toBeFocused();
  await expect(dialog.locator(".preview-stage")).toHaveCSS("background-color", "rgb(13, 20, 26)");
  const download = dialog.getByRole("link", { name: "Download Root photo.jpg" }); await expect(download).toHaveAttribute("href", rootImage.downloadUrl);
  const zoom = dialog.locator(".zoomable-delivery-image"); const box = await zoom.boundingBox(); expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * .25, box!.y + box!.height * .25); await page.mouse.wheel(0, -120);
  await expect(zoom.locator("img")).toHaveAttribute("style", /scale\(1\.18\)/); await expect(zoom.locator("img")).toHaveAttribute("style", /translate\([^0]/);
  await expect(dialog.getByRole("button", { name: "Fit" })).toBeVisible(); await dialog.getByRole("button", { name: "Fit" }).click();
  await expect(zoom.locator("img")).toHaveAttribute("style", /translate\(0px, 0px\) scale\(1\)/); await expect(dialog).toBeFocused();
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("dialog", { name: "Preview Report.pdf" })).toBeVisible();
  await expect(page.locator(".pdf-preview")).toBeVisible(); await expect(page.getByRole("button", { name: "Fit" })).toHaveCount(0);
  await page.keyboard.press("ArrowRight"); await expect(page.getByRole("dialog", { name: "Preview Flight.mp4" })).toBeVisible();
  const streamPlayer = page.locator(".video-preview iframe"); await expect(streamPlayer).toBeVisible();
  await expect(streamPlayer).toHaveAttribute("allow", /picture-in-picture/);
  await expect(page.frameLocator(".video-preview iframe").locator("video")).toHaveAttribute("controls", "");
  await expect(page.locator(".zoomable-delivery-image")).toHaveCount(0); await expect(page.getByRole("button", { name: "Fit" })).toHaveCount(0);
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(trigger).toBeFocused();
});

test("image viewer supports a real two-touch pinch gesture and keeps the image bounded", async ({ page }) => {
  await mockShare(page); await page.goto("/s/public?view=grid");
  await page.getByRole("button", { name: "Preview Root photo.jpg" }).click();
  const zoom = page.locator(".zoomable-delivery-image");
  const image = zoom.locator("img");
  const box = await zoom.boundingBox();
  expect(box).not.toBeNull();

  const center = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [
      { id: 1, x: center.x - 40, y: center.y },
      { id: 2, x: center.x + 40, y: center.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [
      { id: 1, x: center.x - 100, y: center.y },
      { id: 2, x: center.x + 100, y: center.y },
    ],
  });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

  await expect(image).toHaveAttribute("style", /scale\(2\.5\)/);
  for (let index = 0; index < 5; index += 1) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: center.x, y: center.y }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: center.x + 200, y: center.y + 200 }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  const transform = await image.getAttribute("style");
  expect(transform).toMatch(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\) scale\((\d+(?:\.\d+)?)\)/);
  const [, rawX, rawY, rawScale] = transform!.match(/translate\((-?\d+(?:\.\d+)?)px, (-?\d+(?:\.\d+)?)px\) scale\((\d+(?:\.\d+)?)\)/)!;
  const scale = Number(rawScale);
  expect(Math.abs(Number(rawX)) + Math.abs(Number(rawY))).toBeGreaterThan(0);
  expect(Math.abs(Number(rawX))).toBeLessThanOrEqual(box!.width * (scale - 1) / 2 + 1);
  expect(Math.abs(Number(rawY))).toBeLessThanOrEqual(box!.height * (scale - 1) / 2 + 1);
});

test("client-share uses the isolated API shell on desktop and mobile", async ({ page }) => {
  let staffPublicRequests = 0;
  let delegatedSessionSecret = "";
  await page.route("**/api/public/**", async route => {
    staffPublicRequests += 1;
    await route.fulfill({ status: 418, body: "staff route must not be called" });
  });
  await page.route("**/client-share/api/shares/**", async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/session")) {
      delegatedSessionSecret = (await route.request().postDataJSON()).secret;
      return route.fulfill({ json: { publicId: "clientpublicid0000000001", canonicalPath: "/client-share/clientpublicid0000000001" } });
    }
    if (url.pathname.endsWith("/manifest/media")) return route.fulfill({ json: { items: [] } });
    if (url.pathname.endsWith("/download-summary")) return route.fulfill({ json: { fileCount: 1, totalBytes: 1024, knownBytes: 1024, unknownSizeCount: 0 } });
    if (url.pathname.endsWith("/locations")) return route.fulfill({ json: { locations: {
      points: [{ latitude: 44.51, longitude: -88.01, imageCount: 1, assetRef: "loc_opaque-client-map-reference-00000000000000" }],
      imageCount: 1, truncated: false,
    }, mapboxPublicToken: null } });
    if (url.pathname.endsWith("/manifest")) {
      if (url.pathname.includes("/malformed/")) return route.fulfill({ status: 404, json: { error: "Not found" } });
      return route.fulfill({ json: {
        share: { publicId: "clientpublicid0000000001", label: "Client shared", clientName: "Client-shared delivery", projectName: "Approved files", expiresAt: "2026-09-01T00:00:00Z" },
        folder: { id: "", name: "Approved files", breadcrumbs: [] },
        items: [{ id: "cGhvdG8uanBn", name: "photo.jpg", kind: "image", size: 1024, uploadedAt: "2026-08-01T12:00:00Z", previewUrl: "/client-share/api/shares/clientpublicid0000000001/items/cGhvdG8uanBn/source", downloadUrl: "/client-share/api/shares/clientpublicid0000000001/items/cGhvdG8uanBn/download" }],
        nextCursor: null,
        capabilities: { cloudTransfer: { dropbox: false, googleDrive: false, googlePicker: false } },
      } });
    }
    return route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  const fragment = "fragment-secret-must-be-long-and-one-time-0001";
  await page.goto(`/client-share/clientpublicid0000000001#${fragment}`);
  await expect(page.getByRole("heading", { name: "Approved files" })).toBeVisible();
  await expect(page.getByText("photo.jpg", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download photo.jpg" })).toHaveAttribute("href", /^\/client-share\/api\/shares\//);
  await expect(page.getByRole("heading", { name: "Image locations from available photo metadata" })).toBeVisible();
  await expect(page.getByText("Download individual files", { exact: true })).toBeVisible();
  await expect(page.getByText(/Download all is not yet available for client-created links/)).toBeVisible();
  expect(delegatedSessionSecret).toBe(fragment);
  expect(new URL(page.url()).pathname).toBe("/client-share/clientpublicid0000000001");
  expect(new URL(page.url()).hash).toBe("");
  await page.goto("/client-share/malformed");
  await expect(page.getByText("Delivery unavailable", { exact: true })).toBeVisible();
  expect(staffPublicRequests).toBe(0);
});
