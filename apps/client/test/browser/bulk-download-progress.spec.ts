import { expect, test } from "@playwright/test";

test("ZIP preparation renders queued, checking counts, building and ready without overflow", async ({ page }) => {
  const share = { publicId: "public", label: null, clientName: "Fixture client", projectName: "Fixture delivery", expiresAt: null };
  await page.route("**/api/public/shares/public/manifest**", route => route.fulfill({ json: {
    share, folder: { id: "", name: "Fixture delivery", breadcrumbs: [] }, items: [], nextCursor: null,
  } }));
  await page.route("**/api/public/shares/public/manifest/media**", route => route.fulfill({ json: { items: [] } }));
  await page.route("**/api/public/shares/public/locations**", route => route.fulfill({ json: { locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null } }));
  await page.route("**/api/public/shares/public/download-summary**", route => route.fulfill({ json: { fileCount: 4809, totalBytes: 30_000_000_000, knownBytes: 30_000_000_000, unknownSizeCount: 0 } }));
  let status: Record<string, unknown> = { status: "queued", archiveSize: null, fileCount: 4809, processedFiles: 0 };
  await page.route("**/api/public/shares/public/bulk-download", route => route.fulfill({ json: { ...status, statusUrl: "/api/public/shares/public/bulk-download/progress-fixture" } }));
  await page.route("**/api/public/shares/public/bulk-download/progress-fixture", route => route.fulfill({ json: status }));
  await page.route("**/fixture-ready.zip", route => route.fulfill({ contentType: "application/zip", body: "fixture", headers: { "Content-Disposition": "attachment; filename=fixture.zip" } }));
  await page.goto("/s/public?view=grid");
  await page.getByRole("button", { name: /Download all/ }).click();
  const progress = page.locator(".bulk-progress");
  const assertFits = async () => {
    const bounds = await progress.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
    expect(await progress.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  };
  await expect(progress).toContainText("Download queued");
  await assertFits();
  status = { status: "running", archiveSize: null, fileCount: 4809, processedFiles: 2400, progress: 25 };
  await expect(progress).toContainText("Checking files 2,400 of 4,809");
  await expect(progress).toContainText("25% prepared");
  await assertFits();
  status = { status: "running", archiveSize: 30_001_000_000, fileCount: 4809, processedFiles: 4809, progress: 75 };
  await expect(progress).toContainText("Building ZIP");
  await expect(progress).toContainText("75% prepared");
  await assertFits();
  const download = page.waitForEvent("download");
  status = { status: "ready", progress: 100, downloadUrl: "/fixture-ready.zip" };
  await expect(progress).toContainText("Download ready");
  await assertFits();
  expect((await download).suggestedFilename()).toBe("Fixture-delivery.zip");
});
