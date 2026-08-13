import { expect, test, type Page } from "@playwright/test";

const initial = {
  disclaimer: "Always verify current FAA sources before flight.",
  sources: [{ source: "FAA TFR", status: "fresh", last_success_at: "2026-08-13T16:00:00Z" }],
  operationMatches: [],
  tfrs: [{
    id: "tfr-1",
    notam_id: "6/1234",
    title: "Wisconsin event",
    description: "Temporary restriction",
    geometry_available: true,
    effective_at: "2026-08-13T15:00:00Z",
    expires_at: "2026-08-14T15:00:00Z",
    status: "active",
    official_url: "https://tfr.faa.gov/example",
  }],
  sua: [{
    id: "sua-1",
    name: "VOLK EAST MOA",
    airspace_type: "MOA",
    low_altitude: "5000 FT",
    high_altitude: "FL180",
    starts_at: null,
    ends_at: null,
    status: "not_listed",
  }],
};

async function mockSession(page: Page) {
  let airspaceRequests = 0;
  let rejectRefresh!: () => void;
  const refreshGate = new Promise<void>(resolve => { rejectRefresh = resolve; });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") {
      await route.fulfill({ json: {
        user: { id: "pilot", email: "pilot@example.com", displayName: "Pilot", status: "Active", profileType: "Employee", isAdministrator: false, permissions: ["airspace.view"], divisions: [] },
        csrfToken: "csrf-test", timezone: "America/Chicago", mapStyleUrl: null, mapboxPublicToken: null, capabilities: {},
      } });
      return;
    }
    if (path === "/api/airspace/tfrs") {
      airspaceRequests += 1;
      if (airspaceRequests === 1) await route.fulfill({ json: initial });
      else {
        await refreshGate;
        await route.fulfill({ status: 503, json: { error: "FAA refresh unavailable" } });
      }
      return;
    }
    await route.fulfill({ status: 404, json: { error: "Not found" } });
  });
  return { rejectRefresh };
}

test("Airspace refresh stays inside the banner and preserves stale data on failure", async ({ page }) => {
  const { rejectRefresh } = await mockSession(page);
  await page.goto("/airspace");
  const banner = page.locator(".airspace-safety-banner");
  const refresh = page.getByRole("button", { name: "Refresh" });
  await expect(banner).toContainText("Situational awareness only");
  await expect(page.getByText("Wisconsin event")).toBeVisible();

  const layout = await banner.evaluate(element => getComputedStyle(element).flexDirection);
  expect(layout).toBe((page.viewportSize()?.width || 0) <= 700 ? "column" : "row");
  const bannerBox = await banner.boundingBox(), buttonBox = await refresh.boundingBox();
  expect(bannerBox).not.toBeNull(); expect(buttonBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThanOrEqual(bannerBox!.x);
  expect(buttonBox!.x + buttonBox!.width).toBeLessThanOrEqual(bannerBox!.x + bannerBox!.width + 1);

  await refresh.click();
  await expect(page.getByRole("button", { name: "Refreshing…" })).toBeDisabled();
  await expect(page.getByText("Wisconsin event")).toBeVisible();
  rejectRefresh();
  await expect(page.getByText(/Refresh failed\. Showing the last loaded airspace data\. FAA refresh unavailable/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh" })).toBeEnabled();
  await expect(page.getByText("Wisconsin event")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
