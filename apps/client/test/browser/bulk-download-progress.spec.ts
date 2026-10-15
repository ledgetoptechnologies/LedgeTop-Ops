import { expect, test } from "@playwright/test";

for (const { failureCode, recoveryDenied } of [
  { failureCode: "DELIVERY_SESSION_EXPIRED", recoveryDenied: false },
  { failureCode: "SHARE_INVALID", recoveryDenied: false },
  { failureCode: "SHARE_REVOKED", recoveryDenied: false },
  { failureCode: "SHARE_INVALID", recoveryDenied: true },
]) {
  const sessionExpired = failureCode !== "SHARE_REVOKED";
  const replacedSession = failureCode === "SHARE_INVALID";
  test(`ZIP polling ${recoveryDenied ? "stops when replacement-session recovery is denied" : replacedSession ? "recovers after another tab replaces the share session" : sessionExpired ? "recovers an expired session without restarting the job" : "stops when delivery access is revoked"}`, async ({ page }) => {
    let exchanges = 0;
    let starts = 0;
    let polls = 0;
    await page.route("**/api/public/shares/public/session", route => {
      exchanges += 1;
      expect(route.request().postDataJSON()).toEqual({ secret: "fragment-secret-that-is-long-enough-for-a-share" });
      if (recoveryDenied && exchanges > 1) return route.fulfill({ status: 403, json: { error: "This delivery was revoked", code: "SHARE_REVOKED" } });
      return route.fulfill({ json: { publicId: "public", canonicalPath: "/s/public" }, headers: { "Set-Cookie": "__Host-ltds_delivery=public-session; Path=/; Secure; HttpOnly; SameSite=Lax" } });
    });
    await page.route("**/api/public/shares/public/manifest**", route => route.fulfill({ json: {
      share: { publicId: "public", projectName: "Fixture delivery", clientName: "Fixture client", expiresAt: null },
      folder: { id: "", name: "Fixture delivery", breadcrumbs: [] }, items: [], nextCursor: null,
    } }));
    await page.route("**/api/public/shares/public/manifest/media**", route => route.fulfill({ json: { items: [] } }));
    await page.route("**/api/public/shares/public/locations**", route => route.fulfill({ json: { locations: { points: [], imageCount: 0, truncated: false }, mapboxPublicToken: null } }));
    await page.route("**/api/public/shares/public/download-summary**", route => route.fulfill({ json: { fileCount: 2, totalBytes: 100, knownBytes: 100, unknownSizeCount: 0 } }));
    await page.route("**/api/public/shares/public/bulk-download", route => {
      starts += 1;
      return route.fulfill({ status: 202, json: { status: "queued", statusUrl: "/api/public/shares/public/bulk-download/session-fixture" } });
    });
    await page.route("**/api/public/shares/public/bulk-download/session-fixture", route => {
      polls += 1;
      if (replacedSession) expect(route.request().headers().cookie).toContain(polls === 1 ? "__Host-ltds_delivery=other-session" : "__Host-ltds_delivery=public-session");
      if (polls === 1 || !sessionExpired) return route.fulfill({
        status: replacedSession ? 404 : sessionExpired ? 401 : 403,
        json: { error: sessionExpired ? "Delivery session expired" : "This delivery was revoked", code: failureCode },
      });
      return route.fulfill({ json: { status: "ready", downloadUrl: "/session-fixture.zip" } });
    });
    await page.route("**/session-fixture.zip", route => route.fulfill({ contentType: "application/zip", body: "fixture", headers: { "Content-Disposition": "attachment; filename=fixture.zip" } }));
    await page.goto("/s/public#fragment-secret-that-is-long-enough-for-a-share");
    await expect(page.getByRole("button", { name: /Download all/ })).toBeVisible();
    const download = sessionExpired && !recoveryDenied ? page.waitForEvent("download") : null;
    await page.getByRole("button", { name: /Download all/ }).click();
    if (replacedSession) {
      await expect(page.locator(".bulk-progress")).toContainText("Download queued");
      const other = await page.context().newPage();
      await other.route("**/api/public/shares/other/session", route => route.fulfill({ json: { publicId: "other", canonicalPath: "/s/other" }, headers: { "Set-Cookie": "__Host-ltds_delivery=other-session; Path=/; Secure; HttpOnly; SameSite=Lax" } }));
      await other.goto("/other-tab-fixture");
      await other.evaluate(() => fetch("/api/public/shares/other/session", { method: "POST" }));
      await other.close();
    }
    if (sessionExpired && !recoveryDenied) {
      await expect(page.locator(".bulk-progress")).toContainText("Download ready");
      expect((await download!).suggestedFilename()).toBe("Fixture-delivery.zip");
      expect(exchanges).toBe(2);
      expect(polls).toBe(2);
    } else {
      await expect(page.getByText("This delivery was revoked", { exact: true })).toBeVisible();
      expect(exchanges).toBe(recoveryDenied ? 2 : 1);
      expect(polls).toBe(1);
    }
    expect(starts).toBe(1);
    await expect(page).toHaveURL(/\/s\/public\?view=grid$/);
  });
}

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
